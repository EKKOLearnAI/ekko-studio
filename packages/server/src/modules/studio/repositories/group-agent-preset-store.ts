import { randomUUID } from 'node:crypto'
import { getDb } from '../infrastructure/database'
import { GC_AGENT_PRESETS_TABLE } from '../infrastructure/database/schemas'

export type GroupAgentPresetAgent = 'hermes' | 'ekko' | 'codex' | 'claude' | 'pi' | 'grok' | 'opencode' | 'dsh' | 'cursor'
export const GROUP_AGENT_PRESET_NAME_CONFLICT = 'GROUP_AGENT_PRESET_NAME_CONFLICT'

export interface GroupAgentPresetRecord {
  id: string
  ownerUserId: number
  agent: GroupAgentPresetAgent
  agentMode: 'scoped' | 'global'
  profile: string
  provider: string
  model: string
  apiMode: string
  agentPreset?: string
  reasoningEffort: string
  name: string
  description: string
  avatar: string
  createdAt: number
  updatedAt: number
}

export type GroupAgentPresetDefinition = Omit<GroupAgentPresetRecord, 'id' | 'createdAt' | 'updatedAt' | 'agentMode'> & {
  agentMode?: 'scoped' | 'global'
}

function rethrowGroupAgentPresetWriteError(error: any): never {
  const message = String(error?.message || '')
  const isNameConflict = (
    error?.code === 'SQLITE_CONSTRAINT_UNIQUE'
    || error?.code === 'ERR_SQLITE_ERROR'
  ) && message.includes(`UNIQUE constraint failed: ${GC_AGENT_PRESETS_TABLE}.ownerUserId, ${GC_AGENT_PRESETS_TABLE}.name`)
  if (isNameConflict) {
    throw Object.assign(new Error('Agent preset already exists'), {
      status: 409,
      code: GROUP_AGENT_PRESET_NAME_CONFLICT,
    })
  }
  throw error
}

function row(value: any): GroupAgentPresetRecord {
  return {
    id: String(value.id),
    ownerUserId: Number(value.ownerUserId),
    agent: String(value.agent || 'hermes') as GroupAgentPresetAgent,
    agentMode: value.agentMode === 'global' ? 'global' : 'scoped',
    profile: String(value.profile),
    provider: String(value.provider),
    model: String(value.model),
    apiMode: String(value.apiMode || ''),
    reasoningEffort: String(value.reasoningEffort || ''),
    agentPreset: value.agentPreset || undefined,
    name: String(value.name),
    description: String(value.description || ''),
    avatar: String(value.avatar || ''),
    createdAt: Number(value.createdAt),
    updatedAt: Number(value.updatedAt),
  }
}

export function listGroupAgentPresets(ownerUserId: number): GroupAgentPresetRecord[] {
  const db = getDb()
  if (!db) return []
  return (db.prepare(
    `SELECT * FROM ${GC_AGENT_PRESETS_TABLE} WHERE ownerUserId = ? ORDER BY updatedAt DESC, name ASC`,
  ).all(ownerUserId) as any[]).map(row)
}

export function getGroupAgentPreset(id: string, ownerUserId: number): GroupAgentPresetRecord | null {
  const db = getDb()
  if (!db) return null
  const value = db.prepare(
    `SELECT * FROM ${GC_AGENT_PRESETS_TABLE} WHERE id = ? AND ownerUserId = ?`,
  ).get(id, ownerUserId)
  return value ? row(value) : null
}

export function createGroupAgentPreset(input: GroupAgentPresetDefinition): GroupAgentPresetRecord {
  const db = getDb()
  if (!db) throw new Error('Database is not initialized')
  const now = Date.now()
  const value: GroupAgentPresetRecord = {
    ...input,
    agentMode: input.agentMode === 'global' ? 'global' : 'scoped',
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
  }
  try {
    db.prepare(
      `INSERT INTO ${GC_AGENT_PRESETS_TABLE}
        (id, ownerUserId, agent, agentMode, profile, provider, model, apiMode, reasoningEffort, agentPreset, name, description, avatar, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      value.id, value.ownerUserId, value.agent, value.agentMode, value.profile, value.provider, value.model,
      value.apiMode, value.reasoningEffort, value.agentPreset || '', value.name, value.description, value.avatar,
      value.createdAt, value.updatedAt,
    )
  } catch (error) {
    rethrowGroupAgentPresetWriteError(error)
  }
  return value
}

export function updateGroupAgentPreset(
  id: string,
  ownerUserId: number,
  input: GroupAgentPresetDefinition,
): GroupAgentPresetRecord | null {
  const db = getDb()
  if (!db || !getGroupAgentPreset(id, ownerUserId)) return null
  const updatedAt = Date.now()
  try {
    db.prepare(
      `UPDATE ${GC_AGENT_PRESETS_TABLE}
       SET agent = ?, agentMode = ?, profile = ?, provider = ?, model = ?, apiMode = ?, reasoningEffort = ?, agentPreset = ?,
           name = ?, description = ?, avatar = ?, updatedAt = ?
       WHERE id = ? AND ownerUserId = ?`,
    ).run(
      input.agent, input.agentMode === 'global' ? 'global' : 'scoped', input.profile, input.provider, input.model, input.apiMode,
      input.reasoningEffort, input.agentPreset || '', input.name, input.description, input.avatar, updatedAt,
      id, ownerUserId,
    )
  } catch (error) {
    rethrowGroupAgentPresetWriteError(error)
  }
  return getGroupAgentPreset(id, ownerUserId)
}

export function deleteGroupAgentPreset(id: string, ownerUserId: number): boolean {
  const db = getDb()
  if (!db) return false
  return db.prepare(
    `DELETE FROM ${GC_AGENT_PRESETS_TABLE} WHERE id = ? AND ownerUserId = ?`,
  ).run(id, ownerUserId).changes > 0
}
