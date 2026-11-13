/** A decoded server-sent event frame. */
export interface SseFrame {
  event?: string
  data: string
}

export function parseSseFrame(raw: string): SseFrame | null {
  let event: string | undefined
  const data: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
      continue
    }
    if (line.startsWith('data:')) {
      data.push(line.slice(5).trimStart())
    }
  }
  if (!data.length) return null
  return { event, data: data.join('\n') }
}

export function readSseFrameTexts(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = []
  let start = 0
  const boundary = /\r?\n\r?\n/g
  let match: RegExpExecArray | null
  while ((match = boundary.exec(buffer)) !== null) {
    frames.push(buffer.slice(start, match.index))
    start = match.index + match[0].length
  }
  return { frames, rest: buffer.slice(start) }
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
      const parsed = readSseFrameTexts(buffer)
      buffer = parsed.rest
      for (const raw of parsed.frames) {
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

export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}
