"""Create (or add a new version of) the Foundry prompt agent used by the Voice Live demo.

The agent is a normal *text* prompt agent. Voice Live wraps it with speech-to-text,
turn detection, noise suppression, echo cancellation and text-to-speech. Default
Voice Live session settings are stored on the agent itself in metadata
(`microsoft.voice-live.configuration`, chunked into 512-character values) so any
Voice Live client that connects to the agent picks them up automatically.

Usage:
    python agent/create_agent.py

Required environment variables (read from the shell or the repo-root .env file):
    FOUNDRY_PROJECT_ENDPOINT   https://<account>.services.ai.azure.com/api/projects/<project>
    MODEL_DEPLOYMENT_NAME      e.g. gpt-4.1
Optional:
    AGENT_NAME                 default: voice-live-agent
    ENABLE_WEB_SEARCH          default: true
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from azure.ai.projects import AIProjectClient
from azure.ai.projects.models import MCPTool, PromptAgentDefinition, WebSearchTool
from azure.identity import DefaultAzureCredential
from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE.parent / ".env")

METADATA_KEY = "microsoft.voice-live.configuration"
METADATA_LIMIT = 512


def chunk_config(config_json: str) -> dict[str, str]:
    """Split the Voice Live config into metadata values of at most 512 characters."""
    chunks = [config_json[i : i + METADATA_LIMIT] for i in range(0, len(config_json), METADATA_LIMIT)]
    metadata = {METADATA_KEY: chunks[0]}
    for index, chunk in enumerate(chunks[1:], start=1):
        metadata[f"{METADATA_KEY}.{index}"] = chunk
    return metadata


def reassemble_config(metadata: dict[str, str]) -> str:
    config = metadata.get(METADATA_KEY, "")
    index = 1
    while f"{METADATA_KEY}.{index}" in metadata:
        config += metadata[f"{METADATA_KEY}.{index}"]
        index += 1
    return config


def build_tools(enable_web_search: bool) -> list:
    tools: list = [
        MCPTool(
            server_label="microsoft_learn",
            server_url="https://learn.microsoft.com/api/mcp",
            require_approval="never",
        )
    ]
    if enable_web_search:
        tools.append(WebSearchTool())
    return tools


def main() -> None:
    endpoint = os.environ.get("FOUNDRY_PROJECT_ENDPOINT")
    model = os.environ.get("MODEL_DEPLOYMENT_NAME")
    agent_name = os.environ.get("AGENT_NAME", "voice-live-agent")
    enable_web_search = os.environ.get("ENABLE_WEB_SEARCH", "true").lower() == "true"
    if not endpoint or not model:
        sys.exit("Set FOUNDRY_PROJECT_ENDPOINT and MODEL_DEPLOYMENT_NAME (run `azd up` or fill in .env).")

    instructions = (HERE / "instructions.md").read_text(encoding="utf-8")
    voice_config = json.loads((HERE / "voicelive_config.json").read_text(encoding="utf-8"))
    metadata = chunk_config(json.dumps(voice_config, separators=(",", ":")))

    with DefaultAzureCredential() as credential, AIProjectClient(endpoint=endpoint, credential=credential) as project:
        def create(tools: list):
            return project.agents.create_version(
                agent_name=agent_name,
                definition=PromptAgentDefinition(model=model, instructions=instructions, tools=tools),
                description="Voice-enabled assistant for the Foundry Voice Live demo.",
                metadata=metadata,
            )

        try:
            agent = create(build_tools(enable_web_search))
        except Exception as exc:  # web search is not available in every region/subscription
            if not enable_web_search:
                raise
            print(f"Web search tool rejected ({exc.__class__.__name__}); retrying with Microsoft Learn MCP only.")
            agent = create(build_tools(False))

        print(f"Agent '{agent.name}' version {agent.version} created with model '{model}'.")

        stored = project.agents.get(agent_name=agent_name)
        latest_metadata = (stored.versions or {}).get("latest", {}).get("metadata", {}) or {}
        config = reassemble_config(latest_metadata)
        print("Voice Live defaults stored on the agent:")
        print(json.dumps(json.loads(config), indent=2) if config else "  (none found)")


if __name__ == "__main__":
    main()
