import type { NativeTurnHost } from '../runtime/turn-host'

export function applyZcodeEvent(event: any, host: Pick<NativeTurnHost, 'text' | 'reasoning' | 'toolStarted' | 'toolCompleted' | 'fail'>) {
  const payload = event?.payload || {}
  if (event.type === 'model.streaming' && payload.kind === 'text_delta') host.text(String(payload.delta || ''), true)
  else if (event.type === 'model.streaming' && payload.kind === 'reasoning_delta') host.reasoning(String(payload.delta || ''))
  else if (event.type === 'tool.updated' && payload.kind === 'scheduled') host.toolStarted({
    type: 'mcp_tool_call', id: payload.toolCallId, tool: payload.toolName || 'tool', arguments: payload.input,
  })
  else if (event.type === 'tool.updated' && ['result', 'error'].includes(payload.kind)) host.toolCompleted({
    type: 'mcp_tool_call', id: payload.toolCallId, output: payload.result?.content ?? payload.result ?? payload.error?.message ?? '',
    ...(payload.kind === 'error' ? { error: payload.error } : {}),
  })
  else if (event.type === 'turn.failed') host.fail(payload.error?.message || payload.message || 'ZCode turn failed')
}
