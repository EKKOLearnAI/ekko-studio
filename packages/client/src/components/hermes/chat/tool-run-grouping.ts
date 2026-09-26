import type { Message } from '@/stores/hermes/chat'

export function groupCompletedToolsByRun(messages: Message[], ungroupedMessageId?: string | null): Message[] {
  const toolsByRun = new Map<string, Message[]>()
  for (const message of messages) {
    const runId = message.runMarker?.trim()
    if (message.id === ungroupedMessageId || message.role !== 'tool' || message.toolStatus === 'running' || !runId) continue
    const tools = toolsByRun.get(runId) || []
    tools.push(message)
    toolsByRun.set(runId, tools)
  }
  if (toolsByRun.size === 0) return messages

  const emittedRuns = new Set<string>()
  const grouped: Message[] = []
  for (const message of messages) {
    const runId = message.id !== ungroupedMessageId && message.role === 'tool' && message.toolStatus !== 'running'
      ? message.runMarker?.trim()
      : undefined
    if (!runId) {
      grouped.push(message)
      continue
    }
    if (emittedRuns.has(runId)) continue
    emittedRuns.add(runId)
    const tools = toolsByRun.get(runId)
    if (!tools?.length) {
      grouped.push(message)
      continue
    }
    grouped.push({
      id: `tool-run:${runId}`,
      role: 'system',
      content: '',
      timestamp: tools[0].timestamp,
      systemType: 'tool-run',
      runMarker: runId,
      toolRunId: runId,
      toolMessages: tools,
    })
  }
  return grouped
}
