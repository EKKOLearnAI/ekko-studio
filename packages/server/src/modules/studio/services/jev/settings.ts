import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../../public/config'
import { safeFileStore } from '../../public/safe-file-store'

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

export interface JevCredentialSettings extends Omit<JevSettings, 'hasApiKey'> { apiKey: string }
type StoredSettings = JevCredentialSettings

export class JevError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = 'jev_invalid_request') { super(message) }
}

const defaults: StoredSettings = {
  groupSummaryReviewEnabled: false,
  groupSummaryReviewMinConfidence: 0.8,
  groupSummaryRevisionEnabled: false,
  groupSummaryReviewTimeoutMs: 3000,
  workflowQualityEnabled: false,
  workflowQualityMinConfidence: 0.8,
  workflowQualityTimeoutMs: 5000,
  groupMessageRoutingEnabled: false,
  groupHandoffReviewEnabled: true,
  groupLoopDetectionEnabled: true,
  groupMessageRoutingMinConfidence: 0.9,
  groupMessageRoutingMode: 'suggest',
  groupMessageRoutingTimeoutMs: 1500,
  browserMatchEnabled: false,
  browserMatchCandidateLimit: 20,
  browserMatchMinConfidence: 0.8,
  browserMatchTimeoutMs: 3000,
  browserVerifyEnabled: false,
  browserVerifyMinConfidence: 0.8,
  browserVerifyTimeoutMs: 3000,

  ekkoComputerUseMatchEnabled: false,
  ekkoComputerUseMatchCandidateLimit: 20,
  ekkoComputerUseMatchMinConfidence: 0.8,
  ekkoComputerUseMatchTimeoutMs: 3000,
  ekkoComputerUseVerifyEnabled: false,
  ekkoComputerUseVerifyMinConfidence: 0.8,
  ekkoComputerUseVerifyTimeoutMs: 3000,
  ekkoSkillsEnabled: false,
  ekkoSkillsCandidateLimit: 20,
  ekkoSkillsMinConfidence: 0.8,
  ekkoSkillsTimeoutMs: 3000,
  personMemoryEnabled: false,
  personMemoryKindRoutingEnabled: true,
  personMemoryRelevanceFilterEnabled: true,
  personMemoryRerankEnabled: true,
  personMemoryWriteReviewEnabled: true,
  personMemoryCandidateLimit: 20,
  personMemoryRecallMinConfidence: 0.5,
  personMemoryFilterMinConfidence: 0.8,
  personMemoryMinConfidence: 0.8,
  personMemoryTimeoutMs: 3000,
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

function settingsPath(): string {
  return join(config.appHome, 'models', 'jev', 'global.json')
}

function normalize(input: unknown, current = defaults): StoredSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new JevError('Invalid JEV settings')
  const value = input as Record<string, unknown>
  if (Object.keys(value).some(key => !['personMemoryEnabled', 'personMemoryKindRoutingEnabled', 'personMemoryRelevanceFilterEnabled', 'personMemoryRerankEnabled', 'personMemoryWriteReviewEnabled', 'personMemoryCandidateLimit', 'personMemoryRecallMinConfidence', 'personMemoryFilterMinConfidence', 'personMemoryMinConfidence', 'personMemoryTimeoutMs', 'ekkoComputerUseMatchEnabled', 'ekkoComputerUseMatchCandidateLimit', 'ekkoComputerUseMatchMinConfidence', 'ekkoComputerUseMatchTimeoutMs', 'ekkoComputerUseVerifyEnabled', 'ekkoComputerUseVerifyMinConfidence', 'ekkoComputerUseVerifyTimeoutMs', 'browserMatchEnabled', 'browserMatchCandidateLimit', 'browserMatchMinConfidence', 'browserMatchTimeoutMs', 'browserVerifyEnabled', 'browserVerifyMinConfidence', 'browserVerifyTimeoutMs', 'groupSummaryReviewEnabled', 'groupSummaryReviewMinConfidence', 'groupSummaryRevisionEnabled', 'groupSummaryReviewTimeoutMs', 'workflowQualityEnabled', 'workflowQualityMinConfidence', 'workflowQualityTimeoutMs', 'groupMessageRoutingEnabled', 'groupHandoffReviewEnabled', 'groupLoopDetectionEnabled', 'groupMessageRoutingMinConfidence', 'groupMessageRoutingMode', 'groupMessageRoutingTimeoutMs', 'baseUrl', 'model', 'timeoutMs', 'apiKey', 'ekkoSkillsEnabled', 'ekkoSkillsCandidateLimit', 'ekkoSkillsMinConfidence', 'ekkoSkillsTimeoutMs', 'ekkoMemoryEnabled', 'ekkoMemoryKindRoutingEnabled', 'ekkoMemoryRelevanceFilterEnabled', 'ekkoMemoryRerankEnabled', 'ekkoMemoryWriteReviewEnabled', 'ekkoMemoryCandidateLimit', 'ekkoMemoryRecallMinConfidence', 'ekkoMemoryFilterMinConfidence', 'ekkoMemoryMinConfidence', 'ekkoMemoryTimeoutMs'].includes(key))) {
    throw new JevError('Unknown JEV setting')
  }
  const next = { ...current }
  if (value.ekkoMemoryEnabled !== undefined) {
    if (typeof value.ekkoMemoryEnabled !== 'boolean') throw new JevError('JEV ekkoMemoryEnabled must be a boolean')
    next.ekkoMemoryEnabled = value.ekkoMemoryEnabled
  }
  for (const key of ['personMemoryEnabled', 'personMemoryKindRoutingEnabled', 'personMemoryRelevanceFilterEnabled', 'personMemoryRerankEnabled', 'personMemoryWriteReviewEnabled', 'browserMatchEnabled', 'browserVerifyEnabled', 'groupSummaryReviewEnabled', 'groupSummaryRevisionEnabled', 'workflowQualityEnabled', 'groupMessageRoutingEnabled', 'groupHandoffReviewEnabled', 'groupLoopDetectionEnabled', 'ekkoSkillsEnabled', 'ekkoMemoryKindRoutingEnabled', 'ekkoMemoryRelevanceFilterEnabled', 'ekkoMemoryRerankEnabled', 'ekkoMemoryWriteReviewEnabled'] as const) {
    if (value[key] === undefined) continue
    if (typeof value[key] !== 'boolean') throw new JevError(`Invalid JEV ${key}`)
    next[key] = value[key]
  }
  if (value.ekkoComputerUseMatchEnabled !== undefined) next.ekkoComputerUseMatchEnabled = value.ekkoComputerUseMatchEnabled as boolean
  if (value.ekkoComputerUseMatchCandidateLimit !== undefined) next.ekkoComputerUseMatchCandidateLimit = value.ekkoComputerUseMatchCandidateLimit as number
  if (value.ekkoComputerUseMatchMinConfidence !== undefined) next.ekkoComputerUseMatchMinConfidence = value.ekkoComputerUseMatchMinConfidence as number
  if (value.ekkoComputerUseMatchTimeoutMs !== undefined) next.ekkoComputerUseMatchTimeoutMs = value.ekkoComputerUseMatchTimeoutMs as number
  if (value.ekkoComputerUseVerifyEnabled !== undefined) next.ekkoComputerUseVerifyEnabled = value.ekkoComputerUseVerifyEnabled as boolean
  if (value.ekkoComputerUseVerifyMinConfidence !== undefined) next.ekkoComputerUseVerifyMinConfidence = value.ekkoComputerUseVerifyMinConfidence as number
  if (value.ekkoComputerUseVerifyTimeoutMs !== undefined) next.ekkoComputerUseVerifyTimeoutMs = value.ekkoComputerUseVerifyTimeoutMs as number
  if (typeof next.ekkoComputerUseMatchEnabled !== 'boolean') throw new JevError('Invalid JEV ekkoComputerUseMatchEnabled')
  if (!Number.isInteger(next.ekkoComputerUseMatchCandidateLimit) || next.ekkoComputerUseMatchCandidateLimit < 1 || next.ekkoComputerUseMatchCandidateLimit > 50) throw new JevError('Invalid JEV ekkoComputerUseMatchCandidateLimit')
  if (!Number.isFinite(next.ekkoComputerUseMatchMinConfidence) || next.ekkoComputerUseMatchMinConfidence < 0.5 || next.ekkoComputerUseMatchMinConfidence > 1) throw new JevError('Invalid JEV ekkoComputerUseMatchMinConfidence')
  if (!Number.isInteger(next.ekkoComputerUseMatchTimeoutMs) || next.ekkoComputerUseMatchTimeoutMs < 100 || next.ekkoComputerUseMatchTimeoutMs > 30000) throw new JevError('Invalid JEV ekkoComputerUseMatchTimeoutMs')
  if (typeof next.ekkoComputerUseVerifyEnabled !== 'boolean') throw new JevError('Invalid JEV ekkoComputerUseVerifyEnabled')
  if (!Number.isFinite(next.ekkoComputerUseVerifyMinConfidence) || next.ekkoComputerUseVerifyMinConfidence < 0.5 || next.ekkoComputerUseVerifyMinConfidence > 1) throw new JevError('Invalid JEV ekkoComputerUseVerifyMinConfidence')
  if (!Number.isInteger(next.ekkoComputerUseVerifyTimeoutMs) || next.ekkoComputerUseVerifyTimeoutMs < 100 || next.ekkoComputerUseVerifyTimeoutMs > 30000) throw new JevError('Invalid JEV ekkoComputerUseVerifyTimeoutMs')
  if (value.browserMatchCandidateLimit !== undefined) next.browserMatchCandidateLimit = value.browserMatchCandidateLimit as number
  if (!Number.isInteger(next.browserMatchCandidateLimit) || next.browserMatchCandidateLimit < 1 || next.browserMatchCandidateLimit > 50) throw new JevError('Invalid JEV browserMatchCandidateLimit')
  if (value.browserMatchMinConfidence !== undefined) next.browserMatchMinConfidence = value.browserMatchMinConfidence as number
  if (!Number.isFinite(next.browserMatchMinConfidence) || next.browserMatchMinConfidence < 0.5 || next.browserMatchMinConfidence > 1) throw new JevError('Invalid JEV browserMatchMinConfidence')
  if (value.browserMatchTimeoutMs !== undefined) next.browserMatchTimeoutMs = value.browserMatchTimeoutMs as number
  if (!Number.isInteger(next.browserMatchTimeoutMs) || next.browserMatchTimeoutMs < 100 || next.browserMatchTimeoutMs > 30000) throw new JevError('Invalid JEV browserMatchTimeoutMs')
  if (value.browserVerifyMinConfidence !== undefined) next.browserVerifyMinConfidence = value.browserVerifyMinConfidence as number
  if (!Number.isFinite(next.browserVerifyMinConfidence) || next.browserVerifyMinConfidence < 0.5 || next.browserVerifyMinConfidence > 1) throw new JevError('Invalid JEV browserVerifyMinConfidence')
  if (value.browserVerifyTimeoutMs !== undefined) next.browserVerifyTimeoutMs = value.browserVerifyTimeoutMs as number
  if (!Number.isInteger(next.browserVerifyTimeoutMs) || next.browserVerifyTimeoutMs < 100 || next.browserVerifyTimeoutMs > 30000) throw new JevError('Invalid JEV browserVerifyTimeoutMs')
  if (value.groupMessageRoutingMode !== undefined) {
    if (value.groupMessageRoutingMode !== 'suggest' && value.groupMessageRoutingMode !== 'auto') throw new JevError('Invalid JEV group message routing mode')
    next.groupMessageRoutingMode = value.groupMessageRoutingMode
  }
  if (value.groupMessageRoutingMinConfidence !== undefined) next.groupMessageRoutingMinConfidence = value.groupMessageRoutingMinConfidence as number
  if (value.groupMessageRoutingTimeoutMs !== undefined) next.groupMessageRoutingTimeoutMs = value.groupMessageRoutingTimeoutMs as number
  if (!Number.isFinite(next.groupMessageRoutingMinConfidence) || next.groupMessageRoutingMinConfidence < 0.5 || next.groupMessageRoutingMinConfidence > 1) throw new JevError('Invalid JEV group message routing confidence')
  if (!Number.isInteger(next.groupMessageRoutingTimeoutMs) || next.groupMessageRoutingTimeoutMs < 100 || next.groupMessageRoutingTimeoutMs > 30000) throw new JevError('Invalid JEV group message routing timeout')
  if (value.workflowQualityMinConfidence !== undefined) next.workflowQualityMinConfidence = value.workflowQualityMinConfidence as number
  if (value.workflowQualityTimeoutMs !== undefined) next.workflowQualityTimeoutMs = value.workflowQualityTimeoutMs as number
  if (!Number.isFinite(next.workflowQualityMinConfidence) || next.workflowQualityMinConfidence < 0.5 || next.workflowQualityMinConfidence > 1) throw new JevError('Invalid JEV workflow quality confidence')
  if (!Number.isInteger(next.workflowQualityTimeoutMs) || next.workflowQualityTimeoutMs < 100 || next.workflowQualityTimeoutMs > 30000) throw new JevError('Invalid JEV workflow quality timeout')
  if (value.groupSummaryReviewMinConfidence !== undefined) next.groupSummaryReviewMinConfidence = value.groupSummaryReviewMinConfidence as number
  if (value.groupSummaryReviewTimeoutMs !== undefined) next.groupSummaryReviewTimeoutMs = value.groupSummaryReviewTimeoutMs as number
  if (!Number.isFinite(next.groupSummaryReviewMinConfidence) || next.groupSummaryReviewMinConfidence < 0.5 || next.groupSummaryReviewMinConfidence > 1) throw new JevError('Invalid JEV group summary review confidence')
  if (!Number.isInteger(next.groupSummaryReviewTimeoutMs) || next.groupSummaryReviewTimeoutMs < 100 || next.groupSummaryReviewTimeoutMs > 30000) throw new JevError('Invalid JEV group summary review timeout')
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
  if (value.personMemoryCandidateLimit !== undefined) next.personMemoryCandidateLimit = value.personMemoryCandidateLimit as number
  if (value.personMemoryRecallMinConfidence !== undefined) next.personMemoryRecallMinConfidence = value.personMemoryRecallMinConfidence as number
  if (value.personMemoryFilterMinConfidence !== undefined) next.personMemoryFilterMinConfidence = value.personMemoryFilterMinConfidence as number
  if (value.personMemoryMinConfidence !== undefined) next.personMemoryMinConfidence = value.personMemoryMinConfidence as number
  if (value.personMemoryTimeoutMs !== undefined) next.personMemoryTimeoutMs = value.personMemoryTimeoutMs as number
  if (!Number.isInteger(next.personMemoryCandidateLimit) || next.personMemoryCandidateLimit < 1 || next.personMemoryCandidateLimit > 50) throw new JevError('Invalid JEV memory candidate limit')
  if (!Number.isFinite(next.personMemoryRecallMinConfidence) || next.personMemoryRecallMinConfidence < 0.5 || next.personMemoryRecallMinConfidence > 1) throw new JevError('Invalid JEV memory recall confidence')
  if (!Number.isFinite(next.personMemoryFilterMinConfidence) || next.personMemoryFilterMinConfidence < 0.5 || next.personMemoryFilterMinConfidence > 1) throw new JevError('Invalid JEV memory filter confidence')
  if (!Number.isFinite(next.personMemoryMinConfidence) || next.personMemoryMinConfidence < 0.5 || next.personMemoryMinConfidence > 1) throw new JevError('Invalid JEV memory confidence')
  if (!Number.isInteger(next.personMemoryTimeoutMs) || next.personMemoryTimeoutMs < 100 || next.personMemoryTimeoutMs > 30000) throw new JevError('Invalid JEV memory timeout')
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
  // The SDK appends /v1/systemone; accept versioned bases and complete endpoints too.
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1(?:\/systemone)?$/, '') || '/'
  next.baseUrl = url.toString().replace(/\/+$/, '')
  if (/[\r\n]/.test(next.apiKey)) throw new JevError('Invalid JEV API key')
  return next
}

