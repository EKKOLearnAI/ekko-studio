import { randomUUID, createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ExecutionScope } from '../contracts/plugins'
import { StudioError, type AgentProviderRef, type JsonObject, type AgentRunInput, type AgentOutputEvent, type EventEnvelope, type AgentRunRecord, type AgentRunStatus, type HookSnapshot } from '../contracts/plugins'
import { PluginEventStore } from './plugin-event-store'
import { AgentRunStateStore } from './agent-run-state-store'
import { AgentConversationStore, type AgentRunTarget } from './agent-conversation-store'
import { AgentRunCommandOrigins } from './agent-run-command-origin'

export interface AgentInstance {
  id: string; agentTypeId: string; profileId: string; ownerId: string
  config: JsonObject; revision: number; mode: 'scoped' | 'global'
}
export interface AgentInstanceConfiguration { revision: number; config: JsonObject; mode: 'scoped' | 'global' }
export type { AgentRunStatus } from '../contracts/plugins'
export type AgentExecution = AgentRunRecord
export interface AgentAdmission {
  originalInput: AgentRunInput; hooks: HookSnapshot[]; expectedProvider: AgentProviderRef; expectedRevision: number
}
/** Synchronous domain projections participate in the canonical Run transaction. */
export interface AgentExecutionProjection {
  accepted(run: AgentExecution, input: AgentRunInput): void
  started(run: AgentExecution, input: AgentRunInput): void
  output(run: AgentExecution, event: AgentOutputEvent): void
  finished(run: AgentExecution): void
}
interface RunRow { id: string; instance_id: string; profile_id: string; owner_id: string; status: AgentRunStatus; provider_json: string; config_revision: number; revision: number; created_at: number; updated_at: number; error_code: string | null; input_hash: string }

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}
export function agentRunRequestHash(instanceId: string, input: AgentRunInput, target?: AgentRunTarget): string {
  return createHash('sha256').update(canonicalJson({ instanceId, input, ...(target ? { target } : {}) })).digest('hex')
}

export class AgentExecutionStore {
  readonly state: AgentRunStateStore
  readonly conversations: AgentConversationStore
  readonly commands: AgentRunCommandOrigins
  private readonly events: PluginEventStore
  constructor(private readonly db: DatabaseSync, private readonly projection?: AgentExecutionProjection) {
    this.state = new AgentRunStateStore(db)
    this.conversations = new AgentConversationStore(db)
    this.commands = new AgentRunCommandOrigins(db)
    this.events = new PluginEventStore(db)
    db.exec(`CREATE TABLE IF NOT EXISTS studio_agent_instances (
      id TEXT PRIMARY KEY, agent_type_id TEXT NOT NULL, profile_id TEXT NOT NULL, owner_id TEXT NOT NULL,
      config_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, mode TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS studio_agent_runs (
      id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, profile_id TEXT NOT NULL, owner_id TEXT NOT NULL,
      status TEXT NOT NULL, provider_json TEXT NOT NULL, config_revision INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      error_code TEXT, idempotency_key TEXT NOT NULL, input_hash TEXT NOT NULL,
      UNIQUE(owner_id, profile_id, idempotency_key)
    ); CREATE TABLE IF NOT EXISTS studio_agent_run_outputs (
      run_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_json TEXT NOT NULL,
      PRIMARY KEY(run_id, sequence)
    ); CREATE TABLE IF NOT EXISTS studio_agent_run_admissions (
      run_id TEXT PRIMARY KEY, original_input_json TEXT NOT NULL, effective_input_json TEXT NOT NULL, hooks_json TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS studio_agent_run_origins (
      run_id TEXT PRIMARY KEY, surface TEXT NOT NULL
    );`)
  }

