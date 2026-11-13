export function groupReplyNotification(room: { id: string; name: string }, message: {
  id: string; senderName: string; senderType?: string; role?: string; content: string; finish_reason?: string | null
}, now = Date.now()) {
  if (message.senderType !== 'agent' || message.role !== 'assistant' || !message.content.trim()
    || ['tool_calls', 'cancelled', 'aborted', 'error'].includes(message.finish_reason || '')) return null
  const text = (s: string, limit: number) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g,' ').trim().slice(0,limit)
  return { id: `group:${room.id}:message:${message.id}`, target:'group', roomId:room.id, messageId:message.id,
    title:text(room.name,120), content:`${text(message.senderName,60)}: ${text(message.content,180)}`,
    kind:'completion', resolved:false, timestamp:now }
}
