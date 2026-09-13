export type PrimaryAgentBridgeClient = Record<string, any>
export type PrimaryAgentBridgeContextEstimate = any
export type PrimaryAgentBridgeMessage = any
export type PrimaryAgentBridgeOutput = any
export type PrimaryAgentBridgeRunResult = any
export type ChatAgentMessage = any
export type ChatAgentClarificationRequest = any
export type ChatAgentOutputMessage = any
export type ChatAgentToolCall = any
export type ChatAgentToolApprovalRequest = any
export type ChatAgentToolResult = any
export type ChatModelClient = any
export type ChatModelEvent = any
export type ChatAgentRuntimeEvent = any
export type ChatModelProviderConfig = any
export type ChatModelReasoningEffort = any
export type ChatModelRequest = any
export type ChatModelResponse = any

export interface ChatAgentRuntimeDependencies {
  createPrimaryAgentBridge(options?: Record<string, unknown>): PrimaryAgentBridgeClient
  getPrimaryAgentBridgeManager(): any
  redactPrimaryAgentBridgeError(error: string | undefined, endpoint?: string, replacement?: string): string | undefined
  codingAgentRunManager: Record<string, any>
  sendCodingAgentRunInput(...args: any[]): any
  startCodingAgentRun(...args: any[]): any
  handleCodingAgentSessionCommand(...args: any[]): Promise<any>
  parseCodingAgentSessionCommand(...args: any[]): any
  getEkkoAgent(profile: string): any
  abortEkkoBackgroundTasks(...args: any[]): Promise<any>
  hasEkkoBackgroundTasks(...args: any[]): boolean
  createEkkoModelClient(...args: any[]): any
  resolveEkkoModelProviderConfigs(...args: any[]): any
  ekkoModelRequestTimeoutMs: number
  ekkoAgentReasoningText(...args: any[]): string
  normalizeEkkoAgentReasoning(...args: any[]): any
  serializeEkkoAgentReasoningDetails(...args: any[]): any
  waitForEkkoToolApproval(...args: any[]): Promise<any>
  waitForEkkoClarification(...args: any[]): Promise<any>
  resolveEkkoMcpServers(...args: any[]): any
  resolveEkkoProviderRuntimeConfig(...args: any[]): Promise<any>
  createEkkoAuthorizedProviderFetch(...args: any[]): any
  respondToEkkoToolApproval(...args: any[]): any
  respondToEkkoClarification(...args: any[]): any
}

let dependencies: ChatAgentRuntimeDependencies | null = null

export function configureChatAgentRuntime(next: ChatAgentRuntimeDependencies): void {
  dependencies = next
}

function configured(): ChatAgentRuntimeDependencies {
  if (!dependencies) throw new Error('Studio chat Agent runtime has not been configured')
  return dependencies
}

export const createPrimaryAgentBridge = (options?: Record<string, unknown>) => (
  configured().createPrimaryAgentBridge(options)
)
export const getPrimaryAgentBridgeManager = () => configured().getPrimaryAgentBridgeManager()
export const redactPrimaryAgentBridgeError = (
  error: string | undefined,
  endpoint?: string,
  replacement?: string,
) => configured().redactPrimaryAgentBridgeError(error, endpoint, replacement)

export const chatCodingAgentRunManager = {
  hasSession: (...args: any[]) => configured().codingAgentRunManager.hasSession(...args),
  stop: (...args: any[]) => configured().codingAgentRunManager.stop(...args),
  isSessionLaunchCompatible: (...args: any[]) => configured().codingAgentRunManager.isSessionLaunchCompatible(...args),
  isSessionProcessing: (...args: any[]) => configured().codingAgentRunManager.isSessionProcessing(...args),
  runIdForSession: (...args: any[]) => configured().codingAgentRunManager.runIdForSession(...args),
  interruptForQueueInsertion: (...args: any[]) => configured().codingAgentRunManager.interruptForQueueInsertion(...args),
  resolveApproval: (...args: any[]) => configured().codingAgentRunManager.resolveApproval(...args),
  resolveClarification: (...args: any[]) => configured().codingAgentRunManager.resolveClarification(...args),
}

export const sendChatCodingAgentRunInput = (...args: any[]) => configured().sendCodingAgentRunInput(...args)
export const startChatCodingAgentRun = (...args: any[]) => configured().startCodingAgentRun(...args)
export const handleChatCodingAgentSessionCommand = (...args: any[]) => configured().handleCodingAgentSessionCommand(...args)
export const parseChatCodingAgentSessionCommand = (...args: any[]) => configured().parseCodingAgentSessionCommand(...args)

export const getChatEkkoAgent = (profile: string) => configured().getEkkoAgent(profile)
export const abortChatEkkoBackgroundTasks = (...args: any[]) => configured().abortEkkoBackgroundTasks(...args)
export const hasChatEkkoBackgroundTasks = (...args: any[]) => configured().hasEkkoBackgroundTasks(...args)
export const createChatEkkoModelClient = (...args: any[]) => configured().createEkkoModelClient(...args)
export const resolveChatEkkoModelProviderConfigs = (...args: any[]) => configured().resolveEkkoModelProviderConfigs(...args)
export const getChatEkkoModelRequestTimeoutMs = () => configured().ekkoModelRequestTimeoutMs
export const chatEkkoAgentReasoningText = (...args: any[]) => configured().ekkoAgentReasoningText(...args)
export const normalizeChatEkkoAgentReasoning = (...args: any[]) => configured().normalizeEkkoAgentReasoning(...args)
export const serializeChatEkkoAgentReasoningDetails = (...args: any[]) => configured().serializeEkkoAgentReasoningDetails(...args)
export const waitForChatEkkoToolApproval = (...args: any[]) => configured().waitForEkkoToolApproval(...args)
export const waitForChatEkkoClarification = (...args: any[]) => configured().waitForEkkoClarification(...args)
export const resolveChatEkkoMcpServers = (...args: any[]) => configured().resolveEkkoMcpServers(...args)
export const resolveChatEkkoProviderRuntimeConfig = (...args: any[]) => configured().resolveEkkoProviderRuntimeConfig(...args)
export const createChatEkkoAuthorizedProviderFetch = (...args: any[]) => configured().createEkkoAuthorizedProviderFetch(...args)
export const respondToChatEkkoToolApproval = (...args: any[]) => configured().respondToEkkoToolApproval(...args)
export const respondToChatEkkoClarification = (...args: any[]) => configured().respondToEkkoClarification(...args)
