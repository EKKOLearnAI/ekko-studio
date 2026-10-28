import type { MemoryService } from '../../../../../ekko-agent/src/memory/service'
import type { MemoryRuntimeIdentity } from '../../../../../ekko-agent/src/memory/types'
import type { AgentRuntimeRunInput, AgentRuntimeRunResult, AgentRuntimeContextEstimate, AgentRuntimeBoundaryInterruptRequest, AgentRuntimeBoundaryInterruptResult } from '../../../../../ekko-agent/src/runtime/types'
import type { AgentMessage, AgentToolDefinition, ModelRequest, ModelResponse } from '../../../../../ekko-agent/src/model/types'
import type { PersonSelection, PersonTaskOrigin } from '../contracts/person'
import type { AuthenticatedUser } from '../middleware/auth'

export interface PersonModelCall {
  selection: PersonSelection
  messages: AgentMessage[]
  systemPrompt: string
  tools: Array<AgentToolDefinition & { execute(input: Record<string, unknown>, origin?: PersonTaskOrigin): Promise<unknown> }>
  maxSteps: number
  contextTokens: number
  compression?: { enabled: boolean; threshold: number }
  reasoningEffort?: ModelRequest['reasoningEffort']
  signal: AbortSignal
  beforeRequest?: () => void
  onEvent?: (event: unknown) => void
  onUsage?: (response: ModelResponse) => void
  onSummaryUsage?: (response: ModelResponse) => void
  summaryCache?: { get(key: string): string | undefined; set(key: string, summary: string): void }
  onPrepared?: (request: ModelRequest) => void
}
export interface PersonChatAgentOptions extends Pick<PersonModelCall, 'selection' | 'tools' | 'systemPrompt' | 'maxSteps' | 'contextTokens' | 'compression' | 'beforeRequest' | 'summaryCache' | 'onSummaryUsage'> {
  workspace: string
  memory?: { service: MemoryService; identity: MemoryRuntimeIdentity }
  loadHistory?: (query: string) => AgentMessage[]
}
export interface PersonResultDelivery {
  user: AuthenticatedUser
  origin: PersonTaskOrigin
  executionId: string
  taskId: string
  title: string
  status: string
  output: string
  error: string
}
export interface PersonRuntimePort {
  deliver(input: PersonResultDelivery): Promise<void>
  chatAgent?(input: PersonChatAgentOptions): {
    sessionWorkspaceDirectory(sessionId: string): string
    requestBoundaryInterrupt(request: AgentRuntimeBoundaryInterruptRequest): AgentRuntimeBoundaryInterruptResult
    estimateContext(input: AgentRuntimeRunInput): Promise<AgentRuntimeContextEstimate>
    run(input: AgentRuntimeRunInput): Promise<AgentRuntimeRunResult>
  }
  modelConfig(profile: string): Promise<{ default: string; default_provider: string; groups: Array<{
    provider: string; label?: string; models: string[]; api_mode?: string; api_mode_by_model?: Record<string, string | null>
    model_meta?: Record<string, { alias?: string; disabled?: boolean; reasoning?: boolean; reasoning_efforts?: string[] }>
  }> }>
  model(input: PersonModelCall): Promise<string>
  nativeModels(runtime: string): Promise<{ status: string; models: Array<{ id: string; name: string; isDefault?: boolean; reasoningEffort?: string; reasoningEfforts?: string[] }> }>
  execute(input: { user: AuthenticatedUser; selection: PersonSelection; sessionId: string; workspace: string; prompt: string | import('../contracts/runs/session').ContentBlock[]; displayInput?: string; signal: AbortSignal; onEvent(event: string, payload: Record<string, unknown>): void }): Promise<{ ok: boolean; output?: string; error?: string }>
  answer(sessionId: string, id: string, response: string, approval: boolean): Promise<boolean>
  stop(sessionId: string): Promise<void>
}
let port: PersonRuntimePort | undefined
export function configurePersonRuntime(value: PersonRuntimePort) { port = value }
export function personRuntime(): PersonRuntimePort {
  if (!port) throw Object.assign(new Error('Person runtime is unavailable'), { status: 503 })
  return port
}
