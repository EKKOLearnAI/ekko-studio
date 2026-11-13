import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  EKKO_CONFIG_DIRECTORY_NAME,
  EKKO_CONFIG_FILE_NAME,
  serializeDefaultEkkoConfig,
} from './config'

const BUILTIN_SKILL_MANIFEST_FILENAME = '.ekko-builtin-skills.json'
const BUILTIN_SKILL_MANIFEST_OWNER = 'ekko-agent'
const BUILTIN_SKILL_HASH_IGNORED_FILENAMES = new Set(['.DS_Store', 'Thumbs.db'])
const LEGACY_HERMES_SKILL_CLEANUP_FILENAME = '.ekko-hermes-skill-cleanup-v2.json'
const SKILL_RESET_QUARANTINE_PREFIX = '.ekko-skills-reset-'

interface BuiltinSkillManifestEntry {
  owner?: string
  sourceHash?: string
  installedHash?: string
}

type BuiltinSkillManifest = Record<string, BuiltinSkillManifestEntry>

export interface EkkoDirectoryLayout {
  baseDirectory: string
  rootDirectory: string
  databasePath: string
  configDirectory: string
  configPath: string
  skillsDirectory: string
  logsDirectory: string
  workspaceDirectory: string
}

export interface EkkoDirectoryInitializationOptions {
  /**
   * Hermes Agent's root data directory. Its presence triggers the one-time
   * reset of legacy Ekko skill directories. Hermes Skills are never imported.
   */
  hermesRootDirectory?: string
  /** Host hook used to keep Core startup alive when the optional Skill tree fails. */
  onSkillError?: (error: unknown) => void
}

export interface EkkoSkillDirectoryCheck {
  ok: boolean
  sourceDirectory?: string
  targetDirectory: string
  bundledSkillCount: number
  missing: string[]
  unreadable: string[]
  detail: string
}

/**
 * Owns Ekko Agent's filesystem layout.
 *
 * Callers provide one base directory. Ekko keeps every owned artifact under
 * `<baseDirectory>/.ekko`; without an explicit base it uses the user's home.
 */
export class EkkoDirectoryManager {
  readonly baseDirectory: string
  readonly rootDirectory: string
  readonly databasePath: string
  readonly configDirectory: string
  readonly configPath: string
  readonly skillsDirectory: string
  readonly logsDirectory: string
  readonly workspaceDirectory: string
  private builtinSkills?: EkkoBuiltinSkillSynchronizer

  constructor(baseDirectory: string = homedir()) {
    this.baseDirectory = resolve(baseDirectory || homedir())
    this.rootDirectory = join(this.baseDirectory, '.ekko')
    this.databasePath = join(this.rootDirectory, 'ekko.db')
    this.configDirectory = join(this.rootDirectory, EKKO_CONFIG_DIRECTORY_NAME)
    this.configPath = join(this.configDirectory, EKKO_CONFIG_FILE_NAME)
    this.skillsDirectory = join(this.rootDirectory, 'skills')
    this.logsDirectory = join(this.rootDirectory, 'logs')
    this.workspaceDirectory = join(this.rootDirectory, 'workspace')
  }

  initialize(options: EkkoDirectoryInitializationOptions = {}): EkkoDirectoryLayout {
    this.builtinSkills = EkkoBuiltinSkillSynchronizer.createDefault()
    this.initializeConfigDirectory()
    let skillError: unknown
    let fatalSkillError = false
    try {
      this.cleanupSkillResetQuarantines()
      if (options.hermesRootDirectory) {
        skillError = this.resetLegacySkillsDirectory(options.hermesRootDirectory)
      } else {
        mkdirSync(this.skillsDirectory, { recursive: true })
      }
    } catch (error) {
      skillError = error
      fatalSkillError = true
    }
    if (skillError && options.onSkillError) options.onSkillError(skillError)
    else if (fatalSkillError) throw skillError
    mkdirSync(this.workspaceDirectory, { recursive: true })
    return this.layout()
  }

