/**
 * Client-side capability filtering for OrcaRouter model selectors.
 *
 * The server computes the authoritative capability-filtered catalog and returns
 * it on each provider group as `capability_models`. These helpers pick the right
 * bucket for an entry point and decide whether an already-selected model is
 * still usable, so every AI input surface filters the *options* rather than
 * merely blocking the send.
 */

export type ModelCapability = 'chat' | 'chat-image' | 'chat-audio' | 'chat-video' | 'embedding' | 'image' | 'video' | 'rerank'

export const ORCAROUTER_PROVIDER_IDS = ['orcarouter', 'orcarouter-oauth'] as const

export function isOrcaRouterProvider(provider: unknown): boolean {
  const id = typeof provider === 'string' ? provider.trim().toLowerCase() : ''
  return (ORCAROUTER_PROVIDER_IDS as readonly string[]).includes(id)
}

export interface CapabilityCatalogGroup {
  provider: string
  models: string[]
  capability_models?: Partial<Record<ModelCapability, string[]>>
  capability_catalog?: {
    source: 'live' | 'seed'
    degraded: boolean
    reason?: string
  }
}

/**
 * The model options an entry point may offer. For OrcaRouter providers this is
 * the server's capability-filtered list; for every other provider it is the
 * provider's existing model list, unchanged.
 */
export function modelsForCapability(
  group: CapabilityCatalogGroup | undefined | null,
  capability: ModelCapability = 'chat',
): string[] {
  if (!group) return []
  if (!isOrcaRouterProvider(group.provider)) return group.models
  return group.capability_models?.[capability] || []
}

/**
 * Restore a stored model only when it is still in the compatible list. A stale
 * selection is cleared rather than silently kept, which would send an
 * incompatible model to an entry point that cannot use it.
 */
export function reconcileSelectedModel(
  group: CapabilityCatalogGroup | undefined | null,
  selected: string,
  capability: ModelCapability = 'chat',
): { model: string; cleared: boolean } {
  const options = modelsForCapability(group, capability)
  if (!selected) return { model: options[0] || '', cleared: false }
  if (options.includes(selected)) return { model: selected, cleared: false }
  return { model: options[0] || '', cleared: true }
}

export function capabilityCatalogStatus(
  group: CapabilityCatalogGroup | undefined | null,
): { degraded: boolean; source: 'live' | 'seed' | 'unknown'; reason?: string } {
  const catalog = group?.capability_catalog
  if (!catalog) return { degraded: false, source: 'unknown' }
  return {
    degraded: catalog.degraded === true,
    source: catalog.source,
    ...(catalog.reason ? { reason: catalog.reason } : {}),
  }
}
