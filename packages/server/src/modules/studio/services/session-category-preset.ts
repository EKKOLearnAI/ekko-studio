import { stat } from 'fs/promises'
import { resolveRunWorkspacePath } from './workspace/manager'

/**
 * New Chat preset stored on a session category.
 *
 * Every field is optional: an empty preset field means "use today's New Chat
 * default". Presets are shared by everyone who can see categories, so they
 * must never carry credentials (API keys).
 *
 * Validation mirrors the New Chat panel: only rules the panel itself has
 * (MoA only with Hermes, a DSH preset only with DeepSeek Harness), plus
 * storage sanity limits. The workspace is stored as entered, relative paths
 * included, exactly like the panel. One deliberate exception: a Base URL that
 * carries credentials (URL userinfo or a secret-looking query parameter) is
 * refused, because presets are shared and must never hold keys.
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

const SECRET_QUERY_PARAMS = new Set(['key', 'api_key', 'apikey', 'token', 'access_token', 'secret', 'password', 'sig'])

/**
 * True when a Base URL embeds credentials: URL userinfo (`https://user:pass@host`)
 * or a query parameter named like a secret (`?api_key=…`, case-insensitive).
 * Scheme-less values (`localhost:11434/v1`), which the New Chat panel accepts,
 * are parsed as http URLs.
 */
export function presetBaseUrlCarriesCredentials(value: string): boolean {
  const raw = value.trim()
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`)
  } catch {
    // Unparseable: fall back to the textual shapes.
    return /^(?:[a-z][a-z0-9+.-]*:\/\/)?[^/?#]*@/i.test(raw)
      || /[?&](?:key|api[_-]?key|token|access[_-]token|secret|password|sig)=/i.test(raw)
  }
  if (url.username || url.password) return true
  for (const name of url.searchParams.keys()) {
    if (SECRET_QUERY_PARAMS.has(name.toLowerCase().replace(/-/g, '_'))) return true
  }
  return false
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
  if (key === 'baseUrl' && presetBaseUrlCarriesCredentials(trimmed)) {
    throw new SessionCategoryPresetError('Preset Base URL cannot contain credentials (user:password@ or key/token query parameters)')
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
 * fields (for example an enum value a newer build wrote) are dropped one by
 * one; the rest of the preset is kept. Only unparseable JSON yields null.
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
export const PRESET_WORKSPACE_PROBE_TTL_MS = 30_000
export const PRESET_WORKSPACE_PROBE_MAX_IN_FLIGHT = 4
const PRESET_WORKSPACE_PROBE_CACHE_LIMIT = 256

export interface DirectoryProbeOptions {
  statFn?: (path: string) => Promise<{ isDirectory(): boolean }>
  timeoutMs?: number
  ttlMs?: number
  maxInFlight?: number
  now?: () => number
}

/**
 * Directory probe for preset workspaces, shared by the whole process.
 *
 * A stat on a stale network mount can hang and keep a libuv worker thread busy
 * long after we stop waiting, so:
 * - the caller never waits more than `timeoutMs`; a slow check is "unknown";
 * - at most one stat per path runs at a time (callers join the pending one);
 * - at most `maxInFlight` stats run at once; beyond that the answer is "unknown";
 * - settled answers are cached for `ttlMs`, so reopening the drawer does not stat again.
 * Paths are resolved the way a chat run resolves them (resolveRunWorkspacePath).
 */
export function createDirectoryProbe(options: DirectoryProbeOptions = {}): DirectoryProbe {
  const statFn = options.statFn ?? stat
  const timeoutMs = options.timeoutMs ?? PRESET_WORKSPACE_STAT_TIMEOUT_MS
  const ttlMs = options.ttlMs ?? PRESET_WORKSPACE_PROBE_TTL_MS
  const maxInFlight = options.maxInFlight ?? PRESET_WORKSPACE_PROBE_MAX_IN_FLIGHT
  const now = options.now ?? Date.now
  const cache = new Map<string, { value: boolean | undefined; expiresAt: number }>()
  const inFlight = new Map<string, Promise<boolean | undefined>>()

  function remember(key: string, value: boolean | undefined) {
    cache.delete(key)
    cache.set(key, { value, expiresAt: now() + ttlMs })
    if (cache.size > PRESET_WORKSPACE_PROBE_CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
  }

  return (path) => {
    const key = resolveRunWorkspacePath(path)
    const cached = cache.get(key)
    if (cached && cached.expiresAt > now()) return Promise.resolve(cached.value)

    let pending = inFlight.get(key)
    if (!pending) {
      if (inFlight.size >= maxInFlight) return Promise.resolve(undefined)
      pending = statFn(key).then(
        info => info.isDirectory(),
        (error: NodeJS.ErrnoException) => (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? false : undefined),
      ).then((value) => {
        inFlight.delete(key)
        remember(key, value)
        return value
      })
      inFlight.set(key, pending)
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), timeoutMs)
      timer.unref?.()
      pending!.then((value) => { clearTimeout(timer); resolve(value) })
    })
  }
}

export const probeDirectory: DirectoryProbe = createDirectoryProbe()

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
