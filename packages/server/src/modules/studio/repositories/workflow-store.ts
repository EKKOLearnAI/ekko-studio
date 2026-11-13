import { randomUUID } from 'crypto'
import { mkdirSync } from 'fs'
import { getDb, jsonDelete, jsonGet, jsonGetAll, jsonSet } from '../infrastructure/database'
import { WORKFLOWS_TABLE } from '../infrastructure/database/schemas'
import { defaultWorkflowWorkspace, selectWorkspace } from '../services/workspace/manager'

export interface WorkflowRecord {
  id: string
  name: string
  profile: string
  workspace: string | null
  nodes: unknown[]
  edges: unknown[]
  viewport: Record<string, unknown> | null
  created_at: number
  updated_at: number
}

export interface WorkflowCreateInput {
  id?: string
  name: string
  profile?: string | null
  workspace?: string | null
  nodes?: unknown[]
  edges?: unknown[]
  viewport?: Record<string, unknown> | null
}

export interface WorkflowUpdateInput {
  name?: string
  workspace?: string | null
  nodes?: unknown[]
  edges?: unknown[]
  viewport?: Record<string, unknown> | null
}

interface WorkflowRow {
  id: string
  name: string
  profile: string
  workspace: string | null
  nodes_json: string
  edges_json: string
  viewport_json: string
  created_at: number
  updated_at: number
}

function profileName(value?: string | null): string {
  return value?.trim() || 'default'
}

function parseArrayJson(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseObjectJson(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function rowToRecord(row: WorkflowRow | Record<string, any>): WorkflowRecord {
  const raw = row as Record<string, any>
  return {
    id: String(raw.id || ''),
    name: String(raw.name || ''),
    profile: profileName(raw.profile),
    workspace: raw.workspace == null || raw.workspace === '' ? null : String(raw.workspace),
    nodes: parseArrayJson(raw.nodes_json ?? raw.nodes),
    edges: parseArrayJson(raw.edges_json ?? raw.edges),
    viewport: parseObjectJson(raw.viewport_json ?? raw.viewport),
    created_at: Number(raw.created_at || 0),
    updated_at: Number(raw.updated_at || 0),
  }
}

function recordToJsonRow(record: WorkflowRecord): WorkflowRow {
  return {
    id: record.id,
    name: record.name,
    profile: profileName(record.profile),
    workspace: record.workspace,
    nodes_json: JSON.stringify(record.nodes || []),
    edges_json: JSON.stringify(record.edges || []),
    viewport_json: JSON.stringify(record.viewport || {}),
    created_at: record.created_at,
    updated_at: record.updated_at,
  }
}

export function listWorkflows(profile?: string | null): WorkflowRecord[] {
  const db = getDb()
  const normalizedProfile = profile ? profileName(profile) : null
  if (!db) {
    return Object.values(jsonGetAll(WORKFLOWS_TABLE))
      .map(rowToRecord)
      .filter(workflow => !normalizedProfile || workflow.profile === normalizedProfile)
      .sort((a, b) => b.updated_at - a.updated_at)
  }

  const rows = normalizedProfile
    ? db.prepare(`SELECT * FROM ${WORKFLOWS_TABLE} WHERE profile = ? ORDER BY updated_at DESC`).all(normalizedProfile)
    : db.prepare(`SELECT * FROM ${WORKFLOWS_TABLE} ORDER BY updated_at DESC`).all()
  return (rows as unknown as WorkflowRow[]).map(rowToRecord)
}

export function getWorkflow(id: string): WorkflowRecord | null {
  const db = getDb()
  if (!db) {
    const row = jsonGet(WORKFLOWS_TABLE, id)
    return row ? rowToRecord(row) : null
  }

  const row = db.prepare(`SELECT * FROM ${WORKFLOWS_TABLE} WHERE id = ?`).get(id) as WorkflowRow | undefined
  return row ? rowToRecord(row) : null
}

export function createWorkflow(input: WorkflowCreateInput): WorkflowRecord {
  const now = Date.now()
  const id = input.id?.trim() || randomUUID()
  const profile = profileName(input.profile)
  const workspace = selectWorkspace(input.workspace, defaultWorkflowWorkspace(profile, id))
  mkdirSync(workspace, { recursive: true })
  const record: WorkflowRecord = {
    id,
    name: input.name.trim(),
    profile,
    workspace,
    nodes: input.nodes || [],
    edges: input.edges || [],
    viewport: input.viewport || null,
    created_at: now,
    updated_at: now,
  }
  const row = recordToJsonRow(record)
  const db = getDb()
  if (!db) {
    jsonSet(WORKFLOWS_TABLE, record.id, row as any)
    return record
  }

  db.prepare(`
    INSERT INTO ${WORKFLOWS_TABLE} (
      id, name, profile, workspace, nodes_json, edges_json, viewport_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.name,
    row.profile,
    row.workspace,
    row.nodes_json,
    row.edges_json,
    row.viewport_json,
    row.created_at,
    row.updated_at,
  )
  return record
}

export function updateWorkflow(id: string, input: WorkflowUpdateInput): WorkflowRecord | null {
  const existing = getWorkflow(id)
  if (!existing) return null
  const workspace = input.workspace === undefined
    ? existing.workspace
    : selectWorkspace(input.workspace, defaultWorkflowWorkspace(existing.profile, existing.id))
  if (workspace) mkdirSync(workspace, { recursive: true })

  const next: WorkflowRecord = {
    ...existing,
    name: input.name === undefined ? existing.name : input.name.trim(),
    workspace,
    nodes: input.nodes === undefined ? existing.nodes : input.nodes,
    edges: input.edges === undefined ? existing.edges : input.edges,
    viewport: input.viewport === undefined ? existing.viewport : input.viewport,
    updated_at: Date.now(),
  }
  const row = recordToJsonRow(next)
  const db = getDb()
  if (!db) {
    jsonSet(WORKFLOWS_TABLE, id, row as any)
    return next
  }

  db.prepare(`
    UPDATE ${WORKFLOWS_TABLE}
    SET name = ?, workspace = ?, nodes_json = ?, edges_json = ?, viewport_json = ?, updated_at = ?
    WHERE id = ?
  `).run(
    row.name,
    row.workspace,
    row.nodes_json,
    row.edges_json,
    row.viewport_json,
    row.updated_at,
    id,
  )
  return next
}

export function deleteWorkflow(id: string): boolean {
  const existing = getWorkflow(id)
  if (!existing) return false

  const db = getDb()
  if (!db) {
    jsonDelete(WORKFLOWS_TABLE, id)
    return true
  }

  const result = db.prepare(`DELETE FROM ${WORKFLOWS_TABLE} WHERE id = ?`).run(id)
  return Number(result.changes || 0) > 0
}

export function deleteWorkflows(ids: string[]): { deleted: string[]; missing: string[] } {
  const deleted: string[] = []
  const missing: string[] = []
  for (const id of ids) {
    if (deleteWorkflow(id)) deleted.push(id)
    else missing.push(id)
  }
  return { deleted, missing }
}
