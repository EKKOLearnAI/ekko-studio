import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { hermesHome as resolveHermesHome } from './paths'

export const LEGACY_WINDOWS_DATA_MIGRATION_MARKER = '.studio-windows-appdata-migration.json'
export const LEGACY_WINDOWS_DATA_MIGRATION_STAGING = '.hermes.studio-windows-appdata-migration-staging'
export const LEGACY_WINDOWS_DATA_MIGRATION_BACKUP = '.hermes.studio-windows-appdata-migration-backup'
const GATEWAY_RUNTIME_FILES = new Set(['gateway.pid', 'gateway.lock', 'gateway_state.json'])
const LEGACY_PROFILE_FILES = new Set([
  '.cursorrules',
  '.env',
  'AGENTS.md',
  'CLAUDE.md',
  'MEMORY.md',
  'SOUL.md',
  'USER.md',
  '.anthropic_oauth.json',
  'auth.json',
  'channel_directory.json',
  'config.yaml',
  'system_prompt.md',
  'todo.json',
])
const LEGACY_PROFILE_DIRECTORIES = new Set(['knowledge', 'memories', 'preferences', 'skills'])
const LEGACY_ROOT_FILES = new Set([...LEGACY_PROFILE_FILES, 'active_profile'])
const LEGACY_SHARED_FILES = new Set(['nous_auth.json'])
const VERIFIED_CONFIGURATION_FILES = new Set([...LEGACY_ROOT_FILES, ...LEGACY_SHARED_FILES])
const STATE_DATABASE_FILES = ['state.db', 'state.db-wal', 'state.db-shm', 'state.db-journal'] as const
const STATE_DATABASE_STAGING = '.studio-windows-appdata-state-db-staging'
const STATE_DATABASE_BACKUP = '.studio-windows-appdata-state-db-backup'
const STATE_DATABASE_TRANSACTION = 'transaction.json'

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
  copiedFiles?: number
  skippedSymlinks?: string[]
}

export interface PendingLegacyWindowsDataMigrationResult {
  supported: boolean
  attempted: boolean
  completed: boolean
  retryPending: boolean
  error?: string
}

interface MigrationFileSystem {
  copyFilePath: (source: string, target: string) => Promise<void>
  isProcessAlive: (pid: number) => boolean
  renamePath: (source: string, target: string) => Promise<void>
}

export interface PendingLegacyWindowsDataMigrationOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  userHome?: string
  hermesHome?: string
  now?: () => Date
  copyFilePath?: (source: string, target: string) => Promise<void>
  isProcessAlive?: (pid: number) => boolean
  renamePath?: (source: string, target: string) => Promise<void>
}

interface MigrationEnvironment {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  userHome: string
  hermesHome: string
  now: () => Date
  fs: MigrationFileSystem
}

interface MigrationPaths {
  target: string
  marker: string
  staging: string
  backup: string
}

