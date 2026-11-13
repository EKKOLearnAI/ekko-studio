import type { Context } from 'koa'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { textToSpeech, openaiCompatibleTts, speedToEdgeRate } from '../services/voice/tts/core'
import { getTtsProvider } from '../services/voice/tts/providers'
import { transcodeToMp3 } from '../services/voice/stt/audio-convert'
import { assertSafeResolvedTtsBaseUrl } from '../services/voice/tts/providers/url-safety'
import { isValidMcuAudioFileName, resolveMcuAudioPath } from '../services/voice/mcu/prompts'
import {
  assertActiveTtsProvider,
  assertStoredTtsProvider,
  clearStoredTtsSecret,
  deleteTtsProviderSetting,
  getActiveTtsProvider,
  getTtsProviderSetting,
  isStoredTtsProvider,
  listTtsProviderSettings,
  removeTtsBaseUrlPreset,
  saveActiveTtsProvider,
  saveTtsProviderSetting,
  TtsSettingsValidationError,
} from '../public/voice-settings'
import { syncVoiceConfigToHermesProfile } from '../services/voice/config-sync'
import { listProfileNames } from '../public/profile-config'

function currentUserId(ctx: Context): number | null {
  const rawUserId = ctx.state?.user?.id
  const userId = typeof rawUserId === 'number' ? rawUserId : Number.NaN
  return Number.isInteger(userId) && userId > 0 ? userId : null
}

function authUserId(ctx: Context): number | null {
  const userId = currentUserId(ctx)
  if (!userId) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return null
  }
  return userId
}

function requestedProfile(ctx: Context): string {
  const queryProfile = typeof ctx.query?.profile === 'string' ? ctx.query.profile : ''
  const headerProfile = ctx.get?.('x-hermes-profile') || ''
  return (ctx.state?.profile?.name || queryProfile || headerProfile || 'default').trim() || 'default'
}

function requestedVoiceProxyProfile(ctx: Context): string | null {
  const profile = String(ctx.params?.profile || '').trim()
  return profile && listProfileNames().includes(profile) ? profile : null
}

function handleSettingsError(ctx: Context, error: unknown): boolean {
  if (error instanceof TtsSettingsValidationError) {
    ctx.status = 400
    ctx.body = { error: error.message }
    return true
  }
  return false
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
}

function mergeStoredTtsOptions(ctx: Context, providerName: string, options: Record<string, unknown>): Record<string, unknown> {
  const nonEmptyRequestOptions = Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== '' && value !== undefined && value !== null),
  )
  const requestOptionsWithoutApiKey = Object.fromEntries(
    Object.entries(nonEmptyRequestOptions).filter(([key]) => key !== 'apiKey'),
  )

  const userId = currentUserId(ctx)
  if (!userId || !isStoredTtsProvider(providerName)) {
    return nonEmptyRequestOptions
  }

  const stored = getTtsProviderSetting(requestedProfile(ctx), providerName, { includeSecrets: true })
  if (!stored) return nonEmptyRequestOptions

  const storedSecrets = stored.secrets.apiKey
    ? stored.secrets
    : {
      ...stored.secrets,
      ...(typeof nonEmptyRequestOptions.apiKey === 'string' ? { apiKey: nonEmptyRequestOptions.apiKey } : {}),
    }

  return {
    ...stored.settings,
    ...storedSecrets,
    ...requestOptionsWithoutApiKey,
  }
}

function resolveActiveTtsProvider(profile: string, userId: number | null, settings?: ReturnType<typeof listTtsProviderSettings>) {
  if (!userId) return 'edge'
  const active = getActiveTtsProvider(profile)
  if (active) return active
  const configured = (settings ?? listTtsProviderSettings(profile)).filter(setting => setting.provider !== 'edge')
  return configured.length === 1 ? configured[0].provider : 'edge'
}

export async function listSettings(ctx: Context) {
  const userId = authUserId(ctx)
  if (!userId) return

  try {
    const profile = requestedProfile(ctx)
    const settings = listTtsProviderSettings(profile)
    ctx.body = {
      settings,
      activeProvider: resolveActiveTtsProvider(profile, userId, settings),
    }
  } catch (error) {
    if (handleSettingsError(ctx, error)) return
    throw error
  }
}

