"""Real Hermes harness for Studio session notifications (no stubs).

Run by tests/server/hermes-session-notifications-real.test.ts with an isolated HOME,
HERMES_HOME and Studio bindings database. Imports the installed Hermes source read-only.
"""

import json
import os
import sqlite3
import sys
import time

sys.path.insert(0, os.environ["HERMES_AGENT_ROOT"])
sys.path.insert(0, os.path.join(os.getcwd(), "packages/server/src/modules/hermes/services/bridge/python"))

import bridge_studio_notifications as sn  # noqa: E402
import tools.cronjob_tools  # noqa: E402,F401  registers cronjob_manage
import tools.process_registry  # noqa: E402,F401
import tools.terminal_tool  # noqa: E402,F401  registers terminal
from gateway.session_context import set_session_vars  # noqa: E402
from tools.registry import registry  # noqa: E402


def bindings():
    path = json.loads(os.environ[sn.STUDIO_CONFIG_ENV])["bindings_db"]
    if not os.path.exists(path):
        return []
    conn = sqlite3.connect(path)
    try:
        return [list(row) for row in conn.execute(
            "SELECT instance_id, profile, job_id, session_id, stored_deliver, requested_paused FROM cron_session_bindings")]
    except sqlite3.OperationalError:
        return []
    finally:
        conn.close()


def studio_session(session_id="sess-A", platform="agent_bridge"):
    return set_session_vars(platform=platform, source="tui", session_key=session_id, session_id=session_id,
                            ui_session_id=session_id, profile="default", async_delivery=True)


def create(args, session_id="sess-A"):
    return json.loads(registry.dispatch("cronjob_manage", dict(args, action="create"), task_id="task-" + session_id,
                                        session_id=session_id))


def job_view(job_id):
    from cron.jobs import get_job
    job = get_job(job_id)
    return None if job is None else {key: job.get(key) for key in ("state", "enabled", "deliver", "failure_deliver", "origin")}


def case_cron_default():
    assert sn.install_cron_binding_middleware()
    studio_session()
    created = create({"prompt": "Summarize the day", "schedule": "30m", "name": "default-target"})
    return {"created": created, "job": job_view(created["job_id"]), "bindings": bindings()}


def case_cron_origin():
    assert sn.install_cron_binding_middleware()
    studio_session()
    created = create({"prompt": "Summarize", "schedule": "30m", "name": "origin", "deliver": "origin",
                      "failure_deliver": "origin"})
    return {"created": created, "job": job_view(created["job_id"]), "bindings": bindings()}


def case_cron_explicit():
    assert sn.install_cron_binding_middleware()
    studio_session()
    local = create({"prompt": "Write files", "schedule": "30m", "name": "explicit-local", "deliver": "local"})
    slack = create({"prompt": "Post", "schedule": "30m", "name": "explicit-slack", "deliver": "slack:C123",
                    "failure_deliver": "local"})
    return {"local": job_view(local["job_id"]), "slack": job_view(slack["job_id"]), "bindings": bindings(),
            "slack_success": slack.get("success")}


def case_cron_paused():
    assert sn.install_cron_binding_middleware()
    studio_session()
    created = create({"prompt": "Later", "schedule": "30m", "name": "paused", "paused": True})
    return {"created": created, "job": job_view(created["job_id"]), "bindings": bindings()}


def case_cron_not_studio():
    assert sn.install_cron_binding_middleware()
    studio_session(platform="cli")
    created = create({"prompt": "CLI", "schedule": "30m", "name": "cli"})
    import model_tools
    return {"created": created, "job": job_view(created["job_id"]), "bindings": bindings(),
            "legacy_alias": getattr(model_tools, "_LEGACY_TOOL_ALIASES", {}).get("cronjob")}


def case_cron_binding_failure():
    blocker = os.path.join(os.environ["HOME"], "not-a-directory")
    with open(blocker, "w", encoding="utf-8") as handle:
        handle.write("x")
    os.environ[sn.STUDIO_CONFIG_ENV] = json.dumps({"bindings_db": os.path.join(blocker, "b.db"), "instance_id": "inst-1"})
    assert sn.install_cron_binding_middleware()
    studio_session()
    created = create({"prompt": "Fail closed", "schedule": "30m", "name": "binding-failure"})
    from cron.jobs import load_jobs
    jobs = [job for job in load_jobs() if job.get("name") == "binding-failure"]
    return {"created": created, "job": job_view(jobs[0]["id"]) if jobs else None}


def _pool():
    import bridge_pool
    return bridge_pool.AgentPool()


def _terminal(command, notify=True, session_id="sess-A"):
    studio_session(session_id)
    return json.loads(registry.dispatch("terminal", {"command": command, "background": True,
                                                     "notify_on_complete": notify}, task_id="task-" + session_id))


def _poll_until(pool, session_ids, predicate, timeout=60.0):
    deadline = time.time() + timeout
    seen = []
    while time.time() < deadline:
        polled = pool.poll_background(session_ids)
        seen.append(polled)
        if predicate(polled):
            return polled, seen
        time.sleep(0.2)
    return None, seen


