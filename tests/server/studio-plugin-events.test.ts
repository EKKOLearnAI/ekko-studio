import { expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  session: { id: 's', profile: 'work' } as any,
  storage: { getRoom: () => ({ ownerAuthUserId: 1 }), getMemberByAuthUserId: (_room: string, id: number) => id === 2 ? {} : undefined },
  privateAllowed: false,
}))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({ getSession: () => mocks.session }))
vi.mock('../../packages/server/src/modules/studio/services/group-chat/runtime', () => ({ getGroupChatRuntimeServer: () => ({ getStorage: () => mocks.storage }) }))
vi.mock('../../packages/server/src/modules/studio/services/webhooks/app-events', () => ({ appEventEnvelope: () => null, canReceiveAppEvent: () => mocks.privateAllowed }))
import { canReceivePluginEvent, pluginEventData } from '../../packages/server/src/modules/studio/services/plugins/events'
import { publishPluginObservation } from '../../packages/server/src/modules/studio/services/plugins/event-source'
import { businessEvents, type BusinessEvent } from '../../packages/server/src/modules/studio/services/webhooks/business-events'
const event = (patch: Partial<BusinessEvent> = {}): BusinessEvent => ({ schema_version: 1, id: 'e', type: 'chat.message.delta', profile: 'work', source: 'chat', occurred_at: new Date().toISOString(), subject: { session_id: 's' }, payload: {}, ...patch })
const user = (id: number) => ({ id, role: 'admin', profiles: ['work'] } as any)

it('projects normalized observations without forwarding credentials, raw content or internal metadata', () => {
  expect(pluginEventData(event({ payload: { delta: 'hello', content: 'raw private text', apiKey: 'secret', options: { token: 'secret' } } }))).toMatchObject({ type: 'chat.message.delta', delta: 'hello', subject: { session_id: 's' } })
  const projected = pluginEventData(event({ type: 'chat.tool.completed', payload: { content: 'internal', apiKey: 'secret' }, chat: { content: 'normalized', summary: { tool_name: 'search', status: 'completed' } } as any })) as any
  expect(projected.content).toBe('normalized'); expect(projected.summary.tool_name).toBe('search')
  expect(JSON.stringify(projected)).not.toMatch(/internal|secret/)
  expect(pluginEventData(event({ type: 'internal.secret' }))).toBeNull()
})
it('checks group readership separately from interaction ownership and retains private Person visibility', () => {
  const group = event({ source: 'group_chat', subject: { room_id: 'room' }, type: 'group.message.delta' })
  expect(canReceivePluginEvent(user(1), group)).toBe(true); expect(canReceivePluginEvent(user(2), group)).toBe(true)
  expect(canReceivePluginEvent(user(3), group)).toBe(false)
  expect(canReceivePluginEvent(user(2), { ...group, type: 'group.approval.requested' })).toBe(false)
  expect(canReceivePluginEvent(user(1), event({ subject: { session_id: 'person-task-hidden' } }))).toBe(false)
  expect(canReceivePluginEvent(user(1), event({ profile: 'other' }))).toBe(false)
  expect(canReceivePluginEvent(user(1), event({ type: 'chat.session.removed', payload: { owner_user_id: 1 } }))).toBe(true)
  expect(canReceivePluginEvent(user(2), event({ type: 'chat.session.removed', payload: { owner_user_id: 1 } }))).toBe(false)
})
it('publishes stream observations on the shared bus without enabling HTTP webhook delivery', () => {
  const received: BusinessEvent[] = [], stop = businessEvents.subscribe('plugin-source-test', e => { received.push(e) })
  try { publishPluginObservation('group.message.delta', 'work', 'group_chat', { room_id: 'r', message_id: 'm' }, { delta: 'text' }) }
  finally { stop() }
  expect(received[0]).toMatchObject({ type: 'group.message.delta', subject: { room_id: 'r', message_id: 'm' }, payload: { delta: 'text' } })
  expect(received[0]).not.toHaveProperty('chat')
  expect(pluginEventData(received[0])).toMatchObject({ delta: 'text' })
})
