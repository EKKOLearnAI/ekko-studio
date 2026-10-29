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
  const nsp: any = { use: vi.fn(), on: vi.fn(), to, emit: vi.fn(), adapter: { rooms }, sockets }
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
    return { socket, received, notices, resume: (sessionId: string) => handlers.get('resume')!({ session_id: sessionId }) }
  }
  return { server, connect }
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
