import { expect, it } from 'vitest'
import { CommandExecutionScopes } from '../../packages/server/src/modules/studio/services/commands/scopes'
import type { CommandCall } from '../../packages/server/src/modules/studio/repositories/plugin-command-store'
import type { ExecutionScope } from '../../packages/studio-plugin-sdk/src'

const scope: ExecutionScope = { scopeId: 'call', principal: { kind: 'user', id: '7' }, profileId: 'one', sessionId: 'chat', surface: 'chat', traceId: 'trace' }
const call: CommandCall = { id: 'call', ownerId: '7', profileId: 'one', sessionId: 'chat', commandId: 'test.commands/native', inputMessageId: 42, status: 'running', results: [], errorCode: null }
it('keeps provenance private across host context reconstruction and revokes it with the command lifetime', () => {
  const scopes = new CommandExecutionScopes(), controller = new AbortController()
  const target = { instanceId: 'instance', instanceRevision: 2 }
  scopes.bind(scope, call, controller.signal, target)
  target.instanceRevision = 9
  const reconstructed = JSON.parse(JSON.stringify(scope))
  expect(reconstructed).not.toHaveProperty('commandOrigin')
  expect(scopes.origin(reconstructed, { instanceId: 'instance', instanceRevision: 2 })).toEqual({ callId: 'call', messageId: 42 })
  for (const changed of [{ principal: { kind: 'user' as const, id: '8' } }, { profileId: 'two' }, { sessionId: 'other-chat' },
    { runId: 'parent' }, { workspaceId: 'other' }, { surface: 'event' as const }, { traceId: 'forged' }]) {
    expect(() => scopes.origin({ ...reconstructed, ...changed }, { instanceId: 'instance', instanceRevision: 2 })).toThrow(/execution scope/)
  }
  expect(() => scopes.origin(scope, { instanceId: 'instance', instanceRevision: 3 })).toThrow(/configuration changed/)
  expect(() => scopes.origin(scope, { instanceId: 'other', instanceRevision: 2 })).toThrow(/configuration changed/)
  controller.abort()
  expect(scopes.origin(scope)).toBeUndefined()
  expect(() => scopes.bind(scope, call, controller.signal)).toThrow(/ended/)
})

it('refuses receipt identity mismatches and never derives provenance from a caller-supplied scope field', () => {
  const scopes = new CommandExecutionScopes(), signal = new AbortController().signal
  for (const changed of [{ ownerId: '8' }, { profileId: 'two' }, { sessionId: 'other-chat' }, { id: 'other-call' }]) {
    expect(() => scopes.bind(scope, { ...call, ...changed }, signal)).toThrow(/receipt/)
  }
  expect(scopes.origin({ ...scope, commandOrigin: { callId: 'call', messageId: 42 } } as ExecutionScope)).toBeUndefined()
})
