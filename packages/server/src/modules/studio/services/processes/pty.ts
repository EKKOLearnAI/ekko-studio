import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:os'
import type { IPty, IDisposable } from 'node-pty'
import { StudioError, type ProcessSpawnInput, type ProcessHandle, type ProcessExit, type ProcessReadResult } from '../../contracts/plugins'
import { windowsCommandNeedsShell, windowsCmdShimExecution } from '../../public/windows-command'

const CHUNK_BYTES = 16_384, BUFFER_BYTES = 262_144, WRITE_BUDGET = 1_048_576
export function parseTerminalSize(value: unknown): { cols: number; rows: number } {
  const size = value as { cols: number; rows: number }
  if (!size || typeof size !== 'object' || Array.isArray(size) || Object.keys(size).some(key => !['cols', 'rows'].includes(key))
    || !Number.isSafeInteger(size.cols) || size.cols < 2 || size.cols > 1000
    || !Number.isSafeInteger(size.rows) || size.rows < 2 || size.rows > 1000) throw new StudioError('INVALID_ARGUMENT', 'Invalid terminal dimensions')
  return { cols: size.cols, rows: size.rows }
}

/** A PTY is a runtime resource. It never selects a shell or inherits credentials. */
export class ManagedPtyProcess {
  readonly id = randomUUID()
  readonly spawned = Promise.resolve()
  private readonly terminal: IPty
  private readonly listeners: IDisposable[] = []
  private readonly closed: Promise<void>
  private exit: ProcessExit | null = null
  private chunks: ProcessReadResult['chunks'] = []
  private bytes = 0
  private written = 0
  private truncated = false
  private reading = false
  private disposed = false
  private wake?: () => void
  private stopping?: Promise<void>
  private disposal?: Promise<void>

  constructor(input: ProcessSpawnInput & { terminal: { cols: number; rows: number } }, env: NodeJS.ProcessEnv,
    private readonly authorize: () => void, onExit: () => void) {
    let pty: typeof import('node-pty')
    try { pty = require('node-pty') }
    catch { throw new StudioError('CAPABILITY_UNSUPPORTED', 'Native PTY support is unavailable') }
    const execution = process.platform === 'win32' && windowsCommandNeedsShell(input.command) ? windowsCmdShimExecution(input.command, input.args) : undefined
    this.terminal = pty.spawn(execution?.command || input.command, execution ? execution.args.join(' ') : input.args, {
      cwd: input.cwd, env, ...input.terminal, name: 'xterm-256color', encoding: null,
    })
    this.closed = new Promise(resolve => {
      this.listeners.push(this.terminal.onExit(result => {
        this.exit = { code: result.exitCode, signal: result.signal ? Object.entries(constants.signals).find(([, value]) => value === result.signal)?.[0] || String(result.signal) : null }
        onExit(); this.wake?.(); resolve()
        if (process.platform !== 'win32') void this.kill('SIGKILL').catch(() => {})
      }))
    })
    this.listeners.push(this.terminal.onData((value: string | Buffer) => {
      if (this.disposed || this.stopping) { this.truncated = true; return }
      const data = Buffer.isBuffer(value) ? value : Buffer.from(value)
      const length = Math.min(data.length, BUFFER_BYTES - this.bytes)
      for (let offset = 0; offset < length; offset += CHUNK_BYTES) {
        const chunk = Uint8Array.from(data.subarray(offset, Math.min(length, offset + CHUNK_BYTES)))
        this.chunks.push({ stream: 'stdout', data: chunk }); this.bytes += chunk.length
      }
      if (length < data.length) this.truncated = true
      // Pause with headroom for the current native read. Waiting until the hard
      // cap clips a partial chunk on platforms whose read sizes differ.
      if (this.bytes >= BUFFER_BYTES / 2) this.terminal.pause()
      this.wake?.()
    }))
  }

