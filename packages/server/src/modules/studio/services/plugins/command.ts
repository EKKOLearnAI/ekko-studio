import { randomUUID } from 'node:crypto'
import { addMessage, createSession, getSession, updateSessionStats } from '../../repositories/session-store'
import type { PluginIdentity } from '../../contracts/plugins'
import type { SessionState } from '../../contracts/runs/session'
import { authorizePluginIdentity, getPluginManager } from './host'

export async function handlePluginCommand(input: unknown, identity: PluginIdentity, state: SessionState, emit: (payload: Record<string, unknown>) => void): Promise<boolean> {
  if (typeof input !== 'string') return false
  const match = /^\/([a-z][a-z0-9._-]*):([a-z][a-z0-9._-]*)(?:\s+([\s\S]*))?$/.exec(input.trim())
  if (!match) return false
  const [, id, name, args = ''] = match, sessionId = identity.sessionId!
  const base = { event: 'session.command', session_id: sessionId, command: `${id}:${name}`, action: 'plugin' }
  const existing = getSession(sessionId)
  try { authorizePluginIdentity(existing ? identity : { ...identity, sessionId: undefined }) }
  catch (error) { emit({ ...base, ok: false, terminal: true, message: error instanceof Error ? error.message : String(error) }); return true }
  if (state.isWorking) { emit({ ...base, ok: false, message: 'Wait for the current run before executing a plugin command.' }); return true }
  if (!existing) createSession({ id: sessionId, profile: identity.profile, user_id: identity.userId, source: 'cli', title: input.slice(0, 120) })
  const controller = new AbortController(), runId = randomUUID()
  state.isWorking = true; state.abortController = controller; state.runId = runId
  emit({ ...base, ok: true, started: true, terminal: false })
  let content: string, ok = true
  try {
    const result = await getPluginManager().runtime(identity, id).invoke('command', name, args, { ...identity, runId }, controller.signal)
    content = typeof result === 'string' ? result : JSON.stringify(result)
  } catch (error) { ok = false; content = error instanceof Error ? error.message : String(error) }
  const timestamp = Date.now() / 1000
  for (const text of [input, content]) {
    const id = addMessage({ session_id: sessionId, role: 'command', content: text, timestamp })
    state.messages.push({ id: id || randomUUID(), session_id: sessionId, role: 'command', content: text, timestamp })
  }
  updateSessionStats(sessionId)
  if (state.runId === runId) { state.isWorking = false; state.abortController = undefined; state.runId = undefined }
  emit({ ...base, ok, message: content, terminal: true })
  return true
}
