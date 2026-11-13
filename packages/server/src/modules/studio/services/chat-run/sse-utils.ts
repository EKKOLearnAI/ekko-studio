export interface SseFrame {
  event?: string
  data: string
}

export function parseSseFrame(raw: string): SseFrame | null {
  let event: string | undefined
  const data: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
  }
  return data.length ? { event, data: data.join('\n') } : null
}

export async function* readSseFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split(/\r?\n\r?\n/)
      buffer = parts.pop() || ''
      for (const raw of parts) {
        const frame = parseSseFrame(raw)
        if (frame) yield frame
      }
    }
    buffer += decoder.decode()
    const frame = parseSseFrame(buffer)
    if (frame) yield frame
  } finally {
    reader.releaseLock()
  }
}
