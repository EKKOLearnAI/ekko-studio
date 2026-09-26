import { request } from './client'

export type AgentStatusId = 'hermes' | 'ekko-agent' | 'claude-code' | 'codex' | 'pi' | 'grok' | 'opencode' | 'dsh' | 'cursor'
export type AgentStatusSource = 'managed-runtime' | 'user-cli' | 'built-in' | 'not-installed'

export interface AgentStatusRecord {
  id: AgentStatusId
  installed: boolean
  source: AgentStatusSource
  path: string
  version: string
  error?: string
}

export interface AgentStatusSnapshot {
  revision: number
  updatedAt: string
  agents: AgentStatusRecord[]
}

export interface AgentAvailabilityRecord {
  id: AgentStatusId
  installed: boolean
  source: AgentStatusSource
}

export interface AgentAvailabilitySnapshot {
  revision: number
  updatedAt: string
  agents: AgentAvailabilityRecord[]
}

export type AgentInstallationState = 'installed' | 'not-installed' | 'unknown'

const AGENT_STATUS_ALIASES: Record<string, AgentStatusId> = {
  hermes: 'hermes',
  ekko: 'ekko-agent',
  'ekko-agent': 'ekko-agent',
  claude: 'claude-code',
  'claude-code': 'claude-code',
  codex: 'codex',
  pi: 'pi',
  grok: 'grok',
  opencode: 'opencode',
  dsh: 'dsh',
  cursor: 'cursor',
}

export function resolveAgentStatusId(agent: string): AgentStatusId | null {
  return AGENT_STATUS_ALIASES[agent.trim().toLowerCase()] || null
}

export function isAgentStatusAvailable(
  snapshot: AgentStatusSnapshot | null | undefined,
  agent: string,
): boolean {
  const id = resolveAgentStatusId(agent)
  if (!id) return false
  const status = snapshot?.agents.find(item => item.id === id)
  if (!status?.installed || status.source === 'not-installed') return false
  return id !== 'hermes' || Boolean(status.path)
}

export function agentInstallationState(
  snapshot: AgentAvailabilitySnapshot | AgentStatusSnapshot | null | undefined,
  agent: string,
): AgentInstallationState {
  const id = resolveAgentStatusId(agent)
  if (!id) return 'unknown'
  const status = snapshot?.agents.find(item => item.id === id)
  if (!status) return 'unknown'
  return status.installed && status.source !== 'not-installed'
    ? 'installed'
    : 'not-installed'
}

export async function fetchAgentAvailabilitySnapshot(): Promise<AgentAvailabilitySnapshot> {
  return request<AgentAvailabilitySnapshot>('/api/agents/availability')
}

export async function fetchAgentStatusSnapshot(): Promise<AgentStatusSnapshot> {
  return request<AgentStatusSnapshot>('/api/agents/status')
}
