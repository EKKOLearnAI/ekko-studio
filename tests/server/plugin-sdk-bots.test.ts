import { expect, it, vi } from 'vitest'
import { createHostApi } from '../../packages/plugin-sdk/src'

it('groups BOT operations under one host module and connects through the shared live protocol', async () => {
  const request = vi.fn(async () => null), connect = vi.fn(async () => ({ sessionId: 'person-main-bot' }) as any)
  const host = createHostApi(request, undefined, connect)
  await host.bots.create({ title: 'Assistant', bot_type: 'zhezhe' })
  await host.bots.configure('person-main-bot', { expected_revision: 3, workspace: '/work' })
  await host.bots.tasks.send('task/1', { expected_revision: 2, input: 'continue' })
  await host.bots.flows.messages('flow/1', { before_id: 5 })
  await host.bots.schedules.apply({ action: 'pause', id: 'schedule', expected_revision: 4 })
  await host.bots.memory.forget('memory', 6)
  await host.bots.remove('person-main-bot', 7)
  expect(request.mock.calls).toEqual([
    ['/api/studio/person/conversations', { method: 'POST', body: { title: 'Assistant', bot_type: 'zhezhe' } }],
    ['/api/studio/person/settings', { method: 'PUT', body: { expected_revision: 3, workspace: '/work', session_id: 'person-main-bot' } }],
    ['/api/studio/person/tasks/task%2F1/chat', { method: 'POST', body: { expected_revision: 2, input: 'continue' } }],
    ['/api/studio/person/flows/flow%2F1/messages', { query: { before_id: 5 } }],
    ['/api/studio/person/schedules/apply', { method: 'POST', body: { action: 'pause', id: 'schedule', expected_revision: 4 } }],
    ['/api/studio/person/memory', { method: 'POST', body: { id: 'memory', expected_revision: 6, forget: true } }],
    ['/api/studio/person/conversations/person-main-bot', { method: 'DELETE', body: { expected_history_revision: 7 } }],
  ])
  const listener = vi.fn()
  await host.bots.connect('person-main-bot', listener)
  expect(connect).toHaveBeenCalledWith('person-main-bot', listener, 'bot')
  await host.sessions.connect('chat', listener)
  expect(connect).toHaveBeenCalledWith('chat', listener, 'chat')
})
