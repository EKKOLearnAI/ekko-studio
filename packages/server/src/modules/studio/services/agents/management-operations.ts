import { createHash } from 'node:crypto'
import { StudioError, type AgentManagementOperation, type AgentManagementOutput, type ExecutionScope, type ProcessExit, type ProcessHandle } from '../../contracts/plugins'
import { AgentManagementStore, type ManagementOperationRecord } from '../../repositories/agent-management-store'
import { parseTerminalSize } from '../processes/pty'

const LIFETIME_MS = 600_000, RETAIN_MS = 300_000, OUTPUT_BYTES = 262_144
interface OutputChunk { sequence: number; bytes: Buffer }
interface ActiveOperation {
  record: ManagementOperationRecord; controller: AbortController; completed: Promise<void>; resolve(): void
  chunks: OutputChunk[]; bytes: number; sequence: number; truncated: boolean; finishedAt?: number
  terminal?: ProcessHandle; authorize(): void; input?: { sequence: number; digest: string; task: Promise<void> }; inputPending: boolean
}
export interface ManagementControl {
  signal: AbortSignal; completed: Promise<void>; abort(error: StudioError): void
  consume(process: ProcessHandle): Promise<ProcessExit>
}

/** Operation receipts survive restarts; terminal data is a short-lived, bounded memory buffer. */
export class AgentManagementOperations {
  private readonly operations = new Map<string, ActiveOperation>()
  private closed = false
  constructor(private readonly store: AgentManagementStore, private readonly authorizeScope: (scope: ExecutionScope) => void) {}

  previous(scope: ExecutionScope, instanceId: string, revision: number, key: string, action: 'login' | 'install' = 'login'): AgentManagementOperation | null {
    this.checkScope(scope)
    if (!Number.isSafeInteger(revision) || revision < 1 || typeof key !== 'string' || !key.trim() || key.length > 128) throw new StudioError('INVALID_ARGUMENT', 'Revision and request key are required')
    const record = this.store.find(scope.principal.id, scope.profileId, key, instanceId, revision, action)
    return record ? this.project(record) : null
  }

  start(input: Parameters<AgentManagementStore['create']>[0], authorize: () => void, run: (control: ManagementControl) => Promise<ProcessExit>, settled: () => void): AgentManagementOperation {
    if (this.closed) throw new StudioError('RUNTIME_UNAVAILABLE', 'Management is shutting down')
    this.prune()
    const active = [...this.operations.values()].filter(operation => operation.finishedAt === undefined)
    if (active.length >= 16 || active.filter(operation => operation.record.ownerId === input.ownerId).length >= 4) throw new StudioError('RESOURCE_EXHAUSTED', 'Login terminal limit reached')
    const record = this.store.create(input, LIFETIME_MS), controller = new AbortController()
    let resolve!: () => void
    const completed = new Promise<void>(done => { resolve = done })
    const operation: ActiveOperation = { record, controller, completed, resolve, authorize, chunks: [], bytes: 0, sequence: 0, truncated: false, inputPending: false }
    this.operations.set(record.id, operation)
    const timer = setTimeout(() => controller.abort(new StudioError('DEADLINE_EXCEEDED', 'Login terminal expired')), LIFETIME_MS)
    void Promise.resolve().then(async () => {
      let exit: ProcessExit | null = null, error: unknown
      try {
        this.check(operation)
        exit = await run({ signal: controller.signal, completed,
          abort: reason => controller.abort(reason), consume: process => this.consume(operation, process) })
        this.check(operation)
      } catch (failure) { error = failure }
      finally {
        clearTimeout(timer)
        settled()
        // Failed cleanup cannot certify cancellation, even if a stop was requested.
        const reason = error instanceof StudioError && error.code === 'RUNTIME_UNAVAILABLE' ? error : controller.signal.aborted ? controller.signal.reason : error
        const code = reason instanceof StudioError ? reason.code : reason ? 'RUNTIME_UNAVAILABLE' : null
        const status = code === 'CANCELLED' ? 'cancelled'
          : controller.signal.aborted ? 'interrupted' : error || exit?.code !== 0 ? 'failed' : 'completed'
        this.store.finish(record.id, status, exit, code, operation.sequence)
        operation.terminal = undefined
        operation.finishedAt = Date.now()
        operation.resolve()
      }
    })
    return this.project(record)
  }

  private async consume(operation: ActiveOperation, process: ProcessHandle): Promise<ProcessExit> {
    this.check(operation)
    operation.terminal = process
    this.store.running(operation.record.id)
    while (true) {
      this.check(operation)
      const batch = await process.read()
      this.check(operation)
      operation.truncated ||= batch.truncated
      for (const chunk of batch.chunks) {
        const bytes = Buffer.from(chunk.data)
        operation.chunks.push({ sequence: ++operation.sequence, bytes }); operation.bytes += bytes.length
        while (operation.bytes > OUTPUT_BYTES && operation.chunks.length) operation.bytes -= operation.chunks.shift()!.bytes.length
      }
      if (batch.exit && !batch.chunks.length) return batch.exit
    }
  }

