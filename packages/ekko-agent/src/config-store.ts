import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveEkkoJevConfig } from './jev/config'
import {
  DEFAULT_CODE_EXEC_LANGUAGES,
  DEFAULT_EKKO_CONFIG,
  EKKO_CONFIG_SCHEMA_VERSION,
  type EkkoConfig,
  type EkkoConfigPatch,
  type EkkoMcpServerConfig,
  type EkkoModelAuthorizationSettings,
  type EkkoModelProviderSettings,
} from './config'
import {
  modelApiModeToRequestStyle,
  type EkkoModelApiMode,
  type EkkoModelProviderAuthType,
  type EkkoModelProviderPreset,
} from './model/provider-presets'
import type {
  ModelCapabilities,
  ModelProviderType,
  ModelReasoningEffort,
  ModelReasoningSummary,
  ModelRequestStyle,
  OpenAIChatReasoningReplayFormat,
} from './model/types'

const MODEL_PROVIDER_TYPES: ModelProviderType[] = [
  'openai',
  'openai-compatible',
  'anthropic',
  'gemini',
  'ollama',
  'custom',
]
const MODEL_REQUEST_STYLES: ModelRequestStyle[] = [
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
  'gemini-contents',
  'prompt-completion',
  'custom-runtime',
]
const MODEL_API_MODES: EkkoModelApiMode[] = [
  'chat_completions',
  'codex_responses',
  'anthropic_messages',
  'gemini_contents',
  'prompt_completion',
  'custom_runtime',
]
const MODEL_PROVIDER_AUTH_TYPES: EkkoModelProviderAuthType[] = ['none', 'api-key', 'oauth']
const REASONING_EFFORTS: ModelReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]
const REASONING_SUMMARIES: ModelReasoningSummary[] = ['auto', 'concise', 'detailed']
const OPENAI_CHAT_REASONING_FORMATS: OpenAIChatReasoningReplayFormat[] = [
  'reasoning',
  'reasoning_content',
  'reasoning_details',
  'none',
]
const PROVIDER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const MCP_SERVER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const CREDENTIAL_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'cookie',
  'set-cookie',
])

type JsonRecord = Record<string, unknown>

export interface EkkoConfigStoreOptions {
  configPath: string
}

export interface ConfiguredModelProviderEntry {
  id: string
  settings: EkkoModelProviderSettings
  isDefault: boolean
}

export interface ConfiguredModelAuthorizationEntry {
  provider: string
  settings: EkkoModelAuthorizationSettings
}

export interface InstallModelProviderPresetOptions extends Partial<EkkoModelProviderSettings> {
  apiKey?: string
}

export class EkkoConfigError extends Error {
  constructor(message: string, readonly path?: string) {
    super(path ? `${path}: ${message}` : message)
    this.name = 'EkkoConfigError'
  }
}

/**
 * Synchronous configuration boundary for one Ekko installation. Every
 * mutation reloads the current file and replaces it through a temporary file
 * so callers do not keep stale in-memory snapshots.
 */
export class EkkoConfigStore {
  readonly configPath: string
  private readonly listeners = new Set<(config: EkkoConfig) => void>()

  constructor(options: EkkoConfigStoreOptions) {
    this.configPath = options.configPath
  }

  read(): EkkoConfig {
    return loadEkkoConfig(this.configPath)
  }

  /** Add newly introduced default leaves without replacing user-owned values. */
  ensureDefaults(): EkkoConfig {
    const currentText = readFileSync(this.configPath, 'utf8')
    const normalized = parseEkkoConfig(currentText)
    const normalizedText = `${JSON.stringify(normalized, null, 2)}\n`
    if (currentText !== normalizedText) return writeEkkoConfig(this.configPath, normalized)
    return normalized
  }

  replace(config: EkkoConfig): EkkoConfig {
    const written = writeEkkoConfig(this.configPath, config)
    for (const listener of this.listeners) listener(structuredClone(written))
    return written
  }

