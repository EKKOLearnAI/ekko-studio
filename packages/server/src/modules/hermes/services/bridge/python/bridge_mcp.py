"""Keep Studio-managed MCP subprocesses attached to their owning bridge."""
from __future__ import annotations

import importlib
import json
import os
from typing import Any


def install_studio_mcp_env() -> None:
    raw = os.environ.get("HERMES_AGENT_BRIDGE_STUDIO_MCP_ENV", "")
    if not raw:
        return
    owner = json.loads(raw)
    if not isinstance(owner, dict) or not owner.get("HERMES_WEB_UI_URL"):
        raise RuntimeError("Studio Bridge MCP owner environment is invalid")
    try:
        module = importlib.import_module("tools.mcp_tool_config")
    except ModuleNotFoundError as exc:
        if exc.name != "tools.mcp_tool_config":
            raise
        module = importlib.import_module("tools.mcp_tool")
    original = getattr(module, "_build_safe_env", None)
    if not callable(original):
        raise RuntimeError("Hermes runtime does not expose the MCP launch environment builder")
    if getattr(original, "_studio_bridge_owner", False):
        return

    def build_env(user_env: dict[str, Any] | None) -> dict[str, Any]:
        if isinstance(user_env, dict) and user_env.get("HERMES_WEB_UI_MANAGED_MCP") == "1":
            # Rewrite a copy at launch, including reconnect/reload. Never persist
            # instance routing to the shared profile or alter user-owned servers.
            user_env = {**user_env, **owner}
            user_env["HERMES_WEB_UI_PROFILE"] = os.environ.get("HERMES_AGENT_BRIDGE_WORKER_PROFILE") or "default"
            user_env.pop("HERMES_WEB_UI_TOKEN", None)
        return original(user_env)

    build_env._studio_bridge_owner = True  # type: ignore[attr-defined]
    module._build_safe_env = build_env
