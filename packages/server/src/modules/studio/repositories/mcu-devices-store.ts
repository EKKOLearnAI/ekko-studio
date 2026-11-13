import { getDb, jsonDelete, jsonGetAll, jsonSet } from '../infrastructure/database'
import { MCU_DEVICES_TABLE } from '../infrastructure/database/schemas'

export interface McuDeviceRecord {
  id: number
  name: string
  device_code: string
  is_official: boolean
  created_at: number
}

interface StoredMcuDeviceRow {
  id: number
  name: string
  device_code: string
  is_official: number
  created_at: number
}

function rowToRecord(row: StoredMcuDeviceRow | Record<string, any>): McuDeviceRecord {
  return {
    id: Number(row.id),
    name: String(row.name || ''),
    device_code: String(row.device_code || ''),
    is_official: Number(row.is_official || 0) === 1,
    created_at: Number(row.created_at || 0),
  }
}

export function listMcuDevices(): McuDeviceRecord[] {
  const db = getDb()
  if (!db) {
    return Object.values(jsonGetAll(MCU_DEVICES_TABLE))
      .map(rowToRecord)
      .sort((a, b) => b.created_at - a.created_at)
  }

  const rows = db.prepare(`SELECT * FROM ${MCU_DEVICES_TABLE} ORDER BY created_at DESC, id DESC`).all() as unknown as StoredMcuDeviceRow[]
  return rows.map(rowToRecord)
}

export function getMcuDevice(id: number): McuDeviceRecord | null {
  const db = getDb()
  if (!db) {
    const row = jsonGetAll(MCU_DEVICES_TABLE)[String(id)]
    return row ? rowToRecord(row) : null
  }

  const row = db.prepare(`SELECT * FROM ${MCU_DEVICES_TABLE} WHERE id = ?`).get(id) as unknown as StoredMcuDeviceRow | undefined
  return row ? rowToRecord(row) : null
}

export function createMcuDevice(input: {
  name: string
  deviceCode: string
  isOfficial: boolean
}): McuDeviceRecord {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const name = input.name.trim()
  const deviceCode = input.deviceCode.trim()
  const isOfficial = input.isOfficial ? 1 : 0

  if (!db) {
    const existing = Object.values(jsonGetAll(MCU_DEVICES_TABLE))
      .map(rowToRecord)
      .find(record => record.device_code === deviceCode)
    if (existing) throw new Error('mcu_device_exists')
    const id = Date.now()
    const row = { id, name, device_code: deviceCode, is_official: isOfficial, created_at: now }
    jsonSet(MCU_DEVICES_TABLE, String(id), row as any)
    return rowToRecord(row)
  }

  try {
    const result = db.prepare(`
      INSERT INTO ${MCU_DEVICES_TABLE} (name, device_code, is_official, created_at)
      VALUES (?, ?, ?, ?)
    `).run(name, deviceCode, isOfficial, now)

    const id = Number(result.lastInsertRowid)
    const row = db.prepare(`SELECT * FROM ${MCU_DEVICES_TABLE} WHERE id = ?`).get(id) as unknown as StoredMcuDeviceRow
    return rowToRecord(row)
  } catch (error: any) {
    if (String(error?.message || '').toLowerCase().includes('unique')) {
      throw new Error('mcu_device_exists')
    }
    throw error
  }
}

export function updateMcuDeviceName(id: number, name: string): McuDeviceRecord {
  const db = getDb()
  const normalizedName = name.trim().slice(0, 80)

  if (!db) {
    const rows = jsonGetAll(MCU_DEVICES_TABLE)
    const row = rows[String(id)]
    if (!row) throw new Error('mcu_device_not_found')
    const next = { ...row, name: normalizedName || String(row.device_code || '') }
    jsonSet(MCU_DEVICES_TABLE, String(id), next as any)
    return rowToRecord(next)
  }

  const existing = db.prepare(`SELECT * FROM ${MCU_DEVICES_TABLE} WHERE id = ?`).get(id) as unknown as StoredMcuDeviceRow | undefined
  if (!existing) throw new Error('mcu_device_not_found')

  db.prepare(`UPDATE ${MCU_DEVICES_TABLE} SET name = ? WHERE id = ?`).run(normalizedName || existing.device_code, id)
  const row = db.prepare(`SELECT * FROM ${MCU_DEVICES_TABLE} WHERE id = ?`).get(id) as unknown as StoredMcuDeviceRow
  return rowToRecord(row)
}

export function deleteMcuDevice(id: number): boolean {
  const db = getDb()
  if (!db) {
    const rows = jsonGetAll(MCU_DEVICES_TABLE)
    if (!rows[String(id)]) return false
    jsonDelete(MCU_DEVICES_TABLE, String(id))
    return true
  }

  const result = db.prepare(`DELETE FROM ${MCU_DEVICES_TABLE} WHERE id = ?`).run(id)
  return Number(result.changes) > 0
}
