import { afterEach, describe, expect, it, vi } from 'vitest'
import * as chatRuntime from '../../packages/server/src/modules/studio/public/chat-agent-runtime'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { createSession, deleteSession } from '../../packages/server/src/modules/studio/repositories/session-store'
import { ChatRunSocket } from '../../packages/server/src/modules/studio/sockets/chat-run'

// repair-release@1 R1 / @2 S1: a live passive notice reaches only users allowed to see the owning
// session and profile at publication time, including members already in the session room.
function makeServer() {
  const sockets = new Map<string, any>()
  const rooms = new Map<string, Set<string>>()
  const join = (room: string, id: string) => rooms.set(room, new Set([...(rooms.get(room) || []), id]))
  const to = (target: string | string[]) => ({
    emit: (event: string, payload: unknown) => {
      const ids = new Set((Array.isArray(target) ? target : [target]).flatMap(room => [...(rooms.get(room) || [])]))
      for (const id of ids) sockets.get(id)?.emit(event, payload)
    },
    except: () => ({ emit: vi.fn() }),
  })
  // socket.io's local adapter semantics for `nsp.in(room).socketsLeave(room)`.
  const leave = (room: string) => ({
    socketsLeave: (left: string | string[]) => {
      for (const id of [...(rooms.get(room) || [])]) {
        for (const name of Array.isArray(left) ? left : [left]) { rooms.get(name)?.delete(id); sockets.get(id)?.rooms.delete(name) }
      }
    },
  })
  const nsp: any = { use: vi.fn(), on: vi.fn(), to, in: leave, emit: vi.fn(), adapter: { rooms }, sockets }
  vi.spyOn(chatRuntime, 'createPrimaryAgentBridge').mockReturnValue({} as any)
  const server: any = new ChatRunSocket({ of: () => nsp } as any)
  vi.spyOn(server, 'canAccessProfile').mockImplementation((user: any, profile: any) =>
    user.role === 'super_admin' || user.profiles.includes(profile))
  vi.spyOn(server, 'resumeSession').mockResolvedValue(undefined)
  // A real connection: the production handshake handlers, room joins and read authorization.
  const connect = (id: string, data: Record<string, unknown>, profile = 'default', handshake = true) => {
    const received: any[] = []
    const handlers = new Map<string, Function>()
    const socket: any = {
      id, connected: true, data, rooms: new Set<string>(), handshake: { auth: {}, query: { profile } },
      emit: (event: string, payload: unknown) => { received.push({ event, payload }); return true },
      join: (room: string) => { socket.rooms.add(room); join(room, id) },
      to: () => ({ emit: vi.fn() }),
      on: (event: string, handler: Function) => { handlers.set(event, handler) },
      use: vi.fn(),
    }
    sockets.set(id, socket)
    if (handshake) server.onConnection(socket)
    const notices = () => received.filter(entry => entry.event === 'session.notice')
    return { socket, received, notices, handlers, resume: (sessionId: string) => handlers.get('resume')!({ session_id: sessionId }) }
  }
  return { server, connect, nsp, rooms }
}

let counter = 0
const record = (sessionId: string, profile: string) => ({
  id: 7, namespace: 'inst', profile, producer_key: `cron:job-1:e${counter += 1}`, session_id: sessionId, kind: 'cron',
  disposition: 'notified', attention_pending: 1, created_at: Date.now(), updated_at: Date.now(), projected_at: null,
  payload: { job_id: 'job-1', job_name: 'Private brief', execution_id: 'e1', status: 'completed', success: true, content: 'SECRET_RESULT' },
})
const sessionId = () => `notice-recipients-${Date.now()}-${counter += 1}`

afterEach(() => vi.restoreAllMocks())

