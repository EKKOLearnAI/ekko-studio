import { request } from '../client'
import type { Questions, SystemOneRequest, SystemOneResult } from '@typesafe-ai/sdk'
export { choice, score, noul } from '@typesafe-ai/sdk'
export type { Questions, SystemOneRequest, SystemOneResult } from '@typesafe-ai/sdk'

export interface JevSettings {
  groupSummaryReviewEnabled: boolean
  groupSummaryReviewMinConfidence: number
  groupSummaryRevisionEnabled: boolean
  groupSummaryReviewTimeoutMs: number
  workflowQualityEnabled: boolean
  workflowQualityMinConfidence: number
  workflowQualityTimeoutMs: number
  groupMessageRoutingEnabled: boolean
  groupHandoffReviewEnabled: boolean
  groupLoopDetectionEnabled: boolean
  groupMessageRoutingMinConfidence: number
  groupMessageRoutingMode: 'suggest' | 'auto'
  groupMessageRoutingTimeoutMs: number
  browserMatchEnabled: boolean
  browserMatchCandidateLimit: number
  browserMatchMinConfidence: number
  browserMatchTimeoutMs: number
  browserVerifyEnabled: boolean
  browserVerifyMinConfidence: number
  browserVerifyTimeoutMs: number

  ekkoComputerUseMatchEnabled: boolean
  ekkoComputerUseMatchCandidateLimit: number
  ekkoComputerUseMatchMinConfidence: number
  ekkoComputerUseMatchTimeoutMs: number
  ekkoComputerUseVerifyEnabled: boolean
  ekkoComputerUseVerifyMinConfidence: number
  ekkoComputerUseVerifyTimeoutMs: number
  ekkoSkillsEnabled: boolean
  ekkoSkillsCandidateLimit: number
  ekkoSkillsMinConfidence: number
  ekkoSkillsTimeoutMs: number
  personMemoryEnabled: boolean
  personMemoryKindRoutingEnabled: boolean
  personMemoryRelevanceFilterEnabled: boolean
  personMemoryRerankEnabled: boolean
  personMemoryWriteReviewEnabled: boolean
  personMemoryCandidateLimit: number
  personMemoryRecallMinConfidence: number
  personMemoryFilterMinConfidence: number
  personMemoryMinConfidence: number
  personMemoryTimeoutMs: number
  ekkoMemoryEnabled: boolean
  ekkoMemoryKindRoutingEnabled: boolean
  ekkoMemoryRelevanceFilterEnabled: boolean
  ekkoMemoryRerankEnabled: boolean
  ekkoMemoryWriteReviewEnabled: boolean
  ekkoMemoryCandidateLimit: number
  ekkoMemoryRecallMinConfidence: number
  ekkoMemoryFilterMinConfidence: number
  ekkoMemoryMinConfidence: number
  ekkoMemoryTimeoutMs: number
  baseUrl: string
  model: string
  timeoutMs: number
  hasApiKey: boolean
}
export type JevSettingsUpdate = Omit<JevSettings, 'hasApiKey'> & { apiKey?: string }

export function getJevSettings() {
  return request<JevSettings>('/api/studio/jev/settings')
}
export function saveJevSettings(settings: JevSettingsUpdate) {
  return request<JevSettings>('/api/studio/jev/settings', { method: 'PUT', body: JSON.stringify(settings) })
}
export function deleteJevSettings() {
  return request<JevSettings>('/api/studio/jev/settings', { method: 'DELETE' })
}
export function testJevConnection() {
  return request<SystemOneResult<Questions> & { durationMs: number }>('/api/studio/jev/test', { method: 'POST' })
}
export function evaluateJev<Q extends Questions>(input: SystemOneRequest<Q>, signal?: AbortSignal) {
  return request<SystemOneResult<Q>>('/api/studio/jev/evaluate', { method: 'POST', body: JSON.stringify(input), signal })
}
