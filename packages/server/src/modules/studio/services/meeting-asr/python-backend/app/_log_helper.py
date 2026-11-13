"""Centralised skip-logging helper.

A bare ``except Exception: pass`` silently swallows recoverable errors.
That makes debugging production issues (R-6 in the v0.7.7 audit) painful:
operators see "recording crashed" with no traceback. Use ``log_skip`` so we
keep best-effort behaviour but emit a debug-level record with the phase
label and exception class for triage.
"""
from __future__ import annotations

import logging
from typing import Optional

_logger = logging.getLogger(__name__)


def log_skip(phase: str, exc: BaseException, *, level: int = logging.DEBUG) -> None:
    """Log that an exception was caught and deliberately skipped.

    ``phase`` is a short, snake_case label of the operation site
    (e.g. ``"oss_upload_retry"``, ``"sse_keepalive"``) so logs are
    searchable across the meeting-asr backend.
    """
    _logger.log(level, "meeting-asr skipped during %s: %s: %s", phase, type(exc).__name__, exc)