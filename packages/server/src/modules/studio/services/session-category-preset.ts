import { stat } from 'fs/promises'
import { logger } from '../public/logging'
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

const URL_SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i
// A parameter name is secret-like when one of its words is a secret word, or the
// whole name run together is a known compound. Words split on anything but a-z0-9
// and on camelCase boundaries, so x-api-key, subscription-key, client_secret, auth,
// api_key[], signature and accessToken match, while design, author, keyspace,
// monkey, authuser, max_tokens, api-version and version do not.
const SECRET_PARAM_WORDS = new Set([
  'key', 'apikey', 'token', 'secret', 'password', 'passwd', 'pwd', 'sig', 'signature',
  'auth', 'authorization', 'credential', 'credentials', 'accesstoken', 'sessiontoken',
])
const SECRET_PARAM_COMPOUNDS = new Set([
  'apikey', 'xapikey', 'subscriptionkey', 'clientsecret', 'accesstoken', 'authtoken', 'sessiontoken',
])

/** Lowercase words of a parameter name, split on non-alphanumerics and camelCase boundaries. */
function paramNameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** True when a query/fragment parameter name looks like it carries a secret. */
export function isSecretLikeParamName(name: string): boolean {
  let decoded = name
  try {
    decoded = decodeURIComponent(name.replace(/\+/g, ' '))
  } catch {
    // Malformed escapes: match the raw spelling.
  }
  const words = paramNameWords(decoded)
  return words.some((word) => SECRET_PARAM_WORDS.has(word)) || SECRET_PARAM_COMPOUNDS.has(words.join(''))
}

