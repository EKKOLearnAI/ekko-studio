import { readFile } from 'fs/promises'
import { join } from 'path'
import { getActiveProfileName, getProfileDir } from '../services/profiles/profile'
import { gatewayAutostartDisabledByEnv, reconcileGatewayManagementTransition, restartGatewayForProfile } from '../services/gateway/autostart'
import { readAppConfig, writeAppConfig, normalizeGatewayAutoStartConfig } from '../../studio/public/app-config'
import { saveEnvValueForProfile } from '../../studio/public/profile-config'
import { logger } from '../../studio/public/logging'
import { safeFileStore } from '../../studio/public/safe-file-store'
import { EXCLUSIVE_PLATFORM_CREDENTIAL_KEYS } from '../services/profiles/profile-credentials'
import { invalidateProviderRuntime } from '../../studio/public/provider-runtime'

const PLATFORM_SECTIONS = new Set([
  'telegram', 'discord', 'slack', 'whatsapp', 'matrix',
  'weixin', 'wecom', 'feishu', 'dingtalk', 'qqbot',
  'approvals',
])

const APP_CONFIG_SECTIONS = new Set(['gatewayAutoStart'])
const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY'] as const

function requestedProfile(ctx: any): string {
  const headerProfile = typeof ctx.get === 'function' ? ctx.get('x-hermes-profile') : ''
  const queryProfile = typeof ctx.query?.profile === 'string' ? ctx.query.profile : ''
  const bodyProfile = typeof ctx.request?.body?.profile === 'string' ? ctx.request.body.profile : ''
  return ctx.state?.profile?.name ||
    headerProfile.trim() ||
    queryProfile.trim() ||
    bodyProfile.trim() ||
    getActiveProfileName() ||
    'default'
}

const configPath = (profile: string) => join(getProfileDir(profile), 'config.yaml')
const envPath = (profile: string) => join(getProfileDir(profile), '.env')

const envPlatformMap: Record<string, [string, string]> = {
  TELEGRAM_BOT_TOKEN: ['telegram', 'token'],
  TELEGRAM_PROXY: ['telegram', 'proxy'],
  DISCORD_BOT_TOKEN: ['discord', 'token'],
  DISCORD_PROXY: ['discord', 'proxy'],
  SLACK_BOT_TOKEN: ['slack', 'token'],
  MATRIX_ACCESS_TOKEN: ['matrix', 'token'],
  MATRIX_PROXY: ['matrix', 'proxy'],
  MATRIX_HOMESERVER: ['matrix', 'extra.homeserver'],
  MATRIX_USER_ID: ['matrix', 'extra.user_id'],
  MATRIX_PASSWORD: ['matrix', 'extra.password'],
  FEISHU_APP_ID: ['feishu', 'extra.app_id'],
  FEISHU_APP_SECRET: ['feishu', 'extra.app_secret'],
  FEISHU_ENCRYPT_KEY: ['feishu', 'extra.encrypt_key'],
  FEISHU_VERIFICATION_TOKEN: ['feishu', 'extra.verification_token'],
  DINGTALK_CLIENT_ID: ['dingtalk', 'extra.client_id'],
  DINGTALK_CLIENT_SECRET: ['dingtalk', 'extra.client_secret'],
  DINGTALK_APP_KEY: ['dingtalk', 'extra.app_key'],
  DINGTALK_CARD_TEMPLATE_ID: ['dingtalk', 'extra.card_template_id'],
  DINGTALK_ALLOWED_USERS: ['dingtalk', 'allowed_users'],
  DINGTALK_ALLOW_ALL_USERS: ['dingtalk', 'allow_all_users'],
  QQ_APP_ID: ['qqbot', 'extra.app_id'],
  QQ_CLIENT_SECRET: ['qqbot', 'extra.client_secret'],
  QQ_ALLOWED_USERS: ['qqbot', 'allowed_users'],
  QQ_ALLOW_ALL_USERS: ['qqbot', 'allow_all_users'],
  WECOM_BOT_ID: ['wecom', 'extra.bot_id'],
  WECOM_SECRET: ['wecom', 'extra.secret'],
  WEIXIN_TOKEN: ['weixin', 'token'],
  WEIXIN_ACCOUNT_ID: ['weixin', 'extra.account_id'],
  WEIXIN_BASE_URL: ['weixin', 'extra.base_url'],
  WHATSAPP_ENABLED: ['whatsapp', 'enabled'],
}