  private check() {
    if (this.disposed) throw new StudioError('NOT_FOUND', 'Terminal handle was released')
    this.authorize()
  }
  handle(): ProcessHandle {
    return Object.freeze({ id: this.id, read: () => this.read(), write: (data: Uint8Array) => this.write(data),
      end: async () => { this.check(); throw new StudioError('CAPABILITY_UNSUPPORTED', 'A terminal cannot close only its input; stop the process or send an explicit terminal control character') },
      resize: async (cols: number, rows: number) => {
        this.check(); const size = parseTerminalSize({ cols, rows })
        if (this.exit || this.stopping) throw new StudioError('RUNTIME_UNAVAILABLE', 'Terminal has exited')
        try { this.terminal.resize(size.cols, size.rows) } catch { throw new StudioError('RUNTIME_UNAVAILABLE', 'Terminal resize failed') }
        this.check()
      }, stop: () => this.stop(), dispose: () => this.dispose() })
  }
  private async read(): Promise<ProcessReadResult> {
    this.check()
    if (this.reading) throw new StudioError('REVISION_CONFLICT', 'Terminal already has a reader')
    this.reading = true
    try {
      if (!this.chunks.length && !this.exit) await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.wake = undefined; resolve() }, 1000)
        this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve() }
      })
      this.check()
      const chunks = this.chunks.splice(0, 4)
      this.bytes -= chunks.reduce((sum, chunk) => sum + chunk.data.length, 0)
      if (this.bytes < BUFFER_BYTES / 4 && !this.exit) this.terminal.resume()
      return { chunks, truncated: this.truncated, exit: this.exit && { ...this.exit } }
    } finally { this.reading = false }
  }
  private async write(data: Uint8Array): Promise<void> {
    this.check()
    if (!(data instanceof Uint8Array) || data.length > 65_536) throw new StudioError('INVALID_ARGUMENT', 'Terminal writes accept at most 64 KiB')
    if (this.exit || this.stopping) throw new StudioError('RUNTIME_UNAVAILABLE', 'Terminal has exited')
    // node-pty exposes no write-drain barrier. Bound cumulative admission rather
    // than allowing a blocked child to accumulate unlimited native input buffers.
    if (this.written + data.length > WRITE_BUDGET) throw new StudioError('RESOURCE_EXHAUSTED', 'Terminal input budget exceeded')
    this.written += data.length
    try { this.terminal.write(Buffer.from(data)) } catch { throw new StudioError('RUNTIME_UNAVAILABLE', 'Terminal write failed; native effects may be unknown') }
    this.check()
  }
  private async kill(signal: 'SIGTERM' | 'SIGKILL') {
    if (process.platform === 'win32') {
      await new Promise<void>((resolve, reject) => execFile('taskkill.exe', ['/PID', String(this.terminal.pid), '/T', '/F'], { timeout: 5000, windowsHide: true }, error => {
        if (error && !this.exit) { try { this.terminal.kill() } catch {}; reject(new StudioError('RUNTIME_UNAVAILABLE', 'Terminal process tree exit is unconfirmed')) }
        else resolve()
      }))
    } else {
      try { process.kill(-this.terminal.pid, signal) } catch { try { this.terminal.kill(signal) } catch {} }
    }
  }
  stop(): Promise<void> {
    return this.stopping ??= (async () => {
      if (this.exit) return
      try { this.terminal.resume() } catch {}
      const escalate = process.platform === 'win32' ? undefined : setTimeout(() => { void this.kill('SIGKILL').catch(() => {}) }, 1000)
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([Promise.all([this.closed, this.kill('SIGTERM')]), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StudioError('RUNTIME_UNAVAILABLE', 'Terminal exit is unconfirmed')), 5000)
      })]) }
      finally { if (timer) clearTimeout(timer); if (escalate) clearTimeout(escalate) }
    })()
  }
  dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      this.disposed = true; this.chunks = []; this.bytes = 0; this.wake?.()
      await this.stop()
      this.listeners.forEach(listener => listener.dispose())
    })()
  }
}
