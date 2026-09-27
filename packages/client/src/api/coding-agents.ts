import { request } from './client'
import type { ProviderApiMode } from './studio/provider-api-mode'

export type CodingAgentId = 'claude-code' | 'codex' | 'pi' | 'grok' | 'opencode' | 'dsh' | 'cursor'
export type ChatCodingAgentId = CodingAgentId | 'ekko-agent'
export const CODING_AGENT_API_MODES = [
  'chat_completions',
  'codex_responses',
  'anthropic_messages',
] as const satisfies readonly ProviderApiMode[]

export type CodingAgentApiMode = typeof CODING_AGENT_API_MODES[number]
export type CodingAgentLaunchMode = 'scoped' | 'global'

export function isCodingAgentApiMode(value: unknown): value is CodingAgentApiMode {
  return typeof value === 'string' && (CODING_AGENT_API_MODES as readonly string[]).includes(value)
}

export function inferCodingAgentApiMode(provider?: string | null, baseUrl?: string | null): CodingAgentApiMode {
  const providerKey = String(provider || '').toLowerCase()
  const normalizedBaseUrl = String(baseUrl || '').toLowerCase()

  if (
    providerKey.includes('claude') ||
    providerKey === 'anthropic' ||
    normalizedBaseUrl.includes('anthropic') ||
    normalizedBaseUrl.includes('/anthropic')
  ) {
    return 'anthropic_messages'
  }

  if (
    providerKey === 'deepseek' ||
    providerKey === 'lmstudio' ||
    normalizedBaseUrl.includes('deepseek') ||
    normalizedBaseUrl.includes('127.0.0.1') ||
    normalizedBaseUrl.includes('localhost')
  ) {
    return 'chat_completions'
  }

  return 'chat_completions'
}

export function normalizeCodingAgentApiMode(
  value: unknown,
  fallback: CodingAgentApiMode = 'codex_responses',
): CodingAgentApiMode {
  return isCodingAgentApiMode(value) ? value : fallback
}

export interface CodingAgentToolStatus {
  id: CodingAgentId
  name: string
  provider: string
  command: string
  packageName: string
  installed: boolean
  version: string
  rawVersion: string
  source?: 'user-cli' | 'not-installed'
  path?: string
  error?: string
}

export interface CodingAgentsStatus {
  tools: CodingAgentToolStatus[]
}

export interface CodingAgentMutationResult extends CodingAgentsStatus {
  updateState?: AgentUpdatePolicyState
  success: boolean
  tool: CodingAgentToolStatus
  message?: string
  code?: string
}

export interface CodingAgentUpdateResult {
  success: boolean
  tool: CodingAgentToolStatus
  latestVersion: string
  updateAvailable: boolean
  message?: string
}

export interface CodingAgentConfigFileContent {
  key: string
  path: string
  absolutePath: string
  language: string
  content: string
  exists: boolean
  size: number
  profile: string
  provider: string
  rootDir: string
}

export interface CodingAgentConfigScope {
  profile?: string | null
  provider?: string | null
}

export interface CodingAgentLaunchRequest {
  mode?: CodingAgentLaunchMode
  profile?: string | null
  provider?: string
  model?: string
  baseUrl?: string
  apiKey?: string
  apiMode?: CodingAgentApiMode
}

export interface CodingAgentLaunchResult {
  agentId: CodingAgentId
  mode: CodingAgentLaunchMode
  profile: string
  provider: string
  model: string
  apiMode?: CodingAgentApiMode
  rootDir: string
  workspaceDir: string
  command: string
  args: string[]
  env: Record<string, string>
  shellCommand: string
  files: Array<{ key: string; path: string; absolutePath: string }>
}

export interface CodingAgentNativeLaunchResult extends CodingAgentLaunchResult {
  nativeTerminal: true
  terminal: string
}

export interface CodingAgentRunStartResult extends CodingAgentLaunchResult {
  agentSessionId: string
  sessionId: string
  pid: number
}

