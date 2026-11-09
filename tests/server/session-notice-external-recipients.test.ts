import './fixtures/isolated-studio-state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as chatRuntime from '../../packages/server/src/modules/studio/public/chat-agent-runtime'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { clearSessionMessages, createSession, getSessionGeneration } from '../../packages/server/src/modules/studio/repositories/session-store'
import { createUser, updateUser } from '../../packages/server/src/modules/studio/repositories/users-store'
import { SessionShareError } from '../../packages/server/src/modules/studio/contracts/session-shares'
import { sessionShareService } from '../../packages/server/src/modules/studio/services/session-shares/service'
import { ChatRunSocket } from '../../packages/server/src/modules/studio/sockets/chat-run'

// A live external notice reaches only viewers allowed now: re-fenced to its accepting generation and
// re-authorized against current account and share state, never the state cached on a socket.
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
  id: 7, namespace: 'inst', profile, producer_key: `external:e${counter += 1}`, session_id: sessionId, kind: 'external',
  disposition: 'notified', attention_pending: 1, created_at: Date.now(), updated_at: Date.now(),
  payload: { source: 'validator-review', event_id: 'e1', title: 'Validation complete', content: 'SECRET_RESULT', url: null },
})
const sessionId = () => `external-notice-recipients-${Date.now()}-${counter += 1}`

afterEach(() => vi.restoreAllMocks())

describe('external notices are re-fenced and re-authorized against current state at publication', () => {
  function setup() {
    initAllHermesTables()
    const sid = sessionId()
    createSession({ id: sid, profile: 'default', source: 'cli' })
    const suffix = `${Date.now()}-${counter += 1}`
    const user = (name: string, profiles: string[]) => createUser({ username: `${name}-${suffix}`, password: 'password-1', role: 'admin', profiles })!
    const accounts = { member: user('member', ['default']), disabled: user('disabled', ['default']), demoted: user('demoted', ['other']) }
    updateUser({ userId: accounts.disabled.id, status: 'disabled' })
    const external = { ...record(sid, 'default'), kind: 'external', session_generation: getSessionGeneration(sid),
      payload: { source: 'validator-review', event_id: 'e1', title: 'Validation complete', content: 'SECRET_RESULT', url: null } }
    return { sid, accounts, external, ...makeServer() }
  }

  it('reaches current viewers and valid shares only, and nobody once the generation is stale', async () => {
    const { sid, accounts, external, server, connect } = setup()
    vi.spyOn(sessionShareService, 'authorize').mockImplementation(((token: string) => {
      if (token !== 'sst1_valid') throw new SessionShareError('share_revoked')
      return { share: { session_id: sid, profile: 'default' } }
    }) as any)
    // Sockets keep the account state cached at their handshake.
    const viewer = connect('viewer', { user: { id: accounts.member.id, role: 'admin', profiles: ['default'] } })
    const disabled = connect('disabled', { user: { id: accounts.disabled.id, role: 'admin', profiles: ['default'] } })
    const demoted = connect('demoted', { user: { id: accounts.demoted.id, role: 'super_admin', profiles: [] } })
    const share = (id: string, token: string) => {
      const client = connect(id, { sessionShare: { token, actor: { id: 9 }, share: { session_id: sid } }, user: { id: -1, role: 'admin', profiles: [] } }, 'default', false)
      client.socket.join(`session:${sid}`)
      return client
    }
    const validShare = share('valid-share', 'sst1_valid')
    const revokedShare = share('revoked-share', 'sst1_revoked')

    server.publishSessionNotice(external)

    expect(viewer.notices()).toHaveLength(1)
    expect(viewer.notices()[0].payload.message.studio_notice).toMatchObject({ kind: 'external', title: 'Validation complete' })
    expect(validShare.notices()).toHaveLength(1)
    for (const outsider of [disabled, demoted, revokedShare]) expect(JSON.stringify(outsider.received)).not.toContain('SECRET_RESULT')
    // Passive: publication neither starts nor queues a turn.
    expect(server.sessionMap.get(sid)?.isWorking ?? false).toBe(false)
    expect(server.sessionMap.get(sid)?.queue?.length ?? 0).toBe(0)
    expect(viewer.received.map(entry => entry.event)).not.toContain('run.started')

    clearSessionMessages(sid)
    server.publishSessionNotice({ ...external, payload: { ...external.payload, content: 'STALE_RESULT' } })
    expect(JSON.stringify([viewer.received, validShare.received])).not.toContain('STALE_RESULT')
  })

  it('sends unread attention state only to subscribers whose account is still allowed', async () => {
    const { sid, accounts, external, server, connect } = setup()
    const subscribe = (id: string, user: Record<string, unknown>) => {
      const client = connect(id, { user }, 'default', false)
      client.socket.handshake.query.session_state = '1'
      server.onConnection(client.socket)
      return client
    }
    const viewer = subscribe('state-viewer', { id: accounts.member.id, role: 'admin', profiles: ['default'] })
    const disabled = subscribe('state-disabled', { id: accounts.disabled.id, role: 'admin', profiles: ['default'] })
    const updates = (client: ReturnType<typeof subscribe>) => client.received
      .filter(entry => entry.event === 'sessions.state.updated' && entry.payload.sessionId === sid)

    server.publishSessionNotice(external)

    expect(updates(viewer)).toHaveLength(1)
    expect(updates(disabled)).toHaveLength(0)
  })
})
