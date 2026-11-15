import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentRuntime, AgentToolRegistry } from '../../packages/ekko-agent/src'
import type { ModelClient } from '../../packages/ekko-agent/src/model/types'
import { normalizeAgentMessage } from '../../packages/ekko-agent/src/model/messages'
import { PluginRuntime } from '../../packages/server/src/modules/studio/services/plugins/runtime'
import { PluginStore } from '../../packages/server/src/modules/studio/services/plugins/store'
import { pluginRunHooks } from '../../packages/server/src/modules/studio/services/plugins/integration'

const host = vi.hoisted(() => ({ runtime: undefined as PluginRuntime | undefined }))
vi.mock('../../packages/server/src/modules/studio/services/plugins/host', () => ({
  getPluginManager: () => ({
    hasHooks: (_identity: unknown, hook: string) => !!host.runtime?.hooks.get(hook as any)?.length,
    transform: (identity: any, hook: any, value: any, signal?: AbortSignal) => host.runtime!.transform(hook, value, identity, signal),
  }),
}))
const identity = { userId: 1, profile: 'default', runtime: 'ekko-agent' }
const homes: string[] = []
afterEach(async () => {
  await host.runtime?.close()
  host.runtime = undefined
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
async function install(handler: (value: any) => any) {
  const home = mkdtempSync(join(tmpdir(), 'ekko-context-hook-')); homes.push(home)
  const runtime = new PluginRuntime({ directory: home, source: home, enabled: true, config: {}, installedAt: 0,
    manifest: { id: 'fixture', name: 'Fixture', version: '1.0.0', apiVersion: 1, server: 'server.mjs', permissions: ['hooks'] } },
    identity, new PluginStore(home), { authorize() {}, api: async () => null, emit() {}, log() {} })
  await runtime.load({ apply(ctx) { ctx.extensions.hooks.register('context.transform', handler) } })
  runtime.activate(); host.runtime = runtime
}
it('delivers host-constructed messages to an identity context hook before a model request', async () => {
  const callback = vi.fn(async value => ({ value }))
  await install(callback)
  const requests: any[] = []
  const client: ModelClient = { provider: 'fixture', requestStyle: 'custom-runtime',
    capabilities: { streaming: false, tools: true, vision: false, jsonMode: false, systemPrompt: true },
    create: async request => { requests.push(request.messages); return { content: 'answer', finishReason: 'stop' } },
    async *stream() { throw new Error('Unexpected stream') },
  }
  const input = normalizeAgentMessage({ role: 'user', content: 'hello' })
  expect(Object.hasOwn(input, 'reasoning')).toBe(true)
  expect(input.reasoning).toBeUndefined()
  const runtime = new AgentRuntime({ tools: new AgentToolRegistry(), skillsEnabled: false })
  const result = await runtime.run({
    messages: [input], modelClient: client, memoryEnabled: false, toolContext: pluginRunHooks(identity),
  })
  expect(callback).toHaveBeenCalled()
  expect(requests).toHaveLength(1)
  expect(requests[0]).toContainEqual({ role: 'user', content: 'hello' })
  expect(result.output.content).toBe('answer')
  await runtime.run({ messages: [...result.messages, normalizeAgentMessage({ role: 'user', content: 'next turn' })], modelClient: client, memoryEnabled: false, toolContext: pluginRunHooks(identity) })
  expect(requests).toHaveLength(2)
  expect(requests[1]).toContainEqual({ role: 'assistant', content: 'answer' })
  expect(Object.hasOwn(input, 'reasoning')).toBe(true)
})

it('omits nested optional host object fields without mutating the original context', async () => {
  const callback = vi.fn(async value => ({ value }))
  await install(callback)
  const message = { role: 'assistant', content: 'hello', reasoning: { text: undefined, native: { format: 'openai-responses-items', data: [{ optional: undefined, text: 'kept' }] } } }
  const result = await pluginRunHooks(identity).transformContext([message])
  expect(result).toEqual([{ role: 'assistant', content: 'hello', reasoning: { native: { format: 'openai-responses-items', data: [{ text: 'kept' }] } } }])
  expect(Object.hasOwn(message.reasoning, 'text')).toBe(true)
  expect(Object.hasOwn(message.reasoning.native.data[0], 'optional')).toBe(true)
})

function invalidValues() {
  const cyclic: any = {}; cyclic.self = cyclic
  const accessor = Object.defineProperty({}, 'optional', { enumerable: true, get() { throw new Error('getter must not execute') } })
  const hidden = Object.defineProperty({}, 'optional', { value: undefined })
  const symbol = { [Symbol('optional')]: undefined }
  const extraArray: any = [1]; extraArray.extra = undefined
  const deep: any = {}; let nested = deep
  for (let index = 0; index < 34; index++) nested = nested.child = {}
  return [NaN, Infinity, () => {}, BigInt(1), cyclic, new Date(), new Uint8Array([1]),
    [undefined], new Array(1), accessor, hidden, symbol, extraArray, deep, 'a'.repeat(2_000_000)]
}

it('still rejects non-JSON host data, undefined array slots, sparse arrays and accessors before the hook', async () => {
  const callback = vi.fn(async value => ({ value }))
  await install(callback)
  for (const invalid of invalidValues()) {
    await expect(pluginRunHooks(identity).transformContext([{ role: 'user', content: 'hello', extra: invalid }])).rejects.toMatchObject({ code: typeof invalid === 'string' ? 'PLUGIN_INVALID' : 'PLUGIN_SCHEMA' })
  }
  expect(callback).not.toHaveBeenCalled()
})

it('keeps strict validation on plugin-returned data including undefined object fields', async () => {
  let output: any
  const callback = vi.fn(async value => { value[0].extra = output; return { value } })
  await install(callback)
  for (const invalid of [undefined, ...invalidValues()]) {
    output = invalid
    await expect(pluginRunHooks(identity).transformContext([{ role: 'user', content: 'hello', reasoning: undefined }])).rejects.toMatchObject({ code: typeof invalid === 'string' ? 'PLUGIN_INVALID' : 'PLUGIN_SCHEMA' })
  }
  expect(callback).toHaveBeenCalledTimes(1 + invalidValues().length)
})

it('keeps the HookResult envelope requirement rather than accepting a raw identity return', async () => {
  await install(async value => value)
  await expect(pluginRunHooks(identity).transformContext([{ role: 'user', content: 'hello' }])).rejects.toThrow()
})

it('preserves plugin edits and denial without exposing host object references', async () => {
  await install(async value => { value[0].content = 'edited'; return { value } })
  const input = [{ role: 'user', content: 'original', reasoning: undefined }]
  expect(await pluginRunHooks(identity).transformContext(input)).toEqual([{ role: 'user', content: 'edited' }])
  expect(input[0].content).toBe('original')
  host.runtime!.hooks.get('context.transform')![0].handler = async () => ({ deny: 'blocked' })
  await expect(pluginRunHooks(identity).transformContext(input)).rejects.toThrow('blocked')
})

it('leaves disabled hooks and other hook input validation unchanged', async () => {
  const input = [normalizeAgentMessage({ role: 'user', content: 'hello' })]
  expect(await pluginRunHooks(identity).transformContext(input)).toBe(input)
  await install(async value => ({ value }))
  host.runtime!.context().extensions.hooks.register('input.transform', async value => ({ value }))
  await expect(pluginRunHooks(identity).transformInput(input)).rejects.toMatchObject({ code: 'PLUGIN_SCHEMA' })
})

it('preserves valid nulls, shared references and plain null-prototype host data', async () => {
  await install(async value => ({ value }))
  const shared = Object.assign(Object.create(null), { text: 'kept', optional: undefined })
  Object.defineProperty(shared, '__proto__', { value: 'data', enumerable: true })
  const extra = { first: shared, second: shared, empty: null }
  const messages = [{ role: 'user', content: 'hello', extra }]
  const transformed = await pluginRunHooks(identity).transformContext(messages)
  expect(transformed[0].extra).toEqual({ first: { text: 'kept', ['__proto__']: 'data' }, second: { text: 'kept', ['__proto__']: 'data' }, empty: null })
  expect(Object.hasOwn(shared, 'optional')).toBe(true)
})
