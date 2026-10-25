import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import Koa from 'koa'
import { bodyParser } from '@koa/bodyparser'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RunMcpCredentials, runMcpContextTokenPath, runMcpCredentials } from '../../packages/server/src/modules/studio/services/auth/run-mcp-credentials'
import { requireUserJwt, resolveUserProfile, signUserJwt } from '../../packages/server/src/modules/studio/middleware/auth'
import { TaskPlanError, TaskPlanRuns } from '../../packages/server/src/modules/studio/services/task-plan-runs'
import { groupRunUser } from '../../packages/server/src/modules/studio/services/group-chat/run-user'
import { isSensitivePath } from '../../packages/server/src/modules/studio/services/files/file-policy'
import { leaseStudioMcpServers } from '../../packages/server/src/modules/studio/services/mcp/credential-lease'
import { NativeMcpCredentialSlot } from '../../packages/server/src/modules/studio/services/mcp/native-credential-slot'
import { getRunRequestContext } from '../../packages/server/src/modules/studio/services/auth/run-request-context'

const users = vi.hoisted(() => ({
  findUserById: vi.fn(), userCanAccessProfile: vi.fn(() => true),
  listUserProfiles: vi.fn(() => [{ profile_name: 'research' }]), touchUserLogin: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => users)

let home: string
const sessions: string[] = []
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'studio-run-mcp-'))
  vi.stubEnv('HERMES_WEB_UI_HOME', home)
  vi.stubEnv('AUTH_JWT_SECRET', 'fixture-secret')
  users.findUserById.mockReset().mockReturnValue({ id: 7, username: 'requester', role: 'user', status: 'active' })
  users.userCanAccessProfile.mockReset().mockReturnValue(true)
})
afterEach(() => {
  for (const session of sessions.splice(0)) runMcpCredentials.revoke(session)
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

async function issue(sessionId: string, options: { runId?: string; userId?: number; isActive?: () => boolean; contextId?: string; contextLookup?: boolean } = {}) {
  sessions.push(sessionId)
  const file = await runMcpCredentials.issue({
    sessionId, runId: options.runId, contextId: options.contextId || `context-${sessionId}`, profile: 'research',
    roomId: `room-${sessionId}`, agentId: 'codex', isActive: options.isActive || (() => true),
    ...(options.userId !== undefined ? { userId: options.userId } : {}),
  }, { contextLookup: options.contextLookup })
  return { file, ...JSON.parse(readFileSync(file, 'utf8')) }
}

function context(credential: any, path = '/api/studio/task-plans/update', overrides: Record<string, any> = {}): any {
  const headers = { authorization: `Bearer ${credential.token}`, 'x-hermes-profile': 'research', 'x-studio-run-context': credential.context_id, ...overrides.headers }
  return {
    path, method: 'POST', query: {}, state: {}, status: 200,
    request: { body: { context_id: credential.context_id } },
    ...overrides,
    headers,
    get: (name: string) => headers[name.toLowerCase()] || '',
  }
}

it('isolates concurrent credentials, removes files, and rejects credentials after restart', async () => {
  const [a, b] = await Promise.all([issue('a'), issue('b')])
  expect(a.file).not.toBe(b.file)
  expect(isSensitivePath(a.file)).toBe(true)
  expect(a.token).not.toBe(b.token)
  if (process.platform !== 'win32') expect(statSync(a.file).mode & 0o777).toBe(0o600)
  expect(new RunMcpCredentials().authenticate(a.token)).toBeUndefined()
  runMcpCredentials.revoke('a')
  expect(existsSync(a.file)).toBe(false)
  expect(existsSync(dirname(a.file))).toBe(false)
  expect(runMcpCredentials.authenticate(a.token)).toBeUndefined()
  expect(runMcpCredentials.authenticate(b.token)?.sessionId).toBe('b')
  const replacement = await issue('b', { contextId: 'next-turn' })
  runMcpCredentials.revoke('b', b.context_id)
  expect(runMcpCredentials.authenticate(b.token)).toBeUndefined()
  expect(runMcpCredentials.authenticate(replacement.token)?.contextId).toBe('next-turn')
})

it('exposes canonical Run identity only within an authenticated credential request, never from a forged header or body', async () => {
  const credential = await issue('owned', { userId: 7, runId: 'canonical-run' })
  const request = context(credential, '/api/studio/sessions/owned', { method: 'DELETE', request: { body: { run_id: 'forged' } } })
  await requireUserJwt(request, async () => {
    expect(getRunRequestContext(request)).toEqual({ runId: 'canonical-run', sessionId: 'owned', profile: 'research' })
    expect(request.state).not.toHaveProperty('runId')
  })
  expect(getRunRequestContext(request)).toBeUndefined()
  const token = signUserJwt({ id: 7, username: 'requester', role: 'user' }, 'fixture-secret')
  const ordinary = context({ token, context_id: 'canonical-run' }, '/api/studio/sessions/owned', { method: 'DELETE', request: { body: { run_id: 'canonical-run' } } })
  const next = vi.fn(async () => { expect(getRunRequestContext(ordinary)).toBeUndefined() })
  await requireUserJwt(ordinary, next)
  expect(next).toHaveBeenCalledOnce()
})

it('revokes an aborted preparation without leaving a usable credential or file', async () => {
  const pending = issue('preparing')
  runMcpCredentials.revoke('preparing')
  await expect(pending).rejects.toThrow('ended while preparing')
})

it('leases authenticated direct-chat MCP credentials without replacing a running background context', async () => {
  const controller = new AbortController()
  const servers = { 'ekko-studio-browser': { command: 'node', env: {
    HERMES_WEB_UI_MANAGED_MCP: '1', AUTH_TOKEN: 'stale-static-token',
  } }, custom: { command: 'custom' } }
  const a = await leaseStudioMcpServers(servers, { sessionId: 'direct', profile: 'research', agentId: 'ekko-agent', nativeTaskPlan: true, userId: 7, signal: controller.signal })
  const b = await leaseStudioMcpServers(servers, { sessionId: 'direct', profile: 'research', agentId: 'ekko-agent', nativeTaskPlan: true, userId: 7, signal: new AbortController().signal })
  const file = (lease: typeof a) => (lease.servers!['ekko-studio-browser'] as any).env.HERMES_WEB_UI_RUN_TOKEN_FILE
  try {
    const credential = JSON.parse(readFileSync(file(a), 'utf8'))
    expect(runMcpCredentials.authenticate(credential.token)).toMatchObject({ sessionId: 'direct', userId: 7, profile: 'research' })
    const ctx = context(credential, '/api/studio/jev/settings', { method: 'GET', request: { body: {} } })
    const next = vi.fn(async () => {})
    await requireUserJwt(ctx, next)
    expect(next).toHaveBeenCalledOnce()
    expect((a.servers!['ekko-studio-browser'] as any).env.AUTH_TOKEN).toBe('')
    expect((a.servers!['ekko-studio-browser'] as any).requestTimeoutMs).toBe(300_000)
    expect(a.servers!.custom).toBe(servers.custom)
    expect(servers['ekko-studio-browser'].env.AUTH_TOKEN).toBe('stale-static-token')
    controller.abort()
    expect(a.signal.aborted).toBe(true)
    expect(existsSync(file(a))).toBe(false)
    expect(runMcpCredentials.authenticate(credential.token)).toBeUndefined()
    expect(existsSync(file(b))).toBe(true)
  } finally { a.dispose(); b.dispose() }
  expect(existsSync(file(b))).toBe(false)
})

it('rebuilds a credential-bearing managed transport instead of trusting its configured command, URL or env', async () => {
  const servers = { 'ekko-studio-api': { command: 'untrusted-command', args: ['private-arg'], type: 'streamable_http',
    url: 'https://untrusted.example/mcp', headers: { authorization: 'private-header' }, env: {
      HERMES_WEB_UI_MANAGED_MCP: '1', HERMES_WEB_UI_URL: 'https://untrusted.example', HERMES_WEB_UI_HOME: '/untrusted',
      AUTH_TOKEN: 'private-static', HERMES_WEB_UI_TOKEN: 'private-static', ELECTRON_RUN_AS_NODE: '0', CUSTOM_SECRET: 'private-env',
    }, supports_parallel_tool_calls: true, requestTimeoutMs: 120_000 } }
  const lease = await leaseStudioMcpServers(servers, { sessionId: 'safe-local', profile: 'research', agentId: 'test.plugin/agent',
    userId: 7, signal: new AbortController().signal })
  try {
    const configured = lease.servers!['ekko-studio-api'] as any
    expect(configured).toMatchObject({ command: process.execPath, args: [join(process.cwd(), 'bin/ekko-studio-mcp.mjs'), 'api'], supports_parallel_tool_calls: true, requestTimeoutMs: 120_000,
      env: { ELECTRON_RUN_AS_NODE: '1', AUTH_TOKEN: '', HERMES_WEB_UI_TOKEN: '', HERMES_WEB_UI_HOME: home,
        HERMES_WEB_UI_PROFILE: 'research', HERMES_MCP_USER_CLARIFICATION: '1' } })
    expect(configured.env.HERMES_WEB_UI_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(configured.type).toBeUndefined(); expect(configured.url).toBeUndefined(); expect(configured.headers).toBeUndefined()
    expect(JSON.stringify(configured)).not.toMatch(/untrusted|private-arg|private-header|private-static|private-env/)
    const credential = JSON.parse(readFileSync(configured.env.HERMES_WEB_UI_RUN_TOKEN_FILE, 'utf8'))
    expect(runMcpCredentials.authenticate(credential.token)).toMatchObject({ sessionId: 'safe-local', profile: 'research', agentId: 'test.plugin/agent', userId: 7 })
  } finally { lease.dispose() }
})

it('does not issue credentials for disabled managed servers or unrelated external servers', async () => {
  const servers = {
    'ekko-studio-api': { enabled: false, command: 'disabled', env: { HERMES_WEB_UI_MANAGED_MCP: '1' } },
    'ekko-studio-browser': { disabled: true, command: 'disabled', env: { HERMES_WEB_UI_MANAGED_MCP: '1' } },
    external: { command: 'external', env: { HERMES_WEB_UI_MANAGED_MCP: '1' } },
  }
  const lease = await leaseStudioMcpServers(servers, { sessionId: 'disabled', profile: 'research', agentId: 'ekko-agent', signal: new AbortController().signal })
  try {
    expect(lease.servers).toBe(servers)
    expect(existsSync(join(home, 'runtime', 'mcp-credentials'))).toBe(false)
  } finally { lease.dispose() }
})

it('preserves native interaction ownership while refreshing managed credentials', async () => {
  const lease = await leaseStudioMcpServers({ 'ekko-studio-use': { env: { HERMES_WEB_UI_MANAGED_MCP: '1' } } }, {
    sessionId: 'native', profile: 'research', agentId: 'ekko-agent', nativeTaskPlan: true, signal: new AbortController().signal,
  })
  try {
    const env = (lease.servers!['ekko-studio-use'] as any).env
    expect(env.HERMES_MCP_NATIVE_TASK_PLAN).toBe('1')
    expect(env.HERMES_MCP_USER_CLARIFICATION).toBeUndefined()
  } finally { lease.dispose() }
})

it('maps the interaction server name to the existing plan transport toolset', async () => {
  const lease = await leaseStudioMcpServers({ 'ekko-studio-interaction': { env: { HERMES_WEB_UI_MANAGED_MCP: '1' } } }, {
    sessionId: 'interaction', profile: 'research', agentId: 'test.plugin/agent', signal: new AbortController().signal,
  })
  try {
    const server = lease.servers!['ekko-studio-interaction'] as any
    expect(server.args.at(-1)).toBe('plan')
    expect(server.env).toMatchObject({ HERMES_MCP_SERVER_NAME: 'ekko-studio-interaction', HERMES_MCP_TOOLSET: 'plan' })
  } finally { lease.dispose() }
})

it.each(['/api/studio/task-plans/update', '/api/studio/clarifications/request', '/api/studio/session-tasks/list', '/api/studio/session-tasks/update'])('authorizes only the current anonymous interaction: %s', async path => {
  let current = true
  const credential = await issue('anonymous', { isActive: () => current })
  const ctx = context(credential, path)
  const next = vi.fn(async () => {})
  await requireUserJwt(ctx, next)
  expect(next).toHaveBeenCalledOnce()
  expect(ctx.state).toEqual({ profile: { name: 'research' } })
  expect(users.findUserById).not.toHaveBeenCalled()
  current = false
  const stale = context(credential, path)
  await requireUserJwt(stale, vi.fn())
  expect(stale.status).toBe(401)
})

it.each([
  { path: '/api/studio/sessions' },
  { method: 'GET' },
  { headers: { 'x-studio-run-context': 'other-turn' } },
  { headers: { 'x-hermes-profile': 'other-profile' } },
  { query: { profile: 'other-profile' } },
  { request: { body: { context_id: 'other-turn' } } },
  { request: { body: { context_id: 'context-denied', profile: 'other-profile' } } },
])('rejects a foreign scope or non-interaction request: %j', async overrides => {
  const credential = await issue('denied')
  const ctx = context(credential, '/api/studio/task-plans/update', overrides)
  const next = vi.fn()
  await requireUserJwt(ctx, next)
  expect(ctx.status).toBe(403)
  expect(next).not.toHaveBeenCalled()
})

it('delegates only the local requester permissions and rechecks disabled users and revoked profiles', async () => {
  const credential = await issue('account', { userId: 7 })
  const ctx = context(credential, '/api/studio/sessions')
  const next = vi.fn(async () => {})
  await requireUserJwt(ctx, next)
  expect(ctx.state.user).toMatchObject({ id: 7, role: 'user' })
  expect(next).toHaveBeenCalledOnce()
  users.findUserById.mockReturnValue({ id: 7, username: 'requester', role: 'user', status: 'disabled' })
  const disabled = context(credential)
  await requireUserJwt(disabled, vi.fn())
  expect(disabled.status).toBe(403)
  users.findUserById.mockReturnValue({ id: 7, username: 'requester', role: 'user', status: 'active' })
  users.userCanAccessProfile.mockReturnValue(false)
  const revoked = context(credential)
  await requireUserJwt(revoked, vi.fn())
  expect(revoked.status).toBe(403)
})

it('uses local member records and never borrows the room owner or a remote sender identity', () => {
  const message = { role: 'user', senderId: 'auth:7' }
  const local = { getMemberByUserId: vi.fn(() => ({ authUserId: 7 })) }
  expect(groupRunUser(local, 'room', 'research', message)?.id).toBe(7)
  expect(groupRunUser(local, 'room', 'research', { ...message, role: 'assistant' })).toBeUndefined()
  const remote = { getRoom: () => ({ ownerAuthUserId: 7 }), getRoomMembers: () => [{ ...message, authUserId: 7 }] }
  expect(groupRunUser(remote, 'room', 'research', message)).toBeUndefined()
  expect(groupRunUser({ getMemberByUserId: () => null }, 'room', 'research', message)).toBeUndefined()
  users.userCanAccessProfile.mockReturnValue(false)
  expect(groupRunUser(local, 'room', 'research', message)).toBeUndefined()
})

function mcpClient(url: string, file: string, contextLookup = false, boundContext = false, toolset = 'plan', envOverrides: Record<string, string> = {}) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ['bin/ekko-studio-mcp.mjs', toolset], {
    env: { ...process.env, HERMES_WEB_UI_URL: url, HERMES_WEB_UI_PROFILE: 'research', HERMES_WEB_UI_RUN_TOKEN_FILE: file,
      HERMES_MCP_CONTEXT_CREDENTIALS: contextLookup ? '1' : '', HERMES_MCP_RUN_BOUND_CONTEXT: boundContext ? '1' : '',
      HERMES_WEB_UI_TOKEN: 'stale-env-token', AUTH_TOKEN: 'stale-static-token', HERMES_MCP_USER_CLARIFICATION: '1', ...envOverrides },
  })
  const responses = new Map<number, any>()
  let buffer = ''
  let id = 0
  child.stdout.on('data', chunk => {
    buffer += chunk
    let end: number
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      if (line.trim()) { const message = JSON.parse(line); responses.set(message.id, message) }
    }
  })
  const rpc = async (method: string, params: unknown) => {
    const requestId = ++id
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`)
    await vi.waitFor(() => expect(responses.has(requestId)).toBe(true), { timeout: 5000 })
    return responses.get(requestId).result
  }
  return { child, initialize: () => rpc('initialize', {}), list: () => rpc('tools/list', {}), call: (args: unknown, tool = 'ekko_studio_update_plan') => rpc('tools/call', { name: tool, arguments: args }) }

}

it('never grants account permissions to credentials selected by a shared MCP context', async () => {
  await expect(issue('context-account', { userId: 7, contextLookup: true })).rejects.toThrow('cannot delegate account permissions')
})

it('serves concurrent group contexts through one shared MCP process despite an expired profile JWT', async () => {
  const plans = new TaskPlanRuns(vi.fn(), vi.fn())
  let active = true
  const start = (session: string) => plans.begin(session, 'research', () => ({ isWorking: true, activeRunMarker: session }))
  const [a, b] = await Promise.all([
    issue('old-room', { contextId: start('old-room'), contextLookup: true, isActive: () => active }),
    issue('new-room', { contextId: start('new-room'), contextLookup: true }),
  ])
  expect(a.file).toBe(runMcpContextTokenPath('research', a.context_id))
  expect(isSensitivePath(a.file)).toBe(true)
  const profileFile = join(home, 'profiles', 'research', '.model-run-token')
  mkdirSync(dirname(profileFile), { recursive: true })
  const expired = signUserJwt({ id: 7, username: 'requester', role: 'user' }, 'fixture-secret', Date.now() - 7200000, 3600)
  writeFileSync(profileFile, expired)
  const app = new Koa()
  app.use(bodyParser())
  app.use(requireUserJwt)
  app.use(resolveUserProfile)
  app.use(ctx => {
    const body = ctx.request.body as any
    try {
      ctx.body = { ok: true, ...plans.update(body.context_id, ctx.state.profile!.name, body) }
    } catch (error) {
      if (!(error instanceof TaskPlanError)) throw error
      ctx.status = error.status
      ctx.body = { error: error.message }
    }
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const url = `http://127.0.0.1:${(server.address() as any).port}`
  const client = mcpClient(url, '', true)
  const input = (contextId: string) => ({ context_id: contextId, plan: [{ id: 'work', step: 'Inspect', status: 'in_progress' }] })
  try {
    expect((await fetch(`${url}/api/studio/task-plans/update`, { method: 'POST', headers: { Authorization: `Bearer ${expired}` } })).status).toBe(401)
    const results = await Promise.all([a, b].map(credential => client.call({ ...input(credential.context_id), token: 'stale-tool-token' })))
    expect(results.map(result => JSON.parse(result.content[0].text).session_id)).toEqual(['old-room', 'new-room'])
    expect(readFileSync(profileFile, 'utf8')).toBe(expired)
    expect((await client.call({ ...input(a.context_id), profile: 'foreign-profile' })).isError).toBe(true)

    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 7200000)
    try {
      const next = vi.fn(async () => {})
      await requireUserJwt(context(a), next)
      expect(next).toHaveBeenCalledOnce()
    } finally { clock.mockRestore() }

    active = false
    expect((await client.call(input(a.context_id))).isError).toBe(true)
    expect(JSON.parse((await client.call(input(b.context_id))).content[0].text).ok).toBe(true)
    plans.finish(a.context_id, 'interrupted')
    runMcpCredentials.revoke('old-room')
    expect(existsSync(a.file)).toBe(false)
    expect((await client.call(input(a.context_id))).isError).toBe(true)

    // A shared MCP also serves ordinary single-chat plans using the existing JWT.
    const valid = signUserJwt({ id: 7, username: 'requester', role: 'user' }, 'fixture-secret')
    writeFileSync(profileFile, valid)
    expect(JSON.parse((await client.call({ ...input(start('ordinary-chat')), token: valid })).content[0].text).session_id).toBe('ordinary-chat')
    expect((await client.call({ ...input(a.context_id), token: valid })).content[0].text).toContain('context is unavailable or has expired')
    const original = readFileSync(b.file, 'utf8')
    writeFileSync(b.file, 'malformed credential')
    expect((await client.call({ ...input(b.context_id), token: valid })).content[0].text).toContain('credential is unavailable')
    writeFileSync(b.file, original)
    expect(JSON.parse((await client.call(input(b.context_id))).content[0].text).ok).toBe(true)
    plans.finish(b.context_id, 'ended')
    runMcpCredentials.revoke('new-room')
    expect((await client.call({ ...input(b.context_id), token: valid })).content[0].text).toContain('context is unavailable or has expired')
    expect(client.child.exitCode).toBeNull()
  } finally {
    client.child.kill()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

it('round-trips real MCP processes through HTTP auth for simultaneous fresh profiles and fails closed after revocation', async () => {
  const plans = new TaskPlanRuns(() => {}, () => {})
  const start = (session: string) => plans.begin(session, 'research', () => ({ isWorking: true, activeRunMarker: `turn-${session}` }), undefined, true)
  const [a, b] = await Promise.all([issue('mcp-a', { contextId: start('mcp-a') }), issue('mcp-b', { contextId: start('mcp-b') })])
  writeFileSync(join(home, '.token'), 'stale-static-token')
  expect(existsSync(join(home, 'profiles', 'research', '.model-run-token'))).toBe(false)
  const app = new Koa()
  app.use(bodyParser())
  app.use(requireUserJwt)
  app.use(resolveUserProfile)
  app.use(ctx => {
    const body = ctx.request.body as any
    ctx.body = ctx.path.startsWith('/api/studio/session-tasks/')
      ? { ok: true, session_id: plans.sessionForContext(body.context_id, ctx.state.profile!.name), revision: body.revision ?? 0, changes: body.changes, tasks: [] }
      : ctx.path === '/api/studio/clarifications/request'
        ? { ok: true, response: 'approved text' }
        : { ok: true, ...plans.update(body.context_id, ctx.state.profile!.name, body) }
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const url = `http://127.0.0.1:${(server.address() as any).port}`
  const clients = [mcpClient(url, a.file), mcpClient(url, b.file)]
  const input = (contextId: string) => ({ context_id: contextId, plan: [{ id: 'work', step: 'Implement', status: 'in_progress' }], token: 'ignored-tool-override' })
  try {
    const results = await Promise.all(clients.map((client, index) => client.call(input([a, b][index].context_id))))
    expect(results.map(result => JSON.parse(result.content[0].text).session_id)).toEqual(['mcp-a', 'mcp-b'])
    const foreign = await clients[0].call(input(b.context_id))
    expect(foreign.isError).toBe(true)
    const answer = await clients[0].call({ context_id: a.context_id, question: 'Choose a folder' }, 'ekko_studio_clarify')
    expect(JSON.parse(answer.content[0].text).response).toBe('approved text')
    const read = await clients[0].call({ context_id: a.context_id }, 'ekko_studio_list_session_tasks')
    expect(JSON.parse(read.content[0].text).session_id).toBe('mcp-a')
    const changes = [{ title: 'Export', summary: 'Requested', status: 'open' }]
    const write = await clients[0].call({ context_id: a.context_id, revision: 0, changes }, 'ekko_studio_update_session_tasks')
    expect(JSON.parse(write.content[0].text)).toMatchObject({ session_id: 'mcp-a', changes })
    const foreignGoals = await clients[0].call({ context_id: b.context_id }, 'ekko_studio_list_session_tasks')
    expect(foreignGoals.isError).toBe(true)
    runMcpCredentials.revoke('mcp-a')
    expect((await clients[0].call(input(a.context_id))).content[0].text).toContain('credential is unavailable')
    expect((await clients[1].call({ ...input(b.context_id), profile: 'other' })).isError).toBe(true)
    expect(JSON.parse((await clients[1].call(input(b.context_id))).content[0].text).revision).toBe(2)
  } finally {
    for (const { child } of clients) child.kill()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

it('does not let a turn credential mint account-wide API keys or enumerate other Profiles', async () => {
  const credential = await issue('model-api', { userId: 7 })
  for (const path of ['/api/studio/models/api-keys', '/api/ekko-studio/models/v1/models', '/api/ekko-studio/models/v1/responses']) {
    const ctx = context(credential, path)
    const next = vi.fn()
    await requireUserJwt(ctx, next)
    expect(ctx.status).toBe(403)
    expect(next).not.toHaveBeenCalled()
  }
})

it('rotates one native MCP process through a stable private path while revoking each previous turn', async () => {
  const slot = new NativeMcpCredentialSlot(), servers = { 'ekko-studio-interaction': { env: { HERMES_WEB_UI_MANAGED_MCP: '1' } } }
  const first = await slot.begin(servers, { sessionId: 'native-slot', profile: 'research', agentId: 'test.plugin/agent', userId: 7, signal: new AbortController().signal })
  const file = (first.servers['ekko-studio-interaction'] as any).env.HERMES_WEB_UI_RUN_TOKEN_FILE
  const credential = JSON.parse(readFileSync(file, 'utf8'))
  expect(isSensitivePath(file)).toBe(true)
  if (process.platform !== 'win32') { expect(statSync(file).mode & 0o777).toBe(0o600); expect(statSync(dirname(file)).mode & 0o777).toBe(0o700) }
  const app = new Koa()
  app.use(bodyParser()); app.use(requireUserJwt); app.use(resolveUserProfile)
  app.use(ctx => { ctx.body = { ok: true, context_id: (ctx.request.body as any).context_id } })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const client = mcpClient(`http://127.0.0.1:${(server.address() as any).port}`, file, false, true)
  const input = (contextId: string) => ({ context_id: contextId, plan: [{ id: 'work', step: 'Implement', status: 'in_progress' }] })
  try {
    expect(JSON.parse((await client.call(input(credential.context_id))).content[0].text).context_id).toBe(credential.context_id)
    await expect(slot.begin(servers, { sessionId: 'overlap', profile: 'research', agentId: 'test.plugin/agent', userId: 7, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(runMcpCredentials.authenticate(credential.token)).toBeDefined()
    await first.dispose()
    expect(existsSync(file)).toBe(false)
    expect(runMcpCredentials.authenticate(credential.token)).toBeUndefined()
    expect((await client.call(input(credential.context_id))).isError).toBe(true)
    const controller = new AbortController()
    const second = await slot.begin(servers, { sessionId: 'native-slot', profile: 'research', agentId: 'test.plugin/agent', userId: 7, signal: controller.signal })
    expect((second.servers['ekko-studio-interaction'] as any).env.HERMES_WEB_UI_RUN_TOKEN_FILE).toBe(file)
    const next = JSON.parse(readFileSync(file, 'utf8'))
    expect(next.token).not.toBe(credential.token)
    expect(next.context_id).not.toBe(credential.context_id)
    expect((await client.call(input(credential.context_id))).isError).toBe(true)
    expect(JSON.parse((await client.call(input(next.context_id))).content[0].text).context_id).toBe(next.context_id)
    await first.dispose() // late cleanup cannot remove the next turn's file
    expect(existsSync(file)).toBe(true)
    controller.abort(); await second.dispose()
    expect(existsSync(file)).toBe(false)
    expect(runMcpCredentials.authenticate(next.token)).toBeUndefined()
    expect(client.child.exitCode).toBeNull()
  } finally {
    await slot.close(); client.child.kill(); server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

it('exposes only the task card in a background native interaction process and rejects hidden goal/question calls', async () => {
  const slot = new NativeMcpCredentialSlot()
  const lease = await slot.begin({ 'ekko-studio-interaction': { env: { HERMES_WEB_UI_MANAGED_MCP: '1' } } }, {
    sessionId: 'background-chat', profile: 'research', agentId: 'test.plugin/agent', userId: 7, contextId: 'background-plan',
    sessionTasks: false, userClarification: false, signal: new AbortController().signal,
  })
  const env = (lease.servers['ekko-studio-interaction'] as any).env
  const client = mcpClient('http://127.0.0.1:1', env.HERMES_WEB_UI_RUN_TOKEN_FILE, false, true, 'plan', env)
  try {
    const initialized = await client.initialize()
    expect(initialized.instructions).toContain('ekko_studio_update_plan')
    expect(initialized.instructions).not.toContain('ekko_studio_list_session_tasks')
    expect(initialized.instructions).not.toContain('ekko_studio_clarify')
    expect((await client.list()).tools.map((tool: any) => tool.name)).toEqual(['ekko_studio_update_plan'])
    for (const tool of ['ekko_studio_list_session_tasks', 'ekko_studio_update_session_tasks', 'ekko_studio_clarify']) {
      expect((await client.call({ context_id: 'background-plan' }, tool)).isError).toBe(true)
    }
  } finally { client.child.kill(); await slot.close() }
})

it('keeps custom native MCP definitions unchanged and never aliases caller-selected credential paths', async () => {
  const slot = new NativeMcpCredentialSlot(), servers = {
    custom: { command: 'custom', env: { HERMES_WEB_UI_RUN_TOKEN_FILE: '/not-a-host-credential', HERMES_WEB_UI_MANAGED_MCP: '1' } },
    'ekko-studio-interaction': { disabled: true, command: 'disabled', env: { HERMES_WEB_UI_MANAGED_MCP: '1' } },
  }
  try {
    const lease = await slot.begin(servers, { sessionId: 'custom-native-slot', profile: 'research', agentId: 'test.plugin/agent', signal: new AbortController().signal })
    expect(lease.servers).toEqual(servers)
    await lease.dispose()
  } finally { await slot.close() }
})

it('cleans an aborted native credential preparation before allowing another turn, and rejects use after runtime close', async () => {
  const slot = new NativeMcpCredentialSlot(), controller = new AbortController()
  const servers = { 'ekko-studio-use': { env: { HERMES_WEB_UI_MANAGED_MCP: '1' } } }
  const pending = slot.begin(servers, { sessionId: 'aborted-native-slot', profile: 'research', agentId: 'test.plugin/agent', signal: controller.signal })
  controller.abort()
  await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
  const next = await slot.begin(servers, { sessionId: 'aborted-native-slot', profile: 'research', agentId: 'test.plugin/agent', signal: new AbortController().signal })
  const file = (next.servers['ekko-studio-use'] as any).env.HERMES_WEB_UI_RUN_TOKEN_FILE
  const credential = JSON.parse(readFileSync(file, 'utf8'))
  await slot.close()
  expect(existsSync(file)).toBe(false)
  expect(runMcpCredentials.authenticate(credential.token)).toBeUndefined()
  await expect(slot.begin(servers, { sessionId: 'closed-slot', profile: 'research', agentId: 'test.plugin/agent', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
})

it.each(['api', 'browser'])('binds cached native %s tools to the supplied turn context and fresh HTTP authorization', async toolset => {
  const slot = new NativeMcpCredentialSlot(), name = `ekko-studio-${toolset}`
  const servers = { [name]: { env: { HERMES_WEB_UI_MANAGED_MCP: '1' } } }
  const begin = () => slot.begin(servers, { sessionId: 'strict-native-context', profile: 'research', agentId: 'test.plugin/agent', userId: 7, signal: new AbortController().signal })
  const first = await begin(), file = (first.servers[name] as any).env.HERMES_WEB_UI_RUN_TOKEN_FILE
  expect((first.servers[name] as any).env.HERMES_MCP_RUN_BOUND_CONTEXT).toBe('1')
  const requests: string[] = [], app = new Koa()
  app.use(bodyParser()); app.use(async (ctx, next) => { requests.push(ctx.path); await next() })
  app.use(requireUserJwt); app.use(resolveUserProfile)
  app.use(ctx => { ctx.body = { ok: true, context_id: ctx.get('x-studio-run-context'), tabs: [] } })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const url = `http://127.0.0.1:${(server.address() as any).port}`
  if (toolset === 'browser') {
    mkdirSync(join(home, 'desktop-browser'), { mode: 0o700 })
    writeFileSync(join(home, 'desktop-browser', 'broker.json'), JSON.stringify({ schema: 1, endpoint: `${url}/v1`, token: 'direct-broker-token', desktopPid: process.pid, instanceId: 'broker-fixture' }), { mode: 0o600 })
  }
  const client = mcpClient(url, file, false, true, toolset)
  const tool = toolset === 'api' ? 'ekko_studio_api_request' : 'ekko_studio_browser_toolset'
  const args = toolset === 'api' ? { method: 'GET', path: '/api/openapi.json' } : { action: 'call', tool: 'ekko_studio_browser_tabs', arguments: { action: 'list' } }
  const contextId = (result: any) => { const payload = JSON.parse(result.content[0].text); return (payload.body || payload).context_id }
  try {
    expect((await client.list()).tools.every((entry: any) => entry.inputSchema.required.includes('context_id'))).toBe(true)
    expect((await client.call(args, tool)).isError).toBe(true)
    expect(requests).toEqual([])
    expect(contextId(await client.call({ ...args, context_id: first.contextId }, tool))).toBe(first.contextId)
    expect(requests).toEqual([toolset === 'api' ? '/api/openapi.json' : '/api/studio/desktop-browser/request'])
    await first.dispose()
    const second = await begin()
    expect(second.contextId).not.toBe(first.contextId)
    expect((await client.call({ ...args, context_id: first.contextId }, tool)).isError).toBe(true)
    expect(requests).toHaveLength(1)
    expect(contextId(await client.call({ ...args, context_id: second.contextId, token: 'ignored-profile-token' }, tool))).toBe(second.contextId)
    users.userCanAccessProfile.mockReturnValue(false)
    const revoked = await client.call({ ...args, context_id: second.contextId }, tool)
    if (toolset === 'api') expect(JSON.parse(revoked.content[0].text).status).toBe(403)
    else expect(revoked.isError).toBe(true)
    expect(client.child.exitCode).toBeNull()
    await second.dispose()
  } finally {
    await slot.close(); client.child.kill(); server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

it('rejects a delayed native API call after credential rotation before dispatching its mutation', async () => {
  const slot = new NativeMcpCredentialSlot(), servers = { 'ekko-studio-api': { env: { HERMES_WEB_UI_MANAGED_MCP: '1' } } }
  const begin = () => slot.begin(servers, { sessionId: 'delayed-native-api', profile: 'research', agentId: 'test.plugin/agent', userId: 7, signal: new AbortController().signal })
  const first = await begin(), file = (first.servers['ekko-studio-api'] as any).env.HERMES_WEB_UI_RUN_TOKEN_FILE
  let entered!: () => void, release!: () => void
  const reading = new Promise<void>(resolve => { entered = resolve }), barrier = new Promise<void>(resolve => { release = resolve })
  const requests: string[] = [], app = new Koa()
  app.use(bodyParser()); app.use(requireUserJwt); app.use(resolveUserProfile)
  app.use(async ctx => {
    requests.push(ctx.path)
    if (ctx.path === '/api/openapi.json') {
      entered(); await barrier
      ctx.body = { openapi: '3.1.0', paths: { '/api/studio/fixture-mutation': { post: { responses: { '200': { description: 'Fixture' } } } } } }
    } else ctx.body = { context_id: ctx.get('x-studio-run-context') }
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const client = mcpClient(`http://127.0.0.1:${(server.address() as any).port}`, file, false, true, 'api')
  const args = { method: 'POST', path: '/api/studio/fixture-mutation' }
  try {
    const oldCall = client.call({ ...args, context_id: first.contextId }, 'ekko_studio_api_request')
    await reading
    await first.dispose()
    const second = await begin()
    release()
    expect((await oldCall).isError).toBe(true)
    expect(requests).toEqual(['/api/openapi.json'])
    const response = await client.call({ ...args, context_id: second.contextId }, 'ekko_studio_api_request')
    expect(JSON.parse(response.content[0].text).body.context_id).toBe(second.contextId)
    expect(requests).toEqual(['/api/openapi.json', '/api/studio/fixture-mutation'])
    await second.dispose()
  } finally {
    release(); await slot.close(); client.child.kill(); server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
