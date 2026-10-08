import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { beforeAll, describe, expect, it } from 'vitest'

// The clarify tool itself is Hermes code, not vendored here: drive the bridge callback through the
// installed hermes-agent so the test breaks when Hermes changes the callback contract again. CI sets
// HERMES_AGENT_ROOT to a checkout of hermes-agent; when it is set the suite must run, never skip.
const explicitAgentRoot = process.env.HERMES_AGENT_ROOT
const agentRoot = explicitAgentRoot || join(homedir(), '.hermes', 'hermes-agent')
const clarifyToolPath = join(agentRoot, 'tools', 'clarify_tool.py')

const harness = String.raw`
import json
import sys
import threading
import time

sys.path.insert(0, "packages/server/src/modules/hermes/services/bridge/python")
sys.path.insert(0, AGENT_ROOT)

import bridge_pool
from tools.clarify_tool import clarify_tool


def make_pool():
    pool = bridge_pool.AgentPool()
    session = bridge_pool.AgentSession(session_id="s1", agent=None, current_run_id="run-1")
    record = bridge_pool.RunRecord(run_id="run-1", session_id="s1")
    with pool._lock:
        pool._sessions["s1"] = session
        pool._runs["run-1"] = record
    return pool, record


def wait_for_request(record, timeout=5):
    deadline = time.time() + timeout
    while time.time() < deadline:
        for event in list(record.events):
            if event.get("event") == "clarify.requested":
                return event
        time.sleep(0.01)
    raise AssertionError("clarify.requested was never emitted")


def ask(pool, record, questions, respond):
    """Run the real clarify tool against the bridge callback and return (event, result)."""
    result = {}
    thread = threading.Thread(
        target=lambda: result.update(
            value=clarify_tool(questions, callback=pool._clarify_callback("s1"))),
        daemon=True)
    thread.start()
    event = wait_for_request(record)
    respond(event)
    thread.join(timeout=10)
    assert not thread.is_alive(), "clarify tool never returned"
    return event, json.loads(result["value"])
`

