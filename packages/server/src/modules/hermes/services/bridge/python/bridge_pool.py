from __future__ import annotations

import copy
import inspect
import json
import os
import queue
import sys
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from bridge_runtime import (
    APPROVAL_TIMEOUT_MS,
    APPROVAL_TIMEOUT_SECONDS,
    _approval_pattern_keys,
    _base_hermes_home,
    _bridge_platform,
    _cfg_max_turns,
    _discover_bridge_mcp_tools,
    _ensure_agent_imports,
    _hermes_home,
    _install_execute_code_approval_memory_patch,
    _jsonable,
    _load_cfg,
    _load_enabled_toolsets,
    _load_fallback_model,
    _load_reasoning_config,
    _load_service_tier,
    _mcp_tool_names_from_names,
    _persist_execute_code_approval_choice,
    _profile_env,
    _profile_home,
    _refresh_approval_allowlist,
    _refresh_worker_profile_env,
    _resolve_model,
    _resolve_runtime,
    _suppress_bridge_platform_hint,
    _title_user_message,
    _tool_names_from_definitions,
)


def _bind_session_workspace_cwd(session_id: str, workspace: str | None) -> bool:
    workspace_cwd = str(workspace or "").strip()
    if not workspace_cwd:
        return False
    bound = False
    try:
        from agent.runtime_cwd import set_session_cwd

        set_session_cwd(workspace_cwd)
        bound = True
        try:
            from tools.terminal_tool import register_task_env_overrides

            register_task_env_overrides(session_id, {"cwd": workspace_cwd})
        except Exception:
            pass
    except Exception:
        return bound
    return bound


def _clear_session_workspace_cwd() -> None:
    try:
        from agent.runtime_cwd import clear_session_cwd

        clear_session_cwd()
    except Exception:
        pass


def _set_bridge_session_vars(
    session_id: str,
    profile: str | None,
    workspace: str | None,
    background_delegation_enabled: bool,
) -> Any:
    """Bind the richest session context supported by the installed runtime."""
    from gateway.session_context import set_session_vars

    values = {
        "platform": "agent_bridge",
        # Hermes delegate_task has a TUI-specific durable session routing path.
        # Agent Bridge uses that contract so compression-driven session-id
        # rotation cannot orphan a detached completion.
        "source": "tui",
        "session_key": session_id,
        "session_id": session_id,
        "ui_session_id": session_id,
        "profile": str(profile or "default"),
        "cwd": str(workspace or ""),
        "async_delivery": background_delegation_enabled,
    }
    try:
        parameters = inspect.signature(set_session_vars).parameters.values()
        accepts_extra = any(parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in parameters)
        accepted_names = {parameter.name for parameter in parameters}
        supported = values if accepts_extra else {
            name: value for name, value in values.items() if name in accepted_names
        }
    except (TypeError, ValueError):
        supported = values
    return set_session_vars(**supported)


class SessionDbHolder:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._db_by_path: dict[str, Any] = {}
        self._error: str | None = None

    def get(self, db_path: Path | None = None):
        with self._lock:
            key = str((db_path or (_base_hermes_home() / "state.db")).resolve())
            if key in self._db_by_path:
                return self._db_by_path[key]
            _ensure_agent_imports()
            try:
                from hermes_state import SessionDB

                db = SessionDB(db_path=Path(key))
                self._db_by_path[key] = db
                self._error = None
                return db
            except Exception as exc:
                self._error = str(exc)
                return None

    @property
    def error(self) -> str | None:
        return self._error

    def get_for_profile(self, profile: str | None) -> Any:
        """Get a SessionDB for the given profile using an explicit DB path."""
        return self.get(_profile_home(profile) / "state.db")


@dataclass
class RunRecord:
    run_id: str
    session_id: str
    status: str = "running"
    started_at: float = field(default_factory=time.time)
    ended_at: float | None = None
    result: dict[str, Any] | None = None
    error: str | None = None
    deltas: list[str] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class AgentSession:
    session_id: str
    agent: Any
    history: list[dict[str, Any]] = field(default_factory=list)
    config: dict[str, Any] = field(default_factory=dict)
    running: bool = False
    current_run_id: str | None = None
    lock: threading.RLock = field(default_factory=threading.RLock)
    created_at: float = field(default_factory=time.time)
    last_used_at: float = field(default_factory=time.time)
    background_events: list[dict[str, Any]] = field(default_factory=list)
    background_event_seq: int = 0
    background_tasks: dict[str, dict[str, Any]] = field(default_factory=dict)
    boundary_phase: str = "idle"
    boundary_pending_run_id: str | None = None
    boundary_reached_run_id: str | None = None
    boundary_supported: bool = False
    boundary_error: str | None = None


