import { randomUUID } from 'crypto'

export const MOBILE_TERMINAL_LIMITS = {
  retentionMs: 30 * 60_000, maxSessions: 4, bufferBytes: 2 * 1024 * 1024,
  inputBytes: 16 * 1024, readBytes: 32 * 1024,
} as const

export interface TerminalProcess {
  pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(callback: (data: string) => void): unknown
  onExit(callback: (event: { exitCode: number }) => void): unknown
}

export interface TerminalScope { owner: string; userId: number; profile: string; source: string; sourceId: string }
export interface TerminalChunk { seq: number; data: string }
export interface TerminalOutput {
  chunks: TerminalChunk[]; cursor: number; latest: number; truncated: boolean; exitCode: number | null
}
interface OutputStream {
  cursor: number; sent: number; pending: number[]; exitSent: boolean
  send: (output: TerminalOutput) => void; timer?: ReturnType<typeof setTimeout>
}
interface Session {
  id: string; scope: TerminalScope; requestId: string; cwd: string; shell: string
  process: TerminalProcess; createdAt: number; detachedAt: number | null
  writer: string | null; lease: string; inputSeq: number; seq: number
  pendingInput: Map<number, string>
  chunks: TerminalChunk[]; bytes: number; exitCode: number | null
  stream?: OutputStream
}

function matches(a: TerminalScope, b: TerminalScope): boolean {
  return a.owner === b.owner && a.profile === b.profile && a.source === b.source && a.sourceId === b.sourceId
}

export function terminalDimensions(cols: unknown, rows: unknown): { cols: number; rows: number } {
  if (!Number.isInteger(cols) || !Number.isInteger(rows)
    || Number(cols) < 2 || Number(cols) > 500 || Number(rows) < 1 || Number(rows) > 300) {
    throw new Error('terminal_invalid_size')
  }
  return { cols: Number(cols), rows: Number(rows) }
}

/** PTY ownership survives transport loss. Output is read or pushed in bounded batches. */
export class MobileTerminalSessions {
  private sessions = new Map<string, Session>()
  constructor(
    private spawn: (cwd: string, shell: string, cols: number, rows: number) => TerminalProcess,
    private now = () => Date.now(),
  ) {}

  create(scope: TerminalScope, requestId: string, cwd: string, shell: string, cols: number, rows: number) {
    this.sweep()
    if (typeof requestId !== 'string' || !/^[\w-]{8,100}$/.test(requestId)) throw new Error('terminal_invalid_request')
    const existing = [...this.sessions.values()].find(s => matches(s.scope, scope) && s.requestId === requestId)
    if (existing) return this.info(existing)
    if ([...this.sessions.values()].filter(s => s.scope.userId === scope.userId).length >= MOBILE_TERMINAL_LIMITS.maxSessions) {
      throw new Error('terminal_limit')
    }
    terminalDimensions(cols, rows)
    const process = this.spawn(cwd, shell, cols, rows)
    const session: Session = {
      id: randomUUID(), scope: { ...scope }, requestId, cwd, shell, process, createdAt: this.now(),
      detachedAt: this.now(), writer: null, lease: '', inputSeq: 0, pendingInput: new Map(), seq: 0, chunks: [], bytes: 0, exitCode: null,
    }
    this.sessions.set(session.id, session)
    process.onData(data => {
      // Split by code points so transport batches never split UTF-8 characters.
      let part = ''; let bytes = 0
      const append = () => {
        if (!part) return
        session.chunks.push({ seq: ++session.seq, data: part }); session.bytes += bytes
        part = ''; bytes = 0
      }
      for (const char of data) {
        const size = Buffer.byteLength(char)
        if (bytes + size > 4096) append()
        part += char; bytes += size
      }
      append()
      while (session.bytes > MOBILE_TERMINAL_LIMITS.bufferBytes) {
        session.bytes -= Buffer.byteLength(session.chunks.shift()!.data)
      }
      this.scheduleOutput(session)
    })
    process.onExit(({ exitCode }) => {
      session.exitCode = exitCode
      session.detachedAt = this.now()
      this.scheduleOutput(session)
    })
    return this.info(session)
  }

  list(scope: TerminalScope) {
    this.sweep()
    return [...this.sessions.values()].filter(s => matches(s.scope, scope)).map(s => this.info(s))
  }

  attach(scope: TerminalScope, id: string, writer: string) {
    const session = this.get(scope, id)
    this.stopOutput(session)
    session.writer = writer; session.lease = randomUUID(); session.inputSeq = 0
    session.pendingInput.clear()
    if (session.exitCode === null) session.detachedAt = null
    return { ...this.info(session), lease: session.lease, inputSeq: session.inputSeq }
  }

  read(scope: TerminalScope, id: string, writer: string, lease: string, cursor: number) {
    return this.readOutput(this.writable(scope, id, writer, lease), cursor)
  }

