import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { cp, lstat, mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, join, relative, resolve } from 'path'
import AdmZip from 'adm-zip'
import * as tar from 'tar'
import { detectHermesRootHome, isPathWithin, isRealPathWithin } from '../runtime/path'
import {
  installExtractedProfileWithoutHermes,
  ProfileLifecycleError,
  validateProfileName,
} from './lifecycle'

const DEFAULT_PROFILE_EXPORT_ENTRIES = new Set([
  'config.yaml',
  'SOUL.md',
  'MEMORY.md',
  'USER.md',
  'todo.json',
  'system_prompt.md',
  'AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
  'skills',
  'cron',
  'scripts',
  'sessions',
  'plugins',
  'memories',
  'knowledge',
  'preferences',
])

const MAX_ARCHIVE_ENTRIES = 100_000
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024

interface NativeProfileArchiveResult {
  name: string
  path: string
  message: string
}

function invalidArchive(message: string): ProfileLifecycleError {
  return new ProfileLifecycleError(message, 400, 'profile_archive_invalid')
}

function profileSourceDirectory(root: string, name: string): string {
  return name === 'default' ? resolve(root) : resolve(root, 'profiles', name)
}

function isUniversallyExcluded(relativePath: string): boolean {
  const segments = relativePath.split('/').filter(Boolean)
  const name = segments.at(-1) || ''
  return segments.includes('__pycache__')
    || name.endsWith('.sock')
    || name.endsWith('.tmp')
    || name === 'package.json'
    || name === 'package-lock.json'
}

async function shouldIncludeExportPath(sourceRoot: string, sourcePath: string, profile: string): Promise<boolean> {
  const relativePath = relative(sourceRoot, sourcePath).replace(/\\/g, '/')
  if (!relativePath) return true
  if (isUniversallyExcluded(relativePath)) return false

  const segments = relativePath.split('/').filter(Boolean)
  const name = segments.at(-1) || ''
  if (profile === 'default') {
    if (!DEFAULT_PROFILE_EXPORT_ENTRIES.has(segments[0])) return false
  } else if (name === '.env' || name === 'auth.json') {
    return false
  }

  const stat = await lstat(sourcePath)
  return !stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile())
}

