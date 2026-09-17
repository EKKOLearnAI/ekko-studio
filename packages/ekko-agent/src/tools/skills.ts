import { createHash, randomUUID } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { EkkoExternalSkillDirectory } from '../skills/external-directories'
import type { AgentTool, AgentToolContext, AgentToolResult } from './types'

interface SkillListInput extends Record<string, unknown> {
  query?: string
}

interface SkillViewInput extends Record<string, unknown> {
  name: string
  filePath?: string
}

export interface SkillManageInput extends Record<string, unknown> {
  action: 'create' | 'patch' | 'edit' | 'delete' | 'write_file' | 'remove_file'
  name: string
  content?: string
  category?: string
  filePath?: string
  fileContent?: string
  oldString?: string
  newString?: string
  replaceAll?: boolean
  confirmed?: boolean
}

export interface DiscoveredSkill {
  name: string
  description: string
  keywords: string[]
  category: string
  source: 'local' | 'external'
  sourcePath?: string
  enabled: boolean
  content: string
  root: string
  directory: string
  managedByEkko: boolean
  builtIn: boolean
  validationStatus: SkillValidationStatus
  validationError?: string
}

export type SkillValidationStatus = 'valid' | 'needs_metadata' | 'invalid'

export interface SkillValidationIssue {
  name: string
  status: Exclude<SkillValidationStatus, 'valid'>
  error: string
  directory: string
  sha256: string
}

export interface SkillRoutingResolution {
  names: string[]
  matches: DiscoveredSkill[]
}

const MAX_SKILL_CONTENT_CHARS = 250_000
const MAX_SUPPORT_FILE_CHARS = 1_000_000
const SKILL_METADATA_FILE = '.ekko-skill.json'
const BUILTIN_SKILL_MANIFEST_FILE = '.ekko-builtin-skills.json'
const BUILTIN_SKILL_MANIFEST_OWNER = 'ekko-agent'
const SKILL_BACKUP_DIRECTORY = '.ekko-backups'
const SKILL_ARCHIVE_DIRECTORY = '.ekko-archive'
const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/
const SUPPORT_DIRECTORIES = new Set(['references', 'templates', 'scripts', 'assets'])
const MAX_SKILL_READ_MARKS = 1_024
const skillMutationQueues = new Map<string, Promise<void>>()

interface SkillReadMark {
  hash: string
}

class SkillReadTracker {
  private readonly marks = new Map<string, SkillReadMark>()

  mark(runId: string | undefined, path: string, content: string): void {
    if (!runId) return
    const key = this.key(runId, path)
    if (!this.marks.has(key) && this.marks.size >= MAX_SKILL_READ_MARKS) {
      const oldestKey = this.marks.keys().next().value
      if (oldestKey) this.marks.delete(oldestKey)
    }
    this.marks.set(key, { hash: contentHash(content) })
  }

  get(runId: string | undefined, path: string): SkillReadMark | undefined {
    return runId ? this.marks.get(this.key(runId, path)) : undefined
  }

  forget(runId: string | undefined, path: string): void {
    if (runId) this.marks.delete(this.key(runId, path))
  }

  private key(runId: string, path: string): string {
    return `${runId}\0${resolve(path)}`
  }
}

export class SkillListTool implements AgentTool<SkillListInput> {
  readonly concurrency = 'parallel' as const

  constructor(
    private readonly skillDirectory?: string,
    private readonly externalSkillDirectories: EkkoExternalSkillDirectory[] = [],
    private readonly disabledSkillNames: string[] = [],
  ) {}

  readonly definition = {
    name: 'skill_list',
    description: 'Fallback discovery for skills in this Ekko Agent instance\'s configured skill directory. Available skill names are already present in the system prompt; use skill_view directly when one clearly matches.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional case-insensitive search across skill names, descriptions, and maintained keywords.',
        },
      },
      additionalProperties: false,
    },
  }

  async execute(input: SkillListInput): Promise<AgentToolResult> {
    const query = String(input.query || '').trim().toLowerCase()
    const discovered = await discoverSkills(
      this.skillDirectory,
      this.externalSkillDirectories,
      this.disabledSkillNames,
    )
    const matches = discovered
      .filter(skill => !query || `${skill.name}\n${skill.description}\n${skill.keywords.join('\n')}`.toLowerCase().includes(query))
      .map(({ name, description, category, source, sourcePath, enabled, managedByEkko, builtIn, validationStatus, validationError }) => ({
        name,
        description,
        category,
        source: builtIn ? 'builtin' : source,
        ...(sourcePath ? { sourcePath } : {}),
        enabled,
        managedByEkko,
        builtIn,
        validationStatus,
        ...(validationError ? { validationError } : {}),
      }))
    const payload = {
      query: query || undefined,
      count: matches.length,
      total: discovered.length,
      skills: matches,
      next: matches.length
        ? 'Call skill_view with an exact skill name to load its instructions.'
        : 'Try a broader query or call skill_list without a query.',
    }

    return {
      ok: true,
      content: JSON.stringify(payload, null, 2),
      data: payload,
    }
  }
}

