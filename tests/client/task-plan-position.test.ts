import assert from 'node:assert/strict'
import { it as test } from 'vitest'
import { positionTaskPlansAtTurnEnd as position } from '@/utils/task-plan'
import type { TaskPlanSnapshot } from '@/utils/task-plan'
import type { Message } from '@/stores/hermes/chat'

const snapshot = (runId: string, createdAt = 20): TaskPlanSnapshot => ({
  session_id: 's', run_id: runId, plan_id: runId, revision: 1,
  execution_state: 'running', created_at: createdAt, updated_at: createdAt,
  plan: [{ id: 'a', step: 'Check', status: 'in_progress' }],
})
const message = (id: string, role: Message['role'], timestamp: number, runId?: string): Message => ({ id, role, content: id, timestamp, runMarker: runId })
const card = (runId: string, createdAt: number) => ({ ...message(`plan-${runId}`, 'system', createdAt, runId), taskPlan: snapshot(runId, createdAt) })
const ids = (messages: Message[]) => position(messages).map(message => message.id)

test('a plan follows new output without requiring another plan update or mutating source order', () => {
  const p = card('r1', 20)
  const source = [message('u', 'user', 10), p, message('a', 'assistant', 30, 'r1')]
  assert.deepEqual(ids(source), ['u', 'a', 'plan-r1'])
  source.push(message('tool', 'tool', 40, 'r1'), message('final', 'assistant', 50, 'r1'))
  assert.deepEqual(ids(source), ['u', 'a', 'tool', 'final', 'plan-r1'])
  assert.equal(source[1], p)
  assert.equal(position(source).at(-1), p)
})

test('completed, interrupted and failed plans remain at their own turn end', () => {
  for (const state of ['ended', 'interrupted', 'failed'] as const) {
    const p = card('r1', 20)
    p.taskPlan.execution_state = state
    p.taskPlan.updated_at = 1000
    assert.deepEqual(ids([message('u1', 'user', 10), p, message('a1', 'assistant', 30, 'r1'), message('u2', 'user', 40), card('r2', 50), message('a2', 'assistant', 60, 'r2')]), ['u1', 'a1', 'plan-r1', 'u2', 'a2', 'plan-r2'])
  }
})

test('legacy history without run markers uses creation time and stops at the next user or command', () => {
  for (const role of ['user', 'command'] as const) {
    assert.deepEqual(ids([card('r1', 20), message('u1', 'user', 10), message('a1', 'assistant', 30), message('next', role, 40), message('a2', 'assistant', 60)]), ['u1', 'a1', 'plan-r1', 'next', 'a2'])
  }
})

test('includes unmarked trailing output but does not cross into a different marked run', () => {
  assert.deepEqual(ids([message('u', 'user', 10), card('r1', 20), message('t', 'tool', 30, 'r1'), message('a', 'assistant', 40), message('next', 'assistant', 50, 'r2')]), ['u', 't', 'a', 'plan-r1', 'next'])
})

test('explicit run IDs keep ongoing work together across user steering messages', () => {
  assert.deepEqual(ids([message('u', 'user', 10), card('r1', 20), message('a', 'assistant', 30, 'r1'), message('steer', 'user', 40), message('final', 'assistant', 50, 'r1')]), ['u', 'a', 'steer', 'final', 'plan-r1'])
})

test('pagination restores older plan placement and replayed source order renders identically', () => {
  const older = card('older', 5)
  const recent = [older, message('u', 'user', 10), card('r1', 20), message('a', 'assistant', 30, 'r1')]
  assert.deepEqual(ids(recent), ['plan-older', 'u', 'a', 'plan-r1'])
  const loaded = [message('old-u', 'user', 1), message('old-a', 'assistant', 8, 'older'), ...recent]
  assert.deepEqual(ids(loaded), ['old-u', 'old-a', 'plan-older', 'u', 'a', 'plan-r1'])
  assert.deepEqual(ids(position(loaded)), ids(loaded))
})

test('hundreds of turns keep all cards with their own output and retain message identity', () => {
  const source: Message[] = [], expected: string[] = []
  for (let n = 0; n < 500; n++) {
    const r = `r${n}`
    source.push(message(`u${n}`, 'user', n * 10), card(r, n * 10 + 1), message(`a${n}`, 'assistant', n * 10 + 2, r))
    expected.push(`u${n}`, `a${n}`, `plan-${r}`)
  }
  assert.deepEqual(ids(source), expected)
  const withoutPlans = source.filter(message => !message.taskPlan)
  assert.equal(position(withoutPlans), withoutPlans)
})