function environment(options: PendingLegacyWindowsDataMigrationOptions): MigrationEnvironment {
  const env = options.env || process.env
  const platform = options.platform || process.platform
  const userHome = resolve(options.userHome || (platform === 'win32' ? env.USERPROFILE?.trim() || homedir() : homedir()))
  return {
    platform,
    env,
    userHome,
    hermesHome: resolve(options.hermesHome || resolveHermesHome()),
    now: options.now || (() => new Date()),
    fs: {
      copyFilePath: options.copyFilePath || copyFile,
      isProcessAlive: options.isProcessAlive || defaultIsProcessAlive,
      renamePath: options.renamePath || rename,
    },
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function migrationPaths(userHome: string): MigrationPaths {
  const target = resolve(userHome, '.hermes')
  return {
    target,
    marker: join(target, LEGACY_WINDOWS_DATA_MIGRATION_MARKER),
    staging: resolve(userHome, LEGACY_WINDOWS_DATA_MIGRATION_STAGING),
    backup: resolve(userHome, LEGACY_WINDOWS_DATA_MIGRATION_BACKUP),
  }
}

function sameWindowsPath(left: string, right: string): boolean {
  return resolve(left).toLocaleLowerCase('en-US') === resolve(right).toLocaleLowerCase('en-US')
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory()
  } catch {
    return false
  }
}

function isMigrationDecision(value: unknown): value is LegacyWindowsDataMigrationDecision {
  if (!value || typeof value !== 'object') return false
  const decision = value as Partial<LegacyWindowsDataMigrationDecision>
  return decision.schema === 1
    && (decision.action === 'migrate' || decision.action === 'decline')
    && (decision.state === 'completed' || decision.state === 'failed' || decision.state === 'pending')
    && typeof decision.sourceDirectory === 'string'
    && typeof decision.targetDirectory === 'string'
    && typeof decision.decidedAt === 'string'
}

async function readMarker(markerPath: string): Promise<LegacyWindowsDataMigrationDecision | null> {
  try {
    const value = JSON.parse(await readFile(markerPath, 'utf8')) as unknown
    return isMigrationDecision(value) ? value : null
  } catch {
    return null
  }
}

async function writeMarker(markerPath: string, marker: LegacyWindowsDataMigrationDecision): Promise<void> {
  await mkdir(dirname(markerPath), { recursive: true })
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
}

function allowedLegacySources(env: NodeJS.ProcessEnv): string[] {
  return [env.LOCALAPPDATA, env.APPDATA]
    .map(value => value?.trim())
    .filter((value): value is string => Boolean(value))
    .map(value => resolve(value, 'hermes'))
}

function validateAcceptedMarker(
  marker: LegacyWindowsDataMigrationDecision,
  env: MigrationEnvironment,
  paths: MigrationPaths,
): void {
  if (marker.action !== 'migrate' || (marker.state !== 'pending' && marker.state !== 'failed')) {
    throw new Error('Legacy Windows data migration is not pending')
  }
  if (!sameWindowsPath(marker.targetDirectory, paths.target)) {
    throw new Error('Legacy Windows data migration target no longer matches the active Hermes directory')
  }
  if (!allowedLegacySources(env.env).some(candidate => sameWindowsPath(candidate, marker.sourceDirectory))) {
    throw new Error('Legacy Windows data migration source is not an AppData Hermes directory')
  }
}

interface CopySummary {
  copiedFiles: Array<{ source: string; target: string }>
  skippedSymlinks: string[]
}

interface StateDatabaseTransaction {
  schema: 1
  phase: 'staged' | 'activating'
  sourceDirectory: string
  targetDirectory: string
  sourceFiles: string[]
  originalFiles: string[]
}

function isStateDatabaseTransaction(value: unknown): value is StateDatabaseTransaction {
  if (!value || typeof value !== 'object') return false
  const transaction = value as Partial<StateDatabaseTransaction>
  return transaction.schema === 1
    && (transaction.phase === 'staged' || transaction.phase === 'activating')
    && typeof transaction.sourceDirectory === 'string'
    && typeof transaction.targetDirectory === 'string'
    && Array.isArray(transaction.sourceFiles)
    && transaction.sourceFiles.every(name => STATE_DATABASE_FILES.includes(name as typeof STATE_DATABASE_FILES[number]))
    && Array.isArray(transaction.originalFiles)
    && transaction.originalFiles.every(name => STATE_DATABASE_FILES.includes(name as typeof STATE_DATABASE_FILES[number]))
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

async function readStateDatabaseTransaction(directory: string): Promise<StateDatabaseTransaction | null> {
  try {
    const value = JSON.parse(await readFile(join(directory, STATE_DATABASE_TRANSACTION), 'utf8')) as unknown
    return isStateDatabaseTransaction(value) ? value : null
  } catch {
    return null
  }
}

async function writeStateDatabaseTransaction(
  directory: string,
  transaction: StateDatabaseTransaction,
): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, STATE_DATABASE_TRANSACTION), `${JSON.stringify(transaction, null, 2)}\n`, 'utf8')
}

async function recoverStateDatabaseTransaction(targetDirectory: string, fs: MigrationFileSystem): Promise<void> {
  const staging = join(targetDirectory, STATE_DATABASE_STAGING)
  const backup = join(targetDirectory, STATE_DATABASE_BACKUP)
  const stagingExists = await isDirectory(staging)
  const backupExists = await isDirectory(backup)
  if (!stagingExists && !backupExists) return

  const transaction = await readStateDatabaseTransaction(backup)
    || await readStateDatabaseTransaction(staging)
  if (!transaction || !sameWindowsPath(transaction.targetDirectory, targetDirectory)) {
    throw new Error(`Refusing to recover unrecognized Hermes state database migration in: ${targetDirectory}`)
  }

  if (transaction.phase === 'activating') {
    for (const name of STATE_DATABASE_FILES) {
      await rm(join(targetDirectory, name), { force: true })
    }
    for (const name of transaction.originalFiles) {
      const backupFile = join(backup, name)
      if (await isFile(backupFile)) await fs.copyFilePath(backupFile, join(targetDirectory, name))
    }
  }

  await rm(staging, { recursive: true, force: true })
  await rm(backup, { recursive: true, force: true })
}

