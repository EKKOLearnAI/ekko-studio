interface BrowserHistoryMessage {
  role: string
  content: unknown
  name?: string | null
  tool_name?: string | null
}

function browserSnapshot(value: any): boolean {
  return !!value && typeof value.tabId === 'string' && typeof value.snapshotId === 'string'
    && Array.isArray(value.nodes) && value.nodes.every((node: any) => typeof node?.ref === 'string' && typeof node.role === 'string')
}

function historicalSnapshot(snapshot: any): any {
  const ranked = snapshot.nodes.map((node: any, index: number) => ({ node, index,
    score: node.value !== undefined || node.checked !== undefined || node.selected !== undefined || node.pressed !== undefined ? 3
      : /[¥€$£]|\d[,.]\d/.test(node.name || '') ? 2 : node.role === 'heading' ? 1 : 0,
  })).filter(({ node }: any) => node.name || node.value !== undefined)
    .sort((a: any, b: any) => b.score - a.score || a.index - b.index)
  const facts: any[] = []
  let size = 0
  for (const { node } of ranked) {
    const { ref: _ref, ...fact } = node
    const bounded = { ...fact, name: String(fact.name || '').slice(0, 180),
      ...(typeof fact.value === 'string' ? { value: fact.value.slice(0, 180) } : {}),
      ...(typeof fact.description === 'string' ? { description: fact.description.slice(0, 180) } : {}) }
    const length = JSON.stringify(bounded).length
    if (facts.length >= 10) break
    if (size + length > 1400) continue
    facts.push(bounded)
    size += length
  }
  const { nodes, text: _text, ...metadata } = snapshot
  return { ...metadata, stale: true, historicalNodeCount: nodes.length, facts,
    hint: 'Historical snapshot summarized for context. Its refs are stale; use the latest snapshot for actions. Full evidence remains in the original tool result.' }
}

/** Project only Studio browser results; keep stored history, call IDs, failures and current pages intact. */
export function projectBrowserHistory<T extends BrowserHistoryMessage>(messages: T[], options: {
  truncateOtherTools?: (content: string) => string
} = {}): T[] {
  const parsed = new Map<number, any>()
  const latest = new Map<string, string>()
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'tool' || typeof message.content !== 'string'
      || !/(?:ekko|hermes)_studio_browser_(?:toolset|snapshot|interact|batch)$/.test(message.name || message.tool_name || '')) continue
    try {
      const value = JSON.parse(message.content)
      const snapshot = browserSnapshot(value?.result) ? value.result : value?.result?.snapshot
      if (!browserSnapshot(snapshot)) continue
      parsed.set(index, value)
      if (!latest.has(snapshot.tabId)) latest.set(snapshot.tabId, snapshot.snapshotId)
    } catch { /* Plain errors and unrelated tool output remain unchanged. */ }
  }
  return messages.map((message, index) => {
    const value = parsed.get(index)
    let content = message.content
    if (value) {
      const direct = browserSnapshot(value.result)
      const snapshot = direct ? value.result : value.result.snapshot
      const projected = latest.get(snapshot.tabId) === snapshot.snapshotId ? snapshot : historicalSnapshot(snapshot)
      content = JSON.stringify(direct ? { ...value, result: projected }
        : { ...value, result: { ...value.result, snapshot: projected } })
    } else if (message.role === 'tool' && typeof content === 'string') {
      content = options.truncateOtherTools?.(content) ?? content
    }
    if (content === message.content) return message
    const output = { ...message, content }
    const parts = (message as any).contentParts
    if (Array.isArray(parts)) (output as any).contentParts = parts.map(part => part.type === 'text' && part.text === message.content
      ? { ...part, text: content } : part)
    return output
  })
}
