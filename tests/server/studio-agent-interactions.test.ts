import { afterEach, expect, it, vi } from 'vitest'
import { agentRunInteractions, respondAgentInteraction } from '../../packages/server/src/modules/studio/services/agents/interactions'

afterEach(() => vi.useRealTimers())
function setup(sessionId = 'session') {
  const controller = new AbortController(), events: any[] = []
  const interactions = agentRunInteractions({ sessionId, runId: 'run', signal: controller.signal, deadlineAt: Date.now() + 600_000, emit: (event, payload) => events.push({ event, ...payload }) })
  return { controller, events, interactions }
}

it('binds approval responses to the owning session and treats denial as a closed, unapproved request', async () => {
  const f = setup(), result = f.interactions.approve({ operationId: 'write', title: 'Write file', details: 'Write the selected file' })
  const id = f.events[0].approval_id
  expect(respondAgentInteraction('other', id, 'approval', 'once')).toEqual({ handled: true, resolved: false })
  expect(respondAgentInteraction('session', id, 'approval', 'always')).toEqual({ handled: true, resolved: false })
  expect(respondAgentInteraction('session', id, 'approval', 'deny')).toEqual({ handled: true, resolved: true })
  expect(await result).toEqual({ outcome: 'denied' })
  expect(f.events[1]).toMatchObject({ event: 'approval.resolved', resolved: true, outcome: 'denied', choice: 'deny' })
  expect(respondAgentInteraction('session', id, 'approval', 'once').resolved).toBe(false)
})

it('returns a positive approval only after an explicit authorized response', async () => {
  const f = setup(), result = f.interactions.approve({ operationId: 'write', title: 'Write file', details: 'Write selected file' })
  respondAgentInteraction('session', f.events[0].approval_id, 'approval', 'once')
  expect(await result).toEqual({ outcome: 'approved' })
})

it('distinguishes clarification answers, dismissal and cancellation and removes pending requests', async () => {
  const f = setup(), answer = f.interactions.clarify({ question: 'Which version?', choices: ['one', 'two'] })
  respondAgentInteraction('session', f.events[0].clarify_id, 'clarify', 'two')
  expect(await answer).toEqual({ outcome: 'answered', text: 'two' })
  const dismissed = f.interactions.clarify({ question: 'Any preference?' })
  respondAgentInteraction('session', f.events[2].clarify_id, 'clarify', '')
  expect(await dismissed).toEqual({ outcome: 'dismissed' })
  const canceled = f.interactions.clarify({ question: 'Continue?' }), id = f.events[4].clarify_id
  f.controller.abort(); expect(await canceled).toEqual({ outcome: 'cancelled' })
  expect(respondAgentInteraction('session', id, 'clarify', 'yes').resolved).toBe(false)
})

it('times out without granting approval and rejects invalid questions before publishing', async () => {
  vi.useFakeTimers()
  const f = setup(), approval = f.interactions.approve({ operationId: 'op', title: 'Execute', details: 'Execute selected operation' })
  await vi.advanceTimersByTimeAsync(300_000)
  expect(await approval).toEqual({ outcome: 'timeout' })
  await expect(f.interactions.clarify({ question: '', choices: [] })).rejects.toThrow('Invalid')
  expect(f.events).toHaveLength(2)
})
