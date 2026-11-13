import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { chmod, cp, lstat, mkdir, readFile, rename, rm, unlink, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { detectHermesRootHome, isPathWithin, isRealPathWithin } from '../runtime/path'

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

const RESERVED_PROFILE_NAMES = new Set([
  'default',
  'hermes',
  'root',
  'sudo',
  'test',
  'tmp',
])

// Keep this aligned with Hermes' top-level CLI commands. A profile with one of
// these names is ambiguous in shell wrappers such as `hermes-<profile>`.
const HERMES_COMMAND_NAMES = new Set([
  'acp',
  'auth',
  'backup',
  'chat',
  'claw',
  'completion',
  'config',
  'cron',
  'dashboard',
  'debug',
  'desktop',
  'doctor',
  'dump',
  'gateway',
  'gui',
  'honcho',
  'import',
  'insights',
  'kanban',
  'login',
  'logout',
  'logs',
  'mcp',
  'memory',
  'model',
  'pairing',
  'peer',
  'plugins',
  'profile',
  'security',
  'serve',
  'sessions',
  'setup',
  'skills',
  'status',
  'tools',
  'uninstall',
  'update',
  'version',
  'webhook',
  'whatsapp',
  'whatsapp-cloud',
])

const PROFILE_DIRECTORIES = [
  'cron',
  'home',
  'logs',
  'memories',
  'plans',
  'sessions',
  'skills',
  'skins',
  'workspace',
] as const

const CLONE_FILES = [
  'config.yaml',
  '.env',
  'SOUL.md',
] as const

const CLONE_MEMORY_FILES = [
  'MEMORY.md',
  'USER.md',
] as const

const DEFAULT_CONFIG = '# Hermes Agent Configuration\n'
const DEFAULT_ENV = '# Hermes Agent Environment Configuration\n'
const DEFAULT_SOUL = 'You are Hermes Agent, an intelligent AI assistant created by Nous Research. '
  + 'You are helpful, knowledgeable, and direct. You assist users with a wide range of tasks including '
  + 'answering questions, writing and editing code, analyzing information, creative work, and executing '
  + 'actions via your tools. You communicate clearly, admit uncertainty when appropriate, and prioritize '
  + 'being genuinely useful over being verbose unless otherwise directed below. Be targeted and efficient '
  + 'in your exploration and investigations.\n'

export class ProfileLifecycleError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = 'ProfileLifecycleError'
  }
}

export function normalizeProfileName(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

export function isReservedProfileName(value: unknown): boolean {
  const name = normalizeProfileName(value)
  return RESERVED_PROFILE_NAMES.has(name) || HERMES_COMMAND_NAMES.has(name)
}

export function validateProfileName(
  value: unknown,
  options: { allowDefault?: boolean; allowReserved?: boolean } = {},
): string {
  const name = normalizeProfileName(value)
  if (!name) {
    throw new ProfileLifecycleError('Missing profile name', 400, 'profile_name_missing')
  }
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new ProfileLifecycleError(
      'Profile name must start with a letter or number, contain only lowercase letters, numbers, underscores, or hyphens, and be at most 64 characters',
      400,
      'profile_name_invalid',
    )
  }
  if (name === 'default') {
    if (options.allowDefault) return name
    throw new ProfileLifecycleError(`Profile name '${name}' is reserved and cannot be used`, 400, 'profile_name_reserved')
  }
  if (isReservedProfileName(name) && !options.allowReserved) {
    throw new ProfileLifecycleError(`Profile name '${name}' is reserved and cannot be used`, 400, 'profile_name_reserved')
  }
  return name
}

function profileDirectory(root: string, name: string): string {
  const profilesRoot = resolve(root, 'profiles')
  const target = resolve(profilesRoot, name)
  if (!isPathWithin(target, profilesRoot) || target === profilesRoot) {
    throw new ProfileLifecycleError('Profile path is outside the profiles directory', 400, 'profile_path_invalid')
  }
  return target
}

async function ensureProfilesRoot(root: string): Promise<string> {
  const resolvedRoot = resolve(root)
  const profilesRoot = resolve(resolvedRoot, 'profiles')
  await mkdir(resolvedRoot, { recursive: true })
  await mkdir(profilesRoot, { recursive: true })
  if (!await isRealPathWithin(profilesRoot, resolvedRoot)) {
    throw new ProfileLifecycleError('Profiles directory resolves outside Hermes home', 400, 'profiles_root_invalid')
  }
  return profilesRoot
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (err: any) {
    if (err?.code === 'ENOENT') return false
    throw err
  }
}

async function copyIfPresent(source: string, target: string): Promise<void> {
  let sourceStat: Awaited<ReturnType<typeof lstat>>
  try {
    sourceStat = await lstat(source)
  } catch (err: any) {
    if (err?.code === 'ENOENT') return
    throw err
  }
  // Top-level links can make later chmod/config cleanup escape the new profile.
  // Nested links inside copied skill directories remain links and are not followed.
  if (sourceStat.isSymbolicLink()) return
  await cp(source, target, {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
    verbatimSymlinks: true,
  })
}

async function readActiveProfileName(root: string): Promise<string> {
  try {
    const active = normalizeProfileName(await readFile(join(resolve(root), 'active_profile'), 'utf8'))
    if (!active || active === 'default') return 'default'
    return validateProfileName(active)
  } catch {
    return 'default'
  }
}

function activeProfileDirectory(root: string, active: string): string {
  if (active === 'default') return resolve(root)
  return profileDirectory(root, active)
}

