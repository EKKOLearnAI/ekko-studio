import { join } from 'path'
import { readFileSync, existsSync, readdirSync } from 'fs'
import { detectHermesRootHome } from '../runtime/path'

export function getHermesBaseDir(): string {
  return detectHermesRootHome()
}

/**
 * Get the active profile's home directory.
 * default → ~/.hermes/
 * other   → ~/.hermes/profiles/{name}/
 */
export function getActiveProfileDir(): string {
  const hermesBase = getHermesBaseDir()
  const activeFile = join(hermesBase, 'active_profile')
  try {
    const name = readFileSync(activeFile, 'utf-8').trim()
    if (name && name !== 'default') {
      const dir = join(hermesBase, 'profiles', name)
      if (existsSync(dir)) return dir
    }
  } catch { }
  return hermesBase
}

/**
 * Get the active profile's config.yaml path.
 */
export function getActiveConfigPath(): string {
  return join(getActiveProfileDir(), 'config.yaml')
}

/**
 * Get the active profile's auth.json path.
 */
export function getActiveAuthPath(): string {
  return join(getActiveProfileDir(), 'auth.json')
}

/**
 * Get the active profile's .env path.
 */
export function getActiveEnvPath(): string {
  return join(getActiveProfileDir(), '.env')
}

/**
 * Get the active profile name.
 */
export function getActiveProfileName(): string {
  const activeFile = join(getHermesBaseDir(), 'active_profile')
  try {
    const name = readFileSync(activeFile, 'utf-8').trim()
    return name || 'default'
  } catch {
    return 'default'
  }
}

/**
 * Get profile directory by name.
 * default → ~/.hermes/
 * other   → ~/.hermes/profiles/{name}/
 */
export function getProfileDir(name: string): string {
  const hermesBase = getHermesBaseDir()
  if (!name || name === 'default') return hermesBase
  const dir = join(hermesBase, 'profiles', name)
  return existsSync(dir) ? dir : hermesBase
}

export function listProfileNamesFromDisk(): string[] {
  const hermesBase = getHermesBaseDir()
  const names = new Set<string>(['default'])
  const profilesDir = join(hermesBase, 'profiles')
  try {
    for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name.trim()) {
        names.add(entry.name)
      }
    }
  } catch {}
  return [...names].sort((a, b) => {
    if (a === 'default') return -1
    if (b === 'default') return 1
    return a.localeCompare(b)
  })
}
