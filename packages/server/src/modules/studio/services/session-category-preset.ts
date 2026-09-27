/**
 * New Chat preset stored on a session category.
 *
 * Every field is optional: an empty preset field means "use today's New Chat
 * default". Presets are shared by everyone who can see categories, so they
 * must never carry credentials (API keys).
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
export const SESSION_CATEGORY_PRESET_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export interface SessionCategoryPreset {
  agent?: SessionCategoryPresetAgent
  agentMode?: 'global' | 'scoped'
  agentPreset?: string
  profile?: string
  modelKind?: 'model' | 'moa'
  provider?: string
  model?: string
  apiMode?: typeof SESSION_CATEGORY_PRESET_API_MODES[number]
  reasoningEffort?: typeof SESSION_CATEGORY_PRESET_REASONING_EFFORTS[number]
  baseUrl?: string
  workspace?: string
}

export class SessionCategoryPresetError extends Error {
  status = 400
}

const STRING_FIELD_LIMITS: Record<'agentPreset' | 'profile' | 'provider' | 'model' | 'baseUrl' | 'workspace', number> = {
  agentPreset: 200,
  profile: 200,
  provider: 200,
  model: 300,
  baseUrl: 2048,
  workspace: 4096,
}

const ALLOWED_FIELDS = new Set<string>([
  'agent',
  'agentMode',
  'agentPreset',
  'profile',
  'modelKind',
  'provider',
  'model',
  'apiMode',
  'reasoningEffort',
  'baseUrl',
  'workspace',
])

function isCredentialField(key: string): boolean {
  const normalized = key.replace(/[^a-z]/gi, '').toLowerCase()
  return normalized === 'apikey'
    || normalized.endsWith('apikey')
    || normalized.includes('secret')
    || normalized.includes('token')
    || normalized === 'password'
}

function readOptionalString(record: Record<string, unknown>, key: keyof typeof STRING_FIELD_LIMITS): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new SessionCategoryPresetError(`Preset field ${key} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed.length > STRING_FIELD_LIMITS[key]) {
    throw new SessionCategoryPresetError(`Preset field ${key} is too long`)
  }
  if (trimmed.includes('\0')) throw new SessionCategoryPresetError(`Preset field ${key} is invalid`)
  return trimmed
}

function readOptionalEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = record[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new SessionCategoryPresetError(`Preset field ${key} is invalid`)
  }
  return value as T
}

/**
 * Validates and normalizes a preset payload. Returns null for "no preset"
 * (null/undefined input, or an object whose fields are all empty).
 * Throws SessionCategoryPresetError for invalid input, including any API key.
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
    if (!ALLOWED_FIELDS.has(key)) {
      throw new SessionCategoryPresetError(`Unknown preset field: ${key}`)
    }
  }

  const preset: SessionCategoryPreset = {
    agent: readOptionalEnum(record, 'agent', SESSION_CATEGORY_PRESET_AGENTS),
    agentMode: readOptionalEnum(record, 'agentMode', ['global', 'scoped'] as const),
    agentPreset: readOptionalString(record, 'agentPreset'),
    profile: readOptionalString(record, 'profile'),
    modelKind: readOptionalEnum(record, 'modelKind', ['model', 'moa'] as const),
    provider: readOptionalString(record, 'provider'),
    model: readOptionalString(record, 'model'),
    apiMode: readOptionalEnum(record, 'apiMode', SESSION_CATEGORY_PRESET_API_MODES),
    reasoningEffort: readOptionalEnum(record, 'reasoningEffort', SESSION_CATEGORY_PRESET_REASONING_EFFORTS),
    baseUrl: readOptionalString(record, 'baseUrl'),
    workspace: readOptionalString(record, 'workspace'),
  }

  const agent = preset.agent || 'hermes'
  if (preset.modelKind === 'moa' && agent !== 'hermes') {
    throw new SessionCategoryPresetError('MoA presets are only available for the Hermes agent')
  }
  if (preset.agentPreset && agent !== 'dsh') {
    throw new SessionCategoryPresetError('Agent preset is only available for DeepSeek Harness')
  }
  if (preset.baseUrl && !/^https?:\/\//i.test(preset.baseUrl)) {
    throw new SessionCategoryPresetError('Preset base URL must start with http:// or https://')
  }

  const compact = Object.fromEntries(
    Object.entries(preset).filter(([, value]) => value !== undefined),
  ) as SessionCategoryPreset
  return Object.keys(compact).length > 0 ? compact : null
}

/** Parses a stored preset column. Invalid legacy data is ignored rather than thrown. */
export function parseStoredSessionCategoryPreset(raw: unknown): SessionCategoryPreset | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    return normalizeSessionCategoryPreset(JSON.parse(raw))
  } catch {
    return null
  }
}

export function serializeSessionCategoryPreset(preset: SessionCategoryPreset | null): string {
  return preset ? JSON.stringify(preset) : ''
}

export interface SessionCategoryPresetStatus {
  /** false when the preset workspace folder no longer exists; omitted when the preset has no workspace. */
  workspace_exists?: boolean
}

/**
 * Read-only availability check for preset values that only the server can see.
 * It never modifies the stored preset and never recreates a missing folder.
 */
export function describeSessionCategoryPresetStatus(
  preset: SessionCategoryPreset | null,
  isDirectory: (path: string) => boolean,
): SessionCategoryPresetStatus | undefined {
  if (!preset?.workspace) return undefined
  return { workspace_exists: isDirectory(preset.workspace) }
}
