import { randomUUID } from 'crypto'
import { logger } from '../../public/logging'

export const RELAY_DOWNLOAD_CHUNK_BYTES = 256 * 1024
const RELAY_DOWNLOAD_SESSION_TTL_MS = 5 * 60 * 1000

export interface RelayDownloadDescriptor {
  id: string
  totalBytes: number
}

export interface RelayDownloadChunk {
  id: string
  bodyBytes: Uint8Array
  receivedBytes: number
  totalBytes: number
  done: boolean
}

interface RelayDownloadSession {
  id: string
  ownerId: string
  reader: ReadableStreamDefaultReader<Uint8Array>
  buffered: Uint8Array | null
  bufferedOffset: number
  sourceDone: boolean
  sourceBytes: number
  receivedBytes: number
  totalBytes: number
  attemptedChunks: number
  completedChunks: number
  createdAt: number
  lastActivityAt: number
  busy: boolean
  timer: ReturnType<typeof setTimeout> | null
}

export interface RelayDownloadSessionDiagnostic {
  downloadId: string
  ownerId: string
  sessionFound: boolean
  receivedBytes: number
  totalBytes: number
  sourceBytes: number
  sourceDone: boolean
  attemptedChunks: number
  completedChunks: number
  busy: boolean
  ageMs: number
  idleMs: number
}

export class RelayDownloadSessionError extends Error {
  readonly causeMessage: string

  constructor(
    public readonly code: string,
    public readonly diagnostic: RelayDownloadSessionDiagnostic,
    cause?: unknown,
  ) {
    super(code)
    this.name = 'RelayDownloadSessionError'
    this.causeMessage = cause instanceof Error ? cause.message : cause == null ? '' : String(cause)
  }
}

export class RelayDownloadSessions {
  private readonly sessions = new Map<string, RelayDownloadSession>()

  create(ownerId: string, response: Response): RelayDownloadDescriptor {
    if (!response.body) {
      throw new RelayDownloadSessionError('download_body_missing', missingSessionDiagnostic(ownerId, ''))
    }
    const id = randomUUID()
    const now = Date.now()
    const session: RelayDownloadSession = {
      id,
      ownerId,
      reader: response.body.getReader(),
      buffered: null,
      bufferedOffset: 0,
      sourceDone: false,
      sourceBytes: 0,
      receivedBytes: 0,
      totalBytes: declaredResponseBodyBytes(response),
      attemptedChunks: 0,
      completedChunks: 0,
      createdAt: now,
      lastActivityAt: now,
      busy: false,
      timer: null,
    }
    session.timer = this.expiryTimer(id)
    this.sessions.set(id, session)
    return { id, totalBytes: session.totalBytes }
  }