export async function saveSettings(ctx: Context) {
  const userId = authUserId(ctx)
  if (!userId) return

  const provider = ctx.params.provider || ''
  const body = ctx.request.body as { settings?: unknown; secrets?: unknown; activeProvider?: unknown } | undefined

  try {
    const profile = requestedProfile(ctx)
    const storedProvider = assertStoredTtsProvider(provider)
    const setting = saveTtsProviderSetting(profile, storedProvider, {
      settings: body?.settings,
      secrets: body?.secrets,
    })
    const activeProvider = body?.activeProvider === undefined
      ? saveActiveTtsProvider(profile, storedProvider)
      : saveActiveTtsProvider(profile, assertActiveTtsProvider(String(body.activeProvider)))

    await syncVoiceConfigToHermesProfile(profile)
    ctx.body = { setting, activeProvider }
  } catch (error) {
    if (handleSettingsError(ctx, error)) return
    throw error
  }
}

export async function saveActiveProvider(ctx: Context) {
  const userId = authUserId(ctx)
  if (!userId) return

  const body = ctx.request.body as { provider?: unknown } | undefined

  try {
    const profile = requestedProfile(ctx)
    const activeProvider = saveActiveTtsProvider(profile, assertActiveTtsProvider(String(body?.provider || '')))
    await syncVoiceConfigToHermesProfile(profile)
    ctx.body = { activeProvider }
  } catch (error) {
    if (handleSettingsError(ctx, error)) return
    throw error
  }
}

export async function deleteBaseUrlPreset(ctx: Context) {
  const userId = authUserId(ctx)
  if (!userId) return

  const provider = ctx.params.provider || ''
  const rawUrl = typeof ctx.query.url === 'string' ? ctx.query.url : ''
  if (!rawUrl.trim()) {
    ctx.status = 400
    ctx.body = { error: 'baseUrl is required' }
    return
  }

  try {
    const profile = requestedProfile(ctx)
    const storedProvider = assertStoredTtsProvider(provider)
    const setting = removeTtsBaseUrlPreset(profile, storedProvider, rawUrl)
    ctx.body = { success: true, setting }
  } catch (error) {
    if (handleSettingsError(ctx, error)) return
    throw error
  }
}

export async function deleteSecret(ctx: Context) {
  const userId = authUserId(ctx)
  if (!userId) return

  const provider = ctx.params.provider || ''
  const secretName = ctx.params.secretName || ''

  try {
    const profile = requestedProfile(ctx)
    const storedProvider = assertStoredTtsProvider(provider)
    const setting = clearStoredTtsSecret(profile, storedProvider, secretName)
    await syncVoiceConfigToHermesProfile(profile)
    ctx.body = { success: true, setting }
  } catch (error) {
    if (handleSettingsError(ctx, error)) return
    throw error
  }
}

export async function deleteProvider(ctx: Context) {
  const userId = authUserId(ctx)
  if (!userId) return

  const provider = ctx.params.provider || ''

  try {
    const profile = requestedProfile(ctx)
    const storedProvider = assertStoredTtsProvider(provider)
    if (storedProvider === 'edge') {
      ctx.status = 400
      ctx.body = { error: 'built-in TTS provider cannot be deleted' }
      return
    }
    const deleted = deleteTtsProviderSetting(profile, storedProvider)
    const currentActiveProvider = getActiveTtsProvider(profile)
    const activeProvider = currentActiveProvider === storedProvider
      ? saveActiveTtsProvider(profile, 'edge')
      : currentActiveProvider
    await syncVoiceConfigToHermesProfile(profile)
    ctx.body = { success: true, deleted, activeProvider }
  } catch (error) {
    if (handleSettingsError(ctx, error)) return
    throw error
  }
}

type ProbeKind = 'tts' | 'stt'
type ProbeCompatibility = 'openai-compatible' | 'manual'

interface ProbeModel {
  id: string
  label: string
  capability: 'preferred' | 'other'
}

async function normalizeProbeBaseUrl(rawUrl: string): Promise<string> {
  const trimmed = rawUrl.trim()
  if (!trimmed) throw new Error('Base URL is required')

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('Enter a valid Base URL, including https://')
  }

  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  await assertSafeResolvedTtsBaseUrl(url, 'Provider probe')
  return url.toString().replace(/\/$/, '')
}

function buildOpenaiModelsUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  url.search = ''
  url.hash = ''
  let pathname = url.pathname.replace(/\/+$/, '')

  for (const suffix of ['/audio/speech', '/audio/transcriptions', '/chat/completions', '/responses']) {
    if (pathname.endsWith(suffix)) {
      pathname = pathname.slice(0, -suffix.length) || '/'
      break
    }
  }

  url.pathname = `${pathname.replace(/\/+$/, '')}/models`.replace(/\/+/g, '/')
  return url.toString()
}

