import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import Koa from 'koa'
import { bodyParser } from '@koa/bodyparser'
import { Server } from 'socket.io'
import { io as connectClient, type Socket } from 'socket.io-client'

let root: string
let db: DatabaseSync
let io: Server
let origin: string
let service: any
let accessModule: typeof import('../../packages/server/src/modules/studio/services/session-shares/access')
const invalidIdentityTokens = new Set<string>()
let identityValid = true
let terminalService: { close: () => void } | undefined
const processes: any[] = []
const clients: Socket[] = []
const sender = { id: 101, name: 'Alice' }
const recipient = { id: 202, name: 'Bob' }
const delivered = vi.fn()
const speechSynthesize = vi.fn()
const speechTranscribe = vi.fn()

beforeEach(async () => {
  vi.resetModules()
  root = await mkdtemp(join(tmpdir(), 'share-access-'))
  await mkdir(join(root, 'workspace'))
  db = new DatabaseSync(':memory:')
  identityValid = true
  invalidIdentityTokens.clear()
  delivered.mockClear()
  speechSynthesize.mockReset().mockResolvedValue({ audio: Buffer.from('mp3-audio'), contentType: 'audio/mpeg', engine: 'test', provider: 'edge' })
  speechTranscribe.mockReset().mockResolvedValue({ text: 'recognized speech', provider: 'openai', model: 'test', durationMs: 20 })
  vi.doMock('../../packages/server/src/modules/studio/services/voice/tts/providers', () => ({ getTtsProvider: () => ({ synthesize: speechSynthesize }) }))
  vi.doMock('../../packages/server/src/modules/studio/services/voice/stt', async importOriginal => ({ ...await importOriginal<any>(), transcribeWithProvider: speechTranscribe }))
  processes.length = 0
  terminalService = undefined
  vi.doMock('../../packages/server/src/modules/studio/public/profile-config', () => ({ getProfileDir: () => root, getActiveProfileDir: () => root, getActiveProfileName: () => 'default', listProfileNamesFromDisk: () => ['default'] }))
  vi.doMock('../../packages/server/src/modules/hermes/services/profiles/profile', () => ({ getProfileDir: () => root, listProfileNamesFromDisk: () => ['default'] }))
  vi.doMock('../../packages/server/src/modules/hermes/services/terminal/runtime', () => ({
    canOpenTerminal: (user: any) => user?.role === 'super_admin', findShell: () => '/bin/sh', resolveTerminalCwd: () => root,
    pty: { spawn: () => { const process = { pid: 99999999, onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn(), resize: vi.fn() }; processes.push(process); return process } },
  }))
  vi.doMock('../../packages/server/src/modules/studio/public/process-tree', () => ({ killOwnedProcessTree: (_: number, kill: () => void) => kill() }))
  vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({ getDb: () => db, isSqliteAvailable: () => true, getStoragePath: () => ':memory:' }))
  vi.doMock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
    findUserById: () => ({ id: 7, role: 'super_admin', status: 'active', username: 'owner' }), listUserProfiles: () => [], userCanAccessProfile: () => true,
  }))
  vi.doMock('../../packages/server/src/modules/studio/services/files/upload-paths', () => ({ getProfileUploadDir: () => join(root, 'uploads') }))
  vi.doMock('../../packages/server/src/modules/studio/services/session-shares/app-identity', async () => {
    const { SessionShareError } = await import('../../packages/server/src/modules/studio/contracts/session-shares')
    return { shareAppIdentityVerifier: { verify: async (token: string) => {
      if (!identityValid || invalidIdentityTokens.has(token) || !['cloud-bob', 'cloud-bob-renewed'].includes(token)) throw new SessionShareError('share_app_login_required', 401)
      return recipient
    } } }
  })
  vi.doMock('../../packages/server/src/modules/studio/public/session-agent-runtime', async importOriginal => ({
    ...await importOriginal<any>(),
    getSessionAvailableModelGroups: async () => [{ provider: 'custom:test', label: 'Test', models: ['model-a', 'disabled'],
      api_key: 'private-provider-key', base_url: 'https://private-provider.test', api_mode: 'chat_completions', model_meta: { disabled: { disabled: true } } }],
    notifyHermesSessionModelChanged: vi.fn(),
    getHermesModelContextLength: ({ profile, provider, model }: any) => {
      const row = db.prepare('SELECT context_limit FROM model_context WHERE profile = ? AND provider = ? AND model = ?')
        .get(profile, provider || '', model || '') as any
      return row?.context_limit || 128_000
    },
  }))
  vi.doMock('../../packages/server/src/modules/studio/public/chat-agent-runtime', async importOriginal => ({
    ...await importOriginal<any>(),
    createPrimaryAgentBridge: () => ({ statusIfLoaded: async () => ({ exists: false }), interrupt: vi.fn(async () => ({})) }),
  }))
  const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
  initAllHermesTables()
  const { createSession, addMessage } = await import('../../packages/server/src/modules/studio/repositories/session-store')
  for (const id of ['s1', 's2']) {
    createSession({ id, source: 'cli', workspace: join(root, 'workspace') })
    addMessage({ session_id: id, role: 'user', content: `message from ${id}` })
  }
  service = (await import('../../packages/server/src/modules/studio/services/session-shares/service')).sessionShareService
  accessModule = await import('../../packages/server/src/modules/studio/services/session-shares/access')
  const { requireUserJwt, resolveUserProfile } = await import('../../packages/server/src/modules/studio/middleware/auth')
  const { sessionRoutes } = await import('../../packages/server/src/modules/studio/routes/sessions')
  const { appUploadRoutes } = await import('../../packages/server/src/modules/studio/routes/app-upload')
  const { uploadRoutes } = await import('../../packages/server/src/modules/studio/routes/upload')
  const { chatRunRoutes } = await import('../../packages/server/src/modules/studio/routes/chat-run')
  const { downloadRoutes } = await import('../../packages/server/src/modules/studio/routes/download')
  const app = new Koa()
  app.use(bodyParser()); app.use(requireUserJwt); app.use(resolveUserProfile)
  app.use(sessionRoutes.routes()); app.use(appUploadRoutes.routes()); app.use(uploadRoutes.routes()); app.use(downloadRoutes.routes()); app.use(chatRunRoutes.routes())
  const http = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => http.once('listening', resolve))
  origin = `http://127.0.0.1:${(http.address() as any).port}`
  io = new Server(http)
  const { bindSessionShareSocket } = await import('../../packages/server/src/modules/studio/services/session-shares/socket-access')
  io.of('/share-test').use((socket, next) => {
    void accessModule.authenticateSessionShare(accessModule.socketShareToken(socket.handshake.auth), socket.handshake.auth.appAccessToken)
      .then(access => { socket.data.sessionShare = access; next() }).catch(next)
  }).on('connection', socket => {
    bindSessionShareSocket(socket, socket.data.sessionShare, () => undefined)
    for (const event of ['run', 'resume', 'abort', 'app.subscribe']) socket.on(event, data => { delivered(event, data); socket.emit('accepted', { event, data }) })
  })
})
afterEach(async () => {
  clients.splice(0).forEach(socket => socket.disconnect())
  terminalService?.close()
  if (io) await new Promise<void>(resolve => io.close(() => resolve()))
  db.close()
  await rm(root, { recursive: true, force: true })
  for (const path of ['infrastructure/database/index', 'repositories/users-store', 'services/files/upload-paths', 'services/session-shares/app-identity', 'public/profile-config', 'public/process-tree', 'public/chat-agent-runtime', 'public/session-agent-runtime', 'services/voice/tts/providers', 'services/voice/stt']) {
    vi.doUnmock(`../../packages/server/src/modules/studio/${path}`)
  }
  vi.doUnmock('../../packages/server/src/modules/hermes/services/profiles/profile')
  vi.doUnmock('../../packages/server/src/modules/hermes/services/terminal/runtime')
  vi.unstubAllEnvs()
  vi.resetModules()
})
async function issue(permissions = {}, sessionId = 's1') {
  const result = await service.create(7, sender, sessionId, { permissions })
  service.claim(result.token, recipient)
  return result
}
async function request(token: string, path: string, method = 'GET', body?: any, headers = {}) {
  const response = await fetch(origin + path, { method, headers: { 'X-Session-Share-Token': token, 'X-App-Access-Token': 'cloud-bob',
    ...(body !== undefined && typeof body !== 'string' ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) })
  const text = await response.text()
  return { status: response.status, body: (() => { try { return JSON.parse(text) } catch { return text } })(), headers: response.headers }
}
async function socket(token: string) {
  const client = connectClient(origin + '/share-test', { transports: ['websocket'], reconnection: false, auth: { shareToken: token, appAccessToken: 'cloud-bob' } })
  clients.push(client)
  await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject) })
  return client
}
function once(socket: Socket, event: string): Promise<any> { return new Promise(resolve => socket.once(event, resolve)) }

