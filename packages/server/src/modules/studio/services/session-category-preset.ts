import { stat } from 'fs/promises'
import { isAbsolute, win32 as pathWin32 } from 'path'

/**
 * New Chat preset stored on a session category.
 *
 * Every field is optional: an empty preset field means "use today's New Chat
 * default". Presets are shared by everyone who can see categories, so they
 * must never carry credentials (API keys).
 *
 * Validation mirrors the New Chat panel: only rules the panel itself has
 * (MoA only with Hermes, a DSH preset only with DeepSeek Harness), plus
 * storage sanity limits and an absolute workspace path (what FolderPicker
 * produces).
 */
export const SESSION_CATEGORY_PRESET_AGENTS = [
  'hermes',
  'ekko-agent',
  'claude-code',
  'codex',
  'pi',
  'grok',
  'opencode',
  'dsh',
] as const
export type SessionCategoryPresetAgent = typeof SESSION_CATEGORY_PRESET_AGENTS[number]

export const SESSION_CATEGORY_PRESET_API_MODES = ['chat_completions', 'codex_responses', 'anthropic_messages'] as const

export interface SessionCategoryPreset {
  agent?: SessionCategoryPresetAgent
  agentMode?: 'global' | 'scoped'
  agentPreset?: string
  profile?: string
  modelKind?: 'model' | 'moa'
  provider?: string
  model?: string
  apiMode?: typeof SESSION_CATEGORY_PRESET_API_MODES[number]
  baseUrl?: string
  workspace?: string
}

export class SessionCategoryPresetError extends Error {
  status = 400
}

type StringField = 'agentPreset' | 'profile' | 'provider' | 'model' | 'baseUrl' | 'workspace'
type EnumField = 'agent' | 'agentMode' | 'modelKind' | 'apiMode'

const STRING_FIELD_LIMITS: Record<StringField, number> = {
  agentPreset: 200,
  profile: 200,
  provider: 200,
  model: 300,
  baseUrl: 2048,
  workspace: 4096,
}

const ENUM_FIELD_VALUES: Record<EnumField, readonly string[]> = {
  agent: SESSION_CATEGORY_PRESET_AGENTS,
  agentMode: ['global', 'scoped'],
  modelKind: ['model', 'moa'],
  apiMode: SESSION_CATEGORY_PRESET_API_MODES,
}

const FIELD_ORDER: ReadonlyArray<keyof SessionCategoryPreset> = [
  'agent',
  'agentMode',
  'agentPreset',
  'profile',
  'modelKind',
  'provider',
  'model',
  'apiMode',
  'baseUrl',
  'workspace',
]

function isCredentialField(key: string): boolean {
  const normalized = key.replace(/[^a-z]/gi, '').toLowerCase()
  return normalized === 'apikey'
    || normalized.endsWith('apikey')
    || normalized.includes('secret')
    || normalized.includes('token')
    || normalized === 'password'
}

function isStringField(key: string): key is StringField {
  return Object.prototype.hasOwnProperty.call(STRING_FIELD_LIMITS, key)
}

function isEnumField(key: string): key is EnumField {
  return Object.prototype.hasOwnProperty.call(ENUM_FIELD_VALUES, key)
}

/** POSIX (`/home/me/app`) or Windows (`C:\\work`, `\\\\server\\share`) absolute path, as FolderPicker produces. */
export function isAbsolutePresetWorkspace(value: string): boolean {
  return isAbsolute(value) || pathWin32.isAbsolute(value)
}

/**
 * Reads one field. Returns undefined for "empty" and throws a
 * SessionCategoryPresetError describing why a value is unusable.
 */