function modelRank(kind: ProbeKind, id: string): number {
  const value = id.toLowerCase()
  if (kind === 'tts') {
    if (/tts|speech|audio|voice|playai|orpheus/.test(value)) return 0
    if (/whisper|transcrib|stt/.test(value)) return 3
    return 2
  }

  if (/whisper|transcrib|stt|speech-to-text/.test(value)) return 0
  if (/tts|audio-speech|voice|orpheus|playai/.test(value)) return 3
  return 2
}

function rankModels(kind: ProbeKind, ids: string[]): ProbeModel[] {
  return [...new Set(ids.map(id => id.trim()).filter(Boolean))]
    .sort((a, b) => {
      const rankDiff = modelRank(kind, a) - modelRank(kind, b)
      return rankDiff || a.localeCompare(b)
    })
    .slice(0, 100)
    .map(id => ({
      id,
      label: id,
      capability: modelRank(kind, id) === 0 ? 'preferred' : 'other',
    }))
}

function summarizeProbeError(error: unknown): { summary: string; details: string } {
  const message = sanitizeTtsError(error)
  if (/401|unauthorized|invalid api key|incorrect api key|authentication/i.test(message)) {
    return { summary: 'Authentication failed. Check the API key.', details: message }
  }
  if (/403|forbidden|permission|terms|billing|quota/i.test(message)) {
    return { summary: 'The key reached the provider, but access is blocked. Check permissions, terms, billing, or quota.', details: message }
  }
  if (/404|not found/i.test(message)) {
    return { summary: 'The model discovery endpoint was not found. Check the Base URL and compatibility type.', details: message }
  }
  if (/timeout|aborted/i.test(message)) {
    return { summary: 'Model discovery timed out. You can still enter the model manually.', details: message }
  }
  if (/fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET/i.test(message)) {
    return { summary: 'Could not reach the provider from the Web UI server. Check the Base URL and network access.', details: message }
  }
  return { summary: 'Could not fetch models. You can still enter the model name manually.', details: message }
}

