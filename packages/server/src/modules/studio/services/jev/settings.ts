import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../../public/config'
import { safeFileStore } from '../../public/safe-file-store'

export interface JevSettings {
  ekkoSkillsEnabled: boolean
  ekkoSkillsCandidateLimit: number
  ekkoSkillsMinConfidence: number
  ekkoSkillsTimeoutMs: number
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

export interface JevCredentialSettings extends Omit<JevSettings, 'hasApiKey'> { apiKey: string }
type StoredSettings = JevCredentialSettings

export class JevError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = 'jev_invalid_request') { super(message) }
}

const defaults: StoredSettings = {
  ekkoSkillsEnabled: false,
  ekkoSkillsCandidateLimit: 20,
  ekkoSkillsMinConfidence: 0.8,
  ekkoSkillsTimeoutMs: 3000,
  ekkoMemoryEnabled: false,
  ekkoMemoryKindRoutingEnabled: true,
  ekkoMemoryRelevanceFilterEnabled: true,
  ekkoMemoryRerankEnabled: true,
  ekkoMemoryWriteReviewEnabled: true,
  ekkoMemoryCandidateLimit: 20,
  ekkoMemoryRecallMinConfidence: 0.5,
  ekkoMemoryFilterMinConfidence: 0.8,
  ekkoMemoryMinConfidence: 0.8,
  ekkoMemoryTimeoutMs: 3000,

  baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', timeoutMs: 10_000, apiKey: '',
}

function settingsPath(profile: string): string {
  if (typeof profile !== 'string' || !profile.trim() || profile.length > 128) {
    throw new JevError('Profile is required')
  }
  return join(config.appHome, 'models', 'jev', `${createHash('sha256').update(profile.trim()).digest('hex')}.json`)
}

