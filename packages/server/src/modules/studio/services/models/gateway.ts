import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { StudioError, type ExecutionScope, type ModelGatewayHandle, type ModelGatewayInput, type ModelCallRecord } from '../../contracts/plugins'
import type { PluginModelCallStore } from '../../repositories/plugin-model-call-store'
import type { AgentRunStateStore } from '../../repositories/agent-run-state-store'
import type { resolveNativeModel } from './hosted-provider'
import { NativeModelWire, nativeModelFrames } from './native-wire'

export interface ModelGatewayPorts {
  store: PluginModelCallStore
  state: AgentRunStateStore
  authorize(scope: ExecutionScope): void
  authorizeStart?(scope: ExecutionScope): void
  resolve: typeof resolveNativeModel
}
interface Lease {
  key: string; token: string; scope: ExecutionScope; input: ModelGatewayInput
  transport: 'native' | 'translated'
  authorize(): void; controller: AbortController
  active: Set<Promise<void>>; failure?: unknown; closing?: Promise<void>; release(): void
}

/** Loopback capabilities are minted per Run. No public route, upstream credential or caller-supplied identity. */
export class PluginModelGateways {
  private readonly leases = new Map<string, Lease>()
  private readonly opening = new Map<Promise<unknown>, { runId: string; controller: AbortController }>()
  private readonly server = createServer((request, response) => { void this.dispatch(request, response) })
  private listening?: Promise<number>
  private closed = false
  constructor(private readonly ports: ModelGatewayPorts) {
    this.server.requestTimeout = 15_000
    this.server.headersTimeout = 10_000
    this.server.maxConnections = 128
  }

