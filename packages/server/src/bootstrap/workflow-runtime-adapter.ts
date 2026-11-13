import { getChatRunServer } from '../modules/studio/public/chat-run'
import { codingAgentRunManager } from '../modules/coding-agents/services/runtime/run-manager'
import { getExactSessionDetailFromDbWithProfile } from '../modules/hermes/services/history/sessions-db'
import { deleteSessionForProfile } from '../modules/hermes/services/runtime/cli'
import { listProfileNamesFromDisk } from '../modules/hermes/services/profiles/profile'
import { getAvailableModelGroupsForProfile } from '../modules/hermes/controllers/models'
import { configureWorkflowRuntime } from '../modules/studio/public/workflow-runtime'

configureWorkflowRuntime({
  isRunCoordinatorAvailable: () => Boolean(getChatRunServer()?.runAndWait),
  runAndWait: async (input, options) => {
    const server = getChatRunServer()
    if (!server?.runAndWait) throw new Error('chat-run server is not available')
    return server.runAndWait(input as any, options as any)
  },
  abortSession: async (sessionId, reason) => {
    await getChatRunServer()?.abortSession?.(sessionId, reason)
  },
  stopAgentRun: sessionId => {
    codingAgentRunManager.stop(sessionId, { reportClosed: false })
  },
  deletePrimaryAgentSession: async (sessionId, profile) => {
    const targetProfile = profile || 'default'
    if (!listProfileNamesFromDisk().includes(targetProfile)) return true
    if (!await getExactSessionDetailFromDbWithProfile(sessionId, targetProfile)) return true
    return deleteSessionForProfile(sessionId, targetProfile)
  },
  getAvailableModelGroups: getAvailableModelGroupsForProfile,
})