function publicSettings(value: StoredSettings): JevSettings {
  return {
    personMemoryEnabled: value.personMemoryEnabled,
    personMemoryKindRoutingEnabled: value.personMemoryKindRoutingEnabled,
    personMemoryRelevanceFilterEnabled: value.personMemoryRelevanceFilterEnabled,
    personMemoryRerankEnabled: value.personMemoryRerankEnabled,
    personMemoryWriteReviewEnabled: value.personMemoryWriteReviewEnabled,
    personMemoryCandidateLimit: value.personMemoryCandidateLimit,
    personMemoryRecallMinConfidence: value.personMemoryRecallMinConfidence,
    personMemoryFilterMinConfidence: value.personMemoryFilterMinConfidence,
    personMemoryMinConfidence: value.personMemoryMinConfidence,
    personMemoryTimeoutMs: value.personMemoryTimeoutMs,
    groupMessageRoutingEnabled: value.groupMessageRoutingEnabled, groupHandoffReviewEnabled: value.groupHandoffReviewEnabled, groupLoopDetectionEnabled: value.groupLoopDetectionEnabled, groupMessageRoutingMinConfidence: value.groupMessageRoutingMinConfidence, groupMessageRoutingMode: value.groupMessageRoutingMode, groupMessageRoutingTimeoutMs: value.groupMessageRoutingTimeoutMs,
    workflowQualityEnabled: value.workflowQualityEnabled, workflowQualityMinConfidence: value.workflowQualityMinConfidence, workflowQualityTimeoutMs: value.workflowQualityTimeoutMs,
    groupSummaryReviewEnabled: value.groupSummaryReviewEnabled, groupSummaryReviewMinConfidence: value.groupSummaryReviewMinConfidence, groupSummaryRevisionEnabled: value.groupSummaryRevisionEnabled, groupSummaryReviewTimeoutMs: value.groupSummaryReviewTimeoutMs,
    ekkoComputerUseMatchEnabled: value.ekkoComputerUseMatchEnabled,
    ekkoComputerUseMatchCandidateLimit: value.ekkoComputerUseMatchCandidateLimit,
    ekkoComputerUseMatchMinConfidence: value.ekkoComputerUseMatchMinConfidence,
    ekkoComputerUseMatchTimeoutMs: value.ekkoComputerUseMatchTimeoutMs,
    ekkoComputerUseVerifyEnabled: value.ekkoComputerUseVerifyEnabled,
    ekkoComputerUseVerifyMinConfidence: value.ekkoComputerUseVerifyMinConfidence,
    ekkoComputerUseVerifyTimeoutMs: value.ekkoComputerUseVerifyTimeoutMs,
    browserMatchEnabled: value.browserMatchEnabled,
    browserMatchCandidateLimit: value.browserMatchCandidateLimit,
    browserMatchMinConfidence: value.browserMatchMinConfidence,
    browserMatchTimeoutMs: value.browserMatchTimeoutMs,
    browserVerifyEnabled: value.browserVerifyEnabled,
    browserVerifyMinConfidence: value.browserVerifyMinConfidence,
    browserVerifyTimeoutMs: value.browserVerifyTimeoutMs,
    ekkoSkillsEnabled: value.ekkoSkillsEnabled, ekkoSkillsCandidateLimit: value.ekkoSkillsCandidateLimit,
    ekkoSkillsMinConfidence: value.ekkoSkillsMinConfidence, ekkoSkillsTimeoutMs: value.ekkoSkillsTimeoutMs,
    baseUrl: value.baseUrl, model: value.model, timeoutMs: value.timeoutMs, ekkoMemoryEnabled: value.ekkoMemoryEnabled, ekkoMemoryKindRoutingEnabled: value.ekkoMemoryKindRoutingEnabled, ekkoMemoryRelevanceFilterEnabled: value.ekkoMemoryRelevanceFilterEnabled, ekkoMemoryRerankEnabled: value.ekkoMemoryRerankEnabled, ekkoMemoryWriteReviewEnabled: value.ekkoMemoryWriteReviewEnabled, ekkoMemoryCandidateLimit: value.ekkoMemoryCandidateLimit, ekkoMemoryRecallMinConfidence: value.ekkoMemoryRecallMinConfidence, ekkoMemoryFilterMinConfidence: value.ekkoMemoryFilterMinConfidence, ekkoMemoryMinConfidence: value.ekkoMemoryMinConfidence, ekkoMemoryTimeoutMs: value.ekkoMemoryTimeoutMs, hasApiKey: !!value.apiKey }
}

