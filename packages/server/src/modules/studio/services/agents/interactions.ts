import { randomUUID } from 'node:crypto'

type Kind = 'approval' | 'clarify'
type Pending = { sessionId: string; runId: string; kind: Kind; finish(outcome: string, response?: string): void }
const pending = new Map<string, Pending>()

/** Responses enter only through already-authorized Studio socket/group routes. */
export function respondAgentInteraction(sessionId: string, id: string, kind: Kind, response: string) {
  if (!id.startsWith('plugin-agent:')) return { handled: false, resolved: false }
  const value = pending.get(id)
  if (!value || value.sessionId !== sessionId || value.kind !== kind) return { handled: true, resolved: false }
  if (kind === 'approval' && !['once', 'deny'].includes(response)) return { handled: true, resolved: false }
  value.finish(kind === 'approval' ? response === 'once' ? 'approved' : 'denied' : response ? 'answered' : 'dismissed', response)
  return { handled: true, resolved: true }
}

export function agentRunInteractions(input: { sessionId: string; runId: string; signal: AbortSignal; deadlineAt: number; emit(event: string, payload: Record<string, unknown>): void }) {
  function ask(kind: Kind, request: Record<string, unknown>): Promise<{ outcome: string; text?: string }> {
    input.signal.throwIfAborted()
    const id = `plugin-agent:${randomUUID()}`
    return new Promise((resolve, reject) => {
      const timeoutMs = Math.max(1, Math.min(300_000, input.deadlineAt - Date.now()))
      let timer: ReturnType<typeof setTimeout>
      let settled = false
      const finish = (outcome: string, text?: string) => {
        if (settled) return
        settled = true; clearTimeout(timer); pending.delete(id); input.signal.removeEventListener('abort', abort)
        try { input.emit(`${kind}.resolved`, { [`${kind}_id`]: id, resolved: true, outcome, ...(kind === 'approval' ? { choice: text || 'deny' } : { response: text || '' }) }) }
        catch (error) { reject(error); return }
        resolve({ outcome, ...(kind === 'clarify' && outcome === 'answered' ? { text: text || '' } : {}) })
      }
      const abort = () => finish('cancelled')
      timer = setTimeout(() => finish('timeout'), timeoutMs); timer.unref()
      pending.set(id, { sessionId: input.sessionId, runId: input.runId, kind, finish })
      input.signal.addEventListener('abort', abort, { once: true })
      if (input.signal.aborted) { abort(); return }
      try { input.emit(`${kind}.requested`, { ...request, [`${kind}_id`]: id, timeout_ms: timeoutMs, countdown_deadline: Date.now() + timeoutMs }) }
      catch (error) { settled = true; clearTimeout(timer); pending.delete(id); input.signal.removeEventListener('abort', abort); reject(error) }
    })
  }
  return {
    async approve(request: { operationId: string; title: string; details: string; input?: unknown }): Promise<{ outcome: 'approved' | 'denied' | 'cancelled' | 'timeout' }> {
      if (!request || typeof request.title !== 'string' || !request.title.trim() || request.title.length > 4000 || typeof request.details !== 'string' || request.details.length > 16000 || typeof request.operationId !== 'string') throw new Error('Invalid Agent approval request')
      return await ask('approval', { command: request.title, description: request.details, operation_id: request.operationId, input: request.input, choices: ['once', 'deny'], allow_permanent: false }) as { outcome: 'approved' | 'denied' | 'cancelled' | 'timeout' }
    },
    async clarify(request: { question: string; choices?: string[] }): Promise<{ outcome: 'answered'; text: string } | { outcome: 'dismissed' | 'cancelled' | 'timeout' }> {
      if (!request || typeof request.question !== 'string' || !request.question.trim() || request.question.length > 4000 || request.choices && (!Array.isArray(request.choices) || request.choices.length > 20 || request.choices.some(value => typeof value !== 'string' || value.length > 1000))) throw new Error('Invalid Agent clarification request')
      return await ask('clarify', { question: request.question, choices: request.choices || null }) as { outcome: 'answered'; text: string } | { outcome: 'dismissed' | 'cancelled' | 'timeout' }
    },
  }
}
