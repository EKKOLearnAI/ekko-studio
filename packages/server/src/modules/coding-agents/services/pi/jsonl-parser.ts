import { StringDecoder } from 'string_decoder'
import type { Readable } from 'stream'

/** Pi RPC uses strict LF-only JSONL framing. */
export function attachPiJsonlReader(stream: Readable, onValue: (value: any) => void, onInvalid?: (line: string) => void): () => void {
  const decoder = new StringDecoder('utf8')
  let buffer = ''

  const consume = (line: string) => {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line
    if (!normalized.trim()) return
    try {
      onValue(JSON.parse(normalized))
    } catch {
      onInvalid?.(normalized)
    }
  }

  const onData = (chunk: string | Buffer) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    while (true) {
      const index = buffer.indexOf('\n')
      if (index < 0) break
      consume(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
    }
  }
  const onEnd = () => {
    buffer += decoder.end()
    if (buffer) consume(buffer)
    buffer = ''
  }

  stream.on('data', onData)
  stream.on('end', onEnd)
  return () => {
    stream.off('data', onData)
    stream.off('end', onEnd)
  }
}
