export type AgentBridgeHealthPayload = {
  status: string
  reachable: boolean
  ready?: boolean
  running?: boolean
  attached?: boolean
  starting?: boolean
  stopping?: boolean
  restart_scheduled?: boolean
  restart_attempts?: number
  endpoint_kind?: 'ipc' | 'tcp' | 'unknown'
  pid?: number
  error?: string
}

export interface StudioHealthDependencies {
  platform: string
  getPrimaryAgentVersion(): Promise<string>
  getPrimaryAgentBridgeHealth(): Promise<AgentBridgeHealthPayload>
  isDockerContainer(): boolean
}