describe('existing APIs with session share credentials', () => {
  it('reads context limits with read access and edits only the bound model with switchModel access', async () => {
    const { updateSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const { readModelContextRecord } = await import('../../packages/server/src/modules/studio/public/provider-context')
    updateSession('s1', { provider: 'custom:test', model: 'model-a' })
    const readonly = await issue()
    const editor = await issue({ switchModel: true })
    const path = '/api/studio/sessions/s1/share-context-length'
    const input = { provider: 'custom:test', model: 'model-a', context_limit: 64_000 }
    expect(await request(readonly.token, path)).toMatchObject({ status: 200, body: { context_length: 128_000 } })
    expect((await request(readonly.token, path, 'PUT', input)).status).toBe(403)
    expect((await request(editor.token, '/api/studio/sessions/s2/share-context-length', 'PUT', input)).status).toBe(403)
    expect((await request(editor.token, '/api/hermes/model-context/custom%3Atest/model-a', 'PUT', input)).status).toBe(403)
    for (const invalid of [{ ...input, context_limit: 999 }, { ...input, context_limit: 10_000_001 },
      { ...input, context_limit: 1234.5 }, { ...input, context_limit: '64000' },
      { ...input, model: 'other' }, { ...input, provider: 'other' }, { ...input, profile: 'other' }]) {
      expect((await request(editor.token, path, 'PUT', invalid)).status).toBeGreaterThanOrEqual(400)
    }
    expect(await request(editor.token, path, 'PUT', input)).toMatchObject({ status: 200, body: { context_length: 64_000 } })
    expect(readModelContextRecord('default', 'custom:test', 'model-a')).toMatchObject({ available: true, row: { context_limit: 64_000 } })
    expect(await request(readonly.token, path)).toMatchObject({ status: 200, body: { context_length: 64_000 } })
    updateSession('s1', { model: 'model-b' })
    expect((await request(editor.token, path, 'PUT', input)).status).toBe(400)
    updateSession('s1', { model: 'model-a', agent: 'ekko-agent', source: 'coding_agent' })
    expect((await request(editor.token, path, 'PUT', input)).status).toBe(200)
    for (const agent of ['codex', 'claude', 'pi', 'grok', 'opencode', 'dsh']) {
      updateSession('s1', { agent, source: 'coding_agent' } as any)
      expect((await request(editor.token, path)).status).toBe(400)
      expect((await request(editor.token, path, 'PUT', input)).status).toBe(400)
    }
    updateSession('s1', { agent: 'hermes', source: 'cli' })
    await service.change(7, 's1', editor.record.id, { permissions: { switchModel: false } })
    expect((await request(editor.token, path, 'PUT', input)).status).toBe(403)
    expect((await request(editor.token, path)).status).toBe(200)
    await service.change(7, 's1', editor.record.id, { revoke: true })
    expect((await request(editor.token, path)).status).toBe(410)
  })

  it('authenticates on the production chat namespace without leaking global snapshots or broadcasts', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const server = new ChatRunSocket(io) as any
    // Register the real handlers without starting unrelated background Agent polling.
    io.of('/chat-run').use(server.authMiddleware.bind(server)).on('connection', server.onConnection.bind(server))
    for (const id of ['s1', 's2']) server.sessionMap.set(id, { isWorking: true, profile: 'default', source: 'cli', events: [], queue: [], messages: [] })
    const { token } = await issue({ input: true })
    const client = connectClient(origin + '/chat-run', { autoConnect: false, transports: ['websocket'], reconnection: false,
      auth: { shareToken: token, appAccessToken: 'cloud-bob' } })
    clients.push(client)
    const snapshot = once(client, 'session.activity.snapshot')
    client.connect()
    expect((await snapshot).sessions).toEqual([{ session_id: 's1', status: 'running' }])
    const backendSocket = io.of('/chat-run').sockets.get(client.id!)!
    expect(backendSocket.rooms.has('pending-interactions:default')).toBe(false)
    const leaked = vi.fn()
    client.on('session.command', leaked)
    server.clearSessionHistory('s2')
    server.sessionMap.get('s1').isWorking = false
    const run = vi.spyOn(server, 'handleRun').mockImplementation(async (socket: any, data: any) => socket.emit('accepted', data))
    const accepted = once(client, 'accepted')
    client.emit('run', { session_id: 's1', input: 'same message flow' })
    expect((await accepted).input).toBe('same message flow')
    expect(run).toHaveBeenCalledOnce()
    expect(leaked).not.toHaveBeenCalled()
    const denied = once(client, 'run.failed')
    client.emit('run', { session_id: 's2', input: 'forbidden' })
    expect((await denied).error).toBe('share_session_mismatch')
    expect(run).toHaveBeenCalledOnce()
    server.sessionMap.get('s1').isWorking = false
    vi.stubEnv('HERMES_WEB_UI_URL', origin)
    run.mockImplementationOnce(async (socket: any) => {
      socket.emit('run.started', { session_id: 's1', run_id: 'http-run' })
      socket.emit('run.completed', { session_id: 's1', run_id: 'http-run', output: 'shared HTTP reply' })
    })
    expect(await request(token, '/api/studio/chat-run/runs', 'POST', { session_id: 's1', input: 'HTTP message' }))
      .toMatchObject({ status: 200, body: { ok: true, session_id: 's1', output: 'shared HTTP reply' } })
  })

  it('uses the existing terminal protocol, isolates PTYs and kills them after revocation even while disconnected', async () => {
    const { setupMobileTerminal } = await import('../../packages/server/src/modules/hermes/sockets/mobile-terminal')
    terminalService = setupMobileTerminal(io, context => ['s1', 's2'].includes(context.sourceId) ? { profile: 'default', workspace: join(root, 'workspace') } : null)
    const first = await issue({ terminal: true })
    const second = await issue({ terminal: true })
    const readonly = await issue()
    const connect = async (token: string, sourceId = 's1', appAccessToken = 'cloud-bob') => {
      const client = connectClient(origin + '/terminal', { transports: ['websocket'], reconnection: false,
        auth: { shareToken: token, appAccessToken }, query: { source: 'single', sourceId, profile: 'default' } })
      clients.push(client)
      await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject) })
      return client
    }
    await expect(connect(readonly.token)).rejects.toThrow('share_permission_denied')
    await expect(connect(first.token, 's2')).rejects.toThrow('terminal_invalid_context')
    const one = await connect(first.token)
    const two = await connect(second.token)
    const created = await one.timeout(1000).emitWithAck('terminal.create', { requestId: 'terminal-share-1', cols: 80, rows: 24 })
    expect(created.ok).toBe(true)
    const terminalId = created.data.terminal.id
    expect(await two.timeout(1000).emitWithAck('terminal.list', {})).toMatchObject({ data: { terminals: [] } })
    expect(await two.timeout(1000).emitWithAck('terminal.attach', { terminalId })).toMatchObject({ ok: false })
    one.disconnect()
    const renewed = await connect(first.token, 's1', 'cloud-bob-renewed')
    invalidIdentityTokens.add('cloud-bob')
    await vi.waitFor(() => expect(two.connected).toBe(false), { timeout: 2500 })
    expect(processes[0].kill).not.toHaveBeenCalled()
    expect(await renewed.timeout(1000).emitWithAck('terminal.list', {})).toMatchObject({ data: { terminals: [{ id: terminalId }] } })
    renewed.disconnect()
    invalidIdentityTokens.clear()
    await service.change(7, 's1', first.record.id, { revoke: true })
    expect(processes[0].kill).toHaveBeenCalledOnce()
    await expect(connect(first.token)).rejects.toThrow('share_revoked')
  })

  it('reads the same session routes and rejects another session, global APIs, profile overrides and wrong App identity', async () => {
    const { token } = await issue()
    const result = await request(token, '/api/studio/sessions/conversations/s1/messages')
    expect(result.status).toBe(200)
    expect(result.body.messages[0].content).toBe('message from s1')
    expect(result.headers.get('cache-control')).toBe('no-store')
    expect((await request(token, '/api/studio/sessions/s1')).status).toBe(200)
    for (const path of ['/api/studio/sessions/s2', '/api/studio/sessions', '/api/studio/sessions/count', '/api/studio/sessions/s1/shares', '/api/studio/config']) {
      expect((await request(token, path)).status).toBe(403)
    }
    expect((await request(token, '/api/studio/sessions/s1?profile=other')).status).toBe(403)
    expect((await request(token, '/api/studio/sessions/s1', 'GET', undefined, { 'X-App-Access-Token': 'wrong' })).status).toBe(401)
    expect((await request(token, '/api/studio/chat-run/runs', 'POST', { input: 'hello' })).status).toBe(400)
    expect((await request(token, '/api/studio/sessions/s1', 'DELETE')).status).toBe(403)
  })

  it('gates settings independently, validates the catalog and preserves reasoning when changing models', async () => {
    const { updateSession, getSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    updateSession('s1', { source: 'coding_agent', agent: 'codex', model: 'before', reasoning_effort: 'high' })
    const readonly = await issue()
    for (const [suffix, body] of [['model', { model: 'model-a', provider: 'custom:test' }], ['reasoning-effort', { reasoningEffort: 'low' }], ['workspace', { workspace: join(root, 'workspace') }]] as const) {
      expect((await request(readonly.token, '/api/studio/sessions/s1/' + suffix, 'POST', body)).status).toBe(403)
    }
    for (const suffix of ['share-models', 'share-workspaces']) expect((await request(readonly.token, '/api/studio/sessions/s1/' + suffix)).status).toBe(403)
    const model = await issue({ switchModel: true })
    const catalog = await request(model.token, '/api/studio/sessions/s1/share-models')
    expect(catalog).toMatchObject({ status: 200, body: { groups: [{ provider: 'custom:test', models: ['model-a'] }] } })
    expect(JSON.stringify(catalog.body)).not.toMatch(/private-provider|api_key|base_url/)
    expect((await request(model.token, '/api/studio/sessions/s2/model', 'POST', { model: 'model-a', provider: 'custom:test' })).status).toBe(403)
    for (const body of [{ model: 'disabled', provider: 'custom:test' }, { model: 'not-listed', provider: 'custom:test' }, { model: 'model-a', provider: 'custom:test', reasoningEffort: 'low' }, { model: 'model-a', provider: 'custom:test', apiKey: 'injected' }]) {
      expect((await request(model.token, '/api/studio/sessions/s1/model', 'POST', body)).status).toBe(400)
    }
    expect((await request(model.token, '/api/studio/sessions/s1/model', 'POST', { model: 'model-a', provider: 'custom:test', apiMode: 'anthropic_messages' })).status).toBe(200)
    expect(getSession('s1')).toMatchObject({ model: 'model-a', provider: 'custom:test', api_mode: 'chat_completions', reasoning_effort: 'high' })
    expect((await request(model.token, '/api/studio/sessions/s1/reasoning-effort', 'POST', { reasoningEffort: 'low' })).status).toBe(403)
    const effort = await issue({ reasoningEffort: true })
    expect((await request(effort.token, '/api/studio/sessions/s1/model', 'POST', { model: 'model-a', provider: 'custom:test' })).status).toBe(403)
    expect((await request(effort.token, '/api/studio/sessions/s1/reasoning-effort', 'POST', { reasoningEffort: 'invalid' })).status).toBe(400)
    expect((await request(effort.token, '/api/studio/sessions/s1/reasoning-effort', 'POST', { reasoningEffort: 'low' })).status).toBe(200)
    expect(getSession('s1')?.reasoning_effort).toBe('low')
    await service.change(7, 's1', model.record.id, { permissions: { switchModel: false } })
    expect((await request(model.token, '/api/studio/sessions/s1/model', 'POST', { model: 'model-a', provider: 'custom:test' })).status).toBe(403)
  })

  it('switches only within granted roots and applies relative file paths to the new workspace', async () => {
    const base = join(root, 'workspace'), child = join(base, 'child')
    await mkdir(child); await mkdir(join(base, '.ssh'))
    await symlink(root, join(base, 'escape'))
    await symlink(join(base, '.ssh'), join(base, 'hidden-alias'))
    await writeFile(join(child, 'note.txt'), 'child file')
    const { token } = await issue({ switchWorkspace: true, workspaceRead: true })
    const fixed = await issue({ input: true })
    const folders = await request(token, '/api/studio/sessions/s1/share-workspaces?path=' + encodeURIComponent(base))
    expect(folders.status).toBe(200)
    expect(folders.body.folders.map((folder: any) => folder.name)).toEqual(['child'])
    for (const path of [root, join(base, '..'), join(base, 'escape'), join(base, '.ssh'), join(base, 'hidden-alias'), 'child', null]) {
      expect((await request(token, '/api/studio/sessions/s1/workspace', 'POST', { workspace: path })).status).toBe(403)
    }
    expect((await request(token, '/api/studio/sessions/s1/workspace', 'POST', { workspace: child })).status).toBe(200)
    expect((await request(token, '/api/studio/sessions/s1/workspace-file/read?path=note.txt')).body.content).toBe('child file')
    expect((await request(fixed.token, '/api/studio/chat-run/runs', 'POST', { session_id: 's1', input: 'hello' })).body.code).toBe('share_workspace_changed')
    expect((await request(token, '/api/studio/sessions/s1/workspace', 'POST', { workspace: base })).status).toBe(200)
    expect((await request(token, '/api/studio/sessions/s2/workspace', 'POST', { workspace: child })).status).toBe(403)
  })

  it('enforces file actions and both rename paths in the real workspace controllers', async () => {
    const { token, record } = await issue({ workspaceRead: true, workspaceWrite: true })
    const workspace = join(root, 'workspace')
    await writeFile(join(workspace, 'visible.txt'), 'allowed')
    await writeFile(join(root, 'outside.txt'), 'outside')
    await writeFile(join(workspace, '.env'), 'secret')
    await symlink(root, join(workspace, 'escape'))
    expect(await request(token, '/api/studio/sessions/s1/workspace-file/read?path=visible.txt')).toMatchObject({ status: 200, body: { content: 'allowed' } })
    for (const path of ['../outside.txt', 'escape/outside.txt', '.env']) {
      expect((await request(token, '/api/studio/sessions/s1/workspace-file/read?path=' + encodeURIComponent(path))).status).toBe(403)
    }
    expect((await request(token, '/api/studio/sessions/s1/workspace-files/list')).body.entries.map((e: any) => e.name)).toEqual(['visible.txt'])
    expect((await request(token, '/api/studio/sessions/s1/workspace-file/rename', 'POST', { oldPath: 'visible.txt', newPath: '../moved.txt' })).status).toBe(403)
    expect(await readFile(join(workspace, 'visible.txt'), 'utf8')).toBe('allowed')
    expect((await request(token, '/api/studio/sessions/s1/workspace-file/content?path=visible.txt&download=1')).status).toBe(403)
    await service.change(7, 's1', record.id, { permissions: { workspaceWrite: false, download: true } })
    expect((await request(token, '/api/studio/sessions/s1/workspace-file/write', 'PUT', { path: 'visible.txt', content: 'changed' })).status).toBe(403)
    expect((await request(token, '/api/studio/files/download?path=visible.txt')).body).toBe('allowed')
    expect((await request(token, '/api/studio/sessions/s1/export?mode=compressed')).status).toBe(403)
  })

  it('binds upload chunks and downloads to the session without granting workspace access', async () => {
    const first = await issue({ upload: true, download: true, workspaceRead: true })
    const second = await issue({ upload: true, download: true }, 's2')
    expect((await request(first.token, '/api/studio/app-uploads', 'POST', { id: 'upload-1111', name: 'note.txt', size: 5 })).status).toBe(200)
    expect((await request(second.token, '/api/studio/app-uploads/upload-1111/chunks?offset=0', 'PUT', 'hello')).status).toBe(403)
    expect((await request(first.token, '/api/studio/app-uploads/upload-1111/chunks?offset=0', 'PUT', 'hello')).status).toBe(200)
    const result = await request(first.token, '/api/studio/app-uploads/upload-1111/complete', 'POST', {})
    expect(result.status).toBe(200)
    const path = '/api/studio/files/download?path=' + encodeURIComponent(result.body.files[0].path)
    expect((await request(first.token, path)).body).toBe('hello')
    const contentPath = '/api/studio/sessions/s1/workspace-file/content?download=1&path=' + encodeURIComponent(result.body.files[0].path)
    expect((await request(first.token, contentPath)).body).toBe('hello')
    expect((await request(second.token, path)).status).toBe(403)
    const otherAccess = await accessModule.authenticateSessionShare(second.token, 'cloud-bob')
    const otherRoot = await accessModule.authorizeShareUpload(otherAccess)
    await mkdir(otherRoot, { recursive: true })
    await writeFile(join(otherRoot, basename(result.body.files[0].path)), 'other session')
    await rm(dirname(result.body.files[0].path), { recursive: true })
    await symlink(otherRoot, dirname(result.body.files[0].path))
    expect((await request(first.token, path)).status).toBe(403)
    await service.change(7, 's1', first.record.id, { revoke: true })
    expect((await request(first.token, path)).status).toBe(410)
  })

  it('includes only this session’s structured historical uploads in preview and download scope', async () => {
    const { addMessage } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    await mkdir(join(root, 'uploads'))
    const own = join(root, 'uploads', 'a'.repeat(16) + '.md')
    const other = join(root, 'uploads', 'b'.repeat(24) + '.md')
    const mentioned = join(root, 'uploads', 'c'.repeat(16) + '.md')
    for (const path of [own, other, mentioned]) await writeFile(path, 'attachment')
    const historical = Math.floor(Date.now() / 1000) - 60
    addMessage({ session_id: 's1', role: 'user', content: JSON.stringify([{ type: 'file', path: own, name: '旧附件.md' }]), timestamp: historical })
    addMessage({ session_id: 's2', role: 'user', content: JSON.stringify([{ type: 'image', path: other }]), timestamp: historical })
    addMessage({ session_id: 's1', role: 'user', content: `[file](${mentioned})`, timestamp: historical })
    const share = await issue({ download: true, workspaceRead: true, workspaceWrite: true })
    const url = (path: string) => '/api/studio/files/download?path=' + encodeURIComponent(path)
    expect(await request(share.token, url(own))).toMatchObject({ status: 200, body: 'attachment' })
    expect(await request(share.token, '/api/studio/sessions/s1/workspace-file/content?text=1&path=' + encodeURIComponent(own)))
      .toMatchObject({ status: 200, body: 'attachment' })
    expect(await request(share.token, '/api/studio/sessions/s1/workspace-file/content?download=1&path=' + encodeURIComponent(own)))
      .toMatchObject({ status: 200, body: 'attachment' })
    for (const path of [other, mentioned, join(root, 'uploads')]) expect((await request(share.token, url(path))).status).toBe(403)
    // A recipient cannot turn a later stored message into a new file grant.
    addMessage({ session_id: 's1', role: 'user', content: JSON.stringify([{ type: 'file', path: other }]), timestamp: historical + 3600 })
    expect((await request(share.token, url(other))).status).toBe(403)
    expect((await request(share.token, '/api/studio/sessions/s1/workspace-file/write', 'PUT', { path: own, content: 'changed' })).status).toBe(403)
    expect(await readFile(own, 'utf8')).toBe('attachment')
    await service.change(7, 's1', share.record.id, { permissions: { download: false } })
    expect((await request(share.token, url(own))).status).toBe(403)
    expect((await request(share.token, '/api/studio/sessions/s1/workspace-file/content?text=1&path=' + encodeURIComponent(own))).status).toBe(200)
    await service.change(7, 's1', share.record.id, { revoke: true })
    expect((await request(share.token, url(own))).status).toBe(410)
  })

  it.each(['file', 'image'])('preserves a first-message %s upload grant when the new session is created and shared', async type => {
    const { recordSessionUploadAttachments } = await import('../../packages/server/src/modules/studio/services/files/session-uploads')
    const { sessionUploadsStore } = await import('../../packages/server/src/modules/studio/repositories/session-uploads-store')
    const { createSession, getSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    await mkdir(join(root, 'uploads'))
    const own = join(root, 'uploads', 'd'.repeat(24) + '.txt')
    await writeFile(own, 'first attachment')
    const input = [{ type, path: own }]
    expect(getSession('new-local-session')).toBeFalsy()
    await recordSessionUploadAttachments('new-local-session', 'default', input)
    expect(sessionUploadsStore.find('new-local-session', 'default', own)).toBeUndefined()
    await recordSessionUploadAttachments('new-local-session', 'default', input, { allowPendingSession: true })
    expect(sessionUploadsStore.find('new-local-session', 'default', own)).toBe(await realpath(own))
    expect(getSession('new-local-session')).toBeFalsy()
    createSession({ id: 'new-local-session', profile: 'default', source: 'cli' })
    const share = await issue({ download: true }, 'new-local-session')
    expect(await request(share.token, '/api/studio/files/download?path=' + encodeURIComponent(own)))
      .toMatchObject({ status: 200, body: 'first attachment' })
    await recordSessionUploadAttachments('s1', 'another-profile', input, { allowPendingSession: true })
    expect(sessionUploadsStore.find('s1', 'another-profile', own)).toBeUndefined()
  })

  it('records host attachments after sharing without exposing other uploads or symlink targets', async () => {
    const { recordSessionUploadAttachments } = await import('../../packages/server/src/modules/studio/services/files/session-uploads')
    const share = await issue({ download: true })
    await mkdir(join(root, 'uploads'))
    const own = join(root, 'uploads', 'd'.repeat(24) + '.txt')
    const other = join(root, 'uploads', 'e'.repeat(24) + '.txt')
    await writeFile(own, 'new attachment'); await writeFile(other, 'private')
    const url = '/api/studio/files/download?path=' + encodeURIComponent(own)
    expect((await request(share.token, url)).status).toBe(403)
    await recordSessionUploadAttachments('s2', 'default', [{ type: 'file', path: own }])
    expect((await request(share.token, url)).status).toBe(403)
    await recordSessionUploadAttachments('s1', 'another-profile', [{ type: 'file', path: own }])
    expect((await request(share.token, url)).status).toBe(403)
    await recordSessionUploadAttachments('s1', 'default', [{ type: 'file', path: own }])
    expect(await request(share.token, url)).toMatchObject({ status: 200, body: 'new attachment' })
    // Authorization survives process-level service instances because the grant is persisted.
    const store = (await import('../../packages/server/src/modules/studio/repositories/session-uploads-store')).sessionUploadsStore
    expect(store.find('s1', 'default', own)).toBe(await realpath(own))
    await rm(own); await symlink(other, own)
    expect((await request(share.token, url)).status).toBe(403)
    await recordSessionUploadAttachments('s1', 'default', [{ type: 'file', path: own }])
    expect((await request(share.token, url)).status).toBe(403)
  })

  it('serves session attachments without a workspace, but does not grant download by enabling upload', async () => {
    const { updateSession, addMessage } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    updateSession('s1', { workspace: null })
    await mkdir(join(root, 'uploads'))
    const path = join(root, 'uploads', 'f'.repeat(16) + '.md')
    await writeFile(path, 'without workspace')
    addMessage({ session_id: 's1', role: 'user', content: JSON.stringify([{ type: 'file', path }]), timestamp: Math.floor(Date.now() / 1000) - 60 })
    const share = await issue({ download: true })
    const url = '/api/studio/sessions/s1/workspace-file/content?download=1&path=' + encodeURIComponent(path)
    expect(await request(share.token, url)).toMatchObject({ status: 200, body: 'without workspace' })
    const uploadOnly = await issue({ upload: true })
    expect((await request(uploadOnly.token, url)).status).toBe(403)
    const reader = await issue({ workspaceRead: true })
    expect((await request(reader.token, url)).status).toBe(403)
    expect((await request(reader.token, url.replace('download=1', 'text=1'))).status).toBe(200)
  })

  it('checks every Socket packet, strips execution overrides and closes on policy change', async () => {
    const { token, record } = await issue({ input: true })
    const client = await socket(token)
    let denied = once(client, 'run.failed')
    client.emit('resume', { session_id: 's2' })
    expect((await denied).error).toBe('share_session_mismatch')
    expect(delivered).not.toHaveBeenCalled()
    denied = once(client, 'run.failed')
    client.emit('app.subscribe', { session_id: 's1' })
    expect((await denied).error).toBe('share_event_forbidden')
    denied = once(client, 'run.failed')
    client.emit('run', { session_id: 's1', input: '/branch' })
    expect((await denied).error).toBe('share_session_command_forbidden')
    denied = once(client, 'run.failed')
    client.emit('run', { session_id: 's1', input: 'hello', workspace: root })
    expect((await denied).error).toBe('share_workspace_changed')
    const accepted = once(client, 'accepted')
    client.emit('run', { session_id: 's1', input: 'hello', apiKey: 'override', mcpServers: {}, group_room_id: 'foreign', instructions: 'override', model: 'forged', provider: 'forged', reasoning_effort: 'max' })
    const { data } = await accepted
    expect(data).toMatchObject({ session_id: 's1', input: 'hello', workspace: join(root, 'workspace'), source: 'cli' })
    expect(data.model).not.toBe('forged'); expect(data.provider).not.toBe('forged'); expect(data.reasoning_effort).not.toBe('max')
    for (const key of ['apiKey', 'mcpServers', 'group_room_id', 'instructions']) expect(data).not.toHaveProperty(key)
    const disconnected = once(client, 'disconnect')
    await service.change(7, 's1', record.id, { permissions: { input: false } })
    await disconnected
    const readonly = await socket(token)
    denied = once(readonly, 'run.failed')
    readonly.emit('run', { session_id: 's1', input: 'no' })
    expect((await denied).error).toBe('share_permission_denied')
    const resumed = once(readonly, 'accepted')
    readonly.emit('resume', { session_id: 's1' })
    expect((await resumed).event).toBe('resume')
  })

  it('revalidates App identity on commands and while idle', async () => {
    const { token } = await issue({ input: true })
    const client = await socket(token)
    identityValid = false
    const denied = once(client, 'run.failed')
    const disconnected = once(client, 'disconnect')
    client.emit('run', { session_id: 's1', input: 'no' })
    expect((await denied).error).toBe('share_app_login_required')
    expect(delivered).not.toHaveBeenCalled()
    await disconnected
  })
})

