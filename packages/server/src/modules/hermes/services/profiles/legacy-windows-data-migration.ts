import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { detectHermesRootHome } from '../runtime/path'

export const LEGACY_WINDOWS_DATA_MIGRATION_MARKER = '.studio-windows-appdata-migration.json'
const MIGRATABLE_DATA_FILES = new Set([
  '.anthropic_oauth.json',
  '.cursorrules',
  '.env',
  'AGENTS.md',
  'CLAUDE.md',
  'MEMORY.md',
  'SOUL.md',
  'USER.md',
  'active_profile',
  'auth.json',
  'channel_directory.json',
  'config.yaml',
  'state.db',
  'system_prompt.md',
  'todo.json',
])
const MIGRATABLE_DATA_DIRECTORIES = new Set(['knowledge', 'memories', 'preferences', 'profiles', 'shared', 'skills'])

type MigrationAction = 'migrate' | 'decline'
type MigrationState = 'completed' | 'failed' | 'pending'

export interface LegacyWindowsDataMigrationDecision {
  schema: 1
  action: MigrationAction
  state: MigrationState
  sourceDirectory: string
  targetDirectory: string
  decidedAt: string
  completedAt?: string
  failedAt?: string
  error?: string
}

export interface LegacyWindowsDataMigrationStatus {
  supported: boolean
  shouldPrompt: boolean
  sourceDirectory: string
  targetDirectory: string
  markerPath: string
  decision: LegacyWindowsDataMigrationDecision | null
}

interface MigrationEnvironment {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  userHome: string
  hermesHome: string
  now: () => Date
}

export interface LegacyWindowsDataMigrationOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  userHome?: string
  hermesHome?: string
  now?: () => Date
}

function migrationEnvironment(overrides: LegacyWindowsDataMigrationOptions = {}): MigrationEnvironment {
  const env = overrides.env || process.env
  const platform = overrides.platform || process.platform
  const userHome = overrides.userHome || (platform === 'win32' ? env.USERPROFILE?.trim() || homedir() : homedir())
  return {
    platform,
    env,
    userHome: resolve(userHome),
    hermesHome: resolve(overrides.hermesHome || detectHermesRootHome()),
    now: overrides.now || (() => new Date()),
  }
}

function sameWindowsPath(left: string, right: string): boolean {
  return resolve(left).toLocaleLowerCase('en-US') === resolve(right).toLocaleLowerCase('en-US')
}

async function directoryHasData(directory: string): Promise<boolean> {
  try {
    if (!(await lstat(directory)).isDirectory()) return false
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isFile() && MIGRATABLE_DATA_FILES.has(entry.name)) return true
      if (entry.isDirectory() && MIGRATABLE_DATA_DIRECTORIES.has(entry.name)) return true
    }
    return false
  } catch {
    return false
  }
}

async function existingLegacyDirectory(environment: MigrationEnvironment, targetDirectory: string): Promise<string> {
  const candidates = [environment.env.LOCALAPPDATA, environment.env.APPDATA]
    .map(value => value?.trim())
    .filter((value): value is string => Boolean(value))
    .map(value => resolve(value, 'hermes'))

  const visited = new Set<string>()
  for (const candidate of candidates) {
    const key = candidate.toLocaleLowerCase('en-US')
    if (visited.has(key) || sameWindowsPath(candidate, targetDirectory)) continue
    visited.add(key)
    if (await directoryHasData(candidate)) return candidate
  }
  return ''
}

async function readMarker(markerPath: string): Promise<LegacyWindowsDataMigrationDecision | null> {
  try {
    return JSON.parse(await readFile(markerPath, 'utf8')) as LegacyWindowsDataMigrationDecision
  } catch {
    return null
  }
}

async function markerExists(markerPath: string): Promise<boolean> {
  try {
    await lstat(markerPath)
    return true
  } catch {
    return false
  }
}

async function writeMarker(markerPath: string, marker: LegacyWindowsDataMigrationDecision): Promise<void> {
  await mkdir(dirname(markerPath), { recursive: true })
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
}

export async function getLegacyWindowsDataMigrationStatus(
  overrides: LegacyWindowsDataMigrationOptions = {},
): Promise<LegacyWindowsDataMigrationStatus> {
  const environment = migrationEnvironment(overrides)
  const targetDirectory = resolve(environment.userHome, '.hermes')
  const markerPath = join(targetDirectory, LEGACY_WINDOWS_DATA_MIGRATION_MARKER)
  const supported = environment.platform === 'win32' && sameWindowsPath(environment.hermesHome, targetDirectory)
  const hasMarker = supported && await markerExists(markerPath)
  const sourceDirectory = supported && !hasMarker
    ? await existingLegacyDirectory(environment, targetDirectory)
    : ''

  return {
    supported,
    shouldPrompt: supported && !hasMarker && Boolean(sourceDirectory),
    sourceDirectory,
    targetDirectory,
    markerPath,
    decision: hasMarker ? await readMarker(markerPath) : null,
  }
}

export async function decideLegacyWindowsDataMigration(
  action: MigrationAction,
  overrides: LegacyWindowsDataMigrationOptions = {},
): Promise<LegacyWindowsDataMigrationStatus> {
  if (action !== 'migrate' && action !== 'decline') throw new Error('Unsupported legacy data migration action')

  const environment = migrationEnvironment(overrides)
  const status = await getLegacyWindowsDataMigrationStatus(overrides)
  if (!status.supported) throw new Error('Legacy Windows Hermes data migration is not available for the current data directory')
  if (!status.shouldPrompt) return status

  const decidedAt = environment.now().toISOString()
  const marker: LegacyWindowsDataMigrationDecision = {
    schema: 1,
    action,
    state: action === 'decline' ? 'completed' : 'pending',
    sourceDirectory: status.sourceDirectory,
    targetDirectory: status.targetDirectory,
    decidedAt,
    ...(action === 'decline' ? { completedAt: decidedAt } : {}),
  }
  // Accepted migrations are completed by the Windows desktop main process on
  // the next launch, before the Web UI server and Hermes gateway can lock data.
  await writeMarker(status.markerPath, marker)
  return getLegacyWindowsDataMigrationStatus(overrides)
}
