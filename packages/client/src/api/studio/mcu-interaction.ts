import { startRunViaSocket, type RunEvent, type StartRunRequest } from './chat'
import { transcribeSpeech } from './stt'
import type { StoredSttProvider } from './stt-settings'
import { synthesizeSpeech, type TtsProviderId } from './tts'

export type McuInteractionStatus =
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'clearing'
  | 'tool'
  | 'speaking'
  | 'completed'
  | 'failed'
  | 'aborted'

export interface McuStatusEvent {
  type: 'interaction.status'
  interactionId: string
  status: McuInteractionStatus
  text?: string
}

export interface McuToolEvent {
  type: 'tool.started' | 'tool.completed'
  interactionId: string
  tool: string
  preview?: string
  error?: string
}

export interface McuAudioSegment {
  interactionId: string
  segmentId: string
  text: string
  audio: Blob
  mimeType: string
  engine: string
  provider: string
}

export interface McuInteractionTransport {
  clearAudio: (interactionId: string) => void | Promise<void>
  send: (event: McuStatusEvent | McuToolEvent) => void | Promise<void>
  enqueueAudio: (segment: McuAudioSegment) => void | Promise<void>
}

export interface McuSpeechSegmenter {
  pushDelta: (delta: string) => string[]
  flush: () => string | null
  reset: () => void
}

export interface McuSpeechSegmenterOptions {
  maxChars?: number
  emitOnSentenceEnd?: boolean
}

export interface StartMcuVoiceInteractionOptions {
  audio: Blob
  sttProvider: StoredSttProvider
  ttsProvider: TtsProviderId
  transport: McuInteractionTransport
  sessionId?: string
  profile?: string
  language?: string
  prompt?: string
  run?: Omit<StartRunRequest, 'input' | 'session_id' | 'profile'>
  ttsOptions?: Record<string, unknown>
  deps?: Partial<McuInteractionDependencies>
}

export interface McuInteractionHandle {
  interactionId: string
  done: Promise<void>
  abort: () => void
}

interface McuInteractionDependencies {
  startRun: typeof startRunViaSocket
  transcribe: typeof transcribeSpeech
  synthesize: typeof synthesizeSpeech
  makeInteractionId: () => string
}

