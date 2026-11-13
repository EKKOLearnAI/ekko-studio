import { randomUUID } from 'node:crypto'
import {
  createGroupEkkoAuthorizedProviderFetch, createGroupEkkoModelClient,
  resolveGroupEkkoModelProviderConfigs, getGroupEkkoAgent,
  resolveGroupEkkoProviderRuntimeConfig,
} from '../../public/group-chat-agent-runtime'

export interface BareModelAgentInput {
  profile: string
  provider: string
  model: string
  apiMode: string
  systemPrompt: string
  userPrompt: string
  roomId: string
  purpose: string
  timeoutMs?: number
}

export async function runBareModelAgent(input: BareModelAgentInput): Promise<string> {
  const runtimeConfig = await resolveGroupEkkoProviderRuntimeConfig({
    profile: input.profile,
    provider: input.provider,
    model: input.model,
    apiMode: input.apiMode || undefined,
  })
  const { providerConfig } = resolveGroupEkkoModelProviderConfigs({
    provider: runtimeConfig.provider,
    baseUrl: runtimeConfig.baseUrl,
    apiKey: runtimeConfig.apiKey,
    model: input.model,
    apiMode: runtimeConfig.apiMode,
    timeoutMs: input.timeoutMs ?? 300_000,
  })
  const result = await getGroupEkkoAgent(input.profile).runIsolated(
    {
      modelClient: createGroupEkkoModelClient(providerConfig, { fetch: createGroupEkkoAuthorizedProviderFetch({ profile: input.profile, provider: input.provider, model: input.model, accessToken: runtimeConfig.apiKey }) }),
      toolsEnabled: false,
      skillsEnabled: false,
      systemPrompt: input.systemPrompt,
      maxSteps: 1,
      maxModelRetries: 3,
      modelDefaults: { model: input.model },
    },
    {
      messages: [{ role: 'user', content: input.userPrompt }],
      memoryEnabled: false,
      metadata: {
        purpose: input.purpose,
        room_id: input.roomId,
        profile: input.profile,
        session_id: `gc_${input.purpose}_${randomUUID()}`,
      },
      logContext: {
        profile: input.profile,
        sessionId: `gc-${input.purpose}:${input.roomId}`,
      },
    },
  )
  const output = String(result.output.content || '').trim()
  if (!output) throw new Error('Model returned empty output')
  if (result.output.toolCalls?.length || result.output.finishReason === 'max_steps') {
    throw new Error('Model did not finish in one model step')
  }
  return output
}
