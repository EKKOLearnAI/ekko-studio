export interface PrimaryAgentBridgeRuntimeState {
  endpoint: string
  running: boolean
  ready: boolean
  pid?: number
  restartScheduled: boolean
  restartAttempts: number
}

export interface PrimaryAgentOpsDependencies {
  getBridgeRuntimeState(): PrimaryAgentBridgeRuntimeState
  pingBridge(endpoint: string): Promise<Record<string, unknown>>
}