export async function exportProfileWithoutHermes(
  value: unknown,
  outputPath: string,
  root = detectHermesRootHome(),
): Promise<NativeProfileArchiveResult> {
  const name = validateProfileName(value, { allowDefault: true, allowReserved: true })
  const resolvedRoot = resolve(root)
  const source = profileSourceDirectory(resolvedRoot, name)
  if (!existsSync(source)) {
    throw new ProfileLifecycleError(`Profile '${name}' not found`, 404, 'profile_not_found')
  }
  const allowedRoot = name === 'default' ? resolvedRoot : resolve(resolvedRoot, 'profiles')
  if (!await isRealPathWithin(source, allowedRoot)) {
    throw new ProfileLifecycleError('Profile resolves outside Hermes home', 400, 'profile_path_invalid')
  }
  const sourceStat = await lstat(source)
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new ProfileLifecycleError(`Profile '${name}' not found`, 404, 'profile_not_found')
  }

  const stagingRoot = await mkdtemp(join(tmpdir(), `hermes-profile-native-export-${process.pid}-`))
  try {
    const stagedProfile = join(stagingRoot, name)
    await cp(source, stagedProfile, {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
      verbatimSymlinks: true,
      filter: sourcePath => shouldIncludeExportPath(source, sourcePath, name),
    })
    await mkdir(dirname(outputPath), { recursive: true })
    await tar.create({
      cwd: stagingRoot,
      file: outputPath,
      gzip: true,
      portable: true,
      strict: true,
    }, [name])
    return {
      name,
      path: outputPath,
      message: `Profile '${name}' exported by Studio`,
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

function normalizeArchiveEntryPath(value: string): { path: string; segments: string[] } {
  const archivePath = String(value || '').replace(/\\/g, '/')
  if (!archivePath || archivePath.startsWith('/') || /^[a-zA-Z]:/.test(archivePath) || archivePath.includes('\0')) {
    throw invalidArchive('Archive contains an unsafe path')
  }
  const segments = archivePath.split('/').filter(segment => segment.length > 0)
  if (segments.length === 0 || segments.some(segment => segment === '.' || segment === '..')) {
    throw invalidArchive('Archive contains an unsafe path')
  }
  return { path: segments.join('/'), segments }
}

function registerArchiveEntry(
  roots: Set<string>,
  entryPath: string,
  size: number,
  totals: { entries: number; bytes: number },
): { path: string; segments: string[] } {
  const normalized = normalizeArchiveEntryPath(entryPath)
  roots.add(normalized.segments[0])
  totals.entries += 1
  totals.bytes += Math.max(0, Number(size) || 0)
  if (totals.entries > MAX_ARCHIVE_ENTRIES || totals.bytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
    throw invalidArchive('Archive is too large')
  }
  return normalized
}

function importedProfileName(roots: Set<string>): string {
  if (roots.size !== 1) throw invalidArchive('Archive must contain exactly one top-level profile directory')
  return validateProfileName([...roots][0])
}

async function extractZipArchive(archivePath: string, extractionRoot: string): Promise<string> {
  let zip: AdmZip
  try {
    zip = new AdmZip(archivePath)
  } catch {
    throw invalidArchive('Unable to read ZIP archive')
  }

  const roots = new Set<string>()
  const totals = { entries: 0, bytes: 0 }
  const entries = zip.getEntries()
  if (entries.length === 0) throw invalidArchive('Archive is empty')

  for (const entry of entries) {
    const normalized = registerArchiveEntry(roots, entry.entryName, Number(entry.header.size), totals)
    const unixType = (Number(entry.attr) >>> 16) & 0o170000
    if (unixType === 0o120000) throw invalidArchive('Archive links are not supported')
    if (unixType !== 0 && unixType !== 0o040000 && unixType !== 0o100000) {
      throw invalidArchive('Archive contains an unsupported entry type')
    }

    const target = resolve(extractionRoot, ...normalized.segments)
    if (!isPathWithin(target, extractionRoot)) throw invalidArchive('Archive contains an unsafe path')
    if (entry.isDirectory) {
      await mkdir(target, { recursive: true })
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, entry.getData(), { flag: 'wx' })
  }

  return importedProfileName(roots)
}

function isSupportedTarEntryType(type: string): boolean {
  return type === 'File' || type === 'OldFile' || type === 'Directory'
}

async function extractTarArchive(archivePath: string, extractionRoot: string): Promise<string> {
  const roots = new Set<string>()
  const totals = { entries: 0, bytes: 0 }
  try {
    await tar.list({
      file: archivePath,
      strict: true,
      onReadEntry: entry => {
        registerArchiveEntry(roots, entry.path, Number(entry.size), totals)
        if (!isSupportedTarEntryType(entry.type)) {
          throw invalidArchive('Archive links and special files are not supported')
        }
      },
    })
  } catch (err) {
    if (err instanceof ProfileLifecycleError) throw err
    throw invalidArchive('Unable to read tar archive')
  }
  if (totals.entries === 0) throw invalidArchive('Archive is empty')
  const name = importedProfileName(roots)

  try {
    await tar.extract({
      file: archivePath,
      cwd: extractionRoot,
      strict: true,
      preservePaths: false,
      filter: (entryPath, entry) => {
        normalizeArchiveEntryPath(entryPath)
        return 'type' in entry && isSupportedTarEntryType(entry.type)
      },
    })
  } catch (err) {
    if (err instanceof ProfileLifecycleError) throw err
    throw invalidArchive('Unable to extract tar archive')
  }
  return name
}

export async function importProfileWithoutHermes(
  archivePath: string,
  root = detectHermesRootHome(),
): Promise<NativeProfileArchiveResult> {
  const extractionRoot = await mkdtemp(join(tmpdir(), `hermes-profile-native-import-${process.pid}-${randomUUID()}-`))
  try {
    const lowerPath = archivePath.toLowerCase()
    const name = lowerPath.endsWith('.zip')
      ? await extractZipArchive(archivePath, extractionRoot)
      : await extractTarArchive(archivePath, extractionRoot)
    const extractedDirectory = resolve(extractionRoot, name)
    if (!isPathWithin(extractedDirectory, extractionRoot)) throw invalidArchive('Archive contains an unsafe profile root')
    const result = await installExtractedProfileWithoutHermes(name, extractedDirectory, root)
    return {
      ...result,
      message: `Profile '${result.name}' imported by Studio`,
    }
  } finally {
    await rm(extractionRoot, { recursive: true, force: true })
  }
}
