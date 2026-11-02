"""End-to-end smoke test: no microphone needed.

Connects to the running gateway, configures a Voice Live session, sends a typed
user message and saves the spoken reply to reply.wav.

    uvicorn app.main:app --port 8000          # in one terminal
    python scripts/smoke_test.py               # agent mode
    python scripts/smoke_test.py --mode model --model gpt-realtime
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import time
import wave

import websockets


async def run(url: str, mode: str, model: str, prompt: str, code: str) -> None:
    query = f"mode={mode}" + (f"&model={model}" if mode == "model" else "") + (f"&code={code}" if code else "")
    session = {
        "modalities": ["text", "audio"],
        "input_audio_format": "pcm16",
        "output_audio_format": "pcm16",
        "voice": {"type": "azure-standard", "name": "en-US-Ava:DragonHDLatestNeural", "temperature": 0.8},
        "output_audio_timestamp_types": ["word"],
        "animation": {"outputs": ["viseme_id"]},
    }
    if mode == "model":
        session["instructions"] = "You are a concise voice assistant."

    audio = bytearray()
    counts: dict[str, int] = {}
    transcript = ""
    async with websockets.connect(f"{url}/ws?{query}", max_size=None, open_timeout=60) as ws:
        sent_at = None
        first_audio_ms = None
        async for raw in ws:
            event = json.loads(raw)
            etype = event["type"]
            counts[etype] = counts.get(etype, 0) + 1
            if etype == "gateway.connected":
                print(f"gateway connected -> {event['mode']} '{event['target']}' api {event['api_version']}")
                await ws.send(json.dumps({"type": "session.update", "session": session}))
            elif etype == "session.updated" and sent_at is None:
                s = event["session"]
                agent = (s.get("agent") or {}).get("name")
                print(f"session {s.get('id')} ready (agent={agent}, voice={(s.get('voice') or {}).get('name')})")
                await ws.send(json.dumps({
                    "type": "conversation.item.create",
                    "item": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": prompt}]},
                }))
                await ws.send(json.dumps({"type": "response.create"}))
                sent_at = time.perf_counter()
            elif etype in ("response.audio.delta", "response.output_audio.delta"):
                if first_audio_ms is None and sent_at:
                    first_audio_ms = (time.perf_counter() - sent_at) * 1000
                audio.extend(base64.b64decode(event["delta"]))
            elif etype in ("response.audio_transcript.done", "response.output_audio_transcript.done"):
                transcript = event.get("transcript", "")
            elif etype == "error":
                raise SystemExit(f"ERROR: {event['error']}")
            elif etype == "response.done" and sent_at:
                status = event["response"].get("status")
                if status != "completed":
                    raise SystemExit(f"Response status {status}: {event['response'].get('status_details')}")
                break

    with wave.open("reply.wav", "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)
        wav.writeframes(bytes(audio))

    print(f"agent said: {transcript}")
    print(f"time to first audio: {first_audio_ms:.0f} ms" if first_audio_ms else "no audio received")
    print(f"audio: {len(audio) / 48000:.1f}s saved to reply.wav")
    print("event counts:", json.dumps(dict(sorted(counts.items())), indent=1))
    if not audio:
        raise SystemExit("FAILED: no audio returned")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="ws://localhost:8000")
    parser.add_argument("--mode", choices=["agent", "model"], default="agent")
    parser.add_argument("--model", default="gpt-realtime")
    parser.add_argument("--code", default="", help="Access code if DEMO_ACCESS_CODE is set on the server")
    parser.add_argument("--prompt", default="In one sentence, what is Azure Voice Live?")
    args = parser.parse_args()
    asyncio.run(run(args.url, args.mode, args.model, args.prompt, args.code))


if __name__ == "__main__":
    main()
