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
import { leaseEkkoMcpServers } from '../../packages/server/src/modules/studio/services/chat-run/ekko-mcp-lease'

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

async function issue(sessionId: string, options: { userId?: number; isActive?: () => boolean; contextId?: string; contextLookup?: boolean } = {}) {
  sessions.push(sessionId)
  const file = await runMcpCredentials.issue({
    sessionId, contextId: options.contextId || `context-${sessionId}`, profile: 'research',
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
  const a = await leaseEkkoMcpServers(servers, { sessionId: 'direct', profile: 'research', userId: 7, signal: controller.signal })
  const b = await leaseEkkoMcpServers(servers, { sessionId: 'direct', profile: 'research', userId: 7, signal: new AbortController().signal })
  const file = (lease: typeof a) => (lease.servers!['ekko-studio-browser'] as any).env.HERMES_WEB_UI_RUN_TOKEN_FILE
  try {
    const credential = JSON.parse(readFileSync(file(a), 'utf8'))
    expect(runMcpCredentials.authenticate(credential.token)).toMatchObject({ sessionId: 'direct', userId: 7, profile: 'research' })
    const ctx = context(credential, '/api/studio/jev/settings', { method: 'GET', request: { body: {} } })
    const next = vi.fn(async () => {})
    await requireUserJwt(ctx, next)
    expect(next).toHaveBeenCalledOnce()
    expect((a.servers!['ekko-studio-browser'] as any).env.AUTH_TOKEN).toBe('')
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

it.each(['/api/studio/task-plans/update', '/api/studio/clarifications/request'])('authorizes only the current anonymous interaction: %s', async path => {
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

function mcpClient(url: string, file: string, contextLookup = false) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ['bin/ekko-studio-mcp.mjs', 'plan'], {
    env: { ...process.env, HERMES_WEB_UI_URL: url, HERMES_WEB_UI_PROFILE: 'research', HERMES_WEB_UI_RUN_TOKEN_FILE: file,
      HERMES_MCP_CONTEXT_CREDENTIALS: contextLookup ? '1' : '',
      HERMES_WEB_UI_TOKEN: 'stale-env-token', AUTH_TOKEN: 'stale-static-token', HERMES_MCP_USER_CLARIFICATION: '1' },
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
  return {
    child,
    async call(args: any, tool = 'ekko_studio_update_plan') {
      const requestId = ++id
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name: tool, arguments: args } })}\n`)
      await vi.waitFor(() => expect(responses.has(requestId)).toBe(true), { timeout: 5000 })
      return responses.get(requestId).result
    },
  }
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
  const start = (session: string) => plans.begin(session, 'research', () => ({ isWorking: true, activeRunMarker: `turn-${session}` }))
  const [a, b] = await Promise.all([issue('mcp-a', { contextId: start('mcp-a') }), issue('mcp-b', { contextId: start('mcp-b') })])
  writeFileSync(join(home, '.token'), 'stale-static-token')
  expect(existsSync(join(home, 'profiles', 'research', '.model-run-token'))).toBe(false)
  const app = new Koa()
  app.use(bodyParser())
  app.use(requireUserJwt)
  app.use(resolveUserProfile)
  app.use(ctx => {
    const body = ctx.request.body as any
    ctx.body = ctx.path === '/api/studio/clarifications/request'
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