export class SkillViewTool implements AgentTool<SkillViewInput> {
  readonly concurrency = 'parallel' as const

  constructor(
    private readonly skillDirectory?: string,
    private readonly tracker = new SkillReadTracker(),
    private readonly externalSkillDirectories: EkkoExternalSkillDirectory[] = [],
    private readonly disabledSkillNames: string[] = [],
  ) {}

  readonly definition = {
    name: 'skill_view',
    description: 'Load the complete SKILL.md instructions for one skill in this Ekko Agent instance\'s configured skill directory. Use an exact name from the system prompt or skill_list.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Exact skill name from the system prompt or skill_list.',
        },
        filePath: {
          type: 'string',
          description: 'Optional support file path under references/, templates/, scripts/, or assets/. Defaults to SKILL.md.',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  }

  async execute(input: SkillViewInput, context: AgentToolContext = {}): Promise<AgentToolResult> {
    if (!configuredSkillDirectory(this.skillDirectory)) return emptyResult()
    const requestedName = String(input.name || '').trim()
    if (!requestedName) return failure('skill_view requires an exact skill name.')

    const skill = (await discoverSkills(
      this.skillDirectory,
      this.externalSkillDirectories,
      this.disabledSkillNames,
    ))
      .find(candidate => candidate.name.toLowerCase() === requestedName.toLowerCase())
    if (!skill) {
      return failure(`Skill not found: ${requestedName}. Call skill_list to discover available skills.`)
    }

    const requestedFilePath = String(input.filePath || '').trim()
    const readsMainSkillFile = isMainSkillFilePath(requestedFilePath)
    const filePath = readsMainSkillFile
      ? join(skill.directory, 'SKILL.md')
      : await resolveSupportFile(skill.directory, requestedFilePath, { mustExist: true })
    if (!filePath) return failure('Skill support files must stay under references/, templates/, scripts/, or assets/.')
    const content = readsMainSkillFile ? skill.content : await readContainedText(skill.directory, filePath)
    if (content === null) return failure(`Skill file not found: ${requestedFilePath || 'SKILL.md'}.`)
    this.tracker.mark(context.runId, filePath, content)
    const displayFile = readsMainSkillFile ? 'SKILL.md' : requestedFilePath
    const sha256 = contentHash(content)

    return {
      ok: true,
      content: `[skill_view] name=${skill.name} (${content.length} chars) file=${displayFile} sha256=${sha256} baseDirectory=${skill.directory}\n${content}`,
      data: {
        name: skill.name,
        description: skill.description,
        filePath: displayFile,
        baseDirectory: skill.directory,
        characters: content.length,
        sha256,
        managedByEkko: skill.managedByEkko,
        builtIn: skill.builtIn,
        category: skill.category,
        source: skill.builtIn ? 'builtin' : skill.source,
        sourcePath: skill.sourcePath,
        enabled: skill.enabled,
        keywords: skill.keywords,
        validationStatus: skill.validationStatus,
        validationError: skill.validationError,
      },
    }
  }
}

export class SkillManageTool implements AgentTool<SkillManageInput> {
  constructor(
    private readonly skillDirectory?: string,
    private readonly tracker = new SkillReadTracker(),
  ) {}

