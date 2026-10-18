type StreamMessage = {
  id: string
  roomId: string
  senderId: string
  senderAgentRecordId?: string
  content: string
  reasoning?: string | null
  reasoning_content?: string | null
  run_id?: string | null
  role?: string
  tool_calls?: unknown[] | null
}

// Only the current segment of each Agent is transient. Completed messages live
// in SQLite; a room rejoin must restore this segment before receiving deltas.
export class GroupStreamSnapshots<T extends StreamMessage> {
  private rooms = new Map<string, Map<string, { message: T & { isStreaming: true }; sessionId: string }>>()

  start(message: T, sessionId: string): void {
    let room = this.rooms.get(message.roomId)
    if (!room) this.rooms.set(message.roomId, room = new Map())
    const existing = room.get(message.senderId)
    if (existing?.message.id === message.id && existing.sessionId === sessionId) return
    room.set(message.senderId, { message: { ...message, isStreaming: true }, sessionId })
  }

  append(roomId: string, id: string, senderId: string, sessionId: string, field: 'content' | 'reasoning', delta: string): void {
    const stream = this.rooms.get(roomId)?.get(senderId)
    if (stream?.message.id !== id || stream.sessionId !== sessionId) return
    stream.message[field] = `${stream.message[field] || ''}${delta}`
    if (field === 'reasoning') stream.message.reasoning_content = stream.message.reasoning
  }

  finish(roomId: string, id: string, senderId: string): void {
    if (this.rooms.get(roomId)?.get(senderId)?.message.id === id) this.clearSender(roomId, senderId)
  }

  persisted(message: T): void {
    this.finish(message.roomId, message.id, message.senderId)
    const stream = this.rooms.get(message.roomId)?.get(message.senderId)
    if (stream && message.role === 'assistant' && message.tool_calls?.length
      && message.run_id && stream.message.run_id === message.run_id) {
      // Tool messages now own this reasoning, matching the live client path.
      stream.message.reasoning = ''
      stream.message.reasoning_content = ''
    }
  }

  clearSender(roomId: string, senderId: string, sessionId?: string): void {
    const room = this.rooms.get(roomId)
    if (sessionId && room?.get(senderId)?.sessionId !== sessionId) return
    room?.delete(senderId)
    if (!room?.size) this.rooms.delete(roomId)
  }

  clear(roomId: string, agentRecordId?: string): void {
    if (!agentRecordId) { this.rooms.delete(roomId); return }
    for (const [senderId, stream] of this.rooms.get(roomId) || []) {
      if (stream.message.senderAgentRecordId === agentRecordId) this.clearSender(roomId, senderId)
    }
  }

  snapshot(roomId: string, isCurrent: (message: T, sessionId: string) => boolean): Array<T & { isStreaming: true }> {
    const result: Array<T & { isStreaming: true }> = []
    for (const [senderId, stream] of this.rooms.get(roomId) || []) {
      if (isCurrent(stream.message, stream.sessionId)) result.push({ ...stream.message })
      else this.clearSender(roomId, senderId)
    }
    return result
  }
}
