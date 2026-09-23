import { request } from '../client'
import type { Questions, SystemOneRequest, SystemOneResult } from '@typesafe-ai/sdk'
export { choice, score, noul } from '@typesafe-ai/sdk'
export type { Questions, SystemOneRequest, SystemOneResult } from '@typesafe-ai/sdk'

export interface JevSettings {
  ekkoMemoryEnabled: boolean
  ekkoMemoryKindRoutingEnabled: boolean
  ekkoMemoryRerankEnabled: boolean
  ekkoMemoryWriteReviewEnabled: boolean
  ekkoMemoryCandidateLimit: number
  ekkoMemoryRecallMinConfidence: number
  ekkoMemoryMinConfidence: number
  ekkoMemoryTimeoutMs: number
  baseUrl: string
  model: string
  timeoutMs: number
  hasApiKey: boolean
}
export type JevSettingsUpdate = Omit<JevSettings, 'hasApiKey'> & { apiKey?: string }

function profileHeaders(profile: string): Record<string, string> {
  if (!profile.trim()) throw new Error('Profile is required')
  return { 'X-Hermes-Profile': profile }
}

export function getJevSettings(profile: string) {
  return request<JevSettings>('/api/studio/jev/settings', { headers: profileHeaders(profile) })
}
export function saveJevSettings(profile: string, settings: JevSettingsUpdate) {
  return request<JevSettings>('/api/studio/jev/settings', { method: 'PUT', headers: profileHeaders(profile), body: JSON.stringify(settings) })
}
export function deleteJevSettings(profile: string) {
  return request<JevSettings>('/api/studio/jev/settings', { method: 'DELETE', headers: profileHeaders(profile) })
}
export function testJevConnection(profile: string) {
  return request<SystemOneResult<Questions> & { durationMs: number }>('/api/studio/jev/test', { method: 'POST', headers: profileHeaders(profile) })
}
export function evaluateJev<Q extends Questions>(profile: string, input: SystemOneRequest<Q>, signal?: AbortSignal) {
  return request<SystemOneResult<Q>>('/api/studio/jev/evaluate', { method: 'POST', headers: profileHeaders(profile), body: JSON.stringify(input), signal })
}
