import { getCodingAgentManagedMcpServerConfigs, type CodingAgentId } from '../modules/coding-agents/services'
import './agent-profile-adapter'
import { AgentBridgeClient } from '../modules/hermes/services/bridge/client'
import { getAgentBridgeManager } from '../modules/hermes/services/bridge/manager'
import { redactAgentBridgeError } from '../modules/hermes/services/bridge/redact'
import { codingAgentRunManager } from '../modules/coding-agents/services/runtime/run-manager'
import { sendCodingAgentRunInput, startCodingAgentRun } from '../modules/coding-agents'
import {
  handleCodingAgentSessionCommand,
  parseCodingAgentSessionCommand,
} from '../modules/coding-agents/services/session-command'
import {
  abortGlobalEkkoBackgroundTasks,
  getGlobalEkkoAgent,
  hasGlobalEkkoBackgroundTasks,
} from '../modules/ekko/services/manager'
import { respondToEkkoToolApproval, waitForEkkoToolApproval } from '../modules/ekko/services/approvals'
import { respondToEkkoClarification, waitForEkkoClarification } from '../modules/ekko/services/clarifications'
import { resolveEkkoMcpServers } from '../modules/ekko/services/mcp'
import {
  createEkkoAuthorizedProviderFetch,
  resolveEkkoProviderRuntimeConfig,
} from '../modules/ekko/services/provider-runtime'
import { configureChatAgentRuntime } from '../modules/studio/public/chat-agent-runtime'
import {
  agentReasoningText,
  createModelClient,
  DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
  normalizeAgentReasoning,
  resolveModelProviderConfigs,
  serializeAgentReasoningDetails,
} from '../../../ekko-agent/src'

configureChatAgentRuntime({
  createPrimaryAgentBridge: options => new AgentBridgeClient(options),
  getPrimaryAgentBridgeManager: getAgentBridgeManager,
  redactPrimaryAgentBridgeError: redactAgentBridgeError,
  codingAgentRunManager,
  sendCodingAgentRunInput,
  startCodingAgentRun,
  handleCodingAgentSessionCommand,
  parseCodingAgentSessionCommand,
  getEkkoAgent: getGlobalEkkoAgent,
  abortEkkoBackgroundTasks: abortGlobalEkkoBackgroundTasks,
  hasEkkoBackgroundTasks: hasGlobalEkkoBackgroundTasks,
  createEkkoModelClient: createModelClient,
  resolveEkkoModelProviderConfigs: resolveModelProviderConfigs,
  ekkoModelRequestTimeoutMs: DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
  ekkoAgentReasoningText: agentReasoningText,
  normalizeEkkoAgentReasoning: normalizeAgentReasoning,
  serializeEkkoAgentReasoningDetails: serializeAgentReasoningDetails,
  waitForEkkoToolApproval,
  waitForEkkoClarification,
  getCodingAgentMcpServers: (id, profile) => getCodingAgentManagedMcpServerConfigs(id as CodingAgentId, profile),
  resolveEkkoMcpServers,
  resolveEkkoProviderRuntimeConfig,
  createEkkoAuthorizedProviderFetch,
  respondToEkkoToolApproval,
  respondToEkkoClarification,
})
