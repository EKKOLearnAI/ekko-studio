import type { SubagentStream } from '@/stores/hermes/chat'

export const OPEN_SUBAGENT_STREAM_EVENT = 'hermes:open-subagent-stream'

export interface OpenSubagentStreamDetail {
  sessionId: string
  subagentId: string
}

export function subagentIdFromToolCall(toolCallId?: string): string | null {
  const prefix = 'subagent:'
  if (!toolCallId?.startsWith(prefix)) return null
  const subagentId = toolCallId.slice(prefix.length).trim()
  return subagentId || null
}

export function openSubagentStream(sessionId: string | null | undefined, toolCallId?: string): boolean {
  const subagentId = subagentIdFromToolCall(toolCallId)
  if (!sessionId || !subagentId || typeof window === 'undefined') return false
  window.dispatchEvent(new CustomEvent<OpenSubagentStreamDetail>(OPEN_SUBAGENT_STREAM_EVENT, {
    detail: { sessionId, subagentId },
  }))
  return true
}

// 批次号：同一 run_id（一次 delegate_task 派发的一批子任务）在 session 内按首次出现顺序编号（1,2,3…）。
// 跨批次的 i/M 会重复（第一批 1/1、第二批 1/3、2/3、3/3），加批次号才能区分是哪一批。
export function subagentBatchNumber(streams: SubagentStream[], sessionId: string, runId?: string): number | null {
  if (!runId) return null
  const groups = new Map<string, number>()
  for (const s of streams) {
    if (s.sessionId !== sessionId || !s.runId) continue
    groups.set(s.runId, Math.min(groups.get(s.runId) ?? Number.MAX_SAFE_INTEGER, s.startedAt))
  }
  const sorted = [...groups.entries()].sort((a, b) => a[1] - b[1])
  const idx = sorted.findIndex(([r]) => r === runId)
  return idx >= 0 ? idx + 1 : null
}
