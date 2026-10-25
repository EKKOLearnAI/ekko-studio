import type { AgentOutputEvent } from '@ekko-studio/plugin-sdk'
type Output = AgentOutputEvent extends infer T ? T extends AgentOutputEvent ? Omit<T, 'producerSequence'> : never : never

/** The final native item is authoritative; snapshots replace streamed text. */
export function codexEvents(emit: (event: Output) => void) {
  const tools = new Map<string, { name: string; done: boolean }>()
  const toolTypes = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabToolCall', 'webSearch', 'imageView', 'contextCompaction'])
  return (method: string, params: Record<string, any>) => {
    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      emit({ type: 'message.delta', messageId: String(params.itemId), text: params.delta })
    } else if (['item/reasoning/summaryTextDelta', 'item/reasoning/textDelta'].includes(method) && typeof params.delta === 'string') {
      emit({ type: 'reasoning.delta', messageId: String(params.itemId), text: params.delta })
    } else if (['item/started', 'item/completed'].includes(method)) {
      const item = params.item
      if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 256) throw new Error('Invalid Codex item identity')
      if (method === 'item/completed' && item.type === 'agentMessage' && typeof item.text === 'string') {
        emit({ type: 'message.snapshot', messageId: item.id, text: item.text })
      } else if (toolTypes.has(item.type)) {
        let tool = tools.get(item.id)
        if (!tool) {
          if (tools.size >= 256) throw new Error('Codex tool count limit exceeded')
          tool = { name: String(item.tool || item.type), done: false }
          tools.set(item.id, tool)
          emit({ type: 'tool.started', callId: item.id, name: tool.name, data: item })
        }
        if (method === 'item/completed' && !tool.done) {
          tool.done = true
          emit({ type: item.error || ['failed', 'declined'].includes(item.status) || item.success === false ? 'tool.failed' : 'tool.completed',
            callId: item.id, name: tool.name, data: item })
        }
      }
    }
  }
}