  private readOutput(session: Session, cursor: number): TerminalOutput {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > session.seq) throw new Error('terminal_invalid_cursor')
    let bytes = 0
    const chunks: TerminalChunk[] = []
    const start = Math.max(0, cursor - (session.chunks[0]?.seq ?? 1) + 1)
    for (let index = start; index < session.chunks.length; index++) {
      const chunk = session.chunks[index]
      const size = Buffer.byteLength(chunk.data)
      if (bytes + size > MOBILE_TERMINAL_LIMITS.readBytes) break
      chunks.push(chunk); bytes += size
    }
    return {
      chunks, truncated: cursor < (session.chunks[0]?.seq ?? session.seq + 1) - 1,
      cursor: chunks.at(-1)?.seq ?? cursor, latest: session.seq, exitCode: session.exitCode,
    }
  }

  /** Reuse terminal.read for subscription and cumulative render acknowledgements.
   * Four bounded batches may be in flight; a slow renderer cannot grow the wire queue. */
  stream(scope: TerminalScope, id: string, writer: string, lease: string, cursor: number,
    send: (output: TerminalOutput) => void) {
    const session = this.writable(scope, id, writer, lease)
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > session.seq) throw new Error('terminal_invalid_cursor')
    const stream = session.stream
    if (stream) {
      if (cursor < stream.cursor || cursor > stream.sent
        || (cursor !== stream.cursor && !stream.pending.includes(cursor))) throw new Error('terminal_invalid_cursor')
      stream.cursor = cursor
      stream.pending = stream.pending.filter(seq => seq > cursor)
    } else {
      session.stream = { cursor, sent: cursor, pending: [], exitSent: false, send }
    }
    this.scheduleOutput(session)
    return { streaming: true }
  }

  private scheduleOutput(session: Session) {
    const stream = session.stream
    if (!stream || stream.timer || stream.pending.length >= 4) return
    stream.timer = setTimeout(() => {
      stream.timer = undefined
      if (session.stream !== stream) return
      while (stream.pending.length < 4) {
        const output = this.readOutput(session, stream.sent)
        if (!output.chunks.length && (output.exitCode === null || stream.exitSent)) break
        stream.sent = output.cursor
        stream.pending.push(output.cursor)
        if (output.exitCode !== null && output.cursor >= output.latest) stream.exitSent = true
        stream.send(output)
      }
    }, 8)
    stream.timer.unref()
  }

  private stopOutput(session: Session) {
    clearTimeout(session.stream?.timer)
    session.stream = undefined
  }

  input(scope: TerminalScope, id: string, writer: string, lease: string, seq: number, data: string) {
    const session = this.writable(scope, id, writer, lease)
    if (session.exitCode !== null) throw new Error('terminal_exited')
    if (!Number.isSafeInteger(seq) || seq <= session.inputSeq || seq > session.inputSeq + 8 || session.pendingInput.has(seq)) throw new Error('terminal_input_sequence')
    if (typeof data !== 'string' || Buffer.byteLength(data) > MOBILE_TERMINAL_LIMITS.inputBytes) throw new Error('terminal_input_too_large')
    // Relay authorization/throttling is asynchronous and may finish out of order.
    // Buffer only the bounded input window, then write contiguous sequences.
    session.pendingInput.set(seq, data)
    while (session.pendingInput.has(session.inputSeq + 1)) {
      const next = session.inputSeq + 1
      session.process.write(session.pendingInput.get(next)!)
      session.pendingInput.delete(next)
      session.inputSeq = next
    }
  }

  resize(scope: TerminalScope, id: string, writer: string, lease: string, cols: number, rows: number) {
    const session = this.writable(scope, id, writer, lease)
    const size = terminalDimensions(cols, rows)
    if (session.exitCode === null) session.process.resize(size.cols, size.rows)
  }

  detach(scope: TerminalScope, id: string, writer: string, lease: string) {
    const session = this.writable(scope, id, writer, lease)
    this.release(session)
  }

  detachWriter(writer: string) {
    for (const session of this.sessions.values()) if (session.writer === writer) this.release(session)
  }

  close(scope: TerminalScope, id: string) {
    if (!this.sessions.has(id)) return
    this.destroy(this.get(scope, id))
  }

  closeOwner(owner: string) {
    for (const session of this.sessions.values()) if (session.scope.owner === owner) this.destroy(session)
  }

  hasOwner(owner: string) { return [...this.sessions.values()].some(s => s.scope.owner === owner) }

  sweep() {
    for (const session of this.sessions.values()) {
      if (session.detachedAt !== null && this.now() - session.detachedAt >= MOBILE_TERMINAL_LIMITS.retentionMs) this.destroy(session)
    }
  }

  shutdown() { for (const session of this.sessions.values()) this.destroy(session) }

  private info(s: Session) {
    return { id: s.id, cwd: s.cwd, shell: s.shell.split(/[\\/]/).pop() || 'shell', pid: s.process.pid,
      createdAt: s.createdAt, expiresAt: s.detachedAt === null ? null : s.detachedAt + MOBILE_TERMINAL_LIMITS.retentionMs,
      exitCode: s.exitCode }
  }
  private get(scope: TerminalScope, id: string) {
    this.sweep()
    const session = this.sessions.get(id)
    if (!session || !matches(session.scope, scope)) throw new Error('terminal_not_found')
    return session
  }
  private writable(scope: TerminalScope, id: string, writer: string, lease: string) {
    const session = this.get(scope, id)
    if (session.writer !== writer || !lease || session.lease !== lease) throw new Error('terminal_taken_over')
    return session
  }
  private release(session: Session) {
    this.stopOutput(session)
    session.pendingInput.clear()
    session.writer = null; session.lease = ''
    session.detachedAt ??= this.now()
  }
  private destroy(session: Session) {
    this.stopOutput(session)
    session.pendingInput.clear()
    this.sessions.delete(session.id)
    if (session.exitCode === null) { try { session.process.kill() } catch { /* Already exited. */ } }
    session.chunks.length = 0
  }
}
