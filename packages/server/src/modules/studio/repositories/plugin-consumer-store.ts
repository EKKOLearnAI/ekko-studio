import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { StudioError, type EventEnvelope, type StudioErrorCode } from '../contracts/plugins'
import { PluginEventStore } from './plugin-event-store'

export interface ConsumerIdentity { pluginId: string; profileId: string; ownerId: string; name: string }
export interface ConsumerSpec { types: string[]; start: 'now' | 'earliest'; resume: 'continue' | 'from-now' }
export interface ConsumerRecord extends ConsumerIdentity {
  id: string; types: string[]; position: number; state: 'active' | 'paused' | 'expired'; revision: number
  errorCode: StudioErrorCode | null
}
export interface ConsumerDelivery { consumerId: string; position: number; event: EventEnvelope; lease: string; attempt: number; revision: number }
interface ConsumerRow { id: string; plugin_id: string; profile_id: string; owner_id: string; name: string; types_json: string; position: number; state: ConsumerRecord['state']; revision: number; error_code: StudioErrorCode | null }
interface DeliveryRow { consumer_id: string; position: number; partition_key: string; status: 'pending' | 'processing' | 'dead'; attempts: number; available_at: number; lease: string | null; lease_until: number | null; revision: number; error_code: StudioErrorCode | null }

export function parseConsumerSpec(input: unknown): ConsumerSpec {
  const value = input as ConsumerSpec
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['types', 'start', 'resume'].includes(key))
    || !Array.isArray(value.types) || !value.types.length || value.types.length > 64 || new Set(value.types).size !== value.types.length
    || value.types.some(type => typeof type !== 'string' || !/^[a-z][a-z0-9.:-]*$/.test(type) || type.length > 256)
    || !['now', 'earliest'].includes(value.start) || !['continue', 'from-now'].includes(value.resume)) throw new StudioError('INVALID_ARGUMENT', 'Invalid reliable consumer specification')
  return { types: [...value.types].sort(), start: value.start, resume: value.resume }
}

/** Durable delivery metadata only; payloads stay in the public transaction event table. */
export class PluginConsumerStore {
  readonly events: PluginEventStore
  constructor(private readonly db: DatabaseSync, private readonly maxPending = 10_000) {
    this.events = new PluginEventStore(db)
    db.exec(`CREATE TABLE IF NOT EXISTS studio_plugin_consumers (
      id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, profile_id TEXT NOT NULL, owner_id TEXT NOT NULL, name TEXT NOT NULL,
      types_json TEXT NOT NULL, position INTEGER NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, error_code TEXT,
      UNIQUE(plugin_id, profile_id, owner_id, name)
    ); CREATE TABLE IF NOT EXISTS studio_plugin_deliveries (
      consumer_id TEXT NOT NULL, position INTEGER NOT NULL, partition_key TEXT NOT NULL, status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER,
      revision INTEGER NOT NULL DEFAULT 1, error_code TEXT, PRIMARY KEY(consumer_id, position)
    ); CREATE INDEX IF NOT EXISTS studio_plugin_deliveries_partition ON studio_plugin_deliveries(consumer_id, partition_key, position);`)
  }