function normalize(input: unknown, current = defaults): StoredSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new JevError('Invalid JEV settings')
  const value = input as Record<string, unknown>
  if (Object.keys(value).some(key => !['baseUrl', 'model', 'timeoutMs', 'apiKey', 'ekkoSkillsEnabled', 'ekkoSkillsCandidateLimit', 'ekkoSkillsMinConfidence', 'ekkoSkillsTimeoutMs', 'ekkoMemoryEnabled', 'ekkoMemoryKindRoutingEnabled', 'ekkoMemoryRelevanceFilterEnabled', 'ekkoMemoryRerankEnabled', 'ekkoMemoryWriteReviewEnabled', 'ekkoMemoryCandidateLimit', 'ekkoMemoryRecallMinConfidence', 'ekkoMemoryFilterMinConfidence', 'ekkoMemoryMinConfidence', 'ekkoMemoryTimeoutMs'].includes(key))) {
    throw new JevError('Unknown JEV setting')
  }
  const next = { ...current }
  if (value.ekkoMemoryEnabled !== undefined) {
    if (typeof value.ekkoMemoryEnabled !== 'boolean') throw new JevError('JEV ekkoMemoryEnabled must be a boolean')
    next.ekkoMemoryEnabled = value.ekkoMemoryEnabled
  }
  for (const key of ['ekkoSkillsEnabled', 'ekkoMemoryKindRoutingEnabled', 'ekkoMemoryRelevanceFilterEnabled', 'ekkoMemoryRerankEnabled', 'ekkoMemoryWriteReviewEnabled'] as const) {
    if (value[key] === undefined) continue
    if (typeof value[key] !== 'boolean') throw new JevError(`Invalid JEV ${key}`)
    next[key] = value[key]
  }
  if (value.ekkoSkillsCandidateLimit !== undefined) next.ekkoSkillsCandidateLimit = value.ekkoSkillsCandidateLimit as number
  if (value.ekkoSkillsMinConfidence !== undefined) next.ekkoSkillsMinConfidence = value.ekkoSkillsMinConfidence as number
  if (value.ekkoSkillsTimeoutMs !== undefined) next.ekkoSkillsTimeoutMs = value.ekkoSkillsTimeoutMs as number
  if (!Number.isInteger(next.ekkoSkillsCandidateLimit) || next.ekkoSkillsCandidateLimit < 1 || next.ekkoSkillsCandidateLimit > 50) throw new JevError('Invalid JEV skills candidate limit')
  if (!Number.isFinite(next.ekkoSkillsMinConfidence) || next.ekkoSkillsMinConfidence < 0.5 || next.ekkoSkillsMinConfidence > 1) throw new JevError('Invalid JEV skills confidence')
  if (!Number.isInteger(next.ekkoSkillsTimeoutMs) || next.ekkoSkillsTimeoutMs < 100 || next.ekkoSkillsTimeoutMs > 30000) throw new JevError('Invalid JEV skills timeout')
  if (value.ekkoMemoryCandidateLimit !== undefined) next.ekkoMemoryCandidateLimit = value.ekkoMemoryCandidateLimit as number
  if (value.ekkoMemoryRecallMinConfidence !== undefined) next.ekkoMemoryRecallMinConfidence = value.ekkoMemoryRecallMinConfidence as number
  if (value.ekkoMemoryFilterMinConfidence !== undefined) next.ekkoMemoryFilterMinConfidence = value.ekkoMemoryFilterMinConfidence as number
  if (value.ekkoMemoryMinConfidence !== undefined) next.ekkoMemoryMinConfidence = value.ekkoMemoryMinConfidence as number
  if (value.ekkoMemoryTimeoutMs !== undefined) next.ekkoMemoryTimeoutMs = value.ekkoMemoryTimeoutMs as number
  if (!Number.isInteger(next.ekkoMemoryCandidateLimit) || next.ekkoMemoryCandidateLimit < 1 || next.ekkoMemoryCandidateLimit > 50) throw new JevError('Invalid JEV memory candidate limit')
  if (!Number.isFinite(next.ekkoMemoryRecallMinConfidence) || next.ekkoMemoryRecallMinConfidence < 0.5 || next.ekkoMemoryRecallMinConfidence > 1) throw new JevError('Invalid JEV memory recall confidence')
  if (!Number.isFinite(next.ekkoMemoryFilterMinConfidence) || next.ekkoMemoryFilterMinConfidence < 0.5 || next.ekkoMemoryFilterMinConfidence > 1) throw new JevError('Invalid JEV memory filter confidence')
  if (!Number.isFinite(next.ekkoMemoryMinConfidence) || next.ekkoMemoryMinConfidence < 0.5 || next.ekkoMemoryMinConfidence > 1) throw new JevError('Invalid JEV memory confidence')
  if (!Number.isInteger(next.ekkoMemoryTimeoutMs) || next.ekkoMemoryTimeoutMs < 100 || next.ekkoMemoryTimeoutMs > 30000) throw new JevError('Invalid JEV memory timeout')
  for (const key of ['baseUrl', 'model', 'apiKey'] as const) {
    if (value[key] === undefined) continue
    if (typeof value[key] !== 'string' || value[key].length > 4096) throw new JevError(`Invalid JEV ${key}`)
    // Empty API key fields preserve the saved credential. DELETE clears it.
    if (key !== 'apiKey' || value[key].trim()) next[key] = value[key].trim()
  }
  if (value.timeoutMs !== undefined) next.timeoutMs = value.timeoutMs as number
  if (!Number.isInteger(next.timeoutMs) || next.timeoutMs < 1000 || next.timeoutMs > 120_000) {
    throw new JevError('JEV timeout must be between 1000 and 120000 ms')
  }
  if (!next.model || next.model.length > 200 || /[\r\n]/.test(next.model)) throw new JevError('Invalid JEV model')
  let url: URL
  try { url = new URL(next.baseUrl) } catch { throw new JevError('Invalid JEV base URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new JevError('JEV base URL must use HTTP(S) without credentials, query or fragment')
  }
  next.baseUrl = url.toString().replace(/\/+$/, '')
  if (/[\r\n]/.test(next.apiKey)) throw new JevError('Invalid JEV API key')
  return next
}