  readonly definition = {
    name: 'skill_manage',
    description: [
      'Manage reusable Ekko skills in the configured profile skill directory.',
      'Prefer patch over edit. Read an existing target with skill_view in the same run before changing it.',
      'Every created or updated SKILL.md must maintain compact English ASCII frontmatter metadata.keywords for deterministic host-side discovery.',
      'Creates and updates are backed up when replacing existing content; built-in skills cannot be deleted, while other deletes require confirmed=true and archive instead of erasing.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'patch', 'edit', 'delete', 'write_file', 'remove_file'],
          description: 'Mutation to perform.',
        },
        name: {
          type: 'string',
          description: 'Skill name using lowercase letters, numbers, hyphens, or underscores.',
        },
        content: {
          type: 'string',
          description: 'Complete SKILL.md content for create or edit.',
        },
        category: {
          type: 'string',
          description: 'Optional single directory slug used only when creating a skill.',
        },
        filePath: {
          type: 'string',
          description: 'Support file path under references/, templates/, scripts/, or assets/. For patch it defaults to SKILL.md.',
        },
        fileContent: {
          type: 'string',
          description: 'Complete support-file content for write_file.',
        },
        oldString: {
          type: 'string',
          description: 'Exact text to replace for patch. Must be unique unless replaceAll=true.',
        },
        newString: {
          type: 'string',
          description: 'Replacement text for patch. An empty string removes the match.',
        },
        replaceAll: {
          type: 'boolean',
          description: 'Replace every exact match during patch. Defaults to false.',
        },
        confirmed: {
          type: 'boolean',
          description: 'Required for delete. Delete moves the skill into a recoverable hidden archive.',
        },
      },
      required: ['action', 'name'],
      additionalProperties: false,
    },
  }

  async execute(input: SkillManageInput, context: AgentToolContext = {}): Promise<AgentToolResult> {
    const directory = configuredSkillDirectory(this.skillDirectory)
    if (!directory) return failure('skill_manage requires a configured skill directory.')
    const action = String(input.action || '').trim() as SkillManageInput['action']
    const name = normalizeSkillName(input.name)
    if (!name) return failure('Skill names must use lowercase letters, numbers, hyphens, or underscores (maximum 64 characters).')

    try {
      const root = await ensureSkillRoot(directory)
      return await withSkillMutationLock(root, async () => {
        if (action === 'create') return this.create(root, name, input, context)

        const skill = (await discoverSkills(root)).find(candidate => candidate.name.toLowerCase() === name)
        if (!skill) return failure(`Skill not found: ${name}. Call skill_list to discover available skills.`)
        if (context.skillMutationSource === 'background-review' && !skill.managedByEkko) {
          return failure(`Background review cannot modify protected skill: ${skill.name}.`)
        }

        if (action === 'patch') return this.patch(skill, input, context)
        if (action === 'edit') return this.edit(skill, input, context)
        if (action === 'write_file') return this.writeSupportFile(skill, input, context)
        if (action === 'remove_file') return this.removeSupportFile(skill, input, context)
        if (action === 'delete') return this.archiveSkill(root, skill, input, context)
        return failure(`Unknown skill_manage action: ${action}.`)
      })
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error))
    }
  }

  private async create(
    root: string,
    name: string,
    input: SkillManageInput,
    context: AgentToolContext,
  ): Promise<AgentToolResult> {
    const content = String(input.content || '')
    const validationError = validateSkillContent(name, content)
    if (validationError) return failure(validationError)
    if (content.length > MAX_SKILL_CONTENT_CHARS) {
      return failure(`SKILL.md exceeds the ${MAX_SKILL_CONTENT_CHARS} character limit.`)
    }
    if ((await discoverSkills(root)).some(skill => skill.name.toLowerCase() === name)) {
      return failure(`Skill already exists: ${name}. Read it with skill_view, then patch or edit it.`)
    }
    const category = normalizeOptionalSlug(input.category)
    if (input.category && !category) return failure('Skill category must be one lowercase directory slug.')
    const parent = category ? join(root, category) : root
    await ensureWritableDirectory(root, parent)
    const skillDirectory = join(parent, name)
    const temporaryDirectory = join(parent, `.${name}.${randomUUID()}.tmp`)
    const skillPath = join(skillDirectory, 'SKILL.md')
    await mkdir(temporaryDirectory)
    try {
      const now = new Date().toISOString()
      await atomicWrite(join(temporaryDirectory, 'SKILL.md'), content)
      await writeSkillMetadata(temporaryDirectory, {
        createdBy: 'ekko-agent',
        origin: context.skillMutationSource === 'background-review' ? 'background-review' : 'foreground',
        createdAt: now,
        updatedAt: now,
      })
      await rename(temporaryDirectory, skillDirectory)
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true })
      throw error
    }
    return success(name, 'create', {
      path: skillPath,
      managedByEkko: true,
    })
  }

  private async patch(
    skill: DiscoveredSkill,
    input: SkillManageInput,
    context: AgentToolContext,
  ): Promise<AgentToolResult> {
    const oldString = input.oldString
    const newString = input.newString
    if (!oldString) return failure('patch requires oldString.')
    if (newString === undefined) return failure('patch requires newString; use an empty string to remove text.')
    const target = input.filePath
      ? await resolveSupportFile(skill.directory, input.filePath, { mustExist: true })
      : join(skill.directory, 'SKILL.md')
    if (!target) return failure('Patch targets must stay inside SKILL.md or an allowed support directory.')
    const current = await this.currentViewedContent(target, skill, context)
    if (typeof current !== 'string') return current
    const occurrences = countOccurrences(current, oldString)
    if (!occurrences) return failure('oldString was not found in the viewed skill file.')
    if (occurrences > 1 && input.replaceAll !== true) {
      return failure(`oldString matched ${occurrences} times; include more context or set replaceAll=true.`)
    }
    const updated = input.replaceAll === true
      ? current.split(oldString).join(newString)
      : current.replace(oldString, newString)
    if (!input.filePath) {
      const validationError = validateSkillContent(skill.name, updated)
      if (validationError) return failure(validationError)
    }
    const limit = input.filePath ? MAX_SUPPORT_FILE_CHARS : MAX_SKILL_CONTENT_CHARS
    if (updated.length > limit) return failure(`Updated skill file exceeds the ${limit} character limit.`)
    const backupPath = await backupFile(skill.root, target)
    await atomicWrite(target, updated)
    this.tracker.forget(context.runId, target)
    await touchSkillMetadata(skill.directory)
    return success(skill.name, 'patch', {
      filePath: input.filePath || 'SKILL.md',
      replacements: input.replaceAll === true ? occurrences : 1,
      backupPath,
      sha256: contentHash(updated),
    })
  }

  private async edit(
    skill: DiscoveredSkill,
    input: SkillManageInput,
    context: AgentToolContext,
  ): Promise<AgentToolResult> {
    const content = String(input.content || '')
    const validationError = validateSkillContent(skill.name, content)
    if (validationError) return failure(validationError)
    if (content.length > MAX_SKILL_CONTENT_CHARS) {
      return failure(`SKILL.md exceeds the ${MAX_SKILL_CONTENT_CHARS} character limit.`)
    }
    const target = join(skill.directory, 'SKILL.md')
    const current = await this.currentViewedContent(target, skill, context)
    if (typeof current !== 'string') return current
    const backupPath = await backupFile(skill.root, target)
    await atomicWrite(target, content)
    this.tracker.forget(context.runId, target)
    await touchSkillMetadata(skill.directory)
    return success(skill.name, 'edit', {
      filePath: 'SKILL.md',
      backupPath,
      sha256: contentHash(content),
    })
  }

  private async writeSupportFile(
    skill: DiscoveredSkill,
    input: SkillManageInput,
    context: AgentToolContext,
  ): Promise<AgentToolResult> {
    if (!input.filePath) return failure('write_file requires filePath.')
    if (input.fileContent === undefined) return failure('write_file requires fileContent.')
    if (input.fileContent.length > MAX_SUPPORT_FILE_CHARS) {
      return failure(`Support file exceeds the ${MAX_SUPPORT_FILE_CHARS} character limit.`)
    }
    const target = await resolveSupportFile(skill.directory, input.filePath, { mustExist: false })
    if (!target) return failure('Support files must stay under references/, templates/, scripts/, or assets/.')
    const current = await readContainedText(skill.directory, target)
    let backupPath: string | undefined
    if (current !== null) {
      const viewed = await this.currentViewedContent(target, skill, context)
      if (typeof viewed !== 'string') return viewed
      backupPath = await backupFile(skill.root, target)
    }
    await ensureWritableDirectory(skill.directory, dirname(target))
    await atomicWrite(target, input.fileContent)
    this.tracker.forget(context.runId, target)
    await touchSkillMetadata(skill.directory)
    return success(skill.name, 'write_file', {
      filePath: input.filePath,
      backupPath,
      sha256: contentHash(input.fileContent),
    })
  }

  private async removeSupportFile(
    skill: DiscoveredSkill,
    input: SkillManageInput,
    context: AgentToolContext,
  ): Promise<AgentToolResult> {
    if (!input.filePath) return failure('remove_file requires filePath.')
    const target = await resolveSupportFile(skill.directory, input.filePath, { mustExist: true })
    if (!target) return failure('Support files must stay under references/, templates/, scripts/, or assets/.')
    const current = await this.currentViewedContent(target, skill, context)
    if (typeof current !== 'string') return current
    const backupPath = await backupFile(skill.root, target)
    await rm(target)
    this.tracker.forget(context.runId, target)
    await touchSkillMetadata(skill.directory)
    return success(skill.name, 'remove_file', {
      filePath: input.filePath,
      backupPath,
    })
  }

  private async archiveSkill(
    root: string,
    skill: DiscoveredSkill,
    input: SkillManageInput,
    context: AgentToolContext,
  ): Promise<AgentToolResult> {
    if (context.skillMutationSource === 'background-review') {
      return failure('Background review cannot delete skills.')
    }
    if (skill.builtIn) {
      return failure(`Built-in skill cannot be deleted: ${skill.name}.`)
    }
    if (input.confirmed !== true) {
      return failure('delete requires confirmed=true. The skill will be moved to a recoverable hidden archive.')
    }
    const target = join(skill.directory, 'SKILL.md')
    const current = await this.currentViewedContent(target, skill, context)
    if (typeof current !== 'string') return current
    const archiveRoot = join(root, SKILL_ARCHIVE_DIRECTORY)
    await mkdir(archiveRoot, { recursive: true })
    const archivePath = join(archiveRoot, `${timestampSlug()}-${skill.name}-${randomUUID().slice(0, 8)}`)
    await rename(skill.directory, archivePath)
    this.tracker.forget(context.runId, target)
    return success(skill.name, 'delete', {
      archived: true,
      archivePath,
    })
  }

  private async currentViewedContent(
    target: string,
    skill: DiscoveredSkill,
    context: AgentToolContext,
  ): Promise<string | AgentToolResult> {
    const mark = this.tracker.get(context.runId, target)
    if (!mark) {
      return failure(`Read ${skill.name}${target.endsWith('SKILL.md') ? '' : `:${relative(skill.directory, target)}`} with skill_view in this run before modifying it.`)
    }
    const current = await readContainedText(skill.directory, target)
    if (current === null) return failure('The viewed skill file no longer exists.')
    if (contentHash(current) !== mark.hash) {
      return failure('The skill changed after skill_view. Read it again before modifying it.')
    }
    return current
  }
}

