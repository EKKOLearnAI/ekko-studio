import { personMemories } from './memory'
import { ensurePersonSession, personChatBusy } from './chat-agent'
import { personError, personRevision, personText } from '../../contracts/person'
import { personSettings, savePersonSettings,
  listPersonTasks, listPersonSchedules, personInteractions } from '../../repositories/person-store'
import { effectivePersonSettings, personModelSelection, personUser, validatePersonSelection, PERSON_REASONING_EFFORTS } from './catalog'
import { validatePersonAgents } from './agents'
import { isAbsolute, join } from 'node:path'
import { getWebUiHome } from '../../public/config'
import { ensureDirectory, normalizeDirectoryTarget } from '../workspace/directory'
import { personHasPendingWork } from '../../repositories/person-history-store'

export async function personSnapshot(userId: number) {
  personUser(userId)
  const session = await ensurePersonSession(userId)
  const busy = personChatBusy(userId)
  return { ...session, tasks: listPersonTasks(userId), memories: await personMemories(userId),
    schedules: listPersonSchedules(userId), interactions: personInteractions(userId), busy,
    history_revision: session.session.history_revision, can_clear: !busy && !personHasPendingWork(userId) }
}
export async function configurePerson(userId: number, input: Record<string, unknown>) {
  if (personChatBusy(userId)) throw personError('Wait for the current reply before changing settings', 409)
  if (input.contextTokens !== undefined) throw personError('Context capacity follows the selected model; set compressionThreshold instead')
  const old = personSettings(userId)
  const settings = { ...old.settings }
  if (input.workspace !== undefined) {
    if (personHasPendingWork(userId)) throw personError('Wait for Person tasks and result delivery before changing workspace', 409)
    if (typeof input.workspace !== 'string' || input.workspace.length > 4000) throw personError('Invalid workspace')
    settings.workspace = normalizeDirectoryTarget(input.workspace.trim())
    if (settings.workspace && !isAbsolute(settings.workspace)) throw personError('Workspace must be an absolute path')
    if (settings.workspace) await ensureDirectory(settings.workspace)
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
  for (const [key, min, max] of [['maxSteps', 2, 30], ['maxConcurrentTasks', 1, 4]] as const) {
    if (input[key] !== undefined) {
      const value = input[key]
      if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw personError(`Invalid ${key}`)
      settings[key] = Number(value)
    }
  }
  if (personChatBusy(userId)) throw personError('Wait for the current reply before changing settings', 409)
  if (input.workspace !== undefined && personHasPendingWork(userId)) throw personError('Wait for Person tasks and result delivery before changing workspace', 409)
  const workspace = input.workspace !== undefined ? settings.workspace || join(getWebUiHome(), 'person', String(userId), 'workspace') : undefined
  return effectivePersonSettings(userId, savePersonSettings(userId, settings, personRevision(input.expected_revision), workspace))
}
// Service facade for the thin HTTP controller.
export { withPersonTaskReturns } from '../../repositories/person-return-store'
export { listPersonTasks, taskPersonExecutions, personEvents } from '../../repositories/person-store'