  onDidChange(listener: (config: EkkoConfig) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  update(patch: EkkoConfigPatch): EkkoConfig {
    const current = this.read()
    return this.replace(normalizeEkkoConfig(mergeConfigPatch(current, patch)))
  }

  reset(): EkkoConfig {
    return this.replace(cloneDefaultConfig())
  }

  getSkillProfile(profile = 'default'): EkkoConfig['skills']['profiles'][string] {
    const profileId = normalizeProfileId(profile)
    return structuredClone(this.read().skills.profiles[profileId] ?? {
      disabled: [],
      externalDirectories: [],
    })
  }

  setSkillExternalDirectories(directories: string[], profile = 'default'): EkkoConfig {
    const profileId = normalizeProfileId(profile)
    const current = this.read()
    const existing = current.skills.profiles[profileId]
    return this.replace(normalizeEkkoConfig({
      ...current,
      skills: {
        ...current.skills,
        profiles: {
          ...current.skills.profiles,
          [profileId]: {
            disabled: existing?.disabled ?? [],
            externalDirectories: directories,
          },
        },
      },
    }))
  }

  setSkillEnabled(name: string, enabled: boolean, profile = 'default'): EkkoConfig {
    const profileId = normalizeProfileId(profile)
    const skillName = normalizeSkillName(name)
    const current = this.read()
    const existing = current.skills.profiles[profileId]
    const disabled = new Set(existing?.disabled ?? [])
    if (enabled) disabled.delete(skillName)
    else disabled.add(skillName)
    return this.replace(normalizeEkkoConfig({
      ...current,
      skills: {
        ...current.skills,
        profiles: {
          ...current.skills.profiles,
          [profileId]: {
            externalDirectories: existing?.externalDirectories ?? [],
            disabled: [...disabled].sort((left, right) => left.localeCompare(right)),
          },
        },
      },
    }))
  }

  listMcpServers(profile = 'default'): Record<string, EkkoMcpServerConfig> {
    const key = normalizeProfileId(profile)
    return structuredClone(this.read().mcp.profiles[key]?.servers ?? {})
  }

  getMcpServer(name: string, profile = 'default'): EkkoMcpServerConfig | undefined {
    const serverName = normalizeMcpServerName(name)
    const server = this.listMcpServers(profile)[serverName]
    return server ? structuredClone(server) : undefined
  }

  setMcpServer(
    name: string,
    settings: EkkoMcpServerConfig,
    profile = 'default',
  ): EkkoConfig {
    const profileId = normalizeProfileId(profile)
    const serverName = normalizeMcpServerName(name)
    const current = this.read()
    const existingProfile = current.mcp.profiles[profileId]
    return this.replace(normalizeEkkoConfig({
      ...current,
      mcp: {
        ...current.mcp,
        profiles: {
          ...current.mcp.profiles,
          [profileId]: {
            ...existingProfile,
            servers: {
              ...existingProfile?.servers,
              [serverName]: settings,
            },
          },
        },
      },
    }))
  }

  deleteMcpServer(name: string, profile = 'default'): boolean {
    const profileId = normalizeProfileId(profile)
    const serverName = normalizeMcpServerName(name)
    const current = this.read()
    const existingProfile = current.mcp.profiles[profileId]
    if (!existingProfile?.servers[serverName]) return false
    const servers = { ...existingProfile.servers }
    delete servers[serverName]
    this.replace(normalizeEkkoConfig({
      ...current,
      mcp: {
        ...current.mcp,
        profiles: {
          ...current.mcp.profiles,
          [profileId]: { ...existingProfile, servers },
        },
      },
    }))
    return true
  }

  listModelProviderPresets(): EkkoModelProviderPreset[] {
    return Object.values(this.read().model.providerCatalog)
      .sort((left, right) => left.label.localeCompare(right.label))
      .map(preset => structuredClone(preset))
  }

  getModelProviderPreset(id: string): EkkoModelProviderPreset | undefined {
    const providerId = normalizeProviderId(id)
    const preset = this.read().model.providerCatalog[providerId]
    return preset ? structuredClone(preset) : undefined
  }

  setModelProviderPreset(id: string, preset: Omit<EkkoModelProviderPreset, 'id'> & { id?: string }): EkkoConfig {
    const providerId = normalizeProviderId(id)
    const current = this.read()
    const disabledProviderPresets = current.model.disabledProviderPresets
      .filter(disabledId => disabledId !== providerId)
    return this.replace(normalizeEkkoConfig({
      ...current,
      model: {
        ...current.model,
        providerCatalog: {
          ...current.model.providerCatalog,
          [providerId]: { ...preset, id: providerId },
        },
        disabledProviderPresets,
      },
    }))
  }

  updateModelProviderPreset(id: string, patch: Partial<EkkoModelProviderPreset>): EkkoConfig {
    const providerId = normalizeProviderId(id)
    const existing = this.read().model.providerCatalog[providerId]
    if (!existing) throw new EkkoConfigError('model provider preset does not exist', `model.providerCatalog.${providerId}`)
    return this.setModelProviderPreset(providerId, { ...existing, ...patch, id: providerId })
  }

  deleteModelProviderPreset(id: string): boolean {
    const providerId = normalizeProviderId(id)
    const current = this.read()
    if (!current.model.providerCatalog[providerId]) return false
    const providerCatalog = { ...current.model.providerCatalog }
    delete providerCatalog[providerId]
    const disabledProviderPresets = [...new Set([
      ...current.model.disabledProviderPresets,
      providerId,
    ])]
    this.replace(normalizeEkkoConfig({
      ...current,
      model: { ...current.model, providerCatalog, disabledProviderPresets },
    }))
    return true
  }

  installModelProviderPreset(
    id: string,
    options: InstallModelProviderPresetOptions = {},
  ): EkkoConfig {
    const providerId = normalizeProviderId(id)
    const preset = this.read().model.providerCatalog[providerId]
    if (!preset) throw new EkkoConfigError('model provider preset does not exist', `model.providerCatalog.${providerId}`)
    return this.setModelProvider(providerId, {
      label: preset.label,
      type: preset.type,
      apiMode: preset.apiMode,
      requestStyle: preset.requestStyle,
      baseUrl: preset.baseUrl,
      defaultModel: preset.defaultModel,
      models: [...preset.models],
      authType: preset.authType,
      source: preset.builtin ? 'builtin' : 'custom',
      ...options,
    })
  }

  listModelProviders(): ConfiguredModelProviderEntry[] {
    const config = this.read()
    return Object.entries(config.model.providers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, settings]) => ({
        id,
        settings: structuredClone(settings),
        isDefault: id === config.model.defaultProvider,
      }))
  }

  getModelProvider(id: string): EkkoModelProviderSettings | undefined {
    const providerId = normalizeProviderId(id)
    const settings = this.read().model.providers[providerId]
    return settings ? structuredClone(settings) : undefined
  }

  setModelProvider(id: string, settings: EkkoModelProviderSettings): EkkoConfig {
    const providerId = normalizeProviderId(id)
    const current = this.read()
    const providers = {
      ...current.model.providers,
      [providerId]: settings,
    }
    return this.replace(normalizeEkkoConfig({
      ...current,
      model: { ...current.model, providers },
    }))
  }

  updateModelProvider(id: string, patch: Partial<EkkoModelProviderSettings>): EkkoConfig {
    const providerId = normalizeProviderId(id)
    const current = this.read()
    const existing = current.model.providers[providerId]
    if (!existing) throw new EkkoConfigError('model provider does not exist', `model.providers.${providerId}`)
    return this.setModelProvider(providerId, { ...existing, ...patch })
  }

  deleteModelProvider(id: string): boolean {
    const providerId = normalizeProviderId(id)
    const current = this.read()
    if (!current.model.providers[providerId]) return false
    const providers = { ...current.model.providers }
    const authorizations = { ...current.model.authorizations }
    delete providers[providerId]
    delete authorizations[providerId]
    const removingDefault = current.model.defaultProvider === providerId
    this.replace(normalizeEkkoConfig({
      ...current,
      model: {
        ...current.model,
        providers,
        authorizations,
        ...(removingDefault ? { defaultProvider: '', defaultModel: '' } : {}),
      },
    }))
    return true
  }

  setDefaultModel(provider: string, model?: string): EkkoConfig {
    const providerId = normalizeProviderId(provider)
    const current = this.read()
    const settings = current.model.providers[providerId]
    if (!settings) throw new EkkoConfigError('model provider does not exist', `model.providers.${providerId}`)
    const defaultModel = String(model || settings.defaultModel).trim()
    if (!defaultModel) throw new EkkoConfigError('must not be empty', 'model.defaultModel')
    return this.update({
      model: {
        defaultProvider: providerId,
        defaultModel,
      },
    })
  }

  listModelAuthorizations(): ConfiguredModelAuthorizationEntry[] {
    return Object.entries(this.read().model.authorizations)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([provider, settings]) => ({
        provider,
        settings: structuredClone(settings),
      }))
  }

  getModelAuthorization(provider: string): EkkoModelAuthorizationSettings | undefined {
    const providerId = normalizeProviderId(provider)
    const settings = this.read().model.authorizations[providerId]
    return settings ? structuredClone(settings) : undefined
  }

  setModelAuthorization(provider: string, settings: EkkoModelAuthorizationSettings): EkkoConfig {
    const providerId = normalizeProviderId(provider)
    const current = this.read()
    if (!current.model.providers[providerId]) {
      throw new EkkoConfigError('model provider does not exist', `model.providers.${providerId}`)
    }
    return this.replace(normalizeEkkoConfig({
      ...current,
      model: {
        ...current.model,
        authorizations: {
          ...current.model.authorizations,
          [providerId]: settings,
        },
      },
    }))
  }

  updateModelAuthorization(
    provider: string,
    patch: Partial<EkkoModelAuthorizationSettings>,
  ): EkkoConfig {
    const providerId = normalizeProviderId(provider)
    const existing = this.read().model.authorizations[providerId]
    if (!existing) {
      throw new EkkoConfigError('model authorization does not exist', `model.authorizations.${providerId}`)
    }
    return this.setModelAuthorization(providerId, { ...existing, ...patch })
  }

  deleteModelAuthorization(provider: string): boolean {
    const providerId = normalizeProviderId(provider)
    const current = this.read()
    if (!current.model.authorizations[providerId]) return false
    const authorizations = { ...current.model.authorizations }
    delete authorizations[providerId]
    this.replace(normalizeEkkoConfig({
      ...current,
      model: { ...current.model, authorizations },
    }))
    return true
  }
}

