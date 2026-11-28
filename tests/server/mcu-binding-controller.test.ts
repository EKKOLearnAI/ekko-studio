import { beforeEach, expect, it, vi } from 'vitest'
import type { Context } from 'koa'
import { McuBindingError } from '../../packages/server/src/modules/studio/contracts/mcu-session-bindings'
const fixture = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/devices/mcu-session-bindings', () => ({ readMcuBinding: fixture.read, writeMcuBinding: fixture.write }))
import { getMcuSessionBinding, putMcuSessionBinding, deleteMcuSessionBinding } from '../../packages/server/src/modules/studio/controllers/mcu-session-bindings'
function context(body: unknown = {}, user: unknown = { id: 1 }) {
  return { state: { user, profile: { name: 'bot-model-profile' } }, query: { device_code: 'physical-a' }, request: { body },
    get: (name: string) => name === 'x-hermes-profile' ? 'device-profile' : '', status: 200 } as unknown as Context
}
beforeEach(() => { vi.resetAllMocks(); fixture.read.mockResolvedValue({ revision: 0, binding: null }); fixture.write.mockResolvedValue({ revision: 1 }) })
it('uses authenticated account and explicit plugin Profile even when BOT middleware selected a different model Profile', async () => {
  const ctx = context({ device_code: 'physical-a', session_id: 'person-main-bot', kind: 'bot', expected_revision: 0 })
  await putMcuSessionBinding(ctx)
  expect(fixture.write).toHaveBeenCalledWith({ userId: 1, profile: 'device-profile', deviceCode: 'physical-a' }, 0, { sessionId: 'person-main-bot', kind: 'bot' })
})
it('returns offline scoped snapshots without mutating them', async () => {
  const ctx = context(); await getMcuSessionBinding(ctx)
  expect(ctx.body).toEqual({ revision: 0, binding: null }); expect(fixture.write).not.toHaveBeenCalled()
})
it.each([undefined, -1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1])('rejects invalid revision %s without reaching storage', async revision => {
  const ctx = context({ device_code: 'physical-a', expected_revision: revision })
  await deleteMcuSessionBinding(ctx)
  expect(ctx.status).toBe(400); expect(fixture.write).not.toHaveBeenCalled()
})
it.each([
  { device_code: 'physical-a', expected_revision: 0, user_id: 2 },
  { device_code: 'physical-a', expected_revision: 0, profile: 'someone-else' },
  { device_code: 'physical-a', expected_revision: 0, session_id: 'injected' },
  { device_code: ['physical-a'], expected_revision: 0 },
])('rejects owner, profile, target or device-shape injection', async body => {
  const ctx = context(body); await deleteMcuSessionBinding(ctx)
  expect(ctx.status).toBe(400); expect(fixture.write).not.toHaveBeenCalled()
})
it('preserves explicit revision when unbinding and returns busy/conflict without retry', async () => {
  fixture.write.mockRejectedValue(new McuBindingError('busy', 409, 'mcu_binding_busy'))
  const ctx = context({ device_code: 'physical-a', expected_revision: 3 }); await deleteMcuSessionBinding(ctx)
  expect(ctx.status).toBe(409); expect(fixture.write).toHaveBeenCalledTimes(1)
  expect(fixture.write).toHaveBeenCalledWith(expect.objectContaining({ userId: 1 }), 3, null)
})
it.each(['anonymous', 'share'])('rejects %s access without reading or writing owner metadata', async access => {
  const ctx = context({}, access === 'anonymous' ? null : { id: 1 })
  if (access === 'share') ctx.state.sessionShare = { fixture: true }
  await getMcuSessionBinding(ctx)
  expect(ctx.status).toBe(403); expect(fixture.read).not.toHaveBeenCalled()
})
