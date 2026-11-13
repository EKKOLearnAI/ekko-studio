export type AgentLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface AgentLogFile {
  name: string
  size: string
  modified: string
}

export interface AgentLogRecord {
  timestamp: string | number
  level: AgentLogLevel
  category: string
  event: string
  sessionId?: string
  runId?: string
  turnId?: string
  data?: unknown
}

export interface AgentLogQuery {
  sessionId?: string
  runId?: string
  category?: string
  level?: AgentLogLevel
  event?: string
  text?: string
  after?: string
  limit: number
}

export interface StructuredAgentLogSource {
  filePath: string
  query(options: AgentLogQuery): AgentLogRecord[]
}

export interface StudioAgentLogDependencies {
  listPrimaryAgentLogFiles(): Promise<AgentLogFile[]>
  readPrimaryAgentLogs(
    name: string,
    lines: number,
    level?: string,
    session?: string,
    since?: string,
  ): Promise<string>
  getEkkoLogSource(profile: string): StructuredAgentLogSource | null
}
