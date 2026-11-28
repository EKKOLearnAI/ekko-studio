import { createHash } from 'node:crypto'
import { getDb, jsonGet, jsonSet } from '../infrastructure/database'
import { MCU_SESSION_BINDINGS_TABLE } from '../infrastructure/database/schemas'
import { McuBindingError, type McuBindingKind, type McuBindingOwner } from '../contracts/mcu-session-bindings'

export interface StoredMcuSessionBinding extends McuBindingOwner {
  sessionId: string | null
  kind: McuBindingKind | null
  revision: number
}
interface Row { user_id: number; profile: string; device_code: string; session_id: string | null; kind: McuBindingKind | null; revision: number }
const key = (owner: McuBindingOwner) => createHash('sha256').update(JSON.stringify([owner.userId, owner.profile, owner.deviceCode])).digest('hex')
const decode = (row: Row): StoredMcuSessionBinding => ({ userId: Number(row.user_id), profile: row.profile, deviceCode: row.device_code,
  sessionId: row.session_id, kind: row.kind, revision: Number(row.revision) })

export function getMcuSessionBinding(owner: McuBindingOwner): StoredMcuSessionBinding | null {
  const db = getDb(), id = key(owner)
  const row = (db ? db.prepare(`SELECT * FROM ${MCU_SESSION_BINDINGS_TABLE} WHERE id=?`).get(id) : jsonGet(MCU_SESSION_BINDINGS_TABLE, id)) as Row | undefined
  return row ? decode(row) : null
}

/** A deleted binding is a versioned tombstone, never an absent revision-zero row. */
export function compareAndSetMcuSessionBinding(owner: McuBindingOwner, expectedRevision: number,
  binding: { sessionId: string; kind: McuBindingKind } | null): StoredMcuSessionBinding {
  const db = getDb(), id = key(owner)
  if (db) db.exec('BEGIN IMMEDIATE')
  try {
    const previous = getMcuSessionBinding(owner)
    if ((previous?.revision ?? 0) !== expectedRevision) throw new McuBindingError('Binding changed; reload its latest revision', 409, 'mcu_binding_conflict')
    const revision = expectedRevision + 1
    if (!Number.isSafeInteger(revision)) throw new McuBindingError('Binding revision exhausted', 409, 'mcu_binding_conflict')
    const row = { id, user_id: owner.userId, profile: owner.profile, device_code: owner.deviceCode,
      session_id: binding?.sessionId ?? null, kind: binding?.kind ?? null, revision, updated_at: Date.now() }
    if (db) db.prepare(`INSERT INTO ${MCU_SESSION_BINDINGS_TABLE}
      (id,user_id,profile,device_code,session_id,kind,revision,updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,kind=excluded.kind,revision=excluded.revision,updated_at=excluded.updated_at`)
      .run(id, row.user_id, row.profile, row.device_code, row.session_id, row.kind, revision, row.updated_at)
    else jsonSet(MCU_SESSION_BINDINGS_TABLE, id, row)
    if (db) db.exec('COMMIT')
    return decode(row)
  } catch (error) {
    if (db) db.exec('ROLLBACK')
    throw error
  }
}
