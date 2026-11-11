import type { SessionSummary } from './studio/sessions'
import { request } from './client'
import type { AvailableModelGroup } from './hermes/system'
import type { ProviderApiMode } from './studio/provider-api-mode'
import { clientUuid } from '../utils/secure-uuid'
import type { TaskPlanSnapshot } from '../utils/task-plan'
export interface PersonModel { profile: string; provider: string; model: string; apiMode?: ProviderApiMode }
export interface PersonModelGroup extends Pick<AvailableModelGroup, 'provider' | 'label' | 'models' | 'model_meta' | 'api_mode' | 'api_mode_by_model'> { profile: string }
export interface PersonAgentPreset { id: string; name: string; description: string; selection: PersonModel & { runtime: string; mode: 'scoped' | 'global'; reasoningEffort: string } }
export interface PersonTask { activity_running?: boolean | number; redirect_state?: string | null; redirect_error?: string | null; requirements_json?: string; acceptance_state?: string | null; acceptance_reason?: string | null; session_id: string; session_title?: string; updated_at: number; selection_json: string; execution_selection_json?: string | null; id: string; title: string; summary: string; status: string; revision: number; execution_id?: string | null; execution_state: string; running: boolean | number; completion_evidence: string }
export interface PersonExecutionSummary { id: string; session_id: string; state: string; created_at: number; occurrence_id?: string | null }
export interface PersonTaskQueueState { protectedQueueId?: string; canInsert?: boolean; canRemove?: boolean; insertion?: { queueId: string; phase: string } | null; insertionError?: string }
export interface PersonTaskQueueSnapshot extends PersonTaskQueueState { task: PersonTask; pending: { id: string; input: { type: string; text?: string; name?: string }[] }[] }
export interface PersonSchedule { id: string; mode: 'assistant' | 'worker'; task_id: string | null; session_id: string; session_title?: string | null; bot_type?: string | null; task_title?: string | null; task_goal?: string | null; title: string; goal: string; expression: string; timezone: string; next_at: number; state: string; revision: number }
export interface PersonMemory { id: string; content: string; revision: number }
export interface PersonQuestion { id: string; task_id: string | null; question: string; kind: string; choices_json: string; revision: number }
export interface PersonTaskReturn { taskId: string; executionId: string; assistantMessageId: string; title: string; summary: string; agent: string; state: 'finished' | 'failed'; relatedTasks?: PersonTaskReturn[] }
export interface PersonGeneralSettings { compressionThreshold: number | null; maxSteps: number; maxConcurrentTasks: number; taskTimeoutMinutes: number; timezone: string }
export interface PersonFlow {
  timeline_at?: number | null
  created_at?: number; updated_at?: number
  creator_session_title?: string | null; creator_bot_type?: string | null
  round_number?: number; round_limit?: number
  creator_session_id?: string
  id: string; title: string; goal: string; revision: number; state: 'active' | 'failed' | 'stopped' | 'completed'; current_position: number; error: string
  stages: Array<{ confirmation?: {decision_pending?: boolean; state: string; attempts: number; reason: string; message_id: number | null}; id: string; position: number; group_position: number; session_id: string; session_title?: string; bot_type?: string | null; delivery_state?: string; delivery_error?: string; goal: string; state: 'pending' | 'active' | 'failed' | 'completed'; result_message_id: number | null; tasks: Array<{ id: string; title: string; status: string; execution_state?: string; agent?: string }> }>
}
export interface PersonFlowMessage {
  id: number; session_id: string; session_title: string; bot_type: string | null
  stage_id: string; round_number: number | null; role: 'user' | 'assistant'; content: string; timestamp: number
  run_marker?: string | null; person_task_return?: PersonTaskReturn
}
export interface PersonFlowSnapshot {
  cards?: PersonFlow[]
  card_updates?: PersonTimelineItem[]
  timeline?: PersonTimeline
  flows: PersonFlow[]
  active_flows: PersonFlow[]
  active_flow_count: number
  history_cleared_at: number
}
export interface PersonTimelineItem { id: string; kind: 'message' | 'flow'; timestamp: number; cursor: string }
export interface PersonTimeline {
  items: PersonTimelineItem[]
  before: string | null
  has_more: boolean
  history_revision: number
  reset?: boolean
  has_newer?: boolean
}
export interface PersonFlowConversation {
  flow: PersonFlow; messages: PersonFlowMessage[]; has_more: boolean; next_before_id: number | null; history_key: string
  taskPlans?: TaskPlanSnapshot[]
  oldest_message_id?: number | null
}
export function fetchPersonFlowConversation(flowId: string, beforeId?: number, signal?: AbortSignal) {
  return personRequest<PersonFlowConversation>(`/flows/${encodeURIComponent(flowId)}/messages${beforeId ? `?before_id=${beforeId}` : ''}`,undefined,'GET',signal)
}
export interface PersonSnapshot {
  active_tasks?: PersonTask[]
  active_agent_task_count?: number
  session: SessionSummary | null
  settings: PersonGeneralSettings & { model: PersonModel | null; reasoningEffort: string; agents: PersonAgentPreset[]; workspace: string }; revision: number; busy: boolean
  history_revision: number; can_clear: boolean
  inherits_global_model: boolean; reasoning_efforts: string[]
  compression: { enabled: boolean; threshold: number; globalThreshold: number }
  contextTokens: number
  tasks: PersonTask[]; schedules: PersonSchedule[]; memories: PersonMemory[]; interactions: PersonQuestion[]; flows?: PersonFlow[]; active_flows?: PersonFlow[]; active_flow_count?: number
}
export function personRequest<T>(path = '', body?: unknown, method = 'POST', signal?: AbortSignal) {
  return request<T>(`/api/studio/person${path}`, body === undefined ? { signal } : { method, body: JSON.stringify(body), signal })
}
export function personTaskCanStop(task?: PersonTask | null) {
  return !!task?.execution_id && ['pending','queued','starting','running','waiting_person','waiting_user','waiting_approval','stopping'].includes(task.execution_state)
}
export function stopPersonTask(task: PersonTask, signal?: AbortSignal) {
  return personRequest<{ task: PersonTask }>('/tasks/apply', { action: 'stop', task_id: task.id,
    execution_id: task.execution_id, expected_revision: task.revision, idempotency_key: clientUuid() }, 'POST', signal)
}
export function removePersonTaskMessage(task: PersonTask, queueId: string, signal?: AbortSignal) {
  return personRequest<PersonTaskQueueSnapshot>(`/tasks/${encodeURIComponent(task.id)}/queue/remove`, {
    queue_id: queueId, expected_execution_id: task.execution_id, expected_revision: task.revision, idempotency_key: clientUuid(),
  }, 'POST', signal)
}

export interface PersonAcceptanceDetail {
  state: string; attempt: number; reason: string; snapshot: unknown;
  attempts: Array<{ id: string; ordinal: number; state: string; session_id: string; run_id: string; report: unknown; evidence: unknown; error: string }>
}
