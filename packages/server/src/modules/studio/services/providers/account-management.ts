import { join } from 'node:path'
import YAML from 'js-yaml'
import { getCompatibleCustomProviders } from '../../contracts/provider-compat'
import { readConfigYamlForProfile, PROVIDER_ENV_MAP } from '../../public/provider-config'
import { safeFileStore } from '../../public/safe-file-store'
import { providerAccountHome, providerCredentialDir, providerProfileDir, providerProfiles } from './account-store'
import { canonicalProviderId } from './model-routes'

function json(raw: string | undefined): Record<string, any> {
  try { return JSON.parse(raw || '{}') }
  catch { throw new Error('Could not parse the Studio Provider store') }
}

function oauthEntry(value: any): boolean {
  return value && value.auth_type !== 'api_key' && value.auth_mode !== 'api_key'
    && (value.access_token || value.refresh_token || value.tokens?.access_token || value.tokens?.refresh_token
      || value.auth_type === 'oauth' || value.auth_mode === 'oauth_pkce')
}

/** Remove the shared record and its unshared credentials, retaining import backups. */
export async function removeAccountProvider(profile: string, providerId: string): Promise<boolean | null> {
  const configuration = await readConfigYamlForProfile(profile)
  if (configuration.studio_provider_pool !== 2) return null
  const id = canonicalProviderId(profile, providerId)
  const entry = getCompatibleCustomProviders(configuration).find(provider => provider.catalog_provider === id)
  if (!entry) return false
  const original = configuration.providers[entry.provider_key!]
  const home = providerAccountHome()
  const directory = providerCredentialDir(entry.auth_scope)
  const paths = {
    config: join(home, 'config.yaml'), env: join(home, '.env'),
    auth: join(directory, 'auth.json'), authEnv: join(directory, '.env'),
    anthropic: join(directory, '.anthropic_oauth.json'), qwen: join(directory, 'qwen-oauth.json'),
    catalog: join(home, 'catalog.json'),
  }
  const settings = providerProfiles().map(name => ({ name, path: join(providerProfileDir(name), 'config.yaml') }))
  const runtime = entry.auth_provider || entry.runtime_provider || id
  const mapping = PROVIDER_ENV_MAP[runtime]
  const updated = await safeFileStore.updateTexts<boolean>([...Object.values(paths), ...settings.map(item => item.path)], current => {
    const config = (YAML.load(current[paths.config] || '{}') || {}) as Record<string, any>
    const key = Object.keys(config.providers || {}).find(key => config.providers[key]?.catalog_provider === id)
    if (!key) return { files: {}, result: false }
    if (JSON.stringify(config.providers[key]) !== JSON.stringify(original)) throw Object.assign(new Error('Provider configuration changed; reload before clearing'), { status: 409 })
    delete config.providers[key]
    const remaining = getCompatibleCustomProviders(config)
    const files: Record<string, string> = {}
    const clearEnvironment = (path: string, keys: string[]) => {
      if (!current[path]) return
      const remove = new Set(keys.filter(Boolean))
      files[path] = (files[path] ?? current[path]!).split(/\r?\n/).filter(line => !remove.has(line.trim().split('=', 1)[0].trim())).join('\n')
    }
    const usedKeys = new Set(remaining.map(provider => provider.key_env).filter(Boolean))
    for (const provider of remaining) if (provider.auth_provider && !provider.auth_scope) {
      const mapping = PROVIDER_ENV_MAP[provider.auth_provider]
      if (mapping?.api_key_env) usedKeys.add(mapping.api_key_env)
      if (mapping?.base_url_env) usedKeys.add(mapping.base_url_env)
    }
    const rootMapping = entry.auth_scope ? undefined : mapping
    clearEnvironment(paths.env, [entry.key_env, rootMapping?.api_key_env, rootMapping?.base_url_env].filter((key): key is string => !!key && !usedKeys.has(key)))
    const sharedGrant = remaining.some(provider => provider.auth_provider === runtime && provider.auth_scope === entry.auth_scope)
    if (!sharedGrant) {
      if (current[paths.auth]) {
        const auth = json(current[paths.auth])
        for (const section of ['providers', 'credential_pool']) if (auth[section]) delete auth[section][runtime]
        if (auth.active_provider === runtime) delete auth.active_provider
        if (runtime === 'claude-oauth') {
          if (oauthEntry(auth.providers?.anthropic)) delete auth.providers.anthropic
          if (Array.isArray(auth.credential_pool?.anthropic)) {
            auth.credential_pool.anthropic = auth.credential_pool.anthropic.filter((grant: unknown) => !oauthEntry(grant))
          }
        }
        files[paths.auth] = JSON.stringify(auth, null, 2) + '\n'
      }
      if (runtime === 'claude-oauth') {
        if (current[paths.anthropic]) files[paths.anthropic] = '{}\n'
        clearEnvironment(paths.authEnv, ['ANTHROPIC_TOKEN'])
      }
      if (runtime === 'qwen-oauth' && current[paths.qwen]) files[paths.qwen] = '{}\n'
      if (runtime === 'copilot') clearEnvironment(paths.authEnv, ['COPILOT_GITHUB_TOKEN'])
    }
    const clearSelection = (settings: Record<string, any>, name: string) => {
      if (!settings.model || canonicalProviderId(name, settings.model.provider) !== id) return
      const { provider, default: model, base_url, api_key, api_mode, ...options } = settings.model
      settings.model = options
    }
    clearSelection(config, profile)
    files[paths.config] = YAML.dump(config, { lineWidth: -1, noRefs: true })
    for (const item of settings) {
      const config = (YAML.load(current[item.path] || '{}') || {}) as Record<string, any>
      clearSelection(config, item.name)
      files[item.path] = YAML.dump(config, { lineWidth: -1, noRefs: true })
    }
    if (current[paths.catalog]) {
      const catalog = json(current[paths.catalog])
      for (const [key, value] of Object.entries(catalog.providers || {})) if ((value as any)?.provider === id) delete catalog.providers[key]
      files[paths.catalog] = JSON.stringify(catalog, null, 2) + '\n'
    }
    return { files, result: true }
  }, { backup: true })
  return updated === true
}
