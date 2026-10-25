import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { StudioError, type ProcessSpawnInput, type ProcessHandle, type ProcessReadResult, type ProcessExit, type RuntimeProcesses } from '../../contracts/plugins'
import { windowsCommandNeedsShell, windowsCmdShimExecution } from '../../public/windows-command'
import { jsonCopy } from '../plugins/validation'
import { ManagedPtyProcess, parseTerminalSize } from './pty'

const CHUNK_BYTES = 16_384, BUFFER_BYTES = 262_144, WRITE_BYTES = 65_536
let liveProcesses = 0

export function managedProcessEnvironment(parent: NodeJS.ProcessEnv, additions: Record<string, string> = {}, platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  const name = (key: string) => platform === 'win32' ? key.toUpperCase() : key
  for (const [key, value] of Object.entries(parent)) {
    if (['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG'].includes(key.toUpperCase()) || key.startsWith('LC_')) env[name(key)] = value
  }
  for (const [key, value] of Object.entries(additions)) env[name(key)] = value
  return { ...env, ELECTRON_RUN_AS_NODE: '1' }
}

export function parseProcessSpawn(value: unknown, platform = process.platform): ProcessSpawnInput {
  const input = jsonCopy(value, 262_144) as ProcessSpawnInput
  const string = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0')
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['command', 'args', 'cwd', 'env', 'terminal'].includes(key))
    || !string(input.command, 4096) || !input.command.trim()
    || !string(input.cwd, 4096) || !isAbsolute(input.cwd)
    || !Array.isArray(input.args) || input.args.length > 256 || input.args.some(arg => !string(arg, 65_536))
    || (input.env !== undefined && (!input.env || typeof input.env !== 'object' || Array.isArray(input.env)
      || Object.keys(input.env).length > 128 || Object.entries(input.env).some(([key, value]) => !/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(key) || !string(value, 65_536))))) {
    throw new StudioError('INVALID_ARGUMENT', 'Invalid managed process input')
  }
  if (platform === 'win32' && windowsCommandNeedsShell(input.command) && [input.command, ...input.args].some(value => /[\r\n]/.test(value))) {
    throw new StudioError('CAPABILITY_UNSUPPORTED', 'Multiline Windows shim arguments require stdin or a prompt file')
  }
  if (input.terminal !== undefined) parseTerminalSize(input.terminal)
  return input
}

class ManagedProcess {
  readonly id = randomUUID()
  readonly closed: Promise<void>
  private result: ProcessExit | null = null
  private error?: StudioError
  private chunks: ProcessReadResult['chunks'] = []
  private bytes = 0
  private truncated = false
  private wake?: () => void
  private reading = false
  private writing = false
  private stopping?: Promise<void>
  private disposed = false
  private disposal?: Promise<void>
  private readonly child: ChildProcessWithoutNullStreams
  readonly spawned: Promise<void>