async function seedProfileSkeleton(target: string): Promise<void> {
  await Promise.all(PROFILE_DIRECTORIES.map(directory => mkdir(join(target, directory), { recursive: true })))
  if (!await pathExists(join(target, 'config.yaml'))) {
    await writeFile(join(target, 'config.yaml'), DEFAULT_CONFIG, { encoding: 'utf8', mode: 0o600 })
  }
  if (!await pathExists(join(target, '.env'))) {
    await writeFile(join(target, '.env'), DEFAULT_ENV, { encoding: 'utf8', mode: 0o600 })
  }
  await chmod(join(target, '.env'), 0o600)
  if (!await pathExists(join(target, 'SOUL.md'))) {
    await writeFile(join(target, 'SOUL.md'), DEFAULT_SOUL, { encoding: 'utf8', mode: 0o600 })
  }
}

export interface NativeProfileCreateResult {
  name: string
  path: string
  clonedFrom?: string
}

async function commitStagedProfile(
  staging: string,
  target: string,
  name: string,
): Promise<NativeProfileCreateResult> {
  await seedProfileSkeleton(staging)
  try {
    await rename(staging, target)
  } catch (err: any) {
    if (err?.code === 'EEXIST' || err?.code === 'ENOTEMPTY') {
      throw new ProfileLifecycleError(`Profile '${name}' already exists`, 409, 'profile_exists')
    }
    throw err
  }
  return { name, path: target }
}

export async function createProfileWithoutHermes(
  value: unknown,
  clone = false,
  root = detectHermesRootHome(),
): Promise<NativeProfileCreateResult> {
  const name = validateProfileName(value)
  const profilesRoot = await ensureProfilesRoot(root)
  const target = profileDirectory(root, name)
  if (await pathExists(target)) {
    throw new ProfileLifecycleError(`Profile '${name}' already exists`, 409, 'profile_exists')
  }

  const staging = join(profilesRoot, `.create-${process.pid}-${randomUUID()}`)
  let committed = false
  try {
    await mkdir(staging, { mode: 0o700 })
    let clonedFrom: string | undefined
    if (clone) {
      clonedFrom = await readActiveProfileName(root)
      const source = activeProfileDirectory(root, clonedFrom)
      if (!existsSync(source)) {
        throw new ProfileLifecycleError(`Source profile '${clonedFrom}' does not exist`, 404, 'clone_source_missing')
      }
      const allowedSourceRoot = clonedFrom === 'default' ? resolve(root) : resolve(root, 'profiles')
      if (!await isRealPathWithin(source, allowedSourceRoot)) {
        throw new ProfileLifecycleError('Source profile resolves outside Hermes home', 400, 'clone_source_invalid')
      }
      for (const file of CLONE_FILES) {
        await copyIfPresent(join(source, file), join(staging, file))
      }
      await copyIfPresent(join(source, 'skills'), join(staging, 'skills'))
      await mkdir(join(staging, 'memories'), { recursive: true })
      for (const file of CLONE_MEMORY_FILES) {
        await copyIfPresent(join(source, 'memories', file), join(staging, 'memories', file))
      }
    }

    const result = await commitStagedProfile(staging, target, name)
    committed = true
    return {
      ...result,
      ...(clonedFrom ? { clonedFrom } : {}),
    }
  } catch (err: any) {
    if (err?.code === 'EEXIST' || err?.code === 'ENOTEMPTY') {
      throw new ProfileLifecycleError(`Profile '${name}' already exists`, 409, 'profile_exists')
    }
    throw err
  } finally {
    if (!committed) await rm(staging, { recursive: true, force: true })
  }
}

export async function installExtractedProfileWithoutHermes(
  value: unknown,
  extractedDirectory: string,
  root = detectHermesRootHome(),
): Promise<NativeProfileCreateResult> {
  const name = validateProfileName(value)
  const sourceStat = await lstat(extractedDirectory).catch(() => null)
  if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new ProfileLifecycleError('Imported profile root is missing or invalid', 400, 'profile_archive_invalid')
  }

  const profilesRoot = await ensureProfilesRoot(root)
  const target = profileDirectory(root, name)
  if (await pathExists(target)) {
    throw new ProfileLifecycleError(`Profile '${name}' already exists`, 409, 'profile_exists')
  }

  const staging = join(profilesRoot, `.import-${process.pid}-${randomUUID()}`)
  let committed = false
  try {
    await cp(extractedDirectory, staging, {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
      verbatimSymlinks: true,
    })
    const result = await commitStagedProfile(staging, target, name)
    committed = true
    return result
  } finally {
    if (!committed) await rm(staging, { recursive: true, force: true })
  }
}

export async function deleteProfileWithoutHermes(
  value: unknown,
  root = detectHermesRootHome(),
): Promise<boolean> {
  const name = validateProfileName(value, { allowReserved: true })
  const profilesRoot = await ensureProfilesRoot(root)
  const target = profileDirectory(root, name)

  let targetStat: Awaited<ReturnType<typeof lstat>>
  try {
    targetStat = await lstat(target)
  } catch (err: any) {
    if (err?.code === 'ENOENT') return false
    throw err
  }

  if (targetStat.isSymbolicLink()) {
    await unlink(target)
  } else {
    if (!targetStat.isDirectory()) {
      throw new ProfileLifecycleError(`Profile '${name}' is not a directory`, 400, 'profile_path_invalid')
    }
    if (!await isRealPathWithin(target, profilesRoot)) {
      throw new ProfileLifecycleError('Profile directory resolves outside the profiles directory', 400, 'profile_path_invalid')
    }
    const tombstone = join(profilesRoot, `.delete-${process.pid}-${randomUUID()}`)
    await rename(target, tombstone)
    await rm(tombstone, { recursive: true, force: true })
  }

  if (await readActiveProfileName(root) === name) {
    await writeFile(join(resolve(root), 'active_profile'), 'default\n', { encoding: 'utf8', mode: 0o600 })
  }
  return true
}
