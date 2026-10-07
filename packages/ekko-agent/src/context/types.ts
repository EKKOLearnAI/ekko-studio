import type { ModelClient, ModelRequest } from '../model/types'
import type { AgentTool } from '../tools/types'

export interface AgentContextManagerRequest {
  conversationId: string
  profileId?: string
  modelClient: ModelClient
}

/** Opt-in, asynchronous context ownership contract. Native remains the host default. */
export interface AgentContextManager {
  readonly strategy: string
  tools(signal?: AbortSignal): Promise<AgentTool[]>
  prepareRequest(request: ModelRequest, binding: AgentContextManagerRequest): Promise<ModelRequest>
}
