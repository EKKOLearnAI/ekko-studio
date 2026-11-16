import { createHash } from 'node:crypto'
import { getCompatibleCustomProviders, resolveCustomProviderApiKey } from '../../contracts/provider-compat'
import { PROVIDER_PRESETS } from '../../contracts/providers'
import { providerNameKey } from '../../contracts/provider-identity'

export interface ProviderSnapshot {
  profile: string
  config: Record<string, any>
  env: string
  auth: Record<string, any>
  anthropic: string
  qwen: string
}
export interface ProviderPoolState {
  version: 2 | 3
  aliases?: Record<string, string>
  imports: Record<string, Record<string, string>>
  fingerprints: Record<string, string>
}
export const providerConfigKeys = ['providers', 'custom_providers'] as const
const oauth = new Set(['openai-codex', 'claude-oauth', 'nous', 'xai-oauth', 'qwen-oauth', 'minimax-oauth', 'copilot'])
export const providerDigest = (value: string) => createHash('sha256').update(value).digest('hex')
const slug = (value: string) => value.trim().toLowerCase().replace(/ /g, '-')
export const compareProviderProfiles = (a: string, b: string) => a === b ? 0 : a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)

/** Upgrade the draft pool layout that generated hash-suffixed duplicates. */
export function coalesceProviderPool(config: Record<string, any>, state: ProviderPoolState): Record<string, string> {
  const providers = config.providers ||= {}
  const aliases = { ...state.aliases }
  // The draft create endpoint could append legacy list entries even after the
  // account had migrated to a dictionary. Fold those into the same registry.
  for (const entry of getCompatibleCustomProviders({ custom_providers: config.custom_providers || [] })) {
    const id = entry.catalog_provider || `custom:${providerNameKey(entry.name)}`
    const existing = Object.keys(providers).find(key => key === id || providerNameKey(providers[key]?.name || key) === providerNameKey(entry.name))
    if (existing) { if (existing !== id) aliases[id] = existing; continue }
    providers[id] = { ...entry, catalog_provider: id, runtime_provider: entry.runtime_provider || id }
    delete providers[id].source
    delete providers[id].provider_key
  }
  delete config.custom_providers
  const imports = Object.keys(state.imports).sort(compareProviderProfiles).map(profile => state.imports[profile])
  const ids = [...new Set([...imports.flatMap(aliases => Object.values(aliases)), ...Object.keys(providers)])].filter(id => providers[id])
  const parent = Object.fromEntries(ids.map(id => [id, id]))
  const root = (id: string): string => parent[id] && parent[id] !== id ? root(parent[id]) : id
  const names = new Map<string, string>()
  for (const id of ids) {
    const keys = [providers[id].name || id, id.replace(/^custom[:_]/, ''),
      ...imports.flatMap(aliases => Object.keys(aliases).filter(alias => aliases[alias] === id).map(alias => alias.replace(/^custom[:_]/, '')))]
    for (const name of keys) {
      const key = providerNameKey(name)
      const previous = names.get(key)
      if (previous) {
        const pair = [root(previous), root(id)].sort((a, b) => ids.indexOf(a) - ids.indexOf(b))
        parent[pair[1]] = pair[0]
      } else names.set(key, id)
    }
  }
  for (const id of ids) if (root(id) !== id) {
    aliases[id] = root(id)
    delete providers[id]
    delete state.fingerprints[id]
  }
  for (const id of Object.keys(aliases)) aliases[id] = root(aliases[id])
  for (const values of imports) for (const key of Object.keys(values)) values[key] = aliases[values[key]] || values[key]
  state.aliases = aliases
  state.version = 3
  return aliases
}

export function environmentValues(raw: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (match) result[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2')
  }
  return result
}
const envText = (values: Record<string, string>) => Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n'
const stable = (value: any): any => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value

