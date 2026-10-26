import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { killOwnedProcessTree } from '../../../studio/public/process-tree'
import { discoveryError, ModelDiscoveryError, type DiscoveryRpc, type ModelDiscoveryContext } from './types'

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
export interface ModelCommand {
  command: string
  args?: string[]
  env?: NodeJS.ProcessEnv
}

interface ProcessHost {
  commandExecution(command: string, args: string[]): { command: string; args: string[]; windowsVerbatimArguments?: boolean }
  timeoutMs?: number
}

/** Every discovery process has one total deadline and owns its entire process tree. */
class DiscoveryProcess {
  readonly child: ChildProcess
  private timer: ReturnType<typeof setTimeout>
  private stopped = false
  private failure?: Error
  private failures = new Set<(error: Error) => void>()
  private bytes = 0
  stderr = ''
  constructor(command: ModelCommand, cwd: string, env: NodeJS.ProcessEnv, host: ProcessHost) {
    const execution = host.commandExecution(command.command, command.args || [])
    this.child = spawn(execution.command, execution.args, {
      cwd, env: { ...env, ...command.env, ELECTRON_RUN_AS_NODE: '1' },
      detached: process.platform !== 'win32', windowsHide: true,
      ...(execution.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.timer = setTimeout(() => this.fail(new ModelDiscoveryError('timeout')), host.timeoutMs ?? 20_000)
    this.child.on('error', error => this.fail(discoveryError(error)))
    this.child.stdin?.on('error', error => this.fail(discoveryError(error)))
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.count(chunk)
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-16_384)
    })
    this.child.stdout?.on('data', (chunk: Buffer) => this.count(chunk))
  }
  private count(chunk: Buffer) {
    this.bytes += chunk.length
    if (this.bytes > MAX_OUTPUT_BYTES) this.fail(new ModelDiscoveryError('error'))
  }
  onFailure(callback: (error: Error) => void) {
    if (this.failure) callback(this.failure)
    else this.failures.add(callback)
  }
  fail(error: Error) {
    if (this.failure || this.stopped) return
    this.failure = error
    for (const callback of this.failures) callback(error)
    this.stop()
  }
  stop() {
    if (this.stopped) return
    this.stopped = true
    clearTimeout(this.timer)
    // A Unix process group can outlive its parent CLI; still terminate those descendants.
    if (this.child.pid && (process.platform !== 'win32' || (this.child.exitCode === null && this.child.signalCode === null))) {
      killOwnedProcessTree(this.child.pid, () => {
        try { if (this.child.pid) process.kill(-this.child.pid, 'SIGKILL') }
        catch { this.child.kill('SIGKILL') }
      })
    }
  }
  run(): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const decoder = new StringDecoder('utf8')
      let stdout = ''
      this.onFailure(reject)
      this.child.stdout?.on('data', chunk => { if (!this.failure) stdout += decoder.write(chunk) })
      this.child.once('close', code => {
        if (this.failure) return
        stdout += decoder.end()
        if (code === 0) resolve({ stdout, stderr: this.stderr })
        else reject(discoveryError(`${stdout}\n${this.stderr}`))
        this.stop()
      })
      this.child.stdin?.end()
    })
  }
}

class RpcDiscovery implements DiscoveryRpc {
  private sequence = 0
  private pending = new Map<string | number, { resolve(value: any): void; reject(error: Error): void }>()
  private buffer = Buffer.alloc(0)
  private failure?: Error
  constructor(private process: DiscoveryProcess, private framing: 'jsonl' | 'content-length') {
    process.onFailure(error => this.reject(error))
    process.child.once('close', () => this.reject(discoveryError(process.stderr)))
    process.child.stdout?.on('data', (chunk: Buffer) => {
      if (this.failure) return
      try { this.consume(chunk) } catch (error) { process.fail(discoveryError(error)) }
    })
  }
  private reject(error: Error) {
    this.failure = error
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
  }
  private consume(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length) {
      let body: Buffer
      if (this.framing === 'content-length') {
        const separator = this.buffer.indexOf('\r\n\r\n')
        if (separator < 0) return
        const match = /^Content-Length:\s*(\d+)\s*$/im.exec(this.buffer.subarray(0, separator).toString('ascii'))
        const length = match ? Number(match[1]) : NaN
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_OUTPUT_BYTES) throw new ModelDiscoveryError('error')
        if (this.buffer.length < separator + 4 + length) return
        body = this.buffer.subarray(separator + 4, separator + 4 + length)
        this.buffer = this.buffer.subarray(separator + 4 + length)
      } else {
        const end = this.buffer.indexOf(10)
        if (end < 0) return
        body = this.buffer.subarray(0, end)
        this.buffer = this.buffer.subarray(end + 1)
        if (!body.toString('utf8').trim().startsWith('{')) continue
      }
      this.receive(JSON.parse(body.toString('utf8')))
    }
  }
  private write(message: object) {
    const body = Buffer.from(JSON.stringify(message))
    if (!this.process.child.stdin?.writable) throw new ModelDiscoveryError('error')
    this.process.child.stdin.write(this.framing === 'jsonl'
      ? Buffer.concat([body, Buffer.from('\n')])
      : Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]))
  }
  private receive(message: any) {
    if (message?.method) {
      // Discovery never grants tool, filesystem, or permission requests.
      if (message.id !== undefined) this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Model discovery does not support client actions' } })
      return
    }
    const control = message?.type === 'control_response' ? message.response : undefined
    const id = control?.request_id ?? message?.id
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    if (message.error || control?.subtype === 'error') {
      if (message.error?.code === -32601) entry.reject(new ModelDiscoveryError('unsupported'))
      else entry.reject(discoveryError(message.error?.message || control?.error))
    } else entry.resolve(control ? control.response : message.result)
  }
  private send(id: string | number, message: object): Promise<any> {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try { this.write(message) } catch (error) { this.pending.delete(id); reject(error) }
    })
  }
  request(method: string, params: unknown = {}) {
    const id = ++this.sequence
    return this.send(id, { jsonrpc: '2.0', id, method, params })
  }
  notify(method: string, params: unknown = {}) { this.write({ jsonrpc: '2.0', method, params }) }
  controlInitialize() {
    const id = `models-${++this.sequence}`
    return this.send(id, { type: 'control_request', request_id: id, request: { subtype: 'initialize', agents: {} } })
  }
}

export function createModelDiscoveryContext(input: {
  command: ModelCommand
  cwd: string
  home: string
  env: NodeJS.ProcessEnv
  host: ProcessHost
}): ModelDiscoveryContext {
  const start = (args: string[]) => new DiscoveryProcess({ ...input.command, args: [...(input.command.args || []), ...args] }, input.cwd, input.env, input.host)
  return {
    home: input.home, cwd: input.cwd, env: { ...input.env, ...input.command.env },
    async run(args) {
      const process = start(args)
      try { return await process.run() } finally { process.stop() }
    },
    async rpc(args, callback, framing = 'jsonl') {
      const process = start(args)
      try { return await callback(new RpcDiscovery(process, framing)) } finally { process.stop() }
    },
  }
}
