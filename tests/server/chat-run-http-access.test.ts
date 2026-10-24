import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  enabled: vi.fn(), authenticate: vi.fn(), app: vi.fn(), access: vi.fn(), prepare: vi.fn(),
  refresh: vi.fn(), owner: vi.fn(), assertProfile: vi.fn(), watch: vi.fn(), push: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({
  isAuthEnabled: mocks.enabled, authenticateUserToken: mocks.authenticate, inspectAppUserToken: mocks.app,
}))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({ userCanAccessProfile: mocks.access }))
vi.mock('../../packages/server/src/modules/studio/services/session-shares/access', () => ({
  prepareSessionShareRun: mocks.prepare, refreshSessionShare: mocks.refresh, sessionShareExecutionUser: mocks.owner,
  assertShareProfile: mocks.assertProfile, watchSessionShare: mocks.watch,
}))
vi.mock('../../packages/server/src/modules/studio/services/notifications/push-registration', () => ({ authenticatedPushActor: mocks.push }))
import { runChatHttpRequest } from '../../packages/server/src/modules/studio/services/chat-run/http'
import type { DirectChatRunOptions } from '../../packages/server/src/modules/studio/services/chat-run/direct'

const user = { id: 42, username: 'owner', role: 'user' as const }
const scope = { token: 'token', profile: 'default' }
const request = { input: 'hello', session_id: 'session' }
function port() {
  return { startDirectRun: vi.fn((_payload: unknown, options: DirectChatRunOptions) => {
    options.onEvent('run.completed', {})
    return { dispose: vi.fn(), dropQueued: vi.fn() }
  }) }
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.enabled.mockResolvedValue(true)
  mocks.authenticate.mockResolvedValue(user)
  mocks.app.mockResolvedValue(null)
  mocks.access.mockReturnValue(true)
  mocks.owner.mockReturnValue(user)
  mocks.refresh.mockResolvedValue(undefined)
  mocks.watch.mockReturnValue(vi.fn())
})

describe('HTTP direct chat authorization', () => {
  it('snapshots nested input and response options before authentication yields', async () => {
    let release!: () => void
    mocks.enabled.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = () => resolve(true) }))
    const body = { ...request, input: [{ type: 'text', text: 'original' }], include_events: true }
    const server = port()
    const result = runChatHttpRequest(body, scope, server)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    body.input[0].text = 'changed'
    body.include_events = false
    release()
    expect((await result).body.events).toHaveLength(1)
    expect(server.startDirectRun.mock.calls[0][0]).toMatchObject({ input: [{ text: 'original' }] })
  })
  it('fails closed when the execution host is unavailable', async () => {
    expect(await runChatHttpRequest(request, scope, null)).toMatchObject({ status: 503, body: { error: 'Chat run service is unavailable' } })
  })
  it.each(['user', 'profile', 'device'])('rejects invalid %s before execution', async failure => {
    if (failure === 'user') mocks.authenticate.mockResolvedValue(null)
    if (failure === 'profile') mocks.access.mockReturnValue(false)
    if (failure === 'device') { mocks.enabled.mockResolvedValue(false); mocks.app.mockResolvedValue({ status: 'revoked' }) }
    const server = port()
    expect((await runChatHttpRequest(request, scope, server)).status).toBe(503)
    expect(server.startDirectRun).not.toHaveBeenCalled()
  })
  it('supplies identity and device binding from authentication, never request metadata', async () => {
    mocks.app.mockResolvedValue({ status: 'active', user, deviceCode: 'phone' })
    const server = port()
    await runChatHttpRequest({ ...request, user: { id: 999 }, mobileDeviceTarget: { deviceCode: 'spoof' }, onEvent: 'spoof' }, scope, server)
    expect(server.startDirectRun).toHaveBeenCalledWith(expect.not.objectContaining({ onEvent: 'spoof' }), expect.objectContaining({
      user, mobileDeviceTarget: { deviceCode: 'phone', userId: '42', profile: 'default', platform: 'unknown' },
    }))
    await server.startDirectRun.mock.calls[0][1].pushActor()
    expect(mocks.push).toHaveBeenCalledWith('token')
  })
  it('uses the share owner, refreshes input permission, and preserves server-derived run configuration', async () => {
    const share = { token: 'share-token' } as any
    mocks.prepare.mockImplementation((_share, data) => {
      for (const key of Object.keys(data)) delete data[key]
      Object.assign(data, { session_id: 'session', input: 'shared', source: 'cli', profile: 'default' })
    })
    const server = port()
    const result = await runChatHttpRequest({ ...request, profile: 'untrusted', timeout_ms: 500, include_events: true }, { ...scope, share }, server)
    expect(result.status).toBe(200)
    expect(result.body.events).toHaveLength(1)
    expect(mocks.refresh).toHaveBeenCalledWith(share, 'input', 'session')
    expect(server.startDirectRun).toHaveBeenCalledWith(expect.objectContaining({ input: 'shared', profile: 'default' }), expect.objectContaining({ shared: true, user }))
    await server.startDirectRun.mock.calls[0][1].reauthorize!()
    expect(mocks.refresh).toHaveBeenCalledTimes(2)
    expect(mocks.authenticate).not.toHaveBeenCalled()
  })
  it('stops shared delivery and rejects delayed dispatch after revocation', async () => {
    let invalidate = () => {}
    mocks.watch.mockImplementation((_share, _action, callback) => { invalidate = callback; return vi.fn() })
    let options: DirectChatRunOptions
    const handle = { dispose: vi.fn(), dropQueued: vi.fn() }
    const server = { startDirectRun: vi.fn((_payload: unknown, supplied: DirectChatRunOptions) => {
      options = supplied
      supplied.onEvent('message.delta', { delta: 'private' })
      queueMicrotask(invalidate)
      return handle
    }) }
    const result = await runChatHttpRequest(request, { ...scope, share: {} as any }, server)
    expect(result).toMatchObject({ status: 403, body: { output: '', error: 'share_access_denied' } })
    expect(handle.dispose).toHaveBeenCalledOnce()
    expect(handle.dropQueued).toHaveBeenCalledOnce()
    await expect(options!.reauthorize!()).rejects.toThrow('share_access_denied')
  })
})
