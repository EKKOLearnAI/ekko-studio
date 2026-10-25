import { expect, it, vi } from 'vitest'
import type { ExecutionScope } from '../../packages/studio-plugin-sdk/src'
import { createChatRunInvocation } from '../../packages/server/src/modules/studio/services/chat-run/invocation'

function fixture() {
  const scope: ExecutionScope = { scopeId: 'scope', traceId: 'trace', surface: 'api', profileId: 'default',
    principal: { kind: 'user', id: '42' }, sessionId: 'session' }
  const controller = new AbortController()
  const options = { profile: 'default', user: { id: 42, username: 'owner', role: 'user' as const },
    context: { scope, signal: controller.signal },
    mobileDeviceTarget: { deviceCode: 'phone', userId: '42', profile: 'default' },
    pushActor: async () => null, onEvent: vi.fn(), reauthorize: vi.fn(async () => {}) }
  const request = { session_id: 'session', input: [{ type: 'text' as const, text: 'original' }],
    mcpServers: { fixture: { args: ['original'] } } }
  return { scope, controller, options, request }
}

it('copies nested input, principal, device and callbacks before asynchronous admission', async () => {
  const { scope, request, options } = fixture()
  const authorize = options.reauthorize
  const invocation = createChatRunInvocation(request, options)
  request.input[0].text = 'changed'
  request.mcpServers.fixture.args.push('changed')
  request.session_id = 'other'
  options.user.id = 99
  options.mobileDeviceTarget.deviceCode = 'other'
  options.reauthorize = vi.fn(async () => { throw new Error('replaced callback') })
  ;(scope.principal as { id: string }).id = '99'
  await invocation.options.reauthorize()
  expect(invocation.data).toMatchObject({ session_id: 'session', input: [{ text: 'original' }], mcpServers: { fixture: { args: ['original'] } } })
  expect(invocation.options).toMatchObject({ user: { id: 42 }, mobileDeviceTarget: { deviceCode: 'phone' } })
  expect(invocation.scope).toMatchObject({ principal: { id: '42' }, sessionId: 'session' })
  expect(Object.isFrozen(invocation.scope)).toBe(true)
  expect(Object.isFrozen(invocation.scope.principal)).toBe(true)
  expect(authorize).toHaveBeenCalledOnce()
})

it.each(['session', 'profile', 'principal', 'kind', 'payload-profile'])('rejects a mismatched %s binding', field => {
  const { scope, request, options } = fixture()
  const modified = { ...scope, principal: { ...scope.principal } }
  if (field === 'session') modified.sessionId = 'other'
  if (field === 'profile') modified.profileId = 'other'
  if (field === 'principal') modified.principal.id = '99'
  if (field === 'kind') modified.principal.kind = 'service'
  expect(() => createChatRunInvocation({ ...request, ...(field === 'payload-profile' ? { profile: 'other' } : {}) }, {
    ...options, context: { ...options.context, scope: modified },
  })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
})

it.each(['workspaceId', 'runId'])('does not discard an unsupported %s binding', key => {
  const { scope, request, options } = fixture()
  expect(() => createChatRunInvocation(request, { ...options, context: { ...options.context, scope: { ...scope, [key]: 'bound' } } }))
    .toThrow(expect.objectContaining({ code: 'CAPABILITY_UNSUPPORTED' }))
})

it('narrows an unbound context and supplies the bound session when omitted', () => {
  const { scope, request, options } = fixture()
  expect(createChatRunInvocation({ input: 'hello' }, options).data.session_id).toBe('session')
  const unbound = { ...scope, sessionId: undefined }
  const invocation = createChatRunInvocation(request, { ...options, context: { ...options.context, scope: unbound } })
  expect(invocation.scope.sessionId).toBe('session')
  expect(unbound.sessionId).toBeUndefined()
})

it('derives legacy identity from the trusted adapter and never from payload metadata', () => {
  const { request, options } = fixture()
  const { context: _context, ...entry } = options
  const invocation = createChatRunInvocation({ ...request, principal: { id: '999' }, context: { scope: { profileId: 'other' } } } as any, entry)
  expect(invocation.scope).toMatchObject({ profileId: 'default', principal: { kind: 'user', id: '42' } })
  expect(createChatRunInvocation(request, { ...entry, user: undefined }).scope.principal).toMatchObject({ kind: 'service' })
})

it('rejects cancellation before authorization without consulting the authorizer', async () => {
  const { request, options, controller } = fixture()
  const invocation = createChatRunInvocation(request, options)
  controller.abort()
  await expect(invocation.options.reauthorize()).rejects.toMatchObject({ code: 'CANCELLED' })
  expect(options.reauthorize).not.toHaveBeenCalled()
})

it('rejects cancellation while authorization is pending', async () => {
  const { request, options, controller } = fixture()
  let release!: () => void
  options.reauthorize.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
  const invocation = createChatRunInvocation(request, options)
  const pending = invocation.options.reauthorize()
  controller.abort(); release()
  await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
})

it('keeps admitted queue work alive after scope end but still rejects revoked authorization', async () => {
  const { request, options, controller } = fixture()
  const invocation = createChatRunInvocation(request, options)
  await invocation.options.reauthorize()
  controller.abort()
  await invocation.options.reauthorize()
  options.reauthorize.mockRejectedValueOnce(new Error('revoked'))
  await expect(invocation.options.reauthorize()).rejects.toThrow('revoked')
  expect(options.reauthorize).toHaveBeenCalledTimes(3)
})
