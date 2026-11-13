export type GroupPrimaryAgentBridge = Record<string, any>
export type GroupPrimaryAgentBridgeContextEstimate = any
export type GroupPrimaryAgentBridgeMessage = any
export type GroupPrimaryAgentBridgeOutput = any

export interface GroupChatAgentRuntimeDependencies {
  createPrimaryAgentBridge(options?: Record<string, unknown>): GroupPrimaryAgentBridge
  cancelEkkoClarification(...args: any[]): any
  respondToEkkoToolApproval(...args: any[]): any
  respondToEkkoClarification(...args: any[]): any
  createEkkoModelClient(...args: any[]): any
  resolveEkkoModelProviderConfigs(...args: any[]): any
  getEkkoAgent(profile: string): any
  resolveEkkoProviderRuntimeConfig(...args: any[]): Promise<any>
  createEkkoAuthorizedProviderFetch(...args: any[]): any
  drainPrimaryAgentSessions(profile: string): Promise<any>
  getAvailableModelGroups(profile: string): Promise<any[]>
}

let dependencies: GroupChatAgentRuntimeDependencies | null = null

export function configureGroupChatAgentRuntime(next: GroupChatAgentRuntimeDependencies): void {
  dependencies = next
}

function configured(): GroupChatAgentRuntimeDependencies {
  if (!dependencies) throw new Error('Studio group chat Agent runtime has not been configured')
  return dependencies
}

export const createGroupPrimaryAgentBridge = (options?: Record<string, unknown>) => configured().createPrimaryAgentBridge(options)
export const cancelGroupEkkoClarification = (...args: any[]) => configured().cancelEkkoClarification(...args)
export const respondToGroupEkkoToolApproval = (...args: any[]) => configured().respondToEkkoToolApproval(...args)
export const respondToGroupEkkoClarification = (...args: any[]) => configured().respondToEkkoClarification(...args)
export const createGroupEkkoModelClient = (...args: any[]) => configured().createEkkoModelClient(...args)
export const resolveGroupEkkoModelProviderConfigs = (...args: any[]) => configured().resolveEkkoModelProviderConfigs(...args)
export const getGroupEkkoAgent = (profile: string) => configured().getEkkoAgent(profile)
export const resolveGroupEkkoProviderRuntimeConfig = (...args: any[]) => configured().resolveEkkoProviderRuntimeConfig(...args)
export const createGroupEkkoAuthorizedProviderFetch = (...args: any[]) => configured().createEkkoAuthorizedProviderFetch(...args)
export const drainGroupPrimaryAgentSessions = (profile: string) => configured().drainPrimaryAgentSessions(profile)
export const getGroupAvailableModelGroups = (profile: string) => configured().getAvailableModelGroups(profile)