const platformEnvMap: Record<string, Record<string, string>> = {}
for (const [envVar, [platform, cfgPath]] of Object.entries(envPlatformMap)) {
  if (!platformEnvMap[platform]) platformEnvMap[platform] = {}
  platformEnvMap[platform][cfgPath] = envVar
}

// Keep this list deliberately separate from platformEnvMap: the latter also
// contains access-control and enablement settings that must survive a
// credential reset. New credential fields must be added here explicitly.
const PLATFORM_CREDENTIAL_PATHS: Record<string, readonly string[]> = {
  telegram: ['token', 'proxy'],
  discord: ['token', 'proxy'],
  slack: ['token'],
  matrix: ['token', 'proxy', 'extra.user_id', 'extra.password'],
  weixin: ['token', 'extra.account_id'],
  wecom: ['extra.bot_id', 'extra.secret'],
  feishu: ['extra.app_id', 'extra.app_secret', 'extra.encrypt_key', 'extra.verification_token'],
  dingtalk: ['extra.client_id', 'extra.client_secret', 'extra.app_key'],
  qqbot: ['extra.app_id', 'extra.client_secret'],
}

function parseEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim()
    if (val) env[key] = val
  }
  return env
}

function envContainsKey(raw: string, key: string): boolean {
  return raw.split('\n').some((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return false
    const eqIdx = trimmed.indexOf('=')
    return eqIdx !== -1 && trimmed.slice(0, eqIdx).trim() === key
  })
}

function setNested(obj: Record<string, any>, path: string, value: any) {
  const parts = path.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) { if (!cur[parts[i]]) cur[parts[i]] = {}; cur = cur[parts[i]] }
  cur[parts[parts.length - 1]] = value
}

function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
        target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      target[key] = deepMerge(target[key], source[key])
    } else {
      target[key] = source[key]
    }
  }
  return target
}

function valueAtPath(value: unknown, path: string): unknown {
  let current = value
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function hasStoredValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false
  return typeof value === 'string' ? value.trim().length > 0 : true
}

function getPlatformCredentialStatus(platforms: unknown): Record<string, boolean> {
  const status: Record<string, boolean> = {}
  for (const [platform, paths] of Object.entries(PLATFORM_CREDENTIAL_PATHS)) {
    const platformConfig = valueAtPath(platforms, platform)
    status[platform] = paths.some(path => hasStoredValue(valueAtPath(platformConfig, path)))
  }
  return status
}

const AUXILIARY_TASKS = [
  { key: 'vision', label: 'Vision', default_timeout: 120, default_download_timeout: 30 },
  { key: 'web_extract', label: 'Web extract', default_timeout: 360 },
  { key: 'compression', label: 'Compression', default_timeout: 120 },
  { key: 'skills_hub', label: 'Skills hub', default_timeout: 30 },
  { key: 'approval', label: 'Approval', default_timeout: 30 },
  { key: 'mcp', label: 'MCP', default_timeout: 30 },
  { key: 'title_generation', label: 'Title generation', default_timeout: 30 },
  { key: 'triage_specifier', label: 'Triage specifier', default_timeout: 120 },
  { key: 'kanban_decomposer', label: 'Kanban decomposer', default_timeout: 180 },
  { key: 'profile_describer', label: 'Profile describer', default_timeout: 60 },
  { key: 'curator', label: 'Curator', default_timeout: 600 },
  { key: 'session_search', label: 'Session search', default_timeout: 30 },
  { key: 'flush_memories', label: 'Flush memories', default_timeout: 30 },
  { key: 'image_generation', label: 'Studio image generation', default_timeout: 600 },
  { key: 'image_edit', label: 'Studio image-to-image', default_timeout: 600 },
] as const

const AUX_STRING_FIELDS = new Set(['provider', 'model', 'base_url', 'api_key'])
const AUX_NUMBER_FIELDS = new Set(['timeout', 'download_timeout'])
const DELEGATION_REASONING_EFFORTS = new Set([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
])
const DELEGATION_MODEL_FIELDS = ['provider', 'model', 'reasoning_effort'] as const
const DELEGATION_ROUTE_FIELDS = [
  ...DELEGATION_MODEL_FIELDS,
  'base_url', 'api_key', 'api_mode',
] as const

