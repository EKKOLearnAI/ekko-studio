import type { NativeCodingAgentId } from '../../../studio/contracts/agents/native-coding-agents'
import type { ScopedRuntimeInput, ScopedRuntimeConfig } from '../runtime/scoped-config'
import type { ManagedCodingAgentRun } from '../runtime/run-manager'
import type { NativeTurnHost } from '../runtime/turn-host'
import type { CodingAgentImageInput } from '../../protocol/types'
import { startAcpChatTurn } from '../runtime/acp-chat-turn'
import { startZcodeChatTurn } from '../zcode/chat-turn'
import { QWEN_DEFINITION } from '../qwen/definition'
import { KIMI_DEFINITION } from '../kimi/definition'
import { CODEBUDDY_DEFINITION } from '../codebuddy/definition'
import { QODER_DEFINITION } from '../qoder/definition'
import { COPILOT_DEFINITION } from '../copilot/definition'
import { ZCODE_DEFINITION } from '../zcode/definition'
import { prepareQwenScopedRuntime } from '../qwen/runtime-config'
import { prepareKimiScopedRuntime } from '../kimi/runtime-config'
import { prepareCodeBuddyScopedRuntime, codebuddyScopedUsesChatCompletions } from '../codebuddy/runtime-config'
import { prepareCopilotScopedRuntime, copilotScopedUsesChatCompletions } from '../copilot/runtime-config'
import { prepareZcodeScopedRuntime } from '../zcode/runtime-config'
import type { CodingAgentEnvironment } from '../../contracts/environment'
import { checkKimiEnvironment } from '../kimi/environment'
import { checkCopilotEnvironment } from '../copilot/environment'
import { checkQoderPlatform } from '../qoder/environment'

interface NativeAgentAdapter {
  definition: { id: NativeCodingAgentId; name: string; provider: string; command: string; packageName: string; docsUrl: string; acpArgs: readonly string[] }
  prepareScoped?: (input: ScopedRuntimeInput) => Promise<ScopedRuntimeConfig>
  usesChatCompletions?: (model: string) => boolean
  startTurn: typeof startAcpChatTurn
  checkEnvironment?: (context: CodingAgentEnvironment) => Promise<Record<string, string>>
  checkPlatform?: (platform: NodeJS.Platform, arch: string) => void
}

const NATIVE_AGENT_ADAPTERS = {
  qwen: { definition: QWEN_DEFINITION, prepareScoped: prepareQwenScopedRuntime, startTurn: startAcpChatTurn },
  kimi: { definition: KIMI_DEFINITION, prepareScoped: prepareKimiScopedRuntime, startTurn: startAcpChatTurn, checkEnvironment: checkKimiEnvironment },
  codebuddy: { definition: CODEBUDDY_DEFINITION, prepareScoped: prepareCodeBuddyScopedRuntime, usesChatCompletions: codebuddyScopedUsesChatCompletions, startTurn: startAcpChatTurn },
  qoder: { definition: QODER_DEFINITION, startTurn: startAcpChatTurn, checkPlatform: checkQoderPlatform },
  copilot: { definition: COPILOT_DEFINITION, prepareScoped: prepareCopilotScopedRuntime, usesChatCompletions: copilotScopedUsesChatCompletions, startTurn: startAcpChatTurn, checkEnvironment: checkCopilotEnvironment },
  zcode: { definition: ZCODE_DEFINITION, prepareScoped: prepareZcodeScopedRuntime, startTurn: startZcodeChatTurn },
} satisfies Record<NativeCodingAgentId, NativeAgentAdapter>

export const NATIVE_CODING_AGENTS = Object.values(NATIVE_AGENT_ADAPTERS).map(adapter => adapter.definition)

export function checkNativeCodingAgentPlatform(agentId: NativeCodingAgentId): void {
  const adapter: NativeAgentAdapter = NATIVE_AGENT_ADAPTERS[agentId]
  adapter.checkPlatform?.(process.platform, process.arch)
}

export async function checkNativeCodingAgentEnvironment(agentId: NativeCodingAgentId, context: CodingAgentEnvironment): Promise<Record<string, string>> {
  const adapter: NativeAgentAdapter = NATIVE_AGENT_ADAPTERS[agentId]
  adapter.checkPlatform?.(context.platform, context.arch)
  return adapter.checkEnvironment?.(context) || {}
}

export function nativeScopedUsesChatCompletions(agentId: NativeCodingAgentId, model: string): boolean {
  const adapter: NativeAgentAdapter = NATIVE_AGENT_ADAPTERS[agentId]
  return adapter.usesChatCompletions?.(model) || false
}

export function prepareNativeScopedRuntime(input: ScopedRuntimeInput & { agentId: Exclude<NativeCodingAgentId, 'qoder'> }) {
  return NATIVE_AGENT_ADAPTERS[input.agentId].prepareScoped(input)
}

export function startNativeChatTurn(run: ManagedCodingAgentRun, input: string, systemPrompt: string, host: NativeTurnHost, images: CodingAgentImageInput[] = []) {
  const adapter = NATIVE_AGENT_ADAPTERS[run.launch.agentId as NativeCodingAgentId]
  if (!adapter) throw new Error('Unknown native coding agent')
  adapter.startTurn(adapter.definition, run, input, systemPrompt, host, images)
}
