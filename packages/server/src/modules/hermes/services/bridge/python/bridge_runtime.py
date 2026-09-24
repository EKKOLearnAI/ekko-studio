from __future__ import annotations

import asyncio
import errno
import importlib.util
import json
import locale
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable

DEFAULT_ENDPOINT = "tcp://127.0.0.1:18765" if os.name == "nt" else "ipc:///tmp/hermes-agent-bridge.sock"
DEFAULT_AGENT_ROOT = "~/.hermes/hermes-agent"
DEFAULT_HERMES_HOME = "~/.hermes"
APPROVAL_TIMEOUT_SECONDS = 120
APPROVAL_TIMEOUT_MS = APPROVAL_TIMEOUT_SECONDS * 1000
PARENT_WATCHDOG_INTERVAL_SECONDS = 2.0
OPENROUTER_ATTRIBUTION_ENV = {
    "referer": "HERMES_OPENROUTER_APP_REFERER",
    "title": "HERMES_OPENROUTER_APP_TITLE",
    "categories": "HERMES_OPENROUTER_APP_CATEGORIES",
}
_SURROGATE_RE = re.compile("[\ud800-\udfff]")


def _bridge_platform() -> str:
    return os.environ.get("HERMES_AGENT_BRIDGE_PLATFORM", "cli").strip() or "cli"


def _positive_int(value: str | None) -> int | None:
    if not value:
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _title_user_message(message: Any) -> str:
    if isinstance(message, list):
        parts: list[str] = []
        for block in message:
            if isinstance(block, dict):
                if block.get("type") == "text":
                    parts.append(str(block.get("text") or ""))
                elif block.get("name"):
                    parts.append(str(block.get("name") or ""))
            else:
                parts.append(str(block))
        text = "\n".join(part for part in parts if part).strip()
    else:
        text = str(message or "").strip()
    if not text:
        return ""
    return (
        f"{text}\n\n"
        "[Title language: use the same language as the user's message. "
        "Do not translate the title to English unless the user's message is English.]"
    )


def _hidden_subprocess_kwargs() -> dict[str, Any]:
    if os.name != "nt":
        return {}
    if os.environ.get("HERMES_DESKTOP", "").strip().lower() != "true":
        return {}
    create_no_window = getattr(subprocess, "CREATE_NO_WINDOW", 0) or 0x08000000
    kwargs: dict[str, Any] = {"creationflags": create_no_window}
    try:
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= getattr(subprocess, "STARTF_USESHOWWINDOW", 1)
        startupinfo.wShowWindow = getattr(subprocess, "SW_HIDE", 0)
        kwargs["startupinfo"] = startupinfo
    except Exception:
        pass
    return kwargs


def _add_hidden_process_options(kwargs: dict[str, Any], create_no_window: int) -> None:
    flags = kwargs.get("creationflags", 0) or 0
    try:
        kwargs["creationflags"] = int(flags) | create_no_window
    except Exception:
        kwargs["creationflags"] = create_no_window

    startupinfo = kwargs.get("startupinfo")
    if startupinfo is None:
        try:
            startupinfo = subprocess.STARTUPINFO()
        except Exception:
            return
        kwargs["startupinfo"] = startupinfo
    try:
        startupinfo.dwFlags |= getattr(subprocess, "STARTF_USESHOWWINDOW", 1)
        startupinfo.wShowWindow = getattr(subprocess, "SW_HIDE", 0)
    except Exception:
        pass


