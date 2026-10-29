"""Studio-owned session notifications for Hermes cron results and terminal completions.

Cron: a ``cronjob_manage`` create made from a Studio Agent Bridge session has no
capturable Hermes origin (no chat id), so Hermes stores ``deliver=local``. When the
request asks for the creating conversation (``deliver`` omitted or ``origin``), the
job is created paused, a durable Studio binding is written, and only then is the job
resumed through the native tool action. Explicit targets are passed through
untouched and never bound.

Observation reads the native execution ledger and the canonical admission result of
each fire (``cron_request_id(job, execution_id)``); it never correlates output files
by name or time.

Terminal: ``notify_on_complete`` completions owned by a loaded Studio session are
drained with Hermes' own ``drain_notifications`` and handed to Studio as typed
machine events. Consumption by wait/log is rechecked at dispatch.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable

STUDIO_CONFIG_ENV = "HERMES_AGENT_BRIDGE_STUDIO_NOTIFICATIONS"
CRON_TOOL_NAME = "cronjob_manage"
_WRAPPER_MARKER = "_studio_session_binding_wrapper"
_PAUSED_SENTENCE = "Created PAUSED — resume to schedule, or explicitly run now."
_TERMINAL_EXECUTION_STATES = {"completed", "failed", "unknown"}
_install_lock = threading.Lock()


def studio_config() -> dict[str, str] | None:
    raw = os.environ.get(STUDIO_CONFIG_ENV, "")
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(parsed, dict):
        return None
    bindings_db = str(parsed.get("bindings_db") or "").strip()
    instance_id = str(parsed.get("instance_id") or "").strip()
    if not bindings_db or not instance_id:
        return None
    return {"bindings_db": bindings_db, "instance_id": instance_id}


# --- binding store -------------------------------------------------------------------------------

_SCHEMA = """CREATE TABLE IF NOT EXISTS cron_session_bindings (
  instance_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  job_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  bound_at REAL NOT NULL,
  requested_deliver TEXT,
  stored_deliver TEXT,
  requested_paused INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (instance_id, profile, job_id)
)"""


def _connect(path: str) -> sqlite3.Connection:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=5.0)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=FULL")
    conn.execute(_SCHEMA)
    return conn


def write_binding(config: dict[str, str], *, profile: str, job_id: str, session_id: str,
                  requested_deliver: str | None, stored_deliver: str | None, requested_paused: bool) -> float:
    bound_at = time.time()
    conn = _connect(config["bindings_db"])
    try:
        with conn:
            conn.execute(
                "INSERT OR REPLACE INTO cron_session_bindings (instance_id, profile, job_id, session_id, bound_at,"
                " requested_deliver, stored_deliver, requested_paused) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (config["instance_id"], profile, job_id, session_id, bound_at, requested_deliver,
                 stored_deliver, 1 if requested_paused else 0),
            )
    finally:
        conn.close()
    return bound_at


# --- cron create middleware ----------------------------------------------------------------------

def _clean_targets(value: Any) -> list[str]:
    if value is None:
        return []
    items = value if isinstance(value, (list, tuple)) else str(value).split(",")
    return [str(item).strip() for item in items if str(item).strip()]


def translate_deliver(value: Any) -> tuple[bool, str | None]:
    """``(binds_session, native_deliver)`` for a Studio create.

    Omitted delivery and ``origin`` both mean "this conversation": bind the Studio session
    and store a native value that never falls back to a home channel. Any explicit target
    is preserved verbatim and is not bound (no additive Studio mirror).
    """
    targets = _clean_targets(value)
    if not targets:
        return True, "local"
    remaining = [target for target in targets if target.lower() != "origin"]
    if len(remaining) == len(targets):
        return False, None
    return True, ",".join(dict.fromkeys(remaining)) or "local"


def _translate_failure_deliver(value: Any) -> Any:
    targets = _clean_targets(value)
    if not targets or all(target.lower() != "origin" for target in targets):
        return value
    remaining = [target for target in targets if target.lower() != "origin"]
    return ",".join(dict.fromkeys(remaining)) or "local"


def _studio_session_context() -> dict[str, str] | None:
    try:
        from gateway.session_context import get_session_env
    except Exception:
        return None
    if get_session_env("HERMES_SESSION_PLATFORM", "") != "agent_bridge":
        return None
    if str(get_session_env("HERMES_CRON_SESSION", "") or "").strip().lower() in {"1", "true", "yes", "on"}:
        return None
    try:
        from agent.delegation_context import is_delegated_child_context
        if is_delegated_child_context():
            return None
    except Exception:
        pass
    session_id = (get_session_env("HERMES_UI_SESSION_ID", "") or get_session_env("HERMES_SESSION_KEY", "")).strip()
    if not session_id:
        return None
    profile = (get_session_env("HERMES_SESSION_PROFILE", "") or "default").strip() or "default"
    return {"session_id": session_id, "profile": profile}


def _loads(result: Any) -> dict[str, Any] | None:
    if isinstance(result, dict):
        return dict(result)
    try:
        parsed = json.loads(result)
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _strip_sentence(message: Any, sentence: str | None) -> Any:
    if not isinstance(message, str) or not sentence:
        return message
    return " ".join(message.replace(sentence, " ").split())


def _bound_create(original: Callable[..., Any], config: dict[str, str], context: dict[str, str],
                  args: dict[str, Any], kwargs: dict[str, Any]) -> Any:
    binds, native_deliver = translate_deliver(args.get("deliver"))
    if not binds:
        return original(args, **kwargs)
    requested_paused = bool(args.get("paused", False))
    create_args = dict(args, paused=True, deliver=native_deliver)
    if args.get("failure_deliver") is not None:
        create_args["failure_deliver"] = _translate_failure_deliver(args.get("failure_deliver"))
    created_raw = original(create_args, **kwargs)
    created = _loads(created_raw)
    if not created or created.get("success") is not True or not created.get("job_id"):
        return created_raw
    job_id = str(created["job_id"])
    try:
        write_binding(config, profile=context["profile"], job_id=job_id, session_id=context["session_id"],
                      requested_deliver=None if args.get("deliver") is None else ",".join(_clean_targets(args.get("deliver"))),
                      stored_deliver=str(created.get("deliver") or native_deliver), requested_paused=requested_paused)
    except Exception as exc:
        created["success"] = False
        created["error"] = (f"Studio session binding failed; job {job_id} was left paused and will not run "
                            f"until resumed: {type(exc).__name__}: {exc}")
        return json.dumps(created, ensure_ascii=False)
    created["studio_session_delivery"] = "bound"
    if requested_paused:
        return json.dumps(created, ensure_ascii=False)
    resumed = _loads(original({"action": "resume", "job_id": job_id}, **kwargs))
    if not resumed or resumed.get("success") is not True:
        created["success"] = False
        created["error"] = (f"Studio session binding was saved but resuming job {job_id} failed; "
                            f"the job is still paused: {(resumed or {}).get('error') or 'unknown error'}")
        return json.dumps(created, ensure_ascii=False)
    job_view = resumed.get("job") if isinstance(resumed.get("job"), dict) else None
    if job_view is not None:
        created["job"] = job_view
        if "next_run_at" in job_view:
            created["next_run_at"] = job_view.get("next_run_at")
    created["message"] = _strip_sentence(created.get("message"), _PAUSED_SENTENCE)
    created["message"] = " ".join(filter(None, (
        created.get("message"),
        "Results will appear in this Studio conversation as a notification when it runs.",
    )))
    return json.dumps(created, ensure_ascii=False)


def install_cron_binding_middleware() -> bool:
    """Wrap the registered ``cronjob_manage`` handler once (idempotent).

    The legacy ``cronjob`` name resolves to the same registry entry before dispatch.
    Calls outside a Studio Agent Bridge session pass straight through.
    """
    config = studio_config()
    if config is None:
        return False
    try:
        from tools.registry import registry
    except Exception:
        return False
    with _install_lock:
        entry = registry.get_entry(CRON_TOOL_NAME)
        if entry is None:
            return False
        if getattr(entry.handler, _WRAPPER_MARKER, False):
            return True
        original = entry.handler

        def studio_cronjob_handler(args, **kwargs):
            context = _studio_session_context()
            current = studio_config()
            if (context is None or current is None or not isinstance(args, dict)
                    or str(args.get("action") or "").strip().lower() != "create"):
                return original(args, **kwargs)
            return _bound_create(original, current, context, args, kwargs)

        setattr(studio_cronjob_handler, _WRAPPER_MARKER, True)
        studio_cronjob_handler.__wrapped__ = original  # type: ignore[attr-defined]
        entry.handler = studio_cronjob_handler
        return True


# --- cron observation ----------------------------------------------------------------------------

def _iso_seconds(value: Any) -> float | None:
    if not value:
        return None
    from datetime import datetime
    try:
        return datetime.fromisoformat(str(value)).timestamp()
    except ValueError:
        return None


def _admission_receipt(session_db: Any, job_id: str, execution_id: str) -> dict[str, Any] | None:
    """The canonical admission ``{session_id, admission_id}`` of one agent-backed fire."""
    try:
        from cron.scheduler_authority import journal_path
        journal = journal_path(job_id, execution_id)
        if journal.exists():
            record = json.loads(journal.read_text(encoding="utf-8-sig"))
            receipt = record.get("receipt")
            if isinstance(receipt, dict) and receipt.get("admission_id"):
                return {"admission_id": str(receipt["admission_id"]), "session_id": str(receipt.get("session_id") or "")}
    except Exception:
        pass
    if session_db is None:
        return None
    try:
        from hermes_state_keys import CRON_PRINCIPAL_ID, cron_request_id
        with session_db._read_ctx() as conn:
            row = conn.execute(
                "SELECT admission_id, target_session_id FROM session_admissions WHERE request_id=? AND principal_id=?",
                (cron_request_id(job_id, execution_id), CRON_PRINCIPAL_ID),
            ).fetchone()
        if row is not None:
            return {"admission_id": str(row[0]), "session_id": str(row[1] or "")}
    except Exception:
        return None
    return None


def _exact_result(session_db: Any, receipt: dict[str, Any]) -> list[Any] | None:
    try:
        from gateway.session_results import admission_result
        saved = admission_result(session_db, receipt["admission_id"])
    except Exception:
        return None
    if not isinstance(saved, dict) or not isinstance(saved.get("result"), dict):
        return None
    result = saved["result"].get("cron_result")
    return list(result) if isinstance(result, (list, tuple)) and len(result) >= 4 else None


def observe_cron_jobs(jobs: list[dict[str, Any]], session_db: Any) -> dict[str, Any]:
    """Terminal executions of bound jobs with their exact native result when available."""
    from cron.executions import list_executions
    from cron.jobs import get_job
    try:
        from cron.scheduler import _is_cron_silence_response
    except Exception:
        _is_cron_silence_response = None

    observed: list[dict[str, Any]] = []
    states: list[dict[str, Any]] = []
    for item in jobs or []:
        job_id = str((item or {}).get("job_id") or "").strip()
        if not job_id:
            continue
        since = float((item or {}).get("since") or 0)
        job = get_job(job_id)
        if job is None:
            states.append({"job_id": job_id, "state": "missing"})
            continue
        states.append({
            "job_id": job_id,
            "state": "present",
            "name": job.get("name"),
            "deliver": job.get("deliver"),
            "failure_deliver": job.get("failure_deliver"),
            "no_agent": bool(job.get("no_agent")),
        })
        for row in list_executions(job_id=job_id, limit=50):
            status = str(row.get("status") or "")
            if status not in _TERMINAL_EXECUTION_STATES:
                continue
            claimed = _iso_seconds(row.get("claimed_at"))
            if claimed is not None and claimed < since:
                continue
            execution_id = str(row.get("id") or "")
            entry: dict[str, Any] = {
                "job_id": job_id,
                "job_name": job.get("name"),
                "execution_id": execution_id,
                "source": row.get("source"),
                "scheduled_instant": row.get("scheduled_instant"),
                "status": status,
                "finished_at": row.get("finished_at"),
                "error": row.get("error"),
                "delivery_outcome": row.get("delivery_outcome"),
                "no_agent": bool(job.get("no_agent")),
                "receipt": "unavailable",
            }
            if status != "unknown" and not job.get("no_agent"):
                receipt = _admission_receipt(session_db, job_id, execution_id)
                result = _exact_result(session_db, receipt) if receipt else None
                if result is not None:
                    success, _output, answer, error = result[:4]
                    answer_text = str(answer or "")
                    entry.update({
                        "receipt": "exact",
                        "success": bool(success),
                        "answer": answer_text,
                        "result_error": error,
                        "silent": bool(_is_cron_silence_response and answer_text.strip()
                                       and _is_cron_silence_response(answer_text)),
                    })
            observed.append(entry)
    return {"executions": observed, "jobs": states}


# --- terminal completions ------------------------------------------------------------------------

def process_producer_key(profile: str | None, event: dict[str, Any]) -> str:
    return f"hermes-process:{profile or 'default'}:{event.get('session_id') or ''}:{event.get('started_at') or ''}"


def drain_owned_completions(loaded_session_ids: set[str]) -> list[tuple[dict[str, Any], str]]:
    """Owned ``type=completion`` events via the native drain (other types stay queued)."""
    if not loaded_session_ids:
        return []
    from tools.process_registry import process_registry

    def owns(evt: dict[str, Any]) -> bool:
        return evt.get("type") == "completion" and str(evt.get("session_key") or "") in loaded_session_ids

    try:
        return list(process_registry.drain_notifications(owns_event=owns, skip_poll_observed=False))
    except TypeError:
        return []


IMMEDIATE_EXIT_GRACE_SECONDS = 1.0


def republish_missed_completions(loaded_session_ids: set[str], emitted_keys: set[str],
                                 republished_keys: set[str], profile: str | None) -> int:
    """Recover the immediate-exit race from live registry records.

    The terminal tool flags ``notify_on_complete`` on the record after spawning, so a process
    that exits first is finished without a completion event. An exited, flagged, unconsumed
    record that was never emitted is republished once through the registry's own publisher;
    any duplicate with the same producer key is dropped before it reaches Studio.
    """
    if not loaded_session_ids:
        return 0
    from tools.process_registry import process_registry
    publish = getattr(process_registry, "_publish_finished", None)
    if not callable(publish):
        return 0
    now = time.time()
    republished = 0
    for session_id in loaded_session_ids:
        try:
            entries = process_registry.list_sessions(session_key=session_id)
        except Exception:
            continue
        for entry in entries or []:
            if not isinstance(entry, dict) or entry.get("status") != "exited" or not entry.get("notify_on_complete"):
                continue
            proc = process_registry.get(str(entry.get("session_id") or ""))
            if proc is None or str(getattr(proc, "session_key", "") or "") != session_id:
                continue
            key = process_producer_key(profile, {"session_id": proc.id, "started_at": proc.started_at})
            if key in emitted_keys or key in republished_keys or completion_consumed(proc.id):
                continue
            if now - float(getattr(proc, "exited_at", None) or now) < IMMEDIATE_EXIT_GRACE_SECONDS:
                continue
            republished_keys.add(key)
            publish(proc, True)
            republished += 1
    return republished


def completion_consumed(process_id: str) -> bool:
    from tools.process_registry import process_registry
    checker = getattr(process_registry, "is_completion_consumed", None)
    return bool(checker(process_id)) if callable(checker) else False


def notify_pending_session_ids(loaded_session_ids: set[str]) -> list[str]:
    """Loaded sessions with a live ``notify_on_complete`` process or a pending watcher."""
    if not loaded_session_ids:
        return []
    try:
        from tools.process_registry import process_registry
    except Exception:
        return []
    pending: set[str] = set()
    for session_id in loaded_session_ids:
        try:
            entries = process_registry.list_sessions(session_key=session_id)
        except Exception:
            entries = []
        for entry in entries or []:
            if isinstance(entry, dict) and entry.get("notify_on_complete") and entry.get("status") == "running":
                pending.add(session_id)
    for watcher in list(getattr(process_registry, "pending_watchers", []) or []):
        key = str((watcher or {}).get("session_key") or "")
        if key in loaded_session_ids and (watcher or {}).get("notify_on_complete"):
            pending.add(key)
    return sorted(pending)


def new_claim_id() -> str:
    return f"studio-process:{os.getpid()}:{uuid.uuid4().hex}"