const DEFAULT_MOA_PRESET_NAME = 'default'
const DEFAULT_MOA_REFERENCE_MODELS = [
  { provider: 'openai-codex', model: 'gpt-5.5' },
  { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro' },
]
const DEFAULT_MOA_AGGREGATOR = { provider: 'openrouter', model: 'anthropic/claude-opus-4.8' }

function isPlainRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isSafeAuxiliaryKey(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,80}$/.test(value) &&
    value !== '__proto__' &&
    value !== 'prototype' &&
    value !== 'constructor'
}

function normalizeAuxiliaryConfig(value: unknown, options: { resetAuto?: boolean } = {}): Record<string, any> {
  if (!isPlainRecord(value)) return {}
  const normalized: Record<string, any> = {}

  for (const [task, rawSettings] of Object.entries(value)) {
    if (!isSafeAuxiliaryKey(task) || !isPlainRecord(rawSettings)) continue
    const settings: Record<string, any> = {}
    const provider = typeof rawSettings.provider === 'string' ? rawSettings.provider.trim() : ''
    const resetToAuto = options.resetAuto === true && provider === 'auto'

    for (const [field, rawValue] of Object.entries(rawSettings)) {
      if (resetToAuto && field !== 'provider' && field !== 'timeout' && field !== 'download_timeout') continue
      if (AUX_STRING_FIELDS.has(field)) {
        if (typeof rawValue !== 'string') continue
        const trimmed = rawValue.trim()
        if (trimmed) settings[field] = trimmed
      } else if (AUX_NUMBER_FIELDS.has(field)) {
        if (field === 'download_timeout' && task !== 'vision') continue
        if (rawValue === null || rawValue === undefined || rawValue === '') continue
        const numberValue = Number(rawValue)
        if (Number.isFinite(numberValue) && numberValue > 0) {
          settings[field] = Math.floor(numberValue)
        }
      } else if (field === 'extra_body') {
        if (isPlainRecord(rawValue) && Object.keys(rawValue).length > 0) {
          settings.extra_body = rawValue
        }
      }
    }

    if (Object.keys(settings).length > 0) normalized[task] = settings
  }

  return normalized
}

function normalizeDelegationModelConfig(value: unknown): Record<string, string> {
  if (!isPlainRecord(value)) return {}
  const normalized: Record<string, string> = {}

  for (const field of DELEGATION_MODEL_FIELDS) {
    const rawValue = value[field]
    if (typeof rawValue !== 'string') continue
    const trimmed = rawValue.trim()
    if (!trimmed) continue
    if (field === 'reasoning_effort' && !DELEGATION_REASONING_EFFORTS.has(trimmed)) continue
    normalized[field] = trimmed
  }

  return normalized
}

function hasInvalidDelegationModelConfig(value: Record<string, any>): boolean {
  for (const field of DELEGATION_MODEL_FIELDS) {
    if (!(field in value) || value[field] === undefined || value[field] === null) continue
    if (typeof value[field] !== 'string') return true
  }
  const reasoningEffort = typeof value.reasoning_effort === 'string'
    ? value.reasoning_effort.trim()
    : ''
  return !!reasoningEffort && !DELEGATION_REASONING_EFFORTS.has(reasoningEffort)
}

function cleanMoaSlot(value: unknown): { provider: string; model: string; reasoning_effort?: string } | null {
  if (!isPlainRecord(value)) return null
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  const reasoningEffort = typeof value.reasoning_effort === 'string' && value.reasoning_effort.trim()
    ? value.reasoning_effort.trim()
    : undefined
  if (!provider || !model || provider.toLowerCase() === 'moa') return null
  return { provider, model, ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}) }
}

function coerceMoaNumber(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === '') return fallback
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : fallback
}

function coerceMoaInt(value: unknown, fallback: number): number {
  return Math.floor(coerceMoaNumber(value, fallback))
}

function defaultMoaPreset(): Record<string, any> {
  return {
    reference_models: DEFAULT_MOA_REFERENCE_MODELS.map(slot => ({ ...slot })),
    aggregator: { ...DEFAULT_MOA_AGGREGATOR },
    reference_temperature: 0.6,
    aggregator_temperature: 0.4,
    max_tokens: 4096,
    enabled: true,
  }
}