def _install_windows_hidden_subprocess_defaults() -> None:
    """Hide console windows for subprocesses launched inside desktop bridge runs.

    The desktop bridge itself must keep stdout/stderr pipes for readiness and
    worker handshakes, so it runs under python.exe. On Windows that means any
    nested console executable, including git.exe from context expansion, can
    flash a window unless the child process is created with CREATE_NO_WINDOW.
    """
    if os.name != "nt":
        return
    if os.environ.get("HERMES_DESKTOP", "").strip().lower() != "true":
        return
    if getattr(subprocess, "_hermes_hidden_defaults_installed", False):
        return

    original_popen = subprocess.Popen
    original_create_subprocess_exec = asyncio.create_subprocess_exec
    original_create_subprocess_shell = asyncio.create_subprocess_shell
    create_no_window = getattr(subprocess, "CREATE_NO_WINDOW", 0) or 0x08000000

    class HiddenPopen(original_popen):  # type: ignore[misc, valid-type]
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            _add_hidden_process_options(kwargs, create_no_window)
            super().__init__(*args, **kwargs)

    async def hidden_create_subprocess_exec(*args: Any, **kwargs: Any) -> Any:
        _add_hidden_process_options(kwargs, create_no_window)
        return await original_create_subprocess_exec(*args, **kwargs)

    async def hidden_create_subprocess_shell(*args: Any, **kwargs: Any) -> Any:
        _add_hidden_process_options(kwargs, create_no_window)
        return await original_create_subprocess_shell(*args, **kwargs)

    subprocess.Popen = HiddenPopen  # type: ignore[assignment]
    asyncio.create_subprocess_exec = hidden_create_subprocess_exec  # type: ignore[assignment]
    asyncio.create_subprocess_shell = hidden_create_subprocess_shell  # type: ignore[assignment]
    subprocess._hermes_hidden_defaults_installed = True  # type: ignore[attr-defined]


_install_windows_hidden_subprocess_defaults()


