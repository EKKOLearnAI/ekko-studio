import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ run: vi.fn(), auth: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/terminal/realtime-command', () => ({ runRealtimeCommand: mocks.run }))
vi.mock('../../packages/server/src/modules/studio/middleware/auth', () => ({ isAuthEnabled: mocks.auth }))
import { terminalCommand } from '../../packages/server/src/modules/studio/controllers/realtime-agent'

function context(body: unknown, role = 'super_admin') {
  return { request: { body }, state: { user: { role } }, res: new EventEmitter(), status: 200, body: undefined as unknown }
}
describe('realtime direct terminal controller', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue(true); mocks.run.mockResolvedValue({ ok: true, stdout: 'ok' }) })
  it('runs structured arguments without an agent and removes disconnect listener', async () => {
    const ctx = context({ command: 'printf', args: ['%s', '$(whoami); echo hi'] })
    await terminalCommand(ctx)
    expect(mocks.run).toHaveBeenCalledWith('printf', ['%s', '$(whoami); echo hi'], expect.any(AbortSignal))
    expect(ctx.body).toEqual({ ok: true, stdout: 'ok' })
    expect(ctx.res.listenerCount('close')).toBe(0)
  })
  it('denies non-super-admin access before spawning', async () => {
    const ctx = context({ command: 'ls', args: [] }, 'admin')
    await terminalCommand(ctx)
    expect(ctx.status).toBe(403)
    expect(mocks.run).not.toHaveBeenCalled()
  })
  it.each([{ command: '' }, { command: 'ls', args: '-a' }, { command: 'ls', args: [null] }])('rejects malformed input %j', async body => {
    const ctx = context(body)
    await terminalCommand(ctx)
    expect(ctx.status).toBe(400)
    expect(mocks.run).not.toHaveBeenCalled()
  })
})
