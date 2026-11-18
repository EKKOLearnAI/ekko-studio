#!/usr/bin/env python3
"""Verify real Studio/Hermes tool selection without creating an LLM session.

Runs only MCP initialization/list_tools, never any device tool or conversation.
Use the installed Hermes runtime's Python, not the small MCP server venv.

--expect voice (default): the StackChan profile has exactly the seven voice tools
and pulse is its only MCP server. --expect notify (2.8): another Ekko Studio
profile may keep its own tools, but its pulse server exposes only notify_user
and runs with PULSE_MCP_TOOLSET=notify.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=Path, default=Path.home() / ".hermes/profiles/stackchan")
    parser.add_argument("--agent-root", type=Path, default=Path.home() / ".hermes/hermes-agent")
    parser.add_argument("--bridge-runtime", type=Path, default=Path(
        "/Applications/Ekko Studio.app/Contents/Resources/webui/dist/server/agent-bridge/python/bridge_runtime.py"))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--require-director", action="store_true")
    parser.add_argument("--expect", choices=("voice", "notify"), default="voice")
    args = parser.parse_args()
    if args.expect == "notify" and args.require_director:
        parser.error("--require-director only applies to --expect voice")
    if os.environ.get("HERMES_BRIDGE_TOOLSETS", "").strip():
        raise SystemExit("Refusing verification: HERMES_BRIDGE_TOOLSETS overrides profile selection")
    os.environ.update(HERMES_HOME=str(args.profile.resolve()),
                      HERMES_AGENT_ROOT=str(args.agent_root.resolve()),
                      HERMES_AGENT_BRIDGE_BASE_HOME=str(args.profile.parent.parent.resolve()),
                      HERMES_AGENT_BRIDGE_WORKER_PROFILE=args.profile.name,
                      HERMES_AGENT_BRIDGE_PLATFORM="cli", PYTHONDONTWRITEBYTECODE="1")
    sys.path[:0] = [str(args.agent_root), str(args.bridge_runtime.parent)]
    spec = importlib.util.spec_from_file_location("pulse_verify_bridge_runtime", args.bridge_runtime)
    runtime = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runtime)
    enabled = runtime._load_enabled_toolsets()
    disabled = runtime._load_disabled_toolsets()
    if not enabled:
        raise SystemExit("FAIL: empty/None toolset selection can fall back to all tools")
    try:
        discovered = runtime._discover_bridge_mcp_tools()
        from model_tools import get_tool_definitions
        from tools.mcp_tool_schema import mcp_prefixed_tool_name
        definitions = get_tool_definitions(enabled_toolsets=enabled,
                                           disabled_toolsets=disabled, quiet_mode=True)
        names = sorted(runtime._tool_names_from_definitions(definitions))
        definitions_by_name = {definition.get("function", definition).get("name"): definition.get("function", definition)
                               for definition in definitions}
        if args.expect == "notify":
            notify_name = mcp_prefixed_tool_name("pulse", "notify_user")
            prefix = notify_name[:-len("notify_user")]  # e.g. "mcp__pulse__"
            pulse_names = sorted(name for name in names if name.startswith(prefix))
            if pulse_names != [notify_name]:
                raise SystemExit("FAIL: pulse tools in this profile must be exactly notify_user: " + json.dumps(pulse_names))
            notify = definitions_by_name[pulse_names[0]].get("parameters", {})
            if (set(notify.get("properties", {})) != {"kind", "title", "notice_id"} or notify.get("required") != ["kind"]
                    or notify["properties"]["title"].get("maxLength") != 64):
                raise SystemExit("FAIL: bounded notify_user schema is missing or stale")
        else:
            expected = sorted(mcp_prefixed_tool_name("pulse", name) for name in
                              ("capabilities", "status", "set_emotion", "play_action", "respond_to_emotion", "look_at_camera", "stop"))
            if names != expected:
                raise SystemExit("FAIL: actual tool_names differ from seven-tool whitelist: " + json.dumps(names))
            camera = definitions_by_name[mcp_prefixed_tool_name("pulse", "look_at_camera")].get("parameters", {})
            if (set(camera.get("properties", {})) != {"question"} or camera.get("required") != ["question"]
                    or camera["properties"]["question"].get("maxLength") != 200):
                raise SystemExit("FAIL: bounded camera question schema is missing or stale")
        director_schema = {}
        if args.require_director:
            schemas = {}
            for definition in definitions:
                function = definition.get("function", definition)
                schemas[function.get("name")] = function.get("parameters", {})
            respond = schemas[mcp_prefixed_tool_name("pulse", "respond_to_emotion")]
            action = schemas[mcp_prefixed_tool_name("pulse", "play_action")]
            expression = schemas[mcp_prefixed_tool_name("pulse", "set_emotion")]
            intents = respond.get("properties", {}).get("intent", {}).get("enum", [])
            if len(intents) != 16 or "celebrate" not in intents or "comfort" not in intents:
                raise SystemExit("FAIL: director intent schema is missing or stale")
            if ("clip_id" not in action.get("properties", {}) or "action_id" in action.get("required", [])
                    or "clip_id" not in expression.get("properties", {})):
                raise SystemExit("FAIL: director bounded clip schema is missing or stale")
            director_schema = {"validated": True, "intents": intents, "audio_only_supported": True}
        from hermes_cli.config import load_config
        config = load_config()
        active_servers = sorted(name for name, entry in (config.get("mcp_servers") or {}).items()
                                if isinstance(entry, dict) and entry.get("enabled", True))
        if args.expect == "notify":
            toolset = ((config["mcp_servers"].get("pulse") or {}).get("env") or {}).get("PULSE_MCP_TOOLSET")
            if "pulse" not in active_servers or toolset != "notify":
                raise SystemExit("FAIL: pulse server must be enabled with PULSE_MCP_TOOLSET=notify")
        elif active_servers != ["pulse"]:
            raise SystemExit("FAIL: unexpected enabled MCP server")
        server_python = config["mcp_servers"]["pulse"]["command"]
        sdk_version = subprocess.check_output([
            server_python, "-I", "-B", "-c", "import importlib.metadata; print(importlib.metadata.version('mcp'))"
        ], text=True, timeout=10).strip()
        report = {"ok": True, "profile": args.profile.name, "expect": args.expect, "director_schema": director_schema,
                  "camera_schema": {"validated": True, "question_max_length": 200,
                                    "arbitrary_urls_files_or_models": False} if args.expect == "voice" else None,
                  "notify_schema": {"validated": True, "title_max_length": 64} if args.expect == "notify" else None,
                  "enabled_toolsets": enabled, "disabled_native_toolset_count": len(disabled or []),
                  "mcp_servers": ["pulse"] if args.expect == "voice" else active_servers,
                  "mcp_discovered_tool_names": sorted(discovered),
                  "tool_count": len(names), "tool_names": names,
                  "llm_session_created": False, "device_tools_called": False,
                  "mcp_server_python": server_python, "mcp_sdk_version": sdk_version,
                  "mcp_server_args": config["mcp_servers"]["pulse"]["args"],
                  "profile_mode": oct(args.profile.stat().st_mode & 0o777),
                  "config_mode": oct((args.profile / "config.yaml").stat().st_mode & 0o777),
                  "dotenv_mode": oct((args.profile / ".env").stat().st_mode & 0o777),
                  "bridge_runtime": str(args.bridge_runtime), "agent_root": str(args.agent_root)}
        rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
        if args.output:
            args.output.write_text(rendered)
        print(rendered, end="")
    finally:
        from tools.mcp_tool_lifecycle import shutdown_mcp_servers
        shutdown_mcp_servers(timeout=5)


if __name__ == "__main__":
    main()