export interface CreateSkillToolsOptions {
  externalSkillDirectories?: EkkoExternalSkillDirectory[]
  disabledSkillNames?: string[]
}

export function createSkillTools(
  skillDirectory?: string,
  options: CreateSkillToolsOptions = {},
): AgentTool[] {
  const tracker = new SkillReadTracker()
  const externalSkillDirectories = options.externalSkillDirectories ?? []
  const disabledSkillNames = options.disabledSkillNames ?? []
  const tools: AgentTool[] = [
    new SkillListTool(skillDirectory, externalSkillDirectories, disabledSkillNames),
    new SkillViewTool(skillDirectory, tracker, externalSkillDirectories, disabledSkillNames),
  ]
  if (configuredSkillDirectory(skillDirectory)) {
    tools.push(new SkillManageTool(skillDirectory, tracker))
  }
  return tools
}

async function discoverSkills(
  skillDirectory?: string,
  externalSkillDirectories: EkkoExternalSkillDirectory[] = [],
  disabledSkillNames: string[] = [],
): Promise<DiscoveredSkill[]> {
  const directory = String(skillDirectory || '').trim()
  if (!directory) return []
  const skills = new Map<string, DiscoveredSkill>()
  const visited = new Set<string>()
  const root = resolve(directory)
  if (!await isDirectory(root)) return []
  const realRoot = await realpath(root).catch(() => root)
  const builtInSkillNames = await readBuiltInSkillNames(realRoot)
  const disabled = new Set(disabledSkillNames.map(name => name.toLowerCase()))
  await scanSkillDirectory(
    realRoot,
    realRoot,
    skills,
    visited,
    builtInSkillNames,
    'local',
    undefined,
    disabled,
  )

  for (const external of externalSkillDirectories) {
    const externalRoot = resolve(external.directory)
    if (!await isDirectory(externalRoot)) continue
    const realExternalRoot = await realpath(externalRoot).catch(() => externalRoot)
    if (realExternalRoot === realRoot) continue
    await scanSkillDirectory(
      realExternalRoot,
      realExternalRoot,
      skills,
      visited,
      new Set(),
      'external',
      external.sourcePath,
      disabled,
    )
  }

  return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Validates only the writable Profile-local Skill tree. External directories
 * are intentionally excluded because Ekko treats them as read-only sources.
 */
export async function inspectLocalSkillValidationIssues(
  skillDirectory?: string,
): Promise<SkillValidationIssue[]> {
  const skills = await discoverSkills(skillDirectory)
  return skills.flatMap(skill => skill.validationStatus === 'valid'
    ? []
    : [{
        name: skill.name,
        status: skill.validationStatus,
        error: skill.validationError || 'SKILL.md failed validation.',
        directory: skill.directory,
        sha256: contentHash(skill.content),
      }])
}

/**
 * Returns the compact Profile-specific catalog injected into the model prompt.
 * Descriptions, keywords, paths, and skill bodies deliberately stay out.
 */
export async function listSkillNames(skillDirectory?: string): Promise<string[]> {
  return (await resolveSkillRouting(skillDirectory)).names
}

async function scanSkillDirectory(
  root: string,
  directory: string,
  skills: Map<string, DiscoveredSkill>,
  visited: Set<string>,
  builtInSkillNames: Set<string>,
  source: 'local' | 'external',
  sourcePath: string | undefined,
  disabledSkillNames: Set<string>,
): Promise<void> {
  const realDirectory = await realpath(directory).catch(() => resolve(directory))
  if (!isContainedPath(root, realDirectory)) return
  if (visited.has(realDirectory)) return
  visited.add(realDirectory)

  const skillContent = await readContainedText(root, join(realDirectory, 'SKILL.md'))
  if (skillContent !== null) {
    const name = basename(realDirectory)
    const key = name.toLowerCase()
    if (!skills.has(key)) {
      const validation = skillValidationResult(name, skillContent)
      skills.set(key, {
        name,
        description: extractSkillDescription(skillContent),
        keywords: extractSkillKeywords(skillContent),
        category: skillCategory(root, realDirectory),
        source,
        ...(sourcePath ? { sourcePath } : {}),
        enabled: !disabledSkillNames.has(key),
        content: skillContent,
        root,
        directory: realDirectory,
        managedByEkko: await isEkkoManagedSkill(realDirectory),
        builtIn: builtInSkillNames.has(name.toLowerCase()),
        validationStatus: validation.status,
        ...(validation.error ? { validationError: validation.error } : {}),
      })
    }
    return
  }

  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const entryPath = join(directory, entry.name)
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (!await isDirectory(entryPath)) continue
    await scanSkillDirectory(
      root,
      entryPath,
      skills,
      visited,
      builtInSkillNames,
      source,
      sourcePath,
      disabledSkillNames,
    )
  }
}

