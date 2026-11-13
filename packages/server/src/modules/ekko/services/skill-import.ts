import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import AdmZip from 'adm-zip'
import type { EkkoAgentSetup } from '../../../../../ekko-agent/src'
import { setupGlobalEkkoAgent } from './manager'
import { getEkkoSkill, listEkkoSkills, type EkkoSkillDetail } from './skills'

export interface EkkoSkillUpload {
  filename: string
  data: Buffer
}

function normalizeProfile(profile: string): string {
  return String(profile || '').trim() || 'default'
}

function safeSegment(value: string): string | null {
  const name = String(value || '').trim()
  if (!name || name === '.' || name === '..' || name.startsWith('.')) return null
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return null
  return name
}

function contained(root: string, target: string): boolean {
  const offset = relative(resolve(root), resolve(target))
  return offset === '' || (!offset.startsWith('..') && !isAbsolute(offset))
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function hasSkillFile(directory: string): Promise<boolean> {
  try {
    return (await stat(join(directory, 'SKILL.md'))).isFile()
  } catch {
    return false
  }
}

function normalizedUploadPath(filename: string): string | null {
  const value = filename.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!value || value.startsWith('/') || value.includes('\0')) return null
  const parts = value.split('/').filter(Boolean)
  if (!parts.length || parts.some(part => part === '.' || part === '..')) return null
  return parts.join('/')
}

async function extractZip(upload: EkkoSkillUpload, staging: string): Promise<{ name: string; source: string }> {
  let zip: AdmZip
  try {
    zip = new AdmZip(upload.data)
  } catch (error) {
    throw new Error(`Failed to read zip archive: ${error instanceof Error ? error.message : String(error)}`)
  }

  const extracted = join(staging, 'extracted')
  await mkdir(extracted, { recursive: true })
  for (const entry of zip.getEntries()) {
    const path = normalizedUploadPath(entry.entryName)
    if (!path) continue
    const top = path.split('/')[0]
    if (top === '__MACOSX' || top.startsWith('.')) continue
    const destination = resolve(extracted, path)
    if (!contained(extracted, destination)) throw new Error(`Path traversal detected in zip entry: ${path}`)
    if (entry.isDirectory) {
      await mkdir(destination, { recursive: true })
    } else {
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, entry.getData())
    }
  }

  if (await hasSkillFile(extracted)) {
    const name = safeSegment(basename(upload.filename).replace(/\.zip$/i, ''))
    if (!name) throw new Error('The zip filename is not a valid Skill name.')
    return { name, source: extracted }
  }

  const directories = (await readdir(extracted, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
  if (directories.length !== 1) {
    throw new Error('The zip must contain SKILL.md at its root or one top-level Skill directory.')
  }
  const name = safeSegment(directories[0].name)
  const source = join(extracted, directories[0].name)
  if (!name || !await hasSkillFile(source)) {
    throw new Error(`Skill directory "${directories[0].name}" must contain SKILL.md.`)
  }
  return { name, source }
}

async function extractFolder(uploads: EkkoSkillUpload[], staging: string): Promise<{ name: string; source: string }> {
  const paths = uploads.map(upload => normalizedUploadPath(upload.filename))
  if (paths.some(path => !path)) throw new Error('The selected folder contains an invalid path.')
  const topNames = new Set(paths.map(path => path!.split('/')[0]))
  if (topNames.size !== 1) throw new Error('Select exactly one Skill folder.')
  const name = safeSegment([...topNames][0])
  if (!name) throw new Error('The selected folder name is not a valid Skill name.')
  const source = join(staging, name)

  for (let index = 0; index < uploads.length; index += 1) {
    const path = paths[index]!
    const parts = path.split('/')
    if (parts.length < 2) throw new Error('Folder uploads must preserve the top-level Skill directory.')
    const destination = resolve(staging, path)
    if (!contained(source, destination)) throw new Error(`Path traversal detected in upload: ${path}`)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, uploads[index].data)
  }
  if (!await hasSkillFile(source)) throw new Error(`Skill directory "${name}" must contain SKILL.md.`)
  return { name, source }
}

export async function importEkkoSkill(
  profileInput: string,
  uploads: EkkoSkillUpload[],
  categoryInput = '',
  setup?: EkkoAgentSetup,
): Promise<EkkoSkillDetail> {
  if (!uploads.length) throw new Error('No files received.')
  const profile = normalizeProfile(profileInput)
  const resolved = setup || setupGlobalEkkoAgent()
  const layout = resolved.ensureProfile(profile)
  const category = categoryInput ? safeSegment(categoryInput) : ''
  if (categoryInput && !category) throw new Error('Invalid category name.')
  const staging = join(tmpdir(), `ekko-skill-import-${randomUUID()}`)
  await mkdir(staging, { recursive: true })

  try {
    const singleZip = uploads.length === 1
      && uploads[0].filename.toLowerCase().endsWith('.zip')
      && !uploads[0].filename.replace(/\\/g, '/').includes('/')
    const imported = singleZip
      ? await extractZip(uploads[0], staging)
      : await extractFolder(uploads, staging)
    const conflicts = await listEkkoSkills(profile, '', resolved)
    if (conflicts.some(skill => skill.name.toLowerCase() === imported.name.toLowerCase())) {
      throw new Error(`Skill already exists: ${imported.name}.`)
    }

    // Reading the file here catches unreadable/broken uploads before any copy.
    await readFile(join(imported.source, 'SKILL.md'), 'utf8')
    const targetRoot = category ? join(layout.skillDirectory, category) : layout.skillDirectory
    const target = join(targetRoot, imported.name)
    if (!contained(layout.skillDirectory, target)) throw new Error('Invalid Skill destination.')
    if (await exists(target)) throw new Error(`Skill already exists: ${imported.name}.`)
    await mkdir(targetRoot, { recursive: true })
    try {
      await cp(imported.source, target, { recursive: true, errorOnExist: true, force: false })
    } catch (error) {
      await rm(target, { recursive: true, force: true })
      throw error
    }
    resolved.config.setSkillEnabled(imported.name, true, profile)
    return await getEkkoSkill(profile, imported.name, resolved)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
