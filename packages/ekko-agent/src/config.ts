import type {
  ModelCapabilities,
  ModelProviderType,
  ModelReasoningEffort,
  ModelReasoningSummary,
  ModelRequestStyle,
  OpenAIChatReasoningReplayFormat,
} from './model/types'
import { DEFAULT_EKKO_JEV_CONFIG, type EkkoJevConfig } from './jev/config'
import {
  BUILTIN_MODEL_PROVIDER_PRESETS,
  type EkkoModelApiMode,
  type EkkoModelProviderAuthType,
  type EkkoModelProviderPreset,
} from './model/provider-presets'

export const EKKO_CONFIG_SCHEMA_VERSION = 11
export const EKKO_CONFIG_DIRECTORY_NAME = 'config'
export const EKKO_CONFIG_FILE_NAME = 'config.json'

export const DEFAULT_AGENT_MAX_STEPS = 90
export const DEFAULT_AGENT_MODEL_MAX_RETRIES = 3
export const DEFAULT_AGENT_TOOL_FAILURE_RECOVERY_THRESHOLD = 3
/** @deprecated Tool failures now trigger model recovery instead of terminating the run. */
export const DEFAULT_AGENT_MAX_CONSECUTIVE_TOOL_FAILURES = 6
export const DEFAULT_AGENT_SUBTASK_MAX_STEPS = 30
export const DEFAULT_MODEL_REQUEST_TIMEOUT_MS = 5 * 60 * 1_000
export const DEFAULT_MODEL_AUTHORIZATION_REFRESH_LEEWAY_MS = 5 * 60 * 1_000
export const DEFAULT_TOOL_EXECUTION_TIMEOUT_MS = 120_000
export const DEFAULT_TOOL_APPROVAL_TIMEOUT_MS = 5 * 60 * 1_000
export const DEFAULT_CLARIFICATION_TIMEOUT_MS = 5 * 60 * 1_000
export const DEFAULT_CODE_EXEC_LANGUAGES = ['node', 'python'] as const
export const DEFAULT_CODE_EXEC_MAX_TOOL_CALLS = 50
export const DEFAULT_CODE_EXEC_MAX_OUTPUT_BYTES = 50_000
export const DEFAULT_CODE_EXEC_MAX_STDERR_BYTES = 10_000
export const DEFAULT_CODE_EXEC_MAX_SOURCE_BYTES = 200_000
export const DEFAULT_AUTOMATIC_MEMORY_TOKEN_BUDGET = 4_000
export const DEFAULT_MEMORY_RECENT_MESSAGE_LIMIT = 20
export const DEFAULT_MEMORY_SEARCH_RESULT_LIMIT = 50
export const DEFAULT_SKILL_REVIEW_TOOL_CALL_INTERVAL = 10
export const DEFAULT_EKKO_LOG_MAX_BYTES = 10 * 1024 * 1024
export const DEFAULT_COMPRESSION_THRESHOLD = 0.5
export const DEFAULT_COMPRESSION_TARGET_RATIO = 0.2
export const DEFAULT_COMPRESSION_PROTECT_LAST_N = 20
export const DEFAULT_COMPRESSION_PROTECT_FIRST_N = 3

export interface EkkoRuntimeConfig {
  maxSteps: number
  maxModelRetries: number
  toolFailureRecoveryThreshold: number
  /** @deprecated Retained for persisted-config compatibility; it no longer terminates runs. */
  maxConsecutiveToolFailures: number
}

/**
 * Persisted provider settings owned by the user's `.ekko` directory.
 */
export interface EkkoModelProviderSettings {
  label?: string
  type: ModelProviderType
  apiMode?: EkkoModelApiMode
  requestStyle?: ModelRequestStyle
  openAIChatReasoningReplayFormat?: OpenAIChatReasoningReplayFormat
  baseUrl?: string
  endpointPath?: string
  defaultModel: string
  models?: string[]
  authType?: EkkoModelProviderAuthType
  source?: 'builtin' | 'custom'
  apiKey?: string
  headers?: Record<string, string>
  timeoutMs?: number
  capabilities?: Partial<ModelCapabilities>
}

/** OAuth state owned by Ekko and persisted in the user-only config file. */
export interface EkkoModelAuthorizationSettings {
  type: 'oauth'
  accessToken?: string
  refreshToken?: string
  expiresAt?: string
  obtainedAt?: string
  tokenUrl?: string
  clientId?: string
  clientSecret?: string
  scope?: string
  tokenParams?: Record<string, string>
  baseUrl?: string
  apiMode?: EkkoModelApiMode
}

