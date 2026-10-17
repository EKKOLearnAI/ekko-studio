import { execFileSync } from 'child_process'
import { describe, it } from 'vitest'

function runPython(script: string): void {
  try {
    execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', harness + script], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 10_000, stdio: 'pipe',
    })
  } catch (error) {
    const detail = error as { message?: string; stdout?: string; stderr?: string }
    throw new Error([detail.message, detail.stdout, detail.stderr].filter(Boolean).join('\n'))
  }
}

const harness = String.raw`
import sys
import threading
import time
import types
from pathlib import Path

sys.path.insert(0, str(Path('packages/server/src/modules/hermes/services/bridge/python').resolve()))
import bridge_pool
from bridge_pool import AgentPool, AgentSession

pool = AgentPool()
agent = types.SimpleNamespace(_interrupt_requested=False)
session = AgentSession('session-1', agent, current_run_id='run-1')
pool._sessions['session-1'] = session
events = []
responses = []
def publish(session_id, event):
    assert session_id == 'session-1'
    events.append(event)
    if event['event'] == 'clarify.requested' and responses:
        response = responses.pop(0)
        assert pool.respond_clarify(event['clarify_id'], response)['resolved']
pool._append_event = publish
callback = pool._clarify_callback('session-1')
questions = [
    {'qid': 'q0', 'question': 'Which branch?', 'choices': ['main (Recommended)', 'dev'], 'multi_select': False},
    {'qid': 'q1', 'question': 'Which directory?', 'choices': None, 'multi_select': False},
    {'qid': 'q2', 'question': 'Which checks?', 'choices': ['build', 'test'], 'multi_select': True},
]
`

describe('Hermes Python clarify callback contracts', () => {
  it('returns strings for two-argument and multi_select legacy calls', () => {
    runPython(String.raw`
responses[:] = ['main (Recommended)', 'custom/directory', '']
assert callback('Which branch?', ['main (Recommended)', 'dev']) == 'main (Recommended)'
assert callback('Which directory?', None, multi_select=False) == 'custom/directory'
assert callback('Skip?', None) == ''
assert [e['question'] for e in events] == ['Which branch?', 'Which directory?', 'Skip?']
assert not pool._clarify_requests
assert not pool.respond_clarify(events[0]['clarify_id'], 'late')['resolved']
`)
  })

  it('maps a modern batch to ordered Studio prompts and raw answers without modifying questions', () => {
    runPython(String.raw`
import copy
original = copy.deepcopy(questions)
responses[:] = ['main (Recommended)', '', '["build", "test"]']
result = callback(questions)
assert result == {'answers': {'q0': 'main (Recommended)', 'q1': None, 'q2': '["build", "test"]'}, 'outcome': 'submitted'}, result
assert questions == original
assert [e['question'] for e in events] == [q['question'] for q in questions]
assert events[0]['choices'] == questions[0]['choices']
assert events[2]['multi_select'] is True
assert all(0 < e['timeout_ms'] <= 300_000 for e in events)
assert not pool._clarify_requests
`)
  })

  it('preserves the pre-change keyword batch response contract', () => {
    runPython(String.raw`
import inspect
assert 'questions' in inspect.signature(callback).parameters
responses[:] = ['dev', '', 'test']
result = callback('Batch title', None, questions=questions)
assert result == {'answers': {'q0': 'dev', 'q1': None, 'q2': 'test'}, 'timed_out': False}, result
assert not pool._clarify_requests
`)
  })

  it('reports modern timeout as an outcome and keeps completed answers', () => {
    runPython(String.raw`
bridge_pool.CLARIFY_TIMEOUT_SECONDS = 0.1
responses[:] = ['dev']
result = callback(questions)
assert result == {'answers': {'q0': 'dev'}, 'outcome': 'timed_out'}, result
assert [e['question'] for e in events if e['event'] == 'clarify.requested'] == ['Which branch?', 'Which directory?']
assert events[-1]['event'] == 'clarify.resolved'
assert events[-1]['reason'] == 'timed_out'
assert not pool._clarify_requests
assert not pool.respond_clarify(events[-1]['clarify_id'], 'late')['resolved']
`)
  })

  it('uses the upstream sentinel for legacy single timeout and timed_out for legacy batches', () => {
    runPython(String.raw`
bridge_pool.CLARIFY_TIMEOUT_SECONDS = 0.1
tools = types.ModuleType('tools')
tools.clarify_tool = types.SimpleNamespace(TIMEOUT_RESPONSE='canonical timeout')
sys.modules['tools'] = tools
assert callback('No response?', None) == 'canonical timeout'
result = callback('', None, questions=questions)
assert result == {'answers': {}, 'timed_out': True}, result
assert not pool._clarify_requests
`)
  })

  it.each(['interrupt', 'destroy', 'replace-run'] as const)('settles a modern batch when the session is %s', reason => {
    runPython(String.raw`
result = []
responses[:] = ['dev']
thread = threading.Thread(target=lambda: result.append(callback(questions)))
thread.start()
deadline = time.monotonic() + 2
while len([e for e in events if e['event'] == 'clarify.requested']) < 2:
    assert time.monotonic() < deadline, events
    time.sleep(0.001)
` + (reason === 'interrupt'
      ? 'agent._interrupt_requested = True\n'
      : reason === 'destroy'
        ? "pool._sessions.pop('session-1')\n"
        : "session.current_run_id = 'run-2'\n") + String.raw`
thread.join(2)
assert not thread.is_alive()
assert result == [{'answers': {'q0': 'dev'}, 'outcome': 'cancelled'}], result
assert len([e for e in events if e['event'] == 'clarify.requested']) == 2
assert events[-1]['reason'] == 'cancelled'
assert not pool._clarify_requests
`)
  })

  it('does not display another prompt when already interrupted', () => {
    runPython(String.raw`
agent._interrupt_requested = True
assert callback(questions) == {'answers': {}, 'outcome': 'cancelled'}
assert events == []
assert not pool._clarify_requests
`)
  })

  it('cleans up a pending request when publishing the prompt fails', () => {
    runPython(String.raw`
def fail(*args):
    raise RuntimeError('publish failed')
pool._append_event = fail
try:
    callback(questions)
    raise AssertionError('expected publish failure')
except RuntimeError as error:
    assert str(error) == 'publish failed'
assert not pool._clarify_requests
`)
  })

  it('returns undelivered when the callback outlives its Studio session', () => {
    runPython(String.raw`
pool._sessions.pop('session-1')
result = callback(questions)
assert result['outcome'] == 'undelivered', result
assert result['answers'] == {}
assert result['notice']
legacy = callback('', None, questions=questions)
assert legacy['answers'] == {} and legacy['timed_out'] is True
assert legacy['notice']
assert callback('Old question', None) == ''
assert events == []
assert not pool._clarify_requests
`)
  })
})
