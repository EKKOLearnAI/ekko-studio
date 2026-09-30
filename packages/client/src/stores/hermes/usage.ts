import { fetchUsageStats, type UsageStatsResponse } from '@/api/studio/sessions'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

interface DailyUsage {
  cost_coverage?: import('@/utils/usage-cost').UsageCostCoverage
  date: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  sessions: number
  errors: number
  cost: number
  visualTokens: number
  inputPercent: number
  outputPercent: number
  cachePercent: number
}

interface ModelUsage {
  model: string
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  cacheWriteTokens: number
  totalTokens: number
  visualTokens: number
  sessions: number
  color: string
  inputPercent: number
  outputPercent: number
  cachePercent: number
}

interface AgentUsage {
  agent: string
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  cacheWriteTokens: number
  totalTokens: number
  visualTokens: number
  sessions: number
  color: string
  inputPercent: number
  outputPercent: number
  cachePercent: number
}

const MODEL_COLORS = [
  '#4fd1c5',
  '#63b3ed',
  '#f6ad55',
  '#b794f4',
  '#68d391',
  '#fc8181',
  '#f687b3',
  '#90cdf4',
  '#fbd38d',
  '#9ae6b4',
]

function normalizeModel(model: string | null | undefined): string {
  const trimmed = (model || '').trim()
  return trimmed || 'unknown'
}

function percent(part: number, total: number): number {
  if (total <= 0) return 0
  return part / total * 100
}

function getModelColor(model: string): string {
  const normalized = normalizeModel(model)
  let hash = 0
  for (let i = 0; i < normalized.length; i += 1) {
    hash = ((hash << 5) - hash) + normalized.charCodeAt(i)
    hash |= 0
  }
  return MODEL_COLORS[Math.abs(hash) % MODEL_COLORS.length]
}

export const useUsageStore = defineStore('usage', () => {
  const stats = ref<UsageStatsResponse | null>(null)
  const isLoading = ref(false)
  let latestRequestId = 0

  async function loadSessions(days = 30) {
    const requestId = ++latestRequestId
    isLoading.value = true
    try {
      const response = await fetchUsageStats(days)
      if (requestId === latestRequestId) {
        stats.value = response
      }
    } catch (err) {
      if (requestId === latestRequestId) {
        console.error('Failed to load usage stats:', err)
      }
    } finally {
      if (requestId === latestRequestId) {
        isLoading.value = false
      }
    }
  }

  const hasData = computed(() => !!stats.value && stats.value.total_sessions > 0)

  const totalInputTokens = computed(() => stats.value?.total_input_tokens ?? 0)
  const totalOutputTokens = computed(() => stats.value?.total_output_tokens ?? 0)
  const totalTokens = computed(() => totalInputTokens.value + totalOutputTokens.value)
  const totalSessions = computed(() => stats.value?.total_sessions ?? 0)

  const totalCacheTokens = computed(() => stats.value?.total_cache_read_tokens ?? 0)

  const cacheHitRate = computed(() => {
    const total = totalInputTokens.value + totalCacheTokens.value
    if (total === 0) return null
    return ((totalCacheTokens.value / total) * 100)
  })

  const estimatedCost = computed(() => stats.value?.total_cost ?? 0)

  const modelUsage = computed<ModelUsage[]>(() => {
    if (!stats.value) return []
    return stats.value.model_usage.map(m => {
      const model = normalizeModel(m.model)
      const totalTokens = m.input_tokens + m.output_tokens
      const visualTokens = totalTokens + m.cache_read_tokens
      return {
        model,
        inputTokens: m.input_tokens,
        outputTokens: m.output_tokens,
        cacheTokens: m.cache_read_tokens,
        cacheWriteTokens: m.cache_write_tokens,
        totalTokens,
        visualTokens,
        sessions: m.sessions,
        color: getModelColor(model),
        inputPercent: percent(m.input_tokens, visualTokens),
        outputPercent: percent(m.output_tokens, visualTokens),
        cachePercent: percent(m.cache_read_tokens, visualTokens),
      }
    }).sort((a, b) => b.visualTokens - a.visualTokens)
  })

  const modelLegend = computed(() => {
    const seen = new Set<string>()
    return modelUsage.value.filter(m => {
      if (seen.has(m.model)) return false
      seen.add(m.model)
      return true
    }).map(m => ({ model: m.model, color: m.color }))
  })

  const agentUsage = computed<AgentUsage[]>(() => {
    if (!stats.value) return []
    return (stats.value.agent_usage ?? []).map(a => {
      const agent = (a.agent || '').trim() || 'unknown'
      const totalTokens = a.input_tokens + a.output_tokens
      const visualTokens = totalTokens + a.cache_read_tokens
      return {
        agent,
        inputTokens: a.input_tokens,
        outputTokens: a.output_tokens,
        cacheTokens: a.cache_read_tokens,
        cacheWriteTokens: a.cache_write_tokens,
        totalTokens,
        visualTokens,
        sessions: a.sessions,
        color: getModelColor(`agent:${agent}`),
        inputPercent: percent(a.input_tokens, visualTokens),
        outputPercent: percent(a.output_tokens, visualTokens),
        cachePercent: percent(a.cache_read_tokens, visualTokens),
      }
    }).sort((a, b) => b.visualTokens - a.visualTokens)
  })

  const dailyUsage = computed<DailyUsage[]>(() => (stats.value?.daily_usage ?? []).map(d => {
    const visualTokens = d.input_tokens + d.output_tokens + d.cache_read_tokens
    return {
      ...d,
      visualTokens,
      inputPercent: percent(d.input_tokens, visualTokens),
      outputPercent: percent(d.output_tokens, visualTokens),
      cachePercent: percent(d.cache_read_tokens, visualTokens),
    }
  }))

  const avgSessionsPerDay = computed(() => {
    if (!stats.value || stats.value.daily_usage.length === 0) return 0
    const daysWithActivity = stats.value.daily_usage.filter(d => d.sessions > 0).length
    const days = Math.max(1, daysWithActivity)
    return totalSessions.value / days
  })

  return {
    stats,
    isLoading,
    hasData,
    loadSessions,
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    totalSessions,
    totalCacheTokens,
    cacheHitRate,
    estimatedCost,
    modelUsage,
    modelLegend,
    agentUsage,
    dailyUsage,
    avgSessionsPerDay,
    getModelColor,
  }
})
