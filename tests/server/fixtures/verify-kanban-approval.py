#!/usr/bin/env python3
"""Isolated smoke test for Studio's canonical Hermes Kanban transitions."""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path


def run(env: dict[str, str], *args: str) -> str:
    completed = subprocess.run(
        ["hermes", "kanban", *args],
        check=False,
        capture_output=True,
        env=env,
        text=True,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(f"hermes kanban {' '.join(args)} failed: {detail}")
    if completed.stderr.strip():
        raise RuntimeError(completed.stderr.strip())
    return completed.stdout.strip()


def task_id(raw: str) -> str:
    payload = json.loads(raw)
    if isinstance(payload, list):
        payload = payload[0]
    return str(payload.get("id") or payload.get("task", {}).get("id"))


def status(env: dict[str, str], identifier: str) -> str:
    payload = json.loads(run(env, "show", identifier, "--json"))
    return str(payload["task"]["status"])


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="studio-kanban-approval-") as temp:
        root = Path(temp)
        env = dict(os.environ)
        for key in (
            "HERMES_DELEGATED_CHILD_CONTEXT",
            "HERMES_KANBAN_TASK",
            "HERMES_KANBAN_RUN_ID",
            "HERMES_KANBAN_CLAIM_LOCK",
        ):
            env.pop(key, None)
        env["HERMES_KANBAN_DB"] = str(root / "kanban.db")
        env["HERMES_KANBAN_WORKSPACES_ROOT"] = str(root / "workspaces")

        approved = task_id(run(
            env, "create", "Approval smoke", "--assignee", "codex-worker",
            "--initial-status", "blocked", "--json",
        ))
        states = [status(env, approved)]
        run(env, "unblock", approved)
        states.append(status(env, approved))
        run(env, "claim", approved)
        states.append(status(env, approved))
        run(env, "request-review", approved, "--summary", "isolated verification", "--force")
        states.append(status(env, approved))
        run(env, "complete", approved, "--summary", "approved in isolated verification")
        states.append(status(env, approved))
        run(env, "archive", approved)
        states.append(status(env, approved))
        assert states == ["blocked", "ready", "running", "review", "done", "archived"], states

        returned = task_id(run(
            env, "create", "Changes smoke", "--assignee", "codex-worker",
            "--initial-status", "blocked", "--json",
        ))
        run(env, "unblock", returned)
        run(env, "claim", returned)
        run(env, "request-review", returned, "--summary", "isolated verification", "--force")
        run(env, "reopen-review", returned, "--reason", "changes required")
        returned_status = status(env, returned)
        assert returned_status == "ready", returned_status

        print(json.dumps({
            "approve_path": states,
            "request_changes_path": ["review", returned_status],
            "database": str(root / "kanban.db"),
        }, ensure_ascii=False))


if __name__ == "__main__":
    main()