describe('R1 live session.notice recipients', () => {
  it('reaches an authorized off-focus user and the session room, never a disjoint-profile user', async () => {
    initAllHermesTables()
    const sid = sessionId()
    createSession({ id: sid, profile: 'default', source: 'cli' })
    const { server, connect } = makeServer()
    const owner = connect('owner', { user: { id: 1, role: 'super_admin', profiles: [] } })
    const viewer = connect('viewer', { user: { id: 2, role: 'admin', profiles: ['default'] } })
    const outsider = connect('outsider', { user: { id: 3, role: 'admin', profiles: ['other'] } }, 'other')
    await viewer.resume(sid)
    expect(viewer.socket.rooms.has(`session:${sid}`)).toBe(true)

    server.publishSessionNotice(record(sid, 'default'))

    expect(owner.notices()).toHaveLength(1)
    expect(viewer.notices()).toHaveLength(1)
    expect(JSON.stringify(outsider.received)).not.toContain('SECRET_RESULT')
    expect(JSON.stringify(outsider.received)).not.toContain(sid)
  })
})

describe('S1 recipients are re-authorized at publication, including existing room members', () => {
  it('a viewer who joined before delete and recreation under another profile receives nothing', async () => {
    initAllHermesTables()
    const sid = sessionId()
    createSession({ id: sid, profile: 'default', source: 'cli' })
    const { server, connect } = makeServer()
    const staleViewer = connect('stale', { user: { id: 2, role: 'admin', profiles: ['default'] } })
    const newOwner = connect('new-owner', { user: { id: 3, role: 'admin', profiles: ['other'] } }, 'other')
    await staleViewer.resume(sid)
    expect(staleViewer.socket.rooms.has(`session:${sid}`)).toBe(true)

    deleteSession(sid)
    createSession({ id: sid, profile: 'other', source: 'cli' })
    server.publishSessionNotice(record(sid, 'other'))

    expect(JSON.stringify(staleViewer.received)).not.toContain('SECRET_RESULT')
    expect(JSON.stringify(staleViewer.received)).not.toContain('Private brief')
    expect(staleViewer.received.some(entry => JSON.stringify(entry.payload ?? '').includes(sid))).toBe(false)
    expect(newOwner.notices()).toHaveLength(1)
  })

  it('a notice for a deleted session reaches no one', async () => {
    initAllHermesTables()
    const sid = sessionId()
    createSession({ id: sid, profile: 'default', source: 'cli' })
    const { server, connect } = makeServer()
    const viewer = connect('viewer', { user: { id: 2, role: 'admin', profiles: ['default'] } })
    await viewer.resume(sid)
    deleteSession(sid)
    server.publishSessionNotice(record(sid, 'default'))
    expect(viewer.notices()).toHaveLength(0)
  })

  it('keeps private person sessions to their owner and shared viewers to their shared session', async () => {
    initAllHermesTables()
    const personSid = `person-main-${Date.now()}-${counter += 1}`
    createSession({ id: personSid, profile: 'default', source: 'cli', studio_user_id: 5 } as any)
    const sharedSid = sessionId()
    createSession({ id: sharedSid, profile: 'default', source: 'cli' })
    const { server, connect } = makeServer()
    const personOwner = connect('person-owner', { user: { id: 5, role: 'admin', profiles: ['default'] } })
    const otherUser = connect('other-user', { user: { id: 6, role: 'admin', profiles: ['default'] } })
    personOwner.socket.join(`session:${personSid}`)
    otherUser.socket.join(`session:${personSid}`)
    // A share viewer as the share handshake leaves it: share access plus its shared session room.
    const shareViewer = connect('share', { sessionShare: { share: { session_id: sharedSid } }, user: { id: -1, role: 'admin', profiles: [] } }, 'default', false)
    shareViewer.socket.join(`session:${sharedSid}`)

    server.publishSessionNotice(record(personSid, 'default'))
    server.publishSessionNotice(record(sharedSid, 'default'))

    expect(personOwner.notices().map(entry => entry.payload.session_id)).toEqual([personSid, sharedSid])
    expect(otherUser.notices().map(entry => entry.payload.session_id)).toEqual([sharedSid])
    expect(shareViewer.notices().map(entry => entry.payload.session_id)).toEqual([sharedSid])
  })
})

