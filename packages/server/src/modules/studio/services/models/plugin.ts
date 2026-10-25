import { StudioError, type ExecutionScope, type JsonObject, type ModelCallRecord, type ModelStreamEvent, type ModelStreamHandle, type ModelStreamInput, type ModelSummary } from '../../contracts/plugins'
import { PluginModelCallStore } from '../../repositories/plugin-model-call-store'
import type { AgentRunStateStore } from '../../repositories/agent-run-state-store'
import type { prepareModelResponse, listApiModels } from '../model-api/service'
import { AsyncChannel } from '../plugins/channel'
import { jsonCopy } from '../plugins/validation'
import { modelResponseBody, parseModelStreamInput } from './plugin-input'
import { PluginModelGateways, type ModelGatewayPorts } from './gateway'
import { ModelApiError } from '../model-api/errors'

interface ActiveCall { runId?: string; cancel(): Promise<void>; done: Promise<void> }
interface ModelPorts {
  store: PluginModelCallStore
  state: AgentRunStateStore
  authorize(scope: ExecutionScope): void
  authorizeStart?(scope: ExecutionScope): void
  list: typeof listApiModels
  native?: ModelGatewayPorts['resolve']
  prepare: typeof prepareModelResponse
}

/** Credentials stay in the provider closure. Accepted keys and accounting identities survive restart. */
export class PluginModels {
  private readonly active = new Map<string, ActiveCall>()
  private closed = false
  private readonly gateways?: PluginModelGateways
  constructor(private readonly ports: ModelPorts) {
    if (ports.native) this.gateways = new PluginModelGateways({ ...ports, resolve: ports.native })
  }
  gateway(scope: ExecutionScope, input: import('../../contracts/plugins').ModelGatewayInput, signal: AbortSignal) {
    if (this.closed) throw new StudioError('CANCELLED', 'Model services closed')
    if (!this.gateways) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Native model gateways are unavailable')
    return this.gateways.open(scope, input, signal)
  }

