import { logger } from '../../../studio/public/logging'
import {
  ORCAROUTER_OAUTH_PROVIDER,
  ORCAROUTER_PROVIDER,
  filterOrcaRouterModels,
  normalizeOrcaRouterCatalogModels,
  seedOrcaRouterCatalog,
  type OrcaRouterCapability,
  type OrcaRouterCatalogModel,
} from '../../../studio/public/orcarouter-catalog'
import { fetchOrcaRouterCapabilityCatalog } from './model-catalog-cache'
import { resolveOrcaRouterCredential } from './orcarouter-credential'

/**
 * Per-capability model lists for the OrcaRouter provider groups.
 *
 * Each AI entry point gets its own filter, computed from the single live
 * `GET /v1/models?capability=<name>` read. Live discovery is authoritative; the
 * verified seed is only used when the catalog endpoint cannot be read, and the
 * degraded state is reported to the client rather than hidden.
 */

export type OrcaRouterCapabilityKey = 'chat' | 'chat-image' | 'chat-audio' | 'chat-video' | 'embedding' | 'image' | 'video' | 'rerank'

const CAPABILITIES: OrcaRouterCapability[] = ['chat', 'embedding', 'image', 'video', 'rerank']

const CACHE_TTL_MS = 60_000

export interface OrcaRouterCapabilityCatalog {
  models: Record<OrcaRouterCapabilityKey, string[]>
  source: 'live' | 'seed'
  degraded: boolean
  reason?: string
}

interface CacheEntry {
  expiresAt: number
  value: OrcaRouterCapabilityCatalog
}

const cache = new Map<string, CacheEntry>()

export function resetOrcaRouterCapabilityCache(): void {
  cache.clear()
}

function bucketModels(models: OrcaRouterCatalogModel[]): Record<OrcaRouterCapabilityKey, string[]> {
  const chat = filterOrcaRouterModels(models, 'chat')
  const withModality = (modality: 'image' | 'audio' | 'video') =>
    chat.filter(model => model.input_modalities.includes(modality)).map(model => model.id)
  return {
    chat: chat.map(model => model.id),
    'chat-image': withModality('image'),
    'chat-audio': withModality('audio'),
    'chat-video': withModality('video'),
    embedding: filterOrcaRouterModels(models, 'embedding').map(model => model.id),
    image: filterOrcaRouterModels(models, 'image').map(model => model.id),
    video: filterOrcaRouterModels(models, 'video').map(model => model.id),
    rerank: filterOrcaRouterModels(models, 'rerank').map(model => model.id),
  }
}

function seedCatalog(): OrcaRouterCapabilityCatalog {
  const models: Record<OrcaRouterCapabilityKey, string[]> = {
    chat: seedOrcaRouterCatalog('chat').map(model => model.id),
    'chat-image': [],
    'chat-audio': [],
    'chat-video': [],
    embedding: [],
    image: [],
    video: [],
    rerank: [],
  }
  return {
    models,
    source: 'seed',
    degraded: true,
    reason: 'live catalog unavailable; showing the verified cold-start seed',
  }
}

export function isOrcaRouterCapabilityProvider(provider: unknown): boolean {
  const id = String(provider || '').trim().toLowerCase()
  return id === ORCAROUTER_PROVIDER || id === ORCAROUTER_OAUTH_PROVIDER
}

/**
 * Resolve the capability catalog for one profile. The key comes from the
 * credential seam, so the API-key and PKCE entries produce an identical result
 * and this path never learns which one supplied it.
 */
export async function resolveOrcaRouterCapabilityCatalog(
  profile: string,
  provider: string,
  options: { now?: () => number; force?: boolean } = {},
): Promise<OrcaRouterCapabilityCatalog> {
  const credential = await resolveOrcaRouterCredential(profile, provider)
  if (!credential?.apiKey) return seedCatalog()

  const key = `${credential.apiKey.slice(-8)}|${credential.baseUrl}`
  const now = (options.now || Date.now)()
  const cached = cache.get(key)
  if (!options.force && cached && cached.expiresAt > now) return cached.value

  try {
    const results = await Promise.all(
      CAPABILITIES.map(async capability => {
        const models = await fetchOrcaRouterCapabilityCatalog(credential.baseUrl, credential.apiKey, capability)
        return [capability, models] as const
      }),
    )
    const chat = results.find(([capability]) => capability === 'chat')?.[1] || []
    if (chat.length === 0) {
      logger.warn('[orcarouter] live chat catalog was empty profile=%s', profile)
      return seedCatalog()
    }
    const all: OrcaRouterCatalogModel[] = []
    for (const [, models] of results) {
      for (const model of models) {
        if (!all.some(existing => existing.id === model.id)) all.push(model)
      }
    }
    const value: OrcaRouterCapabilityCatalog = {
      models: bucketModels(all),
      source: 'live',
      degraded: false,
    }
    cache.set(key, { expiresAt: now + CACHE_TTL_MS, value })
    return value
  } catch (err) {
    logger.warn(err, '[orcarouter] capability catalog read failed profile=%s', profile)
    return seedCatalog()
  }
}

/** Model ids the text selectors may offer, without the extra metadata. */
export async function resolveOrcaRouterChatModels(profile: string, provider: string): Promise<string[]> {
  return (await resolveOrcaRouterCapabilityCatalog(profile, provider)).models.chat
}

export { ORCAROUTER_OAUTH_PROVIDER, ORCAROUTER_PROVIDER, normalizeOrcaRouterCatalogModels }
