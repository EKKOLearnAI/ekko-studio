import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'

function runPython(script: string): any {
  try {
    const output = execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    return JSON.parse(output.trim().split('\n').pop() as string)
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    throw new Error([
      err.message || 'Python bridge clarify script failed',
      err.stdout ? `stdout:\n${err.stdout}` : '',
      err.stderr ? `stderr:\n${err.stderr}` : '',
    ].filter(Boolean).join('\n\n'))
  }
}

// bridge_pool imports a large surface of bridge_runtime at module load and pulls in
// agent-side helpers on use. Both are stubbed so the clarify callback can be exercised
// in isolation: it is pure plumbing between `clarify_tool`'s batch contract and the
// event stream, which is exactly what regressed.
const PRELUDE = String.raw`
import importlib.util
import json
import queue
import sys
import types

def _stub_runtime():
    rt = types.ModuleType("bridge_runtime")
    rt.APPROVAL_TIMEOUT_MS = 120_000
    rt.APPROVAL_TIMEOUT_SECONDS = 120
    # Mirrors the real module: the event's timeout_ms and the wait derive from ONE pair.
    rt.CLARIFY_TIMEOUT_SECONDS = 300
    rt.CLARIFY_TIMEOUT_MS = 300_000
    rt._approval_pattern_keys = lambda *a, **k: []
    rt._base_hermes_home = lambda: "/tmp"
    rt._bridge_platform = lambda: "studio"
    rt._install_execute_code_approval_memory_patch = lambda *a, **k: None
    rt._jsonable = lambda value: value
    rt._load_cfg = lambda: {}
    rt._load_disabled_toolsets = lambda: None
    rt._load_enabled_toolsets = lambda: None
    rt._load_fallback_model = lambda: None
    rt._load_reasoning_config = lambda *a, **k: None
    rt._load_service_tier = lambda: None
    rt._load_model_catalog = lambda *a, **k: {}
    rt._resolve_runtime = lambda *a, **k: {}
    rt._ensure_agent_imports = lambda: None
    return rt

sys.modules["bridge_runtime"] = _stub_runtime()

def load_pool():
    spec = importlib.util.spec_from_file_location(
        "bridge_pool",
        "packages/server/src/modules/hermes/services/bridge/python/bridge_pool.py",
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    # dataclass() resolves annotations through sys.modules[cls.__module__]; without this
    # registration every @dataclass in the module raises on a NoneType.
    sys.modules["bridge_pool"] = mod
    spec.loader.exec_module(mod)
    return mod

pool_mod = load_pool()

def make_pool(session_id="sess-1"):
    """A pool whose events are captured instead of written, bound to one live session."""
    pool = pool_mod.AgentPool()
    events = []
    pool._append_event = lambda sid, event: events.append((sid, event))
    if session_id is not None:
        session = pool_mod.AgentSession(session_id, None)
        session.current_run_id = "run-1"
        pool._sessions[session_id] = session
    return pool, events
`

