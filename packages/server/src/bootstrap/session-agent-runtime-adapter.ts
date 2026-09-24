import { getAvailableModelGroupsForProfile } from '../modules/hermes/controllers/models'
import { codingAgentRunManager } from '../modules/coding-agents/services/runtime/run-manager'
import { AgentBridgeClient } from '../modules/hermes/services/bridge/client'
import { getAgentBridgeManager } from '../modules/hermes/services/bridge/manager'
import {
  getExactSessionDetailFromDbWithProfile,
  getSessionDetailFromDb,
  getSessionDetailFromDbWithProfile,
  getSessionDetailPaginatedFromDbWithProfile,
  getUsageStatsFromDb,
  listSessionSummaries,
  listSessionSummaryGroups,
} from '../modules/hermes/services/history/sessions-db'
import { deleteSessionForProfile, getSession } from '../modules/hermes/services/runtime/cli'
import { getModelContextLength } from '../modules/hermes/services/models/context'
import { configureSessionAgentRuntime } from '../modules/studio/public/session-agent-runtime'

configureSessionAgentRuntime({
  getAvailableModelGroups: getAvailableModelGroupsForProfile,
  deleteHermesSessionForProfile: deleteSessionForProfile,
  getHermesCliSession: getSession,
  getHermesModelContextLength: getModelContextLength,
  getHermesSessionDetail: getSessionDetailFromDb,
  getHermesSessionDetailForProfile: getSessionDetailFromDbWithProfile,
  getHermesSessionDetailPaginatedForProfile: getSessionDetailPaginatedFromDbWithProfile,
  getExactHermesSessionDetailForProfile: getExactSessionDetailFromDbWithProfile,
  getHermesUsageStats: getUsageStatsFromDb,
  listHermesSessionSummaries: listSessionSummaries,
  listHermesSessionSummaryGroups: listSessionSummaryGroups,
  notifyHermesSessionModelChanged: async (sessionId, model, provider, profile) => {
    const state = getAgentBridgeManager().getRuntimeState()
    if (!state.ready || !state.running) return
    const bridge = new AgentBridgeClient({
      endpoint: state.endpoint,
      timeoutMs: 5000,
      connectRetryMs: 0,
    })
    await bridge.switchSessionModel(
      sessionId,
      model,
      provider === 'claude-oauth' ? 'anthropic' : provider,
      profile,
    )
  },
  stopCodingAgentSessionRun: (sessionId, options) => codingAgentRunManager.stop(sessionId, options),
  invalidateCodingAgentSessionRuntime: (sessionId, agentId = 'grok') => codingAgentRunManager.invalidateMatching(
    launch => launch.sessionId === sessionId && launch.agentId === agentId,
  ),
})
