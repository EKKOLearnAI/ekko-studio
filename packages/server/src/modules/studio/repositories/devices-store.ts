import { getDb, jsonDelete, jsonGet, jsonGetAll, jsonSet } from '../infrastructure/database/index'
import { DEVICES_TABLE } from '../infrastructure/database/schemas'
import type { LanDeviceInfo } from '../services/network/lan-pairing-discovery'

export type DeviceInboundStatus = 'none' | 'pending' | 'approved' | 'rejected' | 'blocked'
export type DeviceOutboundStatus = 'none' | 'pending' | 'approved' | 'rejected' | 'blocked'

export type DeviceRelationRecord = Omit<LanDeviceInfo, 'last_seen_at'> & {
  inbound_status: DeviceInboundStatus
  outbound_status: DeviceOutboundStatus
  requested_at: number
  decided_at: number | null
  outbound_requested_at: number
  outbound_decided_at: number | null
  inbound_history_deleted_at: number | null
  last_seen_at: number
  updated_at: number
}

export class DuplicateDeviceRequestError extends Error {
  constructor() {
    super('Duplicate pairing request')
    this.name = 'DuplicateDeviceRequestError'
  }
}

type StoredDeviceRow = {
  id: string
  status?: DeviceInboundStatus
  inbound_status?: DeviceInboundStatus
  outbound_status?: DeviceOutboundStatus
  device_public_key: string
  computer_name: string
  endpoint_kind: LanDeviceInfo['endpoint_kind']
  ip: string
  http_port: number
  url: string
  os_json: string
  hermes_agent_version: string
  hermes_web_ui_version: string
  response_ms: number
  requested_at: number
  decided_at: number | null
  outbound_requested_at?: number
  outbound_decided_at?: number | null
  inbound_history_deleted_at?: number | null
  last_seen_at: number
  updated_at: number
}

function parseTime(value: string | number | null | undefined): number {
  if (typeof value === 'number') return value
  if (!value) return Date.now()
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? Date.now() : parsed
}

function normalizeInboundStatus(value: unknown): DeviceInboundStatus {
  return value === 'pending' || value === 'approved' || value === 'rejected' || value === 'blocked' ? value : 'none'
}

function normalizeOutboundStatus(value: unknown): DeviceOutboundStatus {
  return value === 'pending' || value === 'approved' || value === 'rejected' || value === 'blocked' ? value : 'none'
}

function rowToRecord(row: StoredDeviceRow | Record<string, any>): DeviceRelationRecord {
  let os: LanDeviceInfo['os'] = { type: '', platform: '' as NodeJS.Platform, release: '', arch: '' }
  try {
    os = JSON.parse(String(row.os_json || '{}'))
  } catch {
    // Keep the empty OS fallback.
  }

  return {
    id: String(row.id),
    device_id: String(row.id),
    inbound_status: normalizeInboundStatus(row.inbound_status || row.status),
    outbound_status: normalizeOutboundStatus(row.outbound_status),
    device_public_key: String(row.device_public_key || ''),
    computer_name: String(row.computer_name || ''),
    endpoint_kind: row.endpoint_kind === 'web' || row.endpoint_kind === 'desktop' ? row.endpoint_kind : 'custom',
    ip: String(row.ip || ''),
    http_port: Number(row.http_port || 0),
    url: String(row.url || ''),
    os,
    hermes_agent_version: String(row.hermes_agent_version || ''),
    hermes_web_ui_version: String(row.hermes_web_ui_version || ''),
    response_ms: Number(row.response_ms || 0),
    requested_at: Number(row.requested_at || 0),
    decided_at: row.decided_at == null ? null : Number(row.decided_at),
    outbound_requested_at: Number(row.outbound_requested_at || 0),
    outbound_decided_at: row.outbound_decided_at == null ? null : Number(row.outbound_decided_at),
    inbound_history_deleted_at: row.inbound_history_deleted_at == null ? null : Number(row.inbound_history_deleted_at),
    last_seen_at: Number(row.last_seen_at || 0),
    updated_at: Number(row.updated_at || 0),
  }
}