  async read(
    ownerId: string,
    id: string,
    maxChunkBytes = RELAY_DOWNLOAD_CHUNK_BYTES,
    maxTotalBytes = Number.MAX_SAFE_INTEGER,
  ): Promise<RelayDownloadChunk> {
    const session = this.sessions.get(id)
    if (!session || session.ownerId !== ownerId) {
      throw new RelayDownloadSessionError('download_not_found', missingSessionDiagnostic(ownerId, id))
    }
    if (session.busy) {
      throw new RelayDownloadSessionError('download_busy', sessionDiagnostic(session))
    }
    if (session.totalBytes > maxTotalBytes || session.receivedBytes > maxTotalBytes) {
      const diagnostic = sessionDiagnostic(session)
      this.cancel(ownerId, id)
      throw new RelayDownloadSessionError('download_too_large', diagnostic)
    }

    session.attemptedChunks += 1
    session.busy = true
    this.refreshExpiry(session)
    try {
      const chunkLimit = Math.max(1, Math.min(RELAY_DOWNLOAD_CHUNK_BYTES, Math.floor(maxChunkBytes)))
      const output: Buffer[] = []
      let outputBytes = 0
      while (outputBytes < chunkLimit) {
        if (session.buffered && session.bufferedOffset < session.buffered.byteLength) {
          const remaining = chunkLimit - outputBytes
          const take = Math.min(remaining, session.buffered.byteLength - session.bufferedOffset)
          output.push(Buffer.from(
            session.buffered.buffer,
            session.buffered.byteOffset + session.bufferedOffset,
            take,
          ))
          session.bufferedOffset += take
          outputBytes += take
          if (session.bufferedOffset >= session.buffered.byteLength) {
            session.buffered = null
            session.bufferedOffset = 0
          }
          continue
        }
        if (session.sourceDone) break
        let next: ReadableStreamReadResult<Uint8Array>
        try {
          next = await session.reader.read()
        } catch (error) {
          const diagnostic = sessionDiagnostic(session)
          this.finish(session)
          throw new RelayDownloadSessionError('download_source_read_failed', diagnostic, error)
        }
        if (next.done) {
          session.sourceDone = true
          break
        }
        if (!next.value?.byteLength) continue
        session.sourceBytes += next.value.byteLength
        if (session.sourceBytes > maxTotalBytes) {
          const diagnostic = sessionDiagnostic(session)
          this.cancel(ownerId, id)
          throw new RelayDownloadSessionError('download_too_large', diagnostic)
        }
        if (session.totalBytes > 0 && session.sourceBytes > session.totalBytes) {
          const diagnostic = sessionDiagnostic(session)
          this.cancel(ownerId, id)
          throw new RelayDownloadSessionError('download_size_mismatch', diagnostic)
        }
        session.buffered = next.value
        session.bufferedOffset = 0
        // Content-Length is authoritative for these authenticated local file
        // responses. Once every declared byte has arrived, do not perform one
        // extra reader.read() merely to observe EOF: some native/HTTP bridges
        // report the closing stream as an error after delivering all bytes.
        if (session.totalBytes > 0 && session.sourceBytes === session.totalBytes) {
          session.sourceDone = true
        }
      }

      session.receivedBytes += outputBytes
      const declaredComplete = session.totalBytes > 0 && session.receivedBytes >= session.totalBytes
      if (session.totalBytes > 0 && session.receivedBytes > session.totalBytes) {
        const diagnostic = sessionDiagnostic(session)
        this.cancel(ownerId, id)
        throw new RelayDownloadSessionError('download_size_mismatch', diagnostic)
      }
      const done = declaredComplete || (session.sourceDone && !session.buffered)
      const bodyBytes = Uint8Array.from(Buffer.concat(output, outputBytes))
      session.completedChunks += 1
      if (done) this.finish(session)
      return {
        id,
        bodyBytes,
        receivedBytes: session.receivedBytes,
        totalBytes: session.totalBytes,
        done,
      }
    } finally {
      const current = this.sessions.get(id)
      if (current) current.busy = false
    }
  }

  cancel(ownerId: string, id: string): boolean {
    const session = this.sessions.get(id)
    if (!session || session.ownerId !== ownerId) return false
    this.finish(session)
    return true
  }

  cancelOwner(ownerId: string): void {
    for (const session of Array.from(this.sessions.values())) {
      if (session.ownerId === ownerId) this.finish(session)
    }
  }

  cancelAll(): void {
    for (const session of Array.from(this.sessions.values())) this.finish(session)
  }

  private refreshExpiry(session: RelayDownloadSession): void {
    if (session.timer) clearTimeout(session.timer)
    session.lastActivityAt = Date.now()
    session.timer = this.expiryTimer(session.id)
  }

  private expiryTimer(id: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const session = this.sessions.get(id)
      if (session) {
        logger.warn(sessionDiagnostic(session), '[app-relay] download session expired')
        this.finish(session)
      }
    }, RELAY_DOWNLOAD_SESSION_TTL_MS)
    timer.unref?.()
    return timer
  }

  private finish(session: RelayDownloadSession): void {
    if (session.timer) clearTimeout(session.timer)
    this.sessions.delete(session.id)
    void session.reader.cancel().catch(() => undefined)
  }
}

function sessionDiagnostic(session: RelayDownloadSession): RelayDownloadSessionDiagnostic {
  const now = Date.now()
  return {
    downloadId: session.id,
    ownerId: session.ownerId,
    sessionFound: true,
    receivedBytes: session.receivedBytes,
    totalBytes: session.totalBytes,
    sourceBytes: session.sourceBytes,
    sourceDone: session.sourceDone,
    attemptedChunks: session.attemptedChunks,
    completedChunks: session.completedChunks,
    busy: session.busy,
    ageMs: Math.max(0, now - session.createdAt),
    idleMs: Math.max(0, now - session.lastActivityAt),
  }
}

function missingSessionDiagnostic(ownerId: string, id: string): RelayDownloadSessionDiagnostic {
  return {
    downloadId: id,
    ownerId,
    sessionFound: false,
    receivedBytes: 0,
    totalBytes: 0,
    sourceBytes: 0,
    sourceDone: false,
    attemptedChunks: 0,
    completedChunks: 0,
    busy: false,
    ageMs: 0,
    idleMs: 0,
  }
}

function declaredResponseBodyBytes(response: Response): number {
  const value = Number(response.headers.get('content-length'))
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}