  constructor(input: ProcessSpawnInput, private readonly authorize: () => void, onExit: () => void) {
    const execution = process.platform === 'win32' && windowsCommandNeedsShell(input.command)
      ? windowsCmdShimExecution(input.command, input.args) : { command: input.command, args: input.args }
    this.child = spawn(execution.command, execution.args, { cwd: input.cwd, env: managedProcessEnvironment(process.env, input.env),
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
      ...('windowsVerbatimArguments' in execution ? { windowsVerbatimArguments: execution.windowsVerbatimArguments } : {}),
    })
    this.spawned = new Promise((resolve, reject) => {
      this.child.once('spawn', resolve)
      this.child.once('error', () => { this.error = new StudioError('RUNTIME_UNAVAILABLE', 'Managed process could not start'); reject(this.error); this.wake?.() })
    })
    for (const stream of ['stdout', 'stderr'] as const) this.child[stream].on('data', (data: Buffer) => {
      if (this.disposed || this.stopping) { this.truncated = true; return }
      for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
        const chunk = Uint8Array.from(data.subarray(offset, offset + CHUNK_BYTES))
        this.chunks.push({ stream, data: chunk }); this.bytes += chunk.length
      }
      if (this.bytes >= BUFFER_BYTES) { this.child.stdout.pause(); this.child.stderr.pause() }
      this.wake?.()
    })
    this.child.stdin.on('error', () => {}) // Individual writes receive a sanitized failure.
    // A completed parent does not transfer ownership of its process group to the OS.
    this.child.once('exit', () => { if (process.platform !== 'win32') void this.kill('SIGKILL') })
    this.closed = new Promise(resolve => this.child.once('close', (code, signal) => {
      this.result = { code, signal }; onExit(); this.wake?.(); resolve()
    }))
  }

  handle(): ProcessHandle {
    return Object.freeze({ id: this.id, read: () => this.read(), write: (data: Uint8Array) => this.write(data),
      end: () => this.end(), stop: () => this.stop(), dispose: () => this.dispose() })
  }

  private check(): void {
    if (this.disposed) throw new StudioError('NOT_FOUND', 'Process handle was released')
    this.authorize()
    if (this.error) throw this.error
  }

  private async read(): Promise<ProcessReadResult> {
    this.check()
    if (this.reading) throw new StudioError('REVISION_CONFLICT', 'Process already has a reader')
    this.reading = true
    try {
      if (!this.chunks.length && !this.result) await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.wake = undefined; resolve() }, 1000)
        this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve() }
      })
      this.check()
      const chunks = this.chunks.splice(0, 4)
      this.bytes -= chunks.reduce((sum, chunk) => sum + chunk.data.length, 0)
      if (this.bytes < BUFFER_BYTES / 2) { this.child.stdout.resume(); this.child.stderr.resume() }
      return { chunks, truncated: this.truncated, exit: this.result && { ...this.result } }
    } finally { this.reading = false }
  }

  private async write(data: Uint8Array): Promise<void> {
    this.check()
    if (!(data instanceof Uint8Array) || data.length > WRITE_BYTES) throw new StudioError('INVALID_ARGUMENT', 'Process writes accept at most 64 KiB')
    if (this.writing) throw new StudioError('RESOURCE_EXHAUSTED', 'Previous process write has not drained')
    if (!this.child.stdin.writable || this.result || this.stopping) throw new StudioError('RUNTIME_UNAVAILABLE', 'Process stdin is closed')
    const copy = Buffer.from(data)
    this.writing = true
    try {
      await new Promise<void>((resolve, reject) => this.child.stdin.write(copy, error => error
        ? reject(new StudioError('RUNTIME_UNAVAILABLE', 'Process write failed')) : resolve()))
      this.check()
    } finally { this.writing = false }
  }

  private async end(): Promise<void> {
    this.check()
    if (this.writing) throw new StudioError('REVISION_CONFLICT', 'Process write has not drained')
    if (this.child.stdin.writable) this.child.stdin.end()
  }

  private async kill(signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    if (!this.child.pid) return
    if (process.platform === 'win32') {
      await new Promise<void>((resolve, reject) => execFile('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'], { timeout: 5000, windowsHide: true }, error => {
        if (error) {
          try { this.child.kill('SIGKILL') } catch {}
          reject(new StudioError('RUNTIME_UNAVAILABLE', 'Managed process tree exit is unconfirmed'))
        } else resolve()
      }))
    } else {
      try { process.kill(-this.child.pid, signal) } catch { try { this.child.kill(signal) } catch {} }
    }
  }

  stop(): Promise<void> {
    return this.stopping ??= (async () => {
      if (this.result) return
      // Cleanup must progress even if nobody consumes a paused output stream.
      this.child.stdout.resume(); this.child.stderr.resume()
      const escalate = process.platform === 'win32' ? undefined : setTimeout(() => { void this.kill('SIGKILL') }, 1000)
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([Promise.all([this.closed, this.kill('SIGTERM')]), new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new StudioError('RUNTIME_UNAVAILABLE', 'Managed process exit is unconfirmed')), 5000)
        })])
      } finally { if (escalate) clearTimeout(escalate); if (deadline) clearTimeout(deadline) }
    })()
  }

  dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      this.disposed = true; this.chunks = []; this.bytes = 0; this.wake?.()
      await this.stop()
    })()
  }
}

/** Shared by builtins and worker proxies; identity and authority stay in this closure. */
export class ManagedProcessScope {
  private readonly entries = new Map<string, ManagedProcess | ManagedPtyProcess>()
  private closing?: Promise<void>
  private ended = false
  readonly api: RuntimeProcesses = Object.freeze({ spawn: (input: ProcessSpawnInput) => this.spawn(input) })
  private readonly aborted = () => { void this.close().catch(() => {}) }

  constructor(private readonly signal: AbortSignal, private readonly authorize: () => void) {
    signal.addEventListener('abort', this.aborted, { once: true })
    if (signal.aborted) this.aborted()
  }

  private check(): void {
    if (this.ended || this.signal.aborted) throw new StudioError('CANCELLED', 'Runtime process scope ended')
    try { this.authorize() } catch (error) { this.aborted(); throw error }
  }

  private async spawn(value: ProcessSpawnInput): Promise<ProcessHandle> {
    this.check()
    const input = parseProcessSpawn(value)
    if (liveProcesses >= 128 || this.entries.size >= 64) throw new StudioError('RESOURCE_EXHAUSTED', 'Managed process limit reached')
    liveProcesses++
    let entry: ManagedProcess | ManagedPtyProcess
    try { entry = input.terminal ? new ManagedPtyProcess({ ...input, terminal: input.terminal }, managedProcessEnvironment(process.env, input.env), () => this.check(), () => { liveProcesses-- })
      : new ManagedProcess(input, () => this.check(), () => { liveProcesses-- }) }
    catch (error) { liveProcesses--; if (error instanceof StudioError) throw error; throw new StudioError('RUNTIME_UNAVAILABLE', 'Managed process could not start') }
    this.entries.set(entry.id, entry)
    try { await entry.spawned; this.check() }
    catch (error) { await entry.dispose(); this.entries.delete(entry.id); throw error }
    const handle = entry.handle()
    return Object.freeze({ ...handle, dispose: async () => { await handle.dispose(); this.entries.delete(entry.id) } })
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.ended = true; this.signal.removeEventListener('abort', this.aborted)
    this.closing = Promise.all([...this.entries.values()].map(entry => entry.dispose())).then(() => { this.entries.clear() })
    return this.closing
  }
}
