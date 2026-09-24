export interface EkkoAgentInfo {
  name: string
  displayName: string
  packageName: string
}

export function createEkkoAgentInfo(): EkkoAgentInfo {
  return {
    name: 'ekko-agent',
    displayName: 'Ekko Agent',
    packageName: 'ekko-agent',
  }
}

export * from './model/errors'
export * from './agent/manager'
export * from './agent/modules'
export * from './agent/profile-agent'
export * from './model/authorized-providers'
export * from './model/authorization'
export * from './model/authorized-client'
export * from './model/manager'
export * from './model/messages'
export * from './model/provider-presets'
export * from './model/provider-config'
export * from './model/registry'
export * from './model/tokens'
export * from './model/types'
export * from './database'
export * from './config'
export * from './config-store'
export * from './jev'
export * from './directories'
export * from './diagnostics'
export * from './recovery'
export * from './setup'
export * from './conversations/schema'
export * from './conversations/store'
export * from './conversations/types'
export * from './logging/file-logger'
export * from './logging/runtime-logger'
export * from './memory/context'
export * from './memory/paths'
export * from './memory/retrieval'
export * from './memory/schema'
export * from './memory/scope'
export * from './memory/service'
export * from './memory/store'
export * from './memory/tools'
export * from './memory/types'
export * from './runtime/events'
export * from './runtime/manager'
export * from './runtime/runtime'
export * from './runtime/system-prompt'
export * from './runtime/types'
export * from './skills/review'
export * from './skills/manager'
export * from './skills/external-directories'
export * from './skills/types'
export * from './tools/browser'
export * from './tools/approval'
export * from './tools/clarify'
export * from './tools/code-exec'
export * from './tools/delegation'
export * from './tools/files'
export * from './tools/images'
export * from './tools/manager'
export * from './tools/registry'
export * from './tools/recovery'
export * from './tools/skills'
export * from './tools/terminal'
export * from './tools/tool-result-sanitizer'
export * from './tools/types'
export {
  AnthropicMessagesModelClient,
  normalizeAnthropicResponse,
  toAnthropicMessagesPayload,
} from './model/providers/anthropic'
export {
  CustomRuntimeModelClient,
} from './model/providers/custom-runtime'
export {
  GeminiContentsModelClient,
  normalizeGeminiResponse,
  toGeminiContentsPayload,
} from './model/providers/gemini'
export {
  OpenAICompatibleModelClient,
  normalizeOpenAIChatResponse,
  toOpenAIChatPayload,
} from './model/providers/openai-compatible'
export {
  OpenAIResponsesModelClient,
  normalizeOpenAIResponsesResponse,
  toOpenAIResponsesPayload,
} from './model/providers/openai-responses'
export {
  PromptCompletionModelClient,
  normalizePromptCompletionResponse,
  toPromptCompletionPayload,
} from './model/providers/prompt-completion'

export { UpdatePlanTool } from './tools/plan'
export type { AgentPlanStep, AgentPlanUpdate, AgentTaskPlan } from './tools/plan'