function publicSettings(value: StoredSettings): JevSettings {
  return { ekkoSkillsEnabled: value.ekkoSkillsEnabled, ekkoSkillsCandidateLimit: value.ekkoSkillsCandidateLimit,
    ekkoSkillsMinConfidence: value.ekkoSkillsMinConfidence, ekkoSkillsTimeoutMs: value.ekkoSkillsTimeoutMs,
    baseUrl: value.baseUrl, model: value.model, timeoutMs: value.timeoutMs, ekkoMemoryEnabled: value.ekkoMemoryEnabled, ekkoMemoryKindRoutingEnabled: value.ekkoMemoryKindRoutingEnabled, ekkoMemoryRelevanceFilterEnabled: value.ekkoMemoryRelevanceFilterEnabled, ekkoMemoryRerankEnabled: value.ekkoMemoryRerankEnabled, ekkoMemoryWriteReviewEnabled: value.ekkoMemoryWriteReviewEnabled, ekkoMemoryCandidateLimit: value.ekkoMemoryCandidateLimit, ekkoMemoryRecallMinConfidence: value.ekkoMemoryRecallMinConfidence, ekkoMemoryFilterMinConfidence: value.ekkoMemoryFilterMinConfidence, ekkoMemoryMinConfidence: value.ekkoMemoryMinConfidence, ekkoMemoryTimeoutMs: value.ekkoMemoryTimeoutMs, hasApiKey: !!value.apiKey }
}

export async function readJevCredentials(profile: string): Promise<StoredSettings> {
  try {
    return normalize(JSON.parse(await readFile(settingsPath(profile), 'utf8')))
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { ...defaults }
    throw error
  }
}

export async function getJevSettings(profile: string): Promise<JevSettings> {
  return publicSettings(await readJevCredentials(profile))
}

/** Server-only host configuration for agent runtimes; never return this from an HTTP endpoint. */
export async function getJevRuntimeConfig(profile: string) {
  const { ekkoSkillsEnabled, ekkoSkillsCandidateLimit, ekkoSkillsMinConfidence, ekkoSkillsTimeoutMs, ekkoMemoryEnabled, ekkoMemoryKindRoutingEnabled, ekkoMemoryRelevanceFilterEnabled, ekkoMemoryRerankEnabled, ekkoMemoryWriteReviewEnabled, ekkoMemoryCandidateLimit, ekkoMemoryRecallMinConfidence, ekkoMemoryFilterMinConfidence, ekkoMemoryMinConfidence, ekkoMemoryTimeoutMs, ...settings } = await readJevCredentials(profile)
  return { ...settings, enabled: Boolean(settings.apiKey), memoryEnabled: ekkoMemoryEnabled,
    skillsEnabled: ekkoSkillsEnabled,
    skillsCandidateLimit: ekkoSkillsCandidateLimit,
    skillsMinConfidence: ekkoSkillsMinConfidence,
    skillsTimeoutMs: ekkoSkillsTimeoutMs,
    memoryKindRoutingEnabled: ekkoMemoryKindRoutingEnabled,
    memoryRelevanceFilterEnabled: ekkoMemoryRelevanceFilterEnabled,
    memoryRerankEnabled: ekkoMemoryRerankEnabled,
    memoryWriteReviewEnabled: ekkoMemoryWriteReviewEnabled,
    memoryCandidateLimit: ekkoMemoryCandidateLimit,
    memoryRecallMinConfidence: ekkoMemoryRecallMinConfidence,
    memoryFilterMinConfidence: ekkoMemoryFilterMinConfidence,
    memoryMinConfidence: ekkoMemoryMinConfidence,
    memoryTimeoutMs: ekkoMemoryTimeoutMs,
  }
}

export async function saveJevSettings(profile: string, input: unknown): Promise<JevSettings> {
  const path = settingsPath(profile)
  const directory = join(config.appHome, 'models', 'jev')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const result = await safeFileStore.updateText(path, text => {
    const next = normalize(input, text ? normalize(JSON.parse(text)) : defaults)
    return { content: JSON.stringify(next), result: publicSettings(next) }
  })
  await chmod(path, 0o600)
  return result!
}

export async function deleteJevSettings(profile: string): Promise<JevSettings> {
  // Use the same write lock as saving; clearing cannot race a credential update.
  const path = settingsPath(profile)
  await mkdir(join(config.appHome, 'models', 'jev'), { recursive: true, mode: 0o700 })
  await safeFileStore.updateText(path, () => JSON.stringify(defaults))
  await chmod(path, 0o600)
  return publicSettings(defaults)
}
