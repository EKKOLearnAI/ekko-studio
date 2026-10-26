export interface ApiRelaySource {
  profile: string
  provider: string
  label: string
}

export interface ApiRelayPeriodUsage {
  requests?: number
  total_tokens?: number
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_creation_tokens?: number
  cost?: number
  actual_cost?: number
}

export interface ApiRelayUsage {
  isValid: boolean
  remaining: number | null
  unit: string
  planName?: string
  today?: ApiRelayPeriodUsage
  total?: ApiRelayPeriodUsage
  rpm?: number
  tpm?: number
  modelStats: Array<ApiRelayPeriodUsage & { model: string }>
}

export interface ApiRelayAccount {
  id: string
  endpoint: string
  sources: ApiRelaySource[]
  status: 'ready' | 'error'
  usage?: ApiRelayUsage
  error?: 'unauthorized' | 'timeout' | 'unavailable' | 'invalid_response'
}

export interface ApiRelayUsageResult {
  configured: boolean
  checkedAt: string
  accounts: ApiRelayAccount[]
}
