import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { StudioError, type AgentInteraction, type AgentInteractionResponse, type AgentOutputEvent, type AgentUsage, type AgentProviderRef, type JsonValue, type ModelCallRecord } from '../contracts/plugins'

/** Projections share the output/terminal transaction owned by AgentExecutionStore. */
export class AgentRunStateStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS studio_host_model_calls (call_id TEXT PRIMARY KEY, run_id TEXT);
    CREATE TABLE IF NOT EXISTS studio_agent_usage (
      run_id TEXT NOT NULL, call_id TEXT NOT NULL, value_json TEXT NOT NULL, event_json TEXT NOT NULL,
      PRIMARY KEY(run_id, call_id)
    ); CREATE TABLE IF NOT EXISTS studio_agent_interactions (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, request_id TEXT NOT NULL, value_json TEXT NOT NULL,
      response_json TEXT, UNIQUE(run_id, request_id)
    ); CREATE TABLE IF NOT EXISTS studio_agent_checkpoints (
      instance_id TEXT PRIMARY KEY, provider_json TEXT NOT NULL, config_revision INTEGER NOT NULL,
      run_id TEXT NOT NULL, value_json TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS studio_agent_runtime_leases (
      id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, provider_json TEXT NOT NULL, config_revision INTEGER NOT NULL,
      status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS studio_agent_run_leases (
      run_id TEXT PRIMARY KEY, lease_id TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS studio_agent_state_revisions (
      instance_id TEXT NOT NULL, provider_key TEXT NOT NULL, config_revision INTEGER NOT NULL, state_revision INTEGER NOT NULL,
      PRIMARY KEY(instance_id, provider_key, config_revision)
    );`)
  }

  project(runId: string, event: AgentOutputEvent): void {
    if (event.type === 'usage.reported') {
      if (this.isHostModelCall(event.modelCallId)) return
      const previous = this.db.prepare('SELECT value_json, event_json FROM studio_agent_usage WHERE run_id=? AND call_id=?')
        .get(runId, event.modelCallId) as { value_json: string; event_json: string } | undefined
      const old = previous ? JSON.parse(previous.value_json) as AgentUsage : undefined
      // Producer sequence belongs to transport, not the model-call revision.
      const details = ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const
      const value = { modelCallId: event.modelCallId, model: event.model, mode: event.mode, revision: event.revision,
        inputTokens: event.inputTokens, outputTokens: event.outputTokens,
        ...Object.fromEntries(details.filter(key => event[key] !== undefined).map(key => [key, event[key]])) }
      if (old && old.model !== event.model) throw new StudioError('INVALID_ARGUMENT', 'Model call identity changed')
      if (old && event.revision < old.revision) return
      if (old && event.revision === old.revision) {
        if (JSON.stringify(value) !== previous!.event_json) throw new StudioError('REVISION_CONFLICT', 'Conflicting usage revision')
        return
      }
      if (old?.final && event.mode !== 'final') throw new StudioError('REVISION_CONFLICT', 'Final usage requires an explicit final correction')
      const inputTokens = event.inputTokens + (event.mode === 'delta' ? old?.inputTokens || 0 : 0)
      const outputTokens = event.outputTokens + (event.mode === 'delta' ? old?.outputTokens || 0 : 0)
      if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) throw new StudioError('INVALID_ARGUMENT', 'Usage exceeds numeric limits')
      const usage: AgentUsage = { modelCallId: event.modelCallId, model: event.model, revision: event.revision, inputTokens, outputTokens, final: event.mode === 'final' }
      for (const key of details) {
        // An omitted delta changes no known detail. An omitted snapshot is unknown.
        const detail = event.mode === 'delta'
          ? event[key] === undefined ? old?.[key] : event[key]! + (old?.[key] ?? 0)
          : event[key]
        if (detail !== undefined) {
          if (!Number.isSafeInteger(detail)) throw new StudioError('INVALID_ARGUMENT', 'Usage exceeds numeric limits')
          usage[key] = detail
        }
      }
      this.db.prepare('INSERT INTO studio_agent_usage VALUES (?, ?, ?, ?) ON CONFLICT(run_id, call_id) DO UPDATE SET value_json=excluded.value_json, event_json=excluded.event_json')
        .run(runId, event.modelCallId, JSON.stringify(usage), JSON.stringify(value))
    }
    if (event.type === 'interaction.requested') {
      if (new Set(event.choices.map(choice => choice.id)).size !== event.choices.length || (event.kind === 'approval' && !event.choices.length)) {
        throw new StudioError('INVALID_ARGUMENT', 'Interaction choices must have unique ids')
      }
      if ((event.kind === 'approval' && event.allowText === true) || (event.allowText === false && !event.choices.length)) {
        throw new StudioError('INVALID_ARGUMENT', 'Interaction has no supported response')
      }
      if (this.interactions(runId).some(item => item.requestId === event.requestId)) throw new StudioError('REVISION_CONFLICT', 'Interaction request already exists')
      const interaction: AgentInteraction = { id: randomUUID(), runId, requestId: event.requestId, kind: event.kind,
        prompt: event.prompt, choices: event.choices, ...(event.allowText === undefined ? {} : { allowText: event.allowText }),
        expiresAt: event.expiresAt ?? null, status: 'pending' }
      this.db.prepare('INSERT INTO studio_agent_interactions (id, run_id, request_id, value_json) VALUES (?, ?, ?, ?)')
        .run(interaction.id, runId, event.requestId, JSON.stringify(interaction))
    }
    if (event.type === 'interaction.withdrawn') {
      const interaction = this.interactions(runId).find(item => item.requestId === event.requestId)
      if (!interaction) throw new StudioError('INVALID_ARGUMENT', 'Unknown interaction request')
      this.setInteraction(interaction, 'withdrawn')
    }
  }

  isHostModelCall(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM studio_host_model_calls WHERE call_id=?').get(id)
  }
  claimHostModelCall(record: ModelCallRecord): void {
    if (this.db.prepare('SELECT 1 FROM studio_agent_usage WHERE call_id=?').get(record.id)) throw new StudioError('REVISION_CONFLICT', 'Model call identity is already reported')
    this.db.prepare('INSERT INTO studio_host_model_calls VALUES (?, ?)').run(record.id, record.runId)
    this.recordHostModelUsage(record)
  }
  recordHostModelUsage(record: ModelCallRecord): void {
    const claim = this.db.prepare('SELECT run_id FROM studio_host_model_calls WHERE call_id=?').get(record.id) as { run_id: string | null } | undefined
    if (!claim || claim.run_id !== record.runId) throw new StudioError('FORBIDDEN', 'Model call accounting binding changed')
    if (!record.runId) return
    const usage: AgentUsage = { ...record.usage, modelCallId: record.id, model: record.model, revision: record.revision,
      inputTokens: record.usage?.inputTokens ?? null, outputTokens: record.usage?.outputTokens ?? null,
      final: record.status !== 'running', source: 'host' }
    this.db.prepare('INSERT INTO studio_agent_usage VALUES (?, ?, ?, ?) ON CONFLICT(run_id, call_id) DO UPDATE SET value_json=excluded.value_json, event_json=excluded.event_json')
      .run(record.runId, record.id, JSON.stringify(usage), JSON.stringify(usage))
  }

  usage(runId: string): AgentUsage[] {
    return (this.db.prepare('SELECT value_json FROM studio_agent_usage WHERE run_id=? ORDER BY call_id').all(runId) as Array<{ value_json: string }>).map(row => JSON.parse(row.value_json))
  }
  interactions(runId: string): AgentInteraction[] {
    return (this.db.prepare('SELECT value_json FROM studio_agent_interactions WHERE run_id=? ORDER BY rowid').all(runId) as Array<{ value_json: string }>).map(row => JSON.parse(row.value_json))
  }
  claimResponse(runId: string, input: AgentInteractionResponse): { interaction: AgentInteraction; dispatch: boolean } {
    const row = this.db.prepare('SELECT value_json, response_json FROM studio_agent_interactions WHERE id=? AND run_id=?')
      .get(input.interactionId, runId) as { value_json: string; response_json: string | null } | undefined
    if (!row) throw new StudioError('NOT_FOUND', 'Interaction is unavailable')
    const interaction = JSON.parse(row.value_json) as AgentInteraction
    const response = JSON.stringify({ idempotencyKey: input.idempotencyKey, choiceId: input.choiceId ?? null, text: input.text ?? null })
    if (row.response_json) {
      if (row.response_json !== response) throw new StudioError('REVISION_CONFLICT', 'Interaction already has a different response')
      return { interaction, dispatch: false }
    }
    if (interaction.status !== 'pending') throw new StudioError('REVISION_CONFLICT', 'Interaction is no longer pending')
    if (interaction.expiresAt !== null && interaction.expiresAt <= Date.now()) {
      this.setInteraction(interaction, 'expired')
      throw new StudioError('DEADLINE_EXCEEDED', 'Interaction has expired')
    }
    if (input.choiceId !== undefined && !interaction.choices.some(choice => choice.id === input.choiceId)) throw new StudioError('INVALID_ARGUMENT', 'Unknown interaction choice')
    if (interaction.kind === 'approval' && (input.choiceId === undefined || input.text !== undefined)) throw new StudioError('INVALID_ARGUMENT', 'Approval requires one declared choice')
    if (interaction.allowText === false && input.text !== undefined) throw new StudioError('INVALID_ARGUMENT', 'Interaction does not accept text')
    if (input.choiceId !== undefined && input.text !== undefined) throw new StudioError('INVALID_ARGUMENT', 'Choose one interaction response')
    if (input.choiceId === undefined && !input.text?.trim()) throw new StudioError('INVALID_ARGUMENT', 'Interaction response is empty')
    interaction.status = 'responding'
    this.db.prepare('UPDATE studio_agent_interactions SET value_json=?, response_json=? WHERE id=?').run(JSON.stringify(interaction), response, interaction.id)
    return { interaction, dispatch: true }
  }
  setInteraction(interaction: AgentInteraction, status: AgentInteraction['status']): AgentInteraction {
    const current = this.interactions(interaction.runId).find(item => item.id === interaction.id)
    if (!current || !['pending', 'responding'].includes(current.status)) return current || interaction
    const value = { ...current, status }
    this.db.prepare('UPDATE studio_agent_interactions SET value_json=? WHERE id=?').run(JSON.stringify(value), value.id)
    return value
  }
  endInteractions(runId: string): void {
    for (const interaction of this.interactions(runId)) this.setInteraction(interaction, 'interrupted')
  }

  openLease(instanceId: string, provider: AgentProviderRef, configRevision: number): string {
    const id = randomUUID(), now = Date.now()
    this.db.prepare("INSERT INTO studio_agent_runtime_leases VALUES (?, ?, ?, ?, 'active', ?, ?)").run(id, instanceId, JSON.stringify(provider), configRevision, now, now)
    return id
  }
  bindLease(runId: string, leaseId: string): void {
    this.db.prepare('INSERT INTO studio_agent_run_leases VALUES (?, ?)').run(runId, leaseId)
  }
  leaseForRun(runId: string): string | undefined {
    return this.db.prepare('SELECT lease_id FROM studio_agent_run_leases WHERE run_id=?').get(runId)?.lease_id as string | undefined
  }
  closeLease(id: string): void {
    this.db.prepare("UPDATE studio_agent_runtime_leases SET status='closed', updated_at=? WHERE id=?").run(Date.now(), id)
  }
  recover(): void {
    this.db.prepare("UPDATE studio_agent_runtime_leases SET status='closed', updated_at=? WHERE status='active'").run(Date.now())
  }
  saveCheckpoint(instanceId: string, provider: AgentProviderRef, configRevision: number, runId: string, value: JsonValue): void {
    this.db.prepare('INSERT INTO studio_agent_checkpoints VALUES (?, ?, ?, ?, ?) ON CONFLICT(instance_id) DO UPDATE SET provider_json=excluded.provider_json, config_revision=excluded.config_revision, run_id=excluded.run_id, value_json=excluded.value_json')
      .run(instanceId, JSON.stringify(provider), configRevision, runId, JSON.stringify(value))
  }
  checkpoint(instanceId: string, provider: AgentProviderRef, configRevision: number): JsonValue | undefined {
    const row = this.db.prepare('SELECT value_json FROM studio_agent_checkpoints WHERE instance_id=? AND provider_json=? AND config_revision=?')
      .get(instanceId, JSON.stringify(provider), configRevision) as { value_json: string } | undefined
    return row ? JSON.parse(row.value_json) as JsonValue : undefined
  }
  forgetCheckpoint(conversationId: string): void {
    this.db.prepare('DELETE FROM studio_agent_checkpoints WHERE instance_id=?').run(conversationId)
  }
  stateRevision(instanceId: string, provider: AgentProviderRef, configRevision: number): number {
    const row = this.db.prepare('SELECT state_revision FROM studio_agent_state_revisions WHERE instance_id=? AND provider_key=? AND config_revision=?')
      .get(instanceId, JSON.stringify(provider), configRevision) as { state_revision: number } | undefined
    return row?.state_revision ?? configRevision
  }
  /** Called inside the instance configuration transaction, after the old runtime has drained. */
  carryConfiguration(instanceId: string, provider: AgentProviderRef, from: number, to: number, conversationIds: string[] = []): void {
    this.db.prepare('INSERT INTO studio_agent_state_revisions VALUES (?, ?, ?, ?)')
      .run(instanceId, JSON.stringify(provider), to, this.stateRevision(instanceId, provider, from))
    for (const key of [instanceId, ...conversationIds]) {
      if (this.checkpoint(key, provider, from) !== undefined) {
        this.db.prepare('UPDATE studio_agent_checkpoints SET config_revision=?, provider_json=? WHERE instance_id=? AND config_revision=?')
          .run(to, JSON.stringify(provider), key, from)
      }
    }
  }
}
