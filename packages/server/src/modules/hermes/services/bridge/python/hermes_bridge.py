#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import os
import subprocess
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

_BRIDGE_DIR = Path(__file__).resolve().parent
if str(_BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(_BRIDGE_DIR))

import bridge_broker as _broker
import bridge_pool as _pool
import bridge_runtime as _runtime
import bridge_server as _server
import bridge_transport as _transport


def _export_module(module: ModuleType) -> None:
    for name, value in vars(module).items():
        if name.startswith("__"):
            continue
        globals().setdefault(name, value)


for _module in (_runtime, _pool, _transport, _server, _broker):
    _export_module(_module)

_ORIGINAL_ENSURE_AGENT_IMPORTS = _runtime._ensure_agent_imports
_ORIGINAL_SET_PATH_ENV = _runtime._set_path_env
_ORIGINAL_START_PARENT_PROCESS_WATCHDOG = _runtime._start_parent_process_watchdog
_ORIGINAL_SEND_BRIDGE_REQUEST = _transport._send_bridge_request
_FACADE_SEND_BRIDGE_REQUEST = None

_RUNTIME_PATCH_NAMES = (
    "_agent_root",
    "_apply_openrouter_attribution_override",
    "_apply_profile_dotenv",
    "_apply_profile_env",
    "_base_hermes_home",
    "_bridge_log",
    "_bridge_platform",
    "_candidate_agent_roots",
    "_discover_agent_root",
    "_discover_hermes_home",
    "_ensure_agent_imports",
    "_find_agent_root",
    "_hermes_home",
    "_hidden_subprocess_kwargs",
    "_json_default",
    "_json_line_bytes",
    "_jsonable",
    "_normalize_base_home",
    "_platform_text_encoding",
    "_positive_int",
    "_process_exists",
    "_profile_dotenv_keys",
    "_profile_home",
    "_read_dotenv",
    "_refresh_terminal_env",
    "_restore_profile_dotenv",
    "_restore_profile_env",
    "_sanitize_surrogates",
    "_suppress_bridge_platform_hint",
    "_title_user_message",
    "_worker_profile",
)

_POOL_PATCH_NAMES = (
    "APPROVAL_TIMEOUT_MS",
    "APPROVAL_TIMEOUT_SECONDS",
    "_approval_pattern_keys",
    "_base_hermes_home",
    "_bridge_platform",
    "_cfg_max_turns",
    "_discover_bridge_mcp_tools",
    "_ensure_agent_imports",
    "_hermes_home",
    "_install_execute_code_approval_memory_patch",
    "_jsonable",
    "_load_cfg",
    "_load_enabled_toolsets",
    "_load_reasoning_config",
    "_load_service_tier",
    "_mcp_tool_names_from_names",
    "_persist_execute_code_approval_choice",
    "_profile_env",
    "_profile_home",
    "_refresh_approval_allowlist",
    "_refresh_worker_profile_env",
    "_resolve_model",
    "_resolve_runtime",
    "_suppress_bridge_platform_hint",
    "_title_user_message",
    "_tool_names_from_definitions",
)

_TRANSPORT_PATCH_NAMES = (
    "_connect_bridge_socket",
    "_hidden_subprocess_kwargs",
    "_json_line_bytes",
    "_platform_text_encoding",
)

_SERVER_PATCH_NAMES = (
    "AgentPool",
    "_agent_root",
    "_apply_profile_env",
    "_ensure_agent_imports",
    "_hermes_home",
    "_install_stop_signal_handlers",
    "_jsonable",
    "_make_listen_socket",
    "_positive_int",
    "_profile_home",
    "_read_json_request",
    "_resolve_runtime",
    "_restore_profile_env",
    "_start_parent_process_watchdog",
    "_worker_profile",
    "_write_json_response",
)

_BROKER_PATCH_NAMES = (
    "WorkerProcess",
    "_install_stop_signal_handlers",
    "_jsonable",
    "_make_listen_socket",
    "_read_json_request",
    "_worker_endpoint",
    "_write_json_response",
)


def _copy_patch_names(target: ModuleType, names: tuple[str, ...]) -> None:
    for name in names:
        if name in globals():
            setattr(target, name, globals()[name])


def _sync_runtime_patches() -> None:
    _copy_patch_names(_runtime, _RUNTIME_PATCH_NAMES)


def _sync_pool_patches() -> None:
    _sync_runtime_patches()
    _copy_patch_names(_pool, _POOL_PATCH_NAMES)
    _pool.SessionDbHolder = SessionDbHolder
    _pool.RunRecord = RunRecord
    _pool.AgentSession = AgentSession


