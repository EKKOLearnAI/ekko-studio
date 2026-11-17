import { createServer } from 'node:http'
import { once } from 'node:events'
import { Server } from 'socket.io'
import { io as connect, type Socket } from 'socket.io-client'
import { expect, it, vi } from 'vitest'
import { acceptanceFixture } from './fixtures/person-acceptance'

function result(socket: Socket, event: string) {
  return once(socket, event, { signal: AbortSignal.timeout(2000) }).then(([payload]) => payload)
}

async function clarificationSocketFixture() {
  const fixture = await acceptanceFixture()
  const http = createServer()
  const io = new Server(http)
  const runtime = await import('../../packages/server/src/modules/studio/public/chat-agent-runtime')
  const notHandled = { handled: false, resolved: false }
  const clarifyRespond = vi.fn()
  vi.spyOn(runtime, 'createPrimaryAgentBridge').mockReturnValue({
    clarifyRespond, close: vi.fn(async () => {}),
  } as ReturnType<typeof runtime.createPrimaryAgentBridge>)
  vi.spyOn(runtime, 'respondToChatEkkoClarification').mockReturnValue(notHandled)
  vi.spyOn(runtime.chatCodingAgentRunManager, 'resolveClarification').mockReturnValue(notHandled)
  const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
  const chat = new ChatRunSocket(io)
  const namespace = io.of('/chat-run')
  namespace.on('connection', socket => {
    socket.data.user = { id: 1, role: 'super_admin', status: 'active' }
    chat['onConnection'](socket)
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
  const clients: Socket[] = []
  const client = async (profile: string) => {
    const socket = connect(`http://127.0.0.1:${address.port}/chat-run`, { transports: ['websocket'], query: { profile } })
    clients.push(socket)
    await result(socket, 'connect')
    return socket
  }
  const close = async () => {
    for (const socket of clients) socket.disconnect()
    await chat.close()
    await io.close()
    await fixture.close('clarification-socket-delivery')
  }
  return { fixture, namespace, chat, client, close, clarifyRespond }
}

it('confirms a durable clarification even while the Bot is busy with another turn', { timeout: 10_000 }, async () => {
  const h = await clarificationSocketFixture()
  const { fixture, chat } = h
  try {
    const sessionId = 'person-main-1'
    vi.spyOn(chat, 'isSessionRunning').mockImplementation(id => id === sessionId)
    const client = await h.client('default')
    const { execution } = await fixture.create()
    const question = fixture.store.addPersonInteraction(1, execution, 'worker-question', 'Which option?', ['A', 'B'], 'question')
    fixture.store.setPersonExecution(execution, 'waiting_user')
    const clarifyId = `person-interaction:${question.id}:${question.revision}`

    const confirmed = result(client, 'clarify.resolved')
    client.emit('clarify.respond', { session_id: sessionId, clarify_id: clarifyId, response: 'B' })
    expect(await confirmed).toMatchObject({ session_id: sessionId, clarify_id: clarifyId, resolved: true })
    expect(fixture.runtime.answer).toHaveBeenCalledExactlyOnceWith(execution.session_id, 'worker-question', 'B', false)
  } finally {
    await h.close()
  }
})

async function hermesSession(h: Awaited<ReturnType<typeof clarificationSocketFixture>>) {
  const { createSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')
  const sessionId = 'hermes-chat'
  const clarifyId = 'hermes-question'
  createSession({ id: sessionId, source: 'cli', profile: 'default', studio_user_id: 1 })
  h.chat['sessionMap'].set(sessionId, { profile: 'run-profile', source: 'cli', messages: [], events: [], queue: [], isWorking: true })
  const other = await h.client('run-profile')
  await h.namespace.sockets.get(other.id!)!.join(`session:${sessionId}`)
  h.chat.emitExternalEvent(sessionId, 'clarify.requested', { event: 'clarify.requested', clarify_id: clarifyId, question: 'Which option?', choices: ['A', 'B'] })
  const submitter = await h.client('default')
  return { other, submitter, answer: { session_id: sessionId, clarify_id: clarifyId, response: 'B' } }
}

it('returns the Hermes confirmation to a replacement socket outside the occupied session room', async () => {
  const h = await clarificationSocketFixture()
  try {
    h.clarifyRespond.mockResolvedValue({ resolved: true })
    const { other, submitter, answer } = await hermesSession(h)
    const received = Promise.all([result(other, 'clarify.resolved'), result(submitter, 'clarify.resolved')])
    submitter.emit('clarify.respond', answer)
    for (const confirmation of await received) {
      expect(confirmation).toMatchObject({ session_id: answer.session_id, clarify_id: answer.clarify_id, resolved: true })
    }
    expect(h.clarifyRespond).toHaveBeenCalledExactlyOnceWith(answer.clarify_id, 'B')
  } finally {
    await h.close()
  }
})

it('removes the question from replay when a legacy Hermes broker has lost its route', async () => {
  const h = await clarificationSocketFixture()
  try {
    h.clarifyRespond.mockRejectedValue(new Error("'unknown clarify request: hermes-question'"))
    const { other, submitter, answer } = await hermesSession(h)
    const received = result(other, 'clarify.resolved')
    submitter.emit('clarify.respond', answer)
    expect(await received).toMatchObject({
      session_id: answer.session_id, clarify_id: answer.clarify_id, resolved: false, stale: true,
    })
    expect(h.chat['sessionMap'].get(answer.session_id)!.events).toEqual([])
  } finally {
    await h.close()
  }
})

it('keeps the Hermes question pending after a transient Bridge error and accepts a retry', async () => {
  const h = await clarificationSocketFixture()
  try {
    h.clarifyRespond.mockRejectedValueOnce(new Error('Bridge temporarily unavailable')).mockResolvedValueOnce({ resolved: true })
    const { submitter, answer } = await hermesSession(h)
    const first = result(submitter, 'clarify.resolved')
    submitter.emit('clarify.respond', answer)
    expect(await first).toMatchObject({ resolved: false, error: 'Bridge temporarily unavailable' })
    expect(h.chat['sessionMap'].get(answer.session_id)!.events).toHaveLength(1)

    const retry = result(submitter, 'clarify.resolved')
    submitter.emit('clarify.respond', answer)
    expect(await retry).toMatchObject({ clarify_id: answer.clarify_id, resolved: true })
    expect(h.clarifyRespond).toHaveBeenCalledTimes(2)
  } finally {
    await h.close()
  }
})