function runPython(script: string): Record<string, unknown> {
  const body = `AGENT_ROOT = ${JSON.stringify(agentRoot)}\n${harness}\n${script}`
  try {
    const stdout = execFileSync('python3', ['-c', body], {
      cwd: resolve('.'),
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    return JSON.parse(stdout.trim().split('\n').pop() || '{}')
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    throw new Error([
      err.message || 'clarify bridge script failed',
      err.stdout ? `stdout:\n${err.stdout}` : '',
      err.stderr ? `stderr:\n${err.stderr}` : '',
    ].filter(Boolean).join('\n\n'))
  }
}

describe.skipIf(!explicitAgentRoot && !existsSync(clarifyToolPath))('agent bridge clarify questions', { timeout: 30_000 }, () => {
  beforeAll(() => {
    expect(existsSync(clarifyToolPath), `HERMES_AGENT_ROOT is set but ${clarifyToolPath} is missing`).toBe(true)
  })

  it('asks every question and returns per-question answers to the clarify tool', () => {
    const probe = runPython(String.raw`
pool, record = make_pool()
questions = [
    {"question": "Which environment?", "choices": ["staging", "production"]},
    {"question": "Which checks?", "choices": ["unit", "e2e", "lint"], "multi_select": True},
    {"question": "Anything else?"},
]
event, result = ask(pool, record, questions, lambda ev: pool.respond_clarify(
    ev["clarify_id"], "", {"q0": "production", "q1": ["unit", "lint"], "q2": None}))
print(json.dumps({"event": event, "result": result}))
`)

    const event = probe.event as Record<string, unknown>
    expect(event.questions).toEqual([
      { qid: 'q0', question: 'Which environment?', choices: ['staging (Recommended)', 'production'], multi_select: false },
      { qid: 'q1', question: 'Which checks?', choices: ['unit (Recommended)', 'e2e', 'lint'], multi_select: true },
      { qid: 'q2', question: 'Anything else?', choices: null, multi_select: false },
    ])
    expect(event.question).toBe('1. Which environment?\n2. Which checks?\n3. Anything else?')
    expect(event.choices).toBeNull()

    expect(probe.result).toEqual({
      outcome: 'submitted',
      responses: [
        { question: 'Which environment?', choices_offered: ['staging', 'production'], status: 'answered', user_response: 'production' },
        { question: 'Which checks?', choices_offered: ['unit', 'e2e', 'lint'], status: 'answered', user_response: ['unit', 'lint'] },
        { question: 'Anything else?', choices_offered: null, status: 'skipped', user_response: null },
      ],
    })
  })

  it('reports a dismissed card as cancelled and an unanswered card as timed out', () => {
    const probe = runPython(String.raw`
pool, record = make_pool()
_event, dismissed = ask(pool, record, [{"question": "Ship it?", "choices": ["yes", "no"]}],
                        lambda ev: pool.respond_clarify(ev["clarify_id"], "", {"q0": None}))

bridge_pool.CLARIFY_TIMEOUT_MS = 200
pool2, record2 = make_pool()
_event2, expired = ask(pool2, record2, [{"question": "Still there?"}], lambda ev: None)
print(json.dumps({"dismissed": dismissed, "expired": expired}))
`)

    expect(probe.dismissed).toMatchObject({
      outcome: 'cancelled',
      notice: 'The user dismissed the clarification card.',
      responses: [{ status: 'skipped', user_response: null }],
    })
    expect(probe.expired).toMatchObject({
      outcome: 'timed_out',
      notice: 'No response within five minutes.',
      responses: [{ status: 'unanswered', user_response: null }],
    })
  })

  it('ignores answers for questions that were not asked and values the card cannot send', () => {
    const probe = runPython(String.raw`
questions = [
    {"question": "Which environment?", "choices": ["staging", "production"]},
    {"question": "Which checks?", "choices": ["unit", "e2e"], "multi_select": True},
    {"question": "Anything else?"},
]
results = {}
for name, answers in {
    "unknown_qid": {"zz": "x", "k1": "v"},
    "non_string": {"q0": {"evil": 1}, "q1": 42, "q2": True},
    "nested_list": {"q0": "production", "q1": [["unit"], {"y": 1}]},
    "oversized": {"q2": "x" * 9000},
}.items():
    pool, record = make_pool()
    _event, results[name] = ask(pool, record, questions,
                                lambda ev, answers=answers: pool.respond_clarify(ev["clarify_id"], "", answers))
print(json.dumps(results))
`)

    expect(probe.unknown_qid).toMatchObject({
      outcome: 'cancelled',
      notice: 'The user dismissed the clarification card.',
      responses: [{ status: 'unanswered' }, { status: 'unanswered' }, { status: 'unanswered' }],
    })

    expect(probe.non_string).toMatchObject({
      outcome: 'cancelled',
      responses: [
        { status: 'skipped', user_response: null },
        { status: 'skipped', user_response: null },
        { status: 'skipped', user_response: null },
      ],
    })

    expect(probe.nested_list).toMatchObject({
      outcome: 'submitted',
      responses: [
        { status: 'answered', user_response: 'production' },
        { status: 'skipped', user_response: null },
        { status: 'unanswered', user_response: null },
      ],
    })
    expect(probe.nested_list).not.toHaveProperty('notice')

    expect(probe.oversized).toMatchObject({
      outcome: 'submitted',
      responses: [
        { status: 'unanswered' },
        { status: 'unanswered' },
        { status: 'answered', user_response: 'x'.repeat(8000) },
      ],
    })
  })

  it('keeps the single-question event shape and the legacy (question, choices) call shape', () => {
    const probe = runPython(String.raw`
pool, record = make_pool()
event, result = ask(pool, record, [{"question": "Which environment?", "choices": ["staging", "production"]}],
                    lambda ev: pool.respond_clarify(ev["clarify_id"], "staging"))

pool2, record2 = make_pool()
legacy = {}
thread = threading.Thread(
    target=lambda: legacy.update(value=pool2._clarify_callback("s1")("Pick one", ["a", "b"])),
    daemon=True)
thread.start()
legacy_event = wait_for_request(record2)
pool2.respond_clarify(legacy_event["clarify_id"], "b")
thread.join(timeout=10)
print(json.dumps({"event": event, "result": result, "legacy_event": legacy_event, "legacy": legacy["value"]}))
`)

    const event = probe.event as Record<string, unknown>
    expect(event.question).toBe('Which environment?')
    expect(event.choices).toEqual(['staging (Recommended)', 'production'])
    expect(probe.result).toMatchObject({
      outcome: 'submitted',
      responses: [{ status: 'answered', user_response: 'staging' }],
    })

    const legacyEvent = probe.legacy_event as Record<string, unknown>
    expect(legacyEvent.question).toBe('Pick one')
    expect(legacyEvent.choices).toEqual(['a', 'b'])
    expect(legacyEvent.questions).toEqual([{ qid: 'q0', question: 'Pick one', choices: ['a', 'b'], multi_select: false }])
    expect(probe.legacy).toBe('b')
  })
})
