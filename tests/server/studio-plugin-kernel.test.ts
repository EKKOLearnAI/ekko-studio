import { describe, expect, it, vi } from 'vitest'
import { AgentRegistry } from '../../packages/server/src/modules/studio/services/agents/registry'
import { ResourceScope } from '../../packages/server/src/modules/studio/services/plugins/resources'
import { parseManifest } from '../../packages/server/src/modules/studio/services/plugins/validation'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import type { AgentTypeDefinition, ExecutionScope, PluginManifest } from '../../packages/studio-plugin-sdk/src'

const provider = (generation: string) => ({ kind: 'plugin' as const, pluginId: 'test.echo', version: '1.0.0', generation })
const definition: AgentTypeDefinition = {
  id: 'test.echo/assistant', name: 'Echo', configSchema: { type: 'object' },
  capabilities: { text: true, modes: ['scoped'] },
  create: async () => ({ run: async () => { throw new Error('unused') }, dispose: async () => {} }),
}
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const scope: ExecutionScope = { scopeId: 'scope', principal: { id: '1', kind: 'user' }, profileId: 'one', surface: 'api', traceId: 'trace' }
const context = (signal: AbortSignal, authorize = vi.fn(async () => {})) => createExecutionContext(scope, signal, logger, {
  authorize, agents: { list: async () => [] }, sessions: { get: async id => ({ id, profileId: 'one', title: null, agentTypeId: 'test.echo/assistant', archived: false }) },
})

describe('Studio plugin contracts and registry', () => {
  it('publishes registrations atomically and does not revoke a new generation during old cleanup', () => {
    const registry = new AgentRegistry()
    const old = registry.stage('one', provider('old'), [definition.id])
    old.register(definition)
    expect(registry.list('one')).toEqual([])
    old.commit()
    expect(registry.list('two')).toEqual([])
    const next = registry.stage('one', provider('new'), [definition.id])
    next.register(definition)
    next.commit()
    old.dispose()
    expect(registry.resolve('one', definition.id).provider).toEqual(provider('new'))
    next.dispose()
    expect(registry.list('one')).toEqual([])
  })

  it('rejects collisions before publishing any staged entries', () => {
    const registry = new AgentRegistry()
    const existing = registry.stage('*', { kind: 'builtin', module: 'ekko', implementationVersion: '1' }, ['ekko'])
    existing.register({ ...definition, id: 'ekko' })
    existing.commit()
    const attempt = registry.stage('one', provider('x'), [definition.id, 'ekko'])
    attempt.register(definition)
    attempt.register({ ...definition, id: 'ekko' })
    expect(() => attempt.commit()).toThrow('already belongs')
    expect(registry.list('one').map(item => item.id)).toEqual(['ekko'])
  })

  it('rejects incompatible manifests, traversal, undeclared properties and schemas', () => {
    const manifest: PluginManifest = {
      schemaVersion: 1, id: 'test.echo', version: '1.0.0', engines: { studioSdk: '^0.1.0', rpc: 1 },
      backend: 'index.cjs', activation: 'profile', contributes: { agents: [definition.id] }, requires: { capabilities: ['agents.register'] },
    }
    expect(parseManifest(manifest)).toEqual(manifest)
    expect(() => parseManifest({ ...manifest, backend: '../index.cjs' })).toThrow('relative path')
    expect(() => parseManifest({ ...manifest, removable: false })).toThrow('manifest')
    expect(() => parseManifest({ ...manifest, engines: { studioSdk: '^2.0.0', rpc: 1 } })).toThrow('different Studio SDK')
    expect(() => parseManifest({ ...manifest, configSchema: { madeUpKeyword: true } })).toThrow('schema')
  })
})

