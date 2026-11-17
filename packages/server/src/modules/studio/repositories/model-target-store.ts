import { createHash } from 'node:crypto'
import { chmod, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { safeFileStore } from '../public/safe-file-store'
import { providerAccountHome, providerAccountId } from '../public/provider-account'
import type { ModelGatewayProtocol } from '../public/model-gateway-adapters'

export interface SavedModelTarget {
  protocol: ModelGatewayProtocol
  token: string
  ownerUserId: number
  profile: string
  provider: string
  model: string
  apiMode?: string
  reasoningEffort?: string
  agentId?: string
  agentSessionId?: string
  chatSessionId?: string
}

/** Persist only the gateway binding; upstream credentials stay in the account store. */
export async function saveModelTarget(protocol: ModelGatewayProtocol, input: Omit<SavedModelTarget, 'token' | 'protocol' | 'ownerUserId'>, token: string): Promise<void> {
  const ownerUserId = providerAccountId(input.profile)
  const dir = join(providerAccountHome(), 'model-targets')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${createHash('sha256').update(token).digest('hex')}.json`)
  const { profile, provider, model, apiMode, reasoningEffort, agentId, agentSessionId, chatSessionId } = input
  await safeFileStore.writeText(path, JSON.stringify({ protocol, token, ownerUserId, profile, provider, model, apiMode, reasoningEffort, agentId, agentSessionId, chatSessionId }), { backup: false })
  await chmod(path, 0o600)
}

export async function savedModelTargets(): Promise<SavedModelTarget[]> {
  const dir = join(providerAccountHome(), 'model-targets')
  const result: SavedModelTarget[] = []
  for (const name of await readdir(dir).catch(() => [])) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
    try {
      const record = JSON.parse(await safeFileStore.readText(join(dir, name))) as SavedModelTarget
      if (record.ownerUserId === providerAccountId() && record.token?.startsWith('hwui_')) result.push(record)
    } catch { /* A damaged binding must not block other agents at startup. */ }
  }
  return result
}

/** Read one credential by its digest; never enumerate an account's history. */
export async function savedModelTarget(userId: number, token: string): Promise<SavedModelTarget | null> {
  if (!/^hwui_[A-Za-z0-9_-]{1,128}$/.test(token)) return null
  const path = join(providerAccountHome(userId), 'model-targets', `${createHash('sha256').update(token).digest('hex')}.json`)
  try {
    const record = JSON.parse(await safeFileStore.readText(path)) as SavedModelTarget
    if (!record || record.ownerUserId !== userId || record.token !== token
      || !['codex_responses', 'anthropic_messages', 'chat_completions', 'gemini_contents'].includes(record.protocol)
      || typeof record.profile !== 'string' || !record.profile
      || typeof record.provider !== 'string' || !record.provider
      || typeof record.model !== 'string' || !record.model) return null
    return record
  } catch (error: any) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  }
}