export interface EkkoModelConfig {
  defaultProvider: string
  defaultModel: string
  requestTimeoutMs: number
  temperature?: number
  maxTokens?: number
  reasoningEffort: ModelReasoningEffort
  reasoningSummary: ModelReasoningSummary
  authorizationRefreshLeewayMs: number
  providerCatalog: Record<string, EkkoModelProviderPreset>
  disabledProviderPresets: string[]
  providers: Record<string, EkkoModelProviderSettings>
  authorizations: Record<string, EkkoModelAuthorizationSettings>
}

export interface EkkoToolApprovalConfig {
  enabled: boolean
  timeoutMs: number
  permanentAllow: string[]
}

export interface EkkoCodeExecConfig {
  enabled: boolean
  languages: Array<typeof DEFAULT_CODE_EXEC_LANGUAGES[number]>
  timeoutMs: number
  maxToolCalls: number
  maxOutputBytes: number
  maxStderrBytes: number
  maxSourceBytes: number
}

export interface EkkoToolsConfig {
  enabled: boolean
  executionTimeoutMs: number
  approvals: EkkoToolApprovalConfig
  codeExec: EkkoCodeExecConfig
}

export interface EkkoMcpServerConfig {
  type?: 'stdio' | 'streamable_http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  enabled: boolean
}

export interface EkkoMcpProfileConfig {
  servers: Record<string, EkkoMcpServerConfig>
}

/** Profile-scoped MCP servers persisted in Ekko's canonical config file. */
export interface EkkoMcpConfig {
  enabled: boolean
  profiles: Record<string, EkkoMcpProfileConfig>
}

export interface EkkoDelegationConfig {
  backgroundEnabled: boolean
  subtaskMaxSteps: number
}

/**
 * Host-owned conversation compression policy. Ekko exposes the policy through
 * its global config; a host with durable conversation history applies it
 * before starting a runtime turn.
 */
export interface EkkoCompressionConfig {
  enabled: boolean
  threshold: number
  targetRatio: number
  protectLastN: number
  protectFirstN: number
}

export interface EkkoMemoryConfig {
  enabled: boolean
  recentMessageLimit: number
  automaticRecallTokenBudget: number
  searchResultLimit: number
}

export interface EkkoSkillsProfileConfig {
  /** Skill names excluded from runtime discovery for this Profile. */
  disabled: string[]
  /** External Skill roots referenced without copying them into Ekko storage. */
  externalDirectories: string[]
}

export interface EkkoSkillsConfig {
  enabled: boolean
  reviewEveryToolCalls: number
  profiles: Record<string, EkkoSkillsProfileConfig>
}

export interface EkkoLoggingConfig {
  maxBytes: number
}

export interface EkkoPromptConfig {
  instructions: string[]
}

export interface EkkoConfig {
  schemaVersion: number
  runtime: EkkoRuntimeConfig
  model: EkkoModelConfig
  tools: EkkoToolsConfig
  mcp: EkkoMcpConfig
  delegation: EkkoDelegationConfig
  compression: EkkoCompressionConfig
  memory: EkkoMemoryConfig
  jev: EkkoJevConfig
  skills: EkkoSkillsConfig
  logging: EkkoLoggingConfig
  prompt: EkkoPromptConfig
}

export type EkkoConfigPatch = {
  schemaVersion?: number
  runtime?: Partial<EkkoRuntimeConfig>
  model?: Partial<Omit<EkkoModelConfig, 'providerCatalog' | 'disabledProviderPresets' | 'providers' | 'authorizations'>> & {
    providerCatalog?: Record<string, EkkoModelProviderPreset>
    disabledProviderPresets?: string[]
    providers?: Record<string, EkkoModelProviderSettings>
    authorizations?: Record<string, EkkoModelAuthorizationSettings>
  }
  tools?: Partial<Omit<EkkoToolsConfig, 'approvals' | 'codeExec'>> & {
    approvals?: Partial<EkkoToolApprovalConfig>
    codeExec?: Partial<EkkoCodeExecConfig>
  }
  mcp?: Partial<Omit<EkkoMcpConfig, 'profiles'>> & {
    profiles?: Record<string, EkkoMcpProfileConfig>
  }
  delegation?: Partial<EkkoDelegationConfig>
  compression?: Partial<EkkoCompressionConfig>
  memory?: Partial<EkkoMemoryConfig>
  jev?: Partial<EkkoJevConfig>
  skills?: Partial<Omit<EkkoSkillsConfig, 'profiles'>> & {
    profiles?: Record<string, Partial<EkkoSkillsProfileConfig>>
  }
  logging?: Partial<EkkoLoggingConfig>
  prompt?: Partial<EkkoPromptConfig>
}

