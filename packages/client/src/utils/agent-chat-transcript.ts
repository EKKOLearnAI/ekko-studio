import type { HermesMessage } from '@/api/studio/sessions'

/** Bounded display cache for canonical message upserts, including corrective
 * snapshots and tool results delivered after a page refresh. */
export class AgentChatTranscript {
  private readonly sessions = new Map<string, Map<number, HermesMessage>>()
  remember(sessionId: string, rows: HermesMessage[], replace = false): HermesMessage[] {
    const cache = replace ? new Map<number, HermesMessage>() : this.sessions.get(sessionId) ?? new Map<number, HermesMessage>()
    for (const row of rows) {
      const usage = row.run_usage
      if (!usage) continue
      for (const [id, previous] of cache) {
        if (id !== Number(row.id) && previous.run_usage?.runId === usage.runId) cache.set(id, { ...previous, run_usage: undefined })
      }
    }
    for (const row of rows) if (Number.isSafeInteger(Number(row.id))) cache.set(Number(row.id), row)
    for (const id of [...cache.keys()].sort((a, b) => b - a).slice(300)) cache.delete(id)
    this.sessions.delete(sessionId); this.sessions.set(sessionId, cache)
    while (this.sessions.size > 32) this.sessions.delete(this.sessions.keys().next().value!)
    return rows
  }
  run(sessionId: string, runId: string): HermesMessage[] {
    return [...(this.sessions.get(sessionId)?.values() ?? [])].filter(row => row.run_marker === runId).sort((a, b) => Number(a.id) - Number(b.id))
  }
  clear(): void { this.sessions.clear() }
}
