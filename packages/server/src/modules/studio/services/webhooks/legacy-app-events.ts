import type { Socket } from 'socket.io'
import { appEventEnvelope } from './app-events'
import { authenticateUserToken } from '../../public/auth'
import { businessEvents, type BusinessEvent } from './business-events'

/** Compatibility projection for old clients; new clients use only /chat-run app.event. */
export function bindLegacyAppEvents(socket: Socket, kind: 'chat' | 'group' | 'workflow', canReceive: (event: BusinessEvent) => boolean): void {
  const name = `legacy-app:${kind}:${socket.id}`
  const seen = new Set<string>()
  let closed = false
  let chain = Promise.resolve()
  const deliver = (event: BusinessEvent) => {
    if (closed || socket.data.appEventVersion === 1 || socket.handshake.auth?.appEventVersion === 1 || !canReceive(event)) return
    if (kind === 'chat' && !event.type.startsWith('chat.')) return
    if (kind === 'group' && event.type !== 'group.message.created') return
    if (kind === 'workflow' && !event.type.startsWith('workflow.run.')) return
    const envelope = appEventEnvelope(event)
    if (!envelope || !('display' in envelope) || !envelope.display || ('notify' in envelope && envelope.notify === false) || seen.has(event.id)) return
    seen.add(event.id); if (seen.size > 2000) seen.delete(seen.values().next().value!)
    const d = envelope.display as Record<string, unknown>
    const common = { title:d.title,content:d.preview ?? d.content,agent:d.agent,profile:event.profile,timestamp:Date.parse(event.occurred_at),resolved:event.type.endsWith('.resolved'),kind:event.type.endsWith('.failed')?'failure':'completion' }
    if (kind === 'chat') {
      const interaction = event.subject.approval_id || event.subject.clarification_id
      socket.emit('app.notification',{...common,sessionId:event.subject.session_id,
        id:interaction?`${event.subject.session_id}:${event.subject.approval_id?'approval':'clarify'}:${interaction}`:`${event.subject.session_id}:run:${event.subject.run_id}`,
        kind:interaction?'approval':common.kind})
    } else if (kind === 'group') {
      socket.emit('app.group-notification',{...common,id:`group:${event.subject.room_id}:message:${event.subject.message_id}`,target:'group',roomId:event.subject.room_id,messageId:event.subject.message_id,agents:d.agents,agentCount:d.agentCount})
    } else {
      socket.emit('app.workflow-notification',{...common,id:`workflow:${event.subject.workflow_id}:run:${event.subject.run_id}`,target:'workflow',workflowId:event.subject.workflow_id,runId:event.subject.run_id})
    }
  }
  const stop = businessEvents.subscribe(name, event => {
    if (closed || socket.handshake.auth?.appEventVersion === 1 || socket.data.appEventVersion === 1) return
    const token = socket.handshake.auth?.token
    if (typeof token !== 'string' || !token) { deliver(event); return }
    chain = chain.then(async () => {
      const user = await authenticateUserToken(token)
      if (!user || closed) return
      socket.data.user = user
      if (kind === 'group') socket.data.authUser = user
      deliver(event)
    }).catch(() => {})
  })
  socket.on('disconnect',()=>{closed=true;stop();seen.clear()})
}