async function legacySettings(): Promise<StoredSettings | undefined> {
  const directory = join(config.appHome, 'models', 'jev')
  let files: string[]
  try { files = (await readdir(directory)).filter(file => /^[a-f0-9]{64}\.json$/.test(file)) }
  catch (error: any) { if (error?.code === 'ENOENT') return; throw error }
  const defaultFile = `${createHash('sha256').update('default').digest('hex')}.json`
  const source = files.includes(defaultFile) ? defaultFile : files.length === 1 ? files[0] : undefined
  if (!source) return
  return normalize(JSON.parse(await readFile(join(directory, source), 'utf8')))
}

export async function readJevCredentials(): Promise<StoredSettings> {
  try { return normalize(JSON.parse(await readFile(settingsPath(), 'utf8'))) }
  catch (error: any) { if (error?.code !== 'ENOENT') throw error }
  const legacy = await legacySettings()
  if (!legacy) return { ...defaults }
  // Serialize migration with saves/resets. Existing global state always wins;
  // legacy files remain intact and deleting the global key cannot revive them.
  const result = await safeFileStore.updateText(settingsPath(), text => {
    const next = text ? normalize(JSON.parse(text)) : legacy
    return { content: JSON.stringify(next), result: next }
  })
  await chmod(settingsPath(), 0o600)
  return result!
}