  createInstance(input: Omit<AgentInstance, 'id' | 'revision'>): AgentInstance {
    const id = randomUUID()
    this.db.prepare('INSERT INTO studio_agent_instances (id, agent_type_id, profile_id, owner_id, config_json, mode) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, input.agentTypeId, input.profileId, input.ownerId, JSON.stringify(input.config), input.mode)
    return { ...input, id, revision: 1 }
  }
  instance(id: string): AgentInstance | null {
    const row = this.db.prepare('SELECT * FROM studio_agent_instances WHERE id=?').get(id) as { id: string; agent_type_id: string; profile_id: string; owner_id: string; config_json: string; revision: number; mode: 'scoped' | 'global' } | undefined
    return row ? { id: row.id, agentTypeId: row.agent_type_id, profileId: row.profile_id, ownerId: row.owner_id, config: JSON.parse(row.config_json) as JsonObject, revision: row.revision, mode: row.mode } : null
  }
  instances(ownerId: string, profileId: string): AgentInstance[] {
    return (this.db.prepare('SELECT id FROM studio_agent_instances WHERE owner_id=? AND profile_id=? ORDER BY id').all(ownerId, profileId) as Array<{ id: string }>).map(row => this.instance(row.id)!)
  }

  hasActiveRuns(instanceId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM studio_agent_runs WHERE instance_id=? AND status NOT IN ('completed','cancelled','failed','interrupted') LIMIT 1").get(instanceId)
  }
  configureInstance(instance: AgentInstance, input: AgentInstanceConfiguration, preserve?: AgentProviderRef, commit?: (instance: AgentInstance) => void): AgentInstance {
    this.db.exec('SAVEPOINT studio_agent_configuration')
    try {
      const changed = this.db.prepare(`UPDATE studio_agent_instances SET config_json=?, mode=?, revision=revision+1
        WHERE id=? AND owner_id=? AND profile_id=? AND revision=? AND revision<?
        AND NOT EXISTS (SELECT 1 FROM studio_agent_runs WHERE instance_id=? AND status NOT IN ('completed','cancelled','failed','interrupted'))`)
        .run(JSON.stringify(input.config), input.mode, instance.id, instance.ownerId, instance.profileId, input.revision, Number.MAX_SAFE_INTEGER, instance.id)
      if (!changed.changes) throw new StudioError('REVISION_CONFLICT', 'Agent instance changed or has active runs')
      if (preserve) this.state.carryConfiguration(instance.id, preserve, input.revision, input.revision + 1, this.conversations.ids(instance.id))
      commit?.(this.instance(instance.id)!)
      this.db.exec('RELEASE studio_agent_configuration')
      return this.instance(instance.id)!
    } catch (error) { this.db.exec('ROLLBACK TO studio_agent_configuration; RELEASE studio_agent_configuration'); throw error }
  }

  findRequest(instance: AgentInstance, input: AgentRunInput, key: string, target?: AgentRunTarget): AgentExecution | null {
    const hash = agentRunRequestHash(instance.id, input, target)
    const previous = this.db.prepare('SELECT * FROM studio_agent_runs WHERE owner_id=? AND profile_id=? AND idempotency_key=?').get(instance.ownerId, instance.profileId, key) as unknown as RunRow | undefined
    if (previous) {
      if (previous.input_hash !== hash) throw new StudioError('REVISION_CONFLICT', 'Idempotency key already identifies different input')
      return this.decode(previous)
    }
    return null
  }
  accept(instance: AgentInstance, provider: AgentProviderRef, input: AgentRunInput, key: string, admission?: AgentAdmission, target?: AgentRunTarget, surface: ExecutionScope['surface'] = 'api'): { run: AgentExecution; created: boolean } {
    const original = admission?.originalInput ?? input
    const previous = this.findRequest(instance, original, key, target)
    if (previous) return { run: previous, created: false }
    const hash = agentRunRequestHash(instance.id, original, target)
    const id = randomUUID(), now = Date.now()
    this.db.exec('SAVEPOINT studio_agent_admission')
    try {
      this.db.prepare(`INSERT INTO studio_agent_runs
      (id, instance_id, profile_id, owner_id, status, provider_json, config_revision, created_at, updated_at, idempotency_key, input_hash)
      VALUES (?, ?, ?, ?, 'accepted', ?, ?, ?, ?, ?, ?)`).run(id, instance.id, instance.profileId, instance.ownerId, JSON.stringify(provider), instance.revision, now, now, key, hash)
      this.db.prepare('INSERT INTO studio_agent_run_admissions VALUES (?, ?, ?, ?)').run(id, JSON.stringify(original), JSON.stringify(input), JSON.stringify(admission?.hooks || []))
      this.db.prepare('INSERT INTO studio_agent_run_origins VALUES (?, ?)').run(id, surface)
      if (target) this.conversations.bind(id, instance, target)
      if (target?.command) this.commands.bind(id, instance, target.sessionId, target.command)
      this.projection?.accepted(this.get(id)!, original)
      this.db.exec('RELEASE studio_agent_admission')
    } catch (error) { this.db.exec('ROLLBACK TO studio_agent_admission; RELEASE studio_agent_admission'); throw error }
    return { run: this.get(id)!, created: true }
  }
  get(id: string): AgentExecution | null {
    const row = this.db.prepare('SELECT * FROM studio_agent_runs WHERE id=?').get(id) as unknown as RunRow | undefined
    return row ? this.decode(row) : null
  }
  requestKey(id: string): string | undefined {
    return this.db.prepare('SELECT idempotency_key FROM studio_agent_runs WHERE id=?').get(id)?.idempotency_key as string | undefined
  }
  activeForChat(sessionId: string): AgentExecution[] {
    const rows = this.db.prepare(`SELECT r.* FROM studio_agent_runs r JOIN studio_agent_run_targets t ON t.run_id=r.id
      WHERE t.session_id=? AND r.status NOT IN ('completed','cancelled','failed','interrupted') ORDER BY r.created_at, r.rowid`).all(sessionId)
    return rows.map(row => this.decode(row as unknown as RunRow))
  }
  input(id: string): AgentRunInput | null {
    const row = this.db.prepare('SELECT effective_input_json FROM studio_agent_run_admissions WHERE run_id=?').get(id) as { effective_input_json: string } | undefined
    return row ? JSON.parse(row.effective_input_json) as AgentRunInput : null
  }
  originalInput(id: string): AgentRunInput | null {
    const row = this.db.prepare('SELECT original_input_json FROM studio_agent_run_admissions WHERE run_id=?').get(id) as { original_input_json: string } | undefined
    return row ? JSON.parse(row.original_input_json) as AgentRunInput : null
  }
  transition(id: string, from: AgentRunStatus[], to: AgentRunStatus): boolean {
    const starting = !!this.projection && ['starting', 'running'].includes(to)
    if (starting) this.db.exec('SAVEPOINT studio_agent_transition')
    try {
      const changed = this.db.prepare(`UPDATE studio_agent_runs SET status=?, revision=revision+1, updated_at=? WHERE id=? AND status IN (${from.map(() => '?').join(',')})`)
        .run(to, Date.now(), id, ...from).changes > 0
      if (changed && starting) this.projection!.started(this.get(id)!, this.originalInput(id)!)
      if (starting) this.db.exec('RELEASE studio_agent_transition')
      return changed
    } catch (error) { if (starting) this.db.exec('ROLLBACK TO studio_agent_transition; RELEASE studio_agent_transition'); throw error }
  }
  appendOutput(id: string, event: AgentOutputEvent): void {
    const run = this.get(id)
    if (!run || !['running', 'waiting_input', 'cancelling'].includes(run.status)) throw new StudioError('REVISION_CONFLICT', 'Run no longer accepts output')
    // The host already owns both global accounting and the parent Run projection.
    if (event.type === 'usage.reported' && this.state.isHostModelCall(event.modelCallId)) return
    this.db.exec('SAVEPOINT studio_agent_output')
    try {
      this.db.prepare('INSERT INTO studio_agent_run_outputs (run_id, sequence, event_json) VALUES (?, ?, ?)').run(id, event.producerSequence, JSON.stringify(event))
      this.state.project(id, event)
      this.projection?.output(run, event)
      if (event.type === 'interaction.requested') this.transition(id, ['running'], 'waiting_input')
      if (event.type === 'interaction.withdrawn' && !this.state.interactions(id).some(item => ['pending', 'responding'].includes(item.status))) {
        this.transition(id, ['waiting_input'], 'running')
      }
      this.db.exec('RELEASE studio_agent_output')
    } catch (error) { this.db.exec('ROLLBACK TO studio_agent_output; RELEASE studio_agent_output'); throw error }
  }
  output(id: string, after = -1, limit = 100): AgentOutputEvent[] {
    return (this.db.prepare('SELECT event_json FROM studio_agent_run_outputs WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?')
      .all(id, after, Math.min(1000, Math.max(1, limit))) as Array<{ event_json: string }>).map(row => JSON.parse(row.event_json) as AgentOutputEvent)
  }
  finish(id: string, status: 'completed' | 'cancelled' | 'failed' | 'interrupted', errorCode: string | null, checkpoint?: import('../contracts/plugins').JsonValue): EventEnvelope[] {
    const run = this.get(id)
    if (!run || ['completed', 'cancelled', 'failed', 'interrupted'].includes(run.status)) return []
    const type = status === 'completed' ? 'run.completed' : status === 'cancelled' ? 'run.cancelled' : 'run.failed'
    this.db.exec('SAVEPOINT studio_agent_finish')
    try {
      const changed = this.db.prepare(`UPDATE studio_agent_runs SET status=?, error_code=?, revision=revision+1, updated_at=?
        WHERE id=? AND revision=?`).run(status, errorCode, Date.now(), id, run.revision)
      if (changed.changes) {
        this.state.endInteractions(id)
        if (status === 'completed' && checkpoint !== undefined) this.state.saveCheckpoint(run.conversationId ?? run.instanceId, run.provider, run.configRevision, id, checkpoint)
        this.projection?.finished(this.get(id)!)
      }
      const events = changed.changes ? this.events.append([{
        schemaVersion: 1, id: randomUUID(), type, occurredAt: Date.now(), partitionKey: `${run.profileId}:${run.id}`, sequence: 0,
        subject: { profileId: run.profileId, runId: run.id, ...(run.sessionId ? { sessionId: run.sessionId } : {}) }, data: { runId: run.id }, correlationId: run.id,
      }], run.ownerId) : []
      this.db.exec('RELEASE studio_agent_finish')
      return events
    } catch (error) { this.db.exec('ROLLBACK TO studio_agent_finish; RELEASE studio_agent_finish'); throw error }
  }
  recover(): number {
    this.state.recover()
    const rows = this.db.prepare("SELECT id FROM studio_agent_runs WHERE status IN ('accepted','queued','starting','running','waiting_input','finalizing','cancelling')").all() as Array<{ id: string }>
    for (const row of rows) this.finish(row.id, 'interrupted', 'RUNTIME_UNAVAILABLE')
    return rows.length
  }
  private decode(row: RunRow): AgentExecution {
    const admission = this.db.prepare('SELECT hooks_json FROM studio_agent_run_admissions WHERE run_id=?').get(row.id) as { hooks_json: string } | undefined
    const origin = this.db.prepare('SELECT surface FROM studio_agent_run_origins WHERE run_id=?').get(row.id) as { surface: ExecutionScope['surface'] } | undefined
    return { id: row.id, instanceId: row.instance_id, profileId: row.profile_id, ownerId: row.owner_id, status: row.status,
      ...this.conversations.target(row.id),
      ...(origin ? { surface: origin.surface } : {}),
      provider: JSON.parse(row.provider_json) as AgentProviderRef, configRevision: row.config_revision, revision: row.revision,
      createdAt: row.created_at, updatedAt: row.updated_at, errorCode: row.error_code, ...(admission ? { hooks: JSON.parse(admission.hooks_json) as HookSnapshot[] } : {}) }
  }
}