/**
 * Deterministically selects file-backed skills for one effective user message.
 * Names and explicit frontmatter keywords are the only routing inputs; long
 * descriptions and skill bodies never participate in automatic selection.
 */
export async function matchSkillsForUserMessage(
  skillDirectory: string | undefined,
  userMessage: string,
  externalSkillDirectories: EkkoExternalSkillDirectory[] = [],
  disabledSkillNames: string[] = [],
): Promise<DiscoveredSkill[]> {
  return (await resolveSkillRouting(
    skillDirectory,
    userMessage,
    externalSkillDirectories,
    disabledSkillNames,
  )).matches
}

/** Resolves prompt names and deterministic exact matches from one directory scan. */
export async function resolveSkillRouting(
  skillDirectory: string | undefined,
  userMessage = '',
  externalSkillDirectories: EkkoExternalSkillDirectory[] = [],
  disabledSkillNames: string[] = [],
): Promise<SkillRoutingResolution> {
  const skills = await discoverSkills(skillDirectory, externalSkillDirectories, disabledSkillNames)
  const enabledSkills = skills.filter(skill => skill.enabled && skill.validationStatus !== 'invalid')
  const normalizedMessage = normalizeMatchText(userMessage)
  return {
    names: enabledSkills.map(skill => skill.name),
    matches: normalizedMessage
      ? enabledSkills.filter(skill => {
          const terms = [
            skill.name,
            skill.name.replaceAll(/[-_]+/g, ' '),
            ...(skill.validationStatus === 'valid' ? skill.keywords : []),
          ]
          return terms.some(term => matchNormalizedTerm(normalizedMessage, term))
        })
      : [],
  }
}

