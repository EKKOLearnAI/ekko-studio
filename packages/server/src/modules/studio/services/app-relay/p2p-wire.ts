// Versioned DataChannel framing. Keep compatible with app/api/p2pWire.ts.
export const P2P_EVENTS = new Set(['http.request', 'http.download.chunk', 'http.download.cancel', 'socket.open', 'socket.event', 'socket.close'])
const MAX_TEXT = 40 * 1024 * 1024
const CHUNK = 8 * 1024

export function encodeP2P(value: unknown): string {
  function visit(item: any): any {
    if (item instanceof ArrayBuffer) return { __ekkoP2PBytes: Buffer.from(item).toString('base64') }
    if (ArrayBuffer.isView(item)) return { __ekkoP2PBytes: Buffer.from(item.buffer, item.byteOffset, item.byteLength).toString('base64') }
    if (Array.isArray(item)) return item.map(visit)
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, val]) => [key, visit(val)]))
    return item
  }
  const text = JSON.stringify(visit(value))
  if (text.length > MAX_TEXT) throw new Error('p2p_message_too_large')
  return text
}

export function decodeP2P(text: string): any {
  return JSON.parse(text, (_key, item) => item && typeof item.__ekkoP2PBytes === 'string' ? Buffer.from(item.__ekkoP2PBytes, 'base64') : item)
}

export function p2pFrames(text: string, id: string): string[] {
  if (text.length > MAX_TEXT) throw new Error('p2p_message_too_large')
  const total = Math.max(1, Math.ceil(text.length / CHUNK))
  return Array.from({ length: total }, (_, index) => JSON.stringify({ v: 1, id, index, total, text: text.slice(index * CHUNK, (index + 1) * CHUNK) }))
}

export class P2PAssembler {
  private pending = new Map<string, { parts: string[]; total: number; length: number; started: number }>()
  private length = 0
  clear(): void { this.pending.clear(); this.length = 0 }
  receive(raw: string): any | undefined {
    if (raw.length > CHUNK * 6 + 1024) throw new Error('p2p_invalid_frame')
    const frame = JSON.parse(raw)
    if (frame.v !== 1 || typeof frame.id !== 'string' || frame.id.length > 128 || typeof frame.text !== 'string' || frame.text.length > CHUNK
      || !Number.isInteger(frame.total) || frame.total < 1 || frame.total > Math.ceil(MAX_TEXT / CHUNK)
      || !Number.isInteger(frame.index) || frame.index < 0 || frame.index >= frame.total) throw new Error('p2p_invalid_frame')
    for (const [id, value] of this.pending) {
      if (Date.now() - value.started > 30_000) { this.length -= value.length; this.pending.delete(id) }
    }
    let message = this.pending.get(frame.id)
    if (!message) {
      if (frame.index !== 0 || this.pending.size >= 8) throw new Error('p2p_invalid_sequence')
      message = { parts: [], total: frame.total, length: 0, started: Date.now() }
      this.pending.set(frame.id, message)
    }
    if (message.total !== frame.total || message.parts.length !== frame.index) throw new Error('p2p_invalid_sequence')
    message.parts.push(frame.text); message.length += frame.text.length; this.length += frame.text.length
    if (this.length > MAX_TEXT) throw new Error('p2p_message_too_large')
    if (message.parts.length !== message.total) return undefined
    this.pending.delete(frame.id); this.length -= message.length
    return decodeP2P(message.parts.join(''))
  }
}
