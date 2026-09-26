import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import Koa from 'koa'
import { bodyParser } from '@koa/bodyparser'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RunMcpCredentials, runMcpCredentials } from '../../packages/server/src/modules/studio/services/auth/run-mcp-credentials'
import { requireUserJwt, resolveUserProfile } from '../../packages/server/src/modules/studio/middleware/auth'
import { TaskPlanRuns } from '../../packages/server/src/modules/studio/services/task-plan-runs'
import { groupRunUser } from '../../packages/server/src/modules/studio/services/group-chat/run-user'
import { isSensitivePath } from '../../packages/server/src/modules/studio/services/files/file-policy'

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

async function issue(sessionId: string, options: { userId?: number; isActive?: () => boolean; contextId?: string } = {}) {
  sessions.push(sessionId)
  const file = await runMcpCredentials.issue({
    sessionId, contextId: options.contextId || `context-${sessionId}`, profile: 'research',
    roomId: `room-${sessionId}`, agentId: 'codex', isActive: options.isActive || (() => true),
    ...(options.userId !== undefined ? { userId: options.userId } : {}),
  })
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

function mcpClient(url: string, file: string) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ['bin/ekko-studio-mcp.mjs', 'plan'], {
    env: { ...process.env, HERMES_WEB_UI_URL: url, HERMES_WEB_UI_PROFILE: 'research', HERMES_WEB_UI_RUN_TOKEN_FILE: file,
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
