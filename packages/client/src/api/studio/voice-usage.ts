// 语音用量统计：GET /api/studio/voice/usage?days=30
import { getActiveProfileName, getApiKey } from '../client'

export interface VoiceUsageRow {
  source: 'tts' | 'stt'
  provider: string
  calls: number
  input_total: number
  output_total: number
  first_at?: number
  last_at?: number
}

export interface VoiceUsageDailyRow {
  day: string
  source: 'tts' | 'stt'
  calls: number
  input_total: number
  output_total: number
}

export interface VoiceUsagePeriod {
  days: number
  start_at: number
  end_at: number
}

export interface VoiceUsageResponse {
  range: VoiceUsageRow[]
  today: VoiceUsageRow[]
  total: VoiceUsageRow[]
  daily: VoiceUsageDailyRow[]
  period: VoiceUsagePeriod
  generated_at: number
}

export async function fetchVoiceUsage(days = 30): Promise<VoiceUsageResponse> {
  const baseUrl = (typeof window !== 'undefined' && window.localStorage.getItem('hermes_server_url')) || ''
  const profile = getActiveProfileName()
  const apiKey = getApiKey()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const d = Math.max(1, Math.min(365, days || 30))
  const res = await fetch(`${baseUrl}/api/studio/voice/usage?profile=${encodeURIComponent(profile || 'default')}&days=${d}`, { headers })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`voice usage API ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json() as Promise<VoiceUsageResponse>
}
