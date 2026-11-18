import { expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ session: { id: 's1', profile: 'default', source: 'api_server' } as any }))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', async (orig) => ({
  ...(await orig<any>()), getSession: () => mocks.session,
}))
vi.mock('../../packages/server/src/modules/studio/services/background-tasks', async (orig) => ({ ...(await orig<any>()), hasChatEkkoBackgroundTasks: () => false }))
import { ChatRunSocket } from '../../packages/server/src/modules/studio/sockets/chat-run'

function socketWith(statusIfLoaded: () => Promise<unknown>) {
  const server = Object.create(ChatRunSocket.prototype) as any
  server.bridge = { statusIfLoaded }
  server.assertSessionMessageEditIdle = vi.fn()
  return server
}

it('allows message edits when the worker confirms the session is not running', async () => {
  const server = socketWith(async () => ({ ok: true, running: false, loaded: false }))
  await expect(server.assertSessionMessagesEditable('s1')).resolves.toBeUndefined()
})

it('rejects message edits when the worker is running', async () => {
  const server = socketWith(async () => ({ ok: true, running: true }))
  await expect(server.assertSessionMessagesEditable('s1')).rejects.toMatchObject({ status: 409 })
})

it('does not allow message edits when worker status is indeterminate (communication failure)', async () => {
  const server = socketWith(async () => { throw new Error('worker status unavailable: [Errno 104] Connection reset by peer') })
  await expect(server.assertSessionMessagesEditable('s1')).rejects.toThrow('worker status unavailable')
})
