import type { Message } from '@/stores/hermes/chat'

export interface TaskPlanSnapshot {
  session_id: string
  run_id: string
  plan_id: string
  revision: number
  execution_state: 'running' | 'ended' | 'interrupted' | 'failed'
  explanation?: string
  plan: Array<{ id: string; step: string; status: 'pending' | 'in_progress' | 'completed' }>
  created_at: number
  updated_at: number
}

export function parseTaskPlan(value: unknown): TaskPlanSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const p = value as TaskPlanSnapshot
  if (![p.session_id, p.run_id, p.plan_id].every(id => typeof id === 'string' && id.length > 0)) return null
  if (!Number.isSafeInteger(p.revision) || p.revision < 1 || !Number.isFinite(p.created_at) || !Number.isFinite(p.updated_at)) return null
  if (!['running', 'ended', 'interrupted', 'failed'].includes(p.execution_state)) return null
  if (p.explanation !== undefined && typeof p.explanation !== 'string') return null
  if (!Array.isArray(p.plan) || p.plan.length < 1 || p.plan.length > 30) return null
  const ids = new Set<string>()
  for (const step of p.plan) {
    if (!step || typeof step.id !== 'string' || !step.id.trim() || ids.has(step.id)) return null
    if (typeof step.step !== 'string' || !step.step.trim() || step.step.length > 200) return null
    if (!['pending', 'in_progress', 'completed'].includes(step.status)) return null
    ids.add(step.id)
  }
  return p
}

/** Keep a single card per plan across stream replay and paginated history. */
export function mergeTaskPlanMessages(messages: Message[], plans: unknown[], sessionId?: string): Message[] {
  const result = [...messages]
  for (const raw of plans) {
    const plan = parseTaskPlan(raw)
    if (!plan || (sessionId && plan.session_id !== sessionId)) continue
    const id = `task-plan:${plan.session_id}:${plan.plan_id}`
    const existing = result.findIndex(message => message.id === id)
    if (existing >= 0 && (result[existing].taskPlan?.revision ?? 0) >= plan.revision) continue
    const message: Message = {
      id, role: 'system', content: '', timestamp: plan.created_at,
      runMarker: plan.run_id, taskPlan: plan,
    }
    if (existing >= 0) {
      result[existing] = message
    } else {
      let index = result.findIndex(item => item.runMarker === plan.run_id && item.role !== 'user' && item.role !== 'command')
      if (index < 0) index = result.findIndex(item => item.timestamp > plan.created_at)
      result.splice(index < 0 ? result.length : index, 0, message)
    }
  }
  return result
}

/** Display plans after their turn without changing the chronological source messages. */
export function positionTaskPlansAtTurnEnd(messages: Message[]): Message[] {
  const cards = messages.filter(message => message.taskPlan)
  if (!cards.length) return messages
  const content = messages.filter(message => !message.taskPlan)
  const runEnds = new Map<string, number>()
  const nextTurn = new Array<number>(content.length + 1).fill(content.length)
  const nextMarkedMessage = new Array<number>(content.length + 1).fill(content.length)
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const message = content[index]
    const runId = message.runMarker?.trim()
    if (runId && !runEnds.has(runId)) runEnds.set(runId, index + 1)
    const startsTurn = message.role === 'user' || message.role === 'command'
    nextTurn[index] = startsTurn ? index : nextTurn[index + 1]
    nextMarkedMessage[index] = startsTurn || runId ? index : nextMarkedMessage[index + 1]
  }
  const slots = new Map<number, Message[]>()
  for (const card of cards) {
    const plan = card.taskPlan!
    let index = runEnds.get(plan.run_id)
    if (index !== undefined) {
      // Include trailing output from older servers that omitted a run marker.
      index = nextMarkedMessage[index]
    } else {
      // Legacy history can lack run IDs. Use creation time, never update time,
      // so a late plan update cannot move an old card into a newer user turn.
      index = content.findIndex(message => typeof message.timestamp === 'number' && message.timestamp > plan.created_at)
      index = index < 0 ? content.length : nextTurn[index]
    }
    const atEnd = slots.get(index) || []
    atEnd.push(card)
    slots.set(index, atEnd)
  }
  const result: Message[] = []
  for (let index = 0; index <= content.length; index += 1) {
    result.push(...(slots.get(index) || []))
    if (index < content.length) result.push(content[index])
  }
  return result
}
