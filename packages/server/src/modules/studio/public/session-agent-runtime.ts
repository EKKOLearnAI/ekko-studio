export interface SessionAgentRuntimeDependencies {
  getAvailableModelGroups?: (profile: string) => Promise<any[]>
  deleteHermesSessionForProfile: (...args: any[]) => Promise<boolean>
  getHermesCliSession: (...args: any[]) => Promise<any>
  getHermesModelContextLength: (...args: any[]) => number
  getHermesSessionDetail: (...args: any[]) => Promise<any>
  getHermesSessionDetailForProfile: (...args: any[]) => Promise<any>
  getHermesSessionDetailPaginatedForProfile: (...args: any[]) => Promise<any>
  getExactHermesSessionDetailForProfile: (...args: any[]) => Promise<any>
  getHermesUsageStats: (...args: any[]) => Promise<any>
  listHermesSessionSummaries: (...args: any[]) => Promise<any[]>
  listHermesSessionSummaryGroups: (...args: any[]) => Promise<any>
  notifyHermesSessionModelChanged: (...args: any[]) => Promise<void>
  stopCodingAgentSessionRun: (...args: any[]) => any
  invalidateCodingAgentSessionRuntime: (...args: any[]) => any
}

let dependencies: SessionAgentRuntimeDependencies | null = null

export function configureSessionAgentRuntime(next: SessionAgentRuntimeDependencies): void {
  dependencies = next
}

function configured(): SessionAgentRuntimeDependencies {
  if (!dependencies) throw new Error('Studio session agent runtime has not been configured')
  return dependencies
}

export const deleteHermesSessionForProfile = (...args: any[]): Promise<boolean> => configured().deleteHermesSessionForProfile(...args)
export const getHermesCliSession = (...args: any[]): Promise<any> => configured().getHermesCliSession(...args)
export const getHermesModelContextLength = (...args: any[]): number => configured().getHermesModelContextLength(...args)
export const getHermesSessionDetail = (...args: any[]): Promise<any> => configured().getHermesSessionDetail(...args)
export const getHermesSessionDetailForProfile = (...args: any[]): Promise<any> => configured().getHermesSessionDetailForProfile(...args)
export const getHermesSessionDetailPaginatedForProfile = (...args: any[]): Promise<any> => configured().getHermesSessionDetailPaginatedForProfile(...args)
export const getExactHermesSessionDetailForProfile = (...args: any[]): Promise<any> => configured().getExactHermesSessionDetailForProfile(...args)
export const getHermesUsageStats = (...args: any[]): Promise<any> => configured().getHermesUsageStats(...args)
export const listHermesSessionSummaries = (...args: any[]): Promise<any[]> => configured().listHermesSessionSummaries(...args)
export const listHermesSessionSummaryGroups = (...args: any[]): Promise<any> => configured().listHermesSessionSummaryGroups(...args)
export const notifyHermesSessionModelChanged = (...args: any[]): Promise<void> => configured().notifyHermesSessionModelChanged(...args)
export const stopCodingAgentSessionRun = (...args: any[]) => configured().stopCodingAgentSessionRun(...args)
export const invalidateCodingAgentSessionRuntime = (...args: any[]) => configured().invalidateCodingAgentSessionRuntime(...args)

export const getSessionAvailableModelGroups = (profile: string): Promise<any[]> => configured().getAvailableModelGroups?.(profile) ?? Promise.resolve([])
