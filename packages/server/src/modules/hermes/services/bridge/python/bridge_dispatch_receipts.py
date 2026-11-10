"""Durable admission receipts for Studio dispatches (Ekko-owned state, outside Hermes' own stores).

A Studio dispatch id is admitted at most once, through one unique key. Admission records
``preparing``; only a started worker turns it into ``dispatched``, and a startup failure into
``failed``. Resolution claims an unknown id as ``refused`` so a delayed request can never start.
A receipt left ``preparing`` by a crash is reported ``uncertain``: never treated as dispatched.
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

_SCHEMA = """CREATE TABLE IF NOT EXISTS dispatch_receipts (
  dispatch_id TEXT PRIMARY KEY, state TEXT NOT NULL, run_id TEXT, recorded_at REAL NOT NULL)"""


def _connect(home: Path) -> sqlite3.Connection:
    path = Path(home) / "ekko-bridge" / "dispatch-receipts.db"
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=5, isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(_SCHEMA)
    return conn


def _state(conn: sqlite3.Connection, dispatch_id: str) -> str | None:
    row = conn.execute("SELECT state FROM dispatch_receipts WHERE dispatch_id=?", (dispatch_id,)).fetchone()
    return str(row[0]) if row else None


def admit(home: Path, dispatch_id: str, run_id: str) -> str:
    """``accepted`` for a new admission (now ``preparing``), ``duplicate`` if admitted before, else ``refused``."""
    conn = _connect(home)
    try:
        inserted = conn.execute(
            "INSERT OR IGNORE INTO dispatch_receipts VALUES (?, 'preparing', ?, ?)", (dispatch_id, run_id, time.time())
        ).rowcount
        if inserted == 1:
            return "accepted"
        return "duplicate" if _state(conn, dispatch_id) in ("preparing", "dispatched") else "refused"
    finally:
        conn.close()


def _settle(home: Path, dispatch_id: str, state: str) -> None:
    conn = _connect(home)
    try:
        conn.execute("UPDATE dispatch_receipts SET state=?, recorded_at=? WHERE dispatch_id=? AND state='preparing'",
                     (state, time.time(), dispatch_id))
    finally:
        conn.close()


def confirm_dispatched(home: Path, dispatch_id: str) -> None:
    _settle(home, dispatch_id, "dispatched")


def settle_failed(home: Path, dispatch_id: str) -> None:
    _settle(home, dispatch_id, "failed")


def resolve(home: Path, dispatch_id: str) -> str:
    """``accepted`` if dispatched, ``refused`` if never admitted or failed to start, ``uncertain`` if still preparing."""
    conn = _connect(home)
    try:
        conn.execute("INSERT OR IGNORE INTO dispatch_receipts VALUES (?, 'refused', NULL, ?)", (dispatch_id, time.time()))
        state = _state(conn, dispatch_id)
        return {"dispatched": "accepted", "preparing": "uncertain"}.get(state or "", "refused")
    finally:
        conn.close()
