import { readFileSync } from 'fs'
import { join } from 'path'
import yaml from 'js-yaml'
import { getCompatibleCustomProviders } from '../../../studio/contracts/provider-compat'
import { PROVIDER_PRESETS } from '../../../studio/contracts/providers'
import { PROVIDER_ENV_MAP } from '../profiles/config'
import { getProfileDir } from '../profiles/profile'

export function resolveConfiguredModelEndpoint(config: any, provider: string | null | undefined, model: string, envContent = ''): string | undefined {
  const normalized = (provider || '').trim().toLowerCase()
  const text = (value: unknown) => typeof value === 'string' ? value.trim() || undefined : undefined
  const configured = Object.entries(config?.providers || {}).find(([id]) => id.toLowerCase() === normalized)?.[1] as any
  const configuredUrl = text(configured?.base_url) || text(configured?.baseUrl)
  if (configuredUrl) return configuredUrl
  const providers = getCompatibleCustomProviders(config)
  const normalizeName = (name: string) => name.trim().toLowerCase().replace(/ /g, '-')
  const named = normalized ? providers.find(entry => [entry.name, entry.provider_key || ''].some(name => normalizeName(name) === normalized.replace(/^custom:/, ''))) : undefined
  if (named) return text(named.base_url)
  if (normalized === 'custom' || normalized.startsWith('custom:')) {
    const selectedUrl = normalized === 'custom' ? text(config?.model?.base_url) : undefined
    if (selectedUrl) return selectedUrl
    const matches = normalized === 'custom' ? providers.filter(entry => entry.model === model) : []
    const url = matches.length === 1 ? text(matches[0].base_url) : undefined
    if (url) return url
  }
  if (text(config?.model?.provider)?.toLowerCase() === normalized || (!normalized && config?.model?.default === model)) {
    const url = text(config?.model?.base_url)
    if (url) return url
  }
  const key = Object.hasOwn(PROVIDER_ENV_MAP, normalized) ? PROVIDER_ENV_MAP[normalized].base_url_env : undefined
  if (key) {
    const match = envContent.match(new RegExp(`^${key}\\s*=\\s*(.*)$`, 'm'))
    const url = text(match?.[1].replace(/^(["'])(.*)\1$/, '$2'))
    if (url) return url
  }
  return PROVIDER_PRESETS.find(preset => preset.value === normalized)?.base_url
}

export function resolveModelBaseUrlForProfile(profile: string, provider: string, model: string): string | undefined {
  const dir = getProfileDir(profile)
  let config: any = {}
  let envContent = ''
  try { config = yaml.load(readFileSync(join(dir, 'config.yaml'), 'utf8'), { json: true }) || {} } catch {}
  try { envContent = readFileSync(join(dir, '.env'), 'utf8') } catch {}
  return resolveConfiguredModelEndpoint(config, provider, model, envContent)
}
