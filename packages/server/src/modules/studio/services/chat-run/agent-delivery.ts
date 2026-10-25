import { StudioError, type ExecutionScope } from '../../contracts/plugins'
import type { AgentChats } from '../agents/chats'
import { agentChatDisplayContent } from '../../repositories/agent-chat-content'

const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
export type AgentChatActivity = ReturnType<AgentChats['activity']>

/** Delivery adapter over committed canonical Runs. It owns neither execution
 * nor message writes. One session lane preserves terminal/start ordering even
 * when the coordinator has already dispatched the next queued Run. */
export class AgentChatDelivery {
  private closed = false
  private readonly lanes = new Map<string, Promise<void>>()
  private readonly followed = new Set<string>()
  private readonly completed = new Set<string>()
  constructor(private readonly deps: {
    chats: AgentChats
    emit(sessionId: string, event: string, payload: Record<string, unknown>): void
    activity(sessionId: string, runs: AgentChatActivity, currentRunId?: string): void
    onError(runId: string): void
  }) {}

  follow(scope: ExecutionScope, sessionId: string, runId: string, queueId: string): boolean {
    if (this.closed) throw new StudioError('RUNTIME_UNAVAILABLE', 'Agent chat delivery is closed')
    this.deps.chats.get(scope, sessionId, runId)
    if (this.completed.has(runId)) return false
    if (this.followed.has(runId)) return true
    this.followed.add(runId)
    this.publishQueue(scope, sessionId)
    const previous = this.lanes.get(sessionId) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(() => this.deliver(scope, sessionId, runId, queueId)).then(() => {
      if (this.closed) return
      this.completed.add(runId)
      if (this.completed.size > 2048) this.completed.delete(this.completed.values().next().value!)
    }).catch(() => {
      // Never include native diagnostics, prompt text, or authentication details.
      this.deps.onError(runId)
    }).finally(() => {
      this.followed.delete(runId)
      if (this.lanes.get(sessionId) === task) this.lanes.delete(sessionId)
    })
    this.lanes.set(sessionId, task)
    return true
  }

  publishQueue(scope: ExecutionScope, sessionId: string): void {
    this.deps.emit(sessionId, 'run.queued', this.queue(scope, sessionId))
  }
  private queue(scope: ExecutionScope, sessionId: string): Record<string, unknown> {
    const runs = this.deps.chats.activity(scope, sessionId)
    const queued = runs.filter(({ run }) => ['accepted', 'queued'].includes(run.status))
    return { event: 'run.queued', session_id: sessionId,
      queue_length: queued.length, queued_messages: queued.map(({ queueId, input }) => ({
        id: queueId, role: 'user', content: agentChatDisplayContent(sessionId, input),
        timestamp: Math.floor(Date.now() / 1000), queued: true,
      })) }
  }

  /** A completed idempotent retry is private to its observer. It must not
   * publish another start/terminal pair into an unrelated live Run. */
  async replay(scope: ExecutionScope, sessionId: string, runId: string, queueId: string,
    emit: (event: string, payload: Record<string, unknown>) => void): Promise<void> {
    if (this.closed) throw new StudioError('RUNTIME_UNAVAILABLE', 'Agent chat delivery is closed')
    if (!terminal.has(this.deps.chats.get(scope, sessionId, runId).status)) throw new StudioError('REVISION_CONFLICT', 'Only terminal Runs may be replayed')
    emit('run.queued', { ...this.queue(scope, sessionId), replayed: true })
    await this.deliver(scope, sessionId, runId, queueId, emit)
  }

  async idle(sessionId: string): Promise<void> { await this.lanes.get(sessionId) }
  close(): void { this.closed = true }

  private async deliver(scope: ExecutionScope, sessionId: string, runId: string, queueId: string,
    replay?: (event: string, payload: Record<string, unknown>) => void): Promise<void> {
    let cursor = -1, started = !!replay, inputDelivered = false
    const interactions = new Map<string, string>()
    const emit = (event: string, data: Record<string, unknown> = {}) => (replay ?? ((event, payload) => this.deps.emit(sessionId, event, payload)))(event, {
      ...data, event, session_id: sessionId, run_id: runId, agent_run_id: runId, run_marker: runId, queue_id: queueId,
      ...(replay ? { replayed: true, terminal: true } : {}),
    })
    while (!this.closed) {
      const run = this.deps.chats.get(scope, sessionId, runId)
      const queued = ['accepted', 'queued'].includes(run.status)
      if (!queued && !started && !(terminal.has(run.status) && !this.deps.chats.rows(scope, sessionId, runId, [], true).length)) {
        started = true
        this.deps.activity(sessionId, this.deps.chats.activity(scope, sessionId), runId)
        emit('run.started', { started_at: run.createdAt })
      }
      const events = this.deps.chats.output(scope, sessionId, runId, cursor)
      const rows = this.deps.chats.rows(scope, sessionId, runId, events, !inputDelivered && !queued)
      if (!queued && rows.some(row => row.role === 'user' || row.role === 'command')) inputDelivered = true
      if (rows.length) emit('message.persisted', { messages: rows, producer_sequence: events.at(-1)?.producerSequence ?? cursor })
      if (events.length) cursor = events.at(-1)!.producerSequence
      for (const interaction of replay ? [] : this.deps.chats.interactions(scope, sessionId, runId)) {
        if (interactions.get(interaction.id) === interaction.status) continue
        interactions.set(interaction.id, interaction.status)
        // Generic choices retain their native ids. Rendering and responding use
        // this bounded DTO, never legacy provider approval stores.
        emit('agent.interaction.updated', { interaction })
      }
      if (terminal.has(run.status) && events.length < 100) {
        await this.deps.chats.wait(runId)
        const final = this.deps.chats.get(scope, sessionId, runId)
        const settledRows = this.deps.chats.rows(scope, sessionId, runId, [], !inputDelivered, true)
        if (settledRows.length) emit('message.persisted', { messages: settledRows, producer_sequence: cursor })
        const remaining = this.deps.chats.activity(scope, sessionId)
        const usage = this.deps.chats.summary(scope, sessionId).agent_usage
        if (!replay) this.deps.activity(sessionId, remaining)
        emit(final.status === 'completed' ? 'run.completed' : final.status === 'cancelled' ? 'abort.completed' : 'run.failed', {
          status: final.status, error_code: final.errorCode, ...(final.status === 'failed' || final.status === 'interrupted' ? { error: final.errorCode || 'RUNTIME_UNAVAILABLE' } : {}),
          queue_remaining: remaining.length, queue_length: remaining.length,
          agent_usage: usage, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens,
        })
        return
      }
      if (events.length < 100) await new Promise<void>(resolve => setTimeout(resolve, 50))
    }
  }
}