/**
 * Initial global configuration. Existing files are reconciled recursively, so
 * newly introduced leaves are added without replacing user-owned siblings.
 */
export const DEFAULT_EKKO_CONFIG: EkkoConfig = {
  schemaVersion: EKKO_CONFIG_SCHEMA_VERSION,
  runtime: {
    maxSteps: DEFAULT_AGENT_MAX_STEPS,
    maxModelRetries: DEFAULT_AGENT_MODEL_MAX_RETRIES,
    toolFailureRecoveryThreshold: DEFAULT_AGENT_TOOL_FAILURE_RECOVERY_THRESHOLD,
    maxConsecutiveToolFailures: DEFAULT_AGENT_MAX_CONSECUTIVE_TOOL_FAILURES,
  },
  model: {
    defaultProvider: '',
    defaultModel: '',
    requestTimeoutMs: DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
    reasoningEffort: 'medium',
    reasoningSummary: 'auto',
    authorizationRefreshLeewayMs: DEFAULT_MODEL_AUTHORIZATION_REFRESH_LEEWAY_MS,
    providerCatalog: structuredClone(BUILTIN_MODEL_PROVIDER_PRESETS),
    disabledProviderPresets: [],
    providers: {},
    authorizations: {},
  },
  tools: {
    enabled: true,
    executionTimeoutMs: DEFAULT_TOOL_EXECUTION_TIMEOUT_MS,
    approvals: {
      enabled: true,
      timeoutMs: DEFAULT_TOOL_APPROVAL_TIMEOUT_MS,
      permanentAllow: [],
    },
    codeExec: {
      enabled: true,
      languages: [...DEFAULT_CODE_EXEC_LANGUAGES],
      timeoutMs: DEFAULT_TOOL_EXECUTION_TIMEOUT_MS,
      maxToolCalls: DEFAULT_CODE_EXEC_MAX_TOOL_CALLS,
      maxOutputBytes: DEFAULT_CODE_EXEC_MAX_OUTPUT_BYTES,
      maxStderrBytes: DEFAULT_CODE_EXEC_MAX_STDERR_BYTES,
      maxSourceBytes: DEFAULT_CODE_EXEC_MAX_SOURCE_BYTES,
    },
  },
  mcp: {
    enabled: true,
    profiles: {},
  },
  delegation: {
    backgroundEnabled: true,
    subtaskMaxSteps: DEFAULT_AGENT_SUBTASK_MAX_STEPS,
  },
  compression: {
    enabled: true,
    threshold: DEFAULT_COMPRESSION_THRESHOLD,
    targetRatio: DEFAULT_COMPRESSION_TARGET_RATIO,
    protectLastN: DEFAULT_COMPRESSION_PROTECT_LAST_N,
    protectFirstN: DEFAULT_COMPRESSION_PROTECT_FIRST_N,
  },
  memory: {
    enabled: true,
    recentMessageLimit: DEFAULT_MEMORY_RECENT_MESSAGE_LIMIT,
    automaticRecallTokenBudget: DEFAULT_AUTOMATIC_MEMORY_TOKEN_BUDGET,
    searchResultLimit: DEFAULT_MEMORY_SEARCH_RESULT_LIMIT,
  },
  skills: {
    enabled: true,
    reviewEveryToolCalls: DEFAULT_SKILL_REVIEW_TOOL_CALL_INTERVAL,
    profiles: {},
  },
  jev: { ...DEFAULT_EKKO_JEV_CONFIG },
  logging: {
    maxBytes: DEFAULT_EKKO_LOG_MAX_BYTES,
  },
  prompt: {
    instructions: [],
  },
}

export function serializeDefaultEkkoConfig(): string {
  return `${JSON.stringify(DEFAULT_EKKO_CONFIG, null, 2)}\n`
}
