import type { SessionSummary } from './studio/sessions'
import { request } from './client'
import type { AvailableModelGroup } from './hermes/system'
export interface PersonModel { profile: string; provider: string; model: string }
export interface PersonModelGroup extends Pick<AvailableModelGroup, 'provider' | 'label' | 'models' | 'model_meta'> { profile: string }
export interface PersonAgentPreset { id: string; name: string; description: string; selection: PersonModel & { runtime: string; mode: 'scoped' | 'global'; reasoningEffort: string } }
export interface PersonTask { updated_at: number; selection_json: string; id: string; title: string; summary: string; status: string; revision: number; execution_id?: string | null; execution_state: string; running: boolean | number; completion_evidence: string }
export interface PersonSchedule { id: string; task_id: string; expression: string; timezone: string; next_at: number; state: string; revision: number }
export interface PersonMemory { id: string; content: string; revision: number }
export interface PersonQuestion { id: string; task_id: string | null; question: string; kind: string; choices_json: string; revision: number }
export interface PersonTaskReturn { taskId: string; executionId: string; assistantMessageId: string; title: string; summary: string; agent: string; state: 'finished' | 'failed' }
export interface PersonGeneralSettings { compressionThreshold: number | null; maxSteps: number; maxConcurrentTasks: number; timezone: string }
export interface PersonSnapshot {
  session: SessionSummary
  settings: PersonGeneralSettings & { model: PersonModel | null; reasoningEffort: string; agents: PersonAgentPreset[]; workspace: string }; revision: number; busy: boolean
  history_revision: number; can_clear: boolean
  inherits_global_model: boolean; reasoning_efforts: string[]
  compression: { enabled: boolean; threshold: number; globalThreshold: number }
  contextTokens: number
  tasks: PersonTask[]; schedules: PersonSchedule[]; memories: PersonMemory[]; interactions: PersonQuestion[]
}
export function personRequest<T>(path = '', body?: unknown, method = 'POST', signal?: AbortSignal) {
  return request<T>(`/api/studio/person${path}`, body === undefined ? { signal } : { method, body: JSON.stringify(body), signal })
}
export function personTaskCanStop(task?: PersonTask | null) {
  return !!task?.execution_id && ['queued','starting','running','waiting_person','waiting_user','waiting_approval','stopping'].includes(task.execution_state)
}
export function stopPersonTask(task: PersonTask, signal?: AbortSignal) {
  return personRequest<{ task: PersonTask }>('/tasks/apply', { action: 'stop', task_id: task.id,
    execution_id: task.execution_id, expected_revision: task.revision, idempotency_key: crypto.randomUUID() }, 'POST', signal)
}
