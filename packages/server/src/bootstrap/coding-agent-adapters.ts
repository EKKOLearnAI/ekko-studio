import './agent-profile-adapter'
import * as modelContext from '../modules/hermes/services/models/context'
import * as responseStream from '../modules/studio/services/chat-run/response-stream'
import * as runUsage from '../modules/studio/services/chat-run/usage'
import * as responseUtils from '../modules/studio/services/chat-run/response-utils'
import * as workspaceDiff from '../modules/studio/services/chat-run/workspace-diff-tracker'
import { getChatRunServer } from '../modules/studio/public/chat-run'
import { getOrCreateSession } from '../modules/studio/services/chat-run/compression'
import { configureProviderRuntime } from '../modules/studio/public/provider-runtime'
import { configureRunState } from '../modules/studio/public/run-state'
import { invalidateCodingAgentProviderRuntime } from '../modules/coding-agents/services'

configureProviderRuntime({
  getModelContextLength: modelContext.getModelContextLength,
  getModelRuntimeCapabilities: (...args: any[]) => {
    const resolver = (modelContext as any).getModelRuntimeCapabilities
    return typeof resolver === 'function'
      ? resolver(...args)
      : { contextWindow: modelContext.getModelContextLength(...args) }
  },
  invalidateProviderRuntime: invalidateCodingAgentProviderRuntime,
})
const optional = (candidate: unknown, fallback: (...args: any[]) => any) => (
  typeof candidate === 'function' ? candidate as (...args: any[]) => any : fallback
)
configureRunState({
  applyResponseStreamEvent: optional((responseStream as any).applyResponseStreamEvent, () => null),
  calcAndUpdateUsage: optional((runUsage as any).calcAndUpdateUsage, async () => ({})),
  completeWorkspaceRunCheckpoint: optional((workspaceDiff as any).completeWorkspaceRunCheckpoint, () => undefined),
  extractResponseText: optional((responseUtils as any).extractResponseText, () => ''),
  flushResponseRunToDb: optional((responseStream as any).flushResponseRunToDb, () => undefined),
  getChatRunServer,
  getOrCreateSession,
  startWorkspaceRunCheckpoint: optional((workspaceDiff as any).startWorkspaceRunCheckpoint, () => undefined),
  updateContextTokenUsage: optional((runUsage as any).updateContextTokenUsage, () => undefined),
})
