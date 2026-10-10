import type { CodingAgentRuntime } from '../../studio/contracts/agents/runtime'

export type CodingAgentModelStatus = 'ready' | 'empty' | 'not_installed' | 'auth_required' | 'unsupported' | 'timeout' | 'error'
export type CodingAgentModelSource = 'cli' | 'app-server' | 'control-protocol' | 'sdk' | 'acp' | 'config'
export type CodingAgentModelScope = 'available' | 'configured' | 'builtin'

/** Native identifiers are preserved, including provider prefixes and model aliases. */
export interface CodingAgentModel {
  id: string
  name: string
  provider?: string
  isDefault?: boolean
  hidden?: boolean
  contextWindow?: number
  maxOutputTokens?: number
  reasoningEfforts?: string[]
  inputModalities?: string[]
}

export interface CodingAgentModelCatalog {
  agentId: CodingAgentRuntime
  name: string
  status: CodingAgentModelStatus
  source: CodingAgentModelSource
  scope: CodingAgentModelScope
  models: CodingAgentModel[]
  checkedAt: string
  cached: boolean
}

export interface CodingAgentModelsResponse {
  agents: CodingAgentModelCatalog[]
}
