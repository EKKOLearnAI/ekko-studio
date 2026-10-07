import { createServer, type Server } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentRuntime, AgentToolRegistry, AnthropicMessagesModelClient, BillionContextManager } from '../../packages/ekko-agent/src/index'

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  session: vi.fn(),
  summarize: vi.fn(),
  config: { appHome: '' },
}))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: mocks.config }))
vi.mock('../../packages/server/src/modules/studio/services/context-manager/settings', () => ({ getContextManagerSettings: mocks.settings }))
vi.mock('../../packages/server/src/modules/studio/services/context-manager/lifecycle', () => ({ getManagedContextManagerCaBundle: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({ getSession: mocks.session, getSessionDetail: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/context-compressor', () => ({
  callSummarizer: mocks.summarize, buildFullPrompt: (source: string) => source,
}))

const biliRoot = process.env.STUDIO_BILI_TEST_ROOT || ''
const loader = `${biliRoot}/node_modules/tsx/dist/loader.mjs`
const serverSource = `${biliRoot}/src/server.ts`
const hasBiliCheckout = Boolean(biliRoot && existsSync(loader) && existsSync(serverSource))
const upstreamServers: Server[] = []
let bili: ChildProcess | undefined
let appHome = ''

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing loopback address')
  return address.port
}

async function startBili(upstreamUrl: string, stateDir: string): Promise<string> {
  const code = `import { startServer } from ${JSON.stringify(serverSource)}; import { defaultConfig } from 'acp-kernel'; import { SessionStore, _setStoreForTest } from ${JSON.stringify(`${biliRoot}/src/persist.ts`)}; import { _setForTest } from ${JSON.stringify(`${biliRoot}/src/registry.ts`)}; import { _resetPluginStateForTest } from ${JSON.stringify(`${biliRoot}/src/plugin.ts`)}; import { _resetSessionsForTest } from ${JSON.stringify(`${biliRoot}/src/session.ts`)}; _resetSessionsForTest(); _resetPluginStateForTest(); _setForTest({}); _setStoreForTest(new SessionStore({ dir: ${JSON.stringify(`${stateDir}/sessions`)}, enabled: false })); const server = await startServer({ port: 0, host: '127.0.0.1', upstream: ${JSON.stringify(upstreamUrl)}, routes: { [${JSON.stringify(upstreamUrl)}]: { models: { 'claude-test': { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: true, preserveRecentMessages: 1, preserveRecentTokens: 0, minCompressRangeChars: 100 }, promptCache: { routing: 'auto' }, sessionHeader: 'x-acp-session', log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } }); const ready = () => process.stdout.write(JSON.stringify({ port: server.address().port }) + '\\n'); if (server.listening) ready(); else server.once('listening', ready)`
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(BILI_|ACP_)/.test(key) && key !== 'NODE_OPTIONS'))
  bili = spawn(process.execPath, ['--import', loader, '--input-type=module', '--eval', code], {
    cwd: biliRoot,
    env: { ...env, NODE_ENV: 'test', XDG_STATE_HOME: stateDir, XDG_DATA_HOME: stateDir, XDG_CACHE_HOME: stateDir, XDG_CONFIG_HOME: stateDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  bili.stderr?.on('data', chunk => { stderr += chunk.toString() })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bili startup timeout: ${stderr}${stdout}`)), 20_000)
    bili?.stdout?.on('data', chunk => {
      stdout += chunk.toString()
      const match = stdout.match(/\{"port":(\d+)\}/)
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`) }
    })
    bili?.once('exit', code => { clearTimeout(timer); reject(new Error(`bili exited ${code}: ${stderr}`)) })
  })
}

async function closeBili(): Promise<void> {
  if (!bili || bili.exitCode !== null) return
  bili.kill('SIGTERM')
  await new Promise<void>(resolve => bili?.once('exit', () => resolve()))
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  appHome = await mkdtemp(join(tmpdir(), 'studio-bili-loopback-'))
  mocks.config.appHome = appHome
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await closeBili()
  await Promise.all(upstreamServers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await rm(appHome, { recursive: true, force: true })
})

