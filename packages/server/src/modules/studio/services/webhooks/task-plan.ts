import type { TaskPlanSnapshot } from '../../contracts/task-plan'
import { parseTaskPlanUpdate } from '../task-plan-runs'

export interface WebhookTaskPlan extends Omit<TaskPlanSnapshot, 'plan'> {
  plan: Array<{ id: string; status: 'pending' | 'in_progress' | 'completed'; step?: string }>
  progress: { total: number; completed: number; in_progress: number; pending: number; percent: number }
}

const publishedRevisions = new Map<string, number>()
export function acceptTaskPlanRevision(scope: string, plan: WebhookTaskPlan): boolean {
  const key = JSON.stringify([scope, plan.session_id, plan.run_id, plan.plan_id])
  if ((publishedRevisions.get(key) || 0) >= plan.revision) return false
  publishedRevisions.set(key, plan.revision)
  if (publishedRevisions.size > 2000) publishedRevisions.delete(publishedRevisions.keys().next().value!)
  return true
}

/** Select only task-card fields; raw runtime/MCP payloads may contain credentials. */
export function taskPlanWebhookSnapshot(value: unknown, sessionId?: string): WebhookTaskPlan | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const p = value as TaskPlanSnapshot
    if (![p.session_id, p.run_id, p.plan_id].every(id => typeof id === 'string' && id.length > 0 && id.length <= 500)
      || sessionId !== undefined && p.session_id !== sessionId
      || !Number.isSafeInteger(p.revision) || p.revision < 1
      || !Number.isFinite(p.created_at) || p.created_at <= 0 || !Number.isFinite(p.updated_at) || p.updated_at < p.created_at
      || !Number.isFinite(new Date(p.created_at).getTime()) || !Number.isFinite(new Date(p.updated_at).getTime())
      || !['running', 'ended', 'interrupted', 'failed'].includes(p.execution_state)) return null
    const update = parseTaskPlanUpdate(p as unknown as Record<string, unknown>)
    const total = update.plan.length
    const completed = update.plan.filter(step => step.status === 'completed').length
    const inProgress = update.plan.filter(step => step.status === 'in_progress').length
    return { session_id: p.session_id, run_id: p.run_id, plan_id: p.plan_id, revision: p.revision,
      execution_state: p.execution_state, created_at: p.created_at, updated_at: p.updated_at, ...update,
      progress: { total, completed, in_progress: inProgress, pending: total - completed - inProgress, percent: Math.floor(completed * 100 / total) } }
  } catch { return null }
}

export function taskPlanWebhookContent(plan: WebhookTaskPlan, includeContent: boolean): WebhookTaskPlan {
  const { explanation, ...metadata } = plan
  return { ...metadata, ...(includeContent && explanation !== undefined ? { explanation } : {}),
    plan: plan.plan.map(({ id, status, step }) => ({ id, status, ...(includeContent ? { step } : {}) })) }
}