def case_process_success_failure():
    pool = _pool()
    ok = _terminal("printf ok-output; exit 0")
    bad = _terminal("printf bad-output; exit 3")
    found = {}

    def collect(polled):
        for item in polled.get("process_notifications") or []:
            found[item["process_id"]] = item
        return len(found) >= 2

    _poll_until(pool, ["sess-A"], collect)
    ok_item = found.get(ok["session_id"]) or {}
    bad_item = found.get(bad["session_id"]) or {}
    admitted = pool.admit_process_notification(ok_item.get("producer_key", ""), ok_item.get("claim_id", ""))
    completed = pool.complete_process_notification(ok_item.get("producer_key", ""), ok_item.get("claim_id", ""))
    replay, _ = _poll_until(pool, ["sess-A"], lambda polled: bool(polled.get("process_notifications")), timeout=1.5)
    return {"ok_result": ok, "ok": ok_item, "bad": bad_item, "admitted": admitted, "completed": completed,
            "replayed": replay is not None}


def case_process_notify_false():
    pool = _pool()
    result = _terminal("exit 0", notify=False)
    polled, _ = _poll_until(pool, ["sess-A"], lambda p: bool(p.get("process_notifications")), timeout=3.0)
    return {"result": result, "delivered": polled is not None}


def case_process_pending_and_immediate_exit():
    pool = _pool()
    running = _terminal("sleep 3; exit 0")
    pending = pool.poll_background(["sess-A"]).get("notify_pending_session_ids")
    immediate = _terminal("exit 0")
    polled, _ = _poll_until(pool, ["sess-A"], lambda p: any(
        item.get("process_id") == immediate["session_id"] for item in p.get("process_notifications") or []))
    return {"pending": pending, "running": running.get("session_id"), "immediate_delivered": polled is not None}


def case_process_immediate_exit_race():
    """Reproduce the native order: the record is flagged after the process already exited."""
    from tools.process_registry import process_registry
    pool = _pool()
    proc = process_registry.spawn_local(command="exit 0", cwd=os.getcwd(), task_id="task-sess-A",
                                        owner_task_id="task-sess-A", session_key="sess-A")
    deadline = time.time() + 30
    while not process_registry.get(proc.id).exited and time.time() < deadline:
        time.sleep(0.05)
    native_event_published = any(evt.get("session_id") == proc.id for evt in list(process_registry.completion_queue.queue))
    proc.notify_on_complete = True  # what the terminal tool does after spawn
    polled, _ = _poll_until(pool, ["sess-A"], lambda p: any(
        item.get("process_id") == proc.id for item in p.get("process_notifications") or []), timeout=15.0)
    items = [item for item in (polled or {}).get("process_notifications") or [] if item.get("process_id") == proc.id]
    again, _ = _poll_until(pool, ["sess-A"], lambda p: bool(p.get("process_notifications")), timeout=3.0)
    return {"native_event_published": native_event_published, "recovered": len(items), "duplicated": again is not None,
            "message": items[0]["message"] if items else None}


def case_process_consumed_by_wait():
    pool = _pool()
    before_drain = _terminal("printf waited; exit 0")
    studio_session()
    registry.dispatch("process_manage", {"action": "wait", "session_id": before_drain["session_id"], "timeout": 10},
                      task_id="task-sess-A")
    drained, _ = _poll_until(pool, ["sess-A"], lambda p: bool(p.get("process_notifications")), timeout=2.0)

    after_drain = _terminal("printf later; exit 0")
    claimed = {}

    def collect(polled):
        for item in polled.get("process_notifications") or []:
            claimed[item["process_id"]] = item
        return after_drain["session_id"] in claimed

    _poll_until(pool, ["sess-A"], collect)
    item = claimed.get(after_drain["session_id"]) or {}
    studio_session()
    registry.dispatch("process_manage", {"action": "log", "session_id": after_drain["session_id"]}, task_id="task-sess-A")
    admitted = pool.admit_process_notification(item.get("producer_key", ""), item.get("claim_id", ""))
    return {"wait_before_drain_delivered": drained is not None, "claimed_after": bool(item), "admit_after_log": admitted}


def case_process_ownership():
    pool = _pool()
    other = _terminal("exit 0", session_id="sess-B")
    polled_a, _ = _poll_until(pool, ["sess-A"], lambda p: bool(p.get("process_notifications")), timeout=3.0)
    polled_b, _ = _poll_until(pool, ["sess-B"], lambda p: any(
        item.get("process_id") == other["session_id"] for item in p.get("process_notifications") or []))
    return {"a_received": polled_a is not None, "b_received": polled_b is not None,
            "b_session": (polled_b or {}).get("process_notifications", [{}])[0].get("session_id") if polled_b else None}


if __name__ == "__main__":
    print("RESULT " + json.dumps(globals()["case_" + sys.argv[1]](), default=str))