function normalizeMoaPreset(value: unknown): Record<string, any> {
  const raw = isPlainRecord(value) ? value : {}
  const rawRefs = Array.isArray(raw.reference_models)
    ? raw.reference_models
    : isPlainRecord(raw.reference_models) ? [raw.reference_models] : []
  const referenceModels = rawRefs.map(cleanMoaSlot).filter((slot): slot is { provider: string; model: string; reasoning_effort?: string } => !!slot)
  const aggregator = cleanMoaSlot(raw.aggregator) || { ...DEFAULT_MOA_AGGREGATOR }
  return {
    enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    reference_models: referenceModels.length > 0 ? referenceModels : DEFAULT_MOA_REFERENCE_MODELS.map(slot => ({ ...slot })),
    aggregator,
    reference_temperature: coerceMoaNumber(raw.reference_temperature, 0.6),
    aggregator_temperature: coerceMoaNumber(raw.aggregator_temperature, 0.4),
    max_tokens: coerceMoaInt(raw.max_tokens, 4096),
  }
}

function normalizeMoaConfig(value: unknown): Record<string, any> {
  const raw = isPlainRecord(value) ? value : {}
  const presets: Record<string, any> = {}
  if (isPlainRecord(raw.presets)) {
    for (const [name, preset] of Object.entries(raw.presets)) {
      const cleanName = String(name || '').trim()
      if (cleanName && isSafeAuxiliaryKey(cleanName)) presets[cleanName] = normalizeMoaPreset(preset)
    }
  }
  if (Object.keys(presets).length === 0) presets[DEFAULT_MOA_PRESET_NAME] = normalizeMoaPreset(raw)

  let defaultPreset = typeof raw.default_preset === 'string' ? raw.default_preset.trim() : ''
  if (!defaultPreset || !presets[defaultPreset]) defaultPreset = Object.keys(presets)[0] || DEFAULT_MOA_PRESET_NAME
  if (!presets[defaultPreset]) presets[defaultPreset] = defaultMoaPreset()

  let activePreset = typeof raw.active_preset === 'string' ? raw.active_preset.trim() : ''
  if (!presets[activePreset]) activePreset = ''

  const active = presets[defaultPreset]
  return {
    default_preset: defaultPreset,
    active_preset: activePreset,
    presets,
    reference_models: active.reference_models.map((slot: any) => ({ ...slot })),
    aggregator: { ...active.aggregator },
    reference_temperature: active.reference_temperature,
    aggregator_temperature: active.aggregator_temperature,
    max_tokens: active.max_tokens,
    enabled: active.enabled,
  }
}

async function readEnvPlatforms(profile: string): Promise<Record<string, any>> {
  try {
    const raw = await readFile(envPath(profile), 'utf-8')
    const env = parseEnv(raw)
    const platforms: Record<string, any> = {}
    for (const [envKey, [platform, cfgPath]] of Object.entries(envPlatformMap)) {
      const val = env[envKey]
      if (val === undefined || val === '') continue
      if (!platforms[platform]) platforms[platform] = {}
      let finalVal: any = val
      if (cfgPath === 'enabled' || cfgPath === 'allow_all_users') finalVal = val === 'true'
      setNested(platforms[platform], cfgPath, finalVal)
    }
    return platforms
  } catch { return {} }
}

async function readProxyEnv(profile: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(envPath(profile), 'utf-8')
    const env = parseEnv(raw)
    const proxy: Record<string, string> = {}
    for (const key of PROXY_ENV_KEYS) {
      if (env[key]) proxy[key] = env[key]
    }
    return proxy
  } catch { return {} }
}

async function readConfig(profile: string): Promise<Record<string, any>> {
  return safeFileStore.readYaml(configPath(profile))
}

function configTruthy(value: unknown): boolean {
  if (value === true) return true
  const normalized = String(value || '').trim().toLowerCase()
  return ['1', 'true', 'yes', 'on'].includes(normalized)
}

function gatewayManagementFromHermesConfig(config: Record<string, any>): 'per_profile' | 'unified' {
  return configTruthy(config.multiplex_profiles) || configTruthy(config.gateway?.multiplex_profiles)
    ? 'unified'
    : 'per_profile'
}

async function readGatewayAutoStartForResponse(): Promise<ReturnType<typeof normalizeGatewayAutoStartConfig>> {
  const appConfig = await readAppConfig()
  const gatewayAutoStart = normalizeGatewayAutoStartConfig(appConfig.gatewayAutoStart)
  const defaultConfig = await readConfig('default')
  gatewayAutoStart.management = gatewayManagementFromHermesConfig(defaultConfig)
  return gatewayAutoStart
}

