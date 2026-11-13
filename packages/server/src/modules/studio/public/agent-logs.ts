import type {
  AgentLogFile,
  AgentLogQuery,
  StructuredAgentLogSource,
  StudioAgentLogDependencies,
} from '../contracts/agents/logs'

export type {
  AgentLogFile,
  AgentLogLevel,
  AgentLogQuery,
  AgentLogRecord,
  StructuredAgentLogSource,
} from '../contracts/agents/logs'

let dependencies: StudioAgentLogDependencies | null = null

export function configureAgentLogs(next: StudioAgentLogDependencies): void {
  dependencies = next
}

function configured(): StudioAgentLogDependencies {
  if (!dependencies) throw new Error('Studio agent logs have not been configured')
  return dependencies
}

export function listPrimaryAgentLogFiles(): Promise<AgentLogFile[]> {
  return configured().listPrimaryAgentLogFiles()
}

export function readPrimaryAgentLogs(
  name: string,
  lines: number,
  level?: string,
  session?: string,
  since?: string,
): Promise<string> {
  return configured().readPrimaryAgentLogs(name, lines, level, session, since)
}

export function getEkkoLogSource(profile: string): StructuredAgentLogSource | null {
  return configured().getEkkoLogSource(profile)
}

export function queryAgentLogs(source: StructuredAgentLogSource, query: AgentLogQuery) {
  return source.query(query)
}
