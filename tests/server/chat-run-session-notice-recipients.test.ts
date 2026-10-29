import { afterEach, describe, expect, it, vi } from 'vitest'
import * as chatRuntime from '../../packages/server/src/modules/studio/public/chat-agent-runtime'
import { ChatRunSocket } from '../../packages/server/src/modules/studio/sockets/chat-run'

// repair-release@1 R1: a live passive notice reaches only users allowed to see the owning profile.
function makeServer() {
  const sockets = new Map<string, any>()
  const rooms = new Map<string, Set<string>>()
  const join = (room: string, id: string) => rooms.set(room, new Set([...(rooms.get(room) || []), id]))
  const to = (target: string | string[]) => ({
    emit: (event: string, payload: unknown) => {
      const ids = new Set((Array.isArray(target) ? target : [target]).flatMap(room => [...(rooms.get(room) || [])]))
      for (const id of ids) sockets.get(id)?.emit(event, payload)
    },
  })
  const nsp: any = { use: vi.fn(), on: vi.fn(), to, adapter: { rooms }, sockets }
  vi.spyOn(chatRuntime, 'createPrimaryAgentBridge').mockReturnValue({} as any)
  const server: any = new ChatRunSocket({ of: () => nsp } as any)
  vi.spyOn(server, 'canAccessProfile').mockImplementation((user: any, profile: any) =>
    user.role === 'super_admin' || user.profiles.includes(profile))
  const connect = (id: string, user: Record<string, unknown>, room?: string) => {
    const received: any[] = []
    sockets.set(id, { id, data: { user }, emit: (event: string, payload: unknown) => received.push({ event, payload }) })
    join('studio-account', id)
    if (room) join(room, id)
    return received
  }
  return { server, connect }
}

const record = (sessionId: string) => ({
  id: 7, namespace: 'inst', profile: 'default', producer_key: 'cron:job-1:e1', session_id: sessionId, kind: 'cron',
  disposition: 'notified', attention_pending: 1, created_at: Date.now(), updated_at: Date.now(), projected_at: null,
  payload: { job_id: 'job-1', job_name: 'Private brief', execution_id: 'e1', status: 'completed', success: true, content: 'SECRET_RESULT' },
})

afterEach(() => vi.restoreAllMocks())

describe('R1 live session.notice recipients', () => {
  it('reaches an authorized off-focus user and the session room, never a disjoint-profile user', () => {
    const { server, connect } = makeServer()
    const owner = connect('owner', { id: 1, role: 'super_admin', profiles: [] })
    const viewer = connect('viewer', { id: 2, role: 'admin', profiles: ['default'] }, 'session:s-1')
    const outsider = connect('outsider', { id: 3, role: 'admin', profiles: ['other'] })

    server.publishSessionNotice(record('s-1'))

    expect(owner.map(entry => entry.event)).toContain('session.notice')
    expect(viewer.filter(entry => entry.event === 'session.notice')).toHaveLength(1)
    expect(JSON.stringify(outsider)).not.toContain('SECRET_RESULT')
    expect(JSON.stringify(outsider)).not.toContain('s-1')
  })
})
