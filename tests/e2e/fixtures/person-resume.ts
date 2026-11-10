import type { Page, WebSocketRoute } from '@playwright/test'
import type { PersonFlowSnapshot } from '../../../packages/client/src/api/person'

export interface PersonResumeFixture {
  messages: Array<{ id: string; role: string; content: string; timestamp: number }>
  personFlows: PersonFlowSnapshot
}

/** Fake only the server wire; selection, resume mapping and rendering remain real. */
export async function mockPersonResume(page: Page, snapshot: (sessionId: string) => PersonResumeFixture, delay = () => 0) {
  const connections = new Map<WebSocketRoute, string>()
  const requested: string[] = []
  await page.routeWebSocket('**/socket.io/**', socket => {
    socket.send('0' + JSON.stringify({ sid: 'fixture', upgrades: [], pingInterval: 60000, pingTimeout: 60000 }))
    socket.onClose(() => connections.delete(socket))
    socket.onMessage(async raw => {
      const text = String(raw)
      if (text.startsWith('40')) socket.send(text.split(',')[0] + ',' + JSON.stringify({ sid: 'fixture' }))
      if (!text.startsWith('42')) return
      const start = text.indexOf('['), [event, data] = JSON.parse(text.slice(start))
      if (event !== 'resume') return
      const prefix = text.slice(0, start)
      connections.set(socket, prefix)
      requested.push(data.session_id)
      if (delay()) await new Promise(resolve => setTimeout(resolve, delay()))
      if (page.isClosed() || !connections.has(socket)) return
      const value = snapshot(data.session_id)
      socket.send(prefix + JSON.stringify(['resumed', {
        session_id: data.session_id, messages: value.messages.map(message => ({ ...message, timestamp: message.timestamp / 1000 })),
        personFlows: value.personFlows, messageLoadedCount: value.messages.length, messageTotal: value.messages.length,
        hasMoreBefore: false, isWorking: false, events: [], queueLength: 0,
      }]))
    })
  })
  return {
    requested,
    publish(sessionId: string) {
      for (const [socket, prefix] of connections) socket.send(prefix + JSON.stringify(['person.updated', {
        session_id: sessionId, personFlows: snapshot(sessionId).personFlows,
      }]))
    },
  }
}
