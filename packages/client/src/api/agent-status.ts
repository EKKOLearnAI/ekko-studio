import { syncPluginAgentOptions } from '@/utils/agent-options'
import type { StudioAgent } from '@/api/studio/agents'
import { request } from './client'

export type AgentStatusId = `plugin:${string}/${string}` | 'hermes' | 'ekko-agent' | 'claude-code' | 'codex' | 'pi' | 'grok' | 'opencode' | 'dsh' | 'cursor' | 'antigravity' | 'qwen' | 'kimi' | 'codebuddy' | 'qoder' | 'copilot' | 'zcode'
export type AgentStatusSource = 'plugin' | 'managed-runtime' | 'user-cli' | 'built-in' | 'not-installed'

export interface AgentStatusRecord {
  id: AgentStatusId
  installed: boolean
  source: AgentStatusSource
  path: string
  version: string
  error?: string
  compatibility?: { pinnedVersion: string; previousVersion: string; adapterRevision: number; verifiedVersion: string }
}

export interface AgentStatusSnapshot {
  revision: number
  updatedAt: string
  agents: AgentStatusRecord[]
}

export interface AgentAvailabilityRecord {
  available: boolean
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
  antigravity: 'antigravity',
  qwen: 'qwen',
  kimi: 'kimi',
  codebuddy: 'codebuddy',
  qoder: 'qoder',
  copilot: 'copilot',
  zcode: 'zcode',
}

export function resolveAgentStatusId(agent: string): AgentStatusId | null {
  if (/^plugin:[a-z][a-z0-9._-]*\/[a-z][a-z0-9._-]*$/.test(agent)) return agent as `plugin:${string}/${string}`
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

/** Uses the server's execution eligibility without exposing local installation paths. */
export function isAgentAvailable(
  snapshot: AgentAvailabilitySnapshot | null | undefined,
  agent: string,
): boolean {
  const id = resolveAgentStatusId(agent)
  return Boolean(id && snapshot?.agents.find(item => item.id === id)?.available === true)
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
  const value = await request<AgentAvailabilitySnapshot>('/api/agents/availability')
  syncPluginAgentOptions((value.agents || []).filter(agent => agent.id.startsWith('plugin:')).map(agent => ({ ...agent, origin: 'plugin' })) as unknown as StudioAgent[])
  return value
}

export async function fetchAgentStatusSnapshot(): Promise<AgentStatusSnapshot> {
  const value = await request<AgentStatusSnapshot>('/api/agents/status')
  syncPluginAgentOptions((value.agents || []).filter(agent => agent.id.startsWith('plugin:')).map(agent => ({ ...agent, origin: 'plugin' })) as unknown as StudioAgent[])
  return value
}
