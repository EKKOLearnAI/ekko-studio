import { StudioError, type AgentContextConfiguration, type AgentNativeContextConfiguration, type AgentMcpServerConfiguration, type ExecutionScope } from '../../contracts/plugins'
import type { AgentInstance } from '../../repositories/agent-execution-store'
import { NativeMcpCredentialSlot } from '../mcp/native-credential-slot'
import { STUDIO_MANAGED_MCP_ENV } from '../mcp/managed-config'
import { studioMcpCapabilities } from '../../public/runs/mcp-capabilities'
import { studioMcpUsageGuidelines } from '../../public/runs/prompt'

export interface NativeAgentContext {
  prepare(runId: string, signal: AbortSignal): Promise<AgentNativeContextConfiguration>
  end(): Promise<void>
  close(): Promise<void>
}
export interface NativeAgentTurnBinding { contextId: string; sessionId: string; instructions: string; interactive?: boolean }

/** No vendor branches or native Home edits: adapters only consume the prepared DTO. */
export function createNativeAgentContext(instance: AgentInstance, scope: ExecutionScope, runtimeSignal: AbortSignal,
  authorize: (runId: string) => void, options: { bindTurn?(runId: string, signal: AbortSignal): NativeAgentTurnBinding | Promise<NativeAgentTurnBinding> } = {}): NativeAgentContext | undefined {
  const settings = instance.config.studioMcp as AgentContextConfiguration['studioMcp']
  if (settings?.enabled !== true) return undefined
  const userId = Number(scope.principal.id)
  if (scope.principal.kind !== 'user' || !Number.isSafeInteger(userId) || userId < 1) throw new StudioError('FORBIDDEN', 'Native Studio MCP requires a local user')
  const servers = Object.fromEntries((['api', 'browser', 'devices', 'use'] as const).filter(toolset => settings[toolset] !== false)
    .map(toolset => [`ekko-studio-${toolset}`, { env: { [STUDIO_MANAGED_MCP_ENV]: '1' } }]))
  const slot = new NativeMcpCredentialSlot()
  let turn: Awaited<ReturnType<NativeMcpCredentialSlot['begin']>> | undefined
  return {
    async prepare(runId, signal) {
      authorize(runId)
      const binding = scope.sessionId && settings.interaction !== false ? await options.bindTurn?.(runId, signal) : undefined
      authorize(runId)
      if (binding && binding.sessionId !== scope.sessionId) throw new StudioError('FORBIDDEN', 'Native MCP binding belongs to another chat')
      turn = await slot.begin({ ...servers, ...(binding ? { 'ekko-studio-interaction': { env: { [STUDIO_MANAGED_MCP_ENV]: '1' } } } : {}) },
        { sessionId: binding?.sessionId ?? scope.sessionId ?? `agent-run:${runId}`, runId, profile: scope.profileId, agentId: instance.agentTypeId, userId, ...(binding ? { contextId: binding.contextId } : {}),
        ...(binding ? { sessionTasks: binding.interactive !== false, userClarification: binding.interactive !== false } : {}),
        signal: AbortSignal.any([signal, runtimeSignal]), authorize: () => authorize(runId) })
      authorize(runId)
      const mcpServers = Object.fromEntries(Object.entries(turn.servers).map(([name, value]) => {
        const server = value as { command: string; args: string[]; env: Record<string, string> }
        return [name, { command: server.command, args: server.args, env: server.env } satisfies AgentMcpServerConfiguration]
      }))
      return { mcpServers, systemPrompt: studioMcpUsageGuidelines(studioMcpCapabilities(mcpServers)),
        ...(turn.contextId ? { turnInstructions: [binding?.instructions, `Studio MCP context for this turn: ${turn.contextId}. Pass context_id="${turn.contextId}" on every Studio MCP call, including compact toolset wrappers. This context supersedes all previous turns and expires when the current Run ends.`].filter(Boolean).join('\n\n') } : {}) }
    },
    async end() { await turn?.dispose(); turn = undefined },
    close: () => slot.close(),
  }
}
