import { execFileSync } from 'child_process'
import { describe, it } from 'vitest'

function runPython(script: string): void {
  try {
    execFileSync('python3', ['-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: 'pipe',
    })
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    throw new Error([
      err.message || 'Python bridge concurrency script failed',
      err.stdout ? `stdout:\n${err.stdout}` : '',
      err.stderr ? `stderr:\n${err.stderr}` : '',
    ].filter(Boolean).join('\n\n'))
  }
}

const harness = String.raw`
import contextvars
import importlib.util
import json
import os
import sys
import threading
import time
import types
from pathlib import Path

os.environ["HERMES_AGENT_BRIDGE_WORKER_PROFILE"] = "default"

tools_pkg = types.ModuleType("tools")
tools_pkg.__path__ = []
sys.modules["tools"] = tools_pkg

terminal_tool = types.ModuleType("tools.terminal_tool")
terminal_tool._callback_tls = threading.local()

def set_approval_callback(callback):
    terminal_tool._callback_tls.callback = callback

def _get_approval_callback():
    return getattr(terminal_tool._callback_tls, "callback", None)

terminal_tool.set_approval_callback = set_approval_callback
terminal_tool._get_approval_callback = _get_approval_callback
terminal_tool._task_env_overrides = {}

def register_task_env_overrides(task_id, overrides):
    terminal_tool._task_env_overrides[task_id] = dict(overrides or {})

terminal_tool.register_task_env_overrides = register_task_env_overrides
sys.modules["tools.terminal_tool"] = terminal_tool

agent_pkg = types.ModuleType("agent")
agent_pkg.__path__ = []
sys.modules["agent"] = agent_pkg

runtime_cwd = types.ModuleType("agent.runtime_cwd")
runtime_cwd._cwd = contextvars.ContextVar("runtime_cwd", default="")
runtime_cwd._cleared = []

def set_session_cwd(cwd):
    runtime_cwd._cwd.set(cwd or "")

def clear_session_cwd():
    runtime_cwd._cleared.append(runtime_cwd._cwd.get())
    runtime_cwd._cwd.set("")

def resolve_agent_cwd():
    return runtime_cwd._cwd.get()

runtime_cwd.set_session_cwd = set_session_cwd
runtime_cwd.clear_session_cwd = clear_session_cwd
runtime_cwd.resolve_agent_cwd = resolve_agent_cwd
sys.modules["agent.runtime_cwd"] = runtime_cwd

approval = types.ModuleType("tools.approval")
approval._session_key = contextvars.ContextVar("approval_session_key", default="")
approval._notify = {}
approval._resolved_gateway = []
approval._resolved_gateway_requests = []
approval._gateway_waiters = {}
approval._session_approved = {}
approval._session_yolo = set()
approval._permanent_approved = set()
approval._saved_permanent = set()
approval._check_execute_code_calls = []

def set_current_session_key(session_key):
    return approval._session_key.set(session_key or "")

def reset_current_session_key(token):
    approval._session_key.reset(token)

def get_current_session_key(default=""):
    return approval._session_key.get() or default

def register_gateway_notify(session_key, callback):
    approval._notify[session_key] = callback

def unregister_gateway_notify(session_key):
    approval._notify.pop(session_key, None)

def queue_gateway_approval(session_key, request_id):
    approval._gateway_waiters.setdefault(session_key, []).append(request_id)

def resolve_gateway_approval(session_key, choice, request_id=None):
    waiters = approval._gateway_waiters.get(session_key, [])
    if request_id is None:
        resolved_request_id = waiters.pop(0) if waiters else None
    elif request_id in waiters:
        waiters.remove(request_id)
        resolved_request_id = request_id
    else:
        resolved_request_id = None
    approval._resolved_gateway.append((session_key, choice))
    approval._resolved_gateway_requests.append((session_key, choice, request_id, resolved_request_id))
    return 1 if resolved_request_id else 0

def is_approved(session_key, pattern_key):
    return (
        pattern_key in approval._permanent_approved or
        pattern_key in approval._session_approved.get(session_key, set())
    )

def approve_session(session_key, pattern_key):
    approval._session_approved.setdefault(session_key, set()).add(pattern_key)

def enable_session_yolo(session_key):
    if session_key:
        approval._session_yolo.add(session_key)

def disable_session_yolo(session_key):
    approval._session_yolo.discard(session_key)

def is_session_yolo_enabled(session_key):
    return bool(session_key) and session_key in approval._session_yolo

def approve_permanent(pattern_key):
    approval._permanent_approved.add(pattern_key)

def save_permanent_allowlist(patterns):
    approval._saved_permanent = set(patterns)

def load_permanent_allowlist():
    return set(approval._permanent_approved)

def check_execute_code_guard(code, env_type, has_host_access=False):
    approval._check_execute_code_calls.append((code, env_type, has_host_access))
    return {"approved": False, "message": "upstream prompt"}

approval.set_current_session_key = set_current_session_key
approval.reset_current_session_key = reset_current_session_key
approval.get_current_session_key = get_current_session_key
approval.register_gateway_notify = register_gateway_notify
approval.unregister_gateway_notify = unregister_gateway_notify
approval.resolve_gateway_approval = resolve_gateway_approval
approval.queue_gateway_approval = queue_gateway_approval
approval.is_approved = is_approved
approval.approve_session = approve_session
approval.enable_session_yolo = enable_session_yolo
approval.disable_session_yolo = disable_session_yolo
approval.is_session_yolo_enabled = is_session_yolo_enabled
approval.approve_permanent = approve_permanent
approval.save_permanent_allowlist = save_permanent_allowlist
approval.load_permanent_allowlist = load_permanent_allowlist
approval.check_execute_code_guard = check_execute_code_guard
sys.modules["tools.approval"] = approval

path = Path("packages/server/src/modules/hermes/services/bridge/python/hermes_bridge.py")
spec = importlib.util.spec_from_file_location("hermes_bridge", path)
bridge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bridge
spec.loader.exec_module(bridge)
bridge._load_reasoning_config = lambda *_args, **_kwargs: {}

class FakeDb:
    def __init__(self):
        self.lock = threading.Lock()
        self.messages = {}
        self.sessions = set()

    def create_session(self, session_id, **kwargs):
        with self.lock:
            self.sessions.add(session_id)
            self.messages.setdefault(session_id, [])

    def get_messages(self, session_id):
        with self.lock:
            return list(self.messages.get(session_id, []))

    def append_message(self, session_id, role, content=None, **kwargs):
        with self.lock:
            self.messages.setdefault(session_id, []).append({
                "role": role,
                "content": content,
                **kwargs,
            })

class FakeDbHolder:
    error = None

    def __init__(self, db):
        self.db = db

    def get_for_profile(self, profile):
        return self.db

def make_pool():
    pool = bridge.AgentPool()
    fake_db = FakeDb()
    pool._db = FakeDbHolder(fake_db)
    return pool, fake_db

def start_manual_run(pool, session_id, agent, message=None, workspace=None):
    session = bridge.AgentSession(session_id=session_id, agent=agent)
    run_id = f"run-{session_id}"
    record = bridge.RunRecord(run_id=run_id, session_id=session_id)
    session.running = True
    session.current_run_id = run_id
    with pool._lock:
        pool._sessions[session_id] = session
        pool._runs[run_id] = record
    thread = threading.Thread(
        target=pool._run_chat,
        args=(session, record, message or f"message:{session_id}", None, None, [], "default", False, workspace, "api_server"),
        daemon=True,
    )
    thread.start()
    return session, record, thread

def wait_for(condition, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if condition():
            return True
        time.sleep(0.01)
    return False
`

