import type { AgentMessage } from '../model/types'

/** Losslessly share repeated browser node descriptions across snapshots in the learning preflight. */
export function skillReviewEvidence(messages: AgentMessage[]) {
  const browserNodes: Record<string, unknown>[] = []
  const nodeIds = new Map<string, number>()
  const compactSnapshot = (value: any): any => {
    if (!value || typeof value !== 'object') return value
    if (value.snapshotId && value.tabId && Array.isArray(value.nodes)
      && value.nodes.every((node: any) => node && typeof node.ref === 'string' && typeof node.role === 'string')) {
      const { text, ...snapshot } = value
      return { ...snapshot, nodes: value.nodes.map(({ ref, ...description }: Record<string, unknown>) => {
        const key = JSON.stringify(description)
        let id = nodeIds.get(key)
        if (id === undefined) { id = browserNodes.length; nodeIds.set(key, id); browserNodes.push(description) }
        return [ref, id]
      }) }
    }
    return value.snapshot ? { ...value, snapshot: compactSnapshot(value.snapshot) } : value
  }
  const transcript = messages.filter(message => message.role !== 'system').map(message => {
    let content: unknown = message.content
    if (message.role === 'tool' && /(?:ekko|hermes)_studio_browser_/.test(message.name || '')) {
      try {
        const result = JSON.parse(message.content)
        if (result && typeof result === 'object' && !Array.isArray(result) && result.result) {
          content = { ...result, result: compactSnapshot(result.result) }
        }
      } catch { /* Keep errors, malformed responses and non-JSON results verbatim. */ }
    }
    return { role: message.role, name: message.name, content, toolCalls: message.toolCalls }
  })
  return { transcript, ...(browserNodes.length ? { browserNodes } : {}) }
}