async function fetchOpenaiCompatibleModels(kind: ProbeKind, baseUrl: string, apiKey: string, signal: AbortSignal): Promise<ProbeModel[]> {
  const modelsUrl = buildOpenaiModelsUrl(baseUrl)
  const res = await fetch(modelsUrl, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    signal,
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Model discovery returned ${res.status}: ${body || res.statusText}`)
  }

  const payload = await res.json().catch(() => null) as { data?: Array<{ id?: unknown }> } | null
  const ids = Array.isArray(payload?.data)
    ? payload.data.map(model => typeof model.id === 'string' ? model.id : '').filter(Boolean)
    : []

  if (!ids.length) {
    throw new Error('Model discovery returned no model IDs')
  }

  return rankModels(kind, ids)
}

export async function probeProvider(ctx: Context) {
  const body = (ctx.request.body || {}) as {
    kind?: unknown
    provider?: unknown
    compatibility?: unknown
    baseUrl?: unknown
    apiKey?: unknown
  }

  const kind = body.kind === 'tts' || body.kind === 'stt' ? body.kind : null
  const compatibility: ProbeCompatibility = body.compatibility === 'manual' ? 'manual' : 'openai-compatible'
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''

  if (!kind) {
    ctx.status = 400
    ctx.body = { ok: false, models: [], recommendedModel: '', errorSummary: 'Provider kind must be TTS or STT.', manualModelAllowed: true }
    return
  }

  let baseUrl = ''
  try {
    baseUrl = await normalizeProbeBaseUrl(typeof body.baseUrl === 'string' ? body.baseUrl : '')
  } catch (error) {
    ctx.status = 400
    const { summary, details } = summarizeProbeError(error)
    ctx.body = { ok: false, models: [], recommendedModel: '', errorSummary: summary, errorDetails: details, manualModelAllowed: true }
    return
  }

  if (compatibility === 'manual') {
    ctx.body = {
      ok: true,
      models: [],
      recommendedModel: '',
      errorSummary: '',
      manualModelAllowed: true,
      normalizedBaseUrl: baseUrl,
    }
    return
  }

  if (!apiKey) {
    ctx.status = 400
    ctx.body = { ok: false, models: [], recommendedModel: '', errorSummary: 'API key is required to fetch models.', manualModelAllowed: true, normalizedBaseUrl: baseUrl }
    return
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)

  try {
    const models = await fetchOpenaiCompatibleModels(kind, baseUrl, apiKey, controller.signal)
    const recommended = models.find(model => model.capability === 'preferred') || models[0] || null
    ctx.body = {
      ok: true,
      models,
      recommendedModel: recommended?.id || '',
      errorSummary: '',
      manualModelAllowed: true,
      normalizedBaseUrl: baseUrl,
    }
  } catch (error) {
    const { summary, details } = summarizeProbeError(error)
    ctx.status = 200
    ctx.body = {
      ok: false,
      models: [],
      recommendedModel: '',
      errorSummary: summary,
      errorDetails: details,
      manualModelAllowed: true,
      normalizedBaseUrl: baseUrl,
    }
  } finally {
    clearTimeout(timeout)
  }
}

export async function generate(ctx: Context) {
  const { text, lang } = ctx.request.body as {
    text?: string
    lang?: string
  }

  if (!text || typeof text !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'text is required' }
    return
  }

  if (text.length > 5000) {
    ctx.status = 400
    ctx.body = { error: 'text is too long (max 5000 characters)' }
    return
  }

  const { audio, engine } = await textToSpeech({ text, lang })

  ctx.set('Content-Type', 'audio/mpeg')
  ctx.set('Content-Length', String(audio.length))
  ctx.set('X-TTS-Engine', engine)
  ctx.body = audio
}

export async function synthesize(ctx: Context) {
  const body = ctx.request.body as {
    provider?: string
    text?: string
    options?: unknown
  }

  if (!body.text || typeof body.text !== 'string' || !body.text.trim()) {
    ctx.status = 400
    ctx.body = { error: 'text is required' }
    return
  }

  if (body.options !== undefined && (typeof body.options !== 'object' || body.options === null || Array.isArray(body.options))) {
    ctx.status = 400
    ctx.body = { error: 'options must be an object' }
    return
  }

  const requestOptions = asRecord(body.options)
  const userId = currentUserId(ctx)
  const providerName = body.provider || resolveActiveTtsProvider(requestedProfile(ctx), userId)
  const options = mergeStoredTtsOptions(ctx, providerName, requestOptions)

  const provider = getTtsProvider(providerName)
  if (!provider) {
    ctx.status = 400
    ctx.body = { error: 'unknown TTS provider' }
    return
  }

  const controller = createRequestAbortController(ctx)

  try {
    const result = await provider.synthesize(
      { text: body.text, signal: controller.signal },
      options,
    )

    ctx.set('Content-Type', result.contentType)
    ctx.set('Content-Length', String(result.audio.length))
    ctx.set('X-TTS-Engine', result.engine)
    ctx.set('X-TTS-Provider', result.provider)
    ctx.body = result.audio
  } catch (error) {
    if (isAbortError(error)) {
      ctx.status = 499
      ctx.body = { error: 'TTS request aborted' }
      return
    }

    ctx.status = statusForTtsError(error)
    ctx.body = {
      error: 'TTS synthesis failed',
      detail: sanitizeTtsError(error),
    }
  }
}

async function synthesizeVoiceProxyText(ctx: Context, text: string) {
  const profile = requestedVoiceProxyProfile(ctx)
  if (!profile) {
    ctx.status = 404
    ctx.body = { error: 'unknown Hermes profile' }
    return
  }

  const normalizedText = text.trim()
  if (!normalizedText) {
    ctx.status = 400
    ctx.body = { error: 'text is required' }
    return
  }
  if (normalizedText.length > 5000) {
    ctx.status = 400
    ctx.body = { error: 'text is too long (max 5000 characters)' }
    return
  }

  const providerName = getActiveTtsProvider(profile) || 'edge'
  const stored = getTtsProviderSetting(profile, providerName, { includeSecrets: true })
  const options = {
    ...(stored?.settings || {}),
    ...(stored?.secrets || {}),
    // Hermes' command provider writes to an .mp3 output path. A provider that
    // cannot produce mp3 answers in whatever format it does support, and the
    // response is transcoded below.
    format: 'mp3',
  }
  const provider = getTtsProvider(providerName)
  if (!provider) {
    ctx.status = 400
    ctx.body = { error: 'unknown Web UI TTS provider' }
    return
  }

  const controller = createRequestAbortController(ctx)
  try {
    const result = await provider.synthesize(
      { text: normalizedText, signal: controller.signal },
      options,
    )
    const mp3 = await transcodeToMp3(result.audio, result.contentType)
    ctx.set('Content-Type', mp3.mimeType)
    ctx.set('Content-Length', String(mp3.audio.length))
    ctx.set('X-TTS-Engine', 'hermes-studio')
    ctx.body = mp3.audio
  } catch (error) {
    if (isAbortError(error)) {
      ctx.status = 499
      ctx.body = { error: 'TTS request aborted' }
      return
    }
    ctx.status = statusForTtsError(error)
    ctx.body = {
      error: 'Ekko Studio TTS failed',
      detail: sanitizeTtsError(error),
    }
  }
}

/**
 * Command-provider endpoint used by Hermes Agent's `hermes-studio` provider.
 * The server token is accepted only for loopback requests by user-auth.
 */
export async function synthesizeVoiceProxy(ctx: Context) {
  const body = ctx.request.body
  await synthesizeVoiceProxyText(ctx, typeof body === 'string' ? body : '')
}

/**
 * OpenAI-compatible companion endpoint for clients that can call HTTP
 * providers directly instead of Hermes' command-provider bridge.
 */
export async function synthesizeVoiceProxyOpenAi(ctx: Context) {
  const body = ctx.request.body as { input?: unknown } | undefined
  await synthesizeVoiceProxyText(ctx, typeof body?.input === 'string' ? body.input : '')
}

function statusForTtsError(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error)
  const upstreamStatus = /returned\s+(\d{3})/.exec(message)?.[1]
  const parsedStatus = upstreamStatus ? Number(upstreamStatus) : Number.NaN

  if (Number.isInteger(parsedStatus) && parsedStatus >= 400 && parsedStatus < 500) {
    return parsedStatus
  }

  if (/baseUrl|api key|apiKey|model|voice|required|empty/i.test(message)) {
    return 400
  }

  return 502
}

function sanitizeTtsError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const redacted = raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-[redacted]')
    .replace(/"api[_-]?key"\s*:\s*"[^"]+"/gi, '"apiKey":"[redacted]"')
    .replace(/'api[_-]?key'\s*:\s*'[^']+'/gi, "'apiKey':'[redacted]'")
    .replace(/api[_-]?key=[^\s&]+/gi, 'apiKey=[redacted]')
    .replace(/\*{3,}/g, '[redacted]')

  return redacted.length > 600 ? `${redacted.slice(0, 600)}…` : redacted
}

function createRequestAbortController(ctx: Context): AbortController {
  const controller = new AbortController()

  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort()
    }
  }

  if (ctx.req?.on) {
    // IncomingMessage "close" fires after the request body is fully consumed in
    // normal POSTs, which aborted every TTS test request before synthesis could
    // complete. Only "aborted" is a reliable client-disconnect signal here.
    ctx.req.on('aborted', abort)
  }

  if (ctx.res?.on) {
    ctx.res.on('close', () => {
      // ServerResponse "close" also fires after successful completion; abort
      // only when the response did not finish normally.
      if (!ctx.res.writableEnded) {
        abort()
      }
    })
  }

  return controller
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}

/**
 * OpenAI-compatible TTS endpoint.
 * Accepts: { model, input, voice, speed }
 * Returns audio/mpeg stream.
 */
export async function openaiProxy(ctx: Context) {
  const body = ctx.request.body as {
    input?: string
    voice?: string
    speed?: number
    model?: string
    rate?: string
    pitch?: string
  }

  if (!body.input || typeof body.input !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'input is required' }
    return
  }

  if (body.input.length > 5000) {
    ctx.status = 400
    ctx.body = { error: 'input is too long (max 5000 characters)' }
    return
  }

  const { audio, engine } = await openaiCompatibleTts({
    input: body.input,
    voice: body.voice,
    speed: body.speed,
    model: body.model,
    rate: body.rate,
    pitch: body.pitch,
  })

  ctx.set('Content-Type', 'audio/mpeg')
  ctx.set('Content-Length', String(audio.length))
  ctx.set('X-TTS-Engine', engine)
  ctx.body = audio
}

export async function mcuAudio(ctx: Context) {
  const file = String(ctx.params.file || '').trim()
  if (!isValidMcuAudioFileName(file)) {
    ctx.status = 404
    ctx.body = { error: 'audio not found' }
    return
  }

  try {
    const audio = await resolveMcuAudioPath(file)
    if (!audio) {
      ctx.status = 404
      ctx.body = { error: 'audio not found' }
      return
    }
    const info = await stat(audio.path)
    if (!info.isFile()) {
      ctx.status = 404
      ctx.body = { error: 'audio not found' }
      return
    }
    ctx.set('Content-Type', file.toLowerCase().endsWith('.adpcm') ? 'audio/x-ima-adpcm' : 'audio/x-pcm')
    ctx.set('Content-Length', String(info.size))
    ctx.set('Cache-Control', audio.bundled ? 'public, max-age=31536000, immutable' : 'no-store')
    ctx.body = createReadStream(audio.path)
  } catch {
    ctx.status = 404
    ctx.body = { error: 'audio not found' }
  }
}
