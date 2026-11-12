import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, mkdir, cp, chmod, readFile, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { PluginManager } from '../../packages/server/src/modules/studio/services/plugins/manager'
import { createServer } from 'node:http'

const cleanup: Array<() => Promise<void>> = [], who = { userId: 1, profile: 'work' }
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals() })
async function setup(executable?: string) {
  const home = await mkdtemp(join(tmpdir(), 'studio-omp-')); cleanup.push(() => rm(home, { recursive: true, force: true }))
  if (!executable) { executable = join(home, 'omp'); await cp(resolve('tests/fixtures/omp-rpc.mjs'), executable); await chmod(executable, 0o700) }
  const manager = new PluginManager(home, { authorize() {}, api: async () => null, emit() {}, log() {} }); cleanup.push(() => manager.close())
  await manager.install(who, 'builtin:omp', 0); await manager.update(who, 'omp', manager.store.read().revision, { enabled: true })
  const runtime = manager.runtime(who, 'omp'), agent = manager.registeredAgents()[0]
  const settings = { executable, defaultModel: 'custom/test-model', models: { providers: { custom: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:19999/v1', apiKey: 'private-key', models: [{ id: 'test-model', name: 'Test', input: ['text', 'image'], contextWindow: 64000, maxTokens: 8192 }] } } }, config: {} }
  await runtime.invoke('rpc', 'save-settings', settings, who)
  const workspace = join(home, 'workspace'); await mkdir(workspace)
  const events: any[] = []
  const signal = new AbortController()
  const input: Parameters<typeof agent.execute>[0] = { identity: { ...who, sessionId: 'session', runId: 'run-1' }, mode: 'global', paths: { runtimeDir: join(home, 'run'), workspaceDir: workspace },
    model: { model: 'custom/test-model' }, signal: signal.signal, deadlineAt: Date.now() + 60000,
    request: { input: [{ type: 'text', text: 'hello' }], history: [], instructions: [], options: {} }, mcpServers: {},
    attachments: { read: async () => Uint8Array.of(1, 2, 3), resolve: async () => ({ assetId: 'file', localPath: join(workspace, 'fixture.txt'), name: 'fixture.txt', mediaType: 'text/plain', size: 3 }) },
    emit: async event => { events.push(event) },
    interactions: { approve: async () => ({ outcome: 'denied' }), clarify: async () => ({ outcome: 'dismissed' }) },
  }
  return { home, manager, runtime, agent, settings, input, events, signal }
}
it('keeps model credentials private and settings isolated by actual user/Profile', async () => {
  const f = await setup()
  const visible: any = await f.runtime.invoke('rpc', 'get-settings', null, who)
  expect(visible.models.providers.custom.apiKey).toBe('••••••••')
  await f.runtime.invoke('rpc', 'save-settings', { ...visible, defaultModel: '' }, who)
  const other: any = await f.runtime.invoke('rpc', 'get-settings', null, { userId: 2, profile: 'other' })
  expect(other.models.providers).toEqual({})
  const paths = f.runtime.context().paths
  expect(paths.dataDir).toContain(f.home)
  expect(JSON.stringify(visible)).not.toContain('private-key')
})
it('recovers update checks through the public release redirect without anonymous REST API access', async () => {
  const f = await setup()
  await f.runtime.invoke('rpc', 'save-settings', { ...f.settings, executable: '' }, who)
  let failed = true
  const request = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.startsWith('https://api.github.com/')) return new Response('API rate limit exceeded', { status: 403 })
    expect(url).toBe('https://github.com/can1357/oh-my-pi/releases/latest')
    expect(options).toMatchObject({ method: 'HEAD', redirect: 'manual' })
    return failed ? new Response(null, { status: 429 }) : new Response(null, { status: 302, headers: { location: 'https://github.com/can1357/oh-my-pi/releases/tag/v18.19.0' } })
  })
  vi.stubGlobal('fetch', request)
  await expect(f.agent.checkUpdate(who)).rejects.toMatchObject({ status: 503, code: 'OMP_RELEASE_LOOKUP' })
  failed = false
  expect(await f.agent.checkUpdate(who)).toMatchObject({ currentVersion: '', latestVersion: '18.19.0', updateAvailable: true })
  expect(await f.agent.checkUpdate(who)).toMatchObject({ latestVersion: '18.19.0' })
  expect(request).toHaveBeenCalledTimes(2)
})
it('exposes managed engine removal and automatic update support without deleting external binaries or settings', async () => {
  const f = await setup()
  expect(f.agent.descriptor().actions).toMatchObject({ remove: true, autoUpdate: true })
  expect(await f.agent.supportsAutoUpdate(who)).toBe(false)
  await expect(f.agent.remove(who, { expectedVersion: (await f.agent.status(who)).version })).rejects.toThrow('managed outside Studio')
  await access(f.settings.executable!)
  const dataDir = f.runtime.context().paths.dataDir, managed = join(dataDir, 'engines', '18.19.0')
  await mkdir(managed, { recursive: true })
  await cp(f.settings.executable!, join(managed, 'fixture-omp')); await chmod(join(managed, 'fixture-omp'), 0o700)
  await writeFile(join(dataDir, 'engine.json'), JSON.stringify({ version: '18.19.0', asset: 'fixture-omp' }))
  await f.runtime.invoke('rpc', 'save-settings', { ...f.settings, executable: '' }, who)
  expect(await f.agent.supportsAutoUpdate(who)).toBe(true)
  expect(await f.agent.status(who)).toMatchObject({ installed: true, source: 'managed' })
  await f.agent.remove(who, { expectedVersion: '18.19.0' })
  expect(await f.agent.status(who)).toMatchObject({ installed: false })
  await expect(access(managed)).rejects.toMatchObject({ code: 'ENOENT' })
  await access(f.settings.executable!)
  const settings: any = await f.runtime.invoke('rpc', 'get-settings', null, who)
  expect(settings.defaultModel).toBe(f.settings.defaultModel)
  expect(settings.models.providers.custom.apiKey).toBe('••••••••')
})
it('executes a native model through RPC, resumes its engine session, and bounds large UI tool output', async () => {
  const f = await setup()
  const first = await f.agent.execute(f.input)
  expect(first.content).toEqual([{ type: 'text', text: 'fixture turn 1; images=0; model=custom/test-model' }])
  expect(first.usage).toMatchObject({ inputTokens: 12, outputTokens: 5 })
  expect(f.events.find(event => event.type === 'tool.completed')?.result.truncated).toBe(true)
  const second = await f.agent.execute({ ...f.input, identity: { ...f.input.identity, runId: 'run-2' } })
  expect(second.content[0]).toMatchObject({ text: 'fixture turn 2; images=0; model=custom/test-model' })
})
it('gives scoped turns the injected Studio model and forwards image inputs without reporting native credentials', async () => {
  const f = await setup()
  const result = await f.agent.execute({ ...f.input, mode: 'scoped', model: { provider: 'custom:studio', model: 'selected', apiMode: 'chat_completions', baseUrl: 'http://studio-proxy/v1', token: 'run-proxy-token', contextWindow: 64000, outputLimit: 8192 },
    request: { ...f.input.request, input: [{ type: 'text', text: 'hello' }, { type: 'image', assetId: 'image', name: 'a.png', mediaType: 'image/png' }] } })
  expect(result.content[0]).toMatchObject({ text: 'fixture turn 1; images=1; model=studio/selected' })
  await expect(readFile(join(f.input.paths.runtimeDir, 'turns/run-1/models.yml'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('cancels a live process and removes its ephemeral model binding', async () => {
  const f = await setup(); f.input.request.input = [{ type: 'text', text: 'hold' }]
  const running = f.agent.execute(f.input)
  await vi.waitFor(() => expect(f.events.some(event => event.type === 'text.delta')).toBe(true))
  f.signal.abort(new Error('Stopped by test'))
  await expect(running).rejects.toThrow('Stopped by test')
  await vi.waitFor(async () => { await expect(readFile(join(f.input.paths.runtimeDir, 'turns/run-1/models.yml'))).rejects.toMatchObject({ code: 'ENOENT' }) })
})

it('removes scoped credentials if an attachment fails before engine startup', async () => {
  const f = await setup()
  await expect(f.agent.execute({ ...f.input, mode: 'scoped', model: { model: 'selected', apiMode: 'chat_completions', baseUrl: 'http://studio-proxy/v1', token: 'temporary-proxy-token' },
    request: { ...f.input.request, input: [{ type: 'image', assetId: 'missing', name: 'missing.png', mediaType: 'image/png' }] },
    attachments: { ...f.input.attachments, read: async () => { throw new Error('Attachment no longer available') } },
  })).rejects.toThrow('Attachment no longer available')
  await expect(readFile(join(f.input.paths.runtimeDir, 'turns/run-1/models.yml'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.skipIf(!process.env.STUDIO_TEST_OMP_BINARY)('runs the real OMP binary with a model stream, image/file tools and native session resume', async () => {
  const f = await setup(process.env.STUDIO_TEST_OMP_BINARY)
  const file = join(f.input.paths.workspaceDir, 'proof.txt')
  await import('node:fs/promises').then(fs => fs.writeFile(file, 'Native attachment proof'))
  const calls: any[] = []
  const authorization: Array<string | undefined> = []
  const upstream = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw); calls.push(body)
    authorization.push(request.headers.authorization)
    response.setHeader('Content-Type', 'text/event-stream')
    const value = calls.length === 1 ? { tool_calls: [{ index: 0, id: 'call_read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: file }) } }] }
      : { content: calls.length === 2 ? 'OMP fixture success' : 'OMP second turn' }
    const frame = (delta: any, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ id: `fixture-${calls.length}`, object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    frame({ role: 'assistant', ...value }); frame({}, calls.length === 1 ? 'tool_calls' : 'stop')
    response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => upstream.close(() => resolve())))
  f.settings.models.providers.custom.baseUrl = `http://127.0.0.1:${(upstream.address() as any).port}/v1`
  await f.runtime.invoke('rpc', 'save-settings', f.settings, who)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aUioAAAAASUVORK5CYII=', 'base64')
  const input = { ...f.input, request: { ...f.input.request, input: [
    { type: 'text' as const, text: 'Read the attached file and inspect the image.' },
    { type: 'file' as const, assetId: 'file', name: 'proof.txt', mediaType: 'text/plain' },
    { type: 'image' as const, assetId: 'image', name: 'image.png', mediaType: 'image/png' },
  ] }, attachments: { resolve: async () => ({ assetId: 'file', localPath: file, name: 'proof.txt', mediaType: 'text/plain', size: 23 }), read: async () => png } }
  const result = await f.agent.execute(input)
  expect(result.content).toEqual([{ type: 'text', text: 'OMP fixture success' }])
  expect(JSON.stringify(calls[0].messages)).toContain('image_url')
  expect(JSON.stringify(calls[1].messages)).toContain('Native attachment proof')
  expect(result.usage?.inputTokens).toBeGreaterThan(0)
  expect(result.checkpoint?.data).toHaveProperty('sessionFile')
  const again = await f.agent.execute({ ...f.input, identity: { ...f.input.identity, runId: 'run-2' }, request: { ...f.input.request, input: [{ type: 'text', text: 'again' }] } })
  expect(again.content).toEqual([{ type: 'text', text: 'OMP second turn' }])
  expect(JSON.stringify(calls[2].messages)).toContain('OMP fixture success')
  const scoped = await f.agent.execute({ ...f.input, mode: 'scoped', identity: { ...f.input.identity, runId: 'scoped-run' },
    model: { provider: 'custom:studio', model: 'selected', apiMode: 'chat_completions', baseUrl: f.settings.models.providers.custom.baseUrl, token: 'scoped-fixture-token', contextWindow: 64000, outputLimit: 8192 } })
  expect(scoped.content).toEqual([{ type: 'text', text: 'OMP second turn' }])
  expect(calls[3].model).toBe('selected')
  expect(authorization[3]).toBe('Bearer scoped-fixture-token')
  expect(authorization.slice(0, 3)).toEqual(Array(3).fill('Bearer private-key'))
}, 60000)
