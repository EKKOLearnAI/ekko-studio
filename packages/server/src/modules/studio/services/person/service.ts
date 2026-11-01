import { personMemories } from './memory'
import { readPersonSession, personChatBusy } from './chat-agent'
import { personError, personRevision, personText } from '../../contracts/person'
import { personSettings, savePersonSettings,
  listPersonTasks, listPersonSchedules, personInteractions } from '../../repositories/person-store'
import { effectivePersonSettings, personModelSelection, personUser, validatePersonSelection, PERSON_REASONING_EFFORTS } from './catalog'
import { validatePersonAgents } from './agents'
import { isAbsolute } from 'node:path'
import { normalizeDirectoryTarget, requireExistingWorkspaceDirectory } from '../workspace/directory'
import { personHasPendingWork } from '../../repositories/person-history-store'
import { listPersonFlows, personFlowActivity } from '../../repositories/person-stage-store'

export async function personSnapshot(userId: number, sessionId = '') {
  personUser(userId)
  const session = sessionId ? await readPersonSession(userId, sessionId) : { ...await effectivePersonSettings(userId), session: null }
  const busy = personChatBusy(userId, sessionId || undefined)
  return { ...session, tasks: sessionId ? listPersonTasks(userId, '', 0, { sessionId, limit: 100 }) : [], memories: await personMemories(userId),
    flows:sessionId ? listPersonFlows(userId,sessionId) : [],
    ...(sessionId ? personFlowActivity(userId,sessionId) : { active_flow_count:0,active_flows:[] }),
    schedules: sessionId ? listPersonSchedules(userId, sessionId) : [], interactions: personInteractions(userId), busy,
    history_revision: session.session?.history_revision ?? 0, can_clear: !!session.session && !busy && !personHasPendingWork(userId, sessionId) }
}
export async function configurePerson(userId: number, input: Record<string, unknown>) {
  const sessionId = input.session_id === undefined ? undefined : personText(input.session_id, 'session_id', 100)
  if (!sessionId && ['model', 'reasoning_effort', 'use_global_default', 'workspace'].some(key => input[key] !== undefined))
    throw personError('session_id is required for Bot settings')
  const sharedChange = ['timezone', 'agents', 'compressionThreshold', 'maxSteps', 'maxConcurrentTasks'].some(key => input[key] !== undefined)
  const busySession = sharedChange ? undefined : sessionId
  const old = personSettings(userId, sessionId)
  if (personChatBusy(userId, busySession)) throw personError('Wait for the current reply before changing settings', 409)
  if (input.contextTokens !== undefined) throw personError('Context capacity follows the selected model; set compressionThreshold instead')
  const settings = { ...old.settings }
  if (input.workspace !== undefined) {
    if (typeof input.workspace !== 'string' || input.workspace.length > 4000) throw personError('Invalid workspace')
    settings.workspace = normalizeDirectoryTarget(input.workspace.trim())
    if (settings.workspace && !isAbsolute(settings.workspace)) throw personError('Workspace must be an absolute path')
    settings.workspace = requireExistingWorkspaceDirectory(settings.workspace)
  }
  if (input.model && typeof input.model === 'object' && !Array.isArray(input.model)) {
    settings.model = await personModelSelection(userId, input.model as Record<string, unknown>)
    await validatePersonSelection(userId, settings.model)
  }
  if (input.use_global_default === true) settings.model = null
  if (input.reasoning_effort !== undefined) {
    if (typeof input.reasoning_effort !== 'string' || (input.reasoning_effort !== '' && !PERSON_REASONING_EFFORTS.includes(input.reasoning_effort as any))) throw personError('Invalid reasoning effort')
    settings.reasoningEffort = input.reasoning_effort
  }
  const effective = await effectivePersonSettings(userId, { ...old, settings })
  if (input.reasoning_effort && !effective.reasoning_efforts.includes(input.reasoning_effort as any)) throw personError('Model does not support this reasoning effort')
  settings.reasoningEffort = effective.settings.reasoningEffort
  if (input.timezone !== undefined) { settings.timezone = personText(input.timezone, 'timezone', 100); new Intl.DateTimeFormat('en-US', { timeZone: settings.timezone }) }
  if (input.agents !== undefined) settings.agents = await validatePersonAgents(userId, input.agents)
  if (input.compressionThreshold !== undefined) {
    const value = input.compressionThreshold
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0.05 || value > 0.95)) throw personError('Invalid compressionThreshold')
    settings.compressionThreshold = value as number | null
  }
  for (const [key, min, max] of [['maxSteps', 2, 30], ['maxConcurrentTasks', 1, 12]] as const) {
    if (input[key] !== undefined) {
      const value = input[key]
      if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw personError(`Invalid ${key}`)
      settings[key] = Number(value)
    }
  }
  if (personChatBusy(userId, busySession)) throw personError('Wait for the current reply before changing settings', 409)
  const workspace = input.workspace !== undefined ? requireExistingWorkspaceDirectory(settings.workspace) : undefined
  return effectivePersonSettings(userId, savePersonSettings(userId, settings, personRevision(input.expected_revision), workspace, sessionId))
}
// Service facade for the thin HTTP controller.
export { withPersonTaskReturns } from '../../repositories/person-return-store'
export { listPersonTasks, taskPersonExecutions, personEvents } from '../../repositories/person-store'

export { requirePersonSession } from '../../repositories/person-session-store'

export { getPersonFlow, listPersonFlows } from '../../repositories/person-stage-store'
