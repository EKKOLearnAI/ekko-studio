import { createHash } from 'node:crypto'
import type { TaskPlanSnapshot } from '../../contracts/task-plan'
import { parseTaskPlanUpdate } from '../task-plan-runs'

/** Task cards use the existing persisted group message transport, including remote relays. */
export function parseGroupTaskPlan(value: unknown): TaskPlanSnapshot | null {
    try {
        const p = (typeof value === 'string' ? JSON.parse(value) : value) as TaskPlanSnapshot
        if (!p || ![p.session_id, p.run_id, p.plan_id].every(id => typeof id === 'string' && id.length > 0 && id.length <= 500)) return null
        if (!Number.isSafeInteger(p.revision) || p.revision < 1 || !Number.isFinite(p.created_at) || !Number.isFinite(p.updated_at)) return null
        if (!['running', 'ended', 'interrupted', 'failed'].includes(p.execution_state)) return null
        return { ...p, ...parseTaskPlanUpdate(p as unknown as Record<string, unknown>) }
    } catch { return null }
}

export function groupTaskPlanMessage(roomId: string, sessionId: string, runId: string, value: unknown) {
    const snapshot = parseGroupTaskPlan(value)
    if (!snapshot || snapshot.session_id !== sessionId) return null
    const id = 'gcplan_' + createHash('sha256').update(JSON.stringify([roomId, sessionId, snapshot.plan_id])).digest('hex')
    const plan = { ...snapshot, run_id: runId }
    return { id, content: JSON.stringify(plan), extra: {
        role: 'tool', tool_name: 'task_plan', tool_call_id: id,
        run_id: runId, timestamp: plan.created_at,
    } }
}
