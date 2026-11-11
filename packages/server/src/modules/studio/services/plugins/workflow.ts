import type { PluginIdentity } from '../../contracts/plugins'
import { addMessage, updateSessionStats } from '../../repositories/session-store'
import { getPluginManager } from './host'
import { identifier, json } from './schema'
import { contentBlocksToString } from '../chat-run/content-blocks'
import type { ContentBlock } from '../../contracts/runs/session'

const executions = new Map<string, Set<AbortController>>()
export function cancelPluginWorkflow(runId: string): void {
  for (const controller of executions.get(runId) || []) controller.abort(new Error('Workflow canceled'))
}
export function parsePluginAction(value: string): [string, string] {
  const parts = value.split('/')
  if (parts.length !== 2) throw new Error('Plugin action must be plugin-id/action-name')
  return [identifier(parts[0]), identifier(parts[1])]
}
export async function runPluginWorkflow(action: string, argumentsJson: string, rawInput: string | ContentBlock[], identity: PluginIdentity, timeoutMs?: number | null): Promise<{ ok: boolean; output?: string; error?: string }> {
  const input = typeof rawInput === 'string' ? rawInput : contentBlocksToString(rawInput)
  const controller = new AbortController(), key = identity.runId!
  const active = executions.get(key) || new Set(); active.add(controller); executions.set(key, active)
  const signal = timeoutMs ? AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)))]) : controller.signal
  try {
    const [id, name] = parsePluginAction(action), runtime = getPluginManager().runtime(identity, id)
    const args = json(JSON.parse(argumentsJson || '{}'))
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Plugin action arguments must be a JSON object')
    if (runtime.actions.get(name)?.inputSchema.properties?.input && args.input === undefined) args.input = input
    const result = await runtime.invoke('action', name, args, identity, signal)
    const output = typeof result === 'string' ? result : JSON.stringify(result)
    if (identity.sessionId) {
      addMessage({ session_id: identity.sessionId, role: 'user', content: input, timestamp: Date.now() / 1000 })
      addMessage({ session_id: identity.sessionId, role: 'assistant', content: output, timestamp: Date.now() / 1000 })
      updateSessionStats(identity.sessionId)
    }
    return { ok: true, output }
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  finally { active.delete(controller); if (!active.size) executions.delete(key) }
}