describe('S6 premise check: no user-less ordinary chat socket is admitted', () => {
  it('the production auth middleware rejects a socket without credentials; auth cannot be disabled', async () => {
    const { isAuthEnabled } = await import('../../packages/server/src/modules/studio/public/auth')
    expect(await isAuthEnabled()).toBe(true)
    const { server } = makeServer()
    const socket: any = { id: 'anonymous', data: {}, handshake: { auth: {}, query: { profile: 'default' } } }
    const next = vi.fn()
    await server.authMiddleware(socket, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error)
    expect(next.mock.calls[0][0].message).toBe('Authentication failed')
    expect(socket.data.user).toBeUndefined()
  })

  it('a user-less socket that is not a share viewer never receives a notice (fail closed)', async () => {
    initAllHermesTables()
    const sid = sessionId()
    createSession({ id: sid, profile: 'default', source: 'cli' })
    const { server, connect } = makeServer()
    const anonymous = connect('anonymous', {})
    anonymous.socket.join(`session:${sid}`)
    const member = connect('member', { user: { id: 2, role: 'admin', profiles: ['default'] } })
    server.publishSessionNotice(record(sid, 'default'))
    expect(anonymous.notices()).toHaveLength(0)
    expect(member.notices()).toHaveLength(1)
  })
})

describe('M1 deleting a session evicts its transcript-room members before the id can be reused', () => {
  async function deletionRoutes() {
    const controllers = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const registry = await import('../../packages/server/src/modules/studio/public/chat-run')
    const admin = { id: 1, role: 'super_admin', profiles: [] }
    return {
      registry,
      'HTTP single delete': async (_server: any, sid: string) => {
        const ctx: any = { params: { id: sid }, query: {}, request: { body: {} }, state: { user: admin }, method: 'DELETE' }
        await controllers.remove(ctx)
        return ctx
      },
      'HTTP batch delete': async (_server: any, sid: string) => {
        const ctx: any = { params: {}, query: {}, request: { body: { ids: [sid] } }, state: { user: admin }, method: 'POST' }
        await controllers.batchRemove(ctx)
        return ctx
      },
      'deleting disposeSession': async (server: any, sid: string) => {
        vi.spyOn(chatRuntime.chatCodingAgentRunManager, 'stop').mockReturnValue(undefined as any)
        await server.disposeSession(sid)
        return {}
      },
    } as const
  }

  // Synthetic profile list (no profile directory is read): both profiles exist.
  async function syntheticProfiles() {
    const { configureProfileConfig } = await import('../../packages/server/src/modules/studio/public/profile-config')
    configureProfileConfig({
      buildModelGroups: () => ({ default: '', groups: [] } as any), getProfilesBaseDir: () => '/nonexistent-synthetic-profiles',
      getProfileDir: (profile: string) => `/nonexistent-synthetic-profiles/${profile}`, getActiveProfileName: () => 'default',
      listProfileNames: () => ['default', 'other'], providerEnvironmentMap: {}, readConfigYaml: async () => ({}),
      readConfigYamlForProfile: async () => ({}), safeReadFile: async () => null, saveEnvValue: async () => {},
      saveEnvValueForProfile: async () => {}, updateConfigYaml: async () => undefined, updateConfigYamlForProfile: async () => undefined,
    })
  }

  for (const route of ['HTTP single delete', 'HTTP batch delete', 'deleting disposeSession'] as const) {
    it(`${route}: the stale viewer leaves the room, gets nothing after recreation, and only the new owner can join`, async () => {
      initAllHermesTables()
      await syntheticProfiles()
      const sid = sessionId()
      createSession({ id: sid, profile: 'default', source: 'cli' })
      const routes = await deletionRoutes()
      const { server, connect, nsp, rooms } = makeServer()
      routes.registry.setChatRunServer(server)
      const stale = connect('stale-a', { user: { id: 2, role: 'admin', profiles: ['default'] } })
      await stale.resume(sid)
      expect(rooms.get(`session:${sid}`)?.has('stale-a')).toBe(true)

      await routes[route](server, sid)
      // Evicted synchronously at the deleting seam, before the id can be reused.
      expect(rooms.get(`session:${sid}`)?.has('stale-a') ?? false).toBe(false)
      expect(stale.socket.rooms.has(`session:${sid}`)).toBe(false)

      createSession({ id: sid, profile: 'other', source: 'cli' })
      const owner = connect('owner-b', { user: { id: 3, role: 'admin', profiles: ['other'] } }, 'other')
      await owner.resume(sid)
      const since = stale.received.length
      // Any live run event for the recreated session goes to its room.
      nsp.to(`session:${sid}`).emit('message.delta', { session_id: sid, delta: 'PROTECTED_B_CONTENT' })
      expect(JSON.stringify(stale.received.slice(since))).not.toContain('PROTECTED_B_CONTENT')
      expect(owner.received.filter(entry => entry.event === 'message.delta')).toHaveLength(1)
      // A fresh join by the stale viewer is refused; the new owner's join worked.
      const refusedAt = stale.received.length
      await stale.resume(sid)
      expect(stale.received.slice(refusedAt).map(entry => entry.event)).toContain('run.failed')
      expect(stale.socket.rooms.has(`session:${sid}`)).toBe(false)
      expect(owner.socket.rooms.has(`session:${sid}`)).toBe(true)
      routes.registry.setChatRunServer(null as any)
    })
  }

  it('controls: /destroy and a same-owner history clear keep rightful viewers in the room', async () => {
    initAllHermesTables()
    const sid = sessionId()
    createSession({ id: sid, profile: 'default', source: 'cli' })
    const { server, connect, nsp, rooms } = makeServer()
    const viewer = connect('viewer', { user: { id: 2, role: 'admin', profiles: ['default'] } })
    await viewer.resume(sid)
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const ctx = { nsp, socket: viewer.socket, sessionMap: server.sessionMap, profile: 'default', runQueuedItem: vi.fn(),
      bridge: { interrupt: vi.fn(async () => ({ ok: true })), destroy: vi.fn(async () => ({ ok: true })), processNotification: vi.fn(async () => ({ ok: true })) } as any }
    await handleSessionCommand(sid, parseSessionCommand('/destroy')!, ctx as any)
    await handleSessionCommand(sid, parseSessionCommand('/clear --history')!, ctx as any)
    expect(rooms.get(`session:${sid}`)?.has('viewer')).toBe(true)
    expect(viewer.socket.rooms.has(`session:${sid}`)).toBe(true)
  })
})

