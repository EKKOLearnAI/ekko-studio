import { providerRequestProfile } from '../../public/provider-account'
import { qualifyModelRoute as qualifiedId, providerRouteNamespace, canonicalModelRoute } from '../../public/model-routing'
import { getSessionAvailableModelGroups } from '../../public/session-agent-runtime'
import { resolveProviderCatalogApiMode } from '../../contracts/providers'
import { resolveProviderUpstream } from '../../public/provider-upstream'
import { findModelApiKey } from './keys'

interface ModelGroup {
  provider: string
  models: string[]
  base_url?: string
  api_key?: string
  api_mode?: string
  api_mode_by_model?: Record<string, string>
  model_meta?: Record<string, { disabled?: boolean }>
}


export function apiMode(group: ModelGroup, model: string): string | undefined {
  return group.api_mode_by_model?.[model] || group.api_mode || resolveProviderCatalogApiMode(group.provider, model)
}

function supported(group: ModelGroup, model: string): boolean {
  return !['bedrock_converse', 'codex_app_server'].includes(apiMode(group, model) || '')
}

interface CatalogEntry { profile: string; group: ModelGroup; model: string }
function callable(entry: CatalogEntry): boolean {
  return supported(entry.group, entry.model) && !entry.group.model_meta?.[entry.model]?.disabled
}

async function isSelfModelApi(group: ModelGroup, profile: string): Promise<boolean> {
  if (!group.base_url) return false
  let url: URL
  try { url = new URL(group.base_url) } catch { return false }
  if (!['http:', 'https:'].includes(url.protocol) || !/\/api\/ekko-studio\/models(?:\/v1)?$/.test(url.pathname.replace(/\/+$/, ''))) return false
  // A locally issued key identifies this instance even behind a proxy or LAN URL.
  // Do not re-export the cached catalog of a provider pointing back to ourselves.
  // Catalog credentials are redacted. Resolve only this potential self-reference
  // through the direct upstream port, never through the Agent gateway client.
  const key = group.api_key || (await resolveProviderUpstream({ profile, provider: group.provider, model: group.models[0] })).apiKey || ''
  return key.startsWith('studio_model_') || findModelApiKey(key.trim()) !== null
}

export async function unifiedCatalog(profiles: string[]): Promise<Map<string, CatalogEntry>> {
  const names = [profiles[0] || providerRequestProfile() || 'default']
  const groupsByProfile = await Promise.all(names.map(profile => getSessionAvailableModelGroups(profile) as Promise<ModelGroup[]>))
  const catalog = new Map<string, CatalogEntry>()
  for (const [index, groups] of groupsByProfile.entries()) {
    for (const group of groups) {
      // MoA presets require agent orchestration and are not public API models.
      if (group.provider === 'moa' || await isSelfModelApi(group, names[index])) continue
      for (const model of group.models) {
        const id = qualifiedId(await providerRouteNamespace(names[index], group.provider), model)
        const entry = { profile: names[index], group, model }
        const existing = catalog.get(id)
        // Keep a callable configuration over a disabled/unsupported duplicate.
        // Otherwise the caller's stable Profile order wins, independent of fetch timing.
        if (!existing || (!callable(existing) && callable(entry))) catalog.set(id, entry)
      }
    }
  }
  return catalog
}

export async function listApiModels(profiles: string[], allowedModels?: readonly string[]) {
  const catalog = await unifiedCatalog(profiles)
  const allowed = allowedModels === undefined ? undefined : new Set(await Promise.all(allowedModels.map(canonicalModelRoute)))
  const data = [...catalog].filter(([id]) => !allowed || allowed.has(id)).map(([id, entry]) => ({
    id, object: 'model', created: 0, owned_by: entry.group.provider,
    api_mode: apiMode(entry.group, entry.model) || null,
    responses_supported: callable(entry), type: 'model', display_name: entry.model, created_at: '1970-01-01T00:00:00Z',
  }))
  return { object: 'list', data, has_more: false, first_id: data[0]?.id || null, last_id: data.at(-1)?.id || null }
}
