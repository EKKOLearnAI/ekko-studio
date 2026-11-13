import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, matchesGlob, resolve } from 'node:path'

type PiSettings = Record<string, unknown>

export function parsePiSettings(content: string): PiSettings {
  try {
    const value = JSON.parse(content)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
  } catch {}
  return {}
}

function settingsPath(path: string, baseDir: string): string {
  const prefix = /^[+-]/.test(path) ? path[0] : ''
  const value = prefix ? path.slice(1) : path
  const expanded = value.startsWith('~/') || value.startsWith('~\\')
    ? resolve(homedir(), value.slice(2))
    : isAbsolute(value) ? value : resolve(baseDir, value)
  return prefix + expanded
}

function isPackageReference(source: string): boolean {
  return /^(?:npm:|git:|https?:\/\/|ssh:\/\/)/.test(source)
}

/** Keep extension paths relative to their original settings file, not the run directory. */
export function mergePiSettings(
  sources: Array<{ content: string; baseDir: string }>,
  bundledAdapterEntry: string,
): PiSettings {
  let merged: PiSettings = {}
  const extensions = new Set<string>()
  for (const source of sources) {
    const settings = parsePiSettings(source.content)
    if (Array.isArray(settings.extensions)) {
      for (const entry of settings.extensions) {
        if (typeof entry !== 'string' || !entry.trim()) continue
        const path = settingsPath(entry.trim(), source.baseDir)
        if (path.replace(/^[+-]/, '') !== bundledAdapterEntry) extensions.add(path)
      }
    }
    if (Array.isArray(settings.packages)) {
      settings.packages = settings.packages.map(entry => {
        const packageSource = typeof entry === 'string' ? entry : entry?.source
        if (typeof packageSource !== 'string' || isPackageReference(packageSource)) return entry
        // Pi expects npm: sources; convert legacy bare adapter specs in the
        // generated runtime only, leaving the user's settings untouched.
        const path = /^(?:@[^/]+\/)?pi-mcp-adapter(?:@[^/]+)?$/.test(packageSource)
          ? `npm:${packageSource}`
          : settingsPath(packageSource, source.baseDir)
        return typeof entry === 'string' ? path : { ...entry, source: path }
      })
    }
    merged = { ...merged, ...settings }
  }
  return { ...merged, extensions: [...extensions] }
}

function adapterExtensionEnabled(patterns: unknown): boolean {
  if (!Array.isArray(patterns)) return true
  const values = patterns.filter((pattern): pattern is string => typeof pattern === 'string')
  if (!values.length) return false
  const normalized = (pattern: string) => pattern.replace(/^\.\//, '')
  const includes = values.filter(pattern => !/^[!+-]/.test(pattern))
  let enabled = !includes.length || includes.some(pattern => matchesGlob('index.ts', normalized(pattern)))
  if (values.some(pattern => pattern.startsWith('!') && matchesGlob('index.ts', normalized(pattern.slice(1))))) enabled = false
  if (values.some(pattern => pattern.startsWith('+') && normalized(pattern.slice(1)) === 'index.ts')) enabled = true
  if (values.some(pattern => pattern.startsWith('-') && normalized(pattern.slice(1)) === 'index.ts')) enabled = false
  return enabled
}

function isAdapterPath(path: string): boolean {
  return /(?:^|[/\\])pi-mcp-adapter(?:[/\\]|$)/.test(path) && existsSync(path)
}

export function userSettingsProvidesPiMcpAdapter(settings: PiSettings): boolean {
  const packages = Array.isArray(settings.packages) ? settings.packages : []
  for (const entry of packages) {
    const source = typeof entry === 'string' ? entry : entry?.source
    if (typeof source !== 'string') continue
    if (typeof entry === 'object' && !adapterExtensionEnabled(entry.extensions)) continue
    if (/^(?:npm:)?(?:@[^/]+\/)?pi-mcp-adapter(?:@[^/]+)?$/.test(source.trim()) || isAdapterPath(source)) return true
  }
  const extensions = Array.isArray(settings.extensions) ? settings.extensions : []
  return extensions.some(entry => typeof entry === 'string' && !entry.startsWith('-')
    && isAdapterPath(entry.replace(/^\+/, ''))
    && !extensions.includes(`-${entry.replace(/^\+/, '')}`))
}