  async open(caller: ExecutionScope, value: ModelGatewayInput, signal: AbortSignal): Promise<ModelGatewayHandle> {
    const scope: ExecutionScope = JSON.parse(JSON.stringify(caller))
    const input: ModelGatewayInput = JSON.parse(JSON.stringify(value))
    if (!scope.runId) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Native model gateways require an active Run')
    if (!input || Array.isArray(input) || Object.keys(input).some(key => !['model', 'protocol'].includes(key))
      || typeof input.model !== 'string' || !input.model.trim() || input.model.length > 256 || !['responses', 'anthropic'].includes(input.protocol)) {
      throw new StudioError('INVALID_ARGUMENT', 'Invalid native model gateway input')
    }
    if (this.leases.size + this.opening.size >= 64) throw new StudioError('RESOURCE_EXHAUSTED', 'Native model gateway limit exceeded')
    const controller = new AbortController()
    const authorize = () => {
      if (this.closed || signal.aborted || controller.signal.aborted) throw new StudioError('CANCELLED', 'Native model gateway ended')
      this.ports.authorize(scope); this.ports.authorizeStart?.(scope)
    }
    authorize()
    const operation = (async () => {
      const native = await this.ports.resolve(scope.profileId, input.model, input.protocol, authorize)
      authorize()
      const port = await this.listen()
      authorize()
      const key = randomBytes(24).toString('hex'), token = randomBytes(32).toString('hex')
      const stop = () => { void this.stop(lease).catch(() => {}) }
      const watch = setInterval(() => { try { authorize() } catch { stop() } }, 250)
      const expiry = setTimeout(stop, 600_000)
      const transport = native.transport ?? 'native'
      const lease: Lease = { key, token, scope, input, transport, controller, authorize, active: new Set(),
        release: () => { clearInterval(watch); clearTimeout(expiry); signal.removeEventListener('abort', stop) } }
      this.leases.set(key, lease)
      signal.addEventListener('abort', stop, { once: true })
      return Object.freeze({ baseUrl: `http://127.0.0.1:${port}/${key}/v1`, token, ...input, transport, images: native.images === true, dispose: () => this.stop(lease) })
    })()
    this.opening.set(operation, { runId: scope.runId, controller })
    // Release the plugin RPC promptly on cancellation, while retaining the
    // underlying resolution in the host's bounded cleanup barrier.
    void operation.finally(() => this.opening.delete(operation)).catch(() => {})
    const ended = AbortSignal.any([signal, controller.signal])
    let abort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new StudioError('CANCELLED', 'Native gateway admission ended'))
      ended.addEventListener('abort', abort, { once: true })
      if (ended.aborted) abort()
    })
    try { return await Promise.race([operation, cancelled]) }
    finally { ended.removeEventListener('abort', abort) }
  }

  private listen(): Promise<number> {
    return this.listening ??= new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', reject)
        const address = this.server.address()
        if (!address || typeof address === 'string') reject(new StudioError('RUNTIME_UNAVAILABLE', 'Native gateway is unavailable'))
        else resolve(address.port)
      })
    })
  }
  private async dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = /^\/([a-f0-9]{48})\/v1\/(responses|messages)$/.exec(request.url || '')
    const lease = path && this.leases.get(path[1])
    const token = String(request.headers.authorization || '').replace(/^Bearer /i, '') || String(request.headers['x-api-key'] || '')
    if (!lease || Buffer.byteLength(token) !== Buffer.byteLength(lease.token) || !timingSafeEqual(Buffer.from(token), Buffer.from(lease.token))) {
      response.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end('{"error":{"message":"Native gateway unavailable"}}'); return
    }
    if (request.method !== 'POST' || path![2] !== (lease.input.protocol === 'responses' ? 'responses' : 'messages')) {
      response.writeHead(404); response.end(); return
    }
    if (lease.active.size >= 4 || [...this.leases.values()].reduce((sum, entry) => sum + entry.active.size, 0) >= 64) {
      response.writeHead(429); response.end(); return
    }
    const task = this.request(lease, request, response)
    lease.active.add(task)
    try { await task } finally { lease.active.delete(task) }
  }

  private async request(lease: Lease, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, lease.controller.signal])
    const check = () => {
      lease.authorize()
      if (signal.aborted) throw new StudioError('CANCELLED', 'Native request ended')
    }
    const abort = () => controller.abort()
    const abortSocket = () => { request.destroy(); response.destroy() }
    response.once('close', abort)
    signal.addEventListener('abort', abortSocket, { once: true })
    const timeout = setTimeout(abort, 120_000)
    let target: Awaited<ReturnType<typeof resolveNativeModel>> | undefined
    let record: ModelCallRecord | undefined, terminal: string | undefined, streaming = false, failure: unknown
    const wire = new NativeModelWire(lease.input.protocol), startedAt = performance.now()
    try {
      check()
      let bytes = 0
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        bytes += chunk.length
        if (bytes > 16 * 1024 * 1024) throw new StudioError('RESOURCE_EXHAUSTED', 'Native model input limit exceeded')
        chunks.push(chunk)
      }
      const raw = Buffer.concat(chunks).toString('utf8'), body = JSON.parse(raw)
      if (!body || typeof body !== 'object' || Array.isArray(body) || (body.stream !== undefined && typeof body.stream !== 'boolean')
        || body.background || body.prompt || body.previous_response_id || body.conversation || body.store === true) throw new StudioError('INVALID_ARGUMENT', 'Native requests require foreground execution and full history')
      streaming = body.stream === true
      check()
      target = await this.ports.resolve(lease.scope.profileId, lease.input.model, lease.input.protocol, check)
      check()
      if ((target.transport ?? 'native') !== lease.transport) throw new StudioError('REVISION_CONFLICT', 'Model transport changed during the Run')
      record = this.ports.store.accept(lease.scope, { idempotencyKey: randomUUID(), model: lease.input.model, input: raw }, call => this.ports.state.claimHostModelCall(call))
      const upstream = await target.request(body, signal, lease.scope.sessionId || lease.scope.runId!)
      try { check() } catch (error) { await upstream.body?.cancel(); throw error }
      response.setHeader('cache-control', 'no-store')
      response.setHeader('content-type', streaming ? 'text/event-stream; charset=utf-8' : 'application/json')
      for await (const frame of nativeModelFrames(upstream, streaming, wire)) {
        check()
        if (frame.terminal) terminal = frame.data
        else if (!response.write(frame.data)) await new Promise<void>((resolve, reject) => {
          const failed = () => { cleanup(); reject(new StudioError('CANCELLED', 'Native client disconnected')) }
          const ready = () => { cleanup(); resolve() }
          const cleanup = () => { response.removeListener('close', failed); response.removeListener('drain', ready) }
          response.once('drain', ready); response.once('close', failed)
          if (response.destroyed) failed()
        })
      }
      check()
    } catch (error) { failure = error }
    finally {
      try {
        if (record) {
          let accountingFailure: unknown
          target!.record({ sessionId: lease.scope.sessionId || '', runId: record.id, parentRunId: lease.scope.runId,
            accountId: lease.scope.principal.id, origin: 'internal', source: 'model_api', agent: 'model_api', usageScope: 'model_call', apiCalls: 1,
            apiDuration: (performance.now() - startedAt) / 1000, requirePersistence: true, usage: wire.usage, isEstimated: !wire.usage || wire.usage.isEstimated,
            onRecorded: value => {
              try {
                const { isEstimated, ...usage } = value
                this.ports.store.update(record!.id, { usage: !wire.usage || wire.usage.isEstimated || isEstimated ? null : usage }, call => this.ports.state.recordHostModelUsage(call))
              } catch (error) { accountingFailure = error }
            },
          })
          if (accountingFailure) throw accountingFailure
          this.ports.store.update(record.id, { status: signal.aborted ? 'cancelled' : failure ? 'failed' : wire.status || 'failed',
            errorCode: signal.aborted ? 'CANCELLED' : failure || !wire.status ? failure instanceof StudioError ? failure.code : 'RUNTIME_UNAVAILABLE' : null }, call => this.ports.state.recordHostModelUsage(call))
        }
      } catch (error) { failure = error; lease.failure = error; lease.controller.abort(); lease.release() }
      clearTimeout(timeout); response.removeListener('close', abort); signal.removeEventListener('abort', abortSocket)
    }
    if (response.destroyed) return
    if (failure || !terminal || signal.aborted) {
      if (response.headersSent) response.destroy()
      else {
        response.writeHead(failure instanceof StudioError && failure.code === 'INVALID_ARGUMENT' ? 400 : 502, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end('{"error":{"message":"Native model request failed"}}')
      }
    } else { response.end(terminal) }
  }

  private stop(lease: Lease): Promise<void> {
    if (lease.closing) return lease.closing
    lease.controller.abort(); lease.release()
    lease.closing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([Promise.all([...lease.active]), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new StudioError('DEADLINE_EXCEEDED', 'Native model cleanup did not settle')), 5_000)
        })])
        if (lease.failure) throw new StudioError('RUNTIME_UNAVAILABLE', 'Native model accounting did not settle')
        this.leases.delete(lease.key)
      } finally { clearTimeout(timer) }
    })()
    return lease.closing
  }
  private async settleOpening(runId?: string): Promise<void> {
    const pending = [...this.opening].filter(([, entry]) => runId === undefined || entry.runId === runId)
    for (const [, entry] of pending) entry.controller.abort()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([Promise.allSettled(pending.map(([operation]) => operation)), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StudioError('DEADLINE_EXCEEDED', 'Native gateway admission did not settle')), 5_000)
      })])
    } finally { clearTimeout(timer) }
  }
  async settleRun(runId: string): Promise<void> {
    const results = await Promise.allSettled([this.settleOpening(runId), ...[...this.leases.values()].filter(lease => lease.scope.runId === runId).map(lease => this.stop(lease))])
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
  async close(): Promise<void> {
    this.closed = true
    const results = await Promise.allSettled([this.settleOpening(), ...[...this.leases.values()].map(lease => this.stop(lease))])
    if (this.listening) {
      await this.listening.catch(() => {})
      this.server.closeAllConnections()
      await new Promise<void>(resolve => this.server.close(() => resolve()))
    }
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
}
