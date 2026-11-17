import type { ReasoningCodec } from '../../studio/public/model-reasoning-codec'
import { assertProviderAvailable } from '../../studio/contracts/providers'
import { createHash, randomBytes } from 'crypto'
import { providerAccountId, providerRequestProfile } from '../../studio/public/provider-account'
import type { AgentApiMode } from './types'
import type { CanonicalResponsesEvent } from './adapters/responses-stream'

export interface AgentTargetInput {
  reasoningCodec?: ReasoningCodec
  requestHeaders?: Record<string, string>
  requestId?: string
  ownerUserId?: number
  signal?: AbortSignal
  profile?: string
  provider: string
  model: string
  baseUrl: string
  apiKey: string
  apiMode?: AgentApiMode
  reasoningEffort?: string
  agentId?: string
  agentSessionId?: string
  chatSessionId?: string
  onUsageEvent?: (event: CanonicalResponsesEvent, apiDuration?: number, baseUrl?: string) => void
}

export type NormalizedAgentTargetInput<T extends AgentTargetInput> = Omit<T, 'apiMode'> & {
  provider: string
  model: string
  baseUrl: string
  apiKey: string
  apiMode: AgentApiMode
}

export type RegisteredAgentTarget<T extends AgentTargetInput> = NormalizedAgentTargetInput<T> & {
  key: string
  routeKey: string
  token: string
  updatedAt: number
}

export class AgentTargetRegistry<T extends AgentTargetInput> {
  private targets = new Map<string, RegisteredAgentTarget<T>>()
  private routes = new Map<string, RegisteredAgentTarget<T>>()
  private tokens = new Map<string, RegisteredAgentTarget<T>>()

  constructor(private readonly keyParts: (input: NormalizedAgentTargetInput<T>) => string[]) {}

  register(input: T, persisted?: { token?: string }): RegisteredAgentTarget<T> {
    assertProviderAvailable(input.provider)
    const normalized = {
      ...input,
      ownerUserId: input.ownerUserId || providerAccountId(input.profile),
      profile: input.profile || providerRequestProfile() || 'default',
      provider: input.provider.trim(),
      model: input.model.trim(),
      baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
      apiMode: input.apiMode || 'chat_completions',
    } as NormalizedAgentTargetInput<T>
    // An older persisted credential may still be in use after a continuation
    // registered a new credential for the same session. Keep both identities.
    const key = JSON.stringify([normalized.ownerUserId, normalized.profile, normalized.requestId || '', ...this.keyParts(normalized),
      ...(persisted?.token ? [createHash('sha256').update(persisted.token).digest('hex')] : [])])
    const existing = this.targets.get(key)
    const routeKey = existing?.routeKey || Buffer.from(key, 'utf-8').toString('base64url')
    const token = existing?.token || persisted?.token?.trim() || `hwui_${randomBytes(24).toString('base64url')}`
    const target = {
      ...normalized,
      key,
      routeKey,
      token,
      updatedAt: Date.now(),
    } as RegisteredAgentTarget<T>

    this.targets.set(key, target)
    this.routes.set(routeKey, target)
    this.tokens.set(token, target)
    return target
  }

  find(routeKey: string): RegisteredAgentTarget<T> | null {
    return this.routes.get(routeKey) || null
  }

  findByToken(token: string): RegisteredAgentTarget<T> | null {
    if (!token.startsWith('hwui_')) return null
    return this.tokens.get(token) || null
  }

  removeWhere(predicate: (target: RegisteredAgentTarget<T>) => boolean): number {
    let removed = 0
    for (const [key, target] of this.targets) {
      if (!predicate(target)) continue
      this.targets.delete(key)
      this.routes.delete(target.routeKey)
      this.tokens.delete(target.token)
      removed += 1
    }
    return removed
  }
}