/** The text before the first path, query or fragment separator, after an optional scheme. */
function textualAuthorities(raw: string): string[] {
  const authority = (text: string) => text.replace(/^[/\\]+/, '').split(/[/\\?#]/, 1)[0]
  const withoutScheme = raw.replace(URL_SCHEME_PREFIX, '')
  return withoutScheme === raw ? [authority(raw)] : [authority(withoutScheme), authority(raw)]
}

/** Parameter names in the query string, read textually so no URL parser quirk hides one. */
function textualQueryParamNames(raw: string): string[] {
  const queryStart = raw.indexOf('?')
  if (queryStart < 0) return []
  return raw.slice(queryStart + 1).split('#', 1)[0].split(/[&;]/).map(part => part.split('=', 1)[0])
}

/**
 * True when a Base URL embeds credentials or anything that could smuggle one.
 * Presets are shared, so the value is refused when ANY of these hold:
 * - a textual `@` in the authority (`https://u:p@h`, `https:u:p@h`, `http:\\u:p@h`, `u:p@h`);
 * - URL userinfo in either reading: the raw value when it starts with a scheme
 *   (WHATWG URL accepts `https:u:p@h`, `https:/u:p@h`, `http:\\u:p@h`), and the
 *   `http://`-prefixed value (the New Chat panel accepts scheme-less `localhost:11434/v1`);
 * - a query parameter whose name looks secret (see isSecretLikeParamName), in either
 *   reading or in the raw text, percent-decoded and case/`-`/`_` insensitive;
 * - any non-empty `#fragment`. HTTP clients never send a fragment, so it has no
 *   function in an API Base URL; one can only be a mistake or data (`#api_key=…`)
 *   stored in a preset everyone sees. Real API base URLs never carry one.
 * Keep this identical to the client copy (category-new-chat-preset.ts).
 */
export function presetBaseUrlCarriesCredentials(value: string): boolean {
  const raw = value.trim()
  if (!raw) return false
  if (/#./s.test(raw)) return true
  if (textualAuthorities(raw).some(authority => authority.includes('@'))) return true
  if (textualQueryParamNames(raw).some(isSecretLikeParamName)) return true
  const readings = URL_SCHEME_PREFIX.test(raw) ? [raw, `http://${raw}`] : [`http://${raw}`]
  for (const reading of readings) {
    let url: URL
    try {
      url = new URL(reading)
    } catch {
      continue
    }
    if (url.username || url.password) return true
    for (const name of url.searchParams.keys()) {
      if (isSecretLikeParamName(name)) return true
    }
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
    throw new SessionCategoryPresetError('Preset Base URL cannot contain credentials (user:password@, key/token query parameters or a #fragment)')
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

export interface StoredSessionCategoryPreset {
  preset: SessionCategoryPreset | null
  /** The stored Base URL failed the filter and was dropped (with its API mode). */
  baseUrlDropped: boolean
}

/**
 * Lenient read of a stored preset column. Unknown, credential, or invalid
 * fields (for example an enum value a newer build wrote) are dropped one by
 * one; the rest of the preset is kept. A dropped Base URL takes its API mode
 * with it (the mode was chosen for that endpoint) and is reported so the UI can
 * warn. Only unparseable JSON yields a null preset.
 */
export function readStoredSessionCategoryPreset(raw: unknown): StoredSessionCategoryPreset {
  const none = { preset: null, baseUrlDropped: false }
  if (typeof raw !== 'string' || !raw.trim()) return none
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return none
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return none
  const record = parsed as Record<string, unknown>
  const preset: Record<string, string | undefined> = {}
  const dropped = new Set<keyof SessionCategoryPreset>()
  for (const key of FIELD_ORDER) {
    try {
      preset[key] = readField(key, record[key])
    } catch {
      preset[key] = undefined
      dropped.add(key)
    }
  }
  const baseUrlDropped = dropped.has('baseUrl')
  if (baseUrlDropped) preset.apiMode = undefined
  const typed = preset as SessionCategoryPreset
  // Drop the field a combination rule points at, then re-check (at most a couple of passes).
  for (let invalid = combinationError(typed); invalid; invalid = combinationError(typed)) {
    delete typed[invalid.field]
  }
  return { preset: compact(typed), baseUrlDropped }
}

export function parseStoredSessionCategoryPreset(raw: unknown): SessionCategoryPreset | null {
  return readStoredSessionCategoryPreset(raw).preset
}

export function serializeSessionCategoryPreset(preset: SessionCategoryPreset | null): string {
  return preset ? JSON.stringify(preset) : ''
}

export interface SessionCategoryPresetStatus {
  /** false when the preset workspace folder no longer exists; omitted when the preset has no workspace or the check was inconclusive. */
  workspace_exists?: boolean
  /** true when the stored Base URL (and its API mode) was dropped on read; its value is never sent. */
  base_url_dropped?: true
}

/** true = directory, false = missing / not a directory, undefined = unknown (timeout or other error). */
export type DirectoryProbe = (path: string) => Promise<boolean | undefined>

export const PRESET_WORKSPACE_STAT_TIMEOUT_MS = 500
export const PRESET_WORKSPACE_PROBE_TTL_MS = 30_000
const LIBUV_THREADPOOL_SIZE = Number(process.env.UV_THREADPOOL_SIZE) || 4
// Healthy stats at once; stays below the libuv threadpool size (4 by default).
export const PRESET_WORKSPACE_PROBE_MAX_IN_FLIGHT = Math.max(1, LIBUV_THREADPOOL_SIZE - 2)
// Worker threads the probe may hold at all, stale-busy stats included (3 by default):
// hung stats on a stale mount hold a worker each, and must never take every worker
// from other fs/dns/crypto work.
export const PRESET_WORKSPACE_PROBE_MAX_THREADS = Math.max(1, LIBUV_THREADPOOL_SIZE - 1)
export const PRESET_WORKSPACE_PROBE_STALE_MS = 30_000
const PRESET_WORKSPACE_PROBE_CACHE_LIMIT = 256

export interface DirectoryProbeOptions {
  statFn?: (path: string) => Promise<{ isDirectory(): boolean }>
  timeoutMs?: number
  ttlMs?: number
  maxInFlight?: number
  /** Stats (running plus stale-busy) that may hold a worker thread at once. */
  maxThreads?: number
  /** A stat still running after this long is "stale-busy" (see createDirectoryProbe). */
  staleMs?: number
  now?: () => number
  onStale?: (path: string, runningMs: number) => void
}

interface ProbeEntry {
  /** Set once the stat has started; a queued entry waits for a free slot. */
  startedAt?: number
  stale: boolean
  /** Callers still waiting; each removes itself on its own timeout, so a hang keeps this bounded. */
  waiters: Set<(value: boolean | undefined) => void>
}

function logStaleProbe(path: string, runningMs: number) {
  logger.warn({ path, runningMs }, '[session-category-preset] workspace check still running; treating the folder as unknown until it finishes')
}

/**
 * Directory probe for preset workspaces, shared by the whole process.
 *
 * A stat on a stale network mount can hang and keep a libuv worker thread busy
 * long after we stop waiting, so:
 * - the caller never waits more than `timeoutMs`; a slow check is "unknown";
 * - at most one stat per path runs at a time; callers join it through one
 *   shared settle handler and a waiter set (no listener per caller);
 * - at most `maxInFlight` healthy stats run at once; other paths queue for a free
 *   slot within their callers' timeout, and leave the queue when no caller waits any more;
 * - a stat running longer than `staleMs` is stale-busy: logged once, answered
 *   "unknown" at once, and never restarted until it settles. It leaves the
 *   `maxInFlight` slots (one hung mount must not block every other path) but keeps
 *   its thread, and at most `maxThreads` stats hold a thread in total: once
 *   stale-busy stats use them all, new paths answer "unknown" at once instead of queueing;
 * - settled answers are cached for `ttlMs`, so reopening the drawer does not stat again.
 * Paths are resolved the way a chat run resolves them (resolveRunWorkspacePath).
 */
export interface SharedDirectoryProbe extends DirectoryProbe {
  /** Callers currently waiting on any check (diagnostics and tests). */
  waiting(): number
}

export function createDirectoryProbe(options: DirectoryProbeOptions = {}): SharedDirectoryProbe {
  const statFn = options.statFn ?? stat
  const timeoutMs = options.timeoutMs ?? PRESET_WORKSPACE_STAT_TIMEOUT_MS
  const ttlMs = options.ttlMs ?? PRESET_WORKSPACE_PROBE_TTL_MS
  const maxInFlight = options.maxInFlight ?? PRESET_WORKSPACE_PROBE_MAX_IN_FLIGHT
  const maxThreads = Math.max(1, options.maxThreads ?? PRESET_WORKSPACE_PROBE_MAX_THREADS)
  const staleMs = options.staleMs ?? PRESET_WORKSPACE_PROBE_STALE_MS
  const now = options.now ?? Date.now
  const onStale = options.onStale ?? logStaleProbe
  const cache = new Map<string, { value: boolean | undefined; expiresAt: number }>()
  /** Running and queued checks by path; Map order keeps the queue first-in, first-out. */
  const entries = new Map<string, ProbeEntry>()
  /** Healthy stats in progress (count toward maxInFlight). */
  let running = 0
  /** Stats past staleMs that still hold a thread (count toward maxThreads only). */
  let staleBusy = 0

  const canStart = () => running < maxInFlight && running + staleBusy < maxThreads
  const threadsExhausted = () => staleBusy >= maxThreads

  function remember(key: string, value: boolean | undefined) {
    cache.delete(key)
    cache.set(key, { value, expiresAt: now() + ttlMs })
    if (cache.size > PRESET_WORKSPACE_PROBE_CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
  }

  function markStale() {
    const time = now()
    let marked = false
    for (const [key, entry] of entries) {
      if (entry.startedAt === undefined || entry.stale || time - entry.startedAt < staleMs) continue
      entry.stale = true
      running -= 1
      staleBusy += 1
      marked = true
      onStale(key, time - entry.startedAt)
    }
    if (marked) drain()
  }

  function start(key: string, entry: ProbeEntry) {
    entry.startedAt = now()
    running += 1
    new Promise<{ isDirectory(): boolean }>(done => done(statFn(key)))
      .then(
        info => info.isDirectory(),
        (error: NodeJS.ErrnoException) => (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? false : undefined),
      )
      .catch(() => undefined)
      .then((value) => {
        if (entry.stale) staleBusy -= 1
        else running -= 1
        entries.delete(key)
        remember(key, value)
        for (const settle of entry.waiters) settle(value)
        drain()
      })
  }

  function drain() {
    for (const [key, entry] of entries) {
      if (entry.startedAt !== undefined) continue
      if (threadsExhausted()) {
        // No stat can start until a hung one settles: answer queued callers now.
        entries.delete(key)
        for (const settle of [...entry.waiters]) settle(undefined)
        continue
      }
      if (!canStart()) return
      start(key, entry)
    }
  }

  const probe: DirectoryProbe = (path) => {
    const key = resolveRunWorkspacePath(path)
    const cached = cache.get(key)
    if (cached && cached.expiresAt > now()) return Promise.resolve(cached.value)

    markStale()
    let entry = entries.get(key)
    if (entry?.stale) return Promise.resolve(undefined)
    if (!entry) {
      if (threadsExhausted()) return Promise.resolve(undefined)
      entry = { stale: false, waiters: new Set() }
      entries.set(key, entry)
      if (canStart()) start(key, entry)
    }

    const joined = entry
    return new Promise((resolve) => {
      const settle = (value: boolean | undefined) => {
        clearTimeout(timer)
        joined.waiters.delete(settle)
        resolve(value)
      }
      const timer = setTimeout(() => {
        settle(undefined)
        // Nobody waits for a queued check any more: drop it instead of keeping it around.
        if (joined.startedAt === undefined && joined.waiters.size === 0) entries.delete(key)
      }, timeoutMs)
      timer.unref?.()
      joined.waiters.add(settle)
    })
  }

  return Object.assign(probe, {
    waiting: () => [...entries.values()].reduce((total, entry) => total + entry.waiters.size, 0),
  })
}

export const probeDirectory: DirectoryProbe = createDirectoryProbe()

/**
 * Read-only availability check for preset values that only the server can see.
 * It never modifies the stored preset and never recreates a missing folder.
 */
export async function describeSessionCategoryPresetStatus(
  preset: SessionCategoryPreset | null,
  isDirectory: DirectoryProbe,
  stored: { baseUrlDropped?: boolean } = {},
): Promise<SessionCategoryPresetStatus | undefined> {
  const status: SessionCategoryPresetStatus = {}
  if (preset?.workspace) {
    const exists = await isDirectory(preset.workspace)
    if (exists !== undefined) status.workspace_exists = exists
  }
  if (stored.baseUrlDropped) status.base_url_dropped = true
  return Object.keys(status).length > 0 ? status : undefined
}
