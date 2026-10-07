export interface AcpEventHost {
  text(text: string, live: boolean): void
  reasoning(text: string): void
  toolStarted(item: any): void
  toolCompleted(item: any): void
}

export function acpMcpServers(servers: Record<string, any>): object[] {
  return Object.entries(servers).filter(([, config]) => config.enabled !== false && !config.disabled).map(([name, config]) => {
    if (config.url) return { name, type: config.type === 'sse' ? 'sse' : 'http', url: config.url,
      headers: Object.entries(config.headers || {}).map(([name, value]) => ({ name, value: String(value) })) }
    return { name, command: config.command, args: config.args || [],
      env: Object.entries(config.env || {}).map(([name, value]) => ({ name, value: String(value) })) }
  })
}

export function applyNativeAcpUpdate(update: any, host: AcpEventHost) {
  if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') host.text(update.content.text, true)
  else if (update?.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text') host.reasoning(update.content.text)
  else if (update?.sessionUpdate === 'tool_call') {
    host.toolStarted({ type: 'mcp_tool_call', id: update.toolCallId, tool: update.title || update.kind || 'tool', arguments: update.rawInput })
    if (['completed', 'failed'].includes(update.status)) applyNativeAcpUpdate({ ...update, sessionUpdate: 'tool_call_update' }, host)
  } else if (update?.sessionUpdate === 'tool_call_update' && ['completed', 'failed'].includes(update.status)) {
    const output = update.rawOutput ?? (update.content || []).map((entry: any) => entry.content?.text || '').join('\n')
    host.toolCompleted({ type: 'mcp_tool_call', id: update.toolCallId, output,
      ...(update.status === 'failed' ? { error: { message: typeof output === 'string' ? output : JSON.stringify(output) } } : {}) })
  }
}