  register(identity: ConsumerIdentity, input: ConsumerSpec): ConsumerRecord {
    const spec = parseConsumerSpec(input)
    if (typeof identity.name !== 'string' || !/^[a-z][a-z0-9.-]{0,127}$/.test(identity.name)) throw new StudioError('INVALID_ARGUMENT', 'Invalid consumer name')
    const previous = this.db.prepare('SELECT id FROM studio_plugin_consumers WHERE plugin_id=? AND profile_id=? AND owner_id=? AND name=?')
      .get(identity.pluginId, identity.profileId, identity.ownerId, identity.name) as { id: string } | undefined
    if (previous && spec.resume === 'continue' && this.expired(previous.id)) throw new StudioError('EVENT_CURSOR_EXPIRED', 'Consumer cursor is older than retained events')
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM studio_plugin_consumers WHERE plugin_id=? AND profile_id=? AND owner_id=? AND name=?')
        .get(identity.pluginId, identity.profileId, identity.ownerId, identity.name) as unknown as ConsumerRow | undefined
      if (old) {
        if (spec.resume === 'from-now') {
          this.db.prepare('DELETE FROM studio_plugin_deliveries WHERE consumer_id=?').run(old.id)
          this.db.prepare("UPDATE studio_plugin_consumers SET types_json=?, position=?, state='active', error_code=NULL, revision=revision+1 WHERE id=?")
            .run(JSON.stringify(spec.types), this.events.head(), old.id)
        } else {
          if (old.types_json !== JSON.stringify(spec.types)) throw new StudioError('REVISION_CONFLICT', 'Consumer event types changed without an explicit reset')
          if (this.expired(old.id)) throw new StudioError('EVENT_CURSOR_EXPIRED', 'Consumer cursor is older than retained events')
        }
        return this.get(old.id)!
      }
      if (spec.start === 'earliest' && this.events.floor() > 0) throw new StudioError('EVENT_CURSOR_EXPIRED', 'Earlier events are no longer retained')
      const id = randomUUID()
      this.db.prepare("INSERT INTO studio_plugin_consumers (id, plugin_id, profile_id, owner_id, name, types_json, position, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')")
        .run(id, identity.pluginId, identity.profileId, identity.ownerId, identity.name, JSON.stringify(spec.types), spec.start === 'now' ? this.events.head() : 0)
      return this.get(id)!
    })
  }

  get(id: string): ConsumerRecord | null {
    const row = this.db.prepare('SELECT * FROM studio_plugin_consumers WHERE id=?').get(id) as unknown as ConsumerRow | undefined
    return row ? { id, pluginId: row.plugin_id, profileId: row.profile_id, ownerId: row.owner_id, name: row.name,
      types: JSON.parse(row.types_json), position: row.position, state: row.state, revision: row.revision, errorCode: row.error_code } : null
  }
  registerMany(inputs: Array<{ identity: ConsumerIdentity; spec: ConsumerSpec }>): ConsumerRecord[] {
    return this.transaction(() => inputs.map(input => this.register(input.identity, input.spec)))
  }
  list(pluginId: string, profileId: string): ConsumerRecord[] {
    return (this.db.prepare('SELECT id FROM studio_plugin_consumers WHERE plugin_id=? AND profile_id=? ORDER BY name, owner_id').all(pluginId, profileId) as Array<{ id: string }>).map(row => this.get(row.id)!)
  }

  private expired(id: string): boolean {
    const consumer = this.get(id)
    if (!consumer) throw new StudioError('NOT_FOUND', 'Consumer is unavailable')
    const pending = this.db.prepare('SELECT MIN(position) AS position FROM studio_plugin_deliveries WHERE consumer_id=?').get(id) as { position: number | null }
    const floor = this.events.floor()
    if (consumer.state === 'expired' || consumer.position < floor || (pending.position !== null && pending.position <= floor && !this.events.get(pending.position))) {
      this.db.prepare("UPDATE studio_plugin_consumers SET state='expired', error_code='EVENT_CURSOR_EXPIRED' WHERE id=?").run(id)
      return true
    }
    return false
  }

  fill(id: string, batchSize = 100): void {
    if (this.expired(id)) return
    batchSize = Math.max(1, Math.min(1000, Math.floor(batchSize)))
    this.transaction(() => {
      const consumer = this.get(id)!
      if (consumer.state !== 'active') return
      const head = this.events.head(), rows = this.events.read(consumer.profileId, consumer.position, batchSize)
      let count = (this.db.prepare('SELECT COUNT(*) AS n FROM studio_plugin_deliveries WHERE consumer_id=?').get(id) as { n: number }).n
      let position = consumer.position, full = false
      for (const row of rows) {
        if (consumer.types.includes(row.event.type)) {
          if (count >= this.maxPending) { full = true; break }
          this.db.prepare("INSERT INTO studio_plugin_deliveries (consumer_id, position, partition_key, status) VALUES (?, ?, ?, 'pending')").run(id, row.position, row.event.partitionKey)
          count++
        }
        position = row.position
      }
      if (!full && rows.length < batchSize) position = head
      this.db.prepare('UPDATE studio_plugin_consumers SET position=?, error_code=? WHERE id=?')
        .run(position, full ? 'RESOURCE_EXHAUSTED' : null, id)
    })
  }

  claim(id: string, now: number, timeoutMs = 30_000, maxAttempts = 5, activePositions: number[] = []): ConsumerDelivery | null {
    if (this.expired(id) || this.get(id)?.state !== 'active') return null
    return this.transaction(() => {
      this.db.prepare("UPDATE studio_plugin_deliveries SET status=CASE WHEN attempts>=? THEN 'dead' ELSE 'pending' END, lease=NULL, lease_until=NULL, error_code='DEADLINE_EXCEEDED', revision=revision+1 WHERE consumer_id=? AND status='processing' AND lease_until<=? AND position NOT IN (SELECT value FROM json_each(?))").run(maxAttempts, id, now, JSON.stringify(activePositions))
      const row = this.db.prepare(`SELECT * FROM studio_plugin_deliveries current WHERE consumer_id=? AND status='pending' AND available_at<=?
        AND position NOT IN (SELECT value FROM json_each(?))
        AND NOT EXISTS (SELECT 1 FROM studio_plugin_deliveries previous WHERE previous.consumer_id=current.consumer_id
          AND previous.partition_key=current.partition_key AND previous.position<current.position) ORDER BY position LIMIT 1`).get(id, now, JSON.stringify(activePositions)) as unknown as DeliveryRow | undefined
      if (!row) return null
      const event = this.events.get(row.position)
      if (!event) { this.db.prepare("UPDATE studio_plugin_consumers SET state='expired', error_code='EVENT_CURSOR_EXPIRED' WHERE id=?").run(id); return null }
      const lease = randomUUID()
      this.db.prepare("UPDATE studio_plugin_deliveries SET status='processing', attempts=attempts+1, lease=?, lease_until=?, revision=revision+1 WHERE consumer_id=? AND position=?")
        .run(lease, now + timeoutMs, id, row.position)
      return { consumerId: id, position: row.position, event, lease, attempt: row.attempts + 1, revision: row.revision + 1 }
    })
  }

  ack(delivery: ConsumerDelivery): boolean {
    return !!this.db.prepare("DELETE FROM studio_plugin_deliveries WHERE consumer_id=? AND position=? AND status='processing' AND lease=?")
      .run(delivery.consumerId, delivery.position, delivery.lease).changes
  }
  fail(delivery: ConsumerDelivery, code: StudioErrorCode, now: number, maxAttempts = 5, cancelled = false): void {
    const attempts = cancelled ? Math.max(0, delivery.attempt - 1) : delivery.attempt
    this.db.prepare('UPDATE studio_plugin_deliveries SET status=?, attempts=?, available_at=?, lease=NULL, lease_until=NULL, error_code=?, revision=revision+1 WHERE consumer_id=? AND position=? AND lease=?')
      .run(attempts >= maxAttempts ? 'dead' : 'pending', attempts, now + (cancelled ? 0 : Math.min(30_000, 1000 * 2 ** Math.min(attempts - 1, 5))),
        cancelled ? null : code, delivery.consumerId, delivery.position, delivery.lease)
  }
  deliveries(id: string): Array<Omit<DeliveryRow, 'lease'>> {
    return (this.db.prepare('SELECT consumer_id, position, partition_key, status, attempts, available_at, lease_until, revision, error_code FROM studio_plugin_deliveries WHERE consumer_id=? ORDER BY position LIMIT 1000').all(id) as unknown as Array<Omit<DeliveryRow, 'lease'>>)
  }
  retry(id: string, position: number, revision: number): void {
    if (this.expired(id)) throw new StudioError('EVENT_CURSOR_EXPIRED', 'Consumer cursor is expired')
    const result = this.db.prepare("UPDATE studio_plugin_deliveries SET status='pending', attempts=0, available_at=0, error_code=NULL, revision=revision+1 WHERE consumer_id=? AND position=? AND status='dead' AND revision=?").run(id, position, revision)
    if (!result.changes) throw new StudioError('REVISION_CONFLICT', 'Dead letter changed before retry')
  }
  control(id: string, action: 'pause' | 'resume' | 'reset-now', revision: number): ConsumerRecord {
    if (!['pause', 'resume', 'reset-now'].includes(action) || !Number.isSafeInteger(revision) || revision < 1) throw new StudioError('INVALID_ARGUMENT', 'Invalid consumer control')
    const consumer = this.get(id)
    if (!consumer) throw new StudioError('NOT_FOUND', 'Consumer is unavailable')
    if (consumer.revision !== revision) throw new StudioError('REVISION_CONFLICT', 'Consumer configuration changed')
    if (action === 'resume' && this.expired(id)) throw new StudioError('EVENT_CURSOR_EXPIRED', 'Consumer cursor is expired')
    return this.transaction(() => {
      if (action === 'reset-now') this.db.prepare('DELETE FROM studio_plugin_deliveries WHERE consumer_id=?').run(id)
      this.db.prepare('UPDATE studio_plugin_consumers SET state=?, position=?, error_code=NULL, revision=revision+1 WHERE id=?')
        .run(action === 'pause' ? 'paused' : 'active', action === 'reset-now' ? this.events.head() : consumer.position, id)
      return this.get(id)!
    })
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('SAVEPOINT studio_plugin_consumer')
    try { const result = work(); this.db.exec('RELEASE studio_plugin_consumer'); return result }
    catch (error) { this.db.exec('ROLLBACK TO studio_plugin_consumer; RELEASE studio_plugin_consumer'); throw error }
  }
}
