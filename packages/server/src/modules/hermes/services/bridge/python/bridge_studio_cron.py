"""Hermes cron results for their bound Studio session (docs/session-notifications.md).

Reads the native execution ledger and the canonical admission result of each fire
(``cron_request_id(job, execution_id)``); it never correlates output files by name or time and
never wraps or replaces a registered Hermes tool.
"""

from __future__ import annotations

import json
from typing import Any

_TERMINAL_EXECUTION_STATES = {"completed", "failed", "unknown"}
_OBSERVE_PAGE = 50



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
        page = list_executions(job_id=job_id, limit=_OBSERVE_PAGE)
        rows = list(page)
        before = str((item or {}).get("before") or "").strip() or None
        # Bounded progress through older retained executions: at most one older page per pass,
        # continuing from the cursor Studio stored on the previous pass.
        if before:
            older = list_executions(job_id=job_id, limit=_OBSERVE_PAGE, before_claimed_at=before)
            rows.extend(older)
            tail = older
        else:
            tail = page
        oldest = _iso_seconds(tail[-1].get("claimed_at")) if tail else None
        states[-1]["older_before"] = (
            str(tail[-1].get("claimed_at")) if len(tail) == _OBSERVE_PAGE and oldest is not None and oldest >= since
            else None)
        seen_ids: set[str] = set()
        for row in rows:
            if str(row.get("id") or "") in seen_ids:
                continue
            seen_ids.add(str(row.get("id") or ""))
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
