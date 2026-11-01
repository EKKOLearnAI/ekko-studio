import { personSessionId } from '../../contracts/person-session'
import { personError, personRevision, personText } from '../../contracts/person'
import { isAbsolute } from 'node:path'
import { normalizeDirectoryTarget, requireExistingWorkspaceDirectory } from '../workspace/directory'
import { createSession } from '../../repositories/session-store'
import { assertPersonBotNameAvailable, beginPersonSessionDeletion, listPersonSessions, requirePersonSession } from '../../repositories/person-session-store'
import { clearPersonHistory } from '../../repositories/person-history-store'
import { personUpdated } from '../../repositories/person-updates'
import { getChatRunServer } from '../../public/chat-run'
import { effectivePersonSettings, personUser, personModelSelection, validatePersonSelection, PERSON_REASONING_EFFORTS } from './catalog'
import { ensurePersonSession } from './chat-agent'
import { stopPersonSessionTasks } from './tasks'
import { stopPersonSessionFlows } from './stage-flows'
import { DEFAULT_PERSON_BOT_TYPE, personBot } from '../../../../../../shared/person-bots'
import { personDb, personSettings, personTransaction } from '../../repositories/person-store'

export function personConversations(userId: number, query = '', offset = 0) {
  personUser(userId)
  const sessions = listPersonSessions(userId, query.slice(0, 200), offset, 51)
  return { sessions: sessions.slice(0, 50), next_offset: sessions.length > 50 ? offset + 50 : null }
}

export async function createPersonConversation(userId: number, title: unknown, input: Record<string, unknown> = {}) {
  personUser(userId)
  const name = personText(title, 'conversation name', 100)
  assertPersonBotNameAvailable(userId, name)
  const bot = personBot(input.bot_type ?? DEFAULT_PERSON_BOT_TYPE)
  if (!bot) throw personError('Unknown bot type')
  const stored = personSettings(userId)
  const initial = { ...stored.settings }
  if (typeof input.workspace !== 'string' || !input.workspace.trim() || input.workspace.length > 4000) throw Object.assign(personError('Choose a workspace directory for this Bot'), { code: 'BOT_WORKSPACE_REQUIRED' })
  initial.workspace = normalizeDirectoryTarget(input.workspace.trim())
  if (!isAbsolute(initial.workspace)) throw personError('Workspace must be an absolute path')
  const workspace = requireExistingWorkspaceDirectory(initial.workspace)
  const checkRevision = () => {
    if (input.expected_revision !== undefined && personSettings(userId).revision !== personRevision(input.expected_revision)) throw personError('Settings changed; reload and retry', 409)
  }
  checkRevision()
  if (input.model !== undefined) {
    if (!input.model || typeof input.model !== 'object' || Array.isArray(input.model)) throw personError('Invalid model')
    initial.model = await personModelSelection(userId, input.model as Record<string, unknown>)
    await validatePersonSelection(userId, initial.model)
  }
  if (input.reasoning_effort !== undefined) {
    if (typeof input.reasoning_effort !== 'string' || (input.reasoning_effort !== '' && !PERSON_REASONING_EFFORTS.includes(input.reasoning_effort as any))) throw personError('Invalid reasoning effort')
    initial.reasoningEffort = input.reasoning_effort
  }
  const { settings, reasoning_efforts } = await effectivePersonSettings(userId, { ...stored, settings: initial })
  if (input.reasoning_effort && !reasoning_efforts.includes(input.reasoning_effort as any)) throw personError('Model does not support this reasoning effort')
  personUser(userId)
  const id = personSessionId()
  personTransaction(() => {
    // Recheck after model/directory awaits, under the same write lock as insertion.
    assertPersonBotNameAvailable(userId, name)
    checkRevision()
    requireExistingWorkspaceDirectory(workspace)
    createSession({ id, user_id: userId, studio_user_id: userId, title: name, bot_type: bot.type,
      source: 'builtin_agent', agent: 'ekko-agent', agent_preset: 'person', agent_mode: 'scoped',
      profile: settings.model?.profile || 'default', workspace, push_enabled: false })
    personDb().prepare('INSERT INTO person_conversation_settings VALUES (?,?,?)')
      .run(id, userId, JSON.stringify({ model: initial.model, reasoningEffort: settings.reasoningEffort, workspace }))
  })
  personUpdated(userId)
  return (await ensurePersonSession(userId, id)).session
}

export async function deletePersonConversation(userId: number, sessionId: string, expectedRevision: unknown) {
  personUser(userId)
  const session = requirePersonSession(userId, sessionId)
  const revision = personRevision(expectedRevision)
  if (session.history_revision !== revision) throw Object.assign(new Error('Conversation changed; reload and retry'), { status: 409 })
  const release = beginPersonSessionDeletion(userId, sessionId)
  try {
    await stopPersonSessionFlows(userId,sessionId)
    const server = getChatRunServer()
    await server?.abortSession?.(sessionId, 'Person conversation deleted', { waitForTermination: true })
    await stopPersonSessionTasks(userId, sessionId)
    personUser(userId)
    const result = clearPersonHistory(userId, sessionId, revision, true)
    for (const id of result.sessionIds) await server?.disposeSession?.(id)
    personUpdated(userId)
    return { deleted: true, session_id: sessionId }
  } finally { release() }
}
