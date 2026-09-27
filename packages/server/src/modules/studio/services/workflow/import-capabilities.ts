import { createHash } from 'crypto'
import { isScopedCodingAgentAuthProvider } from '../../contracts/provider-compat'

interface CapabilityGroup { provider: string; models: string[]; api_mode?: string }

const SCOPED_CODING_AGENT_API_MODES = new Set(['chat_completions', 'codex_responses', 'anthropic_messages'])

function normalizedCapabilityTuples(groups: CapabilityGroup[]): string[] {
  return groups.flatMap(group => (group.models || []).map(model => `${group.provider}\u0000${model}\u0000${group.api_mode || ''}`)).sort()
}

function normalizedProviderModels(groups: CapabilityGroup[]): Set<string> {
  return new Set(groups.flatMap(group => (group.models || []).map(model => `${group.provider}\u0000${model}`)))
}

export function workflowImportEnvironmentRevision(groups: CapabilityGroup[]): string {
  return createHash('sha256').update(JSON.stringify({ models: normalizedCapabilityTuples(groups) })).digest('hex')
}

export function assertWorkflowImportCapabilities(nodes: unknown[], groups: CapabilityGroup[]): void {
  const configured = new Set(normalizedCapabilityTuples(groups))
  const configuredProviderModels = normalizedProviderModels(groups)
  for (const raw of nodes) {
    const node = raw && typeof raw === 'object' ? raw as Record<string, any> : {}
    const data = node.data && typeof node.data === 'object' ? node.data as Record<string, any> : {}
    const agent = typeof data.agent === 'string' ? data.agent.trim() : ''
    if (data.agentMode === 'global' && (agent === 'codex' || agent === 'claude-code' || agent === 'pi' || agent === 'grok' || agent === 'cursor' || (agent === 'opencode' || agent === 'dsh'))) continue
    const provider = typeof data.provider === 'string' ? data.provider.trim() : ''
    const model = typeof data.model === 'string' ? data.model.trim() : ''
    const apiMode = typeof data.apiMode === 'string' ? data.apiMode.trim() : ''
    if (!provider && !model && !apiMode) continue
    const exact = `${provider}\u0000${model}\u0000${apiMode}`
    const providerModel = `${provider}\u0000${model}`
    const hermesTargetAvailable = agent === 'hermes' && configuredProviderModels.has(providerModel)
    const ekkoAgent = agent === 'ekko-agent'
    const scopedExternalCodingAgent = agent === 'codex' || agent === 'claude-code' || agent === 'pi' || agent === 'grok' || agent === 'cursor' || (agent === 'opencode' || agent === 'dsh')
    const scopedCodingAgentProviderBlocked = scopedExternalCodingAgent && isScopedCodingAgentAuthProvider(provider)
    const codingAgentTargetAvailable = (ekkoAgent || scopedExternalCodingAgent)
      && !scopedCodingAgentProviderBlocked
      && SCOPED_CODING_AGENT_API_MODES.has(apiMode)
      && configuredProviderModels.has(providerModel)
    if (scopedCodingAgentProviderBlocked || (!configured.has(exact) && !hermesTargetAvailable && !codingAgentTargetAvailable)) {
      throw Object.assign(new Error(`workflow node ${String(node.id || '?')} target capability is unavailable in profile`), { status: 409 })
    }
  }
}