function readField(key: keyof SessionCategoryPreset, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (isEnumField(key)) {
    if (value === '') return undefined
    if (typeof value !== 'string' || !ENUM_FIELD_VALUES[key].includes(value)) {
      throw new SessionCategoryPresetError(`Preset field ${key} is invalid`)
    }
    return value
  }
  if (typeof value !== 'string') throw new SessionCategoryPresetError(`Preset field ${key} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed.length > STRING_FIELD_LIMITS[key as StringField]) {
    throw new SessionCategoryPresetError(`Preset field ${key} is too long`)
  }
  if (trimmed.includes('\0')) throw new SessionCategoryPresetError(`Preset field ${key} is invalid`)
  if (key === 'workspace' && !isAbsolutePresetWorkspace(trimmed)) {
    throw new SessionCategoryPresetError('Preset workspace must be an absolute folder path')
  }
  return trimmed
}

/** Field combinations the New Chat panel itself does not allow. Returns the offending field. */
function combinationError(preset: SessionCategoryPreset): { field: keyof SessionCategoryPreset; message: string } | null {
  const agent = preset.agent || 'hermes'
  if (preset.modelKind === 'moa' && agent !== 'hermes') {
    return { field: 'modelKind', message: 'MoA presets are only available for the Hermes agent' }
  }
  if (preset.agentPreset && agent !== 'dsh') {
    return { field: 'agentPreset', message: 'Agent preset is only available for DeepSeek Harness' }
  }
  return null
}

function compact(preset: SessionCategoryPreset): SessionCategoryPreset | null {
  const entries = FIELD_ORDER
    .filter(key => preset[key] !== undefined)
    .map(key => [key, preset[key]] as const)
  return entries.length > 0 ? Object.fromEntries(entries) as SessionCategoryPreset : null
}

/**
 * Strict write-side validation. Returns null for "no preset" (null/undefined
 * input, or an object whose fields are all empty). Throws
 * SessionCategoryPresetError for invalid input, including any API key.
 */
export function normalizeSessionCategoryPreset(input: unknown): SessionCategoryPreset | null {
  if (input === undefined || input === null) return null
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new SessionCategoryPresetError('Preset must be an object')
  }
  const record = input as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (isCredentialField(key)) {
      throw new SessionCategoryPresetError('Category presets cannot store API keys or other credentials')
    }
    if (!(FIELD_ORDER as readonly string[]).includes(key)) {
      throw new SessionCategoryPresetError(`Unknown preset field: ${key}`)
    }
  }

  const preset: Record<string, string | undefined> = {}
  for (const key of FIELD_ORDER) preset[key] = readField(key, record[key])
  const typed = preset as SessionCategoryPreset
  const invalid = combinationError(typed)
  if (invalid) throw new SessionCategoryPresetError(invalid.message)
  return compact(typed)
}

/**
 * Lenient read of a stored preset column. Unknown, credential, or invalid
 * fields (for example `reasoningEffort` from an earlier build, or an enum
 * value a newer build wrote) are dropped one by one; the rest of the preset
 * is kept. Only unparseable JSON yields null.
 */
export function parseStoredSessionCategoryPreset(raw: unknown): SessionCategoryPreset | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const preset: Record<string, string | undefined> = {}
  for (const key of FIELD_ORDER) {
    try {
      preset[key] = readField(key, record[key])
    } catch {
      preset[key] = undefined
    }
  }
  const typed = preset as SessionCategoryPreset
  // Drop the field a combination rule points at, then re-check (at most a couple of passes).
  for (let invalid = combinationError(typed); invalid; invalid = combinationError(typed)) {
    delete typed[invalid.field]
  }
  return compact(typed)
}

export function serializeSessionCategoryPreset(preset: SessionCategoryPreset | null): string {
  return preset ? JSON.stringify(preset) : ''
}

export interface SessionCategoryPresetStatus {
  /** false when the preset workspace folder no longer exists; omitted when the preset has no workspace or the check was inconclusive. */
  workspace_exists?: boolean
}

/** true = directory, false = missing / not a directory, undefined = unknown (timeout or other error). */
export type DirectoryProbe = (path: string) => Promise<boolean | undefined>

export const PRESET_WORKSPACE_STAT_TIMEOUT_MS = 500

/**
 * Non-blocking directory probe with a per-path timeout. A slow or hung
 * filesystem (network mount, sleeping disk) resolves as "unknown" instead of
 * blocking the category list or being reported as missing.
 */
export function probeDirectory(path: string, timeoutMs = PRESET_WORKSPACE_STAT_TIMEOUT_MS): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs)
    timer.unref?.()
    stat(path).then(
      (info) => { clearTimeout(timer); resolve(info.isDirectory()) },
      (error: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        resolve(error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? false : undefined)
      },
    )
  })
}

/**
 * Read-only availability check for preset values that only the server can see.
 * It never modifies the stored preset and never recreates a missing folder.
 */
export async function describeSessionCategoryPresetStatus(
  preset: SessionCategoryPreset | null,
  isDirectory: DirectoryProbe,
): Promise<SessionCategoryPresetStatus | undefined> {
  if (!preset?.workspace) return undefined
  const exists = await isDirectory(preset.workspace)
  return exists === undefined ? undefined : { workspace_exists: exists }
}
