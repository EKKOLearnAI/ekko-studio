import { expect, it } from 'vitest'
import { PluginCommandRegistry } from '../../packages/server/src/modules/studio/services/plugins/commands'
import { parseManifest } from '../../packages/server/src/modules/studio/services/plugins/validation'

const provider = { kind: 'plugin' as const, pluginId: 'test.native', generation: 'one', version: '1.0.0' }
const target = { ownerId: 'owner', sessionId: 'chat', instanceId: 'instance', instanceRevision: 2 }
const first = { id: 'test.native/inspect', name: 'inspect_state', description: 'Inspect' }

it('replaces catalogs atomically, preserves unchanged revisions, and separates identical IDs between chats', () => {
  const registry = new PluginCommandRegistry(), controller = new AbortController()
  const catalog = registry.runtime('profile', provider, 'native', target, async () => {}, () => {}, controller.signal)
  catalog.replace([first])
  const original = registry.list('profile', 'native', target)[0]
  catalog.replace([first])
  expect(registry.list('profile', 'native', target)[0]).toEqual(original)
  for (const invalid of [
    [first, first], [{ ...first, id: 'other.plugin/inspect' }], [{ ...first, agentTypeIds: ['foreign'] }],
    [{ ...first, aliases: [first.name] }], [{ ...first, ownerId: 'forged' }], Array.from({ length: 65 }, () => first),
  ]) {
    expect(() => catalog.replace(invalid)).toThrow()
    expect(registry.list('profile', 'native', target)).toEqual([original])
  }
  const other = { ...target, sessionId: 'other' }
  const second = registry.runtime('profile', provider, 'native', other, async () => {}, () => {}, controller.signal)
  second.replace([{ ...first, description: 'Other chat' }])
  expect(registry.list('profile', 'native', other)[0].description).toBe('Other chat')
  expect(() => registry.resolve('profile', 'native', first.id, original.revision, other)).toThrow('registration changed')
  expect(registry.list('other-profile', 'native', target)).toEqual([])
  expect(registry.list('profile', 'other-type', target)).toEqual([])
  catalog.replace([])
  expect(registry.list('profile', 'native', target)).toEqual([])
  expect(registry.list('profile', 'native', other)).toHaveLength(1)
  controller.abort()
  expect(registry.list('profile', 'native', other)).toEqual([])
  expect(() => second.replace([first])).toThrow('runtime ended')
})

it('requires a manifest declaration for owned Agent types and command registration permission', () => {
  const base = { schemaVersion: 1, id: 'test.native', version: '1.0.0', engines: { studioSdk: '^0.1.0', rpc: 1 }, backend: 'index.cjs', activation: 'profile',
    contributes: { agents: ['native'], runtimeCommands: ['native'] }, requires: { capabilities: ['agents.register', 'commands.register'] } }
  expect(parseManifest(base).contributes.runtimeCommands).toEqual(['native'])
  expect(() => parseManifest({ ...base, contributes: { ...base.contributes, runtimeCommands: ['foreign'] } })).toThrow()
  expect(() => parseManifest({ ...base, requires: { capabilities: ['agents.register'] } })).toThrow()
})

it('routes Unicode Skill command names without changing their native spelling', () => {
  const registry = new PluginCommandRegistry(), controller = new AbortController()
  const catalog = registry.runtime('profile', provider, 'native', target, async () => {}, () => {}, controller.signal)
  catalog.replace([{ ...first, name: '技能:检查', aliases: ['café.check'] }])
  const command = registry.list('profile', 'native', target)[0]
  expect(command).toMatchObject({ name: '技能:检查', aliases: ['café.check'], qualifiedName: 'test.native:技能:检查' })
  expect(registry.resolve('profile', 'native', command.id, command.revision, target).summary).toEqual(command)
  controller.abort()
})