async function copyStateDatabase(
  sourceDirectory: string,
  targetDirectory: string,
  fs: MigrationFileSystem,
  summary: CopySummary,
): Promise<void> {
  if (!(await isFile(join(sourceDirectory, 'state.db')))) return
  await mkdir(targetDirectory, { recursive: true })
  await recoverStateDatabaseTransaction(targetDirectory, fs)

  const sourceFiles: string[] = []
  const originalFiles: string[] = []
  for (const name of STATE_DATABASE_FILES) {
    if (await isFile(join(sourceDirectory, name))) sourceFiles.push(name)
    if (await isFile(join(targetDirectory, name))) originalFiles.push(name)
  }

  const staging = join(targetDirectory, STATE_DATABASE_STAGING)
  const backup = join(targetDirectory, STATE_DATABASE_BACKUP)
  const staged: StateDatabaseTransaction = {
    schema: 1,
    phase: 'staged',
    sourceDirectory,
    targetDirectory,
    sourceFiles,
    originalFiles,
  }

  await writeStateDatabaseTransaction(staging, staged)
  await writeStateDatabaseTransaction(backup, staged)
  try {
    for (const name of sourceFiles) {
      await fs.copyFilePath(join(sourceDirectory, name), join(staging, name))
    }
    for (const name of originalFiles) {
      await fs.copyFilePath(join(targetDirectory, name), join(backup, name))
    }

    const activating: StateDatabaseTransaction = { ...staged, phase: 'activating' }
    await writeStateDatabaseTransaction(staging, activating)
    await writeStateDatabaseTransaction(backup, activating)

    for (const name of STATE_DATABASE_FILES) {
      if (!sourceFiles.includes(name)) await rm(join(targetDirectory, name), { force: true })
    }
    for (const name of sourceFiles) {
      await fs.copyFilePath(join(staging, name), join(targetDirectory, name))
      const [sourceStat, targetStat] = await Promise.all([
        stat(join(sourceDirectory, name)),
        stat(join(targetDirectory, name)),
      ])
      if (sourceStat.size !== targetStat.size) {
        throw new Error(`Legacy Windows Hermes state database verification failed: ${join(targetDirectory, name)}`)
      }
      summary.copiedFiles.push({
        source: join(sourceDirectory, name),
        target: join(targetDirectory, name),
      })
    }
  } catch (error) {
    await recoverStateDatabaseTransaction(targetDirectory, fs).catch(() => undefined)
    throw error
  }

  await rm(staging, { recursive: true, force: true })
  await rm(backup, { recursive: true, force: true })
}

async function copyEntry(
  source: string,
  target: string,
  sourceRoot: string,
  fs: MigrationFileSystem,
  summary: CopySummary,
): Promise<void> {
  const sourceStat = await lstat(source)
  if (sourceStat.isSymbolicLink()) {
    // Directory links in old packaged runtimes require Windows Developer Mode
    // to recreate. Runtime directories are not selected for migration, and a
    // user-data directory link should not make config/auth migration fail.
    try {
      if ((await stat(source)).isFile()) {
        await mkdir(dirname(target), { recursive: true })
        await fs.copyFilePath(source, target)
        summary.copiedFiles.push({ source, target })
        return
      }
    } catch { }
    summary.skippedSymlinks.push(relative(sourceRoot, source).replace(/\\/g, '/'))
    return
  }

  if (sourceStat.isDirectory()) {
    try {
      const targetStat = await lstat(target)
      if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
        await rm(target, { recursive: true, force: true })
      }
    } catch { }
    await mkdir(target, { recursive: true })
    for (const entry of await readdir(source)) {
      if (GATEWAY_RUNTIME_FILES.has(entry)) continue
      await copyEntry(join(source, entry), join(target, entry), sourceRoot, fs, summary)
    }
    return
  }

  await mkdir(dirname(target), { recursive: true })
  await fs.copyFilePath(source, target)
  summary.copiedFiles.push({ source, target })
}

async function copySelectedProfileData(
  source: string,
  target: string,
  sourceRoot: string,
  fs: MigrationFileSystem,
  summary: CopySummary,
): Promise<void> {
  if (!(await isDirectory(source))) return
  for (const entry of await readdir(source)) {
    if (!LEGACY_PROFILE_FILES.has(entry) && !LEGACY_PROFILE_DIRECTORIES.has(entry)) continue
    await copyEntry(join(source, entry), join(target, entry), sourceRoot, fs, summary)
  }
  await copyStateDatabase(source, target, fs, summary)
}

