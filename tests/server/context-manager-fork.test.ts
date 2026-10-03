import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  session: vi.fn(),
  detail: vi.fn(),
  config: { appHome: '' },
}))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: mocks.config }))
vi.mock('../../packages/server/src/modules/studio/services/context-manager/settings', () => ({ getContextManagerSettings: mocks.settings }))
vi.mock('../../packages/server/src/modules/studio/services/context-manager/lifecycle', () => ({ getManagedContextManagerCaBundle: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({ getSession: mocks.session, getSessionDetail: mocks.detail }))

const servers: Server[] = []
const managerSettings = {
  hermes: { manager: 'bili' },
  ekko: { manager: 'native' },
  proxyUrl: 'http://127.0.0.1:0',
  allowNativeFallback: false,
}

const snapshotIdentities = [
  { rawId: 'raw-user', ref: 'm00001', identityHash: 'b'.repeat(64) },
  { rawId: 'raw-answer', ref: 'm00002', identityHash: '1'.repeat(64) },
]
const snapshot = {
  ok: true,
  protocolVersion: 1,
  parentRevision: 'parent-revision-7',
  orderedMessages: snapshotIdentities,
  messages: [
    { ...snapshotIdentities[0], role: 'user', text: 'find weather', contentType: 'text' },
    { ...snapshotIdentities[1], role: 'assistant', text: 'It is sunny.', contentType: 'text' },
  ],
}

const branchMessages = [
  { role: 'user', content: 'find weather' },
  { role: 'assistant', content: 'It is sunny.' },
]

async function fakePlugin(handler: (path: string, body: unknown, request: Request) => unknown | Promise<unknown>): Promise<{ url: string; calls: Array<{ path: string; body: unknown; headers: Headers }> }> {
  const calls: Array<{ path: string; body: unknown; headers: Headers }> = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = raw ? JSON.parse(raw) : undefined
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value)
    const path = req.url || '/'
    calls.push({ path, body, headers })
    const result = await handler(path, body, new Request(`http://127.0.0.1${path}`, { method: req.method, headers })) as { status?: number; body: unknown }
    res.statusCode = result.status || 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(result.body))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing fake plugin address')
  return { url: `http://127.0.0.1:${address.port}`, calls }
}

let appHome = ''

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  appHome = await mkdtemp(join(tmpdir(), 'studio-context-fork-'))
  mocks.config.appHome = appHome
  mocks.settings.mockResolvedValue(managerSettings)
  mocks.session.mockImplementation((id: string) => ({ id, profile: 'default', agent: 'hermes', model: 'model-a' }))
  mocks.detail.mockReturnValue({ messages: branchMessages })
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await rm(appHome, { recursive: true, force: true })
})

