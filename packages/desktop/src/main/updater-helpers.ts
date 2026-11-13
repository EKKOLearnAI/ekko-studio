import { join } from 'node:path'

export function isWindowsUpdaterLockError(err: unknown): boolean {
  const message = String((err as { message?: unknown } | null)?.message || err || '')
  return /failed to uninstall old application files/i.test(message)
    || /\bquitandinstall\b/i.test(message) && /\b(?:code|errno)?\s*:?\s*2\b/i.test(message)
    || /\bsquirrel\b/i.test(message) && /\b(?:code|errno)?\s*:?\s*2\b/i.test(message)
}

function updateCacheNames(appName: string): string[] {
  const names = new Set<string>()
  const trimmed = appName.trim()
  if (trimmed) {
    names.add(`${trimmed}-updater`)
    const kebab = trimmed
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
    if (kebab) names.add(`${kebab}-updater`)
  }
  names.add('hermes-studio-updater')
  names.add('Hermes Studio-updater')
  names.add('ekko-studio-updater')
  names.add('Ekko Studio-updater')
  return [...names]
}

export function pendingUpdateDirectories(options: {
  appDataPath?: string | null
  localAppData?: string | null
  appName?: string | null
}): string[] {
  const bases = new Set<string>()
  const appDataPath = options.appDataPath?.trim()
  const localAppData = options.localAppData?.trim()
  if (localAppData) bases.add(localAppData)
  if (appDataPath) bases.add(appDataPath)
  if (!bases.size) return []
  return [...bases].flatMap(base => updateCacheNames(options.appName || 'Ekko Studio')
    .map(name => join(base, name, 'pending')))
}