function skillCategory(root: string, directory: string): string {
  const parts = relative(root, directory).split(sep).filter(Boolean)
  return parts.length > 1 ? parts.slice(0, -1).join('/') : 'misc'
}

function extractSkillDescription(content: string): string {
  const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (frontmatter) {
    const match = frontmatter[1].match(/^description:[ \t]*(?:\r?\n(?:[ \t]*\r?\n)*[ \t]+)?(.+)$/im)
    const description = match?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2')
    if (description && description !== '|' && description !== '>') return description.slice(0, 240)
  }

  const body = frontmatter ? content.slice(frontmatter[0].length) : content
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    return trimmed.slice(0, 240)
  }
  return ''
}

function extractSkillKeywords(content: string): string[] {
  const frontmatter = skillFrontmatter(content)
  if (!frontmatter) return []
  return listFrontmatterValues(frontmatter, 'keywords')
}

async function readBuiltInSkillNames(root: string): Promise<Set<string>> {
  const raw = await readContainedText(root, join(root, BUILTIN_SKILL_MANIFEST_FILE))
  if (!raw) return new Set()
  try {
    const parsed = JSON.parse(raw) as Record<string, { owner?: unknown }>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Set()
    return new Set(Object.entries(parsed)
      .filter(([, entry]) => entry?.owner === BUILTIN_SKILL_MANIFEST_OWNER)
      .map(([name]) => name.toLowerCase()))
  } catch {
    return new Set()
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function failure(message: string): AgentToolResult {
  return {
    ok: false,
    content: message,
    error: message,
  }
}

function configuredSkillDirectory(skillDirectory?: string): string | null {
  const directory = String(skillDirectory || '').trim()
  return directory || null
}

function isMainSkillFilePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/')
  return !normalized || normalized === 'SKILL.md' || normalized === './SKILL.md'
}

function emptyResult(): AgentToolResult {
  return {
    ok: true,
    content: '',
  }
}

interface SkillMetadata {
  createdBy: 'ekko-agent'
  origin: 'foreground' | 'background-review'
  createdAt: string
  updatedAt: string
}

async function ensureSkillRoot(directory: string): Promise<string> {
  const absolute = resolve(directory)
  await mkdir(absolute, { recursive: true })
  return realpath(absolute)
}

async function ensureWritableDirectory(root: string, directory: string): Promise<void> {
  const relativePath = relative(root, directory)
  if (!relativePath || relativePath === '.') return
  if (relativePath.startsWith('..') || resolve(root, relativePath) !== resolve(directory)) {
    throw new Error('Skill path escapes the configured skill directory.')
  }
  let current = root
  for (const part of relativePath.split(sep).filter(Boolean)) {
    current = join(current, part)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`Skill directory component is not a regular directory: ${part}`)
      }
    } catch (error) {
      if (!isMissingFileError(error)) throw error
      await mkdir(current)
    }
  }
  const realDirectory = await realpath(directory)
  if (!isContainedPath(root, realDirectory)) throw new Error('Skill path escapes the configured skill directory.')
}

