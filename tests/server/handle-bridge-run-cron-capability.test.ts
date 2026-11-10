import './fixtures/isolated-studio-state'
import { describe, expect, it } from 'vitest'

const STUDIO = '../../packages/server/src/modules/studio'

describe('handleBridgeRun trusted Cron capability', () => {
  it('a live turn issues the real capability once and forwards it to bridge.chat; an autonomous turn issues nothing', async () => {
    await import('../../packages/server/src/bootstrap/agent-profile-adapter')
    ;(await import(`${STUDIO}/infrastructure/database/schemas`)).initAllHermesTables()
    const users = await import(`${STUDIO}/repositories/users-store`)
    const store = await import(`${STUDIO}/repositories/session-store`)
    const member = users.createUser({ username: 'hb-member', password: 'password-1', role: 'admin', status: 'active', profiles: ['default'] })
    store.createSession({ id: 'hb-1', profile: 'default', source: 'cli', studio_user_id: member.id })
    const { handleBridgeRun } = await import(`${STUDIO}/services/chat-run/handle-bridge-run`)
    const recorded: any[] = []; const events: any[] = []
    const bridge: any = new Proxy({}, { get: (_t, key) => async (...args: any[]) => { recorded.push([String(key), args]); if (key === 'chat') throw new Error('stop after forwarding'); return {} } })
    const socket: any = { id: 's', data: { user: { id: member.id } }, emit: (e: string, p: any) => events.push(['socket', e, JSON.stringify(p).slice(0, 300)]), join: () => {}, connected: true, to: (room: string) => ({ emit: (e: string, p: any) => events.push(['socket-to:' + room, e, JSON.stringify(p).slice(0, 200)]) }) }
    const nsp: any = { to: (room: string) => ({ emit: (e: string, p: any) => events.push(['room:' + room, e, JSON.stringify(p).slice(0, 300)]) }), adapter: { rooms: new Map() }, sockets: new Map() }
    const trusted = await import(`${STUDIO}/public/trusted-cron`)
    const { runMcpCredentials } = await import(`${STUDIO}/services/auth/run-mcp-credentials`)
    trusted.updateTrustedCronPolicy(member.id, 'default', true, trusted.trustedCronPolicy(member.id, 'default').revision)
    const issued: string[] = []
    const issue = () => { const token = trusted.issueTrustedCronCapability({ accountId: member.id, profile: 'default', sessionId: 'hb-1', contextId: 'turn-1', isActive: () => true })!; issued.push(token); return token }
    const run = (extra: any) => handleBridgeRun(nsp, socket, { session_id: 'hb-1', input: 'hi', studio_cron_issue: issue, ...extra } as any,
      'default', new Map(), bridge, false, async () => ({ messages: [] } as any), () => {}).catch((e: any) => e)
    await run({})
    const chats = recorded.filter(([key]) => key === 'chat').map(([, args]) => args[5])
    expect(issued).toHaveLength(1)
    expect(chats[0]?.studio_cron_capability).toBe(issued[0])
    // The issued credential is the real one: bound to this account, profile, session and turn context.
    expect(runMcpCredentials.authenticate(issued[0])).toMatchObject({ sessionId: 'hb-1', contextId: 'turn-1', profile: 'default', cron: { accountId: member.id } })
    await run({ autonomous: true })
    expect(issued).toHaveLength(1)
    expect(recorded.filter(([key]) => key === 'chat').map(([, args]) => args[5])[1]?.studio_cron_capability).toBeUndefined()
  })

  it('the turn-end cleanup revokes exactly the turn capability on completion, failure and abort', async () => {
    await import('../../packages/server/src/bootstrap/agent-profile-adapter')
    ;(await import(`${STUDIO}/infrastructure/database/schemas`)).initAllHermesTables()
    const users = await import(`${STUDIO}/repositories/users-store`)
    const store = await import(`${STUDIO}/repositories/session-store`)
    const trusted = await import(`${STUDIO}/public/trusted-cron`)
    const { runMcpCredentials } = await import(`${STUDIO}/services/auth/run-mcp-credentials`)
    const { ChatRunSocket } = await import(`${STUDIO}/sockets/chat-run`)
    const member = users.createUser({ username: 'hb-cleanup', password: 'password-1', role: 'admin', status: 'active', profiles: ['default'] })
    store.createSession({ id: 'hb-2', profile: 'default', source: 'cli', studio_user_id: member.id })
    trusted.updateTrustedCronPolicy(member.id, 'default', true, trusted.trustedCronPolicy(member.id, 'default').revision)
    const live = Object.create(ChatRunSocket.prototype)
    live.clarificationRuns = { finishSession: () => {} }; live.taskPlanRuns = { finish: () => {}, finishSession: () => {} }; live.sessionMap = new Map()
    const issue = (contextId: string) => trusted.issueTrustedCronCapability({ accountId: member.id, profile: 'default', sessionId: 'hb-2', contextId, isActive: () => true })!
    for (const event of ['run.completed', 'run.failed', 'abort.completed']) {
      const turn = issue(`turn-${event}`), other = issue(`other-${event}`)
      live.finishTaskPlanRun('hb-2', 'message.delta', undefined, `turn-${event}`)
      expect(runMcpCredentials.authenticate(turn)).toMatchObject({ sessionId: 'hb-2', contextId: `turn-${event}`, cron: { accountId: member.id } })
      live.finishTaskPlanRun('hb-2', event, undefined, `turn-${event}`)
      expect(runMcpCredentials.authenticate(turn)).toBeUndefined()
      // Another context of the same session keeps its own authority.
      expect(runMcpCredentials.authenticate(other)).toMatchObject({ contextId: `other-${event}` })
    }
  })

  it('socket auth marks only an interactive login token as a login credential', async () => {
    process.env.AUTH_JWT_SECRET = 'socket-auth-test-secret'
    ;(await import(`${STUDIO}/infrastructure/database/schemas`)).initAllHermesTables()
    const users = await import(`${STUDIO}/repositories/users-store`)
    const auth = await import(`${STUDIO}/middleware/auth`)
    const { ChatRunSocket } = await import(`${STUDIO}/sockets/chat-run`)
    const member = users.createUser({ username: 'hb-socket', password: 'password-1', role: 'admin', status: 'active', profiles: ['default'] })
    const live = Object.create(ChatRunSocket.prototype)
    const connect = async (token: string) => {
      const socket: any = { handshake: { auth: { token }, query: { profile: 'default' }, headers: {} }, data: {} }
      const error = await new Promise<any>(resolve => live.authMiddleware(socket, resolve))
      return { error: error ? String(error.message) : null, user: socket.data.user?.id, loginCredential: socket.data.loginCredential }
    }
    expect(await connect(await auth.issueUserJwt(member))).toEqual({ error: null, user: member.id, loginCredential: true })
    const runtime = await connect(await auth.issueModelRunJwt(member))
    expect(runtime.loginCredential).not.toBe(true)
  })
})
