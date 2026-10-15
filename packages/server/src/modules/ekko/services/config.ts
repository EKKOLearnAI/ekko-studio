import {
  type EkkoAgentSetup,
  type EkkoConfig,
  type EkkoModelConfig,
} from '../../../../../ekko-agent/src'
import { setupGlobalEkkoAgent } from './manager'

type JsonRecord = Record<string, unknown>

export interface EkkoSettingsProvider {
  id: string
  label: string
  defaultModel: string
  models: string[]
  authorizationConfigured: boolean
}

export interface EkkoSettingsConfig {
  runtime: EkkoConfig['runtime']
  model: Pick<
    EkkoModelConfig,
    | 'defaultProvider'
    | 'defaultModel'
    | 'requestTimeoutMs'
    | 'reasoningEffort'
    | 'reasoningSummary'
    | 'authorizationRefreshLeewayMs'
  > & {
    temperature: number | null
    maxTokens: number | null
  }
  tools: EkkoConfig['tools']
  mcp: Pick<EkkoConfig['mcp'], 'enabled'>
  delegation: EkkoConfig['delegation']
  compression: EkkoConfig['compression']
  memory: EkkoConfig['memory']
  skills: Pick<EkkoConfig['skills'], 'enabled' | 'reviewEveryToolCalls'>
  logging: EkkoConfig['logging']
  prompt: EkkoConfig['prompt']
}

export interface EkkoSettingsSnapshot {
  schemaVersion: number
  configPath: string
  config: EkkoSettingsConfig
  providers: EkkoSettingsProvider[]
}

const RUNTIME_KEYS = [
  'maxSteps',
  'maxModelRetries',
  'toolFailureRecoveryThreshold',
  'maxConsecutiveToolFailures',
  'maxIdenticalToolFailures',
] as const
const MODEL_KEYS = [
  'defaultProvider',
  'defaultModel',
  'requestTimeoutMs',
  'reasoningEffort',
  'reasoningSummary',
  'authorizationRefreshLeewayMs',
] as const
const TOOL_KEYS = ['enabled', 'executionTimeoutMs'] as const
const APPROVAL_KEYS = ['enabled', 'timeoutMs', 'permanentAllow'] as const
const CODE_EXEC_KEYS = [
  'enabled',
  'languages',
  'timeoutMs',
  'maxToolCalls',
  'maxOutputBytes',
  'maxStderrBytes',
  'maxSourceBytes',
] as const
const DELEGATION_KEYS = ['backgroundEnabled', 'subtaskMaxSteps'] as const
const COMPRESSION_KEYS = [
  'enabled',
  'threshold',
  'targetRatio',
  'protectLastN',
  'protectFirstN',
] as const
const MEMORY_KEYS = [
  'enabled',
  'recentMessageLimit',
  'automaticRecallTokenBudget',
  'searchResultLimit',
] as const

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {}
}

function assignKnown(
  target: object,
  source: JsonRecord,
  keys: readonly string[],
): void {
  const mutable = target as JsonRecord
  for (const key of keys) {
    if (Object.hasOwn(source, key)) mutable[key] = source[key]
  }
}

function editableConfig(config: EkkoConfig): EkkoSettingsConfig {
  return {
    runtime: structuredClone(config.runtime),
    model: {
      defaultProvider: config.model.defaultProvider,
      defaultModel: config.model.defaultModel,
      requestTimeoutMs: config.model.requestTimeoutMs,
      temperature: config.model.temperature ?? null,
      maxTokens: config.model.maxTokens ?? null,
      reasoningEffort: config.model.reasoningEffort,
      reasoningSummary: config.model.reasoningSummary,
      authorizationRefreshLeewayMs: config.model.authorizationRefreshLeewayMs,
    },
    tools: structuredClone(config.tools),
    mcp: { enabled: config.mcp.enabled },
    delegation: structuredClone(config.delegation),
    compression: structuredClone(config.compression),
    memory: structuredClone(config.memory),
    skills: {
      enabled: config.skills.enabled,
      reviewEveryToolCalls: config.skills.reviewEveryToolCalls,
    },
    logging: structuredClone(config.logging),
    prompt: structuredClone(config.prompt),
  }
}

export function getEkkoSettings(
  setup: EkkoAgentSetup = setupGlobalEkkoAgent(),
): EkkoSettingsSnapshot {
  const config = setup.config.read()
  const providers = Object.entries(config.model.providers)
    .map(([id, settings]) => ({
      id,
      label: settings.label || id,
      defaultModel: settings.defaultModel,
      models: [...new Set([settings.defaultModel, ...(settings.models ?? [])].filter(Boolean))],
      authorizationConfigured: Boolean(config.model.authorizations[id]),
    }))
    .sort((left, right) => left.label.localeCompare(right.label))
  return {
    schemaVersion: config.schemaVersion,
    configPath: setup.layout.configPath,
    config: editableConfig(config),
    providers,
  }
}

/**
 * Update every user-facing runtime setting while preserving internal schema,
 * provider credentials, and Profile-scoped MCP/Skill collections.
 */
export function updateEkkoSettings(
  input: unknown,
  setup: EkkoAgentSetup = setupGlobalEkkoAgent(),
): EkkoSettingsSnapshot {
  const source = record(input)
  const next = structuredClone(setup.config.read())

  assignKnown(next.runtime, record(source.runtime), RUNTIME_KEYS)

  const model = record(source.model)
  assignKnown(next.model, model, MODEL_KEYS)
  for (const key of ['temperature', 'maxTokens'] as const) {
    if (!Object.hasOwn(model, key)) continue
    if (model[key] === null || model[key] === undefined) delete next.model[key]
    else next.model[key] = model[key] as never
  }

  const tools = record(source.tools)
  assignKnown(next.tools, tools, TOOL_KEYS)
  assignKnown(next.tools.approvals, record(tools.approvals), APPROVAL_KEYS)
  assignKnown(next.tools.codeExec, record(tools.codeExec), CODE_EXEC_KEYS)

  assignKnown(next.mcp, record(source.mcp), ['enabled'])
  assignKnown(next.delegation, record(source.delegation), DELEGATION_KEYS)
  assignKnown(next.compression, record(source.compression), COMPRESSION_KEYS)
  assignKnown(next.memory, record(source.memory), MEMORY_KEYS)
  assignKnown(next.skills, record(source.skills), ['enabled', 'reviewEveryToolCalls'])
  assignKnown(next.logging, record(source.logging), ['maxBytes'])
  assignKnown(next.prompt, record(source.prompt), ['instructions'])

  setup.config.replace(next)
  return getEkkoSettings(setup)
}