  /**
   * Creates the global configuration boundary without overwriting an existing
   * file. Profile-specific configuration directories are intentionally not
   * created or loaded yet.
   */
  initializeConfigDirectory(): string {
    mkdirSync(this.configDirectory, { recursive: true, mode: 0o700 })
    try {
      writeFileSync(this.configPath, serializeDefaultEkkoConfig(), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
    } catch (error) {
      if (!isErrorWithCode(error, 'EEXIST')) throw error
    }
    return this.configPath
  }

  profileSkillsDirectory(profile = 'default'): string {
    const directory = this.profileSkillsPath(profile)
    mkdirSync(directory, { recursive: true })
    this.builtinSkills?.sync(directory)
    return directory
  }

  /** Pure path resolution used while Skills are degraded. It performs no I/O. */
  profileSkillsPath(profile = 'default'): string {
    return join(this.skillsDirectory, profileDirectoryName(profile))
  }

  bundledSkillsSourceDirectory(): string | undefined {
    return this.builtinSkills?.directory
  }

  synchronizeProfileSkills(profile = 'default'): string {
    return this.profileSkillsDirectory(profile)
  }

  checkProfileSkills(profile = 'default'): EkkoSkillDirectoryCheck {
    const targetDirectory = this.profileSkillsPath(profile)
    const sourceDirectory = this.builtinSkills?.directory
    if (!sourceDirectory) {
      return {
        ok: false,
        targetDirectory,
        bundledSkillCount: 0,
        missing: [],
        unreadable: [],
        detail: 'Bundled Ekko Skill source directory is unavailable.',
      }
    }
    const bundled = readdirSync(sourceDirectory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && isFile(join(sourceDirectory, entry.name, 'SKILL.md')))
      .map(entry => entry.name)
      .sort((left, right) => left.localeCompare(right))
    const missing: string[] = []
    const unreadable: string[] = []
    for (const name of bundled) {
      const skillPath = join(targetDirectory, name, 'SKILL.md')
      if (!existsSync(skillPath)) {
        missing.push(name)
        continue
      }
      try {
        readFileSync(skillPath, 'utf8')
      } catch {
        unreadable.push(name)
      }
    }
    const ok = bundled.length > 0 && isDirectory(targetDirectory) && !missing.length && !unreadable.length
    return {
      ok,
      sourceDirectory,
      targetDirectory,
      bundledSkillCount: bundled.length,
      missing,
      unreadable,
      detail: ok
        ? `All ${bundled.length} bundled Ekko Skills are readable.`
        : `Skill directory check failed: bundled=${bundled.length}, missing=${missing.length}, unreadable=${unreadable.length}.`,
    }
  }

  profileLogsDirectory(profile = 'default'): string {
    const directory = this.profileLogsPath(profile)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    return directory
  }

  profileLogsPath(profile = 'default'): string {
    return join(this.logsDirectory, profileDirectoryName(profile))
  }

  profileWorkspaceDirectory(profile = 'default'): string {
    const directory = join(this.workspaceDirectory, profileDirectoryName(profile))
    mkdirSync(directory, { recursive: true })
    return directory
  }

  sessionWorkspaceDirectory(profile: string, sessionId: string): string {
    const directory = join(
      this.workspaceDirectory,
      profileDirectoryName(profile),
      sessionDirectoryName(sessionId),
    )
    mkdirSync(directory, { recursive: true })
    return directory
  }

  /** Discover persisted profiles from every profile-owned directory root. */
  profileNames(): string[] {
    const profiles = new Set<string>()
    for (const root of [this.skillsDirectory, this.logsDirectory, this.workspaceDirectory]) {
      let entries
      try {
        entries = readdirSync(root, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        try {
          profiles.add(profileDirectoryName(entry.name))
        } catch {
          // Ignore filesystem entries that cannot represent an Ekko profile.
        }
      }
    }
    return [...profiles].sort((left, right) => left.localeCompare(right))
  }

  layout(): EkkoDirectoryLayout {
    return {
      baseDirectory: this.baseDirectory,
      rootDirectory: this.rootDirectory,
      databasePath: this.databasePath,
      configDirectory: this.configDirectory,
      configPath: this.configPath,
      skillsDirectory: this.skillsDirectory,
      logsDirectory: this.logsDirectory,
      workspaceDirectory: this.workspaceDirectory,
    }
  }

  private resetLegacySkillsDirectory(hermesRootDirectory: string): unknown | undefined {
    const cleanupPath = join(this.rootDirectory, LEGACY_HERMES_SKILL_CLEANUP_FILENAME)
    if (existsSync(cleanupPath)) {
      mkdirSync(this.skillsDirectory, { recursive: true })
      return undefined
    }

    if (!this.builtinSkills) {
      throw new Error('Bundled Ekko Skills are unavailable; refusing to reset the existing Skill directory')
    }
    const profiles = new Set(['default', ...this.profileNames()])
    const deferredError = this.quarantineSkillsDirectoryForReset()
    if (deferredError) {
      // A Windows process can temporarily deny both deletion and rename. Keep
      // Ekko available for this run and retry the full reset next startup; no
      // migration marker is written until the old directory is detached.
      for (const profile of profiles) this.profileSkillsDirectory(profile)
      return deferredError
    }

    mkdirSync(this.skillsDirectory, { recursive: true })
    for (const profile of profiles) this.profileSkillsDirectory(profile)
    const marker = `${JSON.stringify({
      version: 2,
      hermesRootDirectory: resolve(hermesRootDirectory),
      resetSkillsDirectory: true,
    }, null, 2)}\n`
    const temporaryCleanupPath = `${cleanupPath}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporaryCleanupPath, marker, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporaryCleanupPath, cleanupPath)
    } catch (error) {
      try {
        rmSync(temporaryCleanupPath, { force: true })
      } catch {
        // Preserve the marker write failure that caused the cleanup attempt.
      }
      // The marker is only an optimization that prevents repeating this safe,
      // idempotent migration. Failure to persist it must not make Ekko
      // unavailable when its config/database directories remain usable.
      console.warn(
        `[ekko-agent] failed to persist legacy Skill migration marker at ${cleanupPath}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return undefined
  }

  /**
   * Atomically removes the complete active Skills tree before recreating it.
   * Deleting the detached tree is best-effort because Windows scanners can
   * keep individual files open even after the active path has been reset.
   */
  private quarantineSkillsDirectoryForReset(): unknown | undefined {
    if (!existsSync(this.skillsDirectory)) return undefined
    const quarantineDirectory = join(
      this.rootDirectory,
      `${SKILL_RESET_QUARANTINE_PREFIX}${randomUUID()}`,
    )
    try {
      renameSync(this.skillsDirectory, quarantineDirectory)
    } catch (error) {
      if (!isTransientWindowsFilesystemError(error)) throw error
      console.warn(
        `[ekko-agent] Skill reset was deferred because Windows denied access to ${this.skillsDirectory}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      )
      return error
    }

    this.removeSkillResetQuarantine(quarantineDirectory)
    return undefined
  }

  private cleanupSkillResetQuarantines(): void {
    let entries
    try {
      entries = readdirSync(this.rootDirectory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(SKILL_RESET_QUARANTINE_PREFIX)) continue
      this.removeSkillResetQuarantine(join(this.rootDirectory, entry.name))
    }
  }

  private removeSkillResetQuarantine(directory: string): void {
    try {
      rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      })
    } catch (error) {
      console.warn(
        `[ekko-agent] detached legacy Skill directory will be cleaned on a later startup (${directory}): ` +
        `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

function profileDirectoryName(value: string): string {
  const profile = String(value || '').trim() || 'default'
  return safeDirectoryName(profile, 'profile')
}

function sessionDirectoryName(value: string): string {
  const sessionId = String(value || '').trim()
  if (!sessionId) throw new Error('Ekko session directory name is required')
  return safeDirectoryName(sessionId, 'session')
}

function safeDirectoryName(value: string, kind: 'profile' | 'session'): string {
  if (
    value === '.' ||
    value === '..' ||
    /[<>:"/\\|?*\u0000-\u001f]/u.test(value)
  ) {
    throw new Error(`Invalid Ekko ${kind} directory name: ${value}`)
  }
  return value
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

class EkkoBuiltinSkillSynchronizer {
  private constructor(private readonly sourceDirectory: string) {}

  get directory(): string {
    return this.sourceDirectory
  }

  static createDefault(): EkkoBuiltinSkillSynchronizer | undefined {
    const override = process.env.EKKO_BUILTIN_SKILLS_DIR?.trim()
    const sourceDirectory = override
      ? resolve(override)
      : [
          // Production server bundle: dist/server/index.js with dist/ekko-skills.
          resolve(__dirname, '../ekko-skills'),
          // Ekko package source/build: src or dist with package/skills.
          resolve(__dirname, '../skills'),
          resolve(process.cwd(), 'packages/ekko-agent/skills'),
        ].find(isDirectory)
    return sourceDirectory ? new EkkoBuiltinSkillSynchronizer(sourceDirectory) : undefined
  }

  sync(targetDirectory: string): void {
    if (!isDirectory(this.sourceDirectory)) return
    const target = resolve(targetDirectory)
    mkdirSync(target, { recursive: true })
    const manifest = readBuiltinSkillManifest(target)
    let manifestChanged = false

    for (const entry of readdirSync(this.sourceDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith('.') ||
        !isFile(join(this.sourceDirectory, entry.name, 'SKILL.md'))
      ) continue

      const sourceSkillDirectory = join(this.sourceDirectory, entry.name)
      const targetSkillDirectory = join(target, entry.name)
      const sourceHash = hashBuiltinSkillDirectory(sourceSkillDirectory)

      if (!existsSync(targetSkillDirectory)) {
        const installedHash = installBuiltinSkill(sourceSkillDirectory, targetSkillDirectory)
        manifest[entry.name] = {
          owner: BUILTIN_SKILL_MANIFEST_OWNER,
          sourceHash,
          installedHash,
        }
        manifestChanged = true
        continue
      }

      if (!isPlainDirectory(targetSkillDirectory)) continue
      const currentHash = hashBuiltinSkillDirectory(targetSkillDirectory)
      const manifestEntry = manifest[entry.name]
      const isUnchangedManagedCopy = manifestEntry?.owner === BUILTIN_SKILL_MANIFEST_OWNER &&
        manifestEntry.installedHash === currentHash
      const isIdenticalUnmanagedCopy = !manifestEntry && currentHash === sourceHash

      if (isUnchangedManagedCopy && manifestEntry.sourceHash !== sourceHash) {
        const installedHash = installBuiltinSkill(sourceSkillDirectory, targetSkillDirectory)
        manifest[entry.name] = {
          owner: BUILTIN_SKILL_MANIFEST_OWNER,
          sourceHash,
          installedHash,
        }
        manifestChanged = true
      } else if (isIdenticalUnmanagedCopy) {
        manifest[entry.name] = {
          owner: BUILTIN_SKILL_MANIFEST_OWNER,
          sourceHash,
          installedHash: currentHash,
        }
        manifestChanged = true
      }
    }

    if (manifestChanged) writeBuiltinSkillManifest(target, manifest)
  }
}

function installBuiltinSkill(sourceDirectory: string, targetDirectory: string): string {
  const parentDirectory = resolve(targetDirectory, '..')
  const name = basename(targetDirectory)
  const stagingDirectory = join(parentDirectory, `.${name}.${randomUUID()}.tmp`)
  const previousDirectory = join(parentDirectory, `.${name}.${randomUUID()}.previous`)

  try {
    cpSync(sourceDirectory, stagingDirectory, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    })
  } catch (error) {
    rmSync(stagingDirectory, { recursive: true, force: true })
    throw error
  }

  if (!existsSync(targetDirectory)) {
    renameSync(stagingDirectory, targetDirectory)
    return hashBuiltinSkillDirectory(targetDirectory)
  }

  renameSync(targetDirectory, previousDirectory)
  try {
    renameSync(stagingDirectory, targetDirectory)
  } catch (error) {
    renameSync(previousDirectory, targetDirectory)
    rmSync(stagingDirectory, { recursive: true, force: true })
    throw error
  }
  rmSync(previousDirectory, { recursive: true, force: true })
  return hashBuiltinSkillDirectory(targetDirectory)
}

function readBuiltinSkillManifest(targetDirectory: string): BuiltinSkillManifest {
  try {
    const parsed = JSON.parse(readFileSync(
      join(targetDirectory, BUILTIN_SKILL_MANIFEST_FILENAME),
      'utf8',
    ))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as BuiltinSkillManifest
      : {}
  } catch {
    return {}
  }
}

function writeBuiltinSkillManifest(
  targetDirectory: string,
  manifest: BuiltinSkillManifest,
): void {
  const sorted: BuiltinSkillManifest = {}
  for (const name of Object.keys(manifest).sort()) sorted[name] = manifest[name]
  writeFileSync(
    join(targetDirectory, BUILTIN_SKILL_MANIFEST_FILENAME),
    `${JSON.stringify(sorted, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

function hashBuiltinSkillDirectory(directory: string): string {
  const hash = createHash('sha256')
  hashBuiltinSkillDirectoryInto(hash, directory, '')
  return hash.digest('hex')
}

function hashBuiltinSkillDirectoryInto(
  hash: ReturnType<typeof createHash>,
  directory: string,
  relativeDirectory: string,
): void {
  const entries = readdirSync(directory, { withFileTypes: true })
    .filter(entry => !BUILTIN_SKILL_HASH_IGNORED_FILENAMES.has(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      hash.update(`dir\0${relativePath}\0`)
      hashBuiltinSkillDirectoryInto(hash, fullPath, relativePath)
    } else if (entry.isFile()) {
      hash.update(`file\0${relativePath}\0`)
      hash.update(readFileSync(fullPath))
      hash.update('\0')
    }
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isPlainDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

function isErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}

function isTransientWindowsFilesystemError(error: unknown): boolean {
  if (process.platform !== 'win32' || !(error instanceof Error) || !('code' in error)) return false
  return ['EACCES', 'EBUSY', 'EPERM'].includes(String(error.code))
}
