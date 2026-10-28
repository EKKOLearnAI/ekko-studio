import type { AgentMessage } from '../../../../../ekko-agent/src/model/types'

export type PersonRole = 'main' | 'coordinator'
export type PersonRunState = 'queued' | 'starting' | 'stopping' | 'running' | 'waiting_person' | 'waiting_user' | 'waiting_approval' | 'finished' | 'failed' | 'interrupted'
export interface PersonSelection {
  runtime: string
  mode: 'scoped' | 'global'
  profile: string
  provider: string
  model: string
  apiMode?: string
  reasoningEffort?: string
}
export interface PersonAgentPreset {
  id: string
  name: string
  description: string
  selection: PersonSelection
}
export interface PersonTaskOrigin {
  sessionId: string
  runId: string
  messages: AgentMessage[]
}
export interface PersonSettings {
  workspace: string
  model: PersonSelection | null
  reasoningEffort: string
  timezone: string
  maxSteps: number
  compressionThreshold: number | null
  agents: PersonAgentPreset[]
  maxConcurrentTasks: number
}
export interface PersonTask {
  id: string
  owner_user_id: number
  bot_id: string
  title: string
  summary: string
  status: 'open' | 'completed' | 'closed'
  revision: number
  requirements_revision: number
  requirements_json: string
  selection_json: string
  workspace: string
  completion_evidence: string
  created_at: number
  updated_at: number
  running?: boolean | number
  execution_id?: string | null
  execution_state?: PersonRunState | 'idle'
}
export interface PersonExecution {
  id: string; task_id: string; owner_user_id: number; requirements_revision: number
  state: PersonRunState; input_json: string; session_id: string; selection_json: string; output: string
  error: string; generation: number
  lease_until: number; created_at: number; updated_at: number; occurrence_id: string | null
}
export interface PersonInteraction {
  id: string; owner_user_id: number; task_id: string; execution_id: string
  native_id: string; kind: 'question' | 'approval'; question: string; choices_json: string
  state: 'pending' | 'answered' | 'expired'; answer: string; answered_by: string
  revision: number; created_at: number
}
export interface PersonSchedule {
  id: string; owner_user_id: number; task_id: string; kind: 'once' | 'cron'; expression: string
  timezone: string; next_at: number; state: 'active' | 'paused' | 'cancelled' | 'exhausted'
  revision: number; misfire: 'skip' | 'run_latest'; created_at: number
}
export const PERSON_DEFAULTS: PersonSettings = {
  model: null, reasoningEffort: '', timezone: 'Asia/Shanghai', maxSteps: 12,
  agents: [], maxConcurrentTasks: 2, compressionThreshold: null, workspace: '',
}
export function personError(message: string, status = 400): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}
export function personText(value: unknown, name: string, max = 4000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw personError(`Invalid ${name}`)
  return value.trim()
}
export function personRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw personError('expected_revision is required')
  return Number(value)
}