// repair-release@5 P1: a viewer that rejoins while native Hermes deletion is still pending (the old
// row still exists, so `resume` authorizes it) must be evicted again before the row is removed.
describe('P1 deletion evicts again right before the local delete', () => {
  async function setup(options: { localDeleteOk?: boolean } = {}) {
    initAllHermesTables()
    const { configureProfileConfig } = await import('../../packages/server/src/modules/studio/public/profile-config')
    configureProfileConfig({
      buildModelGroups: () => ({ default: '', groups: [] } as any), getProfilesBaseDir: () => '/nonexistent-synthetic-profiles',
      getProfileDir: (profile: string) => `/nonexistent-synthetic-profiles/${profile}`, getActiveProfileName: () => 'default',
      listProfileNames: () => ['default', 'other'], providerEnvironmentMap: {}, readConfigYaml: async () => ({}),
      readConfigYamlForProfile: async () => ({}), safeReadFile: async () => null, saveEnvValue: async () => {},
      saveEnvValueForProfile: async () => {}, updateConfigYaml: async () => undefined, updateConfigYamlForProfile: async () => undefined,
    })
    const agentStatus = await import('../../packages/server/src/modules/studio/public/agent-status-registry')
    const sessionRuntime = await import('../../packages/server/src/modules/studio/public/session-agent-runtime')
    const store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    vi.spyOn(agentStatus, 'isHermesAgentAvailable').mockReturnValue(true)
    vi.spyOn(sessionRuntime, 'getExactHermesSessionDetailForProfile').mockImplementation(async (id: string) => ({ id }))
    let releaseNative!: () => void
    let nativePending = false
    vi.spyOn(sessionRuntime, 'deleteHermesSessionForProfile').mockImplementation(async () => {
      nativePending = true
      await new Promise<void>(resolve => { releaseNative = resolve })
      nativePending = false
      return true
    })
    if (options.localDeleteOk === false) vi.spyOn(store, 'deleteSession').mockReturnValue(false)
    const controllers = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const registry = await import('../../packages/server/src/modules/studio/public/chat-run')
    const sid = sessionId()
    createSession({ id: sid, profile: 'default', source: 'cli' })
    const { server, connect, nsp, rooms } = makeServer()
    registry.setChatRunServer(server)
    const viewer = connect('viewer-a', { user: { id: 2, role: 'admin', profiles: ['default'] } })
    await viewer.resume(sid)
    const admin = { id: 1, role: 'super_admin', profiles: [] }
    const routes = {
      single: (ctx: any = { params: { id: sid }, query: {}, request: { body: {} }, state: { user: admin }, method: 'DELETE' }) =>
        controllers.remove(ctx).then(() => ctx),
      batch: (ctx: any = { params: {}, query: {}, request: { body: { ids: [sid] } }, state: { user: admin }, method: 'POST' }) =>
        controllers.batchRemove(ctx).then(() => ctx),
    }
    return { sid, server, connect, nsp, rooms, viewer, routes, registry, nativePending: () => nativePending, releaseNative: () => releaseNative() }
  }

  for (const route of ['single', 'batch'] as const) {
    it(`${route} delete: a rejoin during the pending native delete is evicted before the row goes; nothing reaches it after recreation`, async () => {
      const t = await setup()
      const deleting = t.routes[route]()
      await vi.waitFor(() => expect(t.nativePending()).toBe(true))
      // Early eviction already happened; the old row still exists, so the read check lets A back in.
      expect(t.viewer.socket.rooms.has(`session:${t.sid}`)).toBe(false)
      await t.viewer.resume(t.sid)
      expect(t.viewer.socket.rooms.has(`session:${t.sid}`)).toBe(true)
      t.releaseNative()
      const ctx = await deleting
      expect(ctx.status ?? 200).toBe(200)
      expect(t.viewer.socket.rooms.has(`session:${t.sid}`)).toBe(false)
      expect(t.rooms.get(`session:${t.sid}`)?.has('viewer-a') ?? false).toBe(false)
      createSession({ id: t.sid, profile: 'other', source: 'cli' })
      const owner = t.connect('owner-b', { user: { id: 3, role: 'admin', profiles: ['other'] } }, 'other')
      await owner.resume(t.sid)
      const since = t.viewer.received.length
      t.nsp.to(`session:${t.sid}`).emit('message.delta', { session_id: t.sid, delta: 'PROTECTED_B_TERMINAL_OUTPUT' })
      expect(JSON.stringify(t.viewer.received.slice(since))).not.toContain('PROTECTED_B_TERMINAL_OUTPUT')
      expect(owner.received.filter(entry => entry.event === 'message.delta')).toHaveLength(1)
      t.registry.setChatRunServer(null as any)
    })
  }

  it('failed local deletion: the session stays, and its authorized viewer can rejoin', async () => {
    const t = await setup({ localDeleteOk: false })
    const deleting = t.routes.single()
    await vi.waitFor(() => expect(t.nativePending()).toBe(true))
    t.releaseNative()
    const ctx = await deleting
    expect(ctx.status).toBe(500)
    expect(t.viewer.socket.rooms.has(`session:${t.sid}`)).toBe(false)
    await t.viewer.resume(t.sid)
    expect(t.viewer.socket.rooms.has(`session:${t.sid}`)).toBe(true)
    t.registry.setChatRunServer(null as any)
  })
})