describe('agent bridge Python session concurrency', () => {
  it('continues accepting worker requests while another request is running', () => {
    runPython(String.raw`
import importlib.util
import json
import socket
import sys
import threading
import types

ready = threading.Event()

class ReadySocket(socket.socket):
    def listen(self, backlog=0):
        result = super().listen(backlog)
        ready.set()
        return result

transport = types.ModuleType("bridge_transport")
listener = ReadySocket(socket.AF_INET, socket.SOCK_STREAM)
listener.bind(("127.0.0.1", 0))
transport._make_listen_socket = lambda _endpoint: listener
transport._read_json_request = lambda conn: json.loads(conn.recv(65536).split(b"\n", 1)[0])
transport._write_json_response = lambda conn, response: conn.sendall((json.dumps(response) + "\n").encode())
sys.modules["bridge_transport"] = transport

runtime = types.ModuleType("bridge_runtime")
runtime._agent_root = lambda: None
runtime._apply_profile_env = lambda _profile: None
runtime._ensure_agent_imports = lambda: None
runtime._hermes_home = lambda: None
runtime._install_stop_signal_handlers = lambda _stop: lambda: None
runtime._jsonable = lambda value: value
runtime._positive_int = lambda _value: None
runtime._profile_env = lambda _profile: None
runtime._profile_home = lambda _profile: None
runtime._resolve_runtime = lambda *_args: {}
runtime._restore_profile_env = lambda _original: None
runtime._start_parent_process_watchdog = lambda *_args: None
runtime._worker_profile = lambda: "default"
sys.modules["bridge_runtime"] = runtime

pool_module = types.ModuleType("bridge_pool")
pool_module.AgentPool = type("AgentPool", (), {"__init__": lambda self: None})
sys.modules["bridge_pool"] = pool_module

spec = importlib.util.spec_from_file_location(
    "bridge_server",
    "packages/server/src/modules/hermes/services/bridge/python/bridge_server.py",
)
bridge_server = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge_server)

server = bridge_server.BridgeServer("tcp://127.0.0.1:0")
started = threading.Event()
release = threading.Event()
server.handle = lambda request: (
    (started.set(), release.wait(5), {"request": request["action"]})[2]
    if request["action"] == "slow"
    else {"request": request["action"]}
)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
assert ready.wait(2)
port = listener.getsockname()[1]

slow = socket.create_connection(("127.0.0.1", port), timeout=1)
slow.sendall(b'{"action":"slow","session_id":"slow-session"}\n')
assert started.wait(2)

fast = socket.create_connection(("127.0.0.1", port), timeout=1)
fast.settimeout(1)
fast.sendall(b'{"action":"fast","session_id":"fast-session"}\n')
response = json.loads(fast.recv(65536).split(b"\n", 1)[0])
assert response == {"ok": True, "request": "fast"}

release.set()
slow.settimeout(2)
slow_response = json.loads(slow.recv(65536).split(b"\n", 1)[0])
assert slow_response == {"ok": True, "request": "slow"}

same_started = threading.Event()
same_release = threading.Event()
server.handle = lambda request: (
    (same_started.set(), same_release.wait(5), {"request": request["action"]})[2]
    if request["action"] == "same-slow"
    else {"request": request["action"]}
)
same_slow = socket.create_connection(("127.0.0.1", port), timeout=1)
same_slow.sendall(b'{"action":"same-slow","session_id":"same-session"}\n')
assert same_started.wait(2)
same_fast = socket.create_connection(("127.0.0.1", port), timeout=1)
same_fast.settimeout(0.2)
same_fast.sendall(b'{"action":"same-fast","session_id":"same-session"}\n')
try:
    same_fast.recv(65536)
    raise AssertionError("same-session request was not serialized")
except TimeoutError:
    pass
same_release.set()
same_slow.settimeout(2)
same_fast.settimeout(2)
assert json.loads(same_slow.recv(65536).split(b"\n", 1)[0]) == {"ok": True, "request": "same-slow"}
assert json.loads(same_fast.recv(65536).split(b"\n", 1)[0]) == {"ok": True, "request": "same-fast"}
server._stop.set()
thread.join(timeout=2)
slow.close()
fast.close()
same_slow.close()
same_fast.close()
`)
  })

  it('denies only the interrupted session run generation approval queues', () => {
    runPython(String.raw`
${harness}

pool, _fake_db = make_pool()

class InterruptibleAgent:
    def __init__(self):
        self.session = None

    def interrupt(self, _message=None):
        self.session.running = False

agents = {sid: InterruptibleAgent() for sid in ("session-a", "session-b")}
for sid, agent in agents.items():
    session = bridge.AgentSession(session_id=sid, agent=agent, current_run_id="run-current")
    session.running = True
    agent.session = session
    with pool._lock:
        pool._sessions[sid] = session

choices = {}
threads = []
for sid, run_id in (("session-a", "run-previous"), ("session-a", "run-current"), ("session-b", "run-current")):
    with pool._lock:
        pool._sessions[sid].current_run_id = run_id
    thread = threading.Thread(
        target=lambda current=sid, generation=run_id: choices.__setitem__(
            f"{current}:{generation}",
            pool._approval_callback(current)(
                f"printf harmless {current} {generation}",
                "harmless test command",
                allow_permanent=False,
            ),
        ),
        daemon=True,
    )
    thread.start()
    threads.append(thread)
    assert wait_for(lambda current=sid, generation=run_id: (
        current,
        generation,
    ) in set(pool._approval_request_generations.values()))
with pool._lock:
    pool._sessions["session-a"].current_run_id = "run-previous"
approval.queue_gateway_approval("session-a", "request-previous")
pool._gateway_approval_notify("session-a")({
    "request_id": "request-previous",
    "command": "printf harmless previous gateway",
    "description": "harmless test command",
})
with pool._lock:
    pool._sessions["session-a"].current_run_id = "run-current"
approval.queue_gateway_approval("session-a", "request-current")
pool._gateway_approval_notify("session-a")({
    "request_id": "request-current",
    "command": "printf harmless current gateway",
    "description": "harmless test command",
})
with pool._lock:
    pool._sessions["session-a"].current_run_id = "run-later"
approval.queue_gateway_approval("session-a", "request-later")
pool._gateway_approval_notify("session-a")({
    "request_id": "request-later",
    "command": "printf harmless later gateway",
    "description": "harmless test command",
})
with pool._lock:
    pool._sessions["session-a"].current_run_id = "run-current"
approval.queue_gateway_approval("session-b", "request-other-session")
pool._gateway_approval_notify("session-b")({
    "request_id": "request-other-session",
    "command": "printf harmless other session gateway",
    "description": "harmless test command",
})

result = pool.interrupt("session-a", "test interrupt")
assert result["status"] == "interrupted"
threads[1].join(timeout=5)
assert not threads[1].is_alive()
assert choices["session-a:run-current"] == "deny"
assert threads[0].is_alive()
with pool._lock:
    assert set(pool._approval_request_generations.values()) == {
        ("session-a", "run-previous"),
        ("session-b", "run-current"),
    }
    remaining = dict(pool._approval_request_generations)
    previous_id = next(key for key, value in remaining.items() if value == ("session-a", "run-previous"))
    other_session_id = next(key for key, value in remaining.items() if value == ("session-b", "run-current"))
    assert set(pool._gateway_approval_requests.values()) == {
        ("session-a", "run-previous", "request-previous"),
        ("session-a", "run-later", "request-later"),
        ("session-b", "run-current", "request-other-session"),
    }
assert approval._resolved_gateway_requests == [
    ("session-a", "deny", "request-current", "request-current"),
]
assert approval._gateway_waiters == {
    "session-a": ["request-previous", "request-later"],
    "session-b": ["request-other-session"],
}

assert pool.respond_approval(previous_id, "deny")["resolved"] is True
assert pool.respond_approval(other_session_id, "deny")["resolved"] is True
threads[0].join(timeout=5)
threads[2].join(timeout=5)
assert not threads[0].is_alive()
assert not threads[2].is_alive()
assert choices["session-a:run-previous"] == "deny"
assert choices["session-b:run-current"] == "deny"
assert pool.respond_approval(other_session_id, "once")["resolved"] is False
`)
  })

  it('toggles YOLO for a session before its first Agent session exists', () => {
    runPython(String.raw`
${harness}

pool, _fake_db = make_pool()
assert "session-yolo" not in pool._sessions

enabled = pool.dispatch_command("session-yolo", "/yolo", "default")
assert enabled == {
    "session_id": "session-yolo",
    "command": "yolo",
    "handled": True,
    "type": "yolo",
    "action": "yolo",
    "enabled": True,
    "message": "⚡ YOLO mode ON for this session — all commands auto-approved. Use with caution.",
}, enabled
assert approval.is_session_yolo_enabled("session-yolo") is True
assert approval.is_session_yolo_enabled("another-session") is False
assert "session-yolo" not in pool._sessions

class YoloAwareAgent:
    def __init__(self):
        self.seen = []

    def run_conversation(self, message, session_id=None, stream_callback=None, **kwargs):
        active_session = approval.get_current_session_key()
        self.seen.append((
            active_session,
            approval.is_session_yolo_enabled(active_session),
        ))
        return {"output": "done"}

agent = YoloAwareAgent()
_session, record, thread = start_manual_run(
    pool,
    "session-yolo",
    agent,
    "first real message",
)
thread.join(timeout=2)
assert not thread.is_alive(), record.result
assert agent.seen == [("session-yolo", True)], agent.seen

disabled = pool.dispatch_command("session-yolo", "yolo", "default")
assert disabled["enabled"] is False, disabled
assert approval.is_session_yolo_enabled("session-yolo") is False
`)
  })

  it('binds Agent-session background delivery capability across runtime context versions', () => {
    runPython(String.raw`
${harness}

gateway_pkg = types.ModuleType("gateway")
gateway_pkg.__path__ = []
sys.modules["gateway"] = gateway_pkg

session_context = types.ModuleType("gateway.session_context")
captured = []

def modern_set_session_vars(
    platform="",
    source="",
    session_key="",
    session_id="",
    profile="",
    cwd="",
    async_delivery=True,
):
    captured.append({
        "platform": platform,
        "source": source,
        "session_key": session_key,
        "session_id": session_id,
        "profile": profile,
        "cwd": cwd,
        "async_delivery": async_delivery,
    })
    return ["modern-token"]

session_context.set_session_vars = modern_set_session_vars
sys.modules["gateway.session_context"] = session_context

tokens = bridge._set_bridge_session_vars(
    "session-modern",
    "profile-modern",
    "/tmp/workspace-modern",
    False,
)
assert tokens == ["modern-token"]
assert captured[-1] == {
    "platform": "agent_bridge",
    "source": "tui",
    "session_key": "session-modern",
    "session_id": "session-modern",
    "profile": "profile-modern",
    "cwd": "/tmp/workspace-modern",
    "async_delivery": False,
}

def legacy_set_session_vars(
    platform="",
    chat_id="",
    chat_name="",
    thread_id="",
    user_id="",
    user_name="",
    session_key="",
    message_id="",
):
    captured.append({"platform": platform, "session_key": session_key})
    return ["legacy-token"]

session_context.set_session_vars = legacy_set_session_vars
tokens = bridge._set_bridge_session_vars(
    "session-legacy",
    "profile-legacy",
    "C:/workspace-legacy",
    True,
)
assert tokens == ["legacy-token"]
assert captured[-1] == {
    "platform": "agent_bridge",
    "session_key": "session-legacy",
}
`)
  })

  it('forwards Agent creation policy from chat and context-estimate requests', () => {
    runPython(String.raw`
${harness}

captured = []

class FakePool:
    def start_chat(self, *args):
        captured.append(args)
        return bridge.RunRecord(run_id=f"run-{len(captured)}", session_id=args[0])

    def estimate_context(self, *args, **kwargs):
        captured.append(kwargs)
        return {"session_id": args[0]}

server = object.__new__(bridge.BridgeServer)
server.pool = FakePool()

disabled = server.handle({
    "action": "chat",
    "session_id": "session-disabled",
    "message": "hello",
    "background_delegation_enabled": False,
})
enabled = server.handle({
    "action": "chat",
    "session_id": "session-default",
    "message": "hello",
})
estimated = server.handle({
    "action": "context_estimate",
    "session_id": "session-estimate-disabled",
    "background_delegation_enabled": False,
})

assert disabled["status"] == "running"
assert enabled["status"] == "running"
assert captured[0][-1] is False
assert captured[1][-1] is None
assert estimated["session_id"] == "session-estimate-disabled"
assert captured[2]["background_delegation_enabled"] is False
`)
  })

  it('buffers subagent events after the parent run has ended', () => {
    runPython(String.raw`
${harness}

pool, _fake_db = make_pool()
session = bridge.AgentSession(session_id="background-session", agent=object())
record = bridge.RunRecord(run_id="parent-run", session_id=session.session_id)
session.current_run_id = record.run_id
with pool._lock:
    pool._sessions[session.session_id] = session
    pool._runs[record.run_id] = record

pool._append_event(session.session_id, {
    "event": "subagent.start",
    "subagent_id": "child-1",
    "goal": "inspect the repository",
})
assert len(record.events) == 1
assert session.background_events == []
assert session.background_tasks["child-1"]["status"] == "running"

session.current_run_id = None
pool._append_event(session.session_id, {
    "event": "subagent.text",
    "subagent_id": "child-1",
    "text": "found the relevant file",
})
pool._append_event(session.session_id, {
    "event": "subagent.complete",
    "subagent_id": "child-1",
    "status": "completed",
    "summary": "done",
})

polled = pool.poll_background()
assert [event["event"] for event in polled["sessions"][0]["events"]] == [
    "subagent.text", "subagent.complete"
]
assert polled["sessions"][0]["tasks"][0]["status"] == "completed"
assert pool.poll_background()["sessions"] == []
`)
  })

  it('requeues a released durable background completion claim', () => {
    runPython(String.raw`
${harness}

import queue

process_registry_module = types.ModuleType("tools.process_registry")
process_registry_module.process_registry = types.SimpleNamespace(completion_queue=queue.Queue())
process_registry_module.format_process_notification = lambda event: "background result ready"
sys.modules["tools.process_registry"] = process_registry_module

async_module = types.ModuleType("tools.async_delegation")
async_module.claim_event_delivery = lambda event, consumer: "claim-1"
async_module.release_completion_delivery = lambda delegation_id, claim_id: True
async_module.complete_completion_delivery = lambda delegation_id, claim_id: True
sys.modules["tools.async_delegation"] = async_module

pool, _fake_db = make_pool()
event = {
    "type": "async_delegation",
    "delegation_id": "deleg-1",
    "session_key": "session-1",
    "parent_session_id": "session-1",
    "status": "completed",
}
process_registry_module.process_registry.completion_queue.put(event)

polled = pool.poll_background(["session-1"])
assert polled["notifications"][0]["claim_id"] == "claim-1"
assert process_registry_module.process_registry.completion_queue.empty()

released = pool.release_background_notification("deleg-1", "claim-1")
assert released["released"] is True
assert process_registry_module.process_registry.completion_queue.get_nowait() == event
`)
  })

  it('acknowledges a user-cancelled delegation completion without starting a new parent turn', () => {
    runPython(String.raw`
${harness}

import queue

completed = []
process_registry_module = types.ModuleType("tools.process_registry")
process_registry_module.process_registry = types.SimpleNamespace(completion_queue=queue.Queue())
process_registry_module.format_process_notification = lambda event: "should not be delivered"
sys.modules["tools.process_registry"] = process_registry_module

async_module = types.ModuleType("tools.async_delegation")
async_module.claim_event_delivery = lambda event, consumer: "claim-interrupted"
async_module.complete_completion_delivery = lambda delegation_id, claim_id: completed.append(
    (delegation_id, claim_id)
) or True
sys.modules["tools.async_delegation"] = async_module

pool, _fake_db = make_pool()
pool._suppressed_background_delegations.add("deleg-interrupted")
process_registry_module.process_registry.completion_queue.put({
    "type": "async_delegation",
    "delegation_id": "deleg-interrupted",
    "session_key": "session-1",
    "parent_session_id": "session-1",
    "status": "completed",
})

polled = pool.poll_background(["session-1"])

assert polled["notifications"] == []
assert process_registry_module.process_registry.completion_queue.empty()
assert completed == [("deleg-interrupted", "claim-interrupted")]
assert pool._suppressed_background_delegations == set()
`)
  })

  it('interrupts background work and releases claims during worker shutdown', () => {
    runPython(String.raw`
${harness}

calls = []

async_module = types.ModuleType("tools.async_delegation")
async_module.interrupt_all = lambda reason: calls.append(("interrupt_all", reason)) or 1
async_module.active_count = lambda: 0
async_module.release_completion_delivery = lambda delegation_id, claim_id: calls.append(
    ("release", delegation_id, claim_id)
) or True
sys.modules["tools.async_delegation"] = async_module

process_registry_module = types.ModuleType("tools.process_registry")
process_registry_module.process_registry = types.SimpleNamespace(
    kill_all=lambda: calls.append(("kill_all",)) or 2,
)
sys.modules["tools.process_registry"] = process_registry_module

class InterruptibleAgent:
    def interrupt(self, message):
        calls.append(("session_interrupt", message))

pool, _fake_db = make_pool()
session = bridge.AgentSession(session_id="session-1", agent=InterruptibleAgent())
session.running = True
pool._sessions[session.session_id] = session
pool._background_notification_claims[("deleg-1", "claim-1")] = {"type": "async_delegation"}

result = pool.shutdown()

assert result == {
    "interrupted_sessions": 1,
    "interrupted_delegations": 1,
    "killed_processes": 2,
    "released_claims": 1,
}
assert calls == [
    ("session_interrupt", "Agent bridge shutting down"),
    ("interrupt_all", "agent_bridge_shutdown"),
    ("kill_all",),
    ("release", "deleg-1", "claim-1"),
]
assert pool._background_notification_claims == {}
`)
  })

  it('interrupts only the current session background delegations on user stop', () => {
    runPython(String.raw`
${harness}

calls = []
async_module = types.ModuleType("tools.async_delegation")
async_module.interrupt_for_session = lambda **kwargs: calls.append(kwargs) or 2
async_module.list_async_delegations = lambda: [
    {
        "delegation_id": "deleg-current",
        "status": "running",
        "session_key": "session-1",
    },
    {
        "delegation_id": "deleg-other",
        "status": "running",
        "session_key": "session-2",
    },
]
sys.modules["tools.async_delegation"] = async_module

class InterruptibleAgent:
    def interrupt(self, message):
        calls.append({"parent_message": message})

pool, _fake_db = make_pool()
session = bridge.AgentSession(session_id="session-1", agent=InterruptibleAgent())
pool._sessions[session.session_id] = session
pool._append_event(session.session_id, {
    "event": "subagent.start",
    "subagent_id": "child-current",
    "task_index": 0,
    "task_count": 1,
    "goal": "background work",
})

result = pool.interrupt("session-1", "Aborted by user")

assert result == {
    "status": "interrupted",
    "session_id": "session-1",
    "synced": True,
    "background_interrupted": 2,
    "background_delegation_ids": ["deleg-current"],
}
assert calls == [{
    "session_key": "session-1",
    "origin_ui_session_id": "session-1",
    "parent_session_id": "session-1",
    "reason": "user_interrupt",
}, {"parent_message": "Aborted by user"}]
assert pool._suppressed_background_delegations == {"deleg-current"}
polled = pool.poll_background()
assert polled["sessions"][0]["tasks"][0]["status"] == "interrupted"
assert [event["event"] for event in polled["sessions"][0]["events"]] == [
    "subagent.start", "subagent.complete"
]
assert polled["sessions"][0]["events"][-1]["status"] == "interrupted"
`)
  })

  it('honors rapid Hermes boundary requests after the complete tool batch', () => {
    runPython(String.raw`
${harness}

interrupt_signals = []
run_agent_module = types.ModuleType("run_agent")
run_agent_module._set_interrupt = lambda value, thread_id=None: interrupt_signals.append(
    (value, thread_id)
)
sys.modules["run_agent"] = run_agent_module

class BoundaryToolAgent:
    def __init__(self):
        self._interrupt_requested = False
        self._interrupt_message = None
        self._pending_redirect = None
        self._pending_redirect_lock = threading.Lock()
        self._model_request_active = threading.Event()
        self._execution_thread_id = None
        self._interrupt_thread_signal_pending = False
        self._active_request_abort = None
        self.tool_started = threading.Event()
        self.release_tool = threading.Event()
        self.tool_order = []
        self.clear_count = 0

    def _execute_tool_calls(self, assistant_message, messages, effective_task_id, api_call_count=0):
        self.tool_order.append("first:start")
        self.tool_started.set()
        assert self.release_tool.wait(10)
        self.tool_order.extend(["first:end", "second"])

    def run_conversation(self, message, **kwargs):
        self._execution_thread_id = threading.current_thread().ident
        self._execute_tool_calls(None, [], kwargs.get("task_id") or "", 1)
        return {"interrupted": self._interrupt_requested, "messages": []}

    def clear_interrupt(self):
        self.clear_count += 1
        self._interrupt_requested = False

pool, _fake_db = make_pool()
agent = BoundaryToolAgent()
session = bridge.AgentSession(session_id="boundary-tools", agent=agent)
assert pool._install_boundary_interrupt(session) is True
run_id = "run-boundary-tools"
record = bridge.RunRecord(run_id=run_id, session_id=session.session_id)
session.running = True
session.current_run_id = run_id
session.boundary_phase = "model"
with pool._lock:
    pool._sessions[session.session_id] = session
    pool._runs[run_id] = record
thread = threading.Thread(
    target=pool._run_chat,
    args=(session, record, "use both tools", None, None, [], "default", False, None, "api_server"),
    daemon=True,
)
thread.start()

assert agent.tool_started.wait(10)
first = pool.request_boundary_interrupt(session.session_id, run_id)
second = pool.request_boundary_interrupt(session.session_id, run_id)
assert first == {
    "status": "accepted",
    "session_id": session.session_id,
    "run_id": run_id,
    "phase": "tool_batch",
    "guarantee": "strict",
}
assert second == {
    "status": "already_pending",
    "session_id": session.session_id,
    "run_id": run_id,
    "phase": "tool_batch",
    "guarantee": "strict",
}
assert interrupt_signals == []
agent.release_tool.set()
thread.join(10)

assert not thread.is_alive()
assert agent.tool_order == ["first:start", "first:end", "second"]
assert record.status == "interrupted"
assert record.result["finish_reason"] == "boundary_interrupt"
assert record.result["boundary_interrupt"] is True
assert [event["event"] for event in record.events if event.get("event") == "run.boundary_interrupt"] == [
    "run.boundary_interrupt"
]
assert agent.clear_count == 1
assert session.boundary_phase == "idle"
assert session.boundary_pending_run_id is None
`)
  })

  it('interrupts only the active Hermes model request at the boundary', () => {
    runPython(String.raw`
${harness}

interrupt_signals = []
run_agent_module = types.ModuleType("run_agent")
run_agent_module._set_interrupt = lambda value, thread_id=None: interrupt_signals.append(
    (value, thread_id)
)
sys.modules["run_agent"] = run_agent_module

class BoundaryModelAgent:
    def __init__(self):
        self._interrupt_requested = False
        self._interrupt_message = None
        self._pending_redirect = None
        self._pending_redirect_lock = threading.Lock()
        self._model_request_active = threading.Event()
        self._execution_thread_id = None
        self._interrupt_thread_signal_pending = False
        self._active_request_abort = None
        self.model_started = threading.Event()
        self.model_aborted = threading.Event()
        self.abort_reasons = []
        self.clear_count = 0

    def _execute_tool_calls(self, assistant_message, messages, effective_task_id, api_call_count=0):
        raise AssertionError("model boundary must not execute tools")

    def run_conversation(self, message, **kwargs):
        self._execution_thread_id = threading.current_thread().ident
        self._model_request_active.set()
        self._active_request_abort = lambda reason: (
            self.abort_reasons.append(reason),
            self.model_aborted.set(),
        )
        self.model_started.set()
        assert self.model_aborted.wait(10)
        self._model_request_active.clear()
        self._active_request_abort = None
        return {"interrupted": self._interrupt_requested, "messages": []}

    def clear_interrupt(self):
        self.clear_count += 1
        self._interrupt_requested = False
        if self._execution_thread_id is not None:
            run_agent_module._set_interrupt(False, self._execution_thread_id)

    def interrupt(self, message):
        raise AssertionError("boundary interrupt must not call the broad interrupt method")

pool, _fake_db = make_pool()
agent = BoundaryModelAgent()
session = bridge.AgentSession(session_id="boundary-model", agent=agent)
assert pool._install_boundary_interrupt(session) is True
run_id = "run-boundary-model"
record = bridge.RunRecord(run_id=run_id, session_id=session.session_id)
session.running = True
session.current_run_id = run_id
session.boundary_phase = "model"
with pool._lock:
    pool._sessions[session.session_id] = session
    pool._runs[run_id] = record
thread = threading.Thread(
    target=pool._run_chat,
    args=(session, record, "wait for model", None, None, [], "default", False, None, "api_server"),
    daemon=True,
)
thread.start()

assert agent.model_started.wait(10)
assert pool.request_boundary_interrupt(session.session_id, "stale-run") == {
    "status": "run_mismatch",
    "session_id": session.session_id,
    "run_id": run_id,
    "guarantee": "strict",
}
first = pool.request_boundary_interrupt(session.session_id, run_id)
second = pool.request_boundary_interrupt(session.session_id, run_id)
assert first["status"] == "accepted" and first["phase"] == "model"
assert second["status"] == "already_pending" and second["phase"] == "model"
thread.join(10)

assert not thread.is_alive()
assert agent.abort_reasons == ["boundary_interrupt_abort"]
assert [value for value, _thread_id in interrupt_signals] == [True, False]
assert record.status == "interrupted"
assert record.result["finish_reason"] == "boundary_interrupt"
assert agent.clear_count == 1
`)
  })

  it('waits for every concurrent Hermes tool worker before crossing the boundary', () => {
    runPython(String.raw`
${harness}

run_agent_module = types.ModuleType("run_agent")
run_agent_module._set_interrupt = lambda value, thread_id=None: None
sys.modules["run_agent"] = run_agent_module

class ParallelBoundaryAgent:
    def __init__(self):
        self._interrupt_requested = False
        self._interrupt_message = None
        self._pending_redirect = None
        self._pending_redirect_lock = threading.Lock()
        self._model_request_active = threading.Event()
        self._execution_thread_id = None
        self._interrupt_thread_signal_pending = False
        self.started = [threading.Event(), threading.Event()]
        self.release = [threading.Event(), threading.Event()]
        self.completed = []

    def _execute_tool_calls(self, assistant_message, messages, effective_task_id, api_call_count=0):
        def execute(index):
            self.started[index].set()
            assert self.release[index].wait(10)
            self.completed.append(index)

        workers = [threading.Thread(target=execute, args=(index,)) for index in range(2)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join()

pool, _fake_db = make_pool()
agent = ParallelBoundaryAgent()
session = bridge.AgentSession(session_id="boundary-parallel", agent=agent)
session.running = True
session.current_run_id = "run-boundary-parallel"
session.boundary_phase = "model"
pool._sessions[session.session_id] = session
assert pool._install_boundary_interrupt(session) is True

execution = threading.Thread(
    target=agent._execute_tool_calls,
    args=(None, [], session.session_id, 1),
    daemon=True,
)
execution.start()
assert all(started.wait(10) for started in agent.started)
assert pool.request_boundary_interrupt(
    session.session_id,
    session.current_run_id,
)["status"] == "accepted"

agent.release[0].set()
assert wait_for(lambda: agent.completed == [0])
assert execution.is_alive()
assert agent._interrupt_requested is False
agent.release[1].set()
execution.join(10)

assert not execution.is_alive()
assert sorted(agent.completed) == [0, 1]
assert agent._interrupt_requested is True
assert session.boundary_reached_run_id == session.current_run_id
`)
  })

  it('fails closed when the Hermes private tool boundary is incompatible', () => {
    runPython(String.raw`
${harness}

run_agent_module = types.ModuleType("run_agent")
run_agent_module._set_interrupt = lambda value, thread_id=None: None
sys.modules["run_agent"] = run_agent_module

class UnsupportedAgent:
    _interrupt_requested = False
    _model_request_active = threading.Event()

pool, _fake_db = make_pool()
session = bridge.AgentSession(session_id="unsupported-boundary", agent=UnsupportedAgent())
session.running = True
session.current_run_id = "run-unsupported"
pool._sessions[session.session_id] = session

assert pool._install_boundary_interrupt(session) is False
result = pool.request_boundary_interrupt(session.session_id, session.current_run_id)
assert result["status"] == "unsupported"
assert result["guarantee"] == "none"
assert "_execute_tool_calls" in result["reason"]
assert session.agent._interrupt_requested is False
`)
  })

  it('keeps idle sessions alive while durable background delegations are active', () => {
    runPython(String.raw`
${harness}

async_module = types.ModuleType("tools.async_delegation")
async_module.list_async_delegations = lambda: [
    {
        "delegation_id": "deleg-running",
        "status": "running",
        "parent_session_id": "session-running",
    },
    {
        "delegation_id": "deleg-finalizing",
        "status": "finalizing",
        "origin_ui_session_id": "session-finalizing",
    },
]
async_module.interrupt_for_session = lambda **kwargs: 0
sys.modules["tools.async_delegation"] = async_module

server = bridge.BridgeServer("tcp://127.0.0.1:1")
server.GC_INTERVAL_SECONDS = 0
old = time.time() - server.IDLE_TIMEOUT_SECONDS - 1
for session_id in ("session-running", "session-finalizing", "session-idle"):
    session = bridge.AgentSession(session_id=session_id, agent=object())
    session.last_used_at = old
    server.pool._sessions[session_id] = session

server._gc_idle_sessions()

assert set(server.pool._sessions) == {"session-running", "session-finalizing"}
`)
  })

  it('falls back to worker task state when checking idle background work', () => {
    runPython(String.raw`
${harness}

async_module = types.ModuleType("tools.async_delegation")
async_module.list_async_delegations = lambda: (_ for _ in ()).throw(RuntimeError("registry unavailable"))
async_module.interrupt_for_session = lambda **kwargs: 0
sys.modules["tools.async_delegation"] = async_module

server = bridge.BridgeServer("tcp://127.0.0.1:1")
server.GC_INTERVAL_SECONDS = 0
session = bridge.AgentSession(session_id="session-1", agent=object())
session.last_used_at = time.time() - server.IDLE_TIMEOUT_SECONDS - 1
session.background_tasks["child-1"] = {"status": "running"}
server.pool._sessions[session.session_id] = session

server._gc_idle_sessions()

assert "session-1" in server.pool._sessions
`)
  })

  it('hot-switches a loaded idle session model without recreating the session', () => {
    runPython(String.raw`
${harness}

def fake_resolve_runtime(model, provider=None):
    return {
        "provider": provider or "openai",
        "base_url": f"https://{provider or 'openai'}.example/v1",
        "api_key": f"key:{model}",
        "api_mode": "chat_completions",
    }

bridge._resolve_runtime = fake_resolve_runtime
pool, _fake_db = make_pool()

class SwitchableAgent:
    def __init__(self):
        self.model = "old-model"
        self.provider = "openai"
        self.base_url = "https://old.example/v1"
        self.api_key = "old-key"
        self.api_mode = "chat_completions"
        self.switch_calls = []

    def switch_model(self, **kwargs):
        self.switch_calls.append(kwargs)
        self.model = kwargs["new_model"]
        self.provider = kwargs["new_provider"]
        self.base_url = kwargs["base_url"]
        self.api_key = kwargs["api_key"]
        self.api_mode = kwargs["api_mode"]

agent = SwitchableAgent()
session = bridge.AgentSession(
    session_id="session-model",
    agent=agent,
    config={"profile": "default", "model": "old-model", "provider": "openai"},
)
pool._sessions["session-model"] = session

result = pool.switch_session_model("session-model", "new-model", "anthropic", "default")

assert result["switched"] is True
assert pool._sessions["session-model"] is session
assert agent.switch_calls == [{
    "new_model": "new-model",
    "new_provider": "anthropic",
    "api_key": "key:new-model",
    "base_url": "https://anthropic.example/v1",
    "api_mode": "chat_completions",
}]
assert session.config["model"] == "new-model"
assert session.config["provider"] == "anthropic"
assert "pending_model_switch_note" in session.config
`)
  })

  it('does not rebuild an idle agent when only the requested custom-provider alias differs', () => {
    runPython(String.raw`
${harness}

def fake_resolve_runtime(model, provider=None):
    assert provider == "custom:liuzheng"
    return {
        "provider": "custom",
        "base_url": "https://custom.example/v1",
        "api_key": "same-key",
        "api_mode": "chat_completions",
    }

bridge._resolve_runtime = fake_resolve_runtime
pool, _fake_db = make_pool()

class SwitchableAgent:
    def __init__(self):
        self.model = "same-model"
        self.provider = "custom"
        self.base_url = "https://custom.example/v1"
        self.api_key = "same-key"
        self.api_mode = "chat_completions"
        self.switch_calls = []

    def switch_model(self, **kwargs):
        self.switch_calls.append(kwargs)

agent = SwitchableAgent()
session = bridge.AgentSession(
    session_id="session-custom-alias",
    agent=agent,
    config={"profile": "default", "model": "same-model", "provider": "custom"},
)
pool._sessions["session-custom-alias"] = session

result = pool.switch_session_model(
    "session-custom-alias", "same-model", "custom:liuzheng", "default",
)

assert result["switched"] is True
assert agent.switch_calls == []
assert session.config["model"] == "same-model"
assert session.config["provider"] == "custom:liuzheng"
assert session.config["base_url"] == "https://custom.example/v1"
`)
  })

  it('rebuilds an idle agent when credentials change under the same runtime', () => {
    runPython(String.raw`
${harness}

def fake_resolve_runtime(model, provider=None):
    return {
        "provider": "custom",
        "base_url": "https://custom.example/v1",
        "api_key": "rotated-key",
        "api_mode": "chat_completions",
    }

bridge._resolve_runtime = fake_resolve_runtime
pool, _fake_db = make_pool()

class SwitchableAgent:
    def __init__(self):
        self.model = "same-model"
        self.provider = "custom"
        self.base_url = "https://custom.example/v1"
        self.api_key = "old-key"
        self.api_mode = "chat_completions"
        self.switch_calls = []

    def switch_model(self, **kwargs):
        self.switch_calls.append(kwargs)
        self.api_key = kwargs["api_key"]

agent = SwitchableAgent()
session = bridge.AgentSession(
    session_id="session-rotated-key",
    agent=agent,
    config={"profile": "default", "model": "same-model", "provider": "custom:liuzheng"},
)
pool._sessions["session-rotated-key"] = session

result = pool.switch_session_model(
    "session-rotated-key", "same-model", "custom:liuzheng", "default",
)

assert result["switched"] is True
assert result["provider"] == "custom:liuzheng"
assert len(agent.switch_calls) == 1
assert agent.switch_calls[0]["api_key"] == "rotated-key"
`)
  })

  it('defers a loaded session model switch while a run is active and applies it after completion', () => {
    runPython(String.raw`
${harness}

def fake_resolve_runtime(model, provider=None):
    return {
        "provider": provider or "openai",
        "base_url": f"https://{provider or 'openai'}.example/v1",
        "api_key": f"key:{model}",
        "api_mode": "chat_completions",
    }

bridge._resolve_runtime = fake_resolve_runtime
pool, _fake_db = make_pool()
release = threading.Event()

class RunningAgent:
    def __init__(self):
        self.model = "old-model"
        self.provider = "openai"
        self.switch_calls = []

    def switch_model(self, **kwargs):
        self.switch_calls.append(kwargs)
        self.model = kwargs["new_model"]
        self.provider = kwargs["new_provider"]

    def run_conversation(self, message, **kwargs):
        release.wait(timeout=5)
        return {"messages": [{"role": "assistant", "content": "done"}]}

agent = RunningAgent()
session, record, thread = start_manual_run(pool, "running-model", agent)
session.config.update({"profile": "default", "model": "old-model", "provider": "openai"})
assert wait_for(lambda: session.running)

result = pool.switch_session_model("running-model", "new-model", "anthropic", "default")
assert result["deferred"] is True
assert agent.switch_calls == []

release.set()
thread.join(timeout=5)

assert record.status == "complete"
assert agent.switch_calls == [{
    "new_model": "new-model",
    "new_provider": "anthropic",
    "api_key": "key:new-model",
    "base_url": "https://anthropic.example/v1",
    "api_mode": "chat_completions",
}]
assert session.config["model"] == "new-model"
assert session.config["provider"] == "anthropic"
assert "pending_model_switch" not in session.config
`)
  })

  it('syncs generated result tail to the session DB when the agent crashes after generation', () => {
    runPython(String.raw`
${harness}

class CrashingAgent:
    def run_conversation(self, message, **kwargs):
        self.messages = [
            {"role": "user", "content": message},
            {"role": "assistant", "content": "assistant survived"},
        ]
        raise RuntimeError("late post-processing failure")

pool, fake_db = make_pool()
_session, record, thread = start_manual_run(pool, "tail-sync", CrashingAgent())
thread.join(timeout=5)

assert record.status == "error"
messages = fake_db.get_messages("tail-sync")
assert [(msg["role"], msg["content"]) for msg in messages] == [
    ("user", "message:tail-sync"),
    ("assistant", "assistant survived"),
]
`)
  })

  it('only appends missing generated tail messages when the session DB is partially flushed', () => {
    runPython(String.raw`
${harness}

class PartiallyFlushedAgent:
    def __init__(self, db):
        self.db = db

    def run_conversation(self, message, **kwargs):
        self.db.append_message("partial-tail-sync", "assistant", "already flushed")
        self.messages = [
            {"role": "user", "content": message},
            {"role": "assistant", "content": "already flushed"},
            {"role": "tool", "content": "missing tool result", "tool_name": "demo"},
        ]
        raise RuntimeError("late post-processing failure")

pool, fake_db = make_pool()
_session, record, thread = start_manual_run(pool, "partial-tail-sync", PartiallyFlushedAgent(fake_db))
thread.join(timeout=5)

assert record.status == "error"
messages = fake_db.get_messages("partial-tail-sync")
assert [(msg["role"], msg["content"]) for msg in messages] == [
    ("user", "message:partial-tail-sync"),
    ("assistant", "already flushed"),
    ("tool", "missing tool result"),
]
`)
  })

  it('remembers execute_code approvals inside the bridge without patching upstream files', () => {
    runPython(String.raw`
${harness}

pool, _fake_db = make_pool()

notify = pool._gateway_approval_notify("session-a")
approval.queue_gateway_approval("session-a", "request-session-a")
notify({
    "request_id": "request-session-a",
    "command": "execute_code <<'PY'\nprint(1)\nPY",
    "description": "execute_code script execution",
    "pattern_key": "execute_code",
    "pattern_keys": ["execute_code"],
})
approval_id = next(iter(pool._gateway_approval_requests.keys()))
result = pool.respond_approval(approval_id, "session")
assert result["resolved"] is True
assert approval.is_approved("session-a", "execute_code") is True
assert approval._saved_permanent == set()

notify = pool._gateway_approval_notify("session-b")
approval.queue_gateway_approval("session-b", "request-session-b")
notify({
    "request_id": "request-session-b",
    "command": "execute_code <<'PY'\nprint(2)\nPY",
    "description": "execute_code script execution",
    "pattern_key": "execute_code",
    "pattern_keys": ["execute_code"],
})
approval_id = next(iter(pool._gateway_approval_requests.keys()))
result = pool.respond_approval(approval_id, "always")
assert result["resolved"] is True
assert approval.is_approved("session-b", "execute_code") is True
assert "execute_code" in approval._permanent_approved
assert "execute_code" in approval._saved_permanent

bridge._install_execute_code_approval_memory_patch()
token = approval.set_current_session_key("session-c")
try:
    approval.approve_session("session-c", "execute_code")
    check_result = approval.check_execute_code_guard("print(3)", "local", has_host_access=True)
    assert check_result["approved"] is True
    assert approval._check_execute_code_calls == []
finally:
    approval.reset_current_session_key(token)

check_result = approval.check_execute_code_guard("print(4)", "local", has_host_access=True)
assert check_result["approved"] is False
assert approval._check_execute_code_calls == [("print(4)", "local", True)]
`)
  })

  it('routes terminal/gateway approvals and stream callbacks per concurrent session', () => {
    runPython(String.raw`
${harness}

barrier = threading.Barrier(2)
os.environ["HERMES_EXEC_ASK"] = "preexisting-exec-ask"

class FakeAgent:
    def __init__(self, session_id):
        self.session_id = session_id

    def run_conversation(self, message, **kwargs):
        barrier.wait(timeout=20)
        notify = approval._notify.get(self.session_id)
        if notify is None:
            raise RuntimeError(f"missing gateway notify for {self.session_id}")
        request_id = f"request:{self.session_id}"
        approval.queue_gateway_approval(self.session_id, request_id)
        notify({
            "request_id": request_id,
            "command": f"gateway:{self.session_id}",
            "description": f"gateway-desc:{self.session_id}",
        })
        kwargs["stream_callback"](f"delta:{self.session_id}")
        callback = _get_approval_callback()
        if callback is None:
            raise RuntimeError(f"missing approval callback for {self.session_id}")
        assert get_current_session_key("") == self.session_id
        choice = callback(f"cmd:{self.session_id}", f"desc:{self.session_id}", allow_permanent=False)
        return {
            "messages": [{"role": "assistant", "content": f"done:{self.session_id}:{choice}"}],
            "choice": choice,
            "completed": True,
        }

pool, fake_db = make_pool()
records = {}
threads = []

for sid in ("session-a", "session-b"):
    _session, record, thread = start_manual_run(pool, sid, FakeAgent(sid))
    records[sid] = record
    threads.append(thread)

terminal_approval_ids = {}
gateway_approval_ids = {}
def approvals_ready():
    with pool._lock:
        for sid, record in records.items():
            for event in record.events:
                if event.get("event") != "approval.requested":
                    continue
                command = event.get("command")
                if command == f"cmd:{sid}":
                    terminal_approval_ids[sid] = event["approval_id"]
                if command == f"gateway:{sid}":
                    gateway_approval_ids[sid] = event["approval_id"]
    return (
        set(terminal_approval_ids) == {"session-a", "session-b"} and
        set(gateway_approval_ids) == {"session-a", "session-b"}
    )

if not wait_for(approvals_ready):
    diagnostics = {
        sid: {
            "status": record.status,
            "error": record.error,
            "events": record.events,
            "result": record.result,
        }
        for sid, record in records.items()
    }
    raise AssertionError({
        "terminal_approval_ids": terminal_approval_ids,
        "gateway_approval_ids": gateway_approval_ids,
        "records": diagnostics,
    })

assert os.environ.get("HERMES_EXEC_ASK") == "1"
assert pool._exec_ask_depth == 2

pool.respond_approval(gateway_approval_ids["session-b"], "always")
pool.respond_approval(gateway_approval_ids["session-a"], "session")
pool.respond_approval(terminal_approval_ids["session-b"], "deny")
pool.respond_approval(terminal_approval_ids["session-a"], "once")

for thread in threads:
    thread.join(timeout=20)
    assert not thread.is_alive()

assert records["session-a"].status == "complete"
assert records["session-b"].status == "complete"
assert records["session-a"].result["choice"] == "once"
assert records["session-b"].result["choice"] == "deny"
assert records["session-a"].deltas == ["delta:session-a"]
assert records["session-b"].deltas == ["delta:session-b"]
assert fake_db.get_messages("session-a")[0]["content"] == "message:session-a"
assert fake_db.get_messages("session-b")[0]["content"] == "message:session-b"
assert os.environ.get("HERMES_EXEC_ASK") == "preexisting-exec-ask"
assert pool._exec_ask_depth == 0
assert pool._approval_handlers == {}
assert approval._notify == {}
assert sorted(approval._resolved_gateway) == [
    ("session-a", "session"),
    ("session-b", "always"),
]

terminal_commands = {}
gateway_commands = {}
timeouts = {}
for sid, record in records.items():
    for event in record.events:
        if event.get("event") != "approval.requested":
            continue
        command = event.get("command")
        if command == f"cmd:{sid}":
            terminal_commands[sid] = command
            timeouts[sid] = event.get("timeout_ms")
        if command == f"gateway:{sid}":
            gateway_commands[sid] = command

assert terminal_commands == {
    "session-a": "cmd:session-a",
    "session-b": "cmd:session-b",
}
assert gateway_commands == {
    "session-a": "gateway:session-a",
    "session-b": "gateway:session-b",
}
assert timeouts == {
    "session-a": 120000,
    "session-b": 120000,
}

same_session = bridge.AgentSession(session_id="same-session", agent=FakeAgent("same-session"))
same_session.running = True
pool.get_or_create = lambda *args, **kwargs: same_session
try:
    pool.start_chat("same-session", "second")
    raise AssertionError("same-session concurrent run was accepted")
except RuntimeError as exc:
    assert "already running" in str(exc)

class FakeWorker:
    def __init__(self, destroyed, profile="default", key="default"):
        self.running = True
        self.destroyed = destroyed
        self.profile = profile
        self.key = key
        self.requests = []
        self.stopped = False

    def request(self, req):
        self.requests.append(req)
        return {"ok": True, "destroyed": self.destroyed}

    def stop(self):
        self.running = False
        self.stopped = True

broker = bridge.BridgeBroker("ipc:///tmp/unused.sock")
profile_worker = FakeWorker(2)
broker._workers["default"] = profile_worker
broker._run_profile["run-session-a"] = "default"
broker._run_worker_key["run-session-a"] = "default"
broker._running_run_profile["run-session-a"] = "default"
broker._running_run_worker_key["run-session-a"] = "default"
broker._session_profile["session-a"] = "default"
broker._session_worker_key["session-a"] = "default"
broker._approval_profile["approval-a"] = "default"
broker._approval_worker_key["approval-a"] = "default"
broker._compression_profile["compression-a"] = "default"
broker._compression_worker_key["compression-a"] = "default"

destroy_profile_result = broker.handle({"action": "destroy_profile", "profile": "default"})
assert destroy_profile_result == {"profile": "default", "destroyed": 2}
assert profile_worker.stopped
assert "default" not in broker._workers
assert broker._run_profile == {}
assert broker._run_worker_key == {}
assert broker._running_run_profile == {}
assert broker._running_run_worker_key == {}
assert broker._session_profile == {}
assert broker._session_worker_key == {}
assert broker._approval_profile == {}
assert broker._approval_worker_key == {}
assert broker._compression_profile == {}
assert broker._compression_worker_key == {}

worker_a = FakeWorker(1, "default", "a")
worker_b = FakeWorker(3, "work", "b")
broker._workers["a"] = worker_a
broker._workers["b"] = worker_b
broker._run_profile["run-a"] = "default"
broker._run_worker_key["run-a"] = "a"
broker._running_run_profile["run-a"] = "default"
broker._running_run_worker_key["run-a"] = "a"
broker._session_profile["session-b"] = "work"
broker._session_worker_key["session-b"] = "b"

destroy_all_result = broker.handle({"action": "destroy_all"})
assert destroy_all_result == {"destroyed": 4}
assert worker_a.stopped
assert worker_b.stopped
assert broker._workers == {}
assert broker._run_profile == {}
assert broker._run_worker_key == {}
assert broker._running_run_profile == {}
assert broker._running_run_worker_key == {}
assert broker._session_profile == {}
assert broker._session_worker_key == {}
`)
  })

  it('builds broker ping metrics without calling profile workers', () => {
    runPython(String.raw`
${harness}

class PingWorker:
    running = True
    pid = 12345
    endpoint = "ipc:///tmp/worker.sock"
    last_used_at = 12.5

    def request(self, req):
        raise AssertionError("broker ping must not forward to worker")

broker = bridge.BridgeBroker("ipc:///tmp/broker.sock")
broker._workers["default"] = PingWorker()
broker._session_profile["session-a"] = "default"
broker._running_run_profile["run-a"] = "default"

resp = broker.handle({"action": "ping"})
assert resp["workers"] == {"default": True}
assert resp["worker_details"]["default"]["pid"] == 12345
assert resp["active_sessions"] == 1
assert resp["running_sessions"] == 1
assert resp["sessions_by_profile"] == {"default": 1}
assert resp["running_sessions_by_profile"] == {"default": 1}
`)
  })

  it('routes boundary interrupts through the worker server and profile broker', () => {
    runPython(String.raw`
${harness}

server_calls = []
server = bridge.BridgeServer.__new__(bridge.BridgeServer)
server.pool = types.SimpleNamespace(
    request_boundary_interrupt=lambda session_id, run_id: server_calls.append(
        (session_id, run_id)
    ) or {"status": "accepted", "run_id": run_id}
)
server_response = server.handle({
    "action": "request_boundary_interrupt",
    "session_id": "session-a",
    "expected_run_id": "run-a",
})
assert server_calls == [("session-a", "run-a")]
assert server_response == {"status": "accepted", "run_id": "run-a"}

class BoundaryWorker:
    running = True
    pid = 12345
    endpoint = "ipc:///tmp/boundary-worker.sock"
    last_used_at = 12.5
    profile = "work"
    key = "work"

    def __init__(self):
        self.requests = []

    def request(self, req, timeout=None):
        self.requests.append(req)
        return {"ok": True, "status": "accepted", "run_id": req["expected_run_id"]}

broker = bridge.BridgeBroker("ipc:///tmp/unused.sock")
worker = BoundaryWorker()
broker._workers["work"] = worker
broker._session_profile["session-a"] = "work"
broker._session_worker_key["session-a"] = "work"

broker_response = broker.handle({
    "action": "request_boundary_interrupt",
    "session_id": "session-a",
    "expected_run_id": "run-a",
    "profile": "work",
})
assert broker_response["status"] == "accepted"
assert worker.requests == [{
    "action": "request_boundary_interrupt",
    "session_id": "session-a",
    "expected_run_id": "run-a",
    "profile": "work",
}]
`)
  })

  it('does not start a worker for unloaded broker status checks', () => {
    runPython(String.raw`
${harness}

broker = bridge.BridgeBroker("ipc:///tmp/unused.sock")
resp = broker.handle({
    "action": "status_if_loaded",
    "session_id": "session-a",
    "profile": "default",
})

assert resp["session_id"] == "session-a"
assert resp["running"] is False
assert resp["loaded"] is False
assert broker._workers == {}
`)
  })

  it('forwards unloaded-safe status checks to an existing routed worker', () => {
    runPython(String.raw`
${harness}

class StatusWorker:
    running = True
    pid = 12345
    endpoint = "ipc:///tmp/worker.sock"
    last_used_at = 12.5

    def __init__(self):
        self.profile = "default"
        self.key = "default"
        self.requests = []

    def request(self, req, timeout=None):
        self.requests.append(req)
        assert req["action"] == "status"
        assert "worker_key" not in req
        return {
            "ok": True,
            "session_id": req["session_id"],
            "exists": True,
            "running": True,
            "current_run_id": "run-a",
        }

broker = bridge.BridgeBroker("ipc:///tmp/unused.sock")
worker = StatusWorker()
broker._workers["default"] = worker
broker._session_profile["session-a"] = "default"
broker._session_worker_key["session-a"] = "default"

resp = broker.handle({
    "action": "status_if_loaded",
    "session_id": "session-a",
    "profile": "default",
})

assert resp["running"] is True
assert resp["current_run_id"] == "run-a"
assert resp["loaded"] is True
assert len(worker.requests) == 1
assert len(broker._workers) == 1
`)
  })

  it('does not record a route for missing sessions during unloaded-safe status checks', () => {
    runPython(String.raw`
${harness}

class StatusWorker:
    running = True
    pid = 12345
    endpoint = "ipc:///tmp/worker.sock"
    last_used_at = 12.5
    profile = "default"
    key = "default"

    def request(self, req, timeout=None):
        return {
            "ok": True,
            "session_id": req["session_id"],
            "exists": False,
            "running": False,
            "message_count": 0,
        }

broker = bridge.BridgeBroker("ipc:///tmp/unused.sock")
broker._workers["default"] = StatusWorker()

resp = broker.handle({
    "action": "status_if_loaded",
    "session_id": "missing-session",
    "profile": "default",
})

assert resp["exists"] is False
assert resp["loaded"] is True
assert broker._session_profile == {}
assert broker._session_worker_key == {}
`)
  })

  it('routes a first-message YOLO command to the requested profile worker', () => {
    runPython(String.raw`
${harness}

class CommandWorker:
    running = True
    pid = 12345
    endpoint = "ipc:///tmp/yolo-worker.sock"
    last_used_at = 12.5

    def __init__(self):
        self.profile = "work"
        self.key = "work"
        self.requests = []

    def request(self, req, timeout=None):
        self.requests.append(req)
        return {
            "ok": True,
            "session_id": req["session_id"],
            "command": "yolo",
            "handled": True,
            "action": "yolo",
            "enabled": True,
        }

broker = bridge.BridgeBroker("ipc:///tmp/unused.sock")
worker = CommandWorker()
broker._workers["work"] = worker

response = broker.handle({
    "action": "command",
    "session_id": "new-session",
    "profile": "work",
    "command": "yolo",
})

assert response["enabled"] is True, response
assert worker.requests == [{
    "action": "command",
    "session_id": "new-session",
    "profile": "work",
    "command": "yolo",
}], worker.requests
assert broker._session_profile["new-session"] == "work"
assert broker._session_worker_key["new-session"] == "work"
`)
  })

  it('routes worker-keyed broker requests without stopping the worker on session destroy', () => {
    runPython(String.raw`
${harness}

class RoutedWorker:
    running = True
    pid = 12345
    endpoint = "ipc:///tmp/worker.sock"
    last_used_at = 12.5

    def __init__(self, profile, key):
        self.profile = profile
        self.key = key
        self.requests = []
        self.stopped = False

    def request(self, req, timeout=None):
        self.requests.append(req)
        action = req.get("action")
        if action == "chat":
            return {"ok": True, "run_id": "run-compress", "session_id": req["session_id"], "status": "running"}
        if action == "get_output":
            return {"ok": True, "run_id": req["run_id"], "session_id": "compress-temp", "status": "complete", "done": True}
        if action == "destroy":
            return {"ok": True, "session_id": req["session_id"], "destroyed": True}
        raise AssertionError(f"unexpected action: {action}")

    def stop(self):
        self.stopped = True

broker = bridge.BridgeBroker("ipc:///tmp/unused.sock")
worker = RoutedWorker("default", "default:compression:session-a")
broker._workers[worker.key] = worker

chat_resp = broker.handle({
    "action": "chat",
    "session_id": "compress-temp",
    "profile": "default",
    "worker_key": worker.key,
    "message": "summarize",
})
assert chat_resp["run_id"] == "run-compress"
assert worker.requests[-1]["profile"] == "default"
assert "worker_key" not in worker.requests[-1]

broker.handle({"action": "get_output", "run_id": "run-compress"})
assert worker.requests[-1]["action"] == "get_output"

destroy_resp = broker.handle({
    "action": "destroy",
    "session_id": "compress-temp",
    "profile": "default",
    "worker_key": worker.key,
})
assert destroy_resp["destroyed"] is True
assert worker.requests[-1]["action"] == "destroy"
assert not worker.stopped
assert worker.key in broker._workers
assert "compress-temp" not in broker._session_profile
assert "compress-temp" not in broker._session_worker_key
`)
  })

  it('namespaces profile worker endpoints by broker endpoint', () => {
    runPython(String.raw`
${harness}

prod_endpoint = bridge._worker_endpoint("default", "ipc:///tmp/hermes-agent-bridge.sock")
preview_endpoint = bridge._worker_endpoint("default", "ipc:///tmp/hermes-web-ui-preview/agent-bridge.sock")
assert prod_endpoint != preview_endpoint
assert prod_endpoint == bridge._worker_endpoint("default", "ipc:///tmp/hermes-agent-bridge.sock")

prod_broker = bridge.BridgeBroker("ipc:///tmp/hermes-agent-bridge.sock")
preview_broker = bridge.BridgeBroker("ipc:///tmp/hermes-web-ui-preview/agent-bridge.sock")
prod_worker = prod_broker._worker_for_profile("default")
preview_worker = preview_broker._worker_for_profile("default")
assert prod_worker.endpoint != preview_worker.endpoint
`)
  })

  it('allows worker transport to be selected with environment variables', () => {
    runPython(String.raw`
${harness}

os.environ.pop("HERMES_AGENT_BRIDGE_WORKER_TRANSPORT", None)
os.environ.pop("HERMES_AGENT_BRIDGE_WORKER_PORT_BASE", None)

default_endpoint = bridge._worker_endpoint("default", "ipc:///tmp/hermes-agent-bridge.sock")
if os.name == "nt":
    assert default_endpoint.startswith("tcp://127.0.0.1:")
else:
    assert default_endpoint.startswith("ipc://")

os.environ["HERMES_AGENT_BRIDGE_WORKER_TRANSPORT"] = "tcp"
os.environ["HERMES_AGENT_BRIDGE_WORKER_PORT_BASE"] = "19650"
tcp_endpoint = bridge._worker_endpoint("default", "ipc:///tmp/hermes-agent-bridge.sock")
assert tcp_endpoint.startswith("tcp://127.0.0.1:")
assert int(tcp_endpoint.rsplit(":", 1)[1]) >= 19650
assert int(tcp_endpoint.rsplit(":", 1)[1]) < 20650

os.environ["HERMES_AGENT_BRIDGE_WORKER_TRANSPORT"] = "ipc"
ipc_endpoint = bridge._worker_endpoint("default", "ipc:///tmp/hermes-agent-bridge.sock")
assert ipc_endpoint.startswith("ipc://")

os.environ.pop("HERMES_AGENT_BRIDGE_WORKER_TRANSPORT", None)
os.environ.pop("HERMES_AGENT_BRIDGE_WORKER_PORT_BASE", None)
`)
  })

  it('restores approval env and clears handlers when a run fails', () => {
    runPython(String.raw`
${harness}

os.environ.pop("HERMES_EXEC_ASK", None)

class FailingAgent:
    def run_conversation(self, message, **kwargs):
        assert os.environ.get("HERMES_EXEC_ASK") == "1"
        assert _get_approval_callback() is not None
        raise RuntimeError("boom")

pool, fake_db = make_pool()
session, record, thread = start_manual_run(pool, "error-session", FailingAgent())
thread.join(timeout=20)
assert not thread.is_alive()

assert record.status == "error"
assert "boom" in (record.error or "")
assert session.running is False
assert session.current_run_id is None
assert "HERMES_EXEC_ASK" not in os.environ
assert pool._exec_ask_depth == 0
assert pool._exec_ask_previous is None
assert pool._approval_handlers == {}
assert approval._notify == {}
assert fake_db.get_messages("error-session")[0]["content"] == "message:error-session"
`)
  })

  it('fails closed when approval dispatch loses run thread context', () => {
    runPython(String.raw`
${harness}

pool, _fake_db = make_pool()
calls = []

def handler(command, description, *, allow_permanent=True):
    calls.append((command, description, allow_permanent))
    return "once"

with pool._lock:
    pool._approval_handlers["session-a"] = handler

assert pool._approval_dispatcher("cmd", "desc") == "deny"
assert calls == []

pool._run_context.session_id = "missing-session"
assert pool._approval_dispatcher("cmd", "desc") == "deny"
assert calls == []

pool._run_context.session_id = "session-a"
assert pool._approval_dispatcher("cmd", "desc", allow_permanent=False) == "once"
assert calls == [("cmd", "desc", False)]
`)
  })

  it('does not persist session-level approval for repeated memory write prompts', () => {
    runPython(String.raw`
${harness}

pool, _fake_db = make_pool()
callback = pool._approval_callback("session-a")
result = {}

def first_prompt():
    result["first"] = callback("memory text", "Save to memory: add to memory", allow_permanent=False)

thread = threading.Thread(target=first_prompt)
thread.start()

deadline = time.time() + 5
approval_id = None
while time.time() < deadline:
    with pool._lock:
        approval_id = next(iter(pool._approval_requests), None)
    if approval_id:
        break
    time.sleep(0.01)

assert approval_id is not None
assert pool.respond_approval(approval_id, "session") == {
    "approval_id": approval_id,
    "resolved": True,
    "choice": "session",
}
thread.join(timeout=5)
assert result["first"] == "session"

second_result = {}
def second_prompt():
    second_result["choice"] = callback("memory text 2", "Save to memory: add to memory", allow_permanent=False)

thread = threading.Thread(target=second_prompt)
thread.start()
deadline = time.time() + 5
approval_id = None
while time.time() < deadline:
    with pool._lock:
        approval_id = next(iter(pool._approval_requests), None)
    if approval_id:
        break
    time.sleep(0.01)

assert approval_id is not None
pool.respond_approval(approval_id, "once")
thread.join(timeout=5)
assert second_result["choice"] == "once"
`)
  })

  it('keeps bound approval session when Hermes propagates callback to tool workers', () => {
    runPython(String.raw`
${harness}

pool, _fake_db = make_pool()
pool._install_approval_dispatcher_for_current_thread("session-a")
parent_callback = terminal_tool._get_approval_callback()
assert parent_callback is not None

result = {}
def worker_prompt():
    # Hermes propagates the terminal approval callback object to worker threads,
    # but it does not propagate bridge_pool._run_context because that is a
    # bridge-local threading.local(). The callback itself must carry session-a.
    assert getattr(pool._run_context, "session_id", "") == ""
    result["first"] = parent_callback("memory text", "Save to memory: add preference", allow_permanent=False)

thread = threading.Thread(target=worker_prompt)
thread.start()

deadline = time.time() + 5
approval_id = None
while time.time() < deadline:
    with pool._lock:
        approval_id = next(iter(pool._approval_requests), None)
    if approval_id:
        break
    time.sleep(0.01)

assert approval_id is not None
pool.respond_approval(approval_id, "session")
thread.join(timeout=5)
assert result["first"] == "session"
`)
  })

  it('cleans broker workers and wires worker parent watchdog state', () => {
    runPython(String.raw`
${harness}

class FakeWorker:
    def __init__(self):
        self.running = True
        self.stopped = False

    def stop(self):
        self.running = False
        self.stopped = True

broker = bridge.BridgeBroker("ipc:///tmp/unused.sock")
worker = FakeWorker()
broker._workers["default"] = worker
broker._run_profile["run-a"] = "default"
broker._running_run_profile["run-a"] = "default"
broker._session_profile["session-a"] = "default"
broker._approval_profile["approval-a"] = "default"
broker._compression_profile["compression-a"] = "default"

broker.stop()
assert broker._stop.is_set()
assert worker.stopped
assert broker._workers == {}
assert broker._run_profile == {}
assert broker._running_run_profile == {}
assert broker._session_profile == {}
assert broker._approval_profile == {}
assert broker._compression_profile == {}

created = {}

class FakeProcess:
    stdout = None
    stderr = None

    def poll(self):
        return None

def fake_popen(args, **kwargs):
    created["args"] = args
    created["env"] = kwargs["env"]
    created["encoding"] = kwargs.get("encoding")
    created["errors"] = kwargs.get("errors")
    return FakeProcess()

original_popen = bridge.subprocess.Popen
original_getpid = bridge.os.getpid
try:
    bridge.subprocess.Popen = fake_popen
    bridge.os.getpid = lambda: 4242
    bridge.os.environ["ANTHROPIC_AUTH_TOKEN"] = "stale-bearer-token"
    proc_worker = bridge.WorkerProcess("default:compression:session-a", "default", "ipc:///tmp/worker.sock", "/agent", "/home")
    proc_worker._pipe_stderr = lambda: None
    proc_worker._wait_ready = lambda: None
    proc_worker.start()
finally:
    bridge.subprocess.Popen = original_popen
    bridge.os.getpid = original_getpid
    bridge.os.environ.pop("ANTHROPIC_AUTH_TOKEN", None)

assert created["env"]["HERMES_AGENT_BRIDGE_BROKER_PID"] == "4242"
assert created["env"]["HERMES_AGENT_BRIDGE_WORKER_PROFILE"] == "default"
assert "ANTHROPIC_AUTH_TOKEN" not in created["env"]
assert created["encoding"] == "utf-8"
assert created["errors"] == "replace"

stop_event = threading.Event()
seen_pids = []
original_process_exists = bridge._process_exists
try:
    bridge._process_exists = lambda pid: seen_pids.append(pid) and False
    bridge._start_parent_process_watchdog(12345, stop_event, "test", interval=0.01)
    assert wait_for(stop_event.is_set, timeout=2)
finally:
    bridge._process_exists = original_process_exists

assert seen_pids == [12345]
`)
  })

  it('handles broker ping while another broker request is blocked', () => {
    runPython(String.raw`
${harness}

class BlockingBroker(bridge.BridgeBroker):
    def handle(self, req):
        if req.get("action") == "block":
            time.sleep(0.4)
            return {"blocked": True}
        return super().handle(req)

class MemoryConn:
    def __init__(self, req):
        self.request = (json.dumps(req) + "\n").encode("utf-8")
        self.response = b""
        self.closed = False

    def recv(self, size):
        if not self.request:
            return b""
        chunk = self.request[:size]
        self.request = self.request[size:]
        return chunk

    def sendall(self, payload):
        self.response += payload

    def close(self):
        self.closed = True

broker = BlockingBroker("ipc:///tmp/unused.sock")
blocking_conn = MemoryConn({"action": "block"})
thread = threading.Thread(target=broker._handle_connection, args=(blocking_conn,))
thread.start()
time.sleep(0.05)

ping_conn = MemoryConn({"action": "ping"})
broker._handle_connection(ping_conn)
ping_resp = json.loads(ping_conn.response.decode("utf-8"))
assert ping_resp["ok"] is True, ping_resp
assert ping_resp["pong"] is True, ping_resp
assert ping_conn.closed is True, ping_conn.closed

thread.join(timeout=2)
assert not thread.is_alive(), blocking_conn.response
blocked_resp = json.loads(blocking_conn.response.decode("utf-8"))
assert blocked_resp["ok"] is True, blocked_resp
assert blocked_resp["blocked"] is True, blocked_resp
`)
  })

  it('extends profile worker request timeout from wait requests', () => {
    runPython(String.raw`
${harness}

broker = bridge.BridgeBroker("ipc:///tmp/unused.sock")
assert broker._worker_request_timeout({"action": "chat"}) == bridge.WorkerProcess.REQUEST_TIMEOUT_SECONDS
assert broker._worker_request_timeout({"action": "chat", "timeout": 60}) == bridge.WorkerProcess.REQUEST_TIMEOUT_SECONDS
assert broker._worker_request_timeout({"action": "chat", "timeout": 300}) == 310

captured = {}
worker = bridge.WorkerProcess("default", "default", "ipc:///tmp/worker.sock", None, None)
worker.start = lambda: None
original_send = bridge._send_bridge_request
try:
    def fake_send(endpoint, req, timeout):
        captured["endpoint"] = endpoint
        captured["req"] = req
        captured["timeout"] = timeout
        return {"ok": True}
    bridge._send_bridge_request = fake_send
    response = worker.request({"action": "chat"}, 310)
finally:
    bridge._send_bridge_request = original_send

assert response["ok"] is True, response
assert captured["endpoint"] == "ipc:///tmp/worker.sock", captured
assert captured["req"] == {"action": "chat"}, captured
assert captured["timeout"] == 310, captured
`)
  })

  it('awaits MCP server shutdown without holding the MCP registry lock', () => {
    runPython(String.raw`
${harness}

import asyncio

lock = threading.Lock()
servers = {}
events = []

class FakeMcpTask:
    async def shutdown(self):
        events.append("shutdown-started")
        acquired = lock.acquire(blocking=False)
        events.append(("lock-free-during-shutdown", acquired))
        if acquired:
            lock.release()
        await asyncio.sleep(0)
        events.append("shutdown-finished")

task = FakeMcpTask()
servers["github"] = task

def run_on_mcp_loop(factory, timeout=30):
    events.append(("timeout", timeout))
    asyncio.run(factory())

result = bridge.BridgeServer._shutdown_mcp_server(
    "github",
    servers,
    lock,
    run_on_mcp_loop,
)

assert result is True, result
assert "github" not in servers, servers
assert events == [
    ("timeout", 15),
    "shutdown-started",
    ("lock-free-during-shutdown", True),
    "shutdown-finished",
], events
`)
  })

  it('cleans worker background state and MCP servers before shutdown exits', () => {
    runPython(String.raw`
${harness}

events = []

class FakeBridgeServer(bridge.BridgeServer):
    def _shutdown_all_mcp_servers(self):
        events.append("mcp-shutdown")
        return 2

server = FakeBridgeServer("tcp://127.0.0.1:1")
response = server.handle({"action": "shutdown"})

assert response == {
    "status": "shutting_down",
    "cleanup": {
        "interrupted_sessions": 0,
        "interrupted_delegations": 0,
        "killed_processes": 0,
        "released_claims": 0,
        "mcp_servers": 2,
    },
}, response
assert events == ["mcp-shutdown"], events
assert server._stop.is_set(), "shutdown should stop worker after MCP shutdown"
`)
  })

  it('requests worker shutdown before terminating the worker process', () => {
    runPython(String.raw`
${harness}

events = []

class FakeProcess:
    def __init__(self):
        self.terminated = False

    def poll(self):
        return None

    def terminate(self):
        events.append("terminate")
        self.terminated = True

    def wait(self, timeout=None):
        events.append(("wait", timeout))

worker = bridge.WorkerProcess("default", "default", "tcp://127.0.0.1:1", None, None)
worker.process = FakeProcess()

def fake_request(req, timeout=None):
    events.append(("request", req, timeout))
    return {"status": "shutting_down"}

worker.request = fake_request
worker.stop()

assert events == [
    ("request", {"action": "shutdown"}, worker.SHUTDOWN_REQUEST_TIMEOUT_SECONDS),
    "terminate",
    ("wait", 3),
], events
`)
  })

  it('binds workspace cwd per running session without process-wide cwd state', () => {
    runPython(String.raw`
${harness}

class WorkspaceAgent:
    def __init__(self):
        self.seen = []

    def run_conversation(self, message, session_id=None, stream_callback=None, **kwargs):
        from agent.runtime_cwd import resolve_agent_cwd

        cwd = resolve_agent_cwd()
        self.seen.append((session_id, cwd))
        if stream_callback:
            stream_callback(cwd)
        time.sleep(0.05)
        return {"output": cwd}

pool, _fake_db = make_pool()
agent_a = WorkspaceAgent()
agent_b = WorkspaceAgent()

session_a, record_a, thread_a = start_manual_run(pool, "session-a", agent_a, "a", "/repo/a")
session_b, record_b, thread_b = start_manual_run(pool, "session-b", agent_b, "b", "/repo/b")

thread_a.join(timeout=2)
thread_b.join(timeout=2)
assert not thread_a.is_alive(), record_a.result
assert not thread_b.is_alive(), record_b.result

assert [cwd for _session_id, cwd in agent_a.seen] == ["/repo/a"], agent_a.seen
assert [cwd for _session_id, cwd in agent_b.seen] == ["/repo/b"], agent_b.seen
assert terminal_tool._task_env_overrides["session-a"] == {"cwd": "/repo/a"}, terminal_tool._task_env_overrides
assert terminal_tool._task_env_overrides["session-b"] == {"cwd": "/repo/b"}, terminal_tool._task_env_overrides
assert runtime_cwd.resolve_agent_cwd() == "", runtime_cwd.resolve_agent_cwd()
`)
  })
})