class AgentPool:
    MAX_BACKGROUND_EVENTS_PER_SESSION = 500
    MAX_BACKGROUND_TASKS_PER_SESSION = 50

    def __init__(self) -> None:
        self._sessions: dict[str, AgentSession] = {}
        self._runs: dict[str, RunRecord] = {}
        self._lock = threading.RLock()
        self._db = SessionDbHolder()
        self._approval_requests: dict[str, queue.Queue[str]] = {}
        self._approval_request_generations: dict[str, tuple[str, str]] = {}
        self._gateway_approval_requests: dict[str, tuple[str, str, str]] = {}
        self._gateway_approval_pattern_keys: dict[str, list[str]] = {}
        self._compression_requests: dict[str, queue.Queue[dict[str, Any]]] = {}
        self._background_notification_claims: dict[tuple[str, str], dict[str, Any]] = {}
        self._suppressed_background_delegations: set[str] = set()
        self._clarify_requests: dict[str, queue.Queue[str]] = {}
        self._run_context = threading.local()
        self._approval_handlers: dict[str, Callable[..., str]] = {}
        self._exec_ask_depth = 0
        self._exec_ask_previous: str | None = None

    def _install_usage_hook(self) -> None:
        """Observe exact per-request model usage without requiring a user plugin."""
        try:
            from hermes_cli.plugins import get_plugin_manager

            manager = get_plugin_manager()
            hooks = getattr(manager, "_hooks", None)
            if not isinstance(hooks, dict):
                raise RuntimeError("Hermes plugin manager does not expose its hook registry")
            callbacks = hooks.setdefault("post_api_request", [])
            callback = self._post_api_request_usage_hook
            if callback not in callbacks:
                callbacks.append(callback)
        except Exception as exc:
            print(
                f"[hermes_bridge] failed to install model usage hook: {exc}",
                file=sys.stderr,
                flush=True,
            )

    def _post_api_request_usage_hook(self, **kwargs: Any) -> None:
        session_id = str(kwargs.get("session_id") or "").strip()
        usage = kwargs.get("usage")
        if not session_id or not isinstance(usage, dict):
            return
        self._append_event(session_id, {
            "event": "model.usage",
            "api_request_id": str(kwargs.get("api_request_id") or "").strip(),
            "turn_id": str(kwargs.get("turn_id") or "").strip(),
            "api_call_count": kwargs.get("api_call_count"),
            "usage": usage,
            "model": kwargs.get("response_model") or kwargs.get("model"),
            "provider": kwargs.get("provider"),
            "api_mode": kwargs.get("api_mode"),
            "api_duration": kwargs.get("api_duration"),
            "started_at": kwargs.get("started_at"),
            "ended_at": kwargs.get("ended_at"),
        })

    @staticmethod
    def _boundary_interrupt_setter() -> Callable[[bool, int | None], None]:
        from run_agent import _set_interrupt

        if not callable(_set_interrupt):
            raise RuntimeError("Hermes runtime does not expose _set_interrupt")
        return _set_interrupt

    @staticmethod
    def _set_boundary_interrupt_flag(agent: Any) -> None:
        redirect_lock = getattr(agent, "_pending_redirect_lock", None)
        if redirect_lock is not None:
            with redirect_lock:
                agent._interrupt_requested = True
                agent._interrupt_message = None
                agent._pending_redirect = None
            return
        agent._interrupt_requested = True
        agent._interrupt_message = None
        agent._pending_redirect = None

    def _signal_boundary_model_interrupt(self, agent: Any) -> None:
        """Interrupt only the foreground model request, never tools or children."""
        self._set_boundary_interrupt_flag(agent)
        if getattr(agent, "api_mode", None) == "codex_app_server":
            codex_session = getattr(agent, "_codex_session", None)
            request_interrupt = getattr(codex_session, "request_interrupt", None)
            if not callable(request_interrupt):
                raise RuntimeError("Codex app-server runtime does not expose request_interrupt")
            request_interrupt()
        execution_thread_id = getattr(agent, "_execution_thread_id", None)
        if execution_thread_id is not None:
            self._boundary_interrupt_setter()(True, execution_thread_id)
            agent._interrupt_thread_signal_pending = False
        else:
            agent._interrupt_thread_signal_pending = True
        abort_active_request = getattr(agent, "_active_request_abort", None)
        if callable(abort_active_request):
            try:
                abort_active_request("boundary_interrupt_abort")
            except Exception:
                pass

    def _clear_boundary_tool_interrupt_signal(self, agent: Any) -> None:
        """Keep a model-phase race from leaking its thread signal into tools."""
        execution_thread_id = getattr(agent, "_execution_thread_id", None)
        if execution_thread_id is not None:
            self._boundary_interrupt_setter()(False, execution_thread_id)
        agent._interrupt_thread_signal_pending = False

    def _install_boundary_interrupt(self, session: AgentSession) -> bool:
        """Wrap one AIAgent instance at the runtime-owned whole-batch boundary."""
        agent = session.agent
        original = getattr(agent, "_execute_tool_calls", None)
        wrapper_installed = bool(
            callable(original)
            and getattr(original, "_hermes_bridge_boundary_wrapper", False)
        )

        try:
            if not callable(original):
                raise RuntimeError("Hermes runtime does not expose _execute_tool_calls")
            if not wrapper_installed:
                parameters = list(inspect.signature(original).parameters.values())
                names = [parameter.name for parameter in parameters]
                if names[:3] != ["assistant_message", "messages", "effective_task_id"]:
                    raise RuntimeError(
                        "unsupported _execute_tool_calls signature: " + ",".join(names)
                    )
            if not hasattr(agent, "_interrupt_requested"):
                raise RuntimeError("Hermes runtime does not expose _interrupt_requested")
            model_active = getattr(agent, "_model_request_active", None)
            if model_active is None or not callable(getattr(model_active, "is_set", None)):
                raise RuntimeError("Hermes runtime does not expose _model_request_active")
            if getattr(agent, "api_mode", None) == "codex_app_server":
                codex_session = getattr(agent, "_codex_session", None)
                if not callable(getattr(codex_session, "request_interrupt", None)):
                    raise RuntimeError(
                        "Codex app-server runtime does not expose request_interrupt"
                    )
            self._boundary_interrupt_setter()
        except Exception as exc:
            session.boundary_supported = False
            session.boundary_error = str(exc)
            return False

        if wrapper_installed:
            session.boundary_supported = True
            session.boundary_error = None
            return True

        def execute_tool_calls_at_boundary(*args: Any, **kwargs: Any) -> Any:
            run_id: str | None = None
            with session.lock:
                if session.running and session.current_run_id:
                    run_id = session.current_run_id
                    session.boundary_phase = "tool_batch"
                    if session.boundary_pending_run_id == run_id:
                        # A model-phase request may win just before Hermes
                        # dispatches its returned tool calls. Clear only the
                        # execution-thread bit so the already-issued batch can
                        # still finish; keep _interrupt_requested latched for
                        # the outer loop check after this wrapper returns.
                        self._clear_boundary_tool_interrupt_signal(agent)
            try:
                return original(*args, **kwargs)
            finally:
                with session.lock:
                    if run_id and session.current_run_id == run_id:
                        session.boundary_phase = "model"
                        if session.boundary_pending_run_id == run_id:
                            self._set_boundary_interrupt_flag(agent)
                            session.boundary_reached_run_id = run_id

        execute_tool_calls_at_boundary._hermes_bridge_boundary_wrapper = True  # type: ignore[attr-defined]
        agent._execute_tool_calls = execute_tool_calls_at_boundary
        session.boundary_supported = True
        session.boundary_error = None
        return True

    @staticmethod
    def _boundary_result_for_run(session: AgentSession, run_id: str) -> bool:
        return (
            session.boundary_pending_run_id == run_id
            or session.boundary_reached_run_id == run_id
        )

    @staticmethod
    def _reset_boundary_run(session: AgentSession, run_id: str) -> None:
        if session.current_run_id != run_id:
            return
        session.boundary_phase = "idle"
        session.boundary_pending_run_id = None

    @staticmethod
    def _cancel_boundary_run(session: AgentSession) -> None:
        session.boundary_pending_run_id = None
        session.boundary_reached_run_id = None

    @staticmethod
    def _clear_completed_boundary_interrupt(agent: Any) -> None:
        clear_interrupt = getattr(agent, "clear_interrupt", None)
        if callable(clear_interrupt):
            try:
                clear_interrupt()
            except Exception:
                pass

    def get_or_create(
        self,
        session_id: str,
        profile: str | None = None,
        model: str | None = None,
        provider: str | None = None,
        background_delegation_enabled: bool | None = None,
    ) -> AgentSession:
        requested_model = str(model or "").strip()
        requested_provider = str(provider or "").strip()
        # A profile worker is long-lived while Studio may rotate OAuth access
        # tokens between runs. Reload its .env before inspecting/reusing a
        # cached AgentSession.
        _refresh_worker_profile_env()
        with self._lock:
            existing = self._sessions.get(session_id)
            if existing is not None:
                # If profile changed, destroy old session and recreate
                profile_changed = bool(profile and existing.config.get("profile") != profile)
                runtime_changed = bool(
                    (requested_model and existing.config.get("model") != requested_model)
                    or (requested_provider and existing.config.get("provider") != requested_provider)
                )
                effective_provider = (
                    requested_provider
                    or str(existing.config.get("provider") or "")
                    or str(getattr(existing.agent, "provider", "") or "")
                ).strip().lower()
                # Anthropic's SDK client freezes its credential at construction.
                # Studio updates ANTHROPIC_TOKEN after centrally refreshing
                # Claude OAuth, so compare the newly resolved runtime with the
                # cached client and hot-switch before the next model request.
                if not profile_changed and not runtime_changed and effective_provider == "anthropic":
                    target_profile = profile or str(existing.config.get("profile") or "default")
                    with _profile_env(target_profile):
                        _refresh_worker_profile_env()
                        refreshed_runtime = _resolve_runtime(
                            requested_model or str(existing.config.get("model") or ""),
                            effective_provider,
                        )
                    runtime_changed = (
                        refreshed_runtime.get("api_key") != getattr(existing.agent, "api_key", None)
                        or str(refreshed_runtime.get("base_url") or "").rstrip("/")
                        != str(getattr(existing.agent, "base_url", "") or "").rstrip("/")
                        or str(refreshed_runtime.get("api_mode") or "")
                        != str(getattr(existing.agent, "api_mode", "") or "")
                    )
                config_changed = profile_changed or runtime_changed
                if config_changed:
                    if profile_changed and not existing.running:
                        self._destroy_session(session_id)
                    elif profile_changed:
                        existing.last_used_at = time.time()
                        return existing
                    elif not existing.running:
                        try:
                            self._switch_loaded_session_model(
                                existing,
                                requested_model or str(existing.config.get("model") or ""),
                                requested_provider or str(existing.config.get("provider") or ""),
                                profile or str(existing.config.get("profile") or "default"),
                                add_note=False,
                            )
                            existing.last_used_at = time.time()
                            return existing
                        except Exception as exc:
                            print(
                                "[hermes_bridge] session model hot switch failed; recreating "
                                f"session={session_id} error={exc}",
                                file=sys.stderr,
                                flush=True,
                            )
                            self._destroy_session(session_id)
                    else:
                        self._set_pending_session_model_switch(
                            existing,
                            requested_model or str(existing.config.get("model") or ""),
                            requested_provider or str(existing.config.get("provider") or ""),
                            profile or str(existing.config.get("profile") or "default"),
                        )
                        existing.last_used_at = time.time()
                        return existing
                else:
                    existing.last_used_at = time.time()
                    return existing

            _ensure_agent_imports()
            _suppress_bridge_platform_hint()
            from run_agent import AIAgent

            with _profile_env(profile):
                _refresh_worker_profile_env()
                _refresh_approval_allowlist()
                discovered_mcp_tools = _discover_bridge_mcp_tools()
                cfg = _load_cfg()
                resolved_model = requested_model or _resolve_model(cfg)
                runtime = _resolve_runtime(resolved_model, requested_provider or None)
                agent_cfg = cfg.get("agent") or {}
                prompt = str(agent_cfg.get("system_prompt", "") or "").strip() or None

                agent = AIAgent(
                    model=resolved_model,
                    fallback_model=_load_fallback_model(cfg),
                    max_iterations=_cfg_max_turns(cfg, 90),
                    provider=runtime.get("provider"),
                    base_url=runtime.get("base_url"),
                    api_key=runtime.get("api_key"),
                    api_mode=runtime.get("api_mode"),
                    acp_command=runtime.get("command"),
                    acp_args=runtime.get("args"),
                    credential_pool=runtime.get("credential_pool"),
                    quiet_mode=True,
                    verbose_logging=False,
                    reasoning_config=_load_reasoning_config(resolved_model),
                    service_tier=_load_service_tier(),
                    enabled_toolsets=_load_enabled_toolsets(),
                    platform=_bridge_platform(),
                    session_id=session_id,
                    session_db=self._db.get_for_profile(profile),
                    ephemeral_system_prompt=prompt,
                    status_callback=self._status_callback(session_id),
                    thinking_callback=self._make_thinking_callback(session_id),
                    reasoning_callback=self._text_event_callback(session_id, "reasoning.delta"),
                    stream_delta_callback=self._stream_delta_callback(session_id),
                    interim_assistant_callback=self._interim_assistant_callback(session_id),
                    tool_progress_callback=self._tool_progress_callback(session_id),
                    tool_start_callback=self._tool_start_callback(session_id),
                    tool_complete_callback=self._tool_complete_callback(session_id),
                    clarify_callback=self._clarify_callback(session_id),
                )
                agent.compression_enabled = False
                self._install_compression_hook(agent, session_id)
                self._install_prepersist_dedup_hook(agent)
                mcp_tool_names = self._mcp_tool_names(self._agent_tool_names(getattr(agent, "tools", None) or []))

                session = AgentSession(
                    session_id=session_id,
                    agent=agent,
                    history=[],
                    config={
                        "requested_session_id": session_id,
                        "profile": profile or "default",
                        "model": resolved_model,
                        # Keep the user-facing provider selector (for example
                        # custom:liuzheng) separate from the normalized runtime
                        # provider (custom). Otherwise the next request sees a
                        # false provider change and rebuilds the client.
                        "provider": requested_provider or runtime.get("provider"),
                        "base_url": runtime.get("base_url"),
                        "api_mode": runtime.get("api_mode"),
                        "platform": _bridge_platform(),
                        "resumed": False,
                        "resumed_message_count": 0,
                        "mcp_tool_count": len(discovered_mcp_tools),
                        "active_mcp_tool_count": len(mcp_tool_names),
                        "db_error": self._db.error,
                        # This is an Agent-session policy, not a per-turn flag.
                        # Callers select it when the cached AIAgent is created.
                        "background_delegation_enabled": background_delegation_enabled is not False,
                    },
                )
                self._install_boundary_interrupt(session)
                session.config["boundary_interrupt_supported"] = session.boundary_supported
                if session.boundary_error:
                    session.config["boundary_interrupt_error"] = session.boundary_error
                self._sessions[session_id] = session
                return session

    def _model_switch_note(self, old_model: str, new_model: str, provider: str) -> str:
        provider_label = provider or "configured provider"
        return (
            f"[Note: model was just switched from {old_model or 'unknown'} to {new_model} "
            f"via {provider_label}. Adjust your self-identification accordingly.]"
        )

    def _set_pending_session_model_switch(
        self,
        session: AgentSession,
        model: str,
        provider: str,
        profile: str | None,
    ) -> None:
        requested_model = str(model or "").strip()
        requested_provider = str(provider or "").strip()
        if not requested_model:
            return
        old_model = str(session.config.get("model") or getattr(session.agent, "model", "") or "")
        session.config["pending_model_switch"] = {
            "model": requested_model,
            "provider": requested_provider,
            "profile": profile or session.config.get("profile") or "default",
        }
        session.config["pending_model_switch_note"] = self._model_switch_note(
            old_model,
            requested_model,
            requested_provider or str(session.config.get("provider") or ""),
        )

    def _switch_loaded_session_model(
        self,
        session: AgentSession,
        model: str,
        provider: str,
        profile: str | None,
        *,
        add_note: bool,
    ) -> dict[str, Any]:
        requested_model = str(model or "").strip()
        requested_provider = str(provider or "").strip()
        if not requested_model:
            raise ValueError("model is required")

        target_profile = str(profile or session.config.get("profile") or "default")
        old_model = str(session.config.get("model") or getattr(session.agent, "model", "") or "")

        with _profile_env(target_profile):
            _refresh_worker_profile_env()
            runtime = _resolve_runtime(requested_model, requested_provider or None)

        resolved_provider = str(runtime.get("provider") or requested_provider or "")
        effective_provider = requested_provider or resolved_provider
        current_agent_provider = str(getattr(session.agent, "provider", "") or "")
        current_agent_model = str(getattr(session.agent, "model", "") or "")
        current_base_url = str(getattr(session.agent, "base_url", "") or "").rstrip("/")
        resolved_base_url = str(runtime.get("base_url") or "").rstrip("/")
        current_api_mode = str(getattr(session.agent, "api_mode", "") or "")
        resolved_api_mode = str(runtime.get("api_mode") or "")
        current_api_key = getattr(session.agent, "api_key", None)
        resolved_api_key = runtime.get("api_key")

        # Provider selectors such as custom:liuzheng normalize to the runtime
        # provider "custom". Re-selecting that same runtime must not rebuild the
        # client: switch_model reconstructs _client_kwargs, and affected Hermes
        # runtimes lose model.default_headers during that reconstruction.
        runtime_unchanged = (
            requested_model == current_agent_model
            and resolved_provider == current_agent_provider
            and resolved_base_url == current_base_url
            and resolved_api_mode == current_api_mode
            and resolved_api_key == current_api_key
        )
        if runtime_unchanged:
            session.config.update({
                "profile": target_profile,
                "model": requested_model,
                "provider": effective_provider,
                "base_url": runtime.get("base_url"),
                "api_mode": runtime.get("api_mode"),
            })
            session.config.pop("pending_model_switch", None)
            session.last_used_at = time.time()
            return {
                "switched": True,
                "deferred": False,
                "session_id": session.session_id,
                "model": requested_model,
                "provider": effective_provider,
            }

        switch_model = getattr(session.agent, "switch_model", None)
        if not callable(switch_model):
            raise RuntimeError("loaded agent does not support switch_model")

        with _profile_env(target_profile):
            _refresh_worker_profile_env()
            reasoning_config = _load_reasoning_config(requested_model)

        switch_model(
            new_model=requested_model,
            new_provider=resolved_provider,
            api_key=runtime.get("api_key") or "",
            base_url=runtime.get("base_url") or "",
            api_mode=runtime.get("api_mode") or "",
        )
        session.agent.reasoning_config = reasoning_config
        if resolved_provider.lower() == "moa":
            self._install_moa_reference_callback(session)
        session.config.update({
            "profile": target_profile,
            "model": requested_model,
            "provider": effective_provider,
            "base_url": runtime.get("base_url"),
            "api_mode": runtime.get("api_mode"),
        })
        session.config.pop("pending_model_switch", None)
        if add_note:
            session.config["pending_model_switch_note"] = self._model_switch_note(
                old_model,
                requested_model,
                resolved_provider,
            )
        session.last_used_at = time.time()
        print(
            "[hermes_bridge] session model switched "
            f"session={session.session_id} model={requested_model} provider={resolved_provider}",
            file=sys.stderr,
            flush=True,
        )
        return {
            "session_id": session.session_id,
            "model": requested_model,
            "provider": effective_provider,
            "loaded": True,
            "switched": True,
        }

    def _install_moa_reference_callback(self, session: AgentSession) -> None:
        try:
            from agent.moa_loop import MoAClient

            progress_callback = self._tool_progress_callback(session.session_id)

            def reference_callback(event: str, **kwargs: Any) -> None:
                if event == "moa.reference":
                    progress_callback(
                        "moa.reference",
                        str(kwargs.get("label") or ""),
                        str(kwargs.get("text") or ""),
                        None,
                        moa_index=kwargs.get("index"),
                        moa_count=kwargs.get("count"),
                    )
                elif event == "moa.aggregating":
                    progress_callback(
                        "moa.aggregating",
                        str(kwargs.get("aggregator") or ""),
                        None,
                        None,
                        moa_ref_count=kwargs.get("ref_count"),
                    )

            session.agent.client = MoAClient(
                str(getattr(session.agent, "model", "") or session.config.get("model") or "default"),
                reference_callback=reference_callback,
            )
            session.agent._client_kwargs = {}
            session.agent.api_key = getattr(session.agent, "api_key", None) or "moa-virtual-provider"
            session.agent.base_url = "moa://local"
        except Exception as exc:
            print(
                f"[hermes_bridge] failed to install MoA reference callback session={session.session_id} error={exc}",
                file=sys.stderr,
                flush=True,
            )

    def _apply_pending_session_model_switch(self, session: AgentSession) -> None:
        pending = session.config.get("pending_model_switch")
        if not isinstance(pending, dict) or session.running:
            return
        try:
            self._switch_loaded_session_model(
                session,
                str(pending.get("model") or ""),
                str(pending.get("provider") or ""),
                str(pending.get("profile") or session.config.get("profile") or "default"),
                add_note=False,
            )
        except Exception as exc:
            print(
                "[hermes_bridge] pending session model switch failed "
                f"session={session.session_id} error={exc}",
                file=sys.stderr,
                flush=True,
            )

    def _prepend_pending_model_switch_note(self, session: AgentSession, message: Any) -> Any:
        note = str(session.config.pop("pending_model_switch_note", "") or "").strip()
        if not note:
            return message
        if isinstance(message, str):
            return f"{note}\n\n{message}"
        if isinstance(message, list):
            return [{"type": "text", "text": note}, *message]
        return message

    def switch_session_model(
        self,
        session_id: str,
        model: str,
        provider: str | None = None,
        profile: str | None = None,
    ) -> dict[str, Any]:
        requested_model = str(model or "").strip()
        requested_provider = str(provider or "").strip()
        if not requested_model:
            raise ValueError("model is required")
        with self._lock:
            session = self._sessions.get(session_id)
        if session is None:
            return {
                "session_id": session_id,
                "model": requested_model,
                "provider": requested_provider,
                "loaded": False,
                "switched": False,
                "reason": "session_not_loaded",
            }
        with session.lock:
            if session.running:
                self._set_pending_session_model_switch(
                    session,
                    requested_model,
                    requested_provider,
                    profile or str(session.config.get("profile") or "default"),
                )
                return {
                    "session_id": session_id,
                    "model": requested_model,
                    "provider": requested_provider,
                    "loaded": True,
                    "switched": False,
                    "deferred": True,
                    "reason": "session_running",
                }
            return self._switch_loaded_session_model(
                session,
                requested_model,
                requested_provider,
                profile or str(session.config.get("profile") or "default"),
                add_note=True,
            )

    def _install_prepersist_dedup_hook(self, agent: Any) -> None:
        """Skip one bridge-pre-persisted user message in the native DB flush."""
        original = getattr(agent, "_persist_session", None)
        if not callable(original) or getattr(original, "_hermes_bridge_prepersist_dedup_wrapper", False):
            return

        def wrapped_persist_session(messages: Any, conversation_history: Any = None, *args: Any, **kwargs: Any):
            if getattr(agent, "_hermes_bridge_prepersisted_user_pending", False) and isinstance(messages, list):
                for message in reversed(messages):
                    if isinstance(message, dict) and message.get("role") == "user" and not message.get("_db_persisted"):
                        message["_db_persisted"] = True
                        agent._hermes_bridge_prepersisted_user_pending = False
                        break
            return original(messages, conversation_history, *args, **kwargs)

        wrapped_persist_session._hermes_bridge_prepersist_dedup_wrapper = True  # type: ignore[attr-defined]
        agent._persist_session = wrapped_persist_session

    def _install_compression_hook(self, agent: Any, session_id: str) -> None:
        original = getattr(agent, "_compress_context", None)
        if not callable(original):
            return

        def wrapped_compress_context(messages, system_message, **kwargs):
            before_count = len(messages) if isinstance(messages, list) else 0
            approx_tokens = kwargs.get("approx_tokens")
            if not isinstance(approx_tokens, int) or approx_tokens <= 0:
                approx_tokens = self._estimate_context_tokens(agent, messages, system_message)
            print(
                "[hermes_bridge] compression requested "
                f"session={session_id} messages={before_count} "
                f"tokens={approx_tokens if approx_tokens is not None else 'unknown'} "
                f"focus={kwargs.get('focus_topic') or ''}",
                file=sys.stderr,
                flush=True,
            )
            request_id = uuid.uuid4().hex
            response_queue: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=1)
            with self._lock:
                self._compression_requests[request_id] = response_queue
            self._append_event(session_id, {
                "event": "bridge.compression.requested",
                "request_id": request_id,
                "message_count": before_count,
                "approx_tokens": approx_tokens,
                "focus_topic": kwargs.get("focus_topic"),
                "messages": _jsonable(messages),
            })
            try:
                response = response_queue.get(timeout=180)
                if response.get("error"):
                    raise RuntimeError(str(response.get("error")))
                compressed_messages = response.get("messages")
                if not isinstance(compressed_messages, list):
                    raise RuntimeError("bridge compression response missing messages")
                next_system_message = response.get("system_message", system_message)
                result_approx_tokens = self._estimate_context_tokens(agent, compressed_messages, next_system_message)
                self._append_event(session_id, {
                    "event": "bridge.compression.completed",
                    "request_id": request_id,
                    "message_count": before_count,
                    "result_messages": len(compressed_messages),
                    "approx_tokens": approx_tokens,
                    "result_approx_tokens": result_approx_tokens,
                    "compressed": True,
                })
                return compressed_messages, next_system_message
            except queue.Empty:
                self._append_event(session_id, {
                    "event": "bridge.compression.failed",
                    "request_id": request_id,
                    "message_count": before_count,
                    "approx_tokens": approx_tokens,
                    "error": "bridge compression timed out",
                })
                raise RuntimeError("bridge compression timed out")
            except Exception as exc:
                self._append_event(session_id, {
                    "event": "bridge.compression.failed",
                    "request_id": request_id,
                    "message_count": before_count,
                    "approx_tokens": approx_tokens,
                    "error": str(exc),
                })
                raise
            finally:
                with self._lock:
                    self._compression_requests.pop(request_id, None)

        agent._compress_context = wrapped_compress_context

    def _agent_system_prompt(self, agent: Any, system_message: Any = None) -> str:
        prompt = str(getattr(agent, "_cached_system_prompt", "") or "")
        if prompt:
            return prompt
        try:
            build_prompt = getattr(agent, "_build_system_prompt", None)
            if callable(build_prompt):
                return str(build_prompt(system_message) or "")
        except Exception:
            return str(system_message or "")
        return str(system_message or "")

    def _agent_tool_names(self, tools: Any) -> list[str]:
        return _tool_names_from_definitions(tools)

    def _mcp_tool_names(self, tool_names: Any) -> list[str]:
        return _mcp_tool_names_from_names(tool_names)

    def _estimate_context_info(self, agent: Any, messages: Any, system_message: Any = None) -> dict[str, Any]:
        try:
            from agent.model_metadata import estimate_request_tokens_rough
        except Exception:
            return {}

        prompt = self._agent_system_prompt(agent, system_message)
        tools = getattr(agent, "tools", None) or []
        message_list = messages if isinstance(messages, list) else []
        try:
            tool_names = self._agent_tool_names(tools)
            token_count = estimate_request_tokens_rough(message_list, system_prompt=prompt, tools=tools or None)
            fixed_context_tokens = estimate_request_tokens_rough([], system_prompt=prompt, tools=tools or None)
            system_prompt_tokens = estimate_request_tokens_rough([], system_prompt=prompt, tools=None)
            tool_tokens = max(0, int(fixed_context_tokens or 0) - int(system_prompt_tokens or 0))
            return {
                "token_count": int(token_count) if isinstance(token_count, (int, float)) and token_count > 0 else None,
                "fixed_context_tokens": int(fixed_context_tokens) if isinstance(fixed_context_tokens, (int, float)) and fixed_context_tokens >= 0 else None,
                "system_prompt_tokens": int(system_prompt_tokens) if isinstance(system_prompt_tokens, (int, float)) and system_prompt_tokens >= 0 else None,
                "tool_tokens": tool_tokens,
                "message_count": len(message_list),
                "tool_count": len(tools) if isinstance(tools, list) else 0,
                "tool_names": tool_names,
                "mcp_tool_count": len(self._mcp_tool_names(tool_names)),
                "mcp_tool_names": self._mcp_tool_names(tool_names),
                "system_prompt_chars": len(prompt),
            }
        except Exception:
            return {}

    def _estimate_context_tokens(self, agent: Any, messages: Any, system_message: Any = None) -> int | None:
        token_count = self._estimate_context_info(agent, messages, system_message).get("token_count")
        return int(token_count) if isinstance(token_count, (int, float)) and token_count > 0 else None

    def _bridge_context_ready_event(self, session: AgentSession, instructions: str | None, profile: str | None) -> dict[str, Any]:
        info = self._estimate_context_info(session.agent, [], instructions)
        event = {
            "event": "bridge.context.ready",
            "session_id": session.session_id,
            "profile": profile or session.config.get("profile") or "default",
            "model": session.config.get("model"),
            "provider": session.config.get("provider"),
            **info,
        }
        session.config["context_info"] = event
        return event

    def estimate_context(
        self,
        session_id: str,
        messages: list[dict[str, Any]] | None = None,
        instructions: str | None = None,
        profile: str | None = None,
        model: str | None = None,
        provider: str | None = None,
        workspace: str | None = None,
        background_delegation_enabled: bool | None = None,
    ) -> dict[str, Any]:
        session = self.get_or_create(
            session_id,
            profile=profile,
            model=model,
            provider=provider,
            background_delegation_enabled=background_delegation_enabled,
        )
        session_cwd_bound = _bind_session_workspace_cwd(session.session_id, workspace)
        try:
            context_info = self._estimate_context_info(session.agent, messages or [], instructions)
        finally:
            if session_cwd_bound:
                _clear_session_workspace_cwd()
        print(
            "[hermes_bridge] context estimate "
            f"session={session_id} profile={profile or 'default'} "
            f"messages={len(messages or [])} system_prompt_chars={context_info.get('system_prompt_chars') or 0} "
            f"tools={context_info.get('tool_count') or 0} "
            f"fixed_tokens={context_info.get('fixed_context_tokens') if context_info.get('fixed_context_tokens') is not None else 'unknown'} "
            f"tokens={context_info.get('token_count') if context_info.get('token_count') is not None else 'unknown'}",
            file=sys.stderr,
            flush=True,
        )
        return {
            "session_id": session_id,
            "profile": profile or session.config.get("profile") or "default",
            "model": session.config.get("model"),
            "provider": session.config.get("provider"),
            **context_info,
        }

    def respond_compression(
        self,
        request_id: str,
        messages: list[dict[str, Any]] | None = None,
        system_message: str | None = None,
        error: str | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            response_queue = self._compression_requests.get(request_id)
        if response_queue is None:
            raise RuntimeError(f"compression request {request_id} not found")
        response_queue.put({
            "messages": messages,
            "system_message": system_message,
            "error": error,
        })
        return {"request_id": request_id, "handled": True}

    def _destroy_session(self, session_id: str) -> None:
        session = self._sessions.pop(session_id, None)
        if session is None:
            return
        with self._lock:
            for rid in list(self._runs):
                if self._runs[rid].session_id == session_id:
                    del self._runs[rid]

    def _append_event(self, session_id: str, event: dict[str, Any]) -> None:
        with self._lock:
            session = self._sessions.get(session_id)
            if session and str(event.get("event") or "").startswith("subagent."):
                event = self._record_background_event(session, event)
            run_id = session.current_run_id if session else None
            if run_id and run_id in self._runs:
                self._runs[run_id].events.append(_jsonable(event))
            elif session and str(event.get("event") or "").startswith("subagent."):
                session.background_events.append(_jsonable(event))
                if len(session.background_events) > self.MAX_BACKGROUND_EVENTS_PER_SESSION:
                    del session.background_events[:-self.MAX_BACKGROUND_EVENTS_PER_SESSION]

    def _record_background_event(
        self,
        session: AgentSession,
        event: dict[str, Any],
    ) -> dict[str, Any]:
        """Attach stable UI routing metadata without touching agent messages."""
        session.background_event_seq += 1
        payload = dict(event)
        payload["background_seq"] = session.background_event_seq
        payload["session_id"] = session.session_id
        payload.setdefault("timestamp", time.time())

        subagent_id = str(payload.get("subagent_id") or "").strip()
        if subagent_id:
            previous = session.background_tasks.get(subagent_id, {})
            event_name = str(payload.get("event") or "")
            status = str(payload.get("status") or "").strip()
            if event_name == "subagent.start":
                status = "running"
            elif event_name != "subagent.complete":
                status = status or str(previous.get("status") or "running")
            else:
                status = status or "completed"
            task = {
                **previous,
                "subagent_id": subagent_id,
                "parent_id": payload.get("parent_id"),
                "depth": payload.get("depth"),
                "task_index": payload.get("task_index"),
                "task_count": payload.get("task_count"),
                "goal": payload.get("goal"),
                "model": payload.get("model"),
                "tool_count": payload.get("tool_count", previous.get("tool_count", 0)),
                "last_event": event_name,
                "last_tool": payload.get("tool_name") or previous.get("last_tool"),
                "preview": payload.get("text") or payload.get("summary") or previous.get("preview"),
                "status": status,
                "updated_at": payload["timestamp"],
            }
            if event_name == "subagent.start":
                task["started_at"] = payload["timestamp"]
            if event_name == "subagent.complete":
                task["completed_at"] = payload["timestamp"]
                task["summary"] = payload.get("summary")
                task["duration_seconds"] = payload.get("duration_seconds")
                task["api_calls"] = payload.get("api_calls")
                task["input_tokens"] = payload.get("input_tokens")
                task["output_tokens"] = payload.get("output_tokens")
                task["cost_usd"] = payload.get("cost_usd")
                task["files_read"] = payload.get("files_read")
                task["files_written"] = payload.get("files_written")
            session.background_tasks[subagent_id] = _jsonable(task)
            if len(session.background_tasks) > self.MAX_BACKGROUND_TASKS_PER_SESSION:
                ordered = sorted(
                    session.background_tasks.items(),
                    key=lambda item: float(item[1].get("updated_at") or 0),
                )
                removable = [item for item in ordered if item[1].get("status") != "running"]
                for stale_id, _ in removable[: max(0, len(ordered) - self.MAX_BACKGROUND_TASKS_PER_SESSION)]:
                    session.background_tasks.pop(stale_id, None)
        return payload

    def poll_background(self, recover_session_ids: list[Any] | None = None) -> dict[str, Any]:
        """Drain worker-level UI telemetry and claim owned async completions."""
        with self._lock:
            loaded_session_ids = set(self._sessions)
            loaded_session_ids.update(
                str(session_id).strip()
                for session_id in (recover_session_ids or [])
                if str(session_id).strip()
            )
            session_payloads = []
            for session in self._sessions.values():
                events = list(session.background_events)
                session.background_events.clear()
                tasks = list(session.background_tasks.values())
                if events or any(task.get("status") == "running" for task in tasks):
                    session_payloads.append({
                        "session_id": session.session_id,
                        "events": _jsonable(events),
                        "tasks": _jsonable(tasks),
                        "running_count": sum(1 for task in tasks if task.get("status") == "running"),
                    })

        notifications: list[dict[str, Any]] = []
        pending_notification_count = 0
        if loaded_session_ids:
            try:
                from tools.async_delegation import claim_event_delivery, complete_completion_delivery
                from tools.process_registry import format_process_notification, process_registry

                def owns_event(evt: dict[str, Any]) -> bool:
                    session_key = str(evt.get("session_key") or "")
                    parent_session_id = str(evt.get("parent_session_id") or "")
                    return session_key in loaded_session_ids or parent_session_id in loaded_session_ids

                deferred: list[dict[str, Any]] = []
                queue_size = process_registry.completion_queue.qsize()
                for _ in range(queue_size):
                    try:
                        event = process_registry.completion_queue.get_nowait()
                    except Exception:
                        break
                    if event.get("type") != "async_delegation" or not owns_event(event):
                        deferred.append(event)
                        continue
                    claim_id = claim_event_delivery(event, "agent-bridge")
                    if claim_id is None:
                        pending_notification_count += 1
                        deferred.append(event)
                        continue
                    delegation_id = str(event.get("delegation_id") or "")
                    with self._lock:
                        suppressed = delegation_id in self._suppressed_background_delegations
                    if suppressed or str(event.get("status") or "").lower() in {"interrupted", "cancelled", "canceled"}:
                        complete_completion_delivery(
                            delegation_id,
                            claim_id,
                        )
                        with self._lock:
                            self._suppressed_background_delegations.discard(delegation_id)
                        continue
                    message = format_process_notification(event)
                    if not message:
                        complete_completion_delivery(
                            str(event.get("delegation_id") or ""),
                            claim_id,
                        )
                        continue
                    session_id = str(event.get("parent_session_id") or event.get("session_key") or "")
                    notifications.append({
                        "delegation_id": str(event.get("delegation_id") or ""),
                        "session_id": session_id,
                        "claim_id": claim_id,
                        "status": event.get("status"),
                        "message": message,
                        "event": _jsonable(event),
                    })
                    with self._lock:
                        self._background_notification_claims[(
                            str(event.get("delegation_id") or ""),
                            claim_id,
                        )] = event
                for event in deferred:
                    process_registry.completion_queue.put(event)
            except Exception as exc:
                print(
                    f"[hermes_bridge] background completion poll failed: {exc}",
                    file=sys.stderr,
                    flush=True,
                )

        return {
            "sessions": session_payloads,
            "notifications": notifications,
            "pending_count": pending_notification_count,
        }

    def complete_background_notification(self, delegation_id: str, claim_id: str) -> dict[str, Any]:
        from tools.async_delegation import complete_completion_delivery

        completed = complete_completion_delivery(delegation_id, claim_id)
        with self._lock:
            self._background_notification_claims.pop((delegation_id, claim_id), None)
        return {"delegation_id": delegation_id, "completed": bool(completed)}

    def release_background_notification(self, delegation_id: str, claim_id: str) -> dict[str, Any]:
        from tools.async_delegation import release_completion_delivery

        released = release_completion_delivery(delegation_id, claim_id)
        with self._lock:
            event = self._background_notification_claims.pop((delegation_id, claim_id), None)
        if released and event is not None:
            from tools.process_registry import process_registry

            process_registry.completion_queue.put(event)
        return {"delegation_id": delegation_id, "released": bool(released)}

    def _status_callback(self, session_id: str):
        def callback(kind, text=None):
            self._append_event(session_id, {"event": "status", "kind": str(kind), "text": None if text is None else str(text)})

        return callback

    def _text_event_callback(self, session_id: str, event_name: str):
        def callback(text):
            self._append_event(session_id, {"event": event_name, "text": str(text)})

        return callback

    def _make_thinking_callback(self, session_id: str):
        """Create a thinking callback that never forwards spinner text as content.

        The hermes-agent CLI uses thinking_callback for its KawaiiSpinner TUI
        widget — sending decorative text like "(◕‿◕✿) pondering..." during
        API calls.  This is pure CLI UX decoration; it has no place in Web UI
        conversation history.

        Prior behaviour forwarded this text as thinking.delta events, which the
        frontend stored in the message reasoning field.  Over long conversations
        this contaminated the model's context: the LLM learned to reproduce
        kaomoji patterns, creating a self-reinforcing degradation loop.

        This callback sends empty text unconditionally.  The model's real
        reasoning content arrives through reasoning_callback → reasoning.delta,
        which is unaffected.
        """
        def callback(text=None):
            self._append_event(session_id, {"event": "thinking.delta", "text": ""})

        return callback

    def _tool_start_callback(self, session_id: str):
        def callback(tool_call_id, function_name, function_args):
            self._append_event(session_id, {
                "event": "tool.started",
                "tool_call_id": str(tool_call_id) if tool_call_id else "",
                "tool_name": str(function_name) if function_name else "",
                "args": _jsonable(function_args) if function_args else {},
            })

        return callback

    def _tool_complete_callback(self, session_id: str):
        def callback(tool_call_id, function_name, function_args, function_result=None):
            result_text = "" if function_result is None else str(function_result)
            print(
                "[hermes_bridge] tool_complete_callback "
                f"session={session_id} tool={function_name} "
                f"tool_call_id={tool_call_id} result_none={function_result is None} "
                f"result_len={len(result_text)}",
                file=sys.stderr,
                flush=True,
            )
            self._append_event(session_id, {
                "event": "tool.completed",
                "tool_call_id": str(tool_call_id) if tool_call_id else "",
                "tool_name": str(function_name) if function_name else "",
                "args": _jsonable(function_args) if function_args else {},
                "result": _jsonable(function_result) if function_result is not None else None,
                "result_preview": str(function_result)[:500] if function_result else None,
            })

        return callback

    def _tool_progress_callback(self, session_id: str):
        def callback(event_type, function_name=None, preview=None, function_args=None, **kwargs):
            if event_type in (None, "tool.started", "tool.completed") or str(event_type or "").startswith("subagent."):
                print(
                    "[hermes_bridge] tool_progress_callback "
                    f"session={session_id} event={event_type} tool={function_name} "
                    f"kwargs_keys={sorted(kwargs.keys())} "
                    f"preview_len={len(str(preview)) if preview is not None else 0}",
                    file=sys.stderr,
                    flush=True,
                )
            if event_type == "reasoning.available":
                self._append_event(session_id, {
                    "event": "reasoning.available",
                    "text": str(preview) if preview else "",
                })
                return

            if str(event_type or "").startswith("subagent."):
                payload = {
                    "event": str(event_type),
                    "tool_name": str(function_name) if function_name else "",
                    "text": str(preview) if preview is not None else "",
                    "args": _jsonable(function_args) if function_args else {},
                }
                for key, value in kwargs.items():
                    payload[str(key)] = _jsonable(value)
                self._append_event(session_id, payload)
                return

            if event_type == "moa.reference":
                payload = {
                    "event": "moa.reference",
                    "label": str(function_name or kwargs.get("label") or "reference"),
                    "text": str(preview) if preview is not None else "",
                }
                if kwargs.get("moa_index") is not None:
                    payload["index"] = _jsonable(kwargs.get("moa_index"))
                if kwargs.get("moa_count") is not None:
                    payload["count"] = _jsonable(kwargs.get("moa_count"))
                self._append_event(session_id, payload)
                return

            if event_type == "moa.aggregating":
                self._append_event(session_id, {
                    "event": "moa.aggregating",
                    "aggregator": str(function_name or kwargs.get("aggregator") or ""),
                })
                return

            if event_type == "_thinking":
                text = function_name
                if text:
                    self._append_event(session_id, {
                        "event": "reasoning.delta",
                        "text": str(text),
                    })
                return

            if event_type in (None, "tool.started"):
                # AIAgent also calls tool_start_callback with the real tool_call_id.
                # Use that event as canonical so resume/replay can match results.
                return

            if event_type == "tool.completed":
                # AIAgent sends the full function_result to tool_complete_callback.
                return

        return callback

    def _step_callback(self, session_id: str):
        def callback(step_info=None):
            self._append_event(session_id, {
                "event": "step",
                "step_info": _jsonable(step_info) if step_info else None,
            })

        return callback

    def _stream_delta_callback(self, session_id: str):
        def callback(delta=None):
            if delta is None:
                # Turn boundary signal (tools about to execute)
                self._append_event(session_id, {
                    "event": "turn.boundary",
                })
                return
            # Text deltas are already captured by the per-run stream_callback
            # passed to run_conversation.  Only consume boundary signals here
            # so registering this callback does not duplicate assistant text.

        return callback

    def _interim_assistant_callback(self, session_id: str):
        def callback(text, *, already_streamed=False):
            value = str(text or "")
            if not value.strip():
                return
            self._append_event(session_id, {
                "event": "message.interim",
                "text": value,
                "already_streamed": bool(already_streamed),
            })

        return callback

    def _approval_callback(self, session_id: str):
        def callback(command: str, description: str, *, allow_permanent: bool = True) -> str:
            approval_id = uuid.uuid4().hex
            response_queue: queue.Queue[str] = queue.Queue(maxsize=1)
            with self._lock:
                run_id = str(self._sessions.get(session_id).current_run_id or "") if self._sessions.get(session_id) else ""
                self._approval_requests[approval_id] = response_queue
                self._approval_request_generations[approval_id] = (session_id, run_id)
            choices = ["once", "session", "always", "deny"] if allow_permanent else ["once", "session", "deny"]
            self._append_event(session_id, {
                "event": "approval.requested",
                "run_id": run_id,
                "approval_id": approval_id,
                "command": str(command or ""),
                "description": str(description or ""),
                "choices": choices,
                "allow_permanent": bool(allow_permanent),
                "timeout_ms": APPROVAL_TIMEOUT_MS,
            })
            try:
                choice = response_queue.get(timeout=APPROVAL_TIMEOUT_SECONDS)
            except queue.Empty:
                choice = "deny"
            finally:
                with self._lock:
                    self._approval_requests.pop(approval_id, None)
                    self._approval_request_generations.pop(approval_id, None)
            self._append_event(session_id, {
                "event": "approval.resolved",
                "run_id": run_id,
                "approval_id": approval_id,
                "choice": choice,
            })
            return choice

        return callback

    def _clarify_callback(self, session_id: str):
        def callback(question: str, choices: list[str] | None = None) -> str:
            clarify_id = uuid.uuid4().hex
            response_queue: queue.Queue[str] = queue.Queue(maxsize=1)
            with self._lock:
                self._clarify_requests[clarify_id] = response_queue
            self._append_event(session_id, {
                "event": "clarify.requested",
                "clarify_id": clarify_id,
                "question": str(question or ""),
                "choices": list(choices) if choices else None,
                "timeout_ms": 300_000,
            })
            try:
                user_response = response_queue.get(timeout=300)
            except queue.Empty:
                user_response = "[user did not respond within 5m]"
            finally:
                with self._lock:
                    self._clarify_requests.pop(clarify_id, None)
            return user_response

        return callback

    def _approval_dispatcher(self, command: str, description: str, *, allow_permanent: bool = True) -> str:
        session_id = str(getattr(self._run_context, "session_id", "") or "")
        if not session_id:
            return "deny"
        with self._lock:
            handler = self._approval_handlers.get(session_id)
        if handler is None:
            return "deny"
        return handler(command, description, allow_permanent=allow_permanent)

    def _install_approval_dispatcher_for_current_thread(self, session_id: str) -> None:
        from tools.terminal_tool import set_approval_callback

        # terminal_tool stores callbacks in threading.local(), and Hermes
        # propagates that callback object into tool worker threads. Bind the
        # session id into the callback itself instead of relying on this
        # bridge's thread-local run context, which is not propagated by Hermes.
        set_approval_callback(self._approval_callback(session_id))

    def _enter_exec_ask_scope(self) -> None:
        with self._lock:
            if self._exec_ask_depth == 0:
                self._exec_ask_previous = os.environ.get("HERMES_EXEC_ASK")
                os.environ["HERMES_EXEC_ASK"] = "1"
            self._exec_ask_depth += 1

    def _exit_exec_ask_scope(self) -> None:
        with self._lock:
            if self._exec_ask_depth <= 0:
                return
            self._exec_ask_depth -= 1
            if self._exec_ask_depth > 0:
                return
            previous = self._exec_ask_previous
            self._exec_ask_previous = None
            if previous is None:
                os.environ.pop("HERMES_EXEC_ASK", None)
            else:
                os.environ["HERMES_EXEC_ASK"] = previous

    def _gateway_approval_notify(self, session_id: str):
        def callback(approval_data: dict[str, Any]) -> None:
            approval_id = uuid.uuid4().hex
            choices = ["once", "session", "always", "deny"]
            pattern_keys = _approval_pattern_keys(approval_data)
            request_id = str(approval_data.get("request_id") or "").strip()
            with self._lock:
                run_id = str(self._sessions.get(session_id).current_run_id or "") if self._sessions.get(session_id) else ""
                self._gateway_approval_requests[approval_id] = (session_id, run_id, request_id)
                self._gateway_approval_pattern_keys[approval_id] = pattern_keys
            self._append_event(session_id, {
                "event": "approval.requested",
                "run_id": run_id,
                "approval_id": approval_id,
                "command": str(approval_data.get("command") or ""),
                "description": str(approval_data.get("description") or ""),
                "pattern_keys": pattern_keys,
                "choices": choices,
                "allow_permanent": True,
                "timeout_ms": 300_000,
            })

        return callback

    def _prepersist_user_message(
        self,
        session: AgentSession,
        message: Any,
        storage_message: Any | None,
        conversation_history: list[dict[str, Any]] | None,
        profile: str | None,
        source: str | None = None,
    ) -> bool:
        persist_message = storage_message if storage_message is not None else message
        user_content = str(persist_message) if not isinstance(persist_message, dict) else str(persist_message.get("content", persist_message))
        if not user_content.strip():
            return False

        db = self._db.get_for_profile(profile)
        if db is None:
            return False

        history_len = len(conversation_history) if conversation_history else 0

        try:
            if hasattr(db, "create_session"):
                db.create_session(
                    session_id=session.session_id,
                    source=source or _bridge_platform(),
                    model=session.config.get("model"),
                )

            if hasattr(db, "get_messages"):
                messages = db.get_messages(session.session_id)
                if messages:
                    last = messages[-1]
                    if last.get("role") == "user" and last.get("content") == user_content:
                        self._align_prepersist_flush_cursor(session, history_len)
                        return False

            db.append_message(
                session_id=session.session_id,
                role="user",
                content=user_content,
            )

            # The native agent flush receives its own live message list. Mark
            # exactly one user entry in that list only after this durable write
            # succeeds, so fallback persistence remains available on failures.
            session.agent._hermes_bridge_prepersisted_user_pending = True

            # AIAgent will build messages as conversation_history + current user.
            # Since the current user was pre-persisted above, align the flush
            # cursor so the normal end-of-turn flush starts at assistant/tool
            # messages generated by this run.
            self._align_prepersist_flush_cursor(session, history_len)
            return True
        except Exception:
            return False

    def _align_prepersist_flush_cursor(self, session: AgentSession, history_len: int) -> None:
        try:
            session.agent._last_flushed_db_idx = history_len + 1
        except Exception:
            pass

    def _session_db_message_count(self, session_id: str, profile: str | None) -> int | None:
        db = self._db.get_for_profile(profile)
        if db is None or not hasattr(db, "get_messages"):
            return None
        try:
            return len(db.get_messages(session_id) or [])
        except Exception:
            return None

    def _sync_result_tail_to_session_db(
        self,
        session: AgentSession,
        result: dict[str, Any],
        conversation_history: list[dict[str, Any]] | None,
        profile: str | None,
        db_count_after_prepersist: int | None,
    ) -> None:
        db = self._db.get_for_profile(profile)
        if db is None or db_count_after_prepersist is None:
            return

        after_count = self._session_db_message_count(session.session_id, profile)
        if after_count is None:
            return

        messages = result.get("messages")
        if not isinstance(messages, list):
            return

        history_len = len(conversation_history) if conversation_history else 0
        generated = [
            msg for msg in messages[history_len + 1:]
            if isinstance(msg, dict) and msg.get("role") in {"assistant", "tool"}
        ]
        if not generated:
            return

        already_persisted = max(0, after_count - db_count_after_prepersist)
        if already_persisted >= len(generated):
            return
        generated = generated[already_persisted:]

        appended = 0
        for msg in generated:
            try:
                db.append_message(
                    session_id=session.session_id,
                    role=str(msg.get("role") or "assistant"),
                    content=msg.get("content"),
                    tool_name=msg.get("tool_name"),
                    tool_calls=msg.get("tool_calls") if isinstance(msg.get("tool_calls"), list) else None,
                    tool_call_id=msg.get("tool_call_id"),
                    finish_reason=msg.get("finish_reason"),
                    reasoning=msg.get("reasoning") if msg.get("role") == "assistant" else None,
                    reasoning_content=msg.get("reasoning_content") if msg.get("role") == "assistant" else None,
                    reasoning_details=msg.get("reasoning_details") if msg.get("role") == "assistant" else None,
                    codex_reasoning_items=msg.get("codex_reasoning_items") if msg.get("role") == "assistant" else None,
                    codex_message_items=msg.get("codex_message_items") if msg.get("role") == "assistant" else None,
                )
                appended += 1
            except Exception:
                break

        if appended:
            print(
                "[hermes_bridge] synced missing result tail to session db "
                f"session={session.session_id} appended={appended}",
                file=sys.stderr,
                flush=True,
            )

    def _result_from_agent_messages_for_sync(self, session: AgentSession) -> dict[str, Any] | None:
        for attr in ("messages", "_messages", "_session_messages"):
            messages = getattr(session.agent, attr, None)
            if isinstance(messages, list):
                return {"messages": copy.deepcopy(messages)}
        if isinstance(session.history, list) and session.history:
            return {"messages": copy.deepcopy(session.history)}
        return None

    def start_chat(
        self,
        session_id: str,
        message: Any,
        storage_message: Any | None = None,
        instructions: str | None = None,
        conversation_history: list[dict[str, Any]] | None = None,
        profile: str | None = None,
        force_compress: bool = False,
        model: str | None = None,
        provider: str | None = None,
        workspace: str | None = None,
        source: str | None = None,
        reasoning_effort: str | None = None,
        background_delegation_enabled: bool | None = None,
    ) -> RunRecord:
        session = self.get_or_create(
            session_id,
            profile=profile,
            model=model,
            provider=provider,
            background_delegation_enabled=background_delegation_enabled,
        )
        # Install after agent construction so any runtime plugin initialization
        # has completed. Rechecking on every run also recovers from a forced
        # plugin reload that clears the manager's callback registry.
        self._install_usage_hook()
        self._install_boundary_interrupt(session)
        session.config["boundary_interrupt_supported"] = session.boundary_supported
        if session.boundary_error:
            session.config["boundary_interrupt_error"] = session.boundary_error
        else:
            session.config.pop("boundary_interrupt_error", None)
        with session.lock:
            if session.running:
                raise RuntimeError(f"session {session_id} is already running")
            run_id = uuid.uuid4().hex
            record = RunRecord(run_id=run_id, session_id=session_id)
            with self._lock:
                self._runs[run_id] = record
            session.running = True
            session.current_run_id = run_id
            session.boundary_phase = "model"
            session.boundary_pending_run_id = None
            session.boundary_reached_run_id = None
            session.last_used_at = time.time()
            session_cwd_bound = _bind_session_workspace_cwd(session.session_id, workspace)
            try:
                context_event = self._bridge_context_ready_event(session, instructions, profile)
                if context_event:
                    record.events.append(_jsonable(context_event))
            finally:
                if session_cwd_bound:
                    _clear_session_workspace_cwd()

        thread = threading.Thread(
            target=self._run_chat,
            args=(session, record, message, storage_message, instructions, conversation_history, profile, force_compress, workspace, source, reasoning_effort),
            daemon=True,
            name=f"hermes-bridge-run-{run_id[:8]}",
        )
        thread.start()
        return record

    def _run_chat(self, session: AgentSession, record: RunRecord, message: Any, storage_message: Any | None = None, instructions: str | None = None, conversation_history: list[dict[str, Any]] | None = None, profile: str | None = None, force_compress: bool = False, workspace: str | None = None, source: str | None = None, reasoning_effort: str | None = None) -> None:
        with _profile_env(profile):
            _refresh_approval_allowlist()
            _install_execute_code_approval_memory_patch()
            def stream_callback(delta: str) -> None:
                with self._lock:
                    text = str(delta)
                    # Keep `deltas` for the aggregated `output`/resume snapshot,
                    # AND record each text chunk as an ordered event in the SAME
                    # `events` list used by tool.started/tool.completed. Text and
                    # tool events were previously tracked in two parallel lists
                    # with no relative ordering, so when the model interleaved
                    # narration and tool calls ("text → tool → more text") the
                    # consumer reordered them — processing all events before the
                    # aggregated delta — which visibly split a word across the
                    # tool boundary. Recording text as ordered events preserves
                    # the true interleaving.
                    record.deltas.append(text)
                    if text:
                        record.events.append({"event": "stream.delta", "delta": text})

            approval_session_token = None
            session_context_tokens = None
            registered_gateway_approval_session = None
            exec_ask_scope_entered = False
            session_cwd_bound = False
            db_count_after_prepersist: int | None = None
            result_for_tail_sync: dict[str, Any] | None = None
            tail_synced = False
            try:
                session_cwd_bound = _bind_session_workspace_cwd(session.session_id, workspace)
                try:
                    session_context_tokens = _set_bridge_session_vars(
                        session.session_id,
                        profile,
                        workspace,
                        session.config.get("background_delegation_enabled", True) is not False,
                    )
                except Exception:
                    session_context_tokens = None
                try:
                    self._enter_exec_ask_scope()
                    exec_ask_scope_entered = True
                    self._install_approval_dispatcher_for_current_thread(session.session_id)
                    with self._lock:
                        self._approval_handlers[session.session_id] = self._approval_callback(session.session_id)
                    self._run_context.session_id = session.session_id
                except Exception:
                    self._run_context.session_id = session.session_id
                try:
                    from tools.approval import register_gateway_notify
                    try:
                        from tools.approval_context import set_current_session_key
                    except ModuleNotFoundError as exc:
                        if exc.name != "tools.approval_context":
                            raise
                        from tools.approval import set_current_session_key

                    approval_session_token = set_current_session_key(session.session_id)
                    register_gateway_notify(session.session_id, self._gateway_approval_notify(session.session_id))
                    registered_gateway_approval_session = session.session_id
                except Exception:
                    pass
                self._prepersist_user_message(session, message, storage_message, conversation_history, profile, source)
                db_count_after_prepersist = self._session_db_message_count(session.session_id, profile)
                agent_message = self._prepend_pending_model_switch_note(session, message)
                if force_compress:
                    compress = getattr(session.agent, "_compress_context", None)
                    if callable(compress):
                        compressed_history, compressed_system = compress(
                            conversation_history if isinstance(conversation_history, list) else [],
                            instructions,
                            approx_tokens=None,
                            focus_topic="debug_force_compress",
                        )
                        if isinstance(compressed_history, list):
                            conversation_history = compressed_history
                        if isinstance(compressed_system, str):
                            instructions = compressed_system
                kwargs: dict[str, Any] = dict(
                    task_id=session.session_id,
                    stream_callback=stream_callback,
                )
                if instructions:
                    kwargs["system_message"] = instructions
                if conversation_history is not None:
                    kwargs["conversation_history"] = conversation_history
                # Local patch (reasoning-effort): per-run reasoning effort override (Web UI brain button).
                # Mutates session.agent.reasoning_config in place — restored after run.
                _saved_reasoning_config = None
                _did_override_reasoning = False
                if reasoning_effort:
                    try:
                        from hermes_constants import parse_reasoning_effort
                        override_cfg = parse_reasoning_effort(str(reasoning_effort).strip())
                        # parse_reasoning_effort returns None for invalid input; only
                        # override when we got a recognized value.
                        if override_cfg is not None:
                            _saved_reasoning_config = getattr(session.agent, "reasoning_config", None)
                            session.agent.reasoning_config = override_cfg
                            _did_override_reasoning = True
                    except Exception:
                        # Non-fatal: fall through to default reasoning_config
                        pass
                try:
                    result = session.agent.run_conversation(
                        agent_message,
                        **kwargs,
                    )
                finally:
                    if _did_override_reasoning:
                        session.agent.reasoning_config = _saved_reasoning_config
                result = _jsonable(result if isinstance(result, dict) else {"value": result})
                with session.lock:
                    boundary_interrupted = self._boundary_result_for_run(session, record.run_id)
                    if boundary_interrupted:
                        result["interrupted"] = True
                        result["boundary_interrupt"] = True
                        result["finish_reason"] = "boundary_interrupt"
                        session.boundary_reached_run_id = record.run_id
                result_for_tail_sync = result
                self._sync_result_tail_to_session_db(
                    session,
                    result,
                    conversation_history,
                    profile,
                    db_count_after_prepersist,
                )
                tail_synced = True
                final_response = str(
                    result.get("final_response")
                    or result.get("response")
                    or result.get("output")
                    or "".join(record.deltas)
                    or ""
                ).strip()
                title_db = self._db.get_for_profile(profile)
                if title_db is not None and final_response and not result.get("failed") and not result.get("partial"):
                    try:
                        from agent.title_generator import maybe_auto_title

                        def title_callback(title: str) -> None:
                            cleaned = str(title or "").strip()
                            if not cleaned:
                                return
                            with self._lock:
                                record.events.append(_jsonable({
                                    "event": "session.title.updated",
                                    "session_id": session.session_id,
                                    "title": cleaned,
                                }))

                        maybe_auto_title(
                            title_db,
                            session.session_id,
                            _title_user_message(message),
                            final_response,
                            result.get("messages", []) if isinstance(result.get("messages"), list) else [],
                            failure_callback=getattr(session.agent, "_emit_auxiliary_failure", None),
                            main_runtime={
                                "model": getattr(session.agent, "model", None),
                                "provider": getattr(session.agent, "provider", None),
                                "base_url": getattr(session.agent, "base_url", None),
                                "api_key": getattr(session.agent, "api_key", None),
                                "api_mode": getattr(session.agent, "api_mode", None),
                            },
                            title_callback=title_callback,
                        )
                    except Exception:
                        pass
                with session.lock:
                    if isinstance(result.get("messages"), list):
                        session.history = result["messages"]
                    record.status = "interrupted" if result.get("interrupted") else "complete"
                    record.result = result
                    record.ended_at = time.time()
                    if boundary_interrupted:
                        record.events.append({
                            "event": "run.boundary_interrupt",
                            "run_id": record.run_id,
                            "finish_reason": "boundary_interrupt",
                        })
                        self._clear_completed_boundary_interrupt(session.agent)
                    self._reset_boundary_run(session, record.run_id)
                    session.running = False
                    session.current_run_id = None
                    session.last_used_at = time.time()
                self._apply_pending_session_model_switch(session)
            except Exception as exc:
                with session.lock:
                    boundary_interrupted = self._boundary_result_for_run(session, record.run_id)
                if not tail_synced:
                    try:
                        fallback_result = result_for_tail_sync or self._result_from_agent_messages_for_sync(session)
                        if fallback_result is not None:
                            self._sync_result_tail_to_session_db(
                                session,
                                fallback_result,
                                conversation_history,
                                profile,
                                db_count_after_prepersist,
                            )
                    except Exception:
                        pass
                with session.lock:
                    if boundary_interrupted:
                        record.status = "interrupted"
                        record.error = None
                        record.result = {
                            "interrupted": True,
                            "boundary_interrupt": True,
                            "finish_reason": "boundary_interrupt",
                        }
                        record.events.append({
                            "event": "run.boundary_interrupt",
                            "run_id": record.run_id,
                            "finish_reason": "boundary_interrupt",
                        })
                        self._clear_completed_boundary_interrupt(session.agent)
                    else:
                        record.status = "error"
                        record.error = str(exc)
                        record.result = {"error": str(exc), "traceback": traceback.format_exc()}
                    record.ended_at = time.time()
                    self._reset_boundary_run(session, record.run_id)
                    session.running = False
                    session.current_run_id = None
                    session.last_used_at = time.time()
                self._apply_pending_session_model_switch(session)
            finally:
                # A failed or interrupted run may never reach a native flush.
                # Do not let its one-shot marker affect a later fallback turn.
                session.agent._hermes_bridge_prepersisted_user_pending = False
                with self._lock:
                    self._approval_handlers.pop(session.session_id, None)
                try:
                    del self._run_context.session_id
                except AttributeError:
                    pass
                if approval_session_token is not None:
                    try:
                        from tools.approval import unregister_gateway_notify
                        try:
                            from tools.approval_context import reset_current_session_key
                        except ModuleNotFoundError as exc:
                            if exc.name != "tools.approval_context":
                                raise
                            from tools.approval import reset_current_session_key

                        if registered_gateway_approval_session is not None:
                            unregister_gateway_notify(registered_gateway_approval_session)
                        reset_current_session_key(approval_session_token)
                    except Exception:
                        pass
                if session_context_tokens is not None:
                    try:
                        from gateway.session_context import clear_session_vars

                        clear_session_vars(session_context_tokens)
                    except Exception:
                        pass
                if exec_ask_scope_entered:
                    self._exit_exec_ask_scope()
                if session_cwd_bound:
                    _clear_session_workspace_cwd()

    @staticmethod
    def _background_delegation_ids_for_session(session_id: str) -> list[str]:
        try:
            from tools.async_delegation import list_async_delegations

            ids = []
            for record in list_async_delegations():
                if str(record.get("status") or "") not in {"running", "finalizing"}:
                    continue
                if not any(
                    str(record.get(key) or "") == session_id
                    for key in ("session_key", "origin_ui_session_id", "parent_session_id")
                ):
                    continue
                delegation_id = str(record.get("delegation_id") or "").strip()
                if delegation_id:
                    ids.append(delegation_id)
            return ids
        except Exception:
            return []

    def has_active_background_for_session(self, session_id: str) -> bool:
        """Return whether a session still owns running background work."""
        try:
            from tools.async_delegation import list_async_delegations

            for record in list_async_delegations():
                if str(record.get("status") or "").lower() not in {"running", "finalizing"}:
                    continue
                if any(
                    str(record.get(key) or "") == session_id
                    for key in ("session_key", "origin_ui_session_id", "parent_session_id")
                ):
                    return True
            return False
        except Exception:
            # The durable registry is authoritative when available. Fall back
            # to worker telemetry so a transient registry failure cannot let
            # idle GC interrupt a task the worker still sees as active.
            with self._lock:
                session = self._sessions.get(session_id)
                if session is None:
                    return False
                return any(
                    str(task.get("status") or "").lower() in {"running", "finalizing"}
                    for task in session.background_tasks.values()
                )

    @staticmethod
    def _interrupt_background_for_session(session_id: str, reason: str) -> int:
        try:
            from tools.async_delegation import interrupt_for_session

            return int(interrupt_for_session(
                session_key=session_id,
                origin_ui_session_id=session_id,
                parent_session_id=session_id,
                reason=reason,
            ) or 0)
        except Exception:
            return 0

    def _settle_interrupted_background_tasks(self, session_id: str) -> int:
        """Persist terminal UI events when upstream interruption ends silently."""
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                return 0
            timestamp = time.time()
            interrupted = 0
            for subagent_id, task in list(session.background_tasks.items()):
                if str(task.get("status") or "").lower() != "running":
                    continue
                event = {
                    **task,
                    "event": "subagent.complete",
                    "subagent_id": subagent_id,
                    "tool_name": task.get("last_tool"),
                    "status": "interrupted",
                    "timestamp": timestamp,
                    "completed_at": timestamp,
                }
                recorded = self._record_background_event(session, event)
                session.background_events.append(_jsonable(recorded))
                interrupted += 1
            if len(session.background_events) > self.MAX_BACKGROUND_EVENTS_PER_SESSION:
                del session.background_events[:-self.MAX_BACKGROUND_EVENTS_PER_SESSION]
            return interrupted

    def interrupt(self, session_id: str, message: str | None = None) -> dict[str, Any]:
        with self._lock:
            session = self._sessions.get(session_id)
        if session is None:
            raise KeyError(f"unknown session: {session_id}")
        with session.lock:
            self._cancel_boundary_run(session)
            interrupted_run_id = str(session.current_run_id or "")
        background_delegation_ids = self._background_delegation_ids_for_session(session_id)
        with self._lock:
            self._suppressed_background_delegations.update(background_delegation_ids)
        background_interrupted = self._interrupt_background_for_session(
            session_id,
            "user_interrupt",
        )
        self._settle_interrupted_background_tasks(session_id)
        if not hasattr(session.agent, "interrupt"):
            raise RuntimeError("agent does not support interrupt")
        session.agent.interrupt(message)
        self._cancel_pending_approvals_for_generation(session_id, interrupted_run_id)
        deadline = time.time() + 10.0
        synced = False
        while time.time() < deadline:
            with session.lock:
                if not session.running:
                    synced = True
                    break
            time.sleep(0.05)
        return {
            "status": "interrupted",
            "session_id": session_id,
            "synced": synced,
            "background_interrupted": background_interrupted,
            "background_delegation_ids": background_delegation_ids,
        }

    def _cancel_pending_approvals_for_generation(self, session_id: str, run_id: str) -> int:
        if not session_id or not run_id:
            return 0
        terminal_queues: list[queue.Queue[str]] = []
        gateway_approvals: list[tuple[str, str, list[str]]] = []
        with self._lock:
            for approval_id, approval_generation in list(self._approval_request_generations.items()):
                if approval_generation != (session_id, run_id):
                    continue
                response_queue = self._approval_requests.pop(approval_id, None)
                self._approval_request_generations.pop(approval_id, None)
                if response_queue is not None:
                    terminal_queues.append(response_queue)
            for approval_id, approval_generation in list(self._gateway_approval_requests.items()):
                if approval_generation[:2] != (session_id, run_id):
                    continue
                self._gateway_approval_requests.pop(approval_id, None)
                gateway_approvals.append((
                    approval_id,
                    approval_generation[2],
                    self._gateway_approval_pattern_keys.pop(approval_id, []),
                ))
        for response_queue in terminal_queues:
            try:
                response_queue.put_nowait("deny")
            except queue.Full:
                pass
        for approval_id, request_id, _pattern_keys in gateway_approvals:
            try:
                from tools.approval import resolve_gateway_approval

                if request_id:
                    resolve_gateway_approval(session_id, "deny", request_id=request_id)
            except Exception:
                pass
            self._append_event(session_id, {
                "event": "approval.resolved",
                "run_id": run_id,
                "approval_id": approval_id,
                "choice": "deny",
                "reason": "Session interrupted",
            })
        return len(terminal_queues) + len(gateway_approvals)

    def request_boundary_interrupt(
        self,
        session_id: str,
        expected_run_id: str | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            session = self._sessions.get(session_id)
        if session is None:
            return {
                "status": "not_running",
                "session_id": session_id,
                "guarantee": "strict",
            }

        with session.lock:
            if not session.boundary_supported:
                return {
                    "status": "unsupported",
                    "session_id": session_id,
                    "guarantee": "none",
                    "reason": session.boundary_error or "boundary interrupt is unavailable",
                }
            run_id = session.current_run_id
            if not session.running or not run_id:
                return {
                    "status": "not_running",
                    "session_id": session_id,
                    "guarantee": "strict",
                }
            cleaned_expected_run_id = str(expected_run_id or "").strip()
            if cleaned_expected_run_id and cleaned_expected_run_id != run_id:
                return {
                    "status": "run_mismatch",
                    "session_id": session_id,
                    "run_id": run_id,
                    "guarantee": "strict",
                }
            phase = session.boundary_phase
            if phase not in {"model", "tool_batch"}:
                return {
                    "status": "unsupported",
                    "session_id": session_id,
                    "run_id": run_id,
                    "guarantee": "none",
                    "reason": f"unsupported boundary phase: {phase}",
                }
            if (
                session.boundary_pending_run_id == run_id
                or session.boundary_reached_run_id == run_id
            ):
                return {
                    "status": "already_pending",
                    "session_id": session_id,
                    "run_id": run_id,
                    "phase": phase,
                    "guarantee": "strict",
                }

            session.boundary_pending_run_id = run_id
            if phase == "model":
                try:
                    self._signal_boundary_model_interrupt(session.agent)
                except Exception as exc:
                    session.boundary_pending_run_id = None
                    self._clear_completed_boundary_interrupt(session.agent)
                    session.boundary_supported = False
                    session.boundary_error = str(exc)
                    session.config["boundary_interrupt_supported"] = False
                    session.config["boundary_interrupt_error"] = str(exc)
                    return {
                        "status": "unsupported",
                        "session_id": session_id,
                        "run_id": run_id,
                        "guarantee": "none",
                        "reason": str(exc),
                    }
            return {
                "status": "accepted",
                "session_id": session_id,
                "run_id": run_id,
                "phase": phase,
                "guarantee": "strict",
            }

    def steer(self, session_id: str, text: str) -> dict[str, Any]:
        with self._lock:
            session = self._sessions.get(session_id)
        if session is None:
            raise KeyError(f"unknown session: {session_id}")
        if not hasattr(session.agent, "steer"):
            raise RuntimeError("agent does not support steer")
        accepted = bool(session.agent.steer(text))
        return {"status": "queued" if accepted else "rejected", "accepted": accepted, "text": text}

    def respond_approval(self, approval_id: str, choice: str) -> dict[str, Any]:
        cleaned = str(choice or "deny").strip().lower()
        if cleaned not in {"once", "session", "always", "deny"}:
            cleaned = "deny"
        with self._lock:
            response_queue = self._approval_requests.pop(approval_id, None)
            if response_queue is not None:
                self._approval_request_generations.pop(approval_id, None)
                try:
                    response_queue.put_nowait(cleaned)
                except queue.Full:
                    pass
        if response_queue is None:
            with self._lock:
                gateway_generation = self._gateway_approval_requests.pop(approval_id, None)
                pattern_keys = self._gateway_approval_pattern_keys.pop(approval_id, [])
            if gateway_generation is None:
                return {"approval_id": approval_id, "resolved": False, "choice": cleaned}
            gateway_session_id, gateway_run_id, gateway_request_id = gateway_generation
            try:
                from tools.approval import resolve_gateway_approval

                resolved = bool(gateway_request_id) and resolve_gateway_approval(
                    gateway_session_id,
                    cleaned,
                    request_id=gateway_request_id,
                ) > 0
            except Exception:
                resolved = False
            if resolved:
                _persist_execute_code_approval_choice(gateway_session_id, pattern_keys, cleaned)
            self._append_event(gateway_session_id, {
                "event": "approval.resolved",
                "run_id": gateway_run_id,
                "approval_id": approval_id,
                "choice": cleaned,
            })
            return {"approval_id": approval_id, "resolved": resolved, "choice": cleaned}
        return {"approval_id": approval_id, "resolved": True, "choice": cleaned}

    def respond_clarify(self, clarify_id: str, response: str) -> dict[str, Any]:
        with self._lock:
            response_queue = self._clarify_requests.get(clarify_id)
        if response_queue is None:
            return {"clarify_id": clarify_id, "resolved": False}
        try:
            response_queue.put_nowait(response)
        except queue.Full:
            pass
        return {"clarify_id": clarify_id, "resolved": True}

    def get_history(self, session_id: str) -> dict[str, Any]:
        with self._lock:
            session = self._sessions.get(session_id)
        if session is None:
            raise KeyError(f"unknown session: {session_id}")
        with session.lock:
            return {"session_id": session_id, "history": copy.deepcopy(session.history)}

    def get_session_title(self, session_id: str, profile: str | None = None) -> dict[str, Any]:
        if not session_id:
            raise ValueError("session_id is required")
        db = self._db.get_for_profile(profile)
        title = None
        if db is not None and hasattr(db, "get_session_title"):
            try:
                title = db.get_session_title(session_id)
            except Exception:
                title = None
        return {"session_id": session_id, "title": str(title or "")}

    def dispatch_command(self, session_id: str, command: str, profile: str | None = None) -> dict[str, Any]:
        raw = str(command or "").strip()
        if raw.startswith("/"):
            raw = raw[1:].strip()
        if not raw:
            raise ValueError("command is required")

        parts = raw.split(maxsplit=1)
        name = parts[0].lstrip("/").strip().lower()
        arg = parts[1] if len(parts) > 1 else ""

        with _profile_env(profile):
            if name == "goal":
                return self._dispatch_goal_command(session_id, arg)
            if name == "subgoal":
                return self._dispatch_subgoal_command(session_id, arg)
            if name == "yolo":
                try:
                    from tools.approval import (
                        disable_session_yolo,
                        enable_session_yolo,
                        is_session_yolo_enabled,
                    )
                except ImportError:
                    return {
                        "session_id": session_id,
                        "command": name,
                        "handled": False,
                        "type": "yolo",
                        "message": (
                            "/yolo requires a newer Hermes Agent runtime with "
                            "session-scoped YOLO support."
                        ),
                    }

                enabled = not is_session_yolo_enabled(session_id)
                if enabled:
                    enable_session_yolo(session_id)
                else:
                    disable_session_yolo(session_id)
                return {
                    "session_id": session_id,
                    "command": name,
                    "handled": True,
                    "type": "yolo",
                    "action": "yolo",
                    "enabled": enabled,
                    "message": (
                        "⚡ YOLO mode ON for this session — all commands "
                        "auto-approved. Use with caution."
                        if enabled
                        else "⚠️ YOLO mode OFF for this session — dangerous "
                        "commands will require approval."
                    ),
                }
            if name == "learn":
                try:
                    from agent.learn_prompt import build_learn_prompt
                except ImportError:
                    return {
                        "session_id": session_id,
                        "command": name,
                        "handled": False,
                        "type": "learn",
                        "message": "/learn requires a newer Hermes Agent runtime with agent.learn_prompt.",
                    }

                return {
                    "session_id": session_id,
                    "command": name,
                    "handled": True,
                    "type": "learn",
                    "message": build_learn_prompt(arg),
                }
            if name in {"reload-skills", "reload_skills"}:
                from agent.skill_commands import reload_skills

                result = reload_skills()
                return {
                    "session_id": session_id,
                    "command": name,
                    "handled": True,
                    "type": "reload-skills",
                    "action": "reload-skills",
                    **_jsonable(result),
                }

            try:
                try:
                    from agent.skill_bundles import (
                        build_bundle_invocation_message,
                        resolve_bundle_command_key,
                    )

                    bundle_key = resolve_bundle_command_key(name)
                    if bundle_key:
                        bundle_result = build_bundle_invocation_message(
                            bundle_key,
                            arg,
                            task_id=session_id,
                        )
                        if bundle_result:
                            message, loaded_names, missing_names = bundle_result
                            return {
                                "session_id": session_id,
                                "command": name,
                                "handled": True,
                                "type": "bundle",
                                "message": message,
                                "loaded": loaded_names,
                                "missing": missing_names,
                            }
                except ImportError:
                    pass

                from agent.skill_commands import (
                    build_skill_invocation_message,
                    resolve_skill_command_key,
                )

                key = resolve_skill_command_key(name)
                if key:
                    message = build_skill_invocation_message(
                        key,
                        arg,
                        task_id=session_id,
                        runtime_note=(
                            "If you need user clarification, call the clarify tool. "
                            "Do not output raw JSON question/choices payloads as the final response."
                        ),
                    )
                    if message:
                        return {
                            "session_id": session_id,
                            "command": name,
                            "handled": True,
                            "type": "skill",
                            "message": message,
                        }
            except Exception as exc:
                raise RuntimeError(f"skill command dispatch failed: {exc}") from exc

        return {
            "session_id": session_id,
            "command": name,
            "handled": False,
            "message": f"not a supported bridge command: /{name}",
        }

    def _goal_max_turns_from_config(self) -> int:
        try:
            from hermes_cli.config import load_config

            goals_cfg = (load_config() or {}).get("goals") or {}
            return int(goals_cfg.get("max_turns", 20) or 20)
        except Exception:
            return 20

    def _goal_manager(self, session_id: str):
        from hermes_cli.goals import GoalManager

        return GoalManager(
            session_id=session_id,
            default_max_turns=self._goal_max_turns_from_config(),
        )

    def _dispatch_goal_command(self, session_id: str, arg: str) -> dict[str, Any]:
        mgr = self._goal_manager(session_id)
        clean_arg = str(arg or "").strip()
        lower = clean_arg.lower()

        if not clean_arg or lower == "status":
            return {
                "session_id": session_id,
                "command": "goal",
                "handled": True,
                "type": "goal",
                "action": "goal_status",
                "message": mgr.status_line(),
            }

        if lower == "pause":
            state = mgr.pause(reason="user-paused")
            return {
                "session_id": session_id,
                "command": "goal",
                "handled": True,
                "type": "goal",
                "action": "pause",
                "message": f"⏸ Goal paused: {state.goal}" if state else "No goal set.",
                "clear_goal_continuations": True,
            }

        if lower == "resume":
            state = mgr.resume()
            prompt = mgr.next_continuation_prompt() if state else None
            return {
                "session_id": session_id,
                "command": "goal",
                "handled": True,
                "type": "goal",
                "action": "resume",
                "message": f"▶ Goal resumed: {state.goal}" if state else "No goal to resume.",
                "kickoff_prompt": prompt,
                "max_turns": state.max_turns if state else None,
            }

        if lower in {"clear", "stop", "done"}:
            had = mgr.has_goal()
            mgr.clear()
            return {
                "session_id": session_id,
                "command": "goal",
                "handled": True,
                "type": "goal",
                "action": "clear",
                "message": "✓ Goal cleared." if had else "No active goal.",
                "clear_goal_continuations": True,
            }

        try:
            state = mgr.set(clean_arg)
        except ValueError as exc:
            return {
                "session_id": session_id,
                "command": "goal",
                "handled": True,
                "type": "goal",
                "action": "set",
                "message": f"Invalid goal: {exc}",
            }

        return {
            "session_id": session_id,
            "command": "goal",
            "handled": True,
            "type": "goal",
            "action": "set",
            "message": (
                f"⊙ Goal set ({state.max_turns}-turn budget): {state.goal}\n"
                "After each turn, a judge model will check if the goal is done. "
                "Hermes keeps working until it is, you pause/clear it, or the budget is exhausted."
            ),
            "kickoff_prompt": state.goal,
            "max_turns": state.max_turns,
        }

    def _dispatch_subgoal_command(self, session_id: str, arg: str) -> dict[str, Any]:
        mgr = self._goal_manager(session_id)
        clean_arg = str(arg or "").strip()
        if not mgr.has_goal():
            return {
                "session_id": session_id,
                "command": "subgoal",
                "handled": True,
                "type": "goal",
                "action": "subgoal",
                "message": "No active goal. Set one with /goal <text>.",
            }

        if not clean_arg:
            return {
                "session_id": session_id,
                "command": "subgoal",
                "handled": True,
                "type": "goal",
                "action": "subgoal_status",
                "message": f"{mgr.status_line()}\n{mgr.render_subgoals()}",
            }

        tokens = clean_arg.split(None, 1)
        verb = tokens[0].lower()
        rest = tokens[1].strip() if len(tokens) > 1 else ""

        if verb == "remove":
            if not rest:
                message = "Usage: /subgoal remove <n>"
            else:
                try:
                    idx = int(rest.split()[0])
                    removed = mgr.remove_subgoal(idx)
                    message = f"✓ Removed subgoal {idx}: {removed}"
                except ValueError:
                    message = "/subgoal remove: <n> must be an integer (1-based index)."
                except (IndexError, RuntimeError) as exc:
                    message = f"/subgoal remove: {exc}"
            return {
                "session_id": session_id,
                "command": "subgoal",
                "handled": True,
                "type": "goal",
                "action": "subgoal_remove",
                "message": message,
            }

        if verb == "clear":
            try:
                prev = mgr.clear_subgoals()
                message = f"✓ Cleared {prev} subgoal{'s' if prev != 1 else ''}." if prev else "No subgoals to clear."
            except RuntimeError as exc:
                message = f"/subgoal clear: {exc}"
            return {
                "session_id": session_id,
                "command": "subgoal",
                "handled": True,
                "type": "goal",
                "action": "subgoal_clear",
                "message": message,
            }

        try:
            text = mgr.add_subgoal(clean_arg)
            idx = len(mgr.state.subgoals) if mgr.state else 0
            message = f"✓ Added subgoal {idx}: {text}"
        except (ValueError, RuntimeError) as exc:
            message = f"/subgoal: {exc}"

        return {
            "session_id": session_id,
            "command": "subgoal",
            "handled": True,
            "type": "goal",
            "action": "subgoal_add",
            "message": message,
        }

    def evaluate_goal(self, session_id: str, final_response: str, profile: str | None = None) -> dict[str, Any]:
        with _profile_env(profile):
            mgr = self._goal_manager(session_id)
            if not mgr.is_active():
                return {
                    "session_id": session_id,
                    "handled": True,
                    "active": False,
                    "should_continue": False,
                    "continuation_prompt": None,
                    "message": "",
                    "verdict": "inactive",
                }
            decision = mgr.evaluate_after_turn(str(final_response or ""), user_initiated=True)
            return {
                "session_id": session_id,
                "handled": True,
                "active": mgr.is_active(),
                **decision,
            }

    def pause_goal(self, session_id: str, reason: str, profile: str | None = None) -> dict[str, Any]:
        with _profile_env(profile):
            clean_reason = str(reason or "").strip() or "paused"
            mgr = self._goal_manager(session_id)
            state = mgr.pause(reason=clean_reason)
            return {
                "session_id": session_id,
                "command": "goal",
                "handled": True,
                "type": "goal",
                "action": "pause",
                "active": mgr.is_active(),
                "status": state.status if state else None,
                "reason": clean_reason,
                "message": f"⏸ Goal paused: {state.goal}" if state else "No goal set.",
                "clear_goal_continuations": True,
            }

    def get_result(self, run_id: str) -> dict[str, Any]:
        with self._lock:
            record = self._runs.get(run_id)
        if record is None:
            raise KeyError(f"unknown run: {run_id}")
        return {
            "run_id": record.run_id,
            "session_id": record.session_id,
            "status": record.status,
            "started_at": record.started_at,
            "ended_at": record.ended_at,
            "output": "".join(record.deltas),
            "deltas": list(record.deltas),
            "events": list(record.events),
            "result": record.result,
            "error": record.error,
        }

    def get_output(self, run_id: str, cursor: int = 0, event_cursor: int = 0) -> dict[str, Any]:
        with self._lock:
            record = self._runs.get(run_id)
        if record is None:
            raise KeyError(f"unknown run: {run_id}")
        cursor = max(0, int(cursor or 0))
        deltas = list(record.deltas)
        next_cursor = len(deltas)
        event_cursor = max(0, int(event_cursor or 0))
        events = list(record.events)
        new_events = _jsonable(events[event_cursor:])
        next_event_cursor = len(events)
        return {
            "run_id": record.run_id,
            "session_id": record.session_id,
            "status": record.status,
            "delta": "".join(deltas[cursor:]),
            "cursor": next_cursor,
            "output": "".join(deltas),
            "done": record.status != "running",
            "result": record.result if record.status != "running" else None,
            "error": record.error,
            "events": new_events,
            "event_cursor": next_event_cursor,
        }

    def destroy(self, session_id: str) -> dict[str, Any]:
        background_delegation_ids = self._background_delegation_ids_for_session(session_id)
        with self._lock:
            self._suppressed_background_delegations.update(background_delegation_ids)
        background_interrupted = self._interrupt_background_for_session(
            session_id,
            "session_destroyed",
        )
        with self._lock:
            session = self._sessions.pop(session_id, None)
        if session is None:
            return {
                "session_id": session_id,
                "destroyed": False,
                "background_interrupted": background_interrupted,
                "background_delegation_ids": background_delegation_ids,
            }
        if session.running and hasattr(session.agent, "interrupt"):
            try:
                with session.lock:
                    self._cancel_boundary_run(session)
                session.agent.interrupt("Session destroyed")
            except Exception:
                pass
        return {
            "session_id": session_id,
            "destroyed": True,
            "background_interrupted": background_interrupted,
            "background_delegation_ids": background_delegation_ids,
        }

    def destroy_all(self) -> dict[str, Any]:
        with self._lock:
            ids = list(self._sessions.keys())
        destroyed = []
        for sid in ids:
            result = self.destroy(sid)
            destroyed.append(result)
        return {"destroyed": len(destroyed)}

    def shutdown(self) -> dict[str, Any]:
        """Bounded worker cleanup for parent runs, delegations, and tool processes."""
        with self._lock:
            sessions = list(self._sessions.values())
            claimed_notifications = list(self._background_notification_claims)

        interrupted_sessions = 0
        for session in sessions:
            if not session.running or not hasattr(session.agent, "interrupt"):
                continue
            try:
                with session.lock:
                    self._cancel_boundary_run(session)
                session.agent.interrupt("Agent bridge shutting down")
                interrupted_sessions += 1
            except Exception:
                pass

        interrupted_delegations = 0
        active_count = None
        try:
            from tools.async_delegation import active_count as async_active_count
            from tools.async_delegation import interrupt_all

            active_count = async_active_count
            interrupted_delegations = int(interrupt_all("agent_bridge_shutdown") or 0)
        except Exception:
            pass

        killed_processes = 0
        try:
            from tools.process_registry import process_registry

            killed_processes = int(process_registry.kill_all() or 0)
        except Exception:
            pass

        if active_count is not None and interrupted_delegations:
            deadline = time.time() + 2.0
            while time.time() < deadline:
                try:
                    if int(active_count() or 0) == 0:
                        break
                except Exception:
                    break
                time.sleep(0.05)

        released_claims = 0
        if claimed_notifications:
            try:
                from tools.async_delegation import release_completion_delivery

                for delegation_id, claim_id in claimed_notifications:
                    if release_completion_delivery(delegation_id, claim_id):
                        released_claims += 1
            except Exception:
                pass
            with self._lock:
                for key in claimed_notifications:
                    self._background_notification_claims.pop(key, None)

        return {
            "interrupted_sessions": interrupted_sessions,
            "interrupted_delegations": interrupted_delegations,
            "killed_processes": killed_processes,
            "released_claims": released_claims,
        }

    def status(self, session_id: str) -> dict[str, Any]:
        with self._lock:
            session = self._sessions.get(session_id)
        if session is None:
            return {
                "session_id": session_id,
                "exists": False,
                "running": False,
                "message_count": 0,
            }
        with session.lock:
            return {
                "session_id": session_id,
                "exists": True,
                "running": session.running,
                "current_run_id": session.current_run_id,
                "boundary_interrupt": {
                    "supported": session.boundary_supported,
                    "phase": session.boundary_phase,
                    "pending_run_id": session.boundary_pending_run_id,
                    "reached_run_id": session.boundary_reached_run_id,
                    "error": session.boundary_error,
                },
                "created_at": session.created_at,
                "last_used_at": session.last_used_at,
                "message_count": len(session.history),
                "config": session.config,
            }

    def list_sessions(self) -> dict[str, Any]:
        with self._lock:
            sessions = list(self._sessions.values())
        return {
            "sessions": [
                {
                    "session_id": s.session_id,
                    "running": s.running,
                    "current_run_id": s.current_run_id,
                    "boundary_interrupt": {
                        "supported": s.boundary_supported,
                        "phase": s.boundary_phase,
                        "pending_run_id": s.boundary_pending_run_id,
                        "reached_run_id": s.boundary_reached_run_id,
                        "error": s.boundary_error,
                    },
                    "created_at": s.created_at,
                    "last_used_at": s.last_used_at,
                    "message_count": len(s.history),
                    "config": s.config,
                }
                for s in sessions
            ]
        }
