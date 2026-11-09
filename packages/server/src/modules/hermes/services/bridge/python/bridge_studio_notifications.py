"""Hermes terminal completions for their Studio session (docs/session-notifications.md).

Uses Hermes' own registry APIs; never wraps or replaces a registered Hermes tool.
"""

from __future__ import annotations

import os
import threading
import time
import uuid
from typing import Any


# session id -> [(declared_at, generation or None)] declared by Studio per turn. Unchanged repeats are
# coalesced, so only real generation changes use the bounded history.
_session_generations: dict[str, list[tuple[float, str | None]]] = {}
_generation_lock = threading.Lock()
_GENERATION_HISTORY_MAX = 32


def set_session_generation(session_id: str, generation: str | None) -> None:
    with _generation_lock:
        history = _session_generations.setdefault(session_id, [])
        declared = str(generation) if generation else None
        if history and history[-1][1] == declared:
            return
        history.append((time.time(), declared))
        del history[:-_GENERATION_HISTORY_MAX]


def generation_at(session_id: str, started_at: Any) -> str | None:
    """The owner generation declared most recently at or before ``started_at``."""
    try:
        moment = float(started_at)
    except (TypeError, ValueError):
        return None
    with _generation_lock:
        declared = [generation for at, generation in _session_generations.get(session_id) or [] if at <= moment]
    return declared[-1] if declared else None


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


def _unrecovered_exits(loaded_session_ids: set[str], emitted_keys: set[str], republished_keys: set[str],
                       profile: str | None):
    """Exited, flagged, unconsumed records of loaded sessions whose completion was never emitted."""
    from tools.process_registry import process_registry
    if not callable(getattr(process_registry, "_publish_finished", None)):
        return
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
            yield session_id, proc, key


def republish_missed_completions(loaded_session_ids: set[str], emitted_keys: set[str],
                                 republished_keys: set[str], profile: str | None) -> int:
    """Republish, once, a flagged process that exited before the terminal tool flagged it."""
    if not loaded_session_ids:
        return 0
    from tools.process_registry import process_registry
    now = time.time()
    republished = 0
    for _session_id, proc, key in list(_unrecovered_exits(loaded_session_ids, emitted_keys, republished_keys, profile)):
        if now - float(getattr(proc, "exited_at", None) or now) < IMMEDIATE_EXIT_GRACE_SECONDS:
            continue
        republished_keys.add(key)
        process_registry._publish_finished(proc, True)
        republished += 1
    return republished


def completion_consumed(process_id: str) -> bool:
    from tools.process_registry import process_registry
    checker = getattr(process_registry, "is_completion_consumed", None)
    return bool(checker(process_id)) if callable(checker) else False


def notify_pending_session_ids(loaded_session_ids: set[str], emitted_keys: set[str] = frozenset(),
                               republished_keys: set[str] = frozenset(), profile: str | None = None) -> list[str]:
    """Loaded sessions with a live notify process, a pending watcher, or an unrecovered exit."""
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
        if key not in loaded_session_ids or not (watcher or {}).get("notify_on_complete"):
            continue
        # The bridge never drains Gateway watcher descriptors; only a still-running process is pending.
        proc = process_registry.get(str((watcher or {}).get("session_id") or ""))
        if proc is not None and not getattr(proc, "exited", False):
            pending.add(key)
    for session_id, _proc, _key in _unrecovered_exits(loaded_session_ids, emitted_keys, republished_keys, profile):
        pending.add(session_id)
    return sorted(pending)


def new_claim_id() -> str:
    return f"studio-process:{os.getpid()}:{uuid.uuid4().hex}"
