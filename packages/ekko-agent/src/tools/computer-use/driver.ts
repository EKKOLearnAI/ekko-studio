import { randomUUID } from 'node:crypto'
import type { CuaDriverLike } from '@trycua/cua-driver'
import { COMPUTER_USE_INPUT_TOOLS, COMPUTER_USE_READ_TOOLS } from './policy'
import { loadComputerUseSdk } from './sdk'

export class ComputerUseDriverSession {
  readonly id = `ekko-${randomUUID()}`
  readonly described = new Set<string>()
  private driver?: CuaDriverLike
  private readonly lifetime = new AbortController()
  private ready?: Promise<void>
  private tools: any[] = []
  private closed = false
  private closing?: Promise<void>
  private pendingCall: Promise<unknown> = Promise.resolve()

  constructor(private readonly timeoutMs: number) {}

  async list(signal?: AbortSignal): Promise<any[]> {
    signal?.throwIfAborted()
    if (this.closed) throw new Error('Computer Use connection has ended; start a new run and capture fresh state.')
    this.ready ??= this.connect(signal)
    await this.ready
    signal?.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
    return this.tools
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const operation = this.pendingCall.then(() => this.dispatch(name, args, signal))
    this.pendingCall = operation.catch(() => undefined)
    return operation
  }

  private async dispatch(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    await this.list(signal)
    try {
      const response = await this.request(
        cancellation => this.driver!.callTool(name, JSON.stringify(args), { signal: cancellation }), signal,
      )
      // Preserve the SDK's canonical envelope, including images and verification.
      return JSON.parse(response.rawJson)
    } catch (error) {
      // Cancellation reaches the native Rust future. Input may already have
      // taken effect, so neither a timeout nor cancellation permits replay.
      await this.close()
      throw new Error(`${this.diagnostic(error)} The action outcome is unknown; inspect fresh state before retrying.`)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return this.closing
    this.closed = true
    this.lifetime.abort()
    const driver = this.driver
    this.driver = undefined
    if (!driver) return
    this.closing = (async () => {
      try {
        await driver.shutdown({ signal: AbortSignal.timeout(5000) })
      } finally {
        const native = driver as CuaDriverLike & { uniffiDestroy?: () => void }
        native.uniffiDestroy?.()
      }
    })().catch(() => undefined)
    return this.closing
  }

  private async connect(signal?: AbortSignal): Promise<void> {
    try {
      const sdk = await loadComputerUseSdk()
      signal?.throwIfAborted()
      this.lifetime.signal.throwIfAborted()
      // Always embed the npm package's native library. create() would prefer
      // an installed daemon on macOS, so use the configured constructor.
      const mode = sdk.SessionPermissionMode.Standard
      this.driver = sdk.CuaDriver.createConfigured({
        claudeCodeCompatibility: false,
        authorization: {
          allowedModes: [mode], compatibilityMode: mode,
          unrestrictedAcknowledged: false,
          maxSessionTtlSeconds: 86_400n, maxIdleTtlSeconds: 300n,
        },
      })
      const inventory = JSON.parse(await this.request(cancellation => this.driver!.listToolsJson({ signal: cancellation }), signal))
      if (!Array.isArray(inventory.tools)) throw new Error('Cua SDK returned an invalid tool inventory')
      this.tools = inventory.tools.filter((tool: any) => COMPUTER_USE_READ_TOOLS.has(tool.name) || COMPUTER_USE_INPUT_TOOLS.has(tool.name))
      if (!this.tools.some(tool => tool.name === 'get_window_state')) throw new Error('Cua SDK does not advertise get_window_state')
    } catch (error) {
      await this.close()
      throw new Error(this.diagnostic(error))
    }
  }

  private async request<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new Error(`Computer Use timed out after ${this.timeoutMs} ms`)), this.timeoutMs)
    timer.unref()
    const cancellation = AbortSignal.any([this.lifetime.signal, timeout.signal, ...(signal ? [signal] : [])])
    try {
      cancellation.throwIfAborted()
      return await operation(cancellation)
    } finally {
      clearTimeout(timer)
    }
  }

  private diagnostic(error: unknown): string {
    return `CUA_SDK_FAILED: ${error instanceof Error ? error.message : String(error)}`
  }
}