export async function getJevSettings(): Promise<JevSettings> {
  return publicSettings(await readJevCredentials())
}

/** Server-only host configuration for agent runtimes; never return this from an HTTP endpoint. */
export async function getJevRuntimeConfig() {
  const { ekkoComputerUseMatchEnabled, ekkoComputerUseMatchCandidateLimit, ekkoComputerUseMatchMinConfidence, ekkoComputerUseMatchTimeoutMs, ekkoComputerUseVerifyEnabled, ekkoComputerUseVerifyMinConfidence, ekkoComputerUseVerifyTimeoutMs, ekkoSkillsEnabled, ekkoSkillsCandidateLimit, ekkoSkillsMinConfidence, ekkoSkillsTimeoutMs, ekkoMemoryEnabled, ekkoMemoryKindRoutingEnabled, ekkoMemoryRelevanceFilterEnabled, ekkoMemoryRerankEnabled, ekkoMemoryWriteReviewEnabled, ekkoMemoryCandidateLimit, ekkoMemoryRecallMinConfidence, ekkoMemoryFilterMinConfidence, ekkoMemoryMinConfidence, ekkoMemoryTimeoutMs, apiKey, baseUrl, model, timeoutMs } = await readJevCredentials()
  return { apiKey, baseUrl, model, timeoutMs, enabled: Boolean(apiKey), memoryEnabled: ekkoMemoryEnabled,
    computerUseMatchEnabled: ekkoComputerUseMatchEnabled,
    computerUseMatchCandidateLimit: ekkoComputerUseMatchCandidateLimit,
    computerUseMatchMinConfidence: ekkoComputerUseMatchMinConfidence,
    computerUseMatchTimeoutMs: ekkoComputerUseMatchTimeoutMs,
    computerUseVerifyEnabled: ekkoComputerUseVerifyEnabled,
    computerUseVerifyMinConfidence: ekkoComputerUseVerifyMinConfidence,
    computerUseVerifyTimeoutMs: ekkoComputerUseVerifyTimeoutMs,
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

/** Personal assistant memory has its own controls; credentials are shared globally. */
export async function getPersonJevRuntimeConfig() {
  const { personMemoryEnabled, personMemoryKindRoutingEnabled, personMemoryRelevanceFilterEnabled, personMemoryRerankEnabled, personMemoryWriteReviewEnabled, personMemoryCandidateLimit, personMemoryRecallMinConfidence, personMemoryFilterMinConfidence, personMemoryMinConfidence, personMemoryTimeoutMs, apiKey, baseUrl, model, timeoutMs } = await readJevCredentials()
  return { apiKey, baseUrl, model, timeoutMs, enabled: Boolean(apiKey),
    memoryEnabled: personMemoryEnabled,
    memoryKindRoutingEnabled: personMemoryKindRoutingEnabled,
    memoryRelevanceFilterEnabled: personMemoryRelevanceFilterEnabled,
    memoryRerankEnabled: personMemoryRerankEnabled,
    memoryWriteReviewEnabled: personMemoryWriteReviewEnabled,
    memoryCandidateLimit: personMemoryCandidateLimit,
    memoryRecallMinConfidence: personMemoryRecallMinConfidence,
    memoryFilterMinConfidence: personMemoryFilterMinConfidence,
    memoryMinConfidence: personMemoryMinConfidence,
    memoryTimeoutMs: personMemoryTimeoutMs,
  }
}

export async function saveJevSettings(input: unknown): Promise<JevSettings> {
  const path = settingsPath()
  const directory = join(config.appHome, 'models', 'jev')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const previous = await readJevCredentials()
  const result = await safeFileStore.updateText(path, text => {
    const next = normalize(input, text ? normalize(JSON.parse(text)) : previous)
    return { content: JSON.stringify(next), result: publicSettings(next) }
  })
  await chmod(path, 0o600)
  return result!
}

export async function deleteJevSettings(): Promise<JevSettings> {
  // Use the same write lock as saving; clearing cannot race a credential update.
  const path = settingsPath()
  await mkdir(join(config.appHome, 'models', 'jev'), { recursive: true, mode: 0o700 })
  await safeFileStore.updateText(path, () => JSON.stringify(defaults))
  await chmod(path, 0o600)
  return publicSettings(defaults)
}