async function resolveSupportFile(
  skillDirectory: string,
  filePath: string,
  options: { mustExist: boolean },
): Promise<string | null> {
  const normalized = String(filePath || '').trim().replaceAll('\\', '/')
  const parts = normalized.split('/').filter(Boolean)
  if (
    !normalized ||
    normalized.startsWith('/') ||
    parts.includes('..') ||
    parts.includes('.') ||
    !SUPPORT_DIRECTORIES.has(parts[0]) ||
    parts.length < 2
  ) {
    return null
  }
  const target = resolve(skillDirectory, ...parts)
  if (!isContainedPath(skillDirectory, target)) return null
  const parent = dirname(target)
  if (options.mustExist) {
    const realTarget = await realpath(target).catch(() => null)
    if (!realTarget || !isContainedPath(skillDirectory, realTarget)) return null
    const info = await lstat(realTarget).catch(() => null)
    return info?.isFile() ? realTarget : null
  }
  const nearest = await nearestExistingAncestor(parent)
  if (!nearest || !isContainedPath(skillDirectory, await realpath(nearest))) return null
  return target
}

async function readContainedText(root: string, path: string): Promise<string | null> {
  const realPath = await realpath(path).catch(() => null)
  if (!realPath || !isContainedPath(root, realPath)) return null
  const info = await lstat(realPath).catch(() => null)
  if (!info?.isFile()) return null
  return readText(realPath)
}

async function nearestExistingAncestor(path: string): Promise<string | null> {
  let current = resolve(path)
  while (true) {
    try {
      await lstat(current)
      return current
    } catch (error) {
      if (!isMissingFileError(error)) return null
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tempPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  await writeFile(tempPath, content, { encoding: 'utf8', flag: 'wx' })
  try {
    await rename(tempPath, path)
  } catch (error) {
    if (isReplaceRenameError(error)) {
      try {
        await writeFile(path, content, 'utf8')
        return
      } finally {
        await rm(tempPath, { force: true })
      }
    }
    await rm(tempPath, { force: true })
    throw error
  }
}

async function withSkillMutationLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const key = resolve(root)
  const previous = skillMutationQueues.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate
  })
  const tail = previous.catch(() => {}).then(() => gate)
  skillMutationQueues.set(key, tail)
  await previous.catch(() => {})
  try {
    return await action()
  } finally {
    release()
    if (skillMutationQueues.get(key) === tail) skillMutationQueues.delete(key)
  }
}

async function backupFile(root: string, target: string): Promise<string> {
  const backupDirectory = join(root, SKILL_BACKUP_DIRECTORY, `${timestampSlug()}-${randomUUID().slice(0, 8)}`)
  const relativeTarget = relative(root, target)
  const backupPath = join(backupDirectory, relativeTarget)
  await mkdir(dirname(backupPath), { recursive: true })
  await copyFile(target, backupPath)
  return backupPath
}

