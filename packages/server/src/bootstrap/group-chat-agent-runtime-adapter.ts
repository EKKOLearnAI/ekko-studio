import { AgentBridgeClient } from '../modules/hermes/services/bridge/client'
import { SessionDeleter } from '../modules/hermes/services/history/session-deleter'
import { getAvailableModelGroupsForProfile } from '../modules/hermes/controllers/models'
import { respondToEkkoToolApproval } from '../modules/ekko/services/approvals'
import {
  cancelPendingEkkoClarification,
  respondToEkkoClarification,
} from '../modules/ekko/services/clarifications'
import { getGlobalEkkoAgent } from '../modules/ekko/services/manager'
import {
  createEkkoAuthorizedProviderFetch,
  resolveEkkoProviderRuntimeConfig,
} from '../modules/ekko/services/provider-runtime'
import { configureGroupChatAgentRuntime } from '../modules/studio/public/group-chat-agent-runtime'
import { createModelClient, resolveModelProviderConfigs } from '../../../ekko-agent/src'

configureGroupChatAgentRuntime({
  createPrimaryAgentBridge: options => new AgentBridgeClient(options),
  cancelEkkoClarification: cancelPendingEkkoClarification,
  respondToEkkoToolApproval,
  respondToEkkoClarification,
  createEkkoModelClient: createModelClient,
  resolveEkkoModelProviderConfigs: resolveModelProviderConfigs,
  getEkkoAgent: getGlobalEkkoAgent,
  resolveEkkoProviderRuntimeConfig,
  createEkkoAuthorizedProviderFetch,
  drainPrimaryAgentSessions: profile => SessionDeleter.getInstance().drain(profile),
  getAvailableModelGroups: getAvailableModelGroupsForProfile,
})
