import type { PersonRuntimePort } from '../modules/studio/public/person-runtime'
import { getChatRunServer } from '../modules/studio/public/chat-run'
import { logger } from '../modules/studio/public/logging'
import { codingAgentRunManager } from '../modules/coding-agents/services/runtime/run-manager'

const starting = new Map<string, Promise<void>>()
const stopping = new Map<string, Promise<void>>()

export function stopPersonTask(sessionId: string): Promise<void> {
  const pending = stopping.get(sessionId)
  if (pending) return pending
  const ready = starting.get(sessionId)
  const result = Promise.resolve().then(async () => {
    // Aborting before native initialization can be ignored and let the worker start later.
    // Keep the durable intent in "stopping" until initialization either starts or fails.
    await ready
    const server = getChatRunServer()
    if (!server) throw new Error('Chat runtime unavailable')
    await server.abortSession(sessionId, 'Person task stopped', { waitForTermination: true })
  }).finally(() => stopping.delete(sessionId))
  stopping.set(sessionId, result)
  return result
}

export const executePersonTask: PersonRuntimePort['execute'] = async input => {
  const server = getChatRunServer()
  if (!server) throw new Error('Chat runtime unavailable')
  if (input.signal.aborted) throw new Error('Cancelled')
  let ready!: () => void
  const startup = new Promise<void>(resolve => { ready = resolve })
  starting.set(input.sessionId, startup)
  const abort = () => { void stopPersonTask(input.sessionId).catch(error => logger.warn(error, 'Person native stop failed; scheduler will retry')) }
  input.signal.addEventListener('abort', abort, { once: true })
  try {
    const s = input.selection
    const existing = codingAgentRunManager.getRunInfo(input.sessionId)
    if (existing && existing.workspaceDir !== input.workspace) codingAgentRunManager.stop(input.sessionId, { reportClosed: false })
    return await server.runAndWait({ session_id: input.sessionId, input: input.prompt, display_input: input.displayInput, profile: s.profile, workspace: input.workspace || undefined,
      provider: s.provider || undefined, model: s.model, apiMode: s.apiMode, mode: s.mode, reasoning_effort: s.reasoningEffort,
      source: s.runtime === 'hermes' ? 'api_server' : s.runtime === 'ekko' ? 'builtin_agent' : 'coding_agent',
      ...(s.runtime !== 'hermes' ? { coding_agent_id: (s.runtime === 'ekko' ? 'ekko-agent' : s.runtime) as any } : {}),
      memory_write_policy: 'explicit-only', memory_recall_scopes: [], memory_write_scopes: [],
      instructions: 'This is a task delegated by Person. Tool execution approvals are handled automatically for this task. Ask clarifying questions normally: Person coordinates answers. Work only on the supplied goal and scope. Persist the deliverable or report and verification evidence as files in the supplied workspace and report their paths. Do not claim completion without checking results.',
    }, { profile: s.profile, user: input.user, timeoutMs: 60 * 60_000, approvalChoice: 'once', onEvent: (event: string, payload: Record<string, unknown>) => {
      if (event === 'run.started') ready()
      input.onEvent(event, payload)
    } })
  } finally {
    ready()
    if (starting.get(input.sessionId) === startup) starting.delete(input.sessionId)
    input.signal.removeEventListener('abort', abort)
  }
}