describe('Studio context and resource lifetime', () => {
  it('binds run reads to the supplied execution scope and rechecks authorization', async () => {
    const authorize = vi.fn(async () => {}), output = vi.fn(async () => [])
    const controller = new AbortController()
    const ctx = createExecutionContext({ ...scope, runId: 'current' }, controller.signal, logger, {
      authorize, sessions: { get: async () => null }, agents: { list: async () => [] },
      runs: { get: async () => { throw new Error('unused') }, output },
    })
    await expect(ctx.runs.output('other')).rejects.toThrow('outside')
    expect(output).not.toHaveBeenCalled()
    await ctx.runs.output('current', 3)
    expect(output).toHaveBeenCalledWith(expect.objectContaining({ principal: scope.principal, profileId: 'one' }), 'current', 3)
    authorize.mockRejectedValueOnce(new Error('revoked'))
    await expect(ctx.runs.output('current')).rejects.toThrow('revoked')
    expect(output).toHaveBeenCalledOnce()
  })

  it('checks authorization on every call and rejects expired scopes', async () => {
    const controller = new AbortController()
    const authorize = vi.fn(async () => {})
    const ctx = context(controller.signal, authorize)
    await ctx.sessions.get('session')
    authorize.mockRejectedValueOnce(new Error('revoked'))
    await expect(ctx.sessions.get('session')).rejects.toThrow('revoked')
    controller.abort()
    await expect(ctx.agents.list()).rejects.toThrow('ended')
    expect(authorize).toHaveBeenCalledTimes(2)
    expect(Object.isFrozen(ctx.scope.principal)).toBe(true)
  })

  it('cleans up once in reverse order even when one disposer fails', async () => {
    const errors = vi.fn(), order: number[] = []
    const resources = new ResourceScope(errors)
    const first = resources.add(() => { order.push(1) })
    resources.add(() => { order.push(2); throw new Error('failed') })
    resources.add(() => { order.push(3) })
    await resources.close()
    await resources.close()
    await first()
    expect(order).toEqual([3, 2, 1])
    expect(errors).toHaveBeenCalledOnce()
    expect(resources.signal.aborted).toBe(true)
  })
})

describe('Plugin event notifications', () => {
  const event = (sequence: number) => ({ schemaVersion: 1 as const, id: `${sequence}`, type: 'run.completed', occurredAt: 1,
    partitionKey: 'session', sequence, subject: { profileId: 'one', runId: 'run' }, data: { runId: 'run' }, correlationId: 'trace' })

  it('preserves partition order, isolates profile access and atomically claims once', async () => {
    const bus = new PluginEventBus()
    const values: number[] = [], once = vi.fn(), other = vi.fn()
    const subscriptionScope = { profileId: 'one', context: async (_event: unknown, signal: AbortSignal) => context(signal) }
    bus.subscribe('run.completed', subscriptionScope, async e => { await Promise.resolve(); values.push(e.sequence) })
    bus.subscribe('run.completed', subscriptionScope, once, true)
    bus.subscribe('run.completed', { ...subscriptionScope, profileId: 'two' }, other)
    bus.publish(event(1)); bus.publish(event(2)); await bus.idle()
    expect(values).toEqual([1, 2]); expect(once).toHaveBeenCalledOnce(); expect(other).not.toHaveBeenCalled()
    bus.close()
  })

  it('bounds slow subscribers and does not propagate callback failures', async () => {
    const errors = vi.fn(), callback = vi.fn()
    const bus = new PluginEventBus({ maxPending: 1, onError: errors })
    bus.subscribe('run.completed', { profileId: 'one', context: async (_event, signal) => context(signal) }, callback)
    bus.publish(event(1)); bus.publish(event(2)); await bus.idle(); await Promise.resolve()
    expect(errors).toHaveBeenCalledOnce(); expect(callback).not.toHaveBeenCalled()
  })

  it('does not consume once on an unauthorized event', async () => {
    const callback = vi.fn(), errors = vi.fn()
    const bus = new PluginEventBus({ onError: errors })
    bus.subscribe('run.completed', { profileId: 'one', context: async (event, signal) => {
      if (event.sequence === 1) throw new Error('Not visible')
      return context(signal)
    } }, callback, true)
    bus.publish(event(1)); bus.publish(event(2)); bus.publish(event(3))
    await bus.idle()
    expect(callback).toHaveBeenCalledOnce()
    expect(callback.mock.calls[0][0].sequence).toBe(2)
    expect(errors).toHaveBeenCalledOnce()
  })
})
