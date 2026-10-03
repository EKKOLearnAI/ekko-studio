import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../../public/config'
import { safeFileStore } from '../../public/safe-file-store'

export type ContextManagerName = 'hermes' | 'ekko'
export type ContextManagerBackend = 'native' | 'bili'
export type ContextManagerLifecycleAction = 'install' | 'start' | 'stop' | 'upgrade'

export interface ContextManagerSettings {
  hermes: { manager: ContextManagerBackend }
  ekko: { manager: ContextManagerBackend }
  proxyUrl: string
  allowNativeFallback: boolean
}

export type ContextManagerSettingsUpdate = {
  hermes?: { manager?: ContextManagerBackend }
  ekko?: { manager?: ContextManagerBackend }
  proxyUrl?: string
  allowNativeFallback?: boolean
}


export class ContextManagerError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = 'context_manager_invalid_request') {
    super(message)
  }
}

export const DEFAULT_CONTEXT_MANAGER_SETTINGS: ContextManagerSettings = {
  hermes: { manager: 'native' },
  ekko: { manager: 'native' },
  proxyUrl: 'http://127.0.0.1:8787',
  allowNativeFallback: false,
}

const allowedTopLevelKeys = new Set(['hermes', 'ekko', 'proxyUrl', 'allowNativeFallback'])

const loopbackHostnames = new Set(['localhost', '127.0.0.1', '[::1]'])

export function profileKey(profile: string): string {
  if (typeof profile !== 'string' || !profile.trim() || profile.length > 128) {
    throw new ContextManagerError('Profile is required')
  }
  return profile.trim()
}

function settingsPath(profile: string): string {
  const key = profileKey(profile)
  return join(config.appHome, 'settings', 'context-manager', `${createHash('sha256').update(key).digest('hex')}.json`)
}

function cloneDefaults(): ContextManagerSettings {
  return {
    hermes: { manager: DEFAULT_CONTEXT_MANAGER_SETTINGS.hermes.manager },
    ekko: { manager: DEFAULT_CONTEXT_MANAGER_SETTINGS.ekko.manager },
    proxyUrl: DEFAULT_CONTEXT_MANAGER_SETTINGS.proxyUrl,
    allowNativeFallback: DEFAULT_CONTEXT_MANAGER_SETTINGS.allowNativeFallback,
  }
}

function parseStored(raw: string): ContextManagerSettings {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new ContextManagerError('Context manager settings are invalid', 500, 'context_manager_storage_invalid')
  }
  return normalizeSettings(value, cloneDefaults(), true)
}

export function validateProxyUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) {
    throw new ContextManagerError('Context manager proxy URL is invalid')
  }

  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new ContextManagerError('Context manager proxy URL is invalid')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ContextManagerError('Context manager proxy URL must use HTTP(S)')
  }
  if (url.username || url.password) {
    throw new ContextManagerError('Context manager proxy URL cannot contain credentials')
  }
  if (!loopbackHostnames.has(url.hostname.toLowerCase())) {
    throw new ContextManagerError('Context manager proxy URL must target a loopback host')
  }
  if (url.port && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535)) {
    throw new ContextManagerError('Context manager proxy URL has an invalid port')
  }

  const rawPath = value.trim().match(/^https?:\/\/[^/?#]+(.*)$/i)?.[1]
  if ((rawPath !== '' && rawPath !== '/') || url.pathname !== '/' || url.search || url.hash) {
    throw new ContextManagerError('Context manager proxy URL must be an origin without a path, query, or fragment')
  }
  return url.origin
}

function managerValue(value: unknown, name: ContextManagerName): ContextManagerBackend {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContextManagerError(`Context manager ${name} settings are invalid`)
  }
  const keys = Object.keys(value as Record<string, unknown>)
  if (keys.some(key => key !== 'manager')) throw new ContextManagerError(`Unknown context manager ${name} setting`)
  const manager = (value as { manager?: unknown }).manager
  if (manager !== 'native' && manager !== 'bili') {
    throw new ContextManagerError(`Context manager ${name} manager must be native or bili`)
  }
  return manager
}

function normalizeSettings(input: unknown, current: ContextManagerSettings, stored: boolean): ContextManagerSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ContextManagerError('Context manager settings must be an object')
  }
  const value = input as Record<string, unknown>
  if (Object.keys(value).some(key => !allowedTopLevelKeys.has(key))) {
    throw new ContextManagerError('Unknown context manager setting')
  }

  const next: ContextManagerSettings = {
    hermes: { ...current.hermes },
    ekko: { ...current.ekko },
    proxyUrl: current.proxyUrl,
    allowNativeFallback: current.allowNativeFallback,
  }
  for (const name of ['hermes', 'ekko'] as const) {
    if (value[name] === undefined) continue
    next[name] = { manager: managerValue(value[name], name) }
  }
  if (value.proxyUrl !== undefined) next.proxyUrl = validateProxyUrl(value.proxyUrl)
  if (value.allowNativeFallback !== undefined) {
    if (typeof value.allowNativeFallback !== 'boolean') {
      throw new ContextManagerError('Context manager allowNativeFallback must be a boolean')
    }
    next.allowNativeFallback = value.allowNativeFallback
  }
  if (stored && next.allowNativeFallback !== false && typeof next.allowNativeFallback !== 'boolean') {
    throw new ContextManagerError('Context manager settings are invalid')
  }
  return next
}

async function readStoredSettings(profile: string): Promise<ContextManagerSettings> {
  try {
    return parseStored(await readFile(settingsPath(profile), 'utf8'))
  } catch (error: any) {
    if (error?.code === 'ENOENT') return cloneDefaults()
    throw error
  }
}

export async function getContextManagerSettings(profile: string): Promise<ContextManagerSettings> {
  return readStoredSettings(profile)
}

export async function saveContextManagerSettings(profile: string, input: unknown): Promise<ContextManagerSettings> {
  const path = settingsPath(profile)
  const directory = join(config.appHome, 'settings', 'context-manager')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const result = await safeFileStore.updateText(path, text => {
    const current = text ? parseStored(text) : cloneDefaults()
    const next = normalizeSettings(input, current, false)
    return { content: JSON.stringify(next), result: next }
  })
  await chmod(path, 0o600)
  return result!
}