  list(scope: ExecutionScope, instanceId: string): AgentManagementOperation[] {
    this.checkScope(scope)
    return this.store.list(scope.principal.id, scope.profileId, instanceId).map(record => this.project(record))
  }
  get(scope: ExecutionScope, id: string): AgentManagementOperation { return this.project(this.owned(scope, id)) }
  async wait(scope: ExecutionScope, id: string): Promise<void> {
    this.owned(scope, id)
    await this.operations.get(id)?.completed
    this.owned(scope, id)
  }
  output(scope: ExecutionScope, id: string, after: number): AgentManagementOutput {
    const record = this.owned(scope, id)
    if (!Number.isSafeInteger(after) || after < 0) throw new StudioError('INVALID_ARGUMENT', 'Invalid terminal cursor')
    this.prune()
    const operation = this.operations.get(id), sequence = operation?.sequence ?? record.outputSequence
    if (after > sequence) throw new StudioError('INVALID_ARGUMENT', 'Terminal cursor is ahead of output')
    const chunks = operation?.chunks.filter(chunk => chunk.sequence > after).slice(0, 4) || []
    return { chunks: chunks.map(chunk => ({ sequence: chunk.sequence, data: chunk.bytes.toString('base64') })),
      lastSequence: chunks.at(-1)?.sequence ?? Math.max(after, sequence),
      nextInputSequence: (operation?.input?.sequence || 0) + 1,
      truncated: !!operation?.truncated || (!operation && record.status === 'interrupted') || (after < sequence && (!chunks.length || chunks[0].sequence > after + 1)),
      finished: !['starting', 'running'].includes(record.status) && (!chunks.length || chunks.at(-1)!.sequence === sequence) }
  }
  async input(scope: ExecutionScope, id: string, sequence: number, text: string): Promise<void> {
    if (this.owned(scope, id).action !== 'login') throw new StudioError('CAPABILITY_UNSUPPORTED', 'Installation output is read-only')
    if (!Number.isSafeInteger(sequence) || sequence < 1 || typeof text !== 'string' || !text || Buffer.byteLength(text) > 65_536) throw new StudioError('INVALID_ARGUMENT', 'Invalid terminal input')
    const digest = createHash('sha256').update(text).digest('hex'), previous = this.operations.get(id)?.input
    if (sequence === previous?.sequence && digest === previous.digest) { await previous.task; return }
    const operation = this.live(scope, id)
    if (sequence !== (previous?.sequence || 0) + 1) throw new StudioError('REVISION_CONFLICT', 'Terminal input sequence changed')
    if (operation.inputPending) throw new StudioError('RESOURCE_EXHAUSTED', 'Previous terminal input is pending')
    const terminal = operation.terminal
    if (!terminal) throw new StudioError('REVISION_CONFLICT', 'Terminal is still starting')
    operation.inputPending = true
    const task = Promise.resolve().then(async () => {
      this.check(operation)
      await terminal.write(Buffer.from(text))
      this.check(operation)
    }).finally(() => { operation.inputPending = false })
    operation.input = { sequence, digest, task }
    await task
  }
  async resize(scope: ExecutionScope, id: string, size: unknown): Promise<void> {
    if (this.owned(scope, id).action !== 'login') throw new StudioError('CAPABILITY_UNSUPPORTED', 'Installation output is read-only')
    const operation = this.live(scope, id), dimensions = parseTerminalSize(size)
    if (!operation.terminal?.resize) throw new StudioError('REVISION_CONFLICT', 'Terminal is still starting')
    await operation.terminal.resize(dimensions.cols, dimensions.rows)
    this.check(operation)
  }
  async cancel(scope: ExecutionScope, id: string): Promise<AgentManagementOperation> {
    this.owned(scope, id)
    const operation = this.operations.get(id)
    if (operation && operation.finishedAt === undefined) {
      operation.controller.abort(new StudioError('CANCELLED', 'Login terminal cancelled'))
      await operation.completed
    }
    return this.get(scope, id)
  }
  async close(): Promise<void> {
    this.closed = true
    for (const operation of this.operations.values()) if (operation.finishedAt === undefined) operation.controller.abort(new StudioError('RUNTIME_UNAVAILABLE', 'Host shutdown'))
    await Promise.allSettled([...this.operations.values()].map(operation => operation.completed))
    this.operations.clear()
  }
  private checkScope(scope: ExecutionScope) {
    this.authorizeScope(scope)
    if (scope.principal.kind !== 'user' || scope.sessionId !== undefined || scope.runId !== undefined || scope.workspaceId !== undefined) throw new StudioError('FORBIDDEN', 'Login requires an interactive user scope')
  }
  private owned(scope: ExecutionScope, id: string) {
    this.checkScope(scope)
    const record = this.store.get(id)
    if (!record || record.ownerId !== scope.principal.id || record.profileId !== scope.profileId) throw new StudioError('NOT_FOUND', 'Management operation is unavailable')
    return record
  }
  private live(scope: ExecutionScope, id: string) {
    const record = this.owned(scope, id), operation = this.operations.get(id)
    if (!operation || !['starting', 'running'].includes(record.status)) throw new StudioError('REVISION_CONFLICT', 'Login terminal has ended')
    this.check(operation)
    return operation
  }
  private check(operation: ActiveOperation) { if (operation.controller.signal.aborted) throw operation.controller.signal.reason; operation.authorize() }
  private project({ ownerId: _owner, profileId: _profile, idempotencyKey: _key, outputSequence: _sequence, ...record }: ManagementOperationRecord): AgentManagementOperation { return { ...record } }
  private prune() {
    for (const [id, operation] of this.operations) if (operation.finishedAt !== undefined && Date.now() - operation.finishedAt > RETAIN_MS) this.operations.delete(id)
    const finished = [...this.operations].filter(([, operation]) => operation.finishedAt !== undefined)
    for (const [id] of finished.slice(0, Math.max(0, this.operations.size - 128))) this.operations.delete(id)
  }
}