const PARAGRAPH_END_RE = /[。！？!?.…][\s"'”’）)\]】》]*$/
const HIDDEN_REASONING_BLOCK_RE = /<(think|thinking)\b[^>]*>[\s\S]*?<\/\1>/gi
const UNCLOSED_HIDDEN_REASONING_BLOCK_RE = /<(think|thinking)\b[^>]*>[\s\S]*/gi
const FENCED_CODE_BLOCK_RE = /```[\s\S]*?```/g
const UNCLOSED_FENCED_CODE_BLOCK_RE = /```[\s\S]*/g
const INLINE_CODE_RE = /`[^`\n]+`/g
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g
const HTML_DECLARATION_RE = /<![^>]*>/g
const HTML_TAG_RE = /<\/?[a-zA-Z][\w:-]*(?:\s+(?:[^"'<>]|"[^"]*"|'[^']*')*)?\s*\/?>/g
const KEYCAP_EMOJI_RE = /[0-9#*]\uFE0F?\u20E3/gu
const EMOJI_RE = /\p{Extended_Pictographic}[\uFE0E\uFE0F\u{E0100}-\u{E01EF}]?(?:\u200D\p{Extended_Pictographic}[\uFE0E\uFE0F\u{E0100}-\u{E01EF}]?)*/gu
const SYMBOL_RE = /[\p{So}\p{Sk}\uFE0E\uFE0F\u{E0100}-\u{E01EF}\u200D\u20E3\u2190-\u21FF\u2300-\u23FF\u2460-\u24FF\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF]/gu
const CONTROL_RE = /[\p{Cc}\p{Cf}]/gu

const defaultDeps: McuInteractionDependencies = {
  startRun: startRunViaSocket,
  transcribe: transcribeSpeech,
  synthesize: synthesizeSpeech,
  makeInteractionId: () => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
    return `mcu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  },
}

function isMarkdownTableLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  const pipeCount = (trimmed.match(/\|/g) || []).length
  return pipeCount >= 2
    || /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(trimmed)
}

function normalizeSpeechText(text: string): string {
  const withoutTables = text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/[^\s<>)\]]+/gi, ' ')
    .replace(/www\.[^\s<>)\]]+/gi, ' ')
    .split(/\r?\n/)
    .filter(line => !isMarkdownTableLine(line))
    .join('\n')

  return withoutTables
    .replace(HIDDEN_REASONING_BLOCK_RE, ' ')
    .replace(UNCLOSED_HIDDEN_REASONING_BLOCK_RE, ' ')
    .replace(FENCED_CODE_BLOCK_RE, ' ')
    .replace(UNCLOSED_FENCED_CODE_BLOCK_RE, ' ')
    .replace(INLINE_CODE_RE, ' ')
    .replace(HTML_COMMENT_RE, ' ')
    .replace(HTML_DECLARATION_RE, ' ')
    .replace(HTML_TAG_RE, ' ')
    .replace(KEYCAP_EMOJI_RE, ' ')
    .replace(EMOJI_RE, ' ')
    .replace(SYMBOL_RE, ' ')
    .replace(CONTROL_RE, ' ')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function paragraphEndsNormally(text: string): boolean {
  return PARAGRAPH_END_RE.test(text.trimEnd())
}

function sentenceBoundary(text: string, index: number): number {
  const char = text[index]
  if (!/[。！？!?…\.]/.test(char)) return -1

  if (char === '.') {
    const previous = text[index - 1] || ''
    const next = text[index + 1] || ''
    if (/\d/.test(previous) && /\d/.test(next)) return -1
    if (next && !/[\s"'”’）)\]】》]/.test(next)) return -1

    const word = text.slice(0, index).match(/([A-Za-z]+)$/)?.[1]?.toLowerCase() || ''
    if (!next && /^(?:mr|mrs|ms|dr|prof|sr|jr|vs|etc|e|g|i)$/.test(word)) return -1
  }

  let end = index + 1
  while (end < text.length && /[。！？!?…\."'”’）)\]】》]/.test(text[end])) end += 1
  return end
}

function findReadyParagraphBoundary(text: string, emitOnSentenceEnd = false): number {
  let inFence = false
  let inInlineCode = false
  let inLinkText = false
  let inLinkUrl = false
  let inUrl = false

  for (let i = 0; i < text.length; i += 1) {
    const rest = text.slice(i)

    if (rest.startsWith('```')) {
      inFence = !inFence
      i += 2
      continue
    }

    if (inFence) continue

    const char = text[i]

    if (char === '`') {
      inInlineCode = !inInlineCode
      continue
    }
    if (inInlineCode) continue

    if (inLinkUrl) {
      if (char === ')') inLinkUrl = false
      continue
    }

    if (inUrl) {
      if (/\s/.test(char)) inUrl = false
      else continue
    }

    if (rest.startsWith('http://') || rest.startsWith('https://') || rest.startsWith('www.')) {
      inUrl = true
      if (rest.startsWith('https://')) i += 7
      else if (rest.startsWith('http://')) i += 6
      else i += 3
      continue
    }
    if (inLinkText) {
      if (char === ']' && text[i + 1] === '(') {
        inLinkText = false
        inLinkUrl = true
        i += 1
      }
      continue
    }
    if (char === '[') {
      inLinkText = true
      continue
    }

    if (emitOnSentenceEnd) {
      const end = sentenceBoundary(text, i)
      if (end > 0) return end
    }

    if (char === '\n' || char === '\r') {
      let end = i + 1
      if (char === '\r' && text[i + 1] === '\n') {
        end += 1
        i += 1
      }
      if (emitOnSentenceEnd) {
        const lineStart = Math.max(text.lastIndexOf('\n', i - 1), text.lastIndexOf('\r', i - 1)) + 1
        const line = text.slice(lineStart, i)
        if (isMarkdownTableLine(line)) return end
      }
      if (paragraphEndsNormally(text.slice(0, end))) return end
    }
  }

  return -1
}

export function createMcuSpeechSegmenter(options: McuSpeechSegmenterOptions = {}): McuSpeechSegmenter {
  let buffer = ''

  function takeReadySegments(force = false): string[] {
    const segments: string[] = []

    while (buffer.length > 0) {
      let end = findReadyParagraphBoundary(buffer, options.emitOnSentenceEnd)

      if (end < 0) {
        if (!force) break
        end = buffer.length
      }

      const segment = normalizeSpeechText(buffer.slice(0, end))
      buffer = buffer.slice(end)

      if (segment) {
        segments.push(segment)
      }
    }

    return segments
  }

  return {
    pushDelta(delta: string): string[] {
      if (!delta) return []
      buffer += delta
      return takeReadySegments(false)
    },
    flush(): string | null {
      const segments = takeReadySegments(true)
      return segments.length ? segments.join(' ') : null
    },
    reset(): void {
      buffer = ''
    },
  }
}

export function mcuEventsFromRunEvent(event: RunEvent, interactionId: string): Array<McuStatusEvent | McuToolEvent> {
  if (event.event === 'run.started') {
    return [{ type: 'interaction.status', interactionId, status: 'thinking' }]
  }

  if (event.event === 'tool.started') {
    return [
      {
        type: 'interaction.status',
        interactionId,
        status: 'tool',
        text: event.tool || event.name || 'tool',
      },
      {
        type: 'tool.started',
        interactionId,
        tool: event.tool || event.name || 'tool',
        preview: event.preview,
      },
    ]
  }

  if (event.event === 'tool.completed') {
    return [
      {
        type: 'tool.completed',
        interactionId,
        tool: event.tool || event.name || 'tool',
        preview: event.preview,
        error: event.error,
      },
      { type: 'interaction.status', interactionId, status: 'thinking' },
    ]
  }

  if (event.event === 'run.failed') {
    return [{
      type: 'interaction.status',
      interactionId,
      status: 'failed',
      text: event.error || 'run failed',
    }]
  }

  if (event.event === 'abort.completed') {
    return [{ type: 'interaction.status', interactionId, status: 'aborted' }]
  }

  return []
}

export function startMcuVoiceInteraction(options: StartMcuVoiceInteractionOptions): McuInteractionHandle {
  const deps = { ...defaultDeps, ...options.deps }
  const interactionId = options.sessionId || deps.makeInteractionId()
  const segmenter = createMcuSpeechSegmenter()
  let runHandle: { abort: () => void } | null = null
  let aborted = false
  let ttsQueue = Promise.resolve()
  let segmentIndex = 0

  const emit = async (event: McuStatusEvent | McuToolEvent) => {
    await options.transport.send(event)
  }

  const enqueueSpeech = (text: string) => {
    const segmentText = normalizeSpeechText(text)
    if (!segmentText) return
    const segmentId = `${interactionId}-${++segmentIndex}`

    ttsQueue = ttsQueue.then(async () => {
      if (aborted) return
      await emit({ type: 'interaction.status', interactionId, status: 'speaking', text: segmentText })
      const result = await deps.synthesize({
        provider: options.ttsProvider,
        text: segmentText,
        options: options.ttsOptions || {},
      })
      if (aborted) return
      await options.transport.enqueueAudio({
        interactionId,
        segmentId,
        text: segmentText,
        audio: result.audio,
        mimeType: result.audio.type || 'audio/mpeg',
        engine: result.engine,
        provider: result.provider,
      })
    })
  }

  const done = (async () => {
    try {
      await options.transport.clearAudio(interactionId)
      await emit({ type: 'interaction.status', interactionId, status: 'transcribing' })

      const transcript = await deps.transcribe({
        audio: options.audio,
        provider: options.sttProvider,
        language: options.language,
        prompt: options.prompt,
      })
      if (aborted) return

      await emit({ type: 'interaction.status', interactionId, status: 'thinking', text: transcript.text })

      await new Promise<void>((resolve, reject) => {
        runHandle = deps.startRun(
          {
            ...(options.run || {}),
            input: transcript.text,
            session_id: interactionId,
            profile: options.profile,
            source: 'global_agent',
            session_source: 'global_agent',
          },
          event => {
            for (const mapped of mcuEventsFromRunEvent(event, interactionId)) {
              void emit(mapped)
            }

            if (event.event === 'message.delta' && event.delta) {
              for (const segment of segmenter.pushDelta(event.delta)) {
                enqueueSpeech(segment)
              }
            }
          },
          () => {
            const tail = segmenter.flush()
            if (tail) enqueueSpeech(tail)
            resolve()
          },
          reject,
        )
      })

      await ttsQueue
      if (!aborted) {
        await emit({ type: 'interaction.status', interactionId, status: 'completed' })
      }
    } catch (err) {
      if (aborted) return
      await emit({
        type: 'interaction.status',
        interactionId,
        status: 'failed',
        text: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  })()

  return {
    interactionId,
    done,
    abort: () => {
      if (aborted) return
      aborted = true
      segmenter.reset()
      runHandle?.abort()
      void options.transport.clearAudio(interactionId)
      void emit({ type: 'interaction.status', interactionId, status: 'aborted' })
    },
  }
}