describe('bridge clarify callback honours the batch contract', () => {
  it('answers a list of questions keyed by qid', () => {
    const result = runPython(PRELUDE + String.raw`
pool, events = make_pool()
pool._ask_clarify_question = lambda sid, q, c: ("answer:" + str(q), True, False)

cb = pool._clarify_callback("sess-1")
reply = cb([
    {"qid": "q0", "question": "First?"},
    {"qid": "q1", "question": "Second?", "choices": ["a", "b"]},
])
asked = [e["question"] for _, e in events if e["event"] == "clarify.requested"]
print(json.dumps({"reply": reply, "asked": asked}))
`)
    expect(result.reply.outcome).toBe('submitted')
    expect(result.reply.answers).toEqual({ q0: 'answer:First?', q1: 'answer:Second?' })
    // The card must receive the question TEXT, not the normalized list's repr.
    expect(result.asked).toEqual(['First?', 'Second?'])
  })

  it('coerces a bare-string entry instead of reporting a silent skip', () => {
    const result = runPython(PRELUDE + String.raw`
pool, events = make_pool()
pool._ask_clarify_question = lambda sid, q, c: ("ok:" + str(q), True, False)
reply = pool._clarify_callback("sess-1")(["plain question"])
print(json.dumps({"reply": reply}))
`)
    expect(result.reply.outcome).toBe('submitted')
    expect(result.reply.answers).toEqual({ q0: 'ok:plain question' })
  })

  it('stops the batch at a question the user never answered', () => {
    const result = runPython(PRELUDE + String.raw`
pool, events = make_pool()
calls = {"n": 0}
def ask(sid, q, c):
    calls["n"] += 1
    return ("", False, False)  # timeout on the first question
pool._ask_clarify_question = ask
reply = pool._clarify_callback("sess-1")([
    {"qid": "q0", "question": "First?"},
    {"qid": "q1", "question": "Second?"},
])
print(json.dumps({"reply": reply, "calls": calls["n"]}))
`)
    expect(result.reply.outcome).toBe('timed_out')
    expect(result.reply.answers).toEqual({})
    // Gateway parity: a skipped question must not be followed by more cards.
    expect(result.calls).toBe(1)
  })

  it('locks a dismissed (blank) answer as skipped but keeps the batch going', () => {
    const result = runPython(PRELUDE + String.raw`
pool, events = make_pool()
answers = {"q0": "", "q1": "second"}
pool._ask_clarify_question = lambda sid, q, c: (answers.pop(list(answers.keys())[0]), True, False)
reply = pool._clarify_callback("sess-1")([
    {"qid": "q0", "question": "First?"},
    {"qid": "q1", "question": "Second?"},
])
print(json.dumps({"reply": reply}))
`)
    // A blank response is the surface's dismiss/skip, not a timeout.
    expect(result.reply.outcome).toBe('submitted')
    expect(result.reply.answers.q0).toBeNull()
    expect(result.reply.answers.q1).toBe('second')
  })

  it('reports undelivered when no client is attached', () => {
    const result = runPython(PRELUDE + String.raw`
pool, events = make_pool()
pool._ask_clarify_question = lambda sid, q, c: ("", False, True)
reply = pool._clarify_callback("sess-1")([{"qid": "q0", "question": "Anybody?"}])
print(json.dumps({"reply": reply}))
`)
    expect(result.reply.outcome).toBe('undelivered')
  })

  it('reports undelivered for an empty question list', () => {
    const result = runPython(PRELUDE + String.raw`
pool, events = make_pool()
reply = pool._clarify_callback("sess-1")([])
print(json.dumps({"reply": reply}))
`)
    expect(result.reply.outcome).toBe('undelivered')
    expect(result.reply.answers).toEqual({})
  })
})

describe('bridge clarify question emits resolved events and a single timeout source', () => {
  it('publishes clarify.requested with the shared timeout and a resolved follow-up', () => {
    const result = runPython(PRELUDE + String.raw`
import bridge_runtime as rt
pool, events = make_pool()

# Answer the card from another thread the moment it is published, so the wait is short
# but the code path (queue -> answered -> resolved) is the real one.
def answer(_sid, event):
    events.append((_sid, event))
    if event.get("event") == "clarify.requested":
        pool._clarify_requests[event["clarify_id"]].put("my answer")
pool._append_event = answer

response, answered, undelivered = pool._ask_clarify_question("sess-1", "Pick one", ["x", "y"])
req = next(e for _, e in events if e["event"] == "clarify.requested")
res = next((e for _, e in events if e["event"] == "clarify.resolved"), None)

print(json.dumps({
    "response": response,
    "answered": answered,
    "undelivered": undelivered,
    "req_timeout_ms": req["timeout_ms"],
    "rt_timeout_ms": rt.CLARIFY_TIMEOUT_MS,
    "req_choices": req["choices"],
    "req_run_id": req["run_id"],
    "resolved": res,
}))
`)
    expect(result.answered).toBe(true)
    expect(result.undelivered).toBe(false)
    expect(result.response).toBe('my answer')
    // The published timeout and the wait must come from the same constant pair.
    expect(result.req_timeout_ms).toBe(result.rt_timeout_ms)
    expect(result.req_choices).toEqual(['x', 'y'])
    expect(result.req_run_id).toBe('run-1')
    expect(result.resolved.reason).toBe('response')
  })

  it('marks a timed-out card as resolved with reason=timeout', () => {
    const result = runPython(PRELUDE + String.raw`
import bridge_runtime as rt
rt.CLARIFY_TIMEOUT_SECONDS = 0.05  # keep the test fast; constant, not a magic number
pool, events = make_pool()
response, answered, undelivered = pool._ask_clarify_question("sess-1", "Anyone?", None)
res = next((e for _, e in events if e["event"] == "clarify.resolved"), None)
print(json.dumps({"answered": answered, "resolved": res}))
`)
    expect(result.answered).toBe(false)
    // A timeout must retire the card, or it keeps looking answerable.
    expect(result.resolved.resolved).toBe(true)
    expect(result.resolved.reason).toBe('timeout')
  })
})