async function writeHermesGatewayManagement(mode: unknown): Promise<'per_profile' | 'unified' | null> {
  if (mode !== 'per_profile' && mode !== 'unified') return null
  await safeFileStore.updateYaml(configPath('default'), (config) => {
    if (mode === 'unified') {
      config.multiplex_profiles = true
    } else {
      delete config.multiplex_profiles
    }
    if (config.gateway && typeof config.gateway === 'object' && !Array.isArray(config.gateway)) {
      delete config.gateway.multiplex_profiles
      if (Object.keys(config.gateway).length === 0) delete config.gateway
    }
    return config
  }, {
    backup: true,
    dumpOptions: {
      forceQuotes: true,
    },
  })
  return mode
}

async function gatewayAutoRestartAllowed(): Promise<boolean> {
  if (gatewayAutostartDisabledByEnv()) return false
  return normalizeGatewayAutoStartConfig((await readAppConfig()).gatewayAutoStart).enabled !== false
}

export async function getConfig(ctx: any) {
  try {
    const profile = requestedProfile(ctx)
    const config = await readConfig(profile)
    const gatewayAutoStart = await readGatewayAutoStartForResponse()
    const proxy = await readProxyEnv(profile)
    const envPlatforms = await readEnvPlatforms(profile)
    if (Object.keys(envPlatforms).length > 0) {
      const existing = config.platforms || {}
      for (const [platform, vals] of Object.entries(envPlatforms)) {
        existing[platform] = deepMerge(existing[platform] || {}, vals as Record<string, any>)
      }
      config.platforms = existing
    }
    const platformCredentialStatus = getPlatformCredentialStatus(config.platforms)
    const { section, sections } = ctx.query
    if (section) {
      const key = section as string
      if (key === 'gatewayAutoStart') {
        ctx.body = { gatewayAutoStart }
        return
      }
      if (key === 'proxy') {
        ctx.body = { proxy }
        return
      }
      ctx.body = { [key]: config[key] || {} }
    } else if (sections) {
      const keys = (sections as string).split(',')
      const result: Record<string, any> = {}
      for (const key of keys) {
        const trimmed = key.trim()
        result[trimmed] = trimmed === 'gatewayAutoStart'
          ? gatewayAutoStart
          : trimmed === 'proxy'
            ? proxy
            : (config[trimmed] || {})
      }
      ctx.body = result
    } else {
      ctx.body = { ...config, gatewayAutoStart, proxy, platformCredentialStatus }
    }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
}

export async function updateConfig(ctx: any) {
  const { section, values, restart } = ctx.request.body as { section: string; values: Record<string, any>; restart?: boolean }
  if (!section || !values) {
    ctx.status = 400; ctx.body = { error: 'Missing section or values' }; return
  }
  try {
    if (section === 'proxy') {
      const profile = requestedProfile(ctx)
      for (const key of PROXY_ENV_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(values, key)) continue
        await saveEnvValueForProfile(profile, key, values[key] ? String(values[key]) : '')
      }
      if (restart !== false && await gatewayAutoRestartAllowed()) {
        try {
          const restartResult = await restartGatewayForProfile(profile)
          logger.info('[config] gateway restarted after proxy update profile=%s result=%j', profile, restartResult)
        } catch (err) {
          logger.error(err, 'Gateway restart failed')
          ctx.status = 500
          ctx.body = { error: err instanceof Error ? err.message : 'Gateway restart failed' }
          return
        }
      }
      ctx.body = { success: true }
      return
    }

    if (APP_CONFIG_SECTIONS.has(section)) {
      if (section === 'gatewayAutoStart') {
        const appConfig = await readAppConfig()
        const previousGatewayAutoStart = await readGatewayAutoStartForResponse()
        const next: Record<string, any> = { ...(appConfig.gatewayAutoStart || {}), ...values }
        if ('include' in values && !Array.isArray(values.include)) delete next.include
        if ('exclude' in values && !Array.isArray(values.exclude)) delete next.exclude
        if ('enabled' in values && typeof values.enabled !== 'boolean') delete next.enabled
        delete next.management
        const gatewayAutoStart = normalizeGatewayAutoStartConfig(next)
        await writeAppConfig({ gatewayAutoStart })
        const writtenManagement = await writeHermesGatewayManagement(values.management)
        if (writtenManagement) gatewayAutoStart.management = writtenManagement
        else gatewayAutoStart.management = previousGatewayAutoStart.management
        const body: Record<string, any> = { success: true, gatewayAutoStart }
        if ('management' in values && gatewayAutoStart.enabled !== false && !gatewayAutostartDisabledByEnv()) {
          const gatewayManagement = await reconcileGatewayManagementTransition(previousGatewayAutoStart, gatewayAutoStart)
          if (gatewayManagement.changed) body.gatewayManagement = gatewayManagement
        }
        ctx.body = body
        return
      }
    }

    const profile = requestedProfile(ctx)
    await safeFileStore.updateYaml(configPath(profile), (config) => {
      config[section] = deepMerge(config[section] || {}, values)
      return config
    }, {
      backup: true,
      dumpOptions: {
        forceQuotes: true,
      },
    })
    if ((section === 'compression' && 'threshold' in values) || section === 'model') invalidateProviderRuntime(profile)

    // Platform adapters run through Hermes gateway; restart it so channel
    // config changes (Feishu/Weixin/etc.) are applied.
    const shouldRestartGateway = restart !== false &&
      PLATFORM_SECTIONS.has(section) &&
      await gatewayAutoRestartAllowed()
    if (shouldRestartGateway) {
      try {
        const restartResult = await restartGatewayForProfile(profile)
        logger.info('[config] gateway restarted after config update section=%s profile=%s result=%j', section, profile, restartResult)
      } catch (err) {
        logger.error(err, 'Gateway restart failed')
        ctx.status = 500
        ctx.body = { error: err instanceof Error ? err.message : 'Gateway restart failed' }
        return
      }
    }

    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
}

export async function getAuxiliaryModels(ctx: any) {
  try {
    const profile = requestedProfile(ctx)
    const config = await readConfig(profile)
    ctx.body = {
      tasks: AUXILIARY_TASKS,
      auxiliary: normalizeAuxiliaryConfig(config.auxiliary),
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function updateAuxiliaryModels(ctx: any) {
  const body = ctx.request.body as { auxiliary?: unknown }
  if (!body || !isPlainRecord(body.auxiliary)) {
    ctx.status = 400
    ctx.body = { error: 'Missing auxiliary config' }
    return
  }

  try {
    const profile = requestedProfile(ctx)
    const auxiliary = normalizeAuxiliaryConfig(body.auxiliary, { resetAuto: true })
    await safeFileStore.updateYaml(configPath(profile), (config) => {
      if (Object.keys(auxiliary).length > 0) config.auxiliary = auxiliary
      else delete config.auxiliary
      return config
    }, {
      backup: true,
      dumpOptions: {
        forceQuotes: true,
      },
    })
    ctx.body = { success: true, auxiliary }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function getDelegationModel(ctx: any) {
  try {
    const profile = requestedProfile(ctx)
    const config = await readConfig(profile)
    ctx.body = {
      delegation: normalizeDelegationModelConfig(config.delegation),
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function updateDelegationModel(ctx: any) {
  const body = ctx.request.body as { delegation?: unknown }
  if (!body || !isPlainRecord(body.delegation)) {
    ctx.status = 400
    ctx.body = { error: 'Missing delegation config' }
    return
  }
  if (hasInvalidDelegationModelConfig(body.delegation)) {
    ctx.status = 400
    ctx.body = { error: 'Invalid delegation model config' }
    return
  }

  try {
    const profile = requestedProfile(ctx)
    const delegation = normalizeDelegationModelConfig(body.delegation)
    await safeFileStore.updateYaml(configPath(profile), (config) => {
      const current = isPlainRecord(config.delegation) ? { ...config.delegation } : {}
      for (const field of DELEGATION_ROUTE_FIELDS) delete current[field]
      Object.assign(current, delegation)
      if (Object.keys(current).length > 0) config.delegation = current
      else delete config.delegation
      return config
    }, {
      backup: true,
      dumpOptions: {
        forceQuotes: true,
      },
    })
    ctx.body = { success: true, delegation }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

/**
 * Hermes reads `fallback_providers` from the profile's config.yaml and hands
 * the chain to the agent when a session starts. Entries missing a provider or
 * a model are ignored by the agent, so they are dropped here rather than
 * written out to sit in the file doing nothing.
 */
const MAX_FALLBACK_PROVIDERS = 10

function normalizeFallbackProviders(value: unknown): Array<{ provider: string; model: string }> {
  if (!Array.isArray(value)) return []
  const normalized: Array<{ provider: string; model: string }> = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!isPlainRecord(entry)) continue
    const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
    const model = typeof entry.model === 'string' ? entry.model.trim() : ''
    if (!provider || !model) continue
    // The chain is tried in order, so a repeat of an earlier pair can never fire.
    const key = `${provider}\u0000${model}`
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push({ provider, model })
    if (normalized.length >= MAX_FALLBACK_PROVIDERS) break
  }
  return normalized
}

export async function getFallbackProviders(ctx: any) {
  try {
    const profile = requestedProfile(ctx)
    const config = await readConfig(profile)
    ctx.body = { fallback_providers: normalizeFallbackProviders(config.fallback_providers) }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function updateFallbackProviders(ctx: any) {
  const body = ctx.request.body as { fallback_providers?: unknown }
  if (!body || !Array.isArray(body.fallback_providers)) {
    ctx.status = 400
    ctx.body = { error: 'Missing fallback_providers list' }
    return
  }

  try {
    const profile = requestedProfile(ctx)
    const fallbackProviders = normalizeFallbackProviders(body.fallback_providers)
    await safeFileStore.updateYaml(configPath(profile), (config) => {
      // An empty chain removes the key instead of leaving `fallback_providers: []`.
      if (fallbackProviders.length > 0) config.fallback_providers = fallbackProviders
      else delete config.fallback_providers
      return config
    }, {
      backup: true,
      dumpOptions: {
        forceQuotes: true,
      },
    })
    ctx.body = { success: true, fallback_providers: fallbackProviders }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function getMoaConfig(ctx: any) {
  try {
    const profile = requestedProfile(ctx)
    const config = await readConfig(profile)
    ctx.body = normalizeMoaConfig(config.moa)
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function updateMoaConfig(ctx: any) {
  const body = ctx.request.body as { moa?: unknown }
  if (!body || !isPlainRecord(body.moa)) {
    ctx.status = 400
    ctx.body = { error: 'Missing MoA config' }
    return
  }

  try {
    const profile = requestedProfile(ctx)
    const moa = normalizeMoaConfig(body.moa)
    await safeFileStore.updateYaml(configPath(profile), (config) => {
      config.moa = {
        default_preset: moa.default_preset,
        active_preset: moa.active_preset,
        presets: moa.presets,
      }
      return config
    }, {
      backup: true,
      dumpOptions: {
        forceQuotes: true,
      },
    })
    ctx.body = { success: true, moa }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

function removeConfigPath(config: any, platform: string, cfgPath: string): boolean {
  const parts = cfgPath.split('.')
  const obj: any = config.platforms?.[platform]
  if (!obj) return false
  if (parts.length === 1) {
    if (!Object.prototype.hasOwnProperty.call(obj, parts[0])) return false
    delete obj[parts[0]]
  } else {
    let cur = obj
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur?.[parts[i]]) return false
      cur = cur[parts[i]]
    }
    if (!Object.prototype.hasOwnProperty.call(cur, parts[parts.length - 1])) return false
    delete cur[parts[parts.length - 1]]
    if (obj.extra && Object.keys(obj.extra).length === 0) delete obj.extra
  }
  if (Object.keys(obj).length === 0) {
    if (!config.platforms) config.platforms = {}
    delete config.platforms[platform]
  }
  return true
}

function isSensitiveCredentialPath(cfgPath: string): boolean {
  const normalized = cfgPath.toLowerCase()
  const fieldName = normalized.split('.').pop() || normalized
  return EXCLUSIVE_PLATFORM_CREDENTIAL_KEYS.includes(fieldName) ||
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('key') ||
    normalized.includes('password') ||
    normalized.includes('credential')
}

export async function updateCredentials(ctx: any) {
  const { platform, values } = ctx.request.body as { platform: string; values: Record<string, any> }
  if (!platform || !values) {
    ctx.status = 400; ctx.body = { error: 'Missing platform or values' }; return
  }
  try {
    const profile = requestedProfile(ctx)
    const envMap = platformEnvMap[platform]
    if (!envMap) {
      ctx.status = 400; ctx.body = { error: `Unknown platform: ${platform}` }; return
    }
    const flatValues: Record<string, any> = {}
    for (const [key, val] of Object.entries(values)) {
      if (key === 'extra' && val && typeof val === 'object') {
        for (const [subKey, subVal] of Object.entries(val as Record<string, any>)) { flatValues[`extra.${subKey}`] = subVal }
      } else { flatValues[key] = val }
    }
    await safeFileStore.updateYaml(configPath(profile), async (config) => {
      for (const [cfgPath, val] of Object.entries(flatValues)) {
        const envVar = envMap[cfgPath]
        if (!envVar) continue
        if (val === undefined || val === null || val === '') {
          await saveEnvValueForProfile(profile, envVar, '')
          removeConfigPath(config, platform, cfgPath)
        } else {
          await saveEnvValueForProfile(profile, envVar, String(val))
          if (isSensitiveCredentialPath(cfgPath)) removeConfigPath(config, platform, cfgPath)
        }
      }
      return config
    }, {
      backup: true,
      dumpOptions: {
        forceQuotes: true,
      },
    })

    // Platform adapters run through Hermes gateway; restart it so channel
    // credentials are applied.
    if (await gatewayAutoRestartAllowed()) {
      try {
        const restartResult = await restartGatewayForProfile(profile)
        logger.info('[config] gateway restarted after credentials update platform=%s profile=%s result=%j', platform, profile, restartResult)
      } catch (err) {
        logger.error(err, 'Gateway restart failed')
        ctx.status = 500
        ctx.body = { error: err instanceof Error ? err.message : 'Gateway restart failed' }
        return
      }
    }

    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
}

export async function clearCredentials(ctx: any) {
  const platform = typeof ctx.params?.platform === 'string' ? ctx.params.platform.trim() : ''
  if (!platform || !PLATFORM_CREDENTIAL_PATHS[platform]) {
    ctx.status = 400
    ctx.body = { error: `Unsupported credential clearing platform: ${platform || 'missing'}` }
    return
  }

  try {
    const profile = requestedProfile(ctx)
    const envMap = platformEnvMap[platform] || {}
    let envRaw = ''
    try {
      envRaw = await readFile(envPath(profile), 'utf-8')
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err
    }

    let configFileExists = true
    try {
      await readFile(configPath(profile), 'utf-8')
    } catch (err: any) {
      if (err?.code === 'ENOENT') configFileExists = false
      else throw err
    }

    const result = await safeFileStore.updateYaml<{ clearedPaths: string[] }>(
      configPath(profile),
      async (config) => {
        const clearedPaths = new Set<string>()
        let changed = false

        for (const cfgPath of PLATFORM_CREDENTIAL_PATHS[platform]) {
          const envVar = envMap[cfgPath]
          if (!envVar) continue

          const envPresent = envContainsKey(envRaw, envVar)
          const configPresent = hasStoredValue(valueAtPath(config.platforms?.[platform], cfgPath))
          if (!envPresent && !configPresent) continue

          if (envPresent) {
            await saveEnvValueForProfile(profile, envVar, '')
            changed = true
          }
          if (removeConfigPath(config, platform, cfgPath)) changed = true
          clearedPaths.add(cfgPath)
        }

        return {
          data: config,
          result: { clearedPaths: [...clearedPaths] },
          // Do not create a new config.yaml when the credentials only lived in
          // .env. The env update above is still persisted independently.
          write: changed && configFileExists,
        }
      },
      {
        backup: true,
        dumpOptions: {
          forceQuotes: true,
        },
      },
    )

    const clearedPaths = result?.clearedPaths || []
    let gatewayRestarted = false
    let warning: { code: string; message: string } | undefined

    if (clearedPaths.length > 0) {
      let restartAllowed = false
      try {
        restartAllowed = await gatewayAutoRestartAllowed()
      } catch (err) {
        logger.error(err, '[config] gateway restart check failed after credentials clear platform=%s profile=%s', platform, profile)
        warning = {
          code: 'gateway_restart_failed',
          message: 'Credentials were cleared, but the gateway could not be restarted automatically.',
        }
      }

      if (!warning && restartAllowed) {
        try {
          const restartResult = await restartGatewayForProfile(profile)
          gatewayRestarted = restartResult.running
          logger.info('[config] gateway restarted after credentials clear platform=%s profile=%s result=%j', platform, profile, restartResult)
          if (!gatewayRestarted) {
            warning = {
              code: 'gateway_restart_failed',
              message: 'Credentials were cleared, but the gateway did not report running.',
            }
          }
        } catch (err) {
          logger.error(err, '[config] gateway restart failed after credentials clear platform=%s profile=%s', platform, profile)
          warning = {
            code: 'gateway_restart_failed',
            message: 'Credentials were cleared, but the gateway could not be restarted automatically.',
          }
        }
      } else if (!warning && !restartAllowed) {
        warning = {
          code: 'gateway_restart_disabled',
          message: 'Credentials were cleared, but gateway auto-restart is disabled. Restart the gateway manually to apply the change.',
        }
      }
    }

    ctx.body = {
      success: true,
      platform,
      clearedPaths,
      gatewayRestarted,
      ...(warning ? { warning } : {}),
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}