async function writeSkillMetadata(skillDirectory: string, metadata: SkillMetadata): Promise<void> {
  await atomicWrite(join(skillDirectory, SKILL_METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`)
}

async function touchSkillMetadata(skillDirectory: string): Promise<void> {
  const metadata = await readSkillMetadata(skillDirectory)
  if (!metadata) return
  await writeSkillMetadata(skillDirectory, {
    ...metadata,
    updatedAt: new Date().toISOString(),
  })
}

async function readSkillMetadata(skillDirectory: string): Promise<SkillMetadata | null> {
  const raw = await readContainedText(skillDirectory, join(skillDirectory, SKILL_METADATA_FILE))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<SkillMetadata>
    return parsed.createdBy === 'ekko-agent' &&
      (parsed.origin === 'foreground' || parsed.origin === 'background-review') &&
      typeof parsed.createdAt === 'string' &&
      typeof parsed.updatedAt === 'string'
      ? parsed as SkillMetadata
      : null
  } catch {
    return null
  }
}

async function isEkkoManagedSkill(skillDirectory: string): Promise<boolean> {
  return Boolean(await readSkillMetadata(skillDirectory))
}

export function validateSkillContent(name: string, content: string): string | null {
  if (!content.trim()) return 'Skill content cannot be empty.'
  const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!frontmatter) return 'SKILL.md must start with YAML frontmatter.'
  const frontmatterName = scalarFrontmatterValue(frontmatter[1], 'name')
  const description = scalarFrontmatterValue(frontmatter[1], 'description')
  if (!frontmatterName || frontmatterName.toLowerCase() !== name) {
    return `SKILL.md frontmatter name must be "${name}".`
  }
  if (!description) return 'SKILL.md frontmatter requires a description.'
  const keywords = listFrontmatterValues(frontmatter[1], 'keywords')
  if (!keywords.length) {
    return 'SKILL.md frontmatter requires at least one non-empty metadata.keywords entry.'
  }
  if (keywords.length > 8) return 'SKILL.md frontmatter supports at most 8 keywords.'
  if (keywords.some(keyword => keyword.length > 80)) {
    return 'SKILL.md frontmatter keywords must not exceed 80 characters each.'
  }
  if (keywords.some(keyword => !/^[\x20-\x7e]+$/.test(keyword))) {
    return 'SKILL.md frontmatter metadata.keywords must use English ASCII text or technical identifiers.'
  }
  if (!content.slice(frontmatter[0].length).trim()) return 'SKILL.md requires a Markdown body after frontmatter.'
  return null
}

export function skillValidationResult(
  name: string,
  content: string,
): { status: SkillValidationStatus; error?: string } {
  const error = validateSkillContent(name, content)
  if (!error) return { status: 'valid' }
  return {
    status: /keywords/i.test(error) ? 'needs_metadata' : 'invalid',
    error,
  }
}

function scalarFrontmatterValue(frontmatter: string, key: string): string {
  const match = frontmatter.match(new RegExp(`^${key}:[ \\t]*(?:\\r?\\n(?:[ \\t]*\\r?\\n)*[ \\t]+)?(.+)$`, 'im'))
  return match?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2') || ''
}

function skillFrontmatter(content: string): string {
  return content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || ''
}

function listFrontmatterValues(frontmatter: string, key: string): string[] {
  const lines = frontmatter.split(/\r?\n/)
  let start = lines.findIndex(line => new RegExp(`^${key}:`, 'i').test(line))
  if (start < 0) {
    const metadataStart = lines.findIndex(line => /^metadata:\s*$/i.test(line))
    if (metadataStart >= 0) {
      for (let index = metadataStart + 1; index < lines.length; index += 1) {
        if (/^\S/.test(lines[index])) break
        if (new RegExp(`^\\s+${key}:`, 'i').test(lines[index])) {
          start = index
          break
        }
      }
    }
  }
  if (start < 0) return []
  const firstValue = lines[start].slice(lines[start].indexOf(':') + 1).trim()
  const keyIndent = lines[start].match(/^\s*/)?.[0].length ?? 0
  const values: string[] = []
  if (firstValue) {
    if (!firstValue.startsWith('[') || !firstValue.endsWith(']')) return []
    values.push(...firstValue.slice(1, -1).split(','))
  } else {
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.trim() && (line.match(/^\s*/)?.[0].length ?? 0) <= keyIndent) break
      const match = line.match(/^\s+-\s*(.*?)\s*$/)
      if (match) values.push(match[1])
    }
  }
  const seen = new Set<string>()
  return values
    .map(value => value.trim().replace(/^(['"])(.*)\1$/, '$2').trim())
    .filter(value => {
      const normalized = value.toLocaleLowerCase()
      if (!value || seen.has(normalized)) return false
      seen.add(normalized)
      return true
    })
}

function normalizeMatchText(value: string): string {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replaceAll(/\s+/g, ' ')
    .trim()
}

function matchNormalizedTerm(normalizedMessage: string, rawTerm: string): boolean {
  const term = normalizeMatchText(rawTerm)
  if (!term) return false
  if (!/^[a-z0-9][a-z0-9 ._+/#-]*$/i.test(term)) return normalizedMessage.includes(term)
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(normalizedMessage)
}

function normalizeSkillName(value: unknown): string | null {
  const normalized = String(value || '').trim().toLowerCase()
  return SKILL_NAME_PATTERN.test(normalized) ? normalized : null
}

function normalizeOptionalSlug(value: unknown): string | null {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return null
  return SKILL_NAME_PATTERN.test(normalized) ? normalized : null
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function countOccurrences(content: string, search: string): number {
  if (!search) return 0
  let count = 0
  let offset = 0
  while ((offset = content.indexOf(search, offset)) >= 0) {
    count += 1
    offset += search.length
  }
  return count
}

function isContainedPath(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function timestampSlug(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, '-')
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function isReplaceRenameError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EEXIST' || code === 'EPERM' || code === 'ENOTEMPTY'
}

function success(
  name: string,
  action: SkillManageInput['action'],
  data: Record<string, unknown>,
): AgentToolResult {
  const payload = { success: true, name, action, ...data }
  return {
    ok: true,
    content: `[skill_manage] name=${name} action=${action}\n${JSON.stringify(payload, null, 2)}`,
    data: payload,
  }
}
