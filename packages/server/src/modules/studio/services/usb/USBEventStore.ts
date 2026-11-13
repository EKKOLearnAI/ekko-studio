import { randomUUID } from 'crypto'
import { getDb, jsonDelete, jsonGetAll, jsonSet } from '../../infrastructure/database/index'
import { USB_EVENTS_TABLE } from '../../infrastructure/database/schemas'
import type { USBEventRecord, USBMonitorDeviceEvent } from './USBDevice'

type StoredUSBEventRow = {
  id: string
  uuid: string
  device_node: string
  action: 'add' | 'remove'
  mount_point: string | null
  fs_type: string | null
  label: string | null
  status: string
  error: string | null
  ts: number
}

function rowToRecord(row: StoredUSBEventRow | Record<string, unknown>): USBEventRecord {
  return {
    id: String(row.id || ''),
    uuid: String(row.uuid || ''),
    deviceNode: String(row.device_node || ''),
    action: row.action === 'remove' ? 'remove' : 'add',
    mountPoint: row.mount_point == null ? null : String(row.mount_point),
    fsType: row.fs_type == null ? null : String(row.fs_type),
    label: row.label == null ? null : String(row.label),
    status: String(row.status || ''),
    error: row.error == null ? null : String(row.error),
    ts: Number(row.ts || 0),
  }
}

function monitorEventToRow(event: USBMonitorDeviceEvent): StoredUSBEventRow {
  return {
    id: randomUUID(),
    uuid: String(event.uuid || ''),
    device_node: String(event.device_node || ''),
    action: event.action,
    mount_point: event.mount_point == null ? null : String(event.mount_point),
    fs_type: event.fs_type == null ? null : String(event.fs_type),
    label: event.label == null ? null : String(event.label),
    status: String(event.status || ''),
    error: event.error == null ? null : String(event.error),
    ts: Number(Date.parse(event.ts || '')) || Date.now(),
  }
}

export class USBEventStore {
  persist(event: USBMonitorDeviceEvent): USBEventRecord {
    const row = monitorEventToRow(event)
    const db = getDb()
    if (!db) {
      jsonSet(USB_EVENTS_TABLE, row.id, row as unknown as Record<string, unknown>)
      return rowToRecord(row)
    }

    db.prepare(`
      INSERT INTO ${USB_EVENTS_TABLE} (
        id, uuid, device_node, action, mount_point, fs_type, label, status, error, ts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.uuid,
      row.device_node,
      row.action,
      row.mount_point,
      row.fs_type,
      row.label,
      row.status,
      row.error,
      row.ts,
    )
    return rowToRecord(row)
  }

  listSince(sinceTs: number): USBEventRecord[] {
    const db = getDb()
    if (!db) {
      return Object.values(jsonGetAll(USB_EVENTS_TABLE))
        .map(row => rowToRecord(row))
        .filter(row => row.ts >= sinceTs)
        .sort((a, b) => b.ts - a.ts)
    }

    const rows = db.prepare(`
      SELECT * FROM ${USB_EVENTS_TABLE}
      WHERE ts >= ?
      ORDER BY ts DESC
    `).all(sinceTs) as StoredUSBEventRow[]
    return rows.map(rowToRecord)
  }

  deleteBefore(cutoffTs: number): number {
    const db = getDb()
    if (!db) {
      const existing = jsonGetAll(USB_EVENTS_TABLE)
      let removed = 0
      for (const [id, row] of Object.entries(existing)) {
        if (Number(row.ts || 0) < cutoffTs) {
          jsonDelete(USB_EVENTS_TABLE, id)
          removed += 1
        }
      }
      return removed
    }

    const result = db.prepare(`DELETE FROM ${USB_EVENTS_TABLE} WHERE ts < ?`).run(cutoffTs)
    return Number(result.changes || 0)
  }
}
