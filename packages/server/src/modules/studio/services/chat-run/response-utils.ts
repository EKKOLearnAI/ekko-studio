/**
 * Response utility functions for processing upstream API responses.
 */

export function responseFunctionCallToToolCall(item: any): any {
  const callId = item.call_id || item.id || ''
  const name = item.name || item.function?.name || ''
  let args = item.arguments ?? item.function?.arguments ?? '{}'
  if (typeof args !== 'string') {
    args = JSON.stringify(args ?? {})
  }
  return {
    id: callId,
    type: 'function',
    function: {
      name,
      arguments: args || '{}',
    },
  }
}

export function summarizeToolArguments(args: string): string | undefined {
  if (!args) return undefined
  try {
    const parsed = JSON.parse(args)
    if (!parsed || typeof parsed !== 'object') return args.slice(0, 120)
    const preferredKeys = ['cmd', 'command', 'code', 'query', 'path', 'url', 'prompt']
    for (const key of preferredKeys) {
      const value = parsed[key]
      if (typeof value === 'string' && value.trim()) {
        return value.replace(/\s+/g, ' ').slice(0, 160)
      }
    }
    const first = Object.entries(parsed).find(([, value]) => typeof value === 'string' && value.trim())
    if (first) return String(first[1]).replace(/\s+/g, ' ').slice(0, 160)
    return JSON.stringify(parsed).slice(0, 160)
  } catch {
    return args.replace(/\s+/g, ' ').slice(0, 160)
  }
}

export function extractResponseText(response: any): string {
  const output = Array.isArray(response?.output) ? response.output : []
  const parts: string[] = []
  for (const item of output) {
    if (item.type !== 'message') continue
    const content = Array.isArray(item.content) ? item.content : []
    for (const part of content) {
      if (part.type === 'output_text' || part.type === 'text') {
        parts.push(part.text || '')
      }
    }
  }
  if (parts.length > 0) return parts.join('')
  return typeof response?.output_text === 'string' ? response.output_text : ''
}
