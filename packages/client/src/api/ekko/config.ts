import { request } from '@/api/client'

export type EkkoReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type EkkoReasoningSummary = 'auto' | 'concise' | 'detailed'
export type EkkoCodeExecLanguage = 'node' | 'python'

export interface EkkoSettingsConfig {
  runtime: {
    maxSteps: number
    maxModelRetries: number
    toolFailureRecoveryThreshold: number
    /** @deprecated Retained for older Ekko config files. */
    maxConsecutiveToolFailures: number
  }
  model: {
    defaultProvider: string
    defaultModel: string
    requestTimeoutMs: number
    temperature: number | null
    maxTokens: number | null
    reasoningEffort: EkkoReasoningEffort
    reasoningSummary: EkkoReasoningSummary
    authorizationRefreshLeewayMs: number
  }
  tools: {
    enabled: boolean
    executionTimeoutMs: number
    computerUse: {
      enabled: boolean
      timeoutMs: number
    }
    approvals: {
      enabled: boolean
      timeoutMs: number
      permanentAllow: string[]
    }
    codeExec: {
      enabled: boolean
      languages: EkkoCodeExecLanguage[]
      timeoutMs: number
      maxToolCalls: number
      maxOutputBytes: number
      maxStderrBytes: number
      maxSourceBytes: number
    }
  }
  mcp: { enabled: boolean }
  delegation: {
    backgroundEnabled: boolean
    subtaskMaxSteps: number
  }
  compression: {
    enabled: boolean
    threshold: number
    targetRatio: number
    protectLastN: number
    protectFirstN: number
  }
  memory: {
    enabled: boolean
    recentMessageLimit: number
    automaticRecallTokenBudget: number
    searchResultLimit: number
  }
  skills: {
    enabled: boolean
    reviewEveryToolCalls: number
  }
  logging: { maxBytes: number }
  prompt: { instructions: string[] }
}

export interface EkkoSettingsProvider {
  id: string
  label: string
  defaultModel: string
  models: string[]
  authorizationConfigured: boolean
}

export interface EkkoSettingsSnapshot {
  schemaVersion: number
  configPath: string
  config: EkkoSettingsConfig
  providers: EkkoSettingsProvider[]
  runtimeRefresh?: { refreshed: number; deferred: number }
}

export async function fetchEkkoSettings(): Promise<EkkoSettingsSnapshot> {
  return request<EkkoSettingsSnapshot & { ok: boolean }>('/api/ekko/config')
}

export async function saveEkkoSettings(config: EkkoSettingsConfig): Promise<EkkoSettingsSnapshot> {
  return request<EkkoSettingsSnapshot & { ok: boolean }>('/api/ekko/config', {
    method: 'PUT',
    body: JSON.stringify({ config }),
  })
}