async function copySelectedFiles(
  source: string,
  target: string,
  sourceRoot: string,
  names: Set<string>,
  fs: MigrationFileSystem,
  summary: CopySummary,
): Promise<void> {
  if (!(await isDirectory(source))) return
  for (const entry of await readdir(source)) {
    if (!names.has(entry)) continue
    await copyEntry(join(source, entry), join(target, entry), sourceRoot, fs, summary)
  }
}

async function copyLegacyUserData(
  source: string,
  target: string,
  fs: MigrationFileSystem,
): Promise<CopySummary> {
  const summary: CopySummary = { copiedFiles: [], skippedSymlinks: [] }
  await mkdir(target, { recursive: true })

  for (const entry of await readdir(source)) {
    if (!LEGACY_ROOT_FILES.has(entry) && !LEGACY_PROFILE_DIRECTORIES.has(entry)) continue
    await copyEntry(join(source, entry), join(target, entry), source, fs, summary)
  }
  await copyStateDatabase(source, target, fs, summary)

  const profilesSource = join(source, 'profiles')
  if (await isDirectory(profilesSource)) {
    for (const profile of await readdir(profilesSource, { withFileTypes: true })) {
      if (!profile.isDirectory() || profile.isSymbolicLink()) continue
      await copySelectedProfileData(
        join(profilesSource, profile.name),
        join(target, 'profiles', profile.name),
        source,
        fs,
        summary,
      )
    }
  }
  await copySelectedFiles(join(source, 'shared'), join(target, 'shared'), source, LEGACY_SHARED_FILES, fs, summary)
  return summary
}

async function verifyCopiedConfiguration(summary: CopySummary): Promise<void> {
  for (const copied of summary.copiedFiles) {
    if (!VERIFIED_CONFIGURATION_FILES.has(basename(copied.source))) continue
    const [sourceValue, targetValue] = await Promise.all([
      readFile(copied.source),
      readFile(copied.target),
    ])
    if (!sourceValue.equals(targetValue)) {
      throw new Error(`Legacy Windows Hermes configuration verification failed: ${copied.target}`)
    }
  }
}