describe('Studio bili branch runtime', () => {
  it('uses public snapshot/fork HTTP and preserves native child conversation identity', async () => {
    const plugin = await fakePlugin((path, body) => {
      if (path === '/__bili/plugin/manifest') return { body: { ok: true, protocolVersion: 1, capabilities: { fork: { protocolVersion: 1 } } } }
      if (path.startsWith('/__bili/plugin/snapshot?conversationId=')) {
        const id = new URL(path, 'http://localhost').searchParams.get('conversationId')!
        return { body: { ...snapshot, conversationId: id, sessionId: id, parentRevision: id === 'child-session' ? 'child-revision-1' : snapshot.parentRevision } }
      }
      if (path === '/__bili/plugin/fork') return {
        body: {
          ok: true,
          protocolVersion: 1,
          parentConversationId: 'parent-session',
          parentRevision: snapshot.parentRevision,
          branchPoint: (body as any).branchPoint,
          childConversationId: 'child-session',
          sessionId: 'child-session',
          childRevision: 'child-revision-1',
          status: 'exact',
        },
      }
      return { status: 404, body: { ok: false, error: 'unexpected public path' } }
    })
    mocks.settings.mockResolvedValue({ ...managerSettings, proxyUrl: plugin.url })
    const { forkBiliConversation } = await import('../../packages/server/src/modules/studio/services/context-manager/runtime')

    const result = await forkBiliConversation({
      profile: 'default',
      agent: 'hermes',
      parentSessionId: 'parent-session',
      childSessionId: 'child-session',
      messages: branchMessages,
    })

    expect(result).toMatchObject({ ok: true, childConversationId: 'child-session', protocolVersion: 1 })
    expect(plugin.calls.map(call => call.path.split('?')[0])).toEqual([
      '/__bili/plugin/manifest',
      '/__bili/plugin/snapshot',
      '/__bili/plugin/fork',
      '/__bili/plugin/snapshot',
    ])
    const fork = plugin.calls[2]
    expect(fork.body).toMatchObject({
      protocolVersion: 1,
      parentConversationId: 'parent-session',
      childConversationId: 'child-session',
      parentRevision: 'parent-revision-7',
      orderedMessages: snapshotIdentities,
      branchPoint: { messageCount: snapshotIdentities.length },
    })
    expect(JSON.stringify(fork.body)).not.toContain('agent:default:')
    expect(fork.headers.has('authorization')).toBe(false)
    expect(fork.headers.has('x-api-key')).toBe(false)
  })

  it('matches only an exact ordered raw/ref prefix and fails closed on changed content', async () => {
    const { matchBiliBranchPrefix } = await import('../../packages/server/src/modules/studio/services/context-manager/runtime')
    expect(matchBiliBranchPrefix(snapshot, branchMessages)).toEqual(snapshotIdentities)
    expect(matchBiliBranchPrefix(snapshot, branchMessages.slice(0, 1))).toEqual(snapshotIdentities.slice(0, 1))
    expect(() => matchBiliBranchPrefix(snapshot, [{ role: 'user', content: 'edited' }])).toThrow(/match/i)
    expect(() => matchBiliBranchPrefix({ ...snapshot, messages: snapshot.messages.map(message => ({ ...message, ref: 'm99999' })) }, branchMessages)).toThrow(/raw\/ref/i)
    expect(() => matchBiliBranchPrefix({ ...snapshot, messages: snapshot.messages.map(message => ({ ...message, contentType: 'image' })) }, branchMessages)).toThrow(/unavailable/i)
  })

  it('serializes same-child forks and keeps a single durable idempotency key', async () => {
    let childSnapshot = { ...snapshot, conversationId: 'parent', sessionId: 'parent' }
    const plugin = await fakePlugin(async (path, body) => {
      if (path.endsWith('/manifest')) {
        await new Promise(resolve => setTimeout(resolve, 20))
        return { body: { ok: true, capabilities: { fork: { protocolVersion: 1 } } } }
      }
      if (path.startsWith('/__bili/plugin/snapshot')) return { body: childSnapshot }
      const request = body as any
      childSnapshot = { ...snapshot, conversationId: request.childConversationId, sessionId: request.childConversationId, parentRevision: 'c'.repeat(64) }
      return { body: { ok: true, protocolVersion: 1, status: 'exact', parentConversationId: request.parentConversationId, childConversationId: request.childConversationId, sessionId: request.childConversationId, parentRevision: request.parentRevision, childRevision: 'c'.repeat(64), branchPoint: request.branchPoint } }
    })
    mocks.settings.mockResolvedValue({ ...managerSettings, proxyUrl: plugin.url })
    const { forkBiliConversation } = await import('../../packages/server/src/modules/studio/services/context-manager/runtime')
    const args = { profile: 'default', agent: 'hermes' as const, parentSessionId: 'parent', childSessionId: 'child', messages: branchMessages }
    const responses = await Promise.all(Array.from({ length: 8 }, () => forkBiliConversation(args)))
    expect(responses).toHaveLength(8)
    expect(plugin.calls.filter(call => call.path.endsWith('/fork'))).toHaveLength(1)
    await expect(forkBiliConversation({ ...args, messages: branchMessages.slice(0, 1) })).rejects.toThrow(/conflict/i)
  })

  it.each([
    { status: 'unavailable' },
    { status: undefined },
    { parentConversationId: 'wrong-parent' },
    { parentRevision: 'wrong-revision' },
    { sessionId: 'wrong-child' },
    { branchPoint: { messageCount: 0, orderHash: '0'.repeat(64) } },
  ])('rejects an unsafe or mismatched receipt %j before continuation', async patch => {
    const plugin = await fakePlugin((path, body) => {
      if (path.endsWith('/manifest')) return { body: { ok: true, capabilities: { fork: { protocolVersion: 1 } } } }
      if (path.startsWith('/__bili/plugin/snapshot')) return { body: { ...snapshot, conversationId: 'parent', sessionId: 'parent' } }
      const request = body as any
      return { body: { ok: true, protocolVersion: 1, status: 'exact', parentConversationId: request.parentConversationId, childConversationId: request.childConversationId, sessionId: request.childConversationId, parentRevision: request.parentRevision, childRevision: 'c'.repeat(64), branchPoint: request.branchPoint, ...patch } }
    })
    mocks.settings.mockResolvedValue({ ...managerSettings, proxyUrl: plugin.url })
    const { forkBiliConversation } = await import('../../packages/server/src/modules/studio/services/context-manager/runtime')
    await expect(forkBiliConversation({ profile: 'default', agent: 'hermes', parentSessionId: 'parent', childSessionId: 'child', messages: branchMessages })).rejects.toThrow(/receipt|unavailable|mismatch/i)
  })

  it.each(['identity', 'prefix'])('rejects wrong child snapshot %s before the first outbound request', async defect => {
    const plugin = await fakePlugin((path, body) => {
      if (path.endsWith('/manifest')) return { body: { ok: true, capabilities: { fork: { protocolVersion: 1 } } } }
      if (path.includes('conversationId=parent')) return { body: { ...snapshot, conversationId: 'parent', sessionId: 'parent' } }
      if (path.startsWith('/__bili/plugin/snapshot')) return { body: {
        ...snapshot, conversationId: defect === 'identity' ? 'parent' : 'child', sessionId: defect === 'identity' ? 'parent' : 'child',
        orderedMessages: defect === 'prefix' ? snapshotIdentities.slice(1) : snapshotIdentities,
        messages: defect === 'prefix' ? snapshot.messages.slice(1) : snapshot.messages,
      } }
      const request = body as any
      return { body: { ok: true, protocolVersion: 1, status: 'expanded', parentConversationId: request.parentConversationId, childConversationId: request.childConversationId, sessionId: request.childConversationId, parentRevision: request.parentRevision, childRevision: 'c'.repeat(64), branchPoint: request.branchPoint } }
    })
    mocks.settings.mockResolvedValue({ ...managerSettings, proxyUrl: plugin.url })
    const { forkBiliConversation, ensureBiliConversation } = await import('../../packages/server/src/modules/studio/services/context-manager/runtime')
    const outbound = vi.fn()
    await expect((async () => {
      await forkBiliConversation({ profile: 'default', agent: 'hermes', parentSessionId: 'parent', childSessionId: 'child', messages: branchMessages })
      await ensureBiliConversation('default', 'hermes', 'child')
      outbound()
    })()).rejects.toThrow(/identity|prefix|match/i)
    expect(outbound).not.toHaveBeenCalled()
  })

  it('fails closed on an HTTP error and never creates a native-looking fallback request', async () => {
    const plugin = await fakePlugin(path => path === '/__bili/plugin/manifest'
      ? { body: { ok: true, protocolVersion: 1, capabilities: { fork: { protocolVersion: 1 } } } }
      : { status: 409, body: { ok: false, code: 'stale_parent' } })
    mocks.settings.mockResolvedValue({ ...managerSettings, proxyUrl: plugin.url })
    const { forkBiliConversation } = await import('../../packages/server/src/modules/studio/services/context-manager/runtime')

    await expect(forkBiliConversation({ profile: 'default', agent: 'hermes', parentSessionId: 'parent', childSessionId: 'child-session', messages: branchMessages })).rejects.toThrow(/stale_parent|409|Bili/i)
    expect(plugin.calls.some(call => call.path === '/__bili/plugin/fork')).toBe(false)
  })
})