export async function fetchCodingAgentsStatus(): Promise<CodingAgentsStatus> {
  return request<CodingAgentsStatus>('/api/coding-agents')
}

export async function installCodingAgent(id: CodingAgentId): Promise<CodingAgentMutationResult> {
  return request<CodingAgentMutationResult>(`/api/coding-agents/${id}/install`, { method: 'POST' })
}

export async function checkCodingAgentUpdate(id: CodingAgentId): Promise<CodingAgentUpdateResult> {
  return request<CodingAgentUpdateResult>(`/api/coding-agents/${id}/check-update`, { method: 'POST' })
}

export async function deleteCodingAgent(id: CodingAgentId): Promise<CodingAgentMutationResult> {
  return request<CodingAgentMutationResult>(`/api/coding-agents/${id}`, { method: 'DELETE' })
}

export async function readCodingAgentConfigFile(
  id: CodingAgentId,
  key: string,
  scope: CodingAgentConfigScope = {},
): Promise<CodingAgentConfigFileContent> {
  const params = new URLSearchParams()
  if (scope.profile) params.set('profile', scope.profile)
  if (scope.provider) params.set('provider', scope.provider)
  const query = params.toString()
  return request<CodingAgentConfigFileContent>(
    `/api/coding-agents/${id}/config-files/${encodeURIComponent(key)}${query ? `?${query}` : ''}`,
  )
}

export async function writeCodingAgentConfigFile(
  id: CodingAgentId,
  key: string,
  content: string,
  scope: CodingAgentConfigScope = {},
): Promise<CodingAgentConfigFileContent> {
  return request<CodingAgentConfigFileContent>(`/api/coding-agents/${id}/config-files/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify({ content, profile: scope.profile, provider: scope.provider }),
  })
}

export async function prepareCodingAgentLaunch(
  id: CodingAgentId,
  data: CodingAgentLaunchRequest,
): Promise<CodingAgentLaunchResult> {
  return request<CodingAgentLaunchResult>(`/api/coding-agents/${id}/launch/prepare`, {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function launchCodingAgentNativeTerminal(
  id: CodingAgentId,
  data: CodingAgentLaunchRequest,
): Promise<CodingAgentNativeLaunchResult> {
  return request<CodingAgentNativeLaunchResult>(`/api/coding-agents/${id}/launch/native`, {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function startCodingAgentRun(
  id: CodingAgentId,
  data: CodingAgentLaunchRequest & { sessionId: string },
): Promise<CodingAgentRunStartResult> {
  return request<CodingAgentRunStartResult>(`/api/coding-agents/${id}/runs`, {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function sendCodingAgentRunInput(sessionId: string, input: string): Promise<{ runId: string }> {
  return request<{ runId: string }>(`/api/coding-agents/runs/${encodeURIComponent(sessionId)}/input`, {
    method: 'POST',
    body: JSON.stringify({ input }),
  })
}

export async function stopCodingAgentRun(sessionId: string): Promise<{ stopped: boolean }> {
  return request<{ stopped: boolean }>(`/api/coding-agents/runs/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  })
}

export interface AgentUpdatePolicyState {
 autoUpdate: boolean
 autoUpdateSupported?: boolean
 status: 'unknown'|'checking'|'current'|'available'|'waiting'|'updating'|'failed'
 currentVersion: string
 latestVersion: string
 checkedAt: string
 error?: string
}
export function getAgentUpdatePolicies() { return request<{agents:Record<string,AgentUpdatePolicyState>}>('/api/coding-agents/update-policies') }
export function setAgentAutoUpdate(id: CodingAgentId, autoUpdate: boolean) { return request<{agents:Record<string,AgentUpdatePolicyState>}>(`/api/coding-agents/${id}/update-policy`, {method:'PUT',body:JSON.stringify({autoUpdate})}) }
