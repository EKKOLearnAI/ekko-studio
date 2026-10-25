import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ManagedMcpScope } from '../../packages/server/src/modules/studio/services/mcp/managed'
import { parseMcpPage, parseMcpPrompt, parseMcpResource } from '../../packages/server/src/modules/studio/services/mcp/read-contract'
import { StudioError } from '../../packages/studio-plugin-sdk/src'

const close: Array<() => Promise<void>> = []
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn() })
async function setup(mode = 'full') {
  const root = await mkdtemp(join(tmpdir(), 'mcp-content-中文 ')), trace = join(root, 'trace'), controller = new AbortController()
  let allowed = true
  const scope = new ManagedMcpScope(controller.signal, () => { if (!allowed) throw new StudioError('FORBIDDEN', 'Revoked') })
  close.push(() => rm(root, { recursive: true, force: true }), () => scope.close())
  const connection = await scope.api.connect({ type: 'stdio', command: process.execPath, args: [resolve('tests/fixtures/mcp-content-server.cjs')], cwd: root,
    env: { TRACE_FILE: trace, CONTENT_MODE: mode } })
  return { scope, connection, controller, revoke: () => { allowed = false }, trace: async () => (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) }
}

it('shares one native connection across tools, paged resources, templates and prompts', async () => {
  const f = await setup(), first = await f.connection.listResources()
  expect(first).toEqual({ items: [{ uri: 'fixture://one', name: 'Local resource' }], nextCursor: 'next' })
  expect(await f.connection.listResources(first.nextCursor)).toEqual({ items: [{ uri: 'fixture://two', name: 'Local resource' }] })
  expect(await f.connection.listResourceTemplates()).toEqual({ items: [{ name: 'Item', uriTemplate: 'fixture://item/{id}' }] })
  expect(await f.connection.readResource('fixture://one')).toEqual([{ uri: 'fixture://one', text: '中文 resource' }])
  expect(await f.connection.readResource('fixture://blob')).toEqual([{ uri: 'fixture://blob', mimeType: 'application/octet-stream', blob: 'aGk=' }])
  expect(await f.connection.listPrompts()).toEqual({ items: [{ name: 'greeting', description: 'Local prompt', arguments: [{ name: 'whom', required: true }] }] })
  const args = { whom: '中文' }
  const prompt = await f.connection.getPrompt('greeting', args)
  expect(prompt.messages).toEqual([{ role: 'user', content: { type: 'text', text: 'Hello 中文' } }, { role: 'assistant', content: { type: 'resource', resource: { uri: 'fixture://prompt', text: 'Context' } } }])
  expect(args).toEqual({ whom: '中文' })
  const trace = await f.trace()
  expect(trace.filter(item => item.method === 'initialize')).toHaveLength(1)
  expect(trace.filter(item => item.method === 'resources/list').map(item => item.params)).toEqual([{}, { cursor: 'next' }])
  expect(new Set(trace.map(item => item.pid)).size).toBe(1)
  expect(await f.connection.callTool('fake_pid', {})).toMatchObject({ ok: true })
})

it('distinguishes a missing advertised capability from an empty content directory', async () => {
  const f = await setup('unsupported')
  await expect(f.connection.listResources()).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  await expect(f.connection.listPrompts()).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  expect((await f.trace()).some(item => item.method === 'resources/list' || item.method === 'prompts/list')).toBe(false)
  expect(await f.connection.callTool('fake_echo', { text: 'still works' })).toMatchObject({ content: 'mcp:still works' })
})

it('rejects invalid request fields before sending resource or prompt requests', async () => {
  const f = await setup()
  expect(() => f.connection.listResources('')).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  expect(() => f.connection.readResource('bad\0uri')).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  expect(() => f.connection.getPrompt('greeting', { nested: {} } as never)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  expect((await f.trace()).some(item => item.method.startsWith('resources/') || item.method.startsWith('prompts/'))).toBe(false)
})

it('bounds resource data before it crosses the worker boundary', async () => {
  const f = await setup('oversize')
  await expect(f.connection.readResource('fixture://large')).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' })
})

it.each(['cancel', 'revoke'])('ends pending content reads on %s and reaps the owned process', async reason => {
  const f = await setup('hang'), pending = f.connection.readResource('fixture://pending')
  // Revocation ends the entire connection scope before the transport rejects
  // its pending request, so both paths report the closed scope.
  const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
  await vi.waitFor(async () => expect((await f.trace()).some(item => item.method === 'resources/read')).toBe(true))
  if (reason === 'cancel') f.controller.abort(); else f.revoke()
  await rejected; await f.scope.close()
  const pid = (await f.trace())[0].pid
  expect(() => process.kill(pid, 0)).toThrow()
})

it('rejects ambiguous binary content, duplicate IDs and unsupported prompt content', () => {
  expect(() => parseMcpResource({ contents: [{ uri: 'fixture://one', text: 'text', blob: 'aGk=' }] })).toThrow()
  expect(() => parseMcpResource({ contents: [{ uri: 'fixture://one', blob: 'not-base64' }] })).toThrow()
  expect(() => parseMcpPage({ resources: [{ uri: 'fixture://one', name: 'One' }, { uri: 'fixture://one', name: 'Two' }] }, 'resources')).toThrow()
  expect(() => parseMcpPrompt({ messages: [{ role: 'user', content: { type: 'unknown' } }] })).toThrow(expect.objectContaining({ code: 'CAPABILITY_UNSUPPORTED' }))
})