/** Merge once per source. Provider identity no longer contains a Profile. */
export function mergeProviderSnapshot(input: {
  snapshot: ProviderSnapshot
  config: Record<string, any>
  env: string
  auth: Record<string, any>
  state: ProviderPoolState
  environmentMap: Record<string, { api_key_env: string; base_url_env: string }>
}) {
  const { snapshot, state, environmentMap } = input
  const config = structuredClone(input.config)
  config.providers ||= {}
  config.studio_provider_pool = 2
  const auth = structuredClone(input.auth)
  auth.providers ||= {}
  const incomingEnv = environmentValues(snapshot.env)
  const env = { ...incomingEnv, ...environmentValues(input.env) }
  const aliases: Record<string, string> = {}
  const credentialFiles: Record<string, string> = {}
  const presets = new Map(PROVIDER_PRESETS.map(preset => [preset.value, preset]))
  const selected = typeof snapshot.config.model === 'object' ? snapshot.config.model : {}

  const add = (identity: string, runtime: string, raw: Record<string, any>, oldNames: string[]) => {
    if (!raw.base_url || ['ekkostudio', 'custom:ekkostudio'].includes(identity)) return
    const mapping = environmentMap[runtime]
    const apiKey = String(raw.api_key || (raw.key_env ? incomingEnv[raw.key_env] : '') || '')
    const storedAuth = snapshot.auth.providers?.[runtime] || (runtime === 'claude-oauth' ? snapshot.auth.providers?.anthropic : undefined)
    const hasAuth = oauth.has(runtime) && !!(storedAuth || snapshot.auth.credential_pool?.[runtime]?.length
      || (runtime === 'copilot' && apiKey) || (runtime === 'qwen-oauth' && snapshot.qwen && snapshot.qwen !== '{}\n'))
    const preset = presets.get(runtime)
    const apiMode = raw.api_mode || preset?.catalog_api_mode || preset?.api_mode || 'chat_completions'
    const fingerprint = providerDigest(JSON.stringify(stable({ runtime, url: String(raw.base_url).replace(/\/+$/, ''), apiMode,
      credential: hasAuth ? { auth: storedAuth, pool: snapshot.auth.credential_pool?.[runtime], copilot: runtime === 'copilot' ? apiKey : undefined,
        qwen: runtime === 'qwen-oauth' ? snapshot.qwen : undefined } : apiKey,
      headers: raw.extra_headers, extra: raw.extra_body })))
    // Sources arrive in default-first order. A different endpoint/key does not
    // create another Provider with the same identity or name.
    const names = [identity.replace(/^custom[:_]/, ''), raw.name || identity].map(providerNameKey)
    let id = Object.keys(config.providers).find(key => key === identity
      || [key.replace(/^custom[:_]/, ''), config.providers[key]?.name || key].some(name => names.includes(providerNameKey(name))))
    if (!id) {
      id = identity
      const scope = hasAuth && Object.entries(config.providers).some(([key, entry]: [string, any]) => entry.runtime_provider === runtime && state.fingerprints[key] !== fingerprint)
        ? fingerprint : undefined
      const entry: Record<string, any> = { ...raw, catalog_provider: id, runtime_provider: runtime, api_mode: apiMode }
      delete entry.provider_key
      delete entry.source
      if (hasAuth) {
        delete entry.api_key
        delete entry.key_env
        entry.auth_provider = runtime
        if (scope) {
          entry.auth_scope = scope
          const privateAuth = { ...snapshot.auth, providers: { [runtime]: storedAuth }, credential_pool: { [runtime]: snapshot.auth.credential_pool?.[runtime] || [] } }
          credentialFiles[`${scope}/auth.json`] = JSON.stringify(privateAuth)
          credentialFiles[`${scope}/.env`] = envText(incomingEnv)
          credentialFiles[`${scope}/.anthropic_oauth.json`] = snapshot.anthropic || '{}\n'
          credentialFiles[`${scope}/qwen-oauth.json`] = snapshot.qwen || '{}\n'
        } else {
          if (storedAuth && !auth.providers[runtime]) auth.providers[runtime] = storedAuth
          if (snapshot.auth.credential_pool?.[runtime] && !auth.credential_pool?.[runtime]) {
            auth.credential_pool ||= {}
            auth.credential_pool[runtime] = snapshot.auth.credential_pool[runtime]
          }
        }
      } else if (raw.api_key) {
        delete entry.key_env
      } else if (raw.key_env && apiKey && env[raw.key_env] !== apiKey) {
        entry.api_key = apiKey
        delete entry.key_env
      } else if (!raw.api_key && mapping?.api_key_env && apiKey) {
        entry.key_env = mapping.api_key_env
        delete entry.api_key
      }
      config.providers[id] = entry
      state.fingerprints[id] = fingerprint
    }
    const entry = config.providers[id]
    if (state.fingerprints[id] === fingerprint) {
      entry.models = { ...(entry.models || {}), ...(raw.models || {}) }
      if (raw.model) entry.models[raw.model] ||= {}
    }
    for (const name of oldNames) aliases[name] = id
  }

  for (const cp of getCompatibleCustomProviders(snapshot.config)) {
    const builtin = presets.get(cp.provider_key || slug(cp.name))
    const runtime = cp.runtime_provider || builtin?.value || `custom:${slug(cp.name)}`
    const identity = cp.catalog_provider || builtin?.value || `custom:${slug(cp.name)}`
    const key = resolveCustomProviderApiKey(cp, snapshot.env) || incomingEnv[environmentMap[runtime]?.api_key_env] || ''
    add(identity, runtime, { ...cp, api_key: cp.api_key || undefined,
      key_env: cp.key_env || (!cp.api_key ? environmentMap[runtime]?.api_key_env : undefined),
      models: { ...cp.models },
      ...(key && !cp.key_env && !environmentMap[runtime]?.api_key_env && !cp.api_key ? { api_key: key } : {}) },
    [identity, `custom:${slug(cp.name)}`, ...(cp.provider_key ? [cp.provider_key] : [])])
  }
  for (const preset of PROVIDER_PRESETS) {
    const mapping = environmentMap[preset.value]
    const key = incomingEnv[mapping?.api_key_env] || ''
    const hasAuth = snapshot.auth.providers?.[preset.value] || snapshot.auth.credential_pool?.[preset.value]?.length
      || (preset.value === 'claude-oauth' && snapshot.auth.providers?.anthropic)
      || (preset.value === 'qwen-oauth' && snapshot.qwen?.includes('access_token'))
    if (!key && !hasAuth && selected?.provider !== preset.value) continue
    // An explicitly configured dictionary Provider takes precedence over its
    // environment-only view when both describe the same source identity.
    if (aliases[preset.value]) continue
    if (!key && !hasAuth && !selected?.base_url && config.providers[preset.value]) { aliases[preset.value] = preset.value; continue }
    const base = incomingEnv[mapping?.base_url_env] || (selected?.provider === preset.value && selected.base_url) || preset.base_url
    const models: Record<string, any> = {}
    if (selected?.provider === preset.value && selected.default) models[selected.default] ||= {}
    add(preset.value, preset.value, { name: preset.label, base_url: base, key_env: mapping?.api_key_env,
      ...(selected?.provider === preset.value && selected.api_key ? { api_key: selected.api_key } : {}), models }, [preset.value])
  }
  if (selected?.base_url && !aliases[selected.provider || 'custom']) {
    const match = Object.entries(config.providers).find(([, entry]: any) => String(entry.base_url).replace(/\/+$/, '') === String(selected.base_url).replace(/\/+$/, ''))
    if (match) aliases[selected.provider || 'custom'] = match[0]
    else add('custom:imported', 'custom:imported', { name: 'Imported Provider', base_url: selected.base_url, api_key: selected.api_key,
      api_mode: selected.api_mode, models: selected.default ? { [selected.default]: {} } : {} }, [selected.provider || 'custom'])
  }
  state.imports[snapshot.profile] = aliases
  const settings = Object.fromEntries(Object.entries(snapshot.config).filter(([key]) => !providerConfigKeys.includes(key as any)))
  if (settings.model && typeof settings.model === 'object') {
    settings.model = { ...settings.model, provider: aliases[settings.model.provider] || settings.model.provider }
    delete settings.model.api_key
    delete settings.model.base_url
  }
  if (!config.model && settings.model) config.model = settings.model
  return { config, auth, env: envText(env), settings, aliases, credentialFiles }
}