describe.skipIf(!hasBiliCheckout)('Studio bili loopback integration', () => {
  it('manually compresses only proxy-approved ranges and preserves the first user anchor', async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'msg_manual', role: 'assistant', content: [{ type: 'text', text: 'answer' }], usage: { input_tokens: 10000, output_tokens: 10 } }))
    })
    upstreamServers.push(upstream)
    const upstreamUrl = `http://127.0.0.1:${await listen(upstream)}`
    const proxyUrl = await startBili(upstreamUrl, appHome)
    const messages = Array.from({ length: 9 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user', content: i === 0 ? 'permanent anchor' : `recoverable history ${i} `.repeat(250),
    }))
    const response = await fetch(`${proxyUrl}/bili/${upstreamUrl}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-bili-plugin': 'test', 'x-bili-plugin-conversation': 'manual-session' },
      body: JSON.stringify({ model: 'claude-test', max_tokens: 1024, stream: false, messages }),
    })
    expect(response.status).toBe(200)
    await response.text()
    mocks.settings.mockResolvedValue({ hermes: { manager: 'bili' }, ekko: { manager: 'native' }, proxyUrl, allowNativeFallback: false })
    mocks.session.mockReturnValue({ id: 'manual-session', profile: 'default', model: 'claude-test', provider: 'loopback' })
    mocks.summarize.mockResolvedValue('Recovered history includes all completed exchanges and their conclusions. The permanent conversation anchor remains uncompressed. Follow the latest request and preserve the original messages for decompression.')
    const toolBodies: Array<{ tool: string; args: { content: Array<{ startId: string; endId: string }> } }> = []
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (url: string | URL, options?: RequestInit) => {
      if (new URL(url).pathname.endsWith('/tool') && options?.body) toolBodies.push(JSON.parse(String(options.body)))
      return realFetch(url, options)
    })
    const approved = await realFetch(`${proxyUrl}/__bili/plugin/status?conversationId=manual-session`).then(r => r.json()) as any
    expect(approved.sessionRevision).toMatch(/^[a-f0-9]{64}$/)
    expect(approved.compressibleRanges.length).toBeGreaterThan(0)
    const { compactBiliConversation } = await import('../../packages/server/src/modules/studio/services/context-manager/runtime')
    const state: any = { contextOwner: { manager: 'bili', conversationId: 'manual-session' } }
    const result = await compactBiliConversation({ profile: 'default', agent: 'hermes', sessionId: 'manual-session', model: 'claude-test', state, emit: vi.fn() })
    expect(result.afterTokens).toBeLessThan(result.beforeTokens)
    expect(toolBodies).toHaveLength(1)
    expect(toolBodies[0].tool).toBe('compress')
    expect(toolBodies[0].args.content[0].startId).not.toBe('m00001')
    expect(mocks.summarize.mock.calls[0][2]).not.toContain('permanent anchor')
    const snapshot = await fetch(`${proxyUrl}/__bili/plugin/snapshot?conversationId=manual-session`).then(r => r.json()) as any
    expect(snapshot.messages[0].text).toBe('permanent anchor')
  }, 60_000)

  it('manually compresses remaining history after nested blocks without refolding their originals', async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'msg_nested', role: 'assistant', content: [{ type: 'text', text: 'answer' }], usage: { input_tokens: 10000, output_tokens: 10 } }))
    })
    upstreamServers.push(upstream)
    const upstreamUrl = `http://127.0.0.1:${await listen(upstream)}`
    const proxyUrl = await startBili(upstreamUrl, appHome)
    const conversationId = 'nested-manual-session'
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user', content: `recoverable nested history ${i} `.repeat(250),
    }))
    const send = async () => {
      const response = await fetch(`${proxyUrl}/bili/${upstreamUrl}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-bili-plugin': 'test', 'x-bili-plugin-conversation': conversationId },
        body: JSON.stringify({ model: 'claude-test', max_tokens: 1024, stream: false, messages }),
      })
      expect(response.status).toBe(200)
      await response.text()
    }
    const fold = async (startId: string, endId: string) => {
      const response = await fetch(`${proxyUrl}/__bili/plugin/tool`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, tool: 'compress', args: { content: [{ startId, endId,
          summary: 'Preserved all selected historical requests and answers. Original content is retained for independent decompression.' }] } }),
      }).then(r => r.json()) as { result: string }
      expect(response.result).not.toContain('FAILED')
    }
    await send()
    await fold('m00002', 'm00003')
    await fold('b1', 'm00006')
    await send()
    mocks.settings.mockResolvedValue({ hermes: { manager: 'bili' }, ekko: { manager: 'native' }, proxyUrl, allowNativeFallback: false })
    mocks.session.mockReturnValue({ id: conversationId, profile: 'default', model: 'claude-test', provider: 'loopback' })
    mocks.summarize.mockResolvedValue('Remaining historical exchanges and their conclusions are preserved. All original messages remain recoverable.')
    const toolBodies: Array<{ args: { content: Array<{ startId: string; endId: string }> } }> = []
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (url: string | URL, options?: RequestInit) => {
      if (new URL(url).pathname.endsWith('/tool') && options?.body) toolBodies.push(JSON.parse(String(options.body)))
      return realFetch(url, options)
    })
    const { compactBiliConversation } = await import('../../packages/server/src/modules/studio/services/context-manager/runtime')
    const state: any = { contextOwner: { manager: 'bili', conversationId } }
    const result = await compactBiliConversation({ profile: 'default', agent: 'hermes', sessionId: conversationId, model: 'claude-test', state, emit: vi.fn() })
    expect(result.afterTokens).toBeLessThan(result.beforeTokens)
    expect(toolBodies).toHaveLength(1)
    expect(toolBodies[0].args.content[0].startId).toBe('m00007')
    expect(mocks.summarize.mock.calls[0][2]).not.toContain('recoverable nested history 1 ')
    expect(mocks.summarize.mock.calls[0][2]).toContain('recoverable nested history 6 ')
    expect(state.externalContext.source).toBe('estimate')
  }, 60_000)

  it('forks through the real bili public HTTP protocol with isolated state', async () => {
    const forwarded: Array<Record<string, unknown>> = []
    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        forwarded.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'msg_test', role: 'assistant', content: [{ type: 'text', text: 'answer' }], usage: { input_tokens: 10000, output_tokens: 10 } }))
      })
    })
    upstreamServers.push(upstream)
    const upstreamUrl = `http://127.0.0.1:${await listen(upstream)}`
    const proxyUrl = await startBili(upstreamUrl, appHome)
    // ACP retains the first user message; compress a later, unprotected range.
    const messages = [
      { role: 'user', content: 'permanent conversation anchor' },
      { role: 'assistant', content: 'anchor acknowledged' },
      { role: 'user', content: 'first original '.repeat(250) },
      { role: 'assistant', content: 'second original '.repeat(250) },
      { role: 'user', content: 'tail original' },
    ]
    const modelResponse = await fetch(`${proxyUrl}/bili/${upstreamUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bili-plugin': 'test', 'x-bili-plugin-conversation': 'parent-session' },
      body: JSON.stringify({ model: 'claude-test', max_tokens: 1024, stream: false, messages: messages.map(message => ({ ...message, content: [{ type: 'text', text: message.content }] })) }),
    })
    expect(modelResponse.status).toBe(200)
    await modelResponse.text()
    const summary = 'Inherited first request and second response are preserved, and the original messages remain available through decompression.'
    const compressed = await fetch(`${proxyUrl}/__bili/plugin/tool`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'parent-session', tool: 'compress', args: { content: [{ startId: 'm00003', endId: 'm00004', summary }] } }),
    }).then(response => response.json()) as any
    expect(compressed.ok).toBe(true)
    expect(compressed.result).not.toContain('FAILED')
    const parent = await fetch(`${proxyUrl}/__bili/plugin/snapshot?conversationId=parent-session`).then(response => response.json()) as any
    if (!parent.ok) throw new Error(JSON.stringify(parent))
    expect(parent.messages[2]).toMatchObject({ role: 'user', contentType: 'text' })
    expect(parent.messages[2].text).toBe(messages[2].content)

    mocks.settings.mockResolvedValue({ hermes: { manager: 'bili' }, ekko: { manager: 'native' }, proxyUrl, allowNativeFallback: false })
    mocks.session.mockReturnValue({ id: 'child-session', profile: 'default', agent: 'hermes', model: 'claude-test' })
    const { forkBiliConversation } = await import('../../packages/server/src/modules/studio/services/context-manager/runtime')
    const result = await forkBiliConversation({ profile: 'default', agent: 'hermes', parentSessionId: 'parent-session', childSessionId: 'child-session', messages })
    expect(result).toMatchObject({ status: 'exact', childConversationId: 'child-session', sessionId: 'child-session' })
    const child = await fetch(`${proxyUrl}/__bili/plugin/snapshot?conversationId=child-session`).then(response => response.json()) as any
    expect(child.orderedMessages).toEqual(parent.orderedMessages)
    expect(result.inheritedBlocks).toEqual([{ id: 'b1', tier: 1, active: true, expanded: false }])

    const modelClient = new AnthropicMessagesModelClient({ id: 'loopback', type: 'anthropic', baseUrl: upstreamUrl, defaultModel: 'claude-test', capabilities: { streaming: false } })
    const runtime = new AgentRuntime({ modelClient, tools: new AgentToolRegistry() })
    const contextManager = new BillionContextManager({ proxyOrigin: proxyUrl, contextWindow: 400000 })
    const answer = await runtime.run({ messages, contextKey: 'child-session', contextManager, maxTokens: 1024 })
    expect(answer.output.content).toBe('answer')
    const firstChildRequest = JSON.stringify(forwarded.at(-1)?.messages)
    expect(firstChildRequest).toContain('permanent conversation anchor')
    expect(firstChildRequest).toContain(summary)
    expect(firstChildRequest).not.toContain('first original')
    expect(firstChildRequest).not.toContain('second original')
    expect(firstChildRequest).toContain('tail original')
    expect((forwarded.at(-1)?.tools as Array<{ name: string }>).map(tool => tool.name)).toEqual(expect.arrayContaining(['compress', 'decompress', 'search_context', 'acp_status', 'acp_cache']))

    const restored = await fetch(`${proxyUrl}/__bili/plugin/tool`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'child-session', tool: 'decompress', args: { blockId: 'b1', full: true } }),
    }).then(response => response.json()) as any
    expect(restored.result).toContain('first original')
    expect(restored.result).toContain('second original')
    expect(restored.result).not.toContain('tail original')
    const unchangedParent = await fetch(`${proxyUrl}/__bili/plugin/snapshot?conversationId=parent-session`).then(response => response.json()) as any
    expect(unchangedParent.parentRevision).toBe(parent.parentRevision)

    mocks.session.mockReturnValue({ id: 'partial-session', profile: 'default', agent: 'hermes', model: 'claude-test' })
    const partial = await forkBiliConversation({ profile: 'default', agent: 'hermes', parentSessionId: 'parent-session', childSessionId: 'partial-session', messages: messages.slice(0, 3) })
    expect(partial).toMatchObject({ status: 'expanded', inheritedBlocks: [] })
    await runtime.run({ messages: messages.slice(0, 3), contextKey: 'partial-session', contextManager, maxTokens: 1024 })
    const firstPartialRequest = JSON.stringify(forwarded.at(-1)?.messages)
    expect(firstPartialRequest).toContain('first original')
    expect(firstPartialRequest).not.toContain(summary)
    expect(firstPartialRequest).not.toContain('second original')
    expect(firstPartialRequest).not.toContain('tail original')
  }, 60_000)
})
