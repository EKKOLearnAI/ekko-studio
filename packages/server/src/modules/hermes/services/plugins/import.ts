/**
 * Install a user plugin from a zip archive into a profile's plugins directory.
 *
 * Hermes discovers user plugins by scanning `<HERMES_HOME>/plugins`, where each
 * plugin is a directory holding a `plugin.yaml` (or `.yml`) manifest. Installing
 * one has meant a shell inside the container; this puts the same directory in
 * place from an upload, with the archive checked before anything is written.
 */

import AdmZip from 'adm-zip'
import { randomBytes } from 'crypto'
import { cp, mkdir, readdir, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { getActiveProfileDir, getProfileDir } from '../profiles/profile'
import { isPathWithin } from '../runtime/path'

export const PLUGIN_MANIFEST_FILES = ['plugin.yaml', 'plugin.yml'] as const

export class PluginImportError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

export interface PluginImportResult {
  name: string
  path: string
  replaced: boolean
  files: number
}

/** Plugin directory names become filesystem paths and config keys. */
export function isValidPluginName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..' && !name.startsWith('.')
}

export function pluginsDirForProfile(profile?: string): string {
  return join(profile ? getProfileDir(profile) : getActiveProfileDir(), 'plugins')
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function hasManifest(dir: string): Promise<boolean> {
  for (const manifest of PLUGIN_MANIFEST_FILES) {
    if (await pathExists(join(dir, manifest))) return true
  }
  return false
}

async function countFiles(dir: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += await countFiles(join(dir, entry.name))
    else total++
  }
  return total
}

/**
 * Extract into a staging directory, refusing any entry that would escape it.
 * Nothing touches the plugins directory until the archive has been validated.
 */
async function extractArchive(archive: Buffer, extractDir: string): Promise<void> {
  let zip: AdmZip
  try {
    zip = new AdmZip(archive)
  } catch (err: any) {
    throw new PluginImportError(`Failed to read zip archive: ${err?.message || err}`)
  }

  for (const entry of zip.getEntries()) {
    const rel = entry.entryName.replace(/\\/g, '/')
    if (!rel || rel.startsWith('/')) continue
    const top = rel.split('/')[0]
    if (top === '__MACOSX' || top.startsWith('.')) continue

    const dest = resolve(join(extractDir, rel))
    if (!isPathWithin(dest, extractDir)) {
      throw new PluginImportError(`Path traversal detected in zip entry: ${rel}`)
    }
    if (entry.isDirectory) {
      await mkdir(dest, { recursive: true })
      continue
    }
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, entry.getData())
  }
}

/**
 * Resolve the plugin root inside an extracted archive: either the archive holds
 * the manifest at its root, or it holds exactly one directory that does.
 */
async function resolvePluginRoot(extractDir: string, fallbackName: string): Promise<{ dir: string; name: string }> {
  if (await hasManifest(extractDir)) {
    return { dir: extractDir, name: fallbackName }
  }
  const entries = (await readdir(extractDir, { withFileTypes: true }))
    .filter(entry => !entry.name.startsWith('.') && entry.name !== '__MACOSX')
  const dirs = entries.filter(entry => entry.isDirectory())
  if (dirs.length !== 1) {
    throw new PluginImportError(
      'Archive must contain a single top-level plugin directory with plugin.yaml (or plugin.yaml at the root)',
    )
  }
  const dir = join(extractDir, dirs[0].name)
  if (!(await hasManifest(dir))) {
    throw new PluginImportError(`Plugin directory "${dirs[0].name}" must contain a plugin.yaml manifest`)
  }
  return { dir, name: dirs[0].name }
}

export interface ImportPluginOptions {
  archive: Buffer
  /** Used as the plugin name when the manifest sits at the archive root. */
  filename?: string
  profile?: string
  /** Replacing an installed plugin is deliberate, so it must be asked for. */
  overwrite?: boolean
}

export async function importPluginArchive(options: ImportPluginOptions): Promise<PluginImportResult> {
  const stagingDir = join(tmpdir(), `hermes-plugin-import-${randomBytes(6).toString('hex')}`)
  const extractDir = join(stagingDir, 'extracted')
  await mkdir(extractDir, { recursive: true })

  try {
    await extractArchive(options.archive, extractDir)

    const fallbackName = String(options.filename || 'plugin').replace(/\.zip$/i, '').trim()
    const { dir: sourceDir, name } = await resolvePluginRoot(extractDir, fallbackName)
    if (!isValidPluginName(name)) {
      throw new PluginImportError(`Invalid plugin name "${name}"`)
    }

    const pluginsDir = pluginsDirForProfile(options.profile)
    const targetDir = join(pluginsDir, name)
    if (!isPathWithin(resolve(targetDir), resolve(pluginsDir))) {
      throw new PluginImportError(`Invalid plugin name "${name}"`)
    }

    const replaced = await pathExists(targetDir)
    if (replaced && !options.overwrite) {
      throw new PluginImportError(`Plugin "${name}" already exists. Pass overwrite=true to replace it.`, 409)
    }

    await mkdir(pluginsDir, { recursive: true })
    if (replaced) await rm(targetDir, { recursive: true, force: true })
    await cp(sourceDir, targetDir, { recursive: true })

    return { name, path: targetDir, replaced, files: await countFiles(targetDir) }
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
  }
}