describe('shared speech authorization', () => {
  const synthPath = '/api/studio/sessions/s1/share-voice/synthesize'
  const transcribePath = '/api/studio/sessions/s1/share-voice/transcribe'
  const audioBody = '--voice\r\nContent-Disposition: form-data; name="audio"; filename="speech.mp3"\r\nContent-Type: audio/mpeg\r\n\r\naudio-bytes\r\n--voice--\r\n'
  const audioHeaders = { 'Content-Type': 'multipart/form-data; boundary=voice' }

  it('defaults to denied and bounds voice grants to one session without exposing settings', async () => {
    const denied = await issue({ input: true, upload: true })
    for (const path of [synthPath, transcribePath]) expect((await request(denied.token, path, 'POST', { text: 'hello' })).status).toBe(403)
    const allowed = await issue({ voice: true })
    for (const path of [synthPath, transcribePath]) expect((await request(allowed.token, path.replace('/s1/', '/s2/'), 'POST', { text: 'hello' })).status).toBe(403)
    for (const path of ['/api/studio/tts/settings', '/api/studio/stt/settings']) expect((await request(allowed.token, path)).status).toBe(403)
    for (const path of ['/api/studio/tts/synthesize', '/api/studio/stt/transcribe']) expect((await request(allowed.token, path, 'POST', { text: 'hello' })).status).toBe(403)
    expect(speechSynthesize).not.toHaveBeenCalled()
    expect(speechTranscribe).not.toHaveBeenCalled()
    expect((await request(allowed.token, synthPath, 'POST', { text: 'hello' })).body).toBe('mp3-audio')
    expect(speechSynthesize).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello' }), expect.objectContaining({ format: 'mp3' }))
    // Speech alone does not authorize sending the recognized text.
    expect((await request(allowed.token, '/api/studio/chat-run/runs', 'POST', { session_id: 's1', input: 'hello' })).status).toBe(403)
    await service.change(7, 's1', allowed.record.id, { permissions: { voice: false } })
    expect((await request(allowed.token, synthPath, 'POST', { text: 'hello' })).status).toBe(403)
  })

  it('uses the bound Profile active STT settings and rejects provider/options overrides', async () => {
    const settings = await import('../../packages/server/src/modules/studio/public/voice-settings')
    settings.saveSttProviderSetting('default', 'openai', { settings: { model: 'host-model' }, secrets: { apiKey: 'host-secret' } })
    settings.saveActiveSttProvider('default', 'openai')
    const allowed = await issue({ voice: true })
    const result = await request(allowed.token, transcribePath, 'POST', audioBody, audioHeaders)
    expect(result).toMatchObject({ status: 200, body: { text: 'recognized speech' } })
    expect(speechTranscribe).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai', audio: Buffer.from('audio-bytes'), settings: expect.objectContaining({ model: 'host-model' }), secrets: expect.objectContaining({ apiKey: 'host-secret' }) }))
    expect(JSON.stringify(result.body)).not.toContain('host-secret')
    for (const name of ['provider', 'apiKey', 'profile']) {
      const overridden = `--voice\r\nContent-Disposition: form-data; name="${name}"\r\n\r\nother\r\n` + audioBody
      expect((await request(allowed.token, transcribePath, 'POST', overridden, audioHeaders)).status).toBe(400)
    }
    for (const body of [{ text: 'hello', provider: 'custom' }, { text: 'hello', options: { apiKey: 'evil', baseUrl: 'https://evil.test' } }, { text: 'hello', profile: 'other' }, { text: 'x'.repeat(5001) }]) {
      expect((await request(allowed.token, synthPath, 'POST', body)).status).toBeGreaterThanOrEqual(400)
    }
    expect(speechTranscribe).toHaveBeenCalledTimes(1)
    const { SttNoSpeechDetectedError } = await import('../../packages/server/src/modules/studio/services/voice/stt/types')
    speechTranscribe.mockRejectedValueOnce(new SttNoSpeechDetectedError('no speech'))
    expect(await request(allowed.token, transcribePath, 'POST', audioBody, audioHeaders)).toMatchObject({ status: 200, body: { text: '', provider: 'openai' } })
    expect(speechSynthesize).not.toHaveBeenCalled()
  })

  it('aborts pending synthesis when voice permission is revoked', async () => {
    const allowed = await issue({ voice: true })
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    let signal!: AbortSignal
    speechSynthesize.mockImplementationOnce(({ signal: incoming }) => {
      signal = incoming
      started()
      return new Promise((_resolve, reject) => incoming.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
    })
    const result = request(allowed.token, synthPath, 'POST', { text: 'hello' }).catch(error => error)
    await ready
    await service.change(7, 's1', allowed.record.id, { permissions: { voice: false } })
    await result
    await vi.waitFor(() => {
      expect(signal.aborted).toBe(true)
    })
  })
})
