import { readFile, mkdir, chmod } from 'fs/promises'
import { join } from 'path'
import { config } from '../../public/config'
import { safeFileStore } from '../../public/safe-file-store'

const APP_HOME = config.appHome
const APP_CONFIG_FILE = join(APP_HOME, 'config.json')

export interface ModelVisibilityRule {
  mode: 'all' | 'include'
  models: string[]
}

export interface GatewayAutoStartConfig {
  enabled?: boolean
  include?: string[]
  exclude?: string[]
  // Derived from Hermes Agent default config.yaml when returned by the config
  // controller. It is not persisted in the Web UI app config.
  management?: 'auto' | 'per_profile' | 'unified'
}

function normalizeProfileList(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  const names: string[] = []
  for (const value of values) {
    const name = String(value || '').trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

export function normalizeGatewayAutoStartConfig(value: unknown): GatewayAutoStartConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const raw = value as Record<string, unknown>
  const normalized: GatewayAutoStartConfig = {}

  if (typeof raw.enabled === 'boolean') normalized.enabled = raw.enabled
  if (Array.isArray(raw.include)) normalized.include = normalizeProfileList(raw.include)
  if (Array.isArray(raw.exclude)) normalized.exclude = normalizeProfileList(raw.exclude)

  return normalized
}

export interface AppConfig {
  // Defaults on for supported gateways. Explicit false opts out for old gateways; persisted in appHome/config.json.
  liveActivityRelevanceEnabled?: boolean
  // Network entry used by Studio's cloud App Relay connection.
  appRelayRoute?: 'official' | 'cloudflare'

  // Whether GitHub Copilot has been explicitly added by the user in web-ui.
  // Default false: even when COPILOT_GITHUB_TOKEN / gh-cli / apps.json can
  // resolve a token, the Copilot provider is hidden until the user opts in
  // via "Add Provider". Mirrors how the user manages Codex/Nous: the web-ui
  // owns the provider list, system credentials are merely a fallback source.
  copilotEnabled?: boolean

  // Web UI-only model display aliases. Keys are provider -> canonical model ID -> display label.
  // These aliases never replace the canonical model ID sent back to Hermes.
  modelAliases?: Record<string, Record<string, string>>

  // Web UI-only manually entered model IDs. Keys are provider -> model IDs.
  // This lets users persist provider-supported models that are absent from a
  // provider catalog response without changing Hermes Agent config.yaml.
  customModels?: Record<string, string[]>

  // Web UI-only model picker visibility. This filters what the WUI exposes in
  // its sidebar/model pages and never renames or rewrites Hermes canonical
  // provider/model IDs. Hermes CLI config remains the upstream source of truth.
  modelVisibility?: Record<string, ModelVisibilityRule>

  // Web UI-only provider display labels, isolated by Hermes profile and stable
  // provider id. Editing a label never renames a config-backed provider.
  providerLabels?: Record<string, Record<string, string>>

  // Per-provider preferred model used by provider management. This is distinct
  // from model.default and does not switch the profile's active default model.
  providerPreferredModels?: Record<string, Record<string, string>>

  // Web UI startup policy for automatically starting Hermes API gateways.
  // Defaults to legacy behavior: all local profiles are eligible. This is a
  // Web UI-level setting, not the active Hermes profile's config.yaml.
  gatewayAutoStart?: GatewayAutoStartConfig
}

let cache: AppConfig | null = null

export async function readAppConfig(): Promise<AppConfig> {
  if (cache) return cache
  try {
    const raw = await readFile(APP_CONFIG_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as AppConfig
    cache = parsed
    return parsed
  } catch {
    cache = {}
    return cache
  }
}

export async function writeAppConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  await mkdir(APP_HOME, { recursive: true })
  let merged: AppConfig = {}
  await safeFileStore.updateText(APP_CONFIG_FILE, (currentText) => {
    let current: AppConfig = {}
    if (currentText.trim()) {
      try { current = JSON.parse(currentText) as AppConfig } catch { current = {} }
    }
    merged = { ...current, ...patch }
    return JSON.stringify(merged, null, 2) + '\n'
  }, { backup: true })
  await chmod(APP_CONFIG_FILE, 0o600).catch(() => undefined)
  cache = merged
  return merged
}

export function providerDisplayLabel(
  appConfig: AppConfig,
  profile: string,
  providerId: string,
  fallback: string,
): string {
  const value = appConfig.providerLabels?.[profile]?.[providerId]
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

export function appConfigFilePath(): string {
  return APP_CONFIG_FILE
}

export function invalidateAppConfigCache(): void {
  cache = null
}

export function __resetAppConfigCacheForTest(): void {
  invalidateAppConfigCache()
}
