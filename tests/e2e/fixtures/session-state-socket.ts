import type { Page, WebSocketRoute } from '@playwright/test'

// Node-side Socket.IO (Engine.IO v4) stand-in for the chat-run namespace, over the page's real WebSocket
// transport. Distinguishes the account session-state socket (query session_state=1) from the chat socket,
// answers `resume`, records `sessions.read`, and holds `sessions.unread` acknowledgements for the spec.
export async function fakeChatRunSockets(page: Page) {
  const reads: Record<string, unknown>[] = []
  const unreads: { payload: Record<string, unknown>; ack: (result: unknown) => void }[] = []
  const stateSockets: WebSocketRoute[] = []
  await page.routeWebSocket('**/socket.io/**', ws => {
    const sessionState = new URL(ws.url()).searchParams.get('session_state') === '1'
    ws.send('0' + JSON.stringify({ sid: `fake-${Date.now()}`, upgrades: [], pingInterval: 60000, pingTimeout: 60000, maxPayload: 1000000 }))
    ws.onMessage(raw => {
      const value = String(raw)
      if (value === '2') { ws.send('3'); return }
      if (value.startsWith('40/chat-run')) {
        ws.send('40/chat-run,' + JSON.stringify({ sid: `ns-${Date.now()}` }))
        if (sessionState) { stateSockets.push(ws); ws.send('42/chat-run,' + JSON.stringify(['sessions.state.snapshot', { sessions: [] }])) }
        return
      }
      const match = value.match(/^42\/chat-run,(\d*)(\[.*)$/s)
      if (!match) return
      const [event, payload] = JSON.parse(match[2])
      if (event === 'sessions.read') reads.push(payload)
      if (event === 'sessions.unread' && match[1]) {
        unreads.push({ payload, ack: result => ws.send(`43/chat-run,${match[1]}` + JSON.stringify([result])) })
      }
      if (event === 'resume') {
        ws.send('42/chat-run,' + JSON.stringify(['resumed', { session_id: payload?.session_id, isWorking: false, events: [], messages: [] }]))
      }
    })
  })
  return {
    reads, unreads,
    connected: () => stateSockets.length > 0,
    publish: (state: Record<string, unknown>) => {
      for (const ws of stateSockets) ws.send('42/chat-run,' + JSON.stringify(['sessions.state.updated', state]))
    },
  }
}
