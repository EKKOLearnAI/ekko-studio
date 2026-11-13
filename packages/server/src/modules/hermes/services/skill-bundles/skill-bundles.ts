import { mkdir, readdir, readFile, unlink, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import YAML from 'js-yaml'
import { getProfileDir, listProfileNamesFromDisk } from '../profiles/profile'

export interface SkillBundleInfo {
  name: string
  commandName: string
  description: string
  skills: string[]
  instruction?: string
}

export interface CreateSkillBundleInput {
  name: string
  description?: string
  skills: string[]
}

export class SkillBundleValidationError extends Error {}
export class SkillBundleConflictError extends Error {}
export class SkillBundleProfileNotFoundError extends Error {}
export class SkillBundleNotFoundError extends Error {}

const RESERVED_BUNDLE_COMMANDS = new Set([
  'abort',
  'bundles',
  'clear',
  'compress',
  'create',
  'destroy',
  'fork',
  'goal',
  'learn',
  'moa',
  'plan',
  'queue',
  'reload-mcp',
  'reload-skills',
  'skill',
  'status',
  'steer',
  'subgoal',
  'title',
  'usage',
  'yolo',
])

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(stringValue).filter(Boolean))]
}

export function skillBundleCommandName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/ /g, '-')
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function bundleDirectory(profile: string): string {
  const normalizedProfile = profile.trim() || 'default'
  if (!listProfileNamesFromDisk().includes(normalizedProfile)) {
    throw new SkillBundleProfileNotFoundError(`Profile "${normalizedProfile}" was not found`)
  }
  return join(getProfileDir(normalizedProfile), 'skill-bundles')
}

function bundleFromYaml(fileName: string, content: string): SkillBundleInfo | null {
  let parsed: unknown
  try {
    parsed = YAML.load(content, { json: true })
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const record = parsed as Record<string, unknown>
  const fallbackName = basename(fileName).replace(/\.ya?ml$/i, '')
  const name = stringValue(record.name) || fallbackName
  const commandName = skillBundleCommandName(name)
  if (!commandName) return null
  const skills = stringList(record.skills)
  if (skills.length === 0) return null

  const instruction = stringValue(record.instruction)
  return {
    name,
    commandName,
    description: stringValue(record.description),
    skills,
    ...(instruction ? { instruction } : {}),
  }
}

export async function listSkillBundles(profile: string): Promise<SkillBundleInfo[]> {
  const dir = bundleDirectory(profile)
  let fileNames: string[]
  try {
    fileNames = (await readdir(dir))
      .filter(fileName => /\.ya?ml$/i.test(fileName))
      .sort((a, b) => a.localeCompare(b))
  } catch (err: any) {
    if (err?.code === 'ENOENT') return []
    throw err
  }

  const bundles: SkillBundleInfo[] = []
  const seenCommands = new Set<string>()
  for (const fileName of fileNames) {
    let bundle: SkillBundleInfo | null = null
    try {
      bundle = bundleFromYaml(fileName, await readFile(join(dir, fileName), 'utf-8'))
    } catch {
      continue
    }
    if (!bundle || seenCommands.has(bundle.commandName)) continue
    seenCommands.add(bundle.commandName)
    bundles.push(bundle)
  }
  return bundles
}

export async function createSkillBundle(profile: string, input: CreateSkillBundleInput): Promise<SkillBundleInfo> {
  const name = stringValue(input.name)
  if (!name) throw new SkillBundleValidationError('Bundle name is required')
  if (name.length > 120) throw new SkillBundleValidationError('Bundle name must be 120 characters or fewer')
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(name) || !/[A-Za-z]/.test(name)) {
    throw new SkillBundleValidationError('Bundle name must use English letters, numbers, spaces, hyphens, or underscores')
  }

  const commandName = skillBundleCommandName(name)
  if (!commandName) {
    throw new SkillBundleValidationError('Bundle name must contain at least one letter or number')
  }
  if (RESERVED_BUNDLE_COMMANDS.has(commandName)) {
    throw new SkillBundleValidationError(`Bundle command "${commandName}" is reserved`)
  }

  const description = stringValue(input.description)
  if (description.length > 1000) {
    throw new SkillBundleValidationError('Bundle description must be 1000 characters or fewer')
  }

  const skills = stringList(input.skills)
  if (skills.length === 0) throw new SkillBundleValidationError('Select at least one skill')
  if (skills.length > 100 || skills.some(skill => skill.length > 200)) {
    throw new SkillBundleValidationError('Bundle contains too many skills or an invalid skill name')
  }

  const existing = await listSkillBundles(profile)
  if (existing.some(bundle => bundle.commandName === commandName)) {
    throw new SkillBundleConflictError(`Bundle command "${commandName}" already exists`)
  }

  const dir = bundleDirectory(profile)
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `${commandName}.yaml`)
  const payload: Record<string, unknown> = { name, skills }
  if (description) payload.description = description
  const yaml = YAML.dump(payload, {
    lineWidth: -1,
    noRefs: true,
    noCompatMode: true,
  })

  try {
    await writeFile(filePath, yaml, { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
  } catch (err: any) {
    if (err?.code === 'EEXIST') {
      throw new SkillBundleConflictError(`Bundle command "${commandName}" already exists`)
    }
    throw err
  }

  return { name, commandName, description, skills }
}

export async function deleteSkillBundle(profile: string, commandName: string): Promise<void> {
  const normalizedCommand = skillBundleCommandName(commandName)
  if (!normalizedCommand) throw new SkillBundleValidationError('Bundle command is required')

  const dir = bundleDirectory(profile)
  let fileNames: string[]
  try {
    fileNames = (await readdir(dir))
      .filter(fileName => /\.ya?ml$/i.test(fileName))
      .sort((a, b) => a.localeCompare(b))
  } catch (err: any) {
    if (err?.code === 'ENOENT') throw new SkillBundleNotFoundError(`Bundle "${normalizedCommand}" was not found`)
    throw err
  }

  for (const fileName of fileNames) {
    const filePath = join(dir, fileName)
    let bundle: SkillBundleInfo | null = null
    try {
      bundle = bundleFromYaml(fileName, await readFile(filePath, 'utf-8'))
    } catch {
      continue
    }
    if (bundle?.commandName !== normalizedCommand) continue
    await unlink(filePath)
    return
  }

  throw new SkillBundleNotFoundError(`Bundle "${normalizedCommand}" was not found`)
}