function deviceToRow(device: LanDeviceInfo | DeviceRelationRecord, existing: DeviceRelationRecord | null, now: number): StoredDeviceRow {
  return {
    id: device.id,
    status: existing?.inbound_status || 'none',
    inbound_status: existing?.inbound_status || 'none',
    outbound_status: existing?.outbound_status || 'none',
    device_public_key: device.device_public_key,
    computer_name: device.computer_name,
    endpoint_kind: device.endpoint_kind,
    ip: device.ip,
    http_port: device.http_port,
    url: device.url,
    os_json: JSON.stringify(device.os || {}),
    hermes_agent_version: device.hermes_agent_version,
    hermes_web_ui_version: device.hermes_web_ui_version,
    response_ms: device.response_ms,
    requested_at: existing?.requested_at || 0,
    decided_at: existing?.decided_at || null,
    outbound_requested_at: existing?.outbound_requested_at || 0,
    outbound_decided_at: existing?.outbound_decided_at || null,
    inbound_history_deleted_at: existing?.inbound_history_deleted_at || null,
    last_seen_at: parseTime(device.last_seen_at),
    updated_at: now,
  }
}

function saveRow(row: StoredDeviceRow): DeviceRelationRecord {
  const db = getDb()
  if (!db) {
    jsonSet(DEVICES_TABLE, row.id, row as any)
    return rowToRecord(row)
  }

  db.prepare(`
    INSERT INTO ${DEVICES_TABLE} (
      id, status, inbound_status, outbound_status, computer_name, endpoint_kind,
      ip, http_port, url, os_json, hermes_agent_version, hermes_web_ui_version,
      response_ms, device_public_key, requested_at, decided_at,
      outbound_requested_at, outbound_decided_at, inbound_history_deleted_at,
      last_seen_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      inbound_status = excluded.inbound_status,
      outbound_status = excluded.outbound_status,
      device_public_key = excluded.device_public_key,
      computer_name = excluded.computer_name,
      endpoint_kind = excluded.endpoint_kind,
      ip = excluded.ip,
      http_port = excluded.http_port,
      url = excluded.url,
      os_json = excluded.os_json,
      hermes_agent_version = excluded.hermes_agent_version,
      hermes_web_ui_version = excluded.hermes_web_ui_version,
      response_ms = excluded.response_ms,
      requested_at = excluded.requested_at,
      decided_at = excluded.decided_at,
      outbound_requested_at = excluded.outbound_requested_at,
      outbound_decided_at = excluded.outbound_decided_at,
      inbound_history_deleted_at = excluded.inbound_history_deleted_at,
      last_seen_at = excluded.last_seen_at,
      updated_at = excluded.updated_at
  `).run(
    row.id,
    row.status || row.inbound_status || 'none',
    row.inbound_status || 'none',
    row.outbound_status || 'none',
    row.computer_name,
    row.endpoint_kind,
    row.ip,
    row.http_port,
    row.url,
    row.os_json,
    row.hermes_agent_version,
    row.hermes_web_ui_version,
    row.response_ms,
    row.device_public_key,
    row.requested_at,
    row.decided_at,
    row.outbound_requested_at || 0,
    row.outbound_decided_at || null,
    row.inbound_history_deleted_at || null,
    row.last_seen_at,
    row.updated_at,
  )
  return getDeviceRelation(row.id)!
}

export function listDeviceRelations(): DeviceRelationRecord[] {
  purgeHiddenDeviceRelations()

  const db = getDb()
  if (!db) {
    return Object.values(jsonGetAll(DEVICES_TABLE))
      .map(rowToRecord)
      .sort((a, b) => b.updated_at - a.updated_at)
  }

  const rows = db.prepare(`SELECT * FROM ${DEVICES_TABLE} ORDER BY updated_at DESC`).all() as StoredDeviceRow[]
  return rows.map(rowToRecord)
}

