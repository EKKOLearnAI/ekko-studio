import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentRuntimeContext, ModelGatewayHandle } from '../../packages/studio-plugin-sdk/src'
import { createZcodeRelay } from '../../plugins/zcode/src/relay'
import { prepareZcode } from '../../plugins/zcode/src/configuration'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function upstream(mode = 'success') {
  const calls: any[] = []
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk
    calls.push({ url: request.url, headers: request.headers, body: JSON.parse(text) })
    if (mode === 'hold') return
    if (mode === 'redirect') { response.writeHead(307, { location: '/escape' }).end(); return }
    response.setHeader('content-type', 'application/json'); response.end('{"ok":true}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
  return { calls, gateway: { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/lease/fixture/v1`, token: 'host-lease-secret', model: 'pinned-model', protocol: 'anthropic', images: true, dispose: async () => {} } as ModelGatewayHandle }
}

it.each(['https://127.0.0.1:1/v1', 'http://example.com/v1', 'http://user:password@127.0.0.1:1/v1', 'http://127.0.0.1:1/v1?target=other'])('rejects an invalid gateway %s before listening', async baseUrl => {
  await expect(createZcodeRelay({ baseUrl } as ModelGatewayHandle, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
})

it('authenticates native callers and pins method, path, model and upstream lease', async () => {
  const u = await upstream(), relay = await createZcodeRelay(u.gateway, new AbortController().signal)
  cleanups.push(relay.dispose)
  const post = (path = '/messages', key = relay.key, model = 'pinned-model', method = 'POST') => fetch(relay.baseUrl + path, { method, headers: { 'x-api-key': key, 'content-type': 'application/json', 'x-secret-native-header': 'must-not-forward' }, ...(method === 'POST' ? { body: JSON.stringify({ model, messages: [] }) } : {}) })
  expect((await post('/messages', 'wrong')).status).toBe(401)
  expect((await post('/messages', relay.key, 'foreign-model')).status).toBe(400)
  expect((await post('/../escape')).status).toBe(404)
  expect((await post('/messages?target=/escape')).status).toBe(404)
  expect((await post('/messages', relay.key, 'pinned-model', 'GET')).status).toBe(404)
  expect(u.calls).toHaveLength(0)
  expect(await (await post()).json()).toEqual({ ok: true })
  expect(u.calls).toHaveLength(1)
  expect(u.calls[0]).toMatchObject({ url: '/lease/fixture/v1/messages', body: { model: 'pinned-model' }, headers: { authorization: 'Bearer host-lease-secret', 'x-api-key': 'host-lease-secret' } })
  expect(u.calls[0].headers['x-secret-native-header']).toBeUndefined()
  expect(relay.key).not.toBe(u.gateway.token)
  await relay.dispose(); await expect(post()).rejects.toThrow()
})

it('refuses redirects without making a second request', async () => {
  const u = await upstream('redirect'), relay = await createZcodeRelay(u.gateway, new AbortController().signal)
  cleanups.push(relay.dispose)
  const response = await fetch(relay.baseUrl + '/messages', { method: 'POST', headers: { 'x-api-key': relay.key }, body: JSON.stringify({ model: 'pinned-model' }) })
  expect(response.status).toBe(502); expect(u.calls).toHaveLength(1)
})

it('bounds concurrent requests and cancels pending upstream work with the Run', async () => {
  const u = await upstream('hold'), controller = new AbortController(), relay = await createZcodeRelay(u.gateway, controller.signal)
  cleanups.push(relay.dispose)
  const post = () => fetch(relay.baseUrl + '/messages', { method: 'POST', headers: { 'x-api-key': relay.key }, body: JSON.stringify({ model: 'pinned-model' }) })
  const work = Array.from({ length: 4 }, post), settled = Promise.allSettled(work)
  await vi.waitFor(() => expect(u.calls).toHaveLength(4))
  expect((await post()).status).toBe(429)
  controller.abort(); await settled; await relay.dispose()
  await expect(post()).rejects.toThrow()
})

it('rejects an oversized native request before forwarding it', async () => {
  const u = await upstream(), relay = await createZcodeRelay(u.gateway, new AbortController().signal)
  cleanups.push(relay.dispose)
  const response = await fetch(relay.baseUrl + '/messages', { method: 'POST', headers: { 'x-api-key': relay.key }, body: JSON.stringify({ model: 'pinned-model', text: 'x'.repeat(10 * 1024 * 1024) }) })
  expect(response.status).toBe(413); expect(u.calls).toHaveLength(0)
})

it('keeps the host bearer out of native files and revokes temporary credentials after cleanup', async () => {
  const u = await upstream(), root = await mkdtemp(join(tmpdir(), 'studio-zcode-configuration-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const runtime = { stateDirectory: join(root, 'state'), runtimeSessionId: 'fixture' } as AgentRuntimeContext
  const config = { cwd: root, command: 'zcode', env: { HOME: root } }
  const nativeDirectory = join(runtime.stateDirectory!, 'home', '.zcode', 'cli')
  await mkdir(nativeDirectory, { recursive: true })
  const original = JSON.stringify({ mcp: { servers: { same: { type: 'stdio', command: 'native-command' }, disabled: { type: 'stdio', command: 'disabled-command', enabled: false } } } })
  await writeFile(join(nativeDirectory, 'config.json'), original)
  const prepared = await prepareZcode({ mcpServers: { same: { command: 'managed-command', env: { ELECTRON_RUN_AS_NODE: '1' } }, remote: { type: 'sse', url: 'http://127.0.0.1:1/sse' } } }, config, 'scoped', runtime, new AbortController().signal, u.gateway)
  cleanups.push(prepared.dispose)
  const path = prepared.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, content = await readFile(path, 'utf8'), provider = JSON.parse(content).config.providerConfigRules.providerRules[0].config
  expect(content).not.toContain('host-lease-secret')
  expect(provider.access.apiKey).toHaveLength(64)
  expect(prepared.mcpServers).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'same', command: 'managed-command', env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }] }), expect.objectContaining({ name: 'remote', type: 'sse' })]))
  expect(prepared.mcpServers.some(server => server.name === 'disabled')).toBe(false)
  if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect(await readFile(join(nativeDirectory, 'config.json'), 'utf8')).toBe(original)
  const post = () => fetch(provider.api.baseUrl + '/messages', { method: 'POST', headers: { 'x-api-key': provider.access.apiKey }, body: JSON.stringify({ model: 'pinned-model' }) })
  expect((await post()).status).toBe(200)
  await prepared.dispose(); await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' }); await expect(post()).rejects.toThrow()
})

it('preserves native-only MCP discovery and refuses to discard a custom working directory during injection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-zcode-cwd-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const runtime = { stateDirectory: join(root, 'state'), runtimeSessionId: 'fixture' } as AgentRuntimeContext
  await mkdir(join(root, '.zcode', 'cli'), { recursive: true })
  const original = JSON.stringify({ mcp: { servers: { custom: { type: 'stdio', command: 'native-command', cwd: 'other-directory' } } } })
  const file = join(root, '.zcode', 'cli', 'config.json'); await writeFile(file, original)
  const config = { cwd: root, command: 'zcode', env: { HOME: root } }
  const native = await prepareZcode({}, config, 'global', runtime, new AbortController().signal)
  expect(native.mcpServers).toEqual([])
  await native.dispose()
  await expect(prepareZcode({ mcpServers: { managed: { command: 'managed' } } }, config, 'global', runtime, new AbortController().signal)).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  expect(await readFile(file, 'utf8')).toBe(original)
})

it('merges worktree ancestor MCP then user and managed definitions while retaining native disabled entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-zcode-ancestry-')), cwd = join(root, 'project', 'nested'), home = join(root, 'home')
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  await Promise.all([mkdir(join(root, '.git')), mkdir(cwd, { recursive: true }), mkdir(join(home, '.zcode', 'cli'), { recursive: true })])
  await writeFile(join(root, 'zcode.json'), JSON.stringify({ mcp: { servers: { ancestor: { type: 'http', url: 'http://127.0.0.1:1/ancestor' }, same: { type: 'http', url: 'http://127.0.0.1:1/project' } } } }))
  await writeFile(join(home, '.zcode', 'cli', 'config.json'), JSON.stringify({ mcp: { servers: { same: { type: 'http', url: 'http://127.0.0.1:1/user' }, disabled: { type: 'stdio', command: 'disabled', enabled: false } } } }))
  const runtime = { stateDirectory: join(root, 'state'), runtimeSessionId: 'fixture' } as AgentRuntimeContext
  const prepared = await prepareZcode({ mcpServers: { managed: { command: 'managed' } } }, { cwd, command: 'zcode', env: { HOME: home } }, 'global', runtime, new AbortController().signal)
  cleanups.push(prepared.dispose)
  expect(prepared.mcpServers).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'ancestor', url: 'http://127.0.0.1:1/ancestor' }), expect.objectContaining({ name: 'same', url: 'http://127.0.0.1:1/user' })]))
  expect(prepared.mcpServers.some(server => server.name === 'disabled')).toBe(false)
})

it('refuses an empty override instead of silently re-enabling the native MCP server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-zcode-empty-mcp-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.zcode', 'cli'), { recursive: true })
  await writeFile(join(root, '.zcode', 'cli', 'config.json'), JSON.stringify({ mcp: { servers: { native: { type: 'stdio', command: 'native-command' } } } }))
  await expect(prepareZcode({ mcpServers: { native: { command: 'native-command', enabled: false } } }, { cwd: root, command: 'zcode', env: { HOME: root } }, 'global', { stateDirectory: join(root, 'state') } as AgentRuntimeContext, new AbortController().signal)).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
})

it('keeps a runtime unavailable after an unconfirmed cleanup instead of admitting another turn', async () => {
  const { createZcodeRuntime } = await import('../../plugins/zcode/src/runtime')
  const root = await mkdtemp(join(tmpdir(), 'studio-zcode-sticky-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const batches: any[] = []; let waiting: ((value: any) => void) | undefined, input = ''
  const deliver = (message: any) => {
    const batch = { chunks: [{ stream: 'stdout', data: Buffer.from(JSON.stringify(message) + '\n') }], truncated: false, exit: null }
    if (waiting) { const resolve = waiting; waiting = undefined; resolve(batch) } else batches.push(batch)
  }
  const sessionId = 'sess_cleanup', workspacePath = await import('node:fs/promises').then(fs => fs.realpath(root))
  const snapshot = () => ({ protocol: { name: 'ZCode Protocol', version: 1 }, session: { sessionId, workspace: { workspacePath }, status: 'idle' }, runtime: { eventSeq: 0 } })
  const process = {
    read: async () => batches.length ? batches.shift() : new Promise(resolve => { waiting = resolve }),
    write: async (bytes: Uint8Array) => {
      input += Buffer.from(bytes).toString()
      while (input.includes('\n')) {
        const end = input.indexOf('\n'), frame = JSON.parse(input.slice(0, end)); input = input.slice(end + 1)
        if (!frame.method) continue
        if (frame.method === 'session/create' || frame.method === 'session/read') deliver({ id: frame.id, result: snapshot() })
        else if (frame.method === 'session/send') {
          deliver({ id: frame.id, result: { sessionId, accepted: true } })
          deliver({ method: 'session/event', params: { sessionId, seq: 1, type: 'turn.completed', payload: { inputId: frame.params.inputId, resultType: 'success', response: 'answer' } } })
          deliver({ method: 'state.updated', params: { sessionId, reason: 'prompt_completed' } })
        } else deliver({ id: frame.id, result: {} })
      }
    },
    end: async () => { const batch = { chunks: [], truncated: false, exit: { code: 0, signal: null } }; if (waiting) { const resolve = waiting; waiting = undefined; resolve(batch) } else batches.push(batch) },
    dispose: async () => {},
  }
  const spawn = vi.fn(async () => process), controller = new AbortController()
  const runtime = createZcodeRuntime({ config: { cwd: root, command: 'fixture', model: 'fixture-model', env: { HOME: root } }, mode: 'scoped' } as any,
    { stateDirectory: join(root, 'state'), signal: controller.signal, processes: { spawn }, runtimeSessionId: 'fixture' } as unknown as AgentRuntimeContext)
  const ctx = { signal: controller.signal, scope: { runId: 'cleanup-run' }, models: { gateway: async () => ({ baseUrl: 'http://127.0.0.1:1/lease/v1', token: 'in-memory-token', model: 'fixture-model', images: true, dispose: async () => { throw new Error('Cleanup confirmation failed') } }) } } as any
  const handle = await runtime.run({ content: [{ type: 'text', text: 'hello' }] }, ctx)
  await expect(handle.result).rejects.toThrow('Cleanup confirmation failed')
  await expect(runtime.run({ content: [{ type: 'text', text: 'another turn' }] }, ctx)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  expect(spawn).toHaveBeenCalledTimes(1)
  await runtime.dispose('test ended')
})