def _process_exists(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        try:
            result = subprocess.run(
                ["tasklist.exe", "/FI", f"PID eq {pid}", "/NH"],
                check=False,
                capture_output=True,
                text=True,
                encoding=_platform_text_encoding(),
                errors="ignore",
                timeout=5,
                **_hidden_subprocess_kwargs(),
            )
            return str(pid) in (result.stdout or "")
        except Exception:
            return True
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError as exc:
        return exc.errno != errno.ESRCH


def _start_parent_process_watchdog(
    parent_pid: int | None,
    stop_event: threading.Event,
    label: str,
    interval: float = PARENT_WATCHDOG_INTERVAL_SECONDS,
) -> None:
    if not parent_pid or parent_pid == os.getpid():
        return

    def run() -> None:
        while not stop_event.wait(interval):
            if _process_exists(parent_pid):
                continue
            print(
                f"[hermes-bridge] parent pid {parent_pid} exited; stopping {label}",
                file=sys.stderr,
                flush=True,
            )
            stop_event.set()
            return

    threading.Thread(target=run, daemon=True, name=f"hermes-bridge-parent-watchdog-{label}").start()


def _install_stop_signal_handlers(stop_event: threading.Event) -> Callable[[], None]:
    if threading.current_thread() is not threading.main_thread():
        return lambda: None

    previous: list[tuple[signal.Signals, Any]] = []

    def handle_signal(signum: int, _frame: Any) -> None:
        stop_event.set()

    for signum in (signal.SIGINT, signal.SIGTERM):
        try:
            sig = signal.Signals(signum)
            previous.append((sig, signal.getsignal(sig)))
            signal.signal(sig, handle_signal)
        except Exception:
            pass

    def restore() -> None:
        for sig, handler in previous:
            try:
                signal.signal(sig, handler)
            except Exception:
                pass

    return restore


def _suppress_bridge_platform_hint() -> None:
    raw = os.environ.get("HERMES_BRIDGE_SUPPRESS_PLATFORM_HINT", "cli").strip()
    if raw.lower() in {"0", "false", "no", "off"}:
        return
    targets = {part.strip().lower() for part in raw.split(",") if part.strip()}
    if not targets:
        return
    try:
        from agent import prompt_builder

        for target in targets:
            prompt_builder.PLATFORM_HINTS.pop(target, None)
    except Exception:
        pass

    run_agent_module = sys.modules.get("run_agent")
    hints = getattr(run_agent_module, "PLATFORM_HINTS", None)
    if isinstance(hints, dict):
        for target in targets:
            hints.pop(target, None)


def _candidate_agent_roots(raw: str | None = None) -> list[Path]:
    candidates: list[Path] = []
    if raw:
        candidates.append(Path(raw).expanduser())

    env_root = os.environ.get("HERMES_AGENT_ROOT")
    if env_root:
        candidates.append(Path(env_root).expanduser())

    hermes_bin = shutil.which(os.environ.get("HERMES_BIN", "hermes"))
    if hermes_bin:
        bin_path = Path(hermes_bin).resolve()
        candidates.extend([
            bin_path.parent.parent,
            bin_path.parent.parent.parent,
            bin_path.parent.parent / "hermes-agent",
        ])

    script_path = Path(__file__).resolve()
    candidates.extend([
        Path.cwd(),
        Path.cwd() / ".hermes" / "hermes-agent",
        Path.cwd() / "hermes-agent",
        script_path.parent,
        script_path.parent.parent,
        script_path.parent.parent.parent,
        script_path.parent.parent.parent / ".hermes" / "hermes-agent",
    ])
    for parent in script_path.parents:
        candidates.extend([
            parent / ".hermes" / "hermes-agent",
            parent / "hermes-agent",
        ])

    candidates.extend([
        Path.home() / ".hermes" / "hermes-agent",
        Path.home() / "hermes-agent",
        Path("/opt/hermes/hermes-agent"),
        Path("/opt/hermes-agent"),
        Path("/usr/local/lib/hermes-agent"),
        Path("/usr/local/hermes-agent"),
    ])
    candidates.append(Path(DEFAULT_AGENT_ROOT).expanduser())

    unique: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
        except OSError:
            resolved = candidate
        key = str(resolved)
        if key not in seen:
            seen.add(key)
            unique.append(resolved)
    return unique


def _find_agent_root(raw: str | None = None) -> Path | None:
    for candidate in _candidate_agent_roots(raw):
        if (candidate / "run_agent.py").exists():
            return candidate
    return None


def _discover_agent_root(raw: str | None = None) -> Path:
    root = _find_agent_root(raw)
    if root is not None:
        return root
    attempted = ", ".join(str(path) for path in _candidate_agent_roots(raw))
    raise RuntimeError(
        "hermes-agent run_agent.py not found. Pass --agent-root or set "
        f"HERMES_AGENT_ROOT. Tried: {attempted}"
    )


def _discover_hermes_home(raw: str | None = None) -> Path:
    if raw:
        return Path(raw).expanduser().resolve()
    env_home = os.environ.get("HERMES_HOME")
    if env_home:
        return Path(env_home).expanduser().resolve()
    return Path(DEFAULT_HERMES_HOME).expanduser().resolve()


def _normalize_base_home(home: Path) -> Path:
    if home.parent.name == "profiles":
        return home.parent.parent
    return home


def _jsonable(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except TypeError:
        if isinstance(value, dict):
            return {str(k): _jsonable(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [_jsonable(v) for v in value]
        return str(value)


def _sanitize_surrogates(value: Any) -> Any:
    if isinstance(value, str):
        return _SURROGATE_RE.sub("\ufffd", value)
    if isinstance(value, dict):
        return {_sanitize_surrogates(k): _sanitize_surrogates(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_sanitize_surrogates(v) for v in value]
    return value


def _json_default(value: Any) -> str:
    return _sanitize_surrogates(str(value))


def _json_line_bytes(value: Any) -> bytes:
    payload = json.dumps(_sanitize_surrogates(value), ensure_ascii=False, default=_json_default) + "\n"
    return payload.encode("utf-8")


def _bridge_log(event: str, payload: dict[str, Any]) -> None:
    try:
        body = {"event": event, **payload}
        print(
            "[hermes_bridge] " + json.dumps(_sanitize_surrogates(body), ensure_ascii=False, default=_json_default),
            file=sys.stderr,
            flush=True,
        )
    except Exception:
        print(f"[hermes_bridge] {event}", file=sys.stderr, flush=True)


def _tool_names_from_definitions(tools: Any) -> list[str]:
    if not isinstance(tools, list):
        return []
    names: list[str] = []
    for tool in tools:
        name = ""
        if isinstance(tool, dict):
            function = tool.get("function")
            if isinstance(function, dict):
                name = str(function.get("name") or "")
            if not name:
                name = str(tool.get("name") or "")
        else:
            name = str(getattr(tool, "name", "") or "")
        if name:
            names.append(name)
    return names


def _mcp_tool_names_from_names(tool_names: Any) -> list[str]:
    if not isinstance(tool_names, list):
        return []
    return sorted(str(name) for name in tool_names if str(name).startswith("mcp_"))


def _agent_root() -> Path | None:
    return _find_agent_root(os.environ.get("HERMES_AGENT_ROOT"))


def _hermes_home() -> Path:
    return _discover_hermes_home(os.environ.get("HERMES_HOME"))


def _base_hermes_home() -> Path:
    return _normalize_base_home(_discover_hermes_home(os.environ.get("HERMES_AGENT_BRIDGE_BASE_HOME") or DEFAULT_HERMES_HOME))


def _worker_profile() -> str | None:
    raw = os.environ.get("HERMES_AGENT_BRIDGE_WORKER_PROFILE", "").strip()
    return raw or None


def _profile_home(profile: str | None) -> Path:
    base = _base_hermes_home()
    if not profile or profile == "default":
        return base
    profile_home = base / "profiles" / profile
    return profile_home if profile_home.exists() else base


def _read_dotenv(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    values: dict[str, str] = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            if stripped.startswith("export "):
                stripped = stripped[7:].strip()
            key, value = stripped.split("=", 1)
            key = key.strip()
            if not key or not (key[0].isalpha() or key[0] == "_"):
                continue
            if not all(ch.isalnum() or ch == "_" for ch in key):
                continue
            value = value.strip()
            if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
                value = value[1:-1]
            values[key] = value
        return values
    except Exception:
        return {}


def _profile_dotenv_keys() -> set[str]:
    base = _base_hermes_home()
    keys = set(_read_dotenv(base / ".env").keys())
    profiles_dir = base / "profiles"
    try:
        for entry in profiles_dir.iterdir():
            if entry.is_dir():
                keys.update(_read_dotenv(entry / ".env").keys())
    except Exception:
        pass
    return keys


def _set_path_env(agent_root: str | None = None, hermes_home: str | None = None) -> None:
    resolved_root = _discover_agent_root(agent_root) if agent_root else _find_agent_root()
    if resolved_root is not None:
        os.environ["HERMES_AGENT_ROOT"] = str(resolved_root)
    else:
        os.environ.pop("HERMES_AGENT_ROOT", None)
    resolved_home = _discover_hermes_home(hermes_home)
    os.environ["HERMES_HOME"] = str(resolved_home)
    os.environ["HERMES_AGENT_BRIDGE_BASE_HOME"] = str(_normalize_base_home(resolved_home))


def _ensure_agent_imports() -> None:
    root = _agent_root()
    if root is not None:
        root_s = str(root)
        if root_s not in sys.path:
            sys.path.insert(0, root_s)
    elif importlib.util.find_spec("run_agent") is None:
        raise RuntimeError(
            "hermes-agent run_agent.py not found in source locations and the "
            "current Python environment cannot import run_agent. Install "
            "hermes-agent or pass --agent-root/HERMES_AGENT_ROOT."
        )
    os.environ.setdefault("HERMES_HOME", str(_hermes_home()))
    os.environ.setdefault("HERMES_AGENT_BRIDGE_BASE_HOME", str(_hermes_home()))
    _apply_openrouter_attribution_override()
    from bridge_mcp import install_studio_mcp_env

    install_studio_mcp_env()


def _apply_openrouter_attribution_override() -> None:
    """Override hermes-agent OpenRouter attribution at bridge runtime only."""
    referer = os.environ.get(OPENROUTER_ATTRIBUTION_ENV["referer"], "").strip()
    title = os.environ.get(OPENROUTER_ATTRIBUTION_ENV["title"], "").strip()
    categories = os.environ.get(OPENROUTER_ATTRIBUTION_ENV["categories"], "").strip()
    if not (referer or title or categories):
        return
    try:
        from agent import auxiliary_client
    except Exception:
        return
    headers = dict(getattr(auxiliary_client, "_OR_HEADERS_BASE", {}) or {})
    if referer:
        headers["HTTP-Referer"] = referer
    if title:
        headers.pop("X-Title", None)
        headers["X-OpenRouter-Title"] = title
    if categories:
        headers["X-OpenRouter-Categories"] = categories
    try:
        auxiliary_client._OR_HEADERS_BASE = headers
    except Exception:
        pass


def _load_cfg(profile: str | None = None) -> dict[str, Any]:
    _ensure_agent_imports()
    try:
        from hermes_cli.config import load_config

        cfg = load_config()
        return cfg if isinstance(cfg, dict) else {}
    except Exception:
        try:
            import yaml

            path = _hermes_home() / "config.yaml"
            if not path.exists():
                return {}
            return yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        except Exception:
            return {}


def _load_fallback_model(cfg: dict[str, Any]) -> list | None:
    """Return the canonical configured fallback chain for a bridge agent."""
    try:
        from hermes_cli.fallback_config import get_fallback_chain

        return get_fallback_chain(cfg) or None
    except Exception:
        return None


def _apply_profile_env(profile: str | None) -> str | None:
    """Temporarily set HERMES_HOME to the profile directory.
    Returns the original HERMES_HOME value to restore later.
    """
    profile_home = _profile_home(profile)
    if not (profile_home / "config.yaml").exists():
        return os.environ.get("HERMES_HOME")
    original = os.environ.get("HERMES_HOME")
    os.environ["HERMES_HOME"] = str(profile_home)
    return original


def _restore_profile_env(original: str | None) -> None:
    """Restore HERMES_HOME after profile-scoped agent creation."""
    if original is not None:
        os.environ["HERMES_HOME"] = original
    else:
        os.environ.pop("HERMES_HOME", None)


def _apply_profile_dotenv(profile: str | None) -> dict[str, str | None]:
    """Load only the active profile's .env into this bridge process.

    This mirrors Web UI gateway env isolation:
    - default keeps inherited env for compatibility, then overlays default .env
    - non-default clears keys seen in any profile .env, then overlays its .env
    The returned snapshot restores the bridge process after the agent call.
    """
    values = _read_dotenv(_profile_home(profile) / ".env")
    if profile and profile != "default":
        keys = _profile_dotenv_keys()
        keys.update(values.keys())
    else:
        keys = set(values.keys())
    snapshot = {key: os.environ.get(key) for key in keys}

    if profile and profile != "default":
        for key in keys:
            os.environ.pop(key, None)
    for key, value in values.items():
        os.environ[key] = value
    return snapshot


def _restore_profile_dotenv(snapshot: dict[str, str | None]) -> None:
    for key, value in snapshot.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def _set_worker_profile_env(profile: str | None) -> None:
    profile_home = _profile_home(profile)
    os.environ["HERMES_HOME"] = str(profile_home)
    os.environ["HERMES_AGENT_BRIDGE_WORKER_PROFILE"] = profile or "default"
    _refresh_worker_profile_env()


def _refresh_worker_profile_env() -> None:
    """Overlay the current worker profile .env/config before creating a new agent."""
    profile = _worker_profile()
    if not profile:
        return
    profile_home = _profile_home(profile)
    os.environ["HERMES_HOME"] = str(profile_home)
    values = _read_dotenv(profile_home / ".env")
    for key, value in values.items():
        os.environ[key] = value
    _refresh_terminal_env()


@contextmanager
def _profile_env(profile: str | None):
    if _worker_profile():
        yield
        return
    original = _apply_profile_env(profile)
    env_snapshot = _apply_profile_dotenv(profile)
    try:
        yield
    finally:
        _restore_profile_dotenv(env_snapshot)
        _restore_profile_env(original)


def _refresh_terminal_env() -> None:
    """Bridge current worker HERMES_HOME/config.yaml terminal config to TERMINAL_* env vars.

    Worker startup first overlays the profile .env, then this function lets
    terminal config.yaml values override the matching terminal environment vars.
    """
    hermes_home = os.environ.get("HERMES_HOME", "")
    if not hermes_home:
        return
    config_path = Path(hermes_home) / "config.yaml"
    if not config_path.exists():
        return
    try:
        import yaml
        with open(config_path, encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}
        terminal_cfg = cfg.get("terminal", {})
        if not isinstance(terminal_cfg, dict):
            return
        TERMINAL_ENV_MAP = {
            "backend": "TERMINAL_ENV",
            "cwd": "TERMINAL_CWD",
            "timeout": "TERMINAL_TIMEOUT",
            "lifetime_seconds": "TERMINAL_LIFETIME_SECONDS",
            "ssh_host": "TERMINAL_SSH_HOST",
            "ssh_user": "TERMINAL_SSH_USER",
            "ssh_port": "TERMINAL_SSH_PORT",
            "ssh_key": "TERMINAL_SSH_KEY",
            "docker_image": "TERMINAL_DOCKER_IMAGE",
            "docker_forward_env": "TERMINAL_DOCKER_FORWARD_ENV",
            "singularity_image": "TERMINAL_SINGULARITY_IMAGE",
            "modal_image": "TERMINAL_MODAL_IMAGE",
            "daytona_image": "TERMINAL_DAYTONA_IMAGE",
            "vercel_runtime": "TERMINAL_VERCEL_RUNTIME",
            "container_cpu": "TERMINAL_CONTAINER_CPU",
            "container_memory": "TERMINAL_CONTAINER_MEMORY",
            "container_disk": "TERMINAL_CONTAINER_DISK",
            "container_persistent": "TERMINAL_CONTAINER_PERSISTENT",
            "docker_volumes": "TERMINAL_DOCKER_VOLUMES",
            "docker_env": "TERMINAL_DOCKER_ENV",
            "docker_mount_cwd_to_workspace": "TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE",
            "docker_run_as_host_user": "TERMINAL_DOCKER_RUN_AS_HOST_USER",
            "sandbox_dir": "TERMINAL_SANDBOX_DIR",
            "persistent_shell": "TERMINAL_PERSISTENT_SHELL",
            "modal_mode": "TERMINAL_MODAL_MODE",
        }
        for cfg_key, env_var in TERMINAL_ENV_MAP.items():
            if cfg_key in terminal_cfg:
                val = terminal_cfg[cfg_key]
                if cfg_key == "cwd" and str(val) in {".", "auto", "cwd"}:
                    continue
                if cfg_key == "cwd" and isinstance(val, str):
                    val = os.path.expanduser(val)
                if isinstance(val, (list, dict)):
                    os.environ[env_var] = json.dumps(val)
                else:
                    os.environ[env_var] = str(val)
    except Exception:
        print(
            f"[hermes-bridge] Failed to refresh terminal env from {config_path}",
            file=sys.stderr,
            flush=True,
        )


def _refresh_approval_allowlist() -> None:
    """Reload command_allowlist into tools.approval's process-local cache."""
    try:
        from tools.approval import load_permanent_allowlist

        load_permanent_allowlist()
    except Exception:
        pass


def _install_execute_code_approval_memory_patch() -> None:
    """Let bridge-scoped execute_code approvals honor session/permanent choices.

    Hermes Agent intentionally treats execute_code approvals as one-shot in
    gateway/ask mode.  Web UI keeps HERMES_EXEC_ASK enabled so dangerous
    terminal commands still require approval, but users expect the visible
    Session/Always choices to suppress later execute_code prompts as well.  Keep
    this compatibility layer in the bridge so the upstream runtime stays
    untouched.
    """
    try:
        import tools.approval as approval

        original = getattr(approval, "check_execute_code_guard", None)
        if not callable(original) or getattr(original, "_hermes_web_ui_memory_patch", False):
            return

        def patched_check_execute_code_guard(code: str, env_type: str, *args: Any, **kwargs: Any) -> dict[str, Any]:
            try:
                session_key = approval.get_current_session_key(default="")
                if session_key and approval.is_approved(session_key, "execute_code"):
                    return {"approved": True, "message": None}
            except Exception:
                pass
            return original(code, env_type, *args, **kwargs)

        setattr(patched_check_execute_code_guard, "_hermes_web_ui_memory_patch", True)
        setattr(patched_check_execute_code_guard, "_hermes_web_ui_original", original)
        approval.check_execute_code_guard = patched_check_execute_code_guard
    except Exception:
        pass


def _approval_pattern_keys(approval_data: dict[str, Any]) -> list[str]:
    raw = approval_data.get("pattern_keys")
    values = raw if isinstance(raw, list) else [approval_data.get("pattern_key")]
    result: list[str] = []
    for value in values:
        key = str(value or "").strip()
        if key and key not in result:
            result.append(key)
    return result


def _persist_execute_code_approval_choice(session_id: str, pattern_keys: list[str], choice: str) -> None:
    if "execute_code" not in pattern_keys or choice not in {"session", "always"}:
        return
    try:
        from tools.approval import approve_permanent, approve_session, load_permanent_allowlist, save_permanent_allowlist
        import tools.approval as approval

        approve_session(session_id, "execute_code")
        if choice == "always":
            approve_permanent("execute_code")
            permanent = getattr(approval, "_permanent_approved", None)
            patterns = set(permanent) if isinstance(permanent, set) else set(load_permanent_allowlist())
            patterns.add("execute_code")
            save_permanent_allowlist(patterns)
    except Exception:
        pass


def _resolve_model(cfg: dict[str, Any]) -> str:
    env_model = (
        os.environ.get("HERMES_MODEL", "")
        or os.environ.get("HERMES_INFERENCE_MODEL", "")
    ).strip()
    if env_model:
        return env_model
    model_cfg = cfg.get("model", "")
    if isinstance(model_cfg, dict):
        return str(model_cfg.get("default") or "").strip()
    if isinstance(model_cfg, str):
        return model_cfg.strip()
    return ""


def _resolve_runtime(model: str, provider: str | None = None) -> dict[str, Any]:
    _ensure_agent_imports()
    from hermes_cli.runtime_provider import resolve_runtime_provider

    requested = provider or os.environ.get("HERMES_BRIDGE_PROVIDER", "").strip() or None
    return resolve_runtime_provider(requested=requested, target_model=model or None)


def _load_enabled_toolsets() -> list[str] | None:
    _ensure_agent_imports()
    raw = os.environ.get("HERMES_BRIDGE_TOOLSETS", "").strip()
    if raw:
        values = [part.strip() for part in raw.split(",") if part.strip()]
        if any(value in {"all", "*"} for value in values):
            return None
        return values or None

    try:
        from hermes_cli.config import load_config
        from hermes_cli.tools_config import _get_platform_tools
        from toolsets import resolve_toolset

        cfg = load_config()
        platform = _bridge_platform()
        enabled = sorted(_get_platform_tools(cfg, platform, include_default_mcp_servers=True))
        if platform != "cli":
            resolved_tools: set[str] = set()
            for toolset_name in enabled:
                try:
                    resolved_tools.update(resolve_toolset(toolset_name))
                except Exception:
                    pass
            if not resolved_tools:
                enabled = sorted(_get_platform_tools(cfg, "cli", include_default_mcp_servers=True))
        return enabled or None
    except Exception:
        return None


def _discover_bridge_mcp_tools() -> list[str]:
    _ensure_agent_imports()
    try:
        try:
            from tools.mcp_tool_discovery import discover_mcp_tools
        except ModuleNotFoundError as exc:
            if exc.name != "tools.mcp_tool_discovery":
                raise
            from tools.mcp_tool import discover_mcp_tools

        tools = discover_mcp_tools()
        return list(tools) if isinstance(tools, list) else []
    except Exception as exc:
        print(
            f"[hermes_bridge] MCP tool discovery failed: {exc}",
            file=sys.stderr,
            flush=True,
        )
        return []


def _log_worker_startup_context(profile: str | None) -> None:
    profile_name = profile or _worker_profile() or "default"
    try:
        cfg = _load_cfg()
        enabled_toolsets = _load_enabled_toolsets()
        discovered_mcp_tools = _discover_bridge_mcp_tools()
        tool_names: list[str] = []
        tool_error: str | None = None
        try:
            from model_tools import get_tool_definitions

            tool_names = _tool_names_from_definitions(
                get_tool_definitions(
                    enabled_toolsets=enabled_toolsets,
                    quiet_mode=True,
                )
            )
        except Exception as exc:
            tool_error = str(exc)

        mcp_servers = cfg.get("mcp_servers") if isinstance(cfg.get("mcp_servers"), dict) else {}
        enabled_mcp_servers: list[str] = []
        disabled_mcp_servers: list[str] = []
        for name, server_cfg in mcp_servers.items():
            enabled = True
            if isinstance(server_cfg, dict):
                enabled = str(server_cfg.get("enabled", True)).strip().lower() not in {"0", "false", "no", "off"}
            (enabled_mcp_servers if enabled else disabled_mcp_servers).append(str(name))

        _bridge_log("bridge.worker.initialized", {
            "profile": profile_name,
            "platform": _bridge_platform(),
            "hermes_home": str(_hermes_home()),
            "base_hermes_home": str(_base_hermes_home()),
            "config_path": str(_hermes_home() / "config.yaml"),
            "model": _resolve_model(cfg),
            "enabled_toolsets": enabled_toolsets,
            "tool_count": len(tool_names),
            "tool_names": tool_names,
            "tool_error": tool_error,
            "mcp_server_count": len(mcp_servers),
            "mcp_servers": sorted(str(name) for name in mcp_servers),
            "enabled_mcp_servers": sorted(enabled_mcp_servers),
            "disabled_mcp_servers": sorted(disabled_mcp_servers),
            "mcp_discovered_tool_count": len(discovered_mcp_tools),
            "mcp_discovered_tool_names": discovered_mcp_tools,
            "mcp_tool_count": len(_mcp_tool_names_from_names(tool_names)),
            "mcp_tool_names": _mcp_tool_names_from_names(tool_names),
        })
    except Exception as exc:
        _bridge_log("bridge.worker.initialized", {
            "profile": profile_name,
            "error": str(exc),
        })


def _load_reasoning_config(model: str = "") -> dict[str, Any] | None:
    _ensure_agent_imports()
    try:
        from hermes_constants import resolve_reasoning_config
    except ImportError:
        try:
            from hermes_constants import parse_reasoning_effort

            effort = str((_load_cfg().get("agent") or {}).get("reasoning_effort", "") or "").strip()
            return parse_reasoning_effort(effort)
        except Exception:
            return None
    return resolve_reasoning_config(_load_cfg(), model)


def _load_service_tier() -> str | None:
    raw = str((_load_cfg().get("agent") or {}).get("service_tier", "") or "").strip().lower()
    if raw in {"fast", "priority", "on"}:
        return "priority"
    return None


def _cfg_max_turns(cfg: dict[str, Any], default: int = 90) -> int:
    try:
        env_max = int(os.environ.get("HERMES_BRIDGE_MAX_TURNS", "") or 0)
        if env_max > 0:
            return env_max
    except ValueError:
        pass
    agent_cfg = cfg.get("agent") or {}
    try:
        return int(agent_cfg.get("max_turns") or cfg.get("max_turns") or default)
    except (TypeError, ValueError):
        return default


def _platform_text_encoding() -> str:
    getencoding = getattr(locale, "getencoding", None)
    if callable(getencoding):
        return getencoding() or "utf-8"
    return locale.getpreferredencoding(False) or "utf-8"