def _sync_transport_patches() -> None:
    _sync_runtime_patches()
    _copy_patch_names(_transport, _TRANSPORT_PATCH_NAMES)
    send = globals().get("_send_bridge_request")
    facade_send = globals().get("_FACADE_SEND_BRIDGE_REQUEST")
    _transport._send_bridge_request = _ORIGINAL_SEND_BRIDGE_REQUEST if facade_send is not None and send is facade_send else send


def _sync_server_patches() -> None:
    _sync_pool_patches()
    _sync_transport_patches()
    _copy_patch_names(_server, _SERVER_PATCH_NAMES)


def _sync_broker_patches() -> None:
    _sync_transport_patches()
    _copy_patch_names(_broker, _BROKER_PATCH_NAMES)


def _set_path_env(agent_root: str | None, hermes_home: str | None) -> None:
    _sync_runtime_patches()
    _ORIGINAL_SET_PATH_ENV(agent_root, hermes_home)


def _ensure_agent_imports() -> None:
    _sync_runtime_patches()
    _ORIGINAL_ENSURE_AGENT_IMPORTS()


def _start_parent_process_watchdog(
    parent_pid: int | None,
    stop_event: Any,
    label: str,
    interval: float = _runtime.PARENT_WATCHDOG_INTERVAL_SECONDS,
) -> None:
    _runtime._process_exists = globals().get("_process_exists", _runtime._process_exists)
    _ORIGINAL_START_PARENT_PROCESS_WATCHDOG(parent_pid, stop_event, label, interval)


def _send_bridge_request(endpoint: str, req: dict[str, Any], timeout: float) -> dict[str, Any]:
    _transport._connect_bridge_socket = globals().get("_connect_bridge_socket", _transport._connect_bridge_socket)
    _transport._json_line_bytes = globals().get("_json_line_bytes", _transport._json_line_bytes)
    return _ORIGINAL_SEND_BRIDGE_REQUEST(endpoint, req, timeout)


_FACADE_SEND_BRIDGE_REQUEST = _send_bridge_request


class AgentPool(_pool.AgentPool):
    def __init__(self) -> None:
        _sync_pool_patches()
        super().__init__()

    def get_or_create(
        self,
        session_id: str,
        profile: str | None = None,
        model: str | None = None,
        provider: str | None = None,
        background_delegation_enabled: bool | None = None,
    ) -> AgentSession:
        _sync_pool_patches()
        return super().get_or_create(
            session_id,
            profile,
            model,
            provider,
            background_delegation_enabled,
        )

    def start_chat(self, *args: Any, **kwargs: Any) -> RunRecord:
        _sync_pool_patches()
        return super().start_chat(*args, **kwargs)


class BridgeServer(_server.BridgeServer):
    def __init__(self, endpoint: str) -> None:
        _sync_server_patches()
        super().__init__(endpoint)


class WorkerProcess(_transport.WorkerProcess):
    def start(self) -> None:
        _sync_transport_patches()
        super().start()

    def request(self, req: dict[str, Any], timeout: float | None = None) -> dict[str, Any]:
        _sync_transport_patches()
        return super().request(req, timeout)


class BridgeBroker(_broker.BridgeBroker):
    def __init__(self, endpoint: str, agent_root: str | None = None, hermes_home: str | None = None) -> None:
        _sync_broker_patches()
        super().__init__(endpoint, agent_root, hermes_home)

    def _worker_for_profile(self, profile: str, worker_key: str | None = None) -> WorkerProcess:
        _sync_broker_patches()
        return super()._worker_for_profile(profile, worker_key)

    def handle(self, req: dict[str, Any]) -> dict[str, Any]:
        _sync_broker_patches()
        return super().handle(req)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Hermes AIAgent in-process bridge")
    parser.add_argument("--endpoint", default=os.environ.get("HERMES_AGENT_BRIDGE_ENDPOINT", DEFAULT_ENDPOINT))
    parser.add_argument("--agent-root", default=os.environ.get("HERMES_AGENT_ROOT", DEFAULT_AGENT_ROOT))
    parser.add_argument("--hermes-home", default=os.environ.get("HERMES_HOME", DEFAULT_HERMES_HOME))
    parser.add_argument("--worker-profile", default=os.environ.get("HERMES_AGENT_BRIDGE_WORKER_PROFILE"))
    args = parser.parse_args(argv)

    _set_path_env(args.agent_root, args.hermes_home)
    if args.worker_profile:
        _set_worker_profile_env(str(args.worker_profile or "default"))
    _ensure_agent_imports()
    if args.worker_profile:
        _refresh_worker_profile_env()
        _log_worker_startup_context(str(args.worker_profile or "default"))
        BridgeServer(args.endpoint).serve_forever()
    else:
        BridgeBroker(args.endpoint, args.agent_root, args.hermes_home).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