async function gatewayRuntimeDirectories(root: string): Promise<string[]> {
  const directories = [root]
  try {
    for (const entry of await readdir(join(root, 'profiles'), { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(join(root, 'profiles', entry.name))
    }
  } catch { }
  return directories
}

async function readRuntimePid(path: string, fileName: string): Promise<number | null> {
  try {
    const data = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown; gateway_state?: unknown }
    if (fileName === 'gateway_state.json') {
      const state = String(data.gateway_state || '').toLowerCase()
      if (state && state !== 'running' && state !== 'starting') return null
    }
    const pid = typeof data.pid === 'number' ? data.pid : Number.parseInt(String(data.pid || ''), 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

async function activeGatewayPids(root: string, isProcessAlive: (pid: number) => boolean): Promise<number[]> {
  const pids = new Set<number>()
  for (const directory of await gatewayRuntimeDirectories(root)) {
    for (const fileName of GATEWAY_RUNTIME_FILES) {
      const pid = await readRuntimePid(join(directory, fileName), fileName)
      if (pid && isProcessAlive(pid)) pids.add(pid)
    }
  }
  return [...pids]
}

async function removeOwnedWorkingDirectory(directory: string, paths: MigrationPaths): Promise<void> {
  if (!(await isDirectory(directory))) return
  const marker = await readMarker(join(directory, LEGACY_WINDOWS_DATA_MIGRATION_MARKER))
  if (!marker || marker.action !== 'migrate' || !sameWindowsPath(marker.targetDirectory, paths.target)) {
    throw new Error(`Refusing to remove unrecognized migration directory: ${directory}`)
  }
  await rm(directory, { recursive: true, force: true })
}

async function recoverInterruptedSwap(env: MigrationEnvironment, paths: MigrationPaths): Promise<boolean> {
  let completedRecovery = false
  let targetExists = await isDirectory(paths.target)
  const stagingExists = await isDirectory(paths.staging)
  let backupExists = await isDirectory(paths.backup)

  if (!targetExists && stagingExists) {
    const stagedMarker = await readMarker(join(paths.staging, LEGACY_WINDOWS_DATA_MIGRATION_MARKER))
    if (stagedMarker?.action === 'migrate'
      && stagedMarker.state === 'completed'
      && sameWindowsPath(stagedMarker.targetDirectory, paths.target)) {
      await env.fs.renamePath(paths.staging, paths.target)
      targetExists = true
      completedRecovery = true
      if (backupExists) {
        await removeOwnedWorkingDirectory(paths.backup, paths)
        backupExists = false
      }
    }
  }

  if (!targetExists && backupExists) {
    await env.fs.renamePath(paths.backup, paths.target)
    targetExists = true
    backupExists = false
  }

  if (targetExists && backupExists) {
    const targetMarker = await readMarker(paths.marker)
    if (targetMarker?.action === 'migrate' && targetMarker.state === 'completed') {
      await removeOwnedWorkingDirectory(paths.backup, paths)
      backupExists = false
      completedRecovery = true
    } else {
      throw new Error(`Legacy Windows data migration backup requires manual recovery: ${paths.backup}`)
    }
  }

  if (targetExists && await isDirectory(paths.staging)) {
    await removeOwnedWorkingDirectory(paths.staging, paths)
  }
  return completedRecovery
}

function completedMarker(
  marker: LegacyWindowsDataMigrationDecision,
  now: Date,
  summary: CopySummary,
): LegacyWindowsDataMigrationDecision {
  return {
    ...marker,
    state: 'completed',
    completedAt: now.toISOString(),
    failedAt: undefined,
    error: undefined,
    copiedFiles: summary.copiedFiles.length,
    skippedSymlinks: summary.skippedSymlinks,
  }
}

function failedMarker(marker: LegacyWindowsDataMigrationDecision, now: Date, error: unknown): LegacyWindowsDataMigrationDecision {
  return {
    ...marker,
    state: 'failed',
    completedAt: undefined,
    failedAt: now.toISOString(),
    error: error instanceof Error ? error.message : String(error),
  }
}

/**
 * Complete an accepted AppData migration before Desktop starts the Web UI
 * server or Hermes gateway. A failed attempt keeps the accepted marker and is
 * retried on the next launch without asking the user again.
 */
export async function migratePendingLegacyWindowsData(
  options: PendingLegacyWindowsDataMigrationOptions = {},
): Promise<PendingLegacyWindowsDataMigrationResult> {
  const env = environment(options)
  const paths = migrationPaths(env.userHome)
  const supported = env.platform === 'win32' && sameWindowsPath(env.hermesHome, paths.target)
  if (!supported) return { supported: false, attempted: false, completed: false, retryPending: false }

  let completedRecovery = false
  try {
    completedRecovery = await recoverInterruptedSwap(env, paths)
  } catch (error) {
    return {
      supported: true,
      attempted: true,
      completed: false,
      retryPending: true,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const marker = await readMarker(paths.marker)
  if (!marker || marker.action !== 'migrate' || marker.state === 'completed') {
    return {
      supported: true,
      attempted: completedRecovery,
      completed: completedRecovery,
      retryPending: false,
    }
  }

  try {
    validateAcceptedMarker(marker, env, paths)
    if (!(await isDirectory(marker.sourceDirectory))) {
      throw new Error(`Legacy Windows Hermes data directory is unavailable: ${marker.sourceDirectory}`)
    }
    const sourceGatewayPids = await activeGatewayPids(marker.sourceDirectory, env.fs.isProcessAlive)
    if (sourceGatewayPids.length > 0) {
      throw new Error(`Legacy Windows Hermes gateway is still using the source directory (PID: ${sourceGatewayPids.join(', ')})`)
    }

    const summary = await copyLegacyUserData(marker.sourceDirectory, paths.target, env.fs)
    if (summary.copiedFiles.length === 0) {
      throw new Error(`Legacy Windows Hermes data directory contains no migratable user data: ${marker.sourceDirectory}`)
    }
    await verifyCopiedConfiguration(summary)
    await writeMarker(paths.marker, completedMarker(marker, env.now(), summary))

    return { supported: true, attempted: true, completed: true, retryPending: false }
  } catch (error) {
    if (await isDirectory(paths.target)) {
      try {
        await writeMarker(paths.marker, failedMarker(marker, env.now(), error))
      } catch { }
      if (await isDirectory(paths.staging)) {
        try { await removeOwnedWorkingDirectory(paths.staging, paths) } catch { }
      }
    }

    return {
      supported: true,
      attempted: true,
      completed: false,
      retryPending: true,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
