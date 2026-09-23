import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../../public/config'
import { safeFileStore } from '../../public/safe-file-store'

export interface JevSettings {
  baseUrl: string
  model: string
  timeoutMs: number
  hasApiKey: boolean
}

interface StoredSettings extends Omit<JevSettings, 'hasApiKey'> { apiKey: string }

export class JevError extends Error {
  constructor(message: string, public readonly status = 400) { super(message) }
}

const defaults: StoredSettings = {
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
  if (Object.keys(value).some(key => !['baseUrl', 'model', 'timeoutMs', 'apiKey'].includes(key))) {
    throw new JevError('Unknown JEV setting')
  }
  const next = { ...current }
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
  return { baseUrl: value.baseUrl, model: value.model, timeoutMs: value.timeoutMs, hasApiKey: !!value.apiKey }
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
