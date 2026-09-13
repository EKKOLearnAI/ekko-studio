import { OPENCODE_FREE_PROVIDER, openCodeFreeRuntime } from '../../studio/contracts/opencode-free'
import { normalizeProviderExtraHeaders, normalizeProviderProxyUrl } from '../../studio/contracts/provider-request-options'
import { randomBytes } from 'crypto'
import type { AgentApiMode } from './types'

export interface AgentTargetInput {
  provider: string
  model: string
  baseUrl: string
  apiKey: string
  apiMode?: AgentApiMode
  reasoningEffort?: string
  agentId?: string
  agentSessionId?: string
  chatSessionId?: string
  extraHeaders?: Record<string, string>
  preserveClientIdentity?: boolean
  proxyUrl?: string
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

  constructor(private readonly keyParts: (input: NormalizedAgentTargetInput<T>) => string[]) {}

  register(input: T, persisted?: { token?: string }): RegisteredAgentTarget<T> {
    const normalized = {
      ...input,
      provider: input.provider.trim(),
      model: input.model.trim(),
      baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
      apiMode: input.apiMode || 'chat_completions',
      extraHeaders: normalizeProviderExtraHeaders(input.extraHeaders),
      preserveClientIdentity: input.preserveClientIdentity === true,
      proxyUrl: normalizeProviderProxyUrl(input.proxyUrl),
      ...(input.provider.trim() === OPENCODE_FREE_PROVIDER ? openCodeFreeRuntime(input.model.trim()) : {}),
    } as NormalizedAgentTargetInput<T>
    const key = JSON.stringify(this.keyParts(normalized))
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
    return target
  }

  find(routeKey: string): RegisteredAgentTarget<T> | null {
    for (const target of this.targets.values()) {
      if (target.routeKey === routeKey) return target
    }
    return null
  }

  removeWhere(predicate: (target: RegisteredAgentTarget<T>) => boolean): number {
    let removed = 0
    for (const [key, target] of this.targets) {
      if (!predicate(target)) continue
      this.targets.delete(key)
      removed += 1
    }
    return removed
  }
}