export function loadEkkoConfig(configPath: string): EkkoConfig {
  let raw: string
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch (error) {
    throw new EkkoConfigError(
      `could not read config: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return parseEkkoConfig(raw)
}

function parseEkkoConfig(raw: string): EkkoConfig {
  try {
    return normalizeEkkoConfig(JSON.parse(raw))
  } catch (error) {
    if (error instanceof EkkoConfigError) throw error
    throw new EkkoConfigError(`contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function writeEkkoConfig(configPath: string, config: EkkoConfig): EkkoConfig {
  const normalized = normalizeEkkoConfig(config)
  const directory = dirname(configPath)
  const temporaryPath = join(directory, `.config-${randomUUID()}.tmp`)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    try {
      renameSync(temporaryPath, configPath)
    } catch {
      writeFileSync(configPath, `${JSON.stringify(normalized, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
    }
    try {
      chmodSync(configPath, 0o600)
    } catch {
      // Some filesystems do not expose POSIX permissions.
    }
  } finally {
    rmSync(temporaryPath, { force: true })
  }
  return normalized
}

export function normalizeEkkoConfig(value: unknown): EkkoConfig {
  const source = record(mergeMissingDefaults(DEFAULT_EKKO_CONFIG, value), 'config')
  const sourceSchemaVersion = integer(source.schemaVersion, EKKO_CONFIG_SCHEMA_VERSION, 'schemaVersion', 1)
  if (sourceSchemaVersion > EKKO_CONFIG_SCHEMA_VERSION) {
    throw new EkkoConfigError(
      `version ${sourceSchemaVersion} is newer than supported version ${EKKO_CONFIG_SCHEMA_VERSION}`,
      'schemaVersion',
    )
  }
  const runtime = record(source.runtime, 'runtime', true)
  const model = record(source.model, 'model', true)
  const tools = record(source.tools, 'tools', true)
  const approvals = record(tools.approvals, 'tools.approvals', true)
  const codeExec = record(tools.codeExec, 'tools.codeExec', true)
  const mcp = record(source.mcp, 'mcp', true)
  const delegation = record(source.delegation, 'delegation', true)
  const compression = record(source.compression, 'compression', true)
  const memory = record(source.memory, 'memory', true)
  let jev: EkkoConfig['jev']
  try {
    jev = resolveEkkoJevConfig(record(source.jev, 'jev', true))
  } catch (error) {
    throw new EkkoConfigError(error instanceof Error ? error.message : 'Invalid JEV configuration.', 'jev')
  }
  const skills = record(source.skills, 'skills', true)
  const logging = record(source.logging, 'logging', true)
  const prompt = record(source.prompt, 'prompt', true)
  const disabledProviderPresets = stringArray(
    model.disabledProviderPresets,
    DEFAULT_EKKO_CONFIG.model.disabledProviderPresets,
    'model.disabledProviderPresets',
  ).map(normalizeProviderId)
  const providerCatalog = normalizeProviderCatalog(model.providerCatalog)
  for (const provider of disabledProviderPresets) delete providerCatalog[provider]
  const providers = normalizeProviders(model.providers)
  const authorizations = normalizeAuthorizations(model.authorizations)
  const mcpProfiles = normalizeMcpProfiles(mcp.profiles)
  const skillProfiles = normalizeSkillProfiles(skills.profiles)

  const normalized: EkkoConfig = {
    ...source,
    jev,
    schemaVersion: EKKO_CONFIG_SCHEMA_VERSION,
    runtime: {
      ...runtime,
      maxSteps: integer(runtime.maxSteps, DEFAULT_EKKO_CONFIG.runtime.maxSteps, 'runtime.maxSteps', 1),
      maxModelRetries: integer(runtime.maxModelRetries, DEFAULT_EKKO_CONFIG.runtime.maxModelRetries, 'runtime.maxModelRetries', 0),
      toolFailureRecoveryThreshold: integer(
        runtime.toolFailureRecoveryThreshold,
        DEFAULT_EKKO_CONFIG.runtime.toolFailureRecoveryThreshold,
        'runtime.toolFailureRecoveryThreshold',
        1,
      ),
      maxConsecutiveToolFailures: integer(
        runtime.maxConsecutiveToolFailures,
        DEFAULT_EKKO_CONFIG.runtime.maxConsecutiveToolFailures,
        'runtime.maxConsecutiveToolFailures',
        1,
      ),
    },
    model: {
      ...model,
      defaultProvider: stringValue(model.defaultProvider, DEFAULT_EKKO_CONFIG.model.defaultProvider, 'model.defaultProvider'),
      defaultModel: stringValue(model.defaultModel, DEFAULT_EKKO_CONFIG.model.defaultModel, 'model.defaultModel'),
      requestTimeoutMs: integer(
        model.requestTimeoutMs,
        DEFAULT_EKKO_CONFIG.model.requestTimeoutMs,
        'model.requestTimeoutMs',
        1,
      ),
      ...(model.temperature === undefined
        ? {}
        : { temperature: finiteNumber(model.temperature, 'model.temperature', 0) }),
      ...(model.maxTokens === undefined
        ? {}
        : { maxTokens: integer(model.maxTokens, 0, 'model.maxTokens', 1) }),
      reasoningEffort: enumValue(
        model.reasoningEffort,
        REASONING_EFFORTS,
        DEFAULT_EKKO_CONFIG.model.reasoningEffort,
        'model.reasoningEffort',
      ),
      reasoningSummary: enumValue(
        model.reasoningSummary,
        REASONING_SUMMARIES,
        DEFAULT_EKKO_CONFIG.model.reasoningSummary,
        'model.reasoningSummary',
      ),
      authorizationRefreshLeewayMs: integer(
        model.authorizationRefreshLeewayMs,
        DEFAULT_EKKO_CONFIG.model.authorizationRefreshLeewayMs,
        'model.authorizationRefreshLeewayMs',
        0,
      ),
      providerCatalog,
      disabledProviderPresets,
      providers,
      authorizations,
    },
    tools: {
      ...tools,
      enabled: booleanValue(tools.enabled, DEFAULT_EKKO_CONFIG.tools.enabled, 'tools.enabled'),
      executionTimeoutMs: integer(
        tools.executionTimeoutMs,
        DEFAULT_EKKO_CONFIG.tools.executionTimeoutMs,
        'tools.executionTimeoutMs',
        1,
      ),
      approvals: {
        ...approvals,
        enabled: booleanValue(
          approvals.enabled,
          DEFAULT_EKKO_CONFIG.tools.approvals.enabled,
          'tools.approvals.enabled',
        ),
        timeoutMs: integer(
          approvals.timeoutMs,
          DEFAULT_EKKO_CONFIG.tools.approvals.timeoutMs,
          'tools.approvals.timeoutMs',
          1,
        ),
        permanentAllow: stringArray(
          approvals.permanentAllow,
          DEFAULT_EKKO_CONFIG.tools.approvals.permanentAllow,
          'tools.approvals.permanentAllow',
        ),
      },
      codeExec: {
        ...codeExec,
        enabled: booleanValue(codeExec.enabled, DEFAULT_EKKO_CONFIG.tools.codeExec.enabled, 'tools.codeExec.enabled'),
        languages: codeExecLanguages(codeExec.languages),
        timeoutMs: integer(codeExec.timeoutMs, DEFAULT_EKKO_CONFIG.tools.codeExec.timeoutMs, 'tools.codeExec.timeoutMs', 1),
        maxToolCalls: integer(codeExec.maxToolCalls, DEFAULT_EKKO_CONFIG.tools.codeExec.maxToolCalls, 'tools.codeExec.maxToolCalls', 1),
        maxOutputBytes: integer(codeExec.maxOutputBytes, DEFAULT_EKKO_CONFIG.tools.codeExec.maxOutputBytes, 'tools.codeExec.maxOutputBytes', 1),
        maxStderrBytes: integer(codeExec.maxStderrBytes, DEFAULT_EKKO_CONFIG.tools.codeExec.maxStderrBytes, 'tools.codeExec.maxStderrBytes', 1),
        maxSourceBytes: integer(codeExec.maxSourceBytes, DEFAULT_EKKO_CONFIG.tools.codeExec.maxSourceBytes, 'tools.codeExec.maxSourceBytes', 1),
      },
    },
    mcp: {
      ...mcp,
      enabled: booleanValue(mcp.enabled, DEFAULT_EKKO_CONFIG.mcp.enabled, 'mcp.enabled'),
      profiles: mcpProfiles,
    },
    delegation: {
      ...delegation,
      backgroundEnabled: booleanValue(
        delegation.backgroundEnabled,
        DEFAULT_EKKO_CONFIG.delegation.backgroundEnabled,
        'delegation.backgroundEnabled',
      ),
      subtaskMaxSteps: integer(
        delegation.subtaskMaxSteps,
        DEFAULT_EKKO_CONFIG.delegation.subtaskMaxSteps,
        'delegation.subtaskMaxSteps',
        1,
      ),
    },
    compression: {
      ...compression,
      enabled: booleanValue(
        compression.enabled,
        DEFAULT_EKKO_CONFIG.compression.enabled,
        'compression.enabled',
      ),
      threshold: boundedNumber(
        compression.threshold,
        DEFAULT_EKKO_CONFIG.compression.threshold,
        'compression.threshold',
        0.05,
        0.95,
      ),
      targetRatio: boundedNumber(
        compression.targetRatio,
        DEFAULT_EKKO_CONFIG.compression.targetRatio,
        'compression.targetRatio',
        0.01,
        0.8,
      ),
      protectLastN: boundedInteger(
        compression.protectLastN,
        DEFAULT_EKKO_CONFIG.compression.protectLastN,
        'compression.protectLastN',
        0,
        500,
      ),
      protectFirstN: boundedInteger(
        compression.protectFirstN,
        DEFAULT_EKKO_CONFIG.compression.protectFirstN,
        'compression.protectFirstN',
        0,
        100,
      ),
    },
    memory: {
      enabled: booleanValue(memory.enabled, DEFAULT_EKKO_CONFIG.memory.enabled, 'memory.enabled'),
      recentMessageLimit: integer(memory.recentMessageLimit, DEFAULT_EKKO_CONFIG.memory.recentMessageLimit, 'memory.recentMessageLimit', 1),
      automaticRecallTokenBudget: integer(memory.automaticRecallTokenBudget, DEFAULT_EKKO_CONFIG.memory.automaticRecallTokenBudget, 'memory.automaticRecallTokenBudget', 0),
      searchResultLimit: integer(memory.searchResultLimit, DEFAULT_EKKO_CONFIG.memory.searchResultLimit, 'memory.searchResultLimit', 1),
    },
    skills: {
      ...skills,
      enabled: booleanValue(skills.enabled, DEFAULT_EKKO_CONFIG.skills.enabled, 'skills.enabled'),
      reviewEveryToolCalls: integer(skills.reviewEveryToolCalls, DEFAULT_EKKO_CONFIG.skills.reviewEveryToolCalls, 'skills.reviewEveryToolCalls', 0),
      profiles: skillProfiles,
    },
    logging: {
      ...logging,
      maxBytes: integer(logging.maxBytes, DEFAULT_EKKO_CONFIG.logging.maxBytes, 'logging.maxBytes', 1),
    },
    prompt: {
      ...prompt,
      instructions: stringArray(prompt.instructions, DEFAULT_EKKO_CONFIG.prompt.instructions, 'prompt.instructions'),
    },
  }

  if (normalized.model.defaultProvider && !PROVIDER_ID_PATTERN.test(normalized.model.defaultProvider)) {
    throw new EkkoConfigError('contains an invalid provider id', 'model.defaultProvider')
  }
  if (
    normalized.model.defaultProvider &&
    !normalized.model.providers[normalized.model.defaultProvider]
  ) {
    throw new EkkoConfigError('must reference a configured provider', 'model.defaultProvider')
  }
  if (normalized.model.defaultProvider && !normalized.model.defaultModel) {
    normalized.model.defaultModel = normalized.model.providers[normalized.model.defaultProvider].defaultModel
  }
  for (const provider of Object.keys(normalized.model.authorizations)) {
    if (!normalized.model.providers[provider]) {
      throw new EkkoConfigError('must reference a configured provider', `model.authorizations.${provider}`)
    }
  }
  if (normalized.tools.codeExec.enabled && normalized.tools.codeExec.languages.length === 0) {
    throw new EkkoConfigError('must contain at least one language when code_exec is enabled', 'tools.codeExec.languages')
  }
  return normalized
}

function mergeConfigPatch(current: EkkoConfig, patch: EkkoConfigPatch): JsonRecord {
  return {
    ...current,
    ...patch,
    runtime: { ...current.runtime, ...patch.runtime },
    model: {
      ...current.model,
      ...patch.model,
      providerCatalog: {
        ...current.model.providerCatalog,
        ...patch.model?.providerCatalog,
      },
      disabledProviderPresets: patch.model?.disabledProviderPresets
        ?? current.model.disabledProviderPresets,
      providers: {
        ...current.model.providers,
        ...patch.model?.providers,
      },
      authorizations: {
        ...current.model.authorizations,
        ...patch.model?.authorizations,
      },
    },
    tools: {
      ...current.tools,
      ...patch.tools,
      approvals: { ...current.tools.approvals, ...patch.tools?.approvals },
      codeExec: { ...current.tools.codeExec, ...patch.tools?.codeExec },
    },
    mcp: {
      ...current.mcp,
      ...patch.mcp,
      profiles: {
        ...current.mcp.profiles,
        ...patch.mcp?.profiles,
      },
    },
    delegation: { ...current.delegation, ...patch.delegation },
    compression: { ...current.compression, ...patch.compression },
    memory: { ...current.memory, ...patch.memory },
    jev: { ...current.jev, ...patch.jev },
    skills: {
      ...current.skills,
      ...patch.skills,
      profiles: {
        ...current.skills.profiles,
        ...Object.fromEntries(Object.entries(patch.skills?.profiles ?? {}).map(([profile, value]) => [
          profile,
          { ...current.skills.profiles[profile], ...value },
        ])),
      },
    },
    logging: { ...current.logging, ...patch.logging },
    prompt: { ...current.prompt, ...patch.prompt },
  }
}

/**
 * Recursively fills only absent leaves. Existing scalars, arrays, objects, and
 * forward-compatible unknown keys remain user-owned.
 */
function mergeMissingDefaults(defaults: unknown, current: unknown): unknown {
  if (current === undefined) return structuredClone(defaults)
  if (
    !defaults ||
    typeof defaults !== 'object' ||
    Array.isArray(defaults) ||
    !current ||
    typeof current !== 'object' ||
    Array.isArray(current)
  ) {
    return current
  }
  const defaultRecord = defaults as JsonRecord
  const currentRecord = current as JsonRecord
  const merged: JsonRecord = { ...currentRecord }
  for (const [key, defaultValue] of Object.entries(defaultRecord)) {
    merged[key] = mergeMissingDefaults(defaultValue, currentRecord[key])
  }
  return merged
}

function normalizeMcpProfiles(value: unknown): EkkoConfig['mcp']['profiles'] {
  const source = record(value, 'mcp.profiles', true)
  const profiles: EkkoConfig['mcp']['profiles'] = {}
  for (const [rawProfile, rawProfileConfig] of Object.entries(source)) {
    const profile = normalizeProfileId(rawProfile)
    const path = `mcp.profiles.${profile}`
    const profileConfig = record(rawProfileConfig, path)
    const rawServers = record(profileConfig.servers, `${path}.servers`, true)
    const servers: Record<string, EkkoMcpServerConfig> = {}
    for (const [rawName, rawServer] of Object.entries(rawServers)) {
      const name = normalizeMcpServerName(rawName)
      servers[name] = normalizeMcpServerConfig(rawServer, `${path}.servers.${name}`)
    }
    profiles[profile] = { ...profileConfig, servers }
  }
  return profiles
}

function mcpServerType(value: unknown, path: string): 'stdio' | 'streamable_http' | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new EkkoConfigError('must be one of: stdio, streamable_http', path)
  }
  const normalized = value.trim().toLowerCase()
  if (normalized === 'stdio') return 'stdio'
  if (
    normalized === 'http'
    || normalized === 'streamable_http'
    || normalized === 'streamable-http'
    || normalized === 'streamablehttp'
  ) {
    return 'streamable_http'
  }
  throw new EkkoConfigError('must be one of: stdio, streamable_http', path)
}

function normalizeMcpServerConfig(value: unknown, path: string): EkkoMcpServerConfig {
  const source = record(value, path)
  const configuredType = mcpServerType(source.type, `${path}.type`)
  const command = optionalString(source.command, `${path}.command`)
  const url = optionalString(source.url, `${path}.url`)
  const type = configuredType ?? (url ? 'streamable_http' : 'stdio')
  if (type === 'stdio' && !command) throw new EkkoConfigError('is required for stdio MCP servers', `${path}.command`)
  if (type === 'streamable_http' && !url) throw new EkkoConfigError('is required for Streamable HTTP MCP servers', `${path}.url`)
  if (url) validateMcpHttpUrl(url, `${path}.url`)
  const args = source.args === undefined
    ? undefined
    : mcpArgs(source.args, `${path}.args`)
  const env = source.env === undefined
    ? undefined
    : stringRecord(source.env, `${path}.env`)
  const headers = source.headers === undefined
    ? undefined
    : stringRecord(source.headers, `${path}.headers`)
  return {
    ...source,
    ...(configuredType || type === 'streamable_http' ? { type } : {}),
    ...(type === 'stdio' ? { command, ...(args ? { args } : {}), ...(env ? { env } : {}) } : {}),
    ...(type === 'streamable_http' ? { url, ...(headers ? { headers } : {}) } : {}),
    enabled: booleanValue(source.enabled, true, `${path}.enabled`),
  }
}

function normalizeSkillProfiles(value: unknown): EkkoConfig['skills']['profiles'] {
  const source = record(value, 'skills.profiles', true)
  const profiles: EkkoConfig['skills']['profiles'] = {}
  for (const [rawProfile, rawProfileConfig] of Object.entries(source)) {
    const profile = normalizeProfileId(rawProfile)
    const path = `skills.profiles.${profile}`
    const profileConfig = record(rawProfileConfig, path)
    profiles[profile] = {
      ...profileConfig,
      disabled: stringArray(profileConfig.disabled, [], `${path}.disabled`).map(normalizeSkillName),
      externalDirectories: externalDirectoryArray(
        profileConfig.externalDirectories,
        `${path}.externalDirectories`,
      ),
    }
  }
  return profiles
}

function validateMcpHttpUrl(value: string, path: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new EkkoConfigError('must be a valid URL', path)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EkkoConfigError('must use http or https', path)
  }
}

function mcpArgs(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new EkkoConfigError('must be an array of strings', path)
  }
  return [...value]
}

function normalizeProviderCatalog(value: unknown): Record<string, EkkoModelProviderPreset> {
  const source = record(value, 'model.providerCatalog', true)
  const catalog: Record<string, EkkoModelProviderPreset> = {}
  for (const [rawId, rawPreset] of Object.entries(source)) {
    const id = normalizeProviderId(rawId)
    const path = `model.providerCatalog.${id}`
    const preset = record(rawPreset, path)
    const configuredId = normalizeProviderId(requiredString(preset.id, `${path}.id`))
    if (configuredId !== id) throw new EkkoConfigError('must match its catalog key', `${path}.id`)
    const apiMode = enumValue(preset.apiMode, MODEL_API_MODES, undefined, `${path}.apiMode`)
    const requestStyle = enumValue(
      preset.requestStyle,
      MODEL_REQUEST_STYLES,
      modelApiModeToRequestStyle(apiMode),
      `${path}.requestStyle`,
    )
    if (requestStyle !== modelApiModeToRequestStyle(apiMode)) {
      throw new EkkoConfigError('does not match apiMode', `${path}.requestStyle`)
    }
    catalog[id] = {
      id,
      label: requiredString(preset.label, `${path}.label`),
      type: enumValue(preset.type, MODEL_PROVIDER_TYPES, undefined, `${path}.type`),
      apiMode,
      requestStyle,
      baseUrl: requiredString(preset.baseUrl, `${path}.baseUrl`),
      defaultModel: requiredString(preset.defaultModel, `${path}.defaultModel`),
      models: stringArray(preset.models, [], `${path}.models`),
      authType: enumValue(preset.authType, MODEL_PROVIDER_AUTH_TYPES, undefined, `${path}.authType`),
      builtin: booleanValue(preset.builtin, true, `${path}.builtin`),
    }
  }
  return catalog
}

function normalizeProviders(value: unknown): Record<string, EkkoModelProviderSettings> {
  const source = record(value, 'model.providers', true)
  const providers: Record<string, EkkoModelProviderSettings> = {}
  for (const [rawId, rawSettings] of Object.entries(source)) {
    const id = normalizeProviderId(rawId)
    providers[id] = normalizeProviderSettings(rawSettings, `model.providers.${id}`)
  }
  return providers
}

function normalizeProviderSettings(value: unknown, path: string): EkkoModelProviderSettings {
  const source = record(value, path)
  const settings: EkkoModelProviderSettings = {
    ...source,
    type: enumValue(source.type, MODEL_PROVIDER_TYPES, undefined, `${path}.type`),
    defaultModel: requiredString(source.defaultModel, `${path}.defaultModel`),
  }
  if (source.label !== undefined) settings.label = requiredString(source.label, `${path}.label`)
  if (source.apiMode !== undefined) {
    settings.apiMode = enumValue(source.apiMode, MODEL_API_MODES, undefined, `${path}.apiMode`)
  }
  if (source.requestStyle !== undefined) {
    settings.requestStyle = enumValue(source.requestStyle, MODEL_REQUEST_STYLES, undefined, `${path}.requestStyle`)
  }
  if (
    settings.apiMode &&
    settings.requestStyle &&
    settings.requestStyle !== modelApiModeToRequestStyle(settings.apiMode)
  ) {
    throw new EkkoConfigError('does not match apiMode', `${path}.requestStyle`)
  }
  if (source.openAIChatReasoningReplayFormat !== undefined) {
    settings.openAIChatReasoningReplayFormat = enumValue(
      source.openAIChatReasoningReplayFormat,
      OPENAI_CHAT_REASONING_FORMATS,
      undefined,
      `${path}.openAIChatReasoningReplayFormat`,
    )
  }
  for (const key of ['baseUrl', 'endpointPath'] as const) {
    if (source[key] !== undefined) settings[key] = requiredString(source[key], `${path}.${key}`)
  }
  if (source.apiKey !== undefined) settings.apiKey = stringValue(source.apiKey, '', `${path}.apiKey`)
  if (source.models !== undefined) settings.models = stringArray(source.models, [], `${path}.models`)
  if (source.authType !== undefined) {
    settings.authType = enumValue(source.authType, MODEL_PROVIDER_AUTH_TYPES, undefined, `${path}.authType`)
  }
  if (source.source !== undefined) {
    settings.source = enumValue(source.source, ['builtin', 'custom'] as const, undefined, `${path}.source`)
  }
  if (source.headers !== undefined) settings.headers = providerHeaders(source.headers, `${path}.headers`)
  if (source.timeoutMs !== undefined) settings.timeoutMs = integer(source.timeoutMs, 0, `${path}.timeoutMs`, 1)
  if (source.capabilities !== undefined) {
    settings.capabilities = normalizeCapabilities(source.capabilities, `${path}.capabilities`)
  }
  return settings
}

function normalizeAuthorizations(value: unknown): Record<string, EkkoModelAuthorizationSettings> {
  const source = record(value, 'model.authorizations', true)
  const authorizations: Record<string, EkkoModelAuthorizationSettings> = {}
  for (const [rawProvider, rawSettings] of Object.entries(source)) {
    const provider = normalizeProviderId(rawProvider)
    const path = `model.authorizations.${provider}`
    const input = record(rawSettings, path)
    const settings: EkkoModelAuthorizationSettings = {
      ...input,
      type: enumValue(input.type, ['oauth'], undefined, `${path}.type`),
    }
    for (const key of [
      'accessToken',
      'refreshToken',
      'tokenUrl',
      'clientId',
      'clientSecret',
      'scope',
      'baseUrl',
    ] as const) {
      if (input[key] !== undefined) settings[key] = stringValue(input[key], '', `${path}.${key}`)
    }
    for (const key of ['expiresAt', 'obtainedAt'] as const) {
      if (input[key] !== undefined) settings[key] = isoDateString(input[key], `${path}.${key}`)
    }
    if (input.tokenParams !== undefined) {
      settings.tokenParams = stringRecord(input.tokenParams, `${path}.tokenParams`)
    }
    if (input.apiMode !== undefined) {
      settings.apiMode = enumValue(input.apiMode, MODEL_API_MODES, undefined, `${path}.apiMode`)
    }
    authorizations[provider] = settings
  }
  return authorizations
}

function normalizeCapabilities(value: unknown, path: string): Partial<ModelCapabilities> {
  const source = record(value, path)
  const capabilities: Partial<ModelCapabilities> = { ...source }
  for (const key of ['streaming', 'tools', 'vision', 'jsonMode', 'systemPrompt'] as const) {
    if (source[key] !== undefined) capabilities[key] = booleanValue(source[key], false, `${path}.${key}`)
  }
  if (source.maxInputTokens !== undefined) {
    capabilities.maxInputTokens = integer(source.maxInputTokens, 0, `${path}.maxInputTokens`, 1)
  }
  return capabilities
}

function cloneDefaultConfig(): EkkoConfig {
  return structuredClone(DEFAULT_EKKO_CONFIG)
}

function normalizeProviderId(value: string): string {
  const id = String(value || '').trim()
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new EkkoConfigError('must contain only letters, numbers, dot, underscore, or dash', 'model provider id')
  }
  return id
}

function normalizeProfileId(value: string): string {
  return String(value || '').trim() || 'default'
}

function normalizeSkillName(value: string): string {
  const name = String(value || '').trim().toLowerCase()
  if (!/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/.test(name)) {
    throw new EkkoConfigError(
      'must use lowercase letters, numbers, hyphens, or underscores (maximum 64 characters)',
      'Skill name',
    )
  }
  return name
}

function normalizeMcpServerName(value: string): string {
  const name = String(value || '').trim()
  if (!MCP_SERVER_NAME_PATTERN.test(name)) {
    throw new EkkoConfigError(
      'must contain letters, numbers, dots, underscores, or dashes (maximum 64 characters)',
      'MCP server name',
    )
  }
  return name
}

function record(value: unknown, path: string, optional = false): JsonRecord {
  if (value === undefined && optional) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EkkoConfigError('must be an object', path)
  }
  return value as JsonRecord
}

function booleanValue(value: unknown, fallback: boolean, path: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new EkkoConfigError('must be a boolean', path)
  return value
}

function integer(value: unknown, fallback: number, path: string, minimum: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new EkkoConfigError(`must be an integer greater than or equal to ${minimum}`, path)
  }
  return parsed
}

function finiteNumber(value: unknown, path: string, minimum: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new EkkoConfigError(`must be a number greater than or equal to ${minimum}`, path)
  }
  return parsed
}

function boundedNumber(
  value: unknown,
  fallback: number,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new EkkoConfigError(`must be a number between ${minimum} and ${maximum}`, path)
  }
  return parsed
}

function boundedInteger(
  value: unknown,
  fallback: number,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new EkkoConfigError(`must be an integer between ${minimum} and ${maximum}`, path)
  }
  return parsed
}

function stringValue(value: unknown, fallback: string, path: string): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string') throw new EkkoConfigError('must be a string', path)
  return value.trim()
}

function requiredString(value: unknown, path: string): string {
  const normalized = stringValue(value, '', path)
  if (!normalized) throw new EkkoConfigError('must not be empty', path)
  return normalized
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, path)
}

function isoDateString(value: unknown, path: string): string {
  const normalized = requiredString(value, path)
  const timestamp = Date.parse(normalized)
  if (!Number.isFinite(timestamp)) throw new EkkoConfigError('must be an ISO date string', path)
  return new Date(timestamp).toISOString()
}

function stringArray(value: unknown, fallback: readonly string[], path: string): string[] {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new EkkoConfigError('must be an array of strings', path)
  }
  return [...new Set(value.map(item => item.trim()).filter(Boolean))]
}

function externalDirectoryArray(value: unknown, path: string): string[] {
  const directories = stringArray(value, [], path)
  for (const directory of directories) {
    if (directory.length > 2_048) throw new EkkoConfigError('path is too long', path)
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(directory)) throw new EkkoConfigError('path contains control characters', path)
  }
  return directories
}

function stringRecord(value: unknown, path: string): Record<string, string> {
  const source = record(value, path)
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(source)) {
    if (typeof item !== 'string') throw new EkkoConfigError('must be a string', `${path}.${key}`)
    result[key] = item
  }
  return result
}

function providerHeaders(value: unknown, path: string): Record<string, string> {
  const headers = stringRecord(value, path)
  for (const key of Object.keys(headers)) {
    if (CREDENTIAL_HEADER_NAMES.has(key.trim().toLowerCase())) {
      throw new EkkoConfigError('credential headers must be supplied at runtime', `${path}.${key}`)
    }
  }
  return headers
}

function codeExecLanguages(value: unknown): Array<typeof DEFAULT_CODE_EXEC_LANGUAGES[number]> {
  if (value === undefined) return [...DEFAULT_CODE_EXEC_LANGUAGES]
  if (!Array.isArray(value)) throw new EkkoConfigError('must be an array', 'tools.codeExec.languages')
  const languages = [...new Set(value.map(item => String(item).trim()))]
  for (const language of languages) {
    if (!DEFAULT_CODE_EXEC_LANGUAGES.includes(language as typeof DEFAULT_CODE_EXEC_LANGUAGES[number])) {
      throw new EkkoConfigError('supports only node and python', 'tools.codeExec.languages')
    }
  }
  return languages as Array<typeof DEFAULT_CODE_EXEC_LANGUAGES[number]>
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T | undefined,
  path: string,
): T {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new EkkoConfigError(`must be one of: ${allowed.join(', ')}`, path)
  }
  return value as T
}