  async list(scope: ExecutionScope): Promise<ModelSummary[]> {
    this.ports.authorize(scope)
    const result = await this.ports.list([scope.profileId])
    this.ports.authorize(scope)
    return result.data.map(model => ({ id: model.id, provider: model.owned_by, callable: model.responses_supported }))
  }
  get(scope: ExecutionScope, id: string): ModelCallRecord {
    this.ports.authorize(scope)
    if (typeof id !== 'string' || !id || id.length > 256) throw new StudioError('INVALID_ARGUMENT', 'Invalid model call id')
    const record = this.ports.store.get(id)
    if (!record || record.profileId !== scope.profileId || record.ownerId !== scope.principal.id
      || (scope.runId && scope.runId !== record.runId) || (scope.sessionId && scope.sessionId !== record.sessionId)) throw new StudioError('NOT_FOUND', 'Model call is unavailable')
    return record
  }
  async stream(scope: ExecutionScope, value: ModelStreamInput, signal: AbortSignal): Promise<ModelStreamHandle> {
    const input = parseModelStreamInput(value)
    const authorize = () => {
      if (this.closed || signal.aborted) throw new StudioError('CANCELLED', 'Model execution scope ended')
      this.ports.authorize(scope)
    }
    authorize()
    const old = this.ports.store.find(scope, input)
    if (old) {
      this.get(scope, old.id)
      if (old.status === 'running') throw new StudioError('REVISION_CONFLICT', 'Model call is already in progress; query its receipt', true)
      return Object.freeze({ id: old.id, cancel: async () => {}, events: {
        async *[Symbol.asyncIterator]() { authorize(); yield { sequence: 0, type: 'call.finished' as const, call: old } },
      } })
    }
    if (this.active.size >= 64) throw new StudioError('RESOURCE_EXHAUSTED', 'Too many active model calls')
    this.ports.authorizeStart?.(scope)
    const record = this.ports.store.accept(scope, input, call => this.ports.state.claimHostModelCall(call))
    const controller = new AbortController()
    let done!: Promise<void>, sequence = 0, bytes = 0, reading = false
    let reason: string | null = null
    const stop = (code: string) => { reason ||= code; controller.abort(); channel.finish() }
    const channel = new AsyncChannel<ModelStreamEvent>(32, () => stop('CANCELLED'))
    const scopeEnded = () => stop('CANCELLED')
    signal.addEventListener('abort', scopeEnded, { once: true })
    const timeout = setTimeout(() => stop('DEADLINE_EXCEEDED'), input.timeoutMs ?? 120_000)
    const check = () => {
      authorize()
      if (controller.signal.aborted) throw new StudioError('CANCELLED', 'Model call ended')
    }
    const watch = setInterval(() => { try { check() } catch (error) { stop(error instanceof StudioError ? error.code : 'FORBIDDEN') } }, 250)
    const publish = async (event: ModelStreamEvent) => {
      check()
      const snapshot = jsonCopy(event, 524_288)
      bytes += Buffer.byteLength(JSON.stringify(snapshot))
      if (bytes > 2_097_152 || sequence > 16_384) throw new StudioError('RESOURCE_EXHAUSTED', 'Model output limit exceeded')
      await channel.push(snapshot)
    }
    const cancel = async () => {
      stop('CANCELLED')
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([done, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new StudioError('DEADLINE_EXCEEDED', 'Model cancellation did not settle')), 5_000) })]) }
      finally { clearTimeout(timer) }
    }
    done = Promise.resolve().then(async () => {
      let output: JsonObject[] = [], status: ModelCallRecord['status'] = 'failed', errorCode: string | null = 'RUNTIME_UNAVAILABLE'
      try {
        check()
        const request = await this.ports.prepare({ profiles: [scope.profileId], accountId: scope.principal.id,
          body: modelResponseBody(input), signal: controller.signal,
          internal: { id: record.id, sessionId: scope.sessionId, parentRunId: scope.runId, authorize: check },
          onUsage: value => {
            const { isEstimated, ...measured } = value
            this.ports.store.update(record.id, { usage: isEstimated ? null : measured }, updated => this.ports.state.recordHostModelUsage(updated))
          },
        })
        check()
        for await (const event of request.events()) {
          check()
          if (event.type === 'response.output_text.delta' || event.type === 'response.reasoning_summary_text.delta') {
            await publish({ sequence: sequence++, type: event.type === 'response.output_text.delta' ? 'text.delta' : 'reasoning.delta', text: String(event.delta) })
          } else if (event.type === 'response.output_item.done') {
            const item = jsonCopy(event.item, 262_144) as JsonObject
            output = jsonCopy([...output, item], 393_216)
            await publish({ sequence: sequence++, type: 'output.item', item })
          } else if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) {
            output = jsonCopy(event.response.output, 393_216)
            status = event.type === 'response.completed' ? 'completed' : event.type === 'response.incomplete' ? 'incomplete' : 'failed'
            errorCode = status === 'failed' ? 'RUNTIME_UNAVAILABLE' : null
          }
        }
        // The provider iterator's finally block records usage before publishing a terminal receipt.
        check()
      } catch (error) {
        status = reason === 'CANCELLED' ? 'cancelled' : 'failed'
        errorCode = reason || (error instanceof StudioError ? error.code : error instanceof ModelApiError
          ? ({ 400: 'INVALID_ARGUMENT', 401: 'FORBIDDEN', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 429: 'RESOURCE_EXHAUSTED', 501: 'CAPABILITY_UNSUPPORTED' } as Record<number, string>)[error.status] || 'RUNTIME_UNAVAILABLE'
          : 'RUNTIME_UNAVAILABLE')
      } finally {
        try {
          const result = this.ports.store.update(record.id, { status, output, errorCode }, updated => this.ports.state.recordHostModelUsage(updated))
          try { authorize() } catch (error) { stop(error instanceof StudioError ? error.code : 'FORBIDDEN') }
          if (!controller.signal.aborted) {
            try { await channel.push(jsonCopy({ sequence: sequence++, type: 'call.finished' as const, call: result }, 524_288)) }
            catch (error) { if (!controller.signal.aborted) throw error }
          }
          channel.finish()
        } finally {
          clearTimeout(timeout); clearInterval(watch); signal.removeEventListener('abort', scopeEnded)
          this.active.delete(record.id)
        }
      }
    })
    void done.catch(error => channel.finish(error))
    this.active.set(record.id, { done, cancel, runId: scope.runId })
    return Object.freeze({ id: record.id, cancel, events: {
      [Symbol.asyncIterator]: () => {
        if (reading) throw new StudioError('REVISION_CONFLICT', 'Model stream already has a reader')
        reading = true
        const iterator = channel[Symbol.asyncIterator]()
        return {
          next: async () => {
            try { authorize(); const next = await iterator.next(); authorize(); if (next.done) await done; return next }
            catch (error) { await cancel(); throw error }
          },
          return: async () => { await cancel(); return { done: true as const, value: undefined } },
        }
      },
    } })
  }
  async settleRun(runId: string): Promise<void> {
    const results = await Promise.allSettled([this.gateways?.settleRun(runId), ...[...this.active.values()].filter(call => call.runId === runId).map(call => call.cancel())])
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
  async close(): Promise<void> {
    this.closed = true
    const results = await Promise.allSettled([this.gateways?.close(), ...[...this.active.values()].map(call => call.cancel())])
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
}