export function getDeviceRelation(id: string): DeviceRelationRecord | null {
  const db = getDb()
  if (!db) {
    const row = jsonGet(DEVICES_TABLE, id)
    return row ? rowToRecord(row) : null
  }

  const row = db.prepare(`SELECT * FROM ${DEVICES_TABLE} WHERE id = ?`).get(id) as StoredDeviceRow | undefined
  return row ? rowToRecord(row) : null
}

export function purgeHiddenDeviceRelations(): number {
  const db = getDb()
  if (!db) {
    const rows = jsonGetAll(DEVICES_TABLE)
    let count = 0
    for (const [id, row] of Object.entries(rows)) {
      if (row.inbound_history_deleted_at != null) {
        jsonDelete(DEVICES_TABLE, id)
        count += 1
      }
    }
    return count
  }

  const result = db.prepare(`DELETE FROM ${DEVICES_TABLE} WHERE inbound_history_deleted_at IS NOT NULL`).run()
  return Number(result.changes)
}

export function listPendingInboundRequests(): DeviceRelationRecord[] {
  return listDeviceRelations().filter(device => device.inbound_status === 'pending')
}

export function listInboundRequestHistory(): DeviceRelationRecord[] {
  return listDeviceRelations()
    .filter(device => device.inbound_status !== 'none' && device.inbound_history_deleted_at == null)
    .sort((a, b) => (b.requested_at || b.updated_at) - (a.requested_at || a.updated_at))
}

export function mergeDeviceRelation(device: LanDeviceInfo): DeviceRelationRecord {
  return saveRow(deviceToRow(device, getDeviceRelation(device.id), Date.now()))
}

export function requestInboundDeviceLink(device: LanDeviceInfo): DeviceRelationRecord {
  const now = Date.now()
  const existing = getDeviceRelation(device.id)
  const row = deviceToRow(device, existing, now)

  if (existing?.inbound_status === 'pending') {
    throw new DuplicateDeviceRequestError()
  }

  if (existing?.inbound_status === 'blocked' || existing?.inbound_status === 'approved') {
    return saveRow(row)
  }

  row.status = 'pending'
  row.inbound_status = 'pending'
  row.requested_at = now
  row.decided_at = null
  row.inbound_history_deleted_at = null
  return saveRow(row)
}

export function updateInboundStatus(id: string, status: DeviceInboundStatus, snapshot?: LanDeviceInfo): DeviceRelationRecord {
  const existing = snapshot ? mergeDeviceRelation(snapshot) : getDeviceRelation(id)
  if (!existing) throw new Error('Device not found')
  const now = Date.now()
  const row = deviceToRow(existing, existing, now)
  row.status = status
  row.inbound_status = status
  row.decided_at = status === 'pending' || status === 'none' ? null : now
  if (status === 'pending' && !row.requested_at) row.requested_at = now
  if (status === 'pending') row.inbound_history_deleted_at = null
  return saveRow(row)
}

export function updateOutboundStatus(id: string, status: DeviceOutboundStatus, snapshot: LanDeviceInfo): DeviceRelationRecord {
  const existing = mergeDeviceRelation(snapshot)
  const now = Date.now()
  const row = deviceToRow(existing, existing, now)
  row.outbound_status = status
  if (status === 'pending') {
    row.outbound_requested_at = now
    row.outbound_decided_at = null
  } else {
    row.outbound_decided_at = now
  }
  return saveRow(row)
}

export function deleteDeviceRelation(id: string): boolean {
  const existing = getDeviceRelation(id)
  if (!existing) return false

  const db = getDb()
  if (!db) {
    jsonDelete(DEVICES_TABLE, id)
    return true
  }

  const result = db.prepare(`DELETE FROM ${DEVICES_TABLE} WHERE id = ?`).run(id)
  return result.changes > 0
}
