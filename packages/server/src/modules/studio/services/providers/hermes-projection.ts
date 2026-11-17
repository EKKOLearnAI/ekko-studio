import { applySupplementalEdits, readSupplementalEdits, supplementalSections } from './supplemental-routing'
import { readConfigYamlForProfile } from '../../public/provider-config'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { chmod } from 'node:fs/promises'
import YAML from 'js-yaml'
import { config } from '../../public/config'
import { safeFileStore } from '../../public/safe-file-store'
import { internalModelCredential, providerProfileDir, providerSourceDir, providerAccountHome } from './account-store'
import { providerRouteNamespace, qualifyModelRoute, logicalModelSelection } from './model-routes'

interface Group { provider: string; models: string[]; base_url?: string }
let modelGroups: ((profile: string) => Promise<Group[]>) | undefined
export const configureProviderProjection = (resolver: NonNullable<typeof modelGroups>) => { modelGroups = resolver }
export const studioModelGatewayUrl = () => `http://127.0.0.1:${config.port}/api/ekko-studio/models/v1`

function parse(raw: string | undefined): Record<string, any> {
  if (!raw?.trim()) return {}
  let value: unknown
  try { value = YAML.load(raw, { json: true }) } catch { throw new Error('Invalid Hermes configuration') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Hermes configuration')
  return value as Record<string, any>
}

export async function synchronizeHermesProvider(profile: string): Promise<void> {
  if (!modelGroups) throw new Error('Provider projection is not configured')
  const dir = providerProfileDir(profile)
  const cfg = await readConfigYamlForProfile(profile)
  const edits = await readSupplementalEdits(profile)
  const credential = await internalModelCredential(profile)
  const catalog = await safeFileStore.readText(join(providerAccountHome(), 'catalog.json')).catch(() => '')
  const stamp = createHash('sha256').update(JSON.stringify([cfg, edits, catalog, credential.token, studioModelGatewayUrl()])).digest('hex')
  const marker = join(dir, 'projection.json')
  const sourceConfig = parse(await safeFileStore.readText(join(providerSourceDir(profile), 'config.yaml')).catch(() => ''))
  if (await safeFileStore.readText(marker).catch(() => '') === stamp
    && sourceConfig.providers?.ekkostudio?.api_key === credential.token) return
  const groups = (await modelGroups(profile)).filter(group => group.provider !== 'moa' && !['ekkostudio', 'custom:ekkostudio'].includes(group.provider))
  const models: string[] = []
  for (const group of groups) for (const model of group.models) models.push(qualifyModelRoute(await providerRouteNamespace(profile, group.provider), model))
  const selection = typeof cfg.model === 'object' && cfg.model ? cfg.model : {}
  const defaultModel = String(typeof cfg.model === 'string' ? cfg.model : selection.default || '')
  let defaultProvider = String(selection.provider || '')
  if (defaultProvider !== 'moa' && !groups.some(group => group.provider === defaultProvider && group.models.includes(defaultModel))) {
    const found = groups.find(group => group.models.includes(defaultModel) && (!selection.base_url || group.base_url === selection.base_url))
    if (found) defaultProvider = found.provider
  }
  let routedDefault = defaultModel
  if (defaultProvider && defaultModel && defaultProvider !== 'moa') routedDefault = qualifyModelRoute(await providerRouteNamespace(profile, defaultProvider), defaultModel)
  const src = providerSourceDir(profile)
  const configPath = join(src, 'config.yaml')
  const envPath = join(src, '.env')
  const authPath = join(src, 'auth.json')
  const anthropicPath = join(src, '.anthropic_oauth.json')
  const projectRoutes = async (value: any): Promise<any> => {
    if (Array.isArray(value)) return Promise.all(value.map(projectRoutes))
    if (!value || typeof value !== 'object') return value
    const projected = Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, entry]) => [key, await projectRoutes(entry)])))
    if (typeof value.model === 'string' && value.model && value.provider !== 'moa' && value.provider !== 'auto') {
      const provider = value.provider && value.provider !== 'auto' ? value.provider : defaultProvider
      if (provider && provider !== 'moa') Object.assign(projected, { provider: 'ekkostudio',
        model: qualifyModelRoute(await providerRouteNamespace(profile, provider), value.model),
        base_url: studioModelGatewayUrl(), api_key: credential.token, api_mode: 'codex_responses' })
    }
    return projected
  }
  const importedEnv = await safeFileStore.readText(join(providerAccountHome(), '.env')).catch(() => '')
  const envKeys = new Set(importedEnv.split(/\r?\n/).filter(Boolean).map(line => line.trim().split('=', 1)[0].trim()))
  await safeFileStore.updateTexts([configPath, envPath, authPath, anthropicPath, marker], async current => {
    const original = parse(current[configPath])
    for (const section of supplementalSections) {
      const projected = await applySupplementalEdits(original[section], cfg[section], edits[section], projectRoutes)
      if (projected === undefined) delete original[section]
      else original[section] = projected
    }
    // Existing auxiliary routes still need their original provider definitions
    // and credentials. Keep those dependencies until users choose to migrate.
    const keepLegacy = defaultProvider === 'moa' || supplementalSections.some(section => {
      const value = original[section]
      return value && typeof value === 'object' && Object.keys(value).length > 0
    })
    const previousModel = typeof original.model === 'object' && original.model ? original.model : {}
    const { base_url, api_key, api_mode, ...modelOptions } = { ...previousModel, ...selection }
    if (!keepLegacy) delete original.custom_providers
    original.providers = { ...(keepLegacy ? original.providers : {}), ekkostudio: { name: 'ekkostudio', base_url: studioModelGatewayUrl(), api_key: credential.token,
      api_mode: 'codex_responses', models: [...new Set(models)], extra_headers: { 'User-Agent': 'hermes-agent', 'x-studio-profile': profile } } }
    original.model = { ...modelOptions, provider: defaultProvider === 'moa' ? 'moa' : 'ekkostudio', default: routedDefault }
    if (keepLegacy) return { files: { [configPath]: YAML.dump(original, { lineWidth: -1, noRefs: true }), [marker]: stamp }, result: undefined }
    const env = String(current[envPath] || '').split(/\r?\n/).filter(line => !envKeys.has(line.trim().split('=', 1)[0].trim())).join('\n')
    const auth = JSON.parse(current[authPath] || '{}')
    delete auth.providers
    delete auth.credential_pool
    delete auth.active_provider
    return { files: { [configPath]: YAML.dump(original, { lineWidth: -1, noRefs: true }), [envPath]: env, [authPath]: JSON.stringify(auth, null, 2), [anthropicPath]: '{}\n', [marker]: stamp }, result: undefined }
  }, { backup: false })
  await Promise.all([configPath, marker].map(path => chmod(path, 0o600)))
}

export async function hermesGatewaySelection(profile: string, provider: string, model: string) {
  const selected = logicalModelSelection(profile, provider, model)
  if (selected.provider === 'moa') return { model: selected.model, provider: selected.provider }
  await synchronizeHermesProvider(profile)
  const credential = await internalModelCredential(profile)
  const routedModel = qualifyModelRoute(await providerRouteNamespace(profile, selected.provider), selected.model)
  return { provider: 'ekkostudio', model: routedModel,
    gateway_runtime: { provider: 'custom', api_mode: 'codex_responses', base_url: studioModelGatewayUrl(), api_key: credential.token } }
}
