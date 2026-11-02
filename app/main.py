"""Voice Live demo gateway.

A thin, secure WebSocket relay between the browser and Azure Speech Voice Live:

* The browser speaks the Voice Live realtime protocol (JSON events) directly, so
  the event inspector in the UI shows exactly what goes over the wire.
* This server adds the Microsoft Entra ID bearer token (managed identity in Azure,
  your `az login` locally). No keys or tokens ever reach the browser.
* Only an allow-list of client events is forwarded, and the target agent/model is
  decided server-side.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlencode, urlparse

import websockets
from azure.identity.aio import DefaultAzureCredential
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("azure").setLevel(logging.WARNING)
logger = logging.getLogger("voicelive-gateway")

VOICELIVE_ENDPOINT = os.environ.get("AZURE_VOICELIVE_ENDPOINT", "").rstrip("/")
API_VERSION = os.environ.get("VOICELIVE_API_VERSION", "2026-04-10")
PROJECT_NAME = os.environ.get("FOUNDRY_PROJECT_NAME", "")
AGENT_NAME = os.environ.get("AGENT_NAME", "")
AGENT_VERSION = os.environ.get("AGENT_VERSION", "")
DEMO_ACCESS_CODE = os.environ.get("DEMO_ACCESS_CODE", "")
TOKEN_SCOPE = "https://ai.azure.com/.default"

# Models the UI may pick in "direct model" mode (Voice Live hosts these; no deployment needed).
ALLOWED_MODELS = [
    m.strip()
    for m in os.environ.get(
        "VOICELIVE_MODELS",
        "gpt-realtime,gpt-realtime-mini,gpt-4.1,gpt-4.1-mini,gpt-4o,gpt-4o-mini,gpt-5,gpt-5-mini,phi4-mini,azure-realtime",
    ).split(",")
    if m.strip()
]

ALLOWED_CLIENT_EVENTS = {
    "session.update",
    "session.avatar.connect",
    "input_audio_buffer.append",
    "input_audio_buffer.commit",
    "input_audio_buffer.clear",
    "conversation.item.create",
    "conversation.item.retrieve",
    "conversation.item.truncate",
    "conversation.item.delete",
    "response.create",
    "response.cancel",
}

credential = DefaultAzureCredential()


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await credential.close()


app = FastAPI(title="Foundry Voice Live demo", lifespan=lifespan)


@app.middleware("http")
async def revalidate_static(request, call_next):
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-cache")
    return response


@app.get("/healthz")
async def healthz() -> dict:
    return {"status": "ok"}


@app.get("/api/config")
async def config() -> JSONResponse:
    return JSONResponse(
        {
            "agentName": AGENT_NAME,
            "projectName": PROJECT_NAME,
            "agentModeAvailable": bool(AGENT_NAME and PROJECT_NAME),
            "models": ALLOWED_MODELS,
            "apiVersion": API_VERSION,
            "endpointHost": urlparse(VOICELIVE_ENDPOINT).netloc,
            "accessCodeRequired": bool(DEMO_ACCESS_CODE),
        }
    )


def build_upstream_url(mode: str, model: str) -> str:
    parsed = urlparse(VOICELIVE_ENDPOINT)
    params = {"api-version": API_VERSION}
    if mode == "agent":
        params["agent-name"] = AGENT_NAME
        params["agent-project-name"] = PROJECT_NAME
        if AGENT_VERSION:
            params["agent-version"] = AGENT_VERSION
    else:
        params["model"] = model
    return f"wss://{parsed.netloc}/voice-live/realtime?{urlencode(params)}"


def origin_allowed(ws: WebSocket) -> bool:
    origin = ws.headers.get("origin")
    if not origin:
        return True  # non-browser clients (scripts, tests)
    return urlparse(origin).netloc == ws.headers.get("host")


@app.websocket("/ws")
async def voice_session(ws: WebSocket) -> None:
    mode = ws.query_params.get("mode", "agent")
    model = ws.query_params.get("model", "")
    code = ws.query_params.get("code", "")

    if not origin_allowed(ws):
        await ws.close(code=1008, reason="Origin not allowed")
        return
    if DEMO_ACCESS_CODE and not hmac.compare_digest(code.encode(), DEMO_ACCESS_CODE.encode()):
        await ws.close(code=1008, reason="Invalid access code")
        return

    await ws.accept()

    async def fail(message: str) -> None:
        await ws.send_text(json.dumps({"type": "error", "error": {"message": message, "source": "gateway"}}))
        await ws.close()

    if not VOICELIVE_ENDPOINT:
        await fail("AZURE_VOICELIVE_ENDPOINT is not configured on the server.")
        return
    if mode == "agent" and not (AGENT_NAME and PROJECT_NAME):
        await fail("Agent mode needs AGENT_NAME and FOUNDRY_PROJECT_NAME on the server.")
        return
    if mode == "model" and model not in ALLOWED_MODELS:
        await fail(f"Model '{model}' is not in the allow-list.")
        return
    if mode not in ("agent", "model"):
        await fail("mode must be 'agent' or 'model'.")
        return

    url = build_upstream_url(mode, model)
    try:
        token = await credential.get_token(TOKEN_SCOPE)
        upstream = await websockets.connect(
            url,
            additional_headers={"Authorization": f"Bearer {token.token}"},
            max_size=None,
            open_timeout=20,
        )
    except websockets.InvalidStatus as exc:
        body = exc.response.body.decode(errors="ignore") if exc.response.body else ""
        await fail(f"Voice Live rejected the connection (HTTP {exc.response.status_code}). {body[:500]}")
        return
    except Exception as exc:  # credential or network problems
        logger.exception("Upstream connection failed")
        await fail(f"Could not connect to Voice Live: {exc}")
        return

    logger.info("Session opened mode=%s target=%s", mode, AGENT_NAME if mode == "agent" else model)
    await ws.send_text(
        json.dumps(
            {
                "type": "gateway.connected",
                "mode": mode,
                "target": AGENT_NAME if mode == "agent" else model,
                "api_version": API_VERSION,
            }
        )
    )

    async def browser_to_voicelive() -> None:
        while True:
            raw = await ws.receive_text()
            try:
                event_type = json.loads(raw).get("type")
            except (ValueError, AttributeError):
                continue
            if event_type in ALLOWED_CLIENT_EVENTS:
                await upstream.send(raw)
            else:
                logger.warning("Dropped client event %r", event_type)

    async def voicelive_to_browser() -> None:
        async for message in upstream:
            await ws.send_text(message if isinstance(message, str) else message.decode())

    tasks = [asyncio.create_task(browser_to_voicelive()), asyncio.create_task(voicelive_to_browser())]
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in done:
            exc = task.exception()
            if exc and not isinstance(exc, (WebSocketDisconnect, websockets.ConnectionClosed)):
                logger.warning("Relay ended: %r", exc)
    finally:
        close_code, close_reason = upstream.close_code, upstream.close_reason
        await upstream.close()
        if close_code not in (None, 1000):
            try:
                await fail(f"Voice Live closed the session ({close_code}): {close_reason}")
            except Exception:
                pass
        logger.info("Session closed")


app.mount("/", StaticFiles(directory=Path(__file__).resolve().parent / "static", html=True), name="static")
