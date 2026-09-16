import type { Context } from 'koa'
import type { TtsSynthesisResult } from '../services/voice/tts/providers/types'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { textToSpeech, openaiCompatibleTts, speedToEdgeRate } from '../services/voice/tts/core'
import { getTtsProvider } from '../services/voice/tts/providers'
import { updateUsage } from '../repositories/usage-store'
import { prepareSpeechText, normalizeSpeechPreprocessingConfig, splitSpeechSegments } from '../services/voice/tts/speech-preprocess'
import { readAppConfig, writeAppConfig } from '../services/config/app-config'
import { transcodeToMp3 } from '../services/voice/stt/audio-convert'
import { assertSafeResolvedTtsBaseUrl } from '../services/voice/tts/providers/url-safety'
import { isValidMcuAudioFileName, resolveMcuAudioPath } from '../services/voice/mcu/prompts'
import { logger } from '../public/logging'
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
// ---------------------------------------------------------------------------
// TTS fallback 链（备用降级，B 方案）
// ---------------------------------------------------------------------------
// 配置：config.json ttsFallback.<profile> = { enabled, providers: [备用有序], perProviderTimeoutMs }
// 行为：UI 播放 synthesize 时主 provider 失败 → 错误分类判断 → 切下一家备用。
//   可切：网络/代理错误、无状态错误(超时 abort)、429 限流、5xx 服务端错误
//   不切：401/403/404 等其余 4xx（配置问题，切换无意义，直接暴露）
// 试听/直测：请求带 skipFallback=true 时链只含主 provider（防止 fallback 掩盖真实可用性）
// 响应头 X-TTS-Provider 标注实际命中的 provider（可能与请求的不一致）。
// 存储沿用 config.json（与 speechPreprocessing 同约定；上游化时再评估 DB migration）。

const TTS_FALLBACK_DEFAULT_TIMEOUT_MS = 12_000
const TTS_FALLBACK_DEFAULT_PRIMARY_TIMEOUT_MS = 45_000
const TTS_FALLBACK_MAX_CHAIN = 5

interface TtsFallbackConfig {
  enabled: boolean
  providers: string[]
  perProviderTimeoutMs: number
  /** 主 provider 尝试窗口：长文本合成本来就慢，但仍需兜底（避免 UI 永久转圈） */
  primaryTimeoutMs: number
}

function normalizeTtsFallbackConfig(value: unknown): TtsFallbackConfig {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const providers = Array.isArray(raw.providers)
    ? raw.providers
        .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        .map(p => p.trim())
    : []
  const timeoutMs =
    typeof raw.perProviderTimeoutMs === 'number' && Number.isFinite(raw.perProviderTimeoutMs)
      ? Math.min(Math.max(Math.floor(raw.perProviderTimeoutMs), 3_000), 60_000)
      : TTS_FALLBACK_DEFAULT_TIMEOUT_MS
  const primaryTimeoutMs =
    typeof raw.primaryTimeoutMs === 'number' && Number.isFinite(raw.primaryTimeoutMs)
      ? Math.min(Math.max(Math.floor(raw.primaryTimeoutMs), 5_000), 300_000)
      : TTS_FALLBACK_DEFAULT_PRIMARY_TIMEOUT_MS
  return { enabled: raw.enabled === true, providers, perProviderTimeoutMs: timeoutMs, primaryTimeoutMs }
}

function statusCodeFromTtsError(error: unknown): number | null {
  const msg = error instanceof Error ? error.message : String(error)
  const match = /(?:returned|HTTP|status)\s*(\d{3})/i.exec(msg)
  return match ? Number(match[1]) : null
}

/** B 方案错误分类：无状态错误(网络/代理/超时 abort) 与 429/5xx 可切；其余 4xx 不切 */
function shouldFallbackForTtsError(error: unknown): boolean {
  const status = statusCodeFromTtsError(error)
  if (status === null) return true
  return status === 429 || status >= 500
}

async function readTtsFallbackConfig(ctx: Context): Promise<TtsFallbackConfig> {
  const appConfig = await readAppConfig()
  const value = appConfig.ttsFallback?.[requestedProfile(ctx)] ?? appConfig.ttsFallback?.default
  return normalizeTtsFallbackConfig(value)
}

function buildTtsFallbackChain(providerName: string, fb: TtsFallbackConfig): string[] {
  const chain = [providerName]
  if (!fb.enabled) return chain
  for (const candidate of fb.providers) {
    if (chain.length >= TTS_FALLBACK_MAX_CHAIN) break
    if (chain.includes(candidate)) continue
    // 备用必须"服务端已实现 + 该 profile 已配置"，否则跳过（缺配置的备用等于没用）
    if (!getTtsProvider(candidate) || !isStoredTtsProvider(candidate)) continue
    chain.push(candidate)
  }
  return chain
}

interface RunTtsFallbackChainArgs {
  ctx: Context
  providerName: string
  speechText: string
  outerSignal: AbortSignal
  requestOptions: Record<string, unknown>
  skipFallback: boolean
}

export async function runTtsFallbackChain(args: RunTtsFallbackChainArgs): Promise<TtsSynthesisResult> {
  const { ctx, providerName, speechText, outerSignal, requestOptions, skipFallback } = args
  const fb = await readTtsFallbackConfig(ctx)
  const chain = skipFallback ? [providerName] : buildTtsFallbackChain(providerName, fb)
  const chainStart = Date.now()

  let lastError: unknown = null
  for (const attemptProvider of chain) {
    const attempt = getTtsProvider(attemptProvider)
    if (!attempt) continue

    const perProviderController = new AbortController()
    // 主 provider 不做内部超时（长文本合成本来就慢，如 fishaudio 免费档 ~24s/1MB）；
    // 备用 provider 才用 perProviderTimeoutMs 窗口，避免每家都拖很久。
    const isPrimary = attemptProvider === chain[0]
    const attemptStart = Date.now()
    const timer = isPrimary
      ? setTimeout(() => perProviderController.abort(), fb.primaryTimeoutMs)
      : setTimeout(() => perProviderController.abort(), fb.perProviderTimeoutMs)
    const onOuterAbort = () => perProviderController.abort()
    if (outerSignal.aborted) perProviderController.abort()
    else outerSignal.addEventListener('abort', onOuterAbort)

    try {
      const attemptOptions = mergeStoredTtsOptions(ctx, attemptProvider, requestOptions)
      const result = await attempt.synthesize(
        { text: speechText, signal: perProviderController.signal },
        attemptOptions,
      )
      const durationMs = Date.now() - attemptStart
      logger.info({
        provider: attemptProvider,
        textChars: speechText.length,
        durationMs,
        chainPosition: chain.indexOf(attemptProvider),
        chainLength: chain.length,
        chainTotalMs: Date.now() - chainStart,
        aborted: false,
        result: 'success',
      }, '[tts-chain] attempt succeeded')
      return result
    } catch (error) {
      lastError = error
      const durationMs = Date.now() - attemptStart
      const abortedByUser = outerSignal.aborted
      const timedOut = !abortedByUser && perProviderController.signal.aborted
      const message = error instanceof Error ? error.message : String(error)
      logger.warn({
        err: error,
        provider: attemptProvider,
        textChars: speechText.length,
        durationMs,
        chainPosition: chain.indexOf(attemptProvider),
        chainLength: chain.length,
        aborted: true,
        abortedByUser,
        timedOut,
        message: message.slice(0, 300),
      }, '[tts-chain] attempt failed')
      if (abortedByUser) throw error // 用户主动断开 → 上层 499 处理，不参与 fallback
      if (!shouldFallbackForTtsError(error) || attemptProvider === chain[chain.length - 1]) throw error
    } finally {
      if (timer) clearTimeout(timer)
      outerSignal.removeEventListener('abort', onOuterAbort)
    }
  }
  throw lastError ?? new Error('TTS synthesis failed: no provider available')
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
    /** true=试听/直测，绕过 fallback；false(默认)=UI 播放走备用降级 */
    skipFallback?: boolean
    /** true=跳过语音预处理（已编辑好的稿子直接合成，避免二次改写） */
    skipPreprocess?: boolean
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
  const skipFallback = body.skipFallback === true

  if (!getTtsProvider(providerName)) {
    ctx.status = 400
    ctx.body = { error: 'unknown TTS provider' }
    return
  }

  const controller = createRequestAbortController(ctx)

  try {
    // 语音预处理管线：规则清洗 → 智能触发 → 模型转述（超时降级规则层）。
    // 任何失败都回退原文本，绝不阻断播放。
    const speechText =
      body.skipPreprocess === true
        ? String(body.text ?? '')
        : await prepareSpeechText(body.text, controller.signal, requestedProfile(ctx))

    // TTS fallback 链：主 provider → 备用有序列表（错误分类切换 + 每 provider 独立超时窗口）
    const result = await runTtsFallbackChain({
      ctx,
      providerName,
      speechText,
      outerSignal: controller.signal,
      requestOptions,
      skipFallback,
    })

    ctx.set('Content-Type', result.contentType)
    ctx.set('Content-Length', String(result.audio.length))
    ctx.set('X-TTS-Engine', result.engine)
    ctx.set('X-TTS-Provider', result.provider)
    // #11 用量统计：TTS 成功时写一行（fire-and-forget；不影响播放延迟）
    try {
      updateUsage(requestedProfile(ctx) || 'default', {
        runId: '',
        source: 'tts',
        agent: result.provider,
        usageScope: 'model_call',
        purpose: 'tts_synthesize',
        apiCalls: 1,
        inputTokens: result.audio.length,
        outputTokens: speechText.length,
        model: result.engine,
        provider: result.provider,
        profile: requestedProfile(ctx) || 'default',
        isEstimated: false,
      })
    } catch {}
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

// ---------------------------------------------------------------------------
// 语音预处理（speech-preprocessing）配置读写
// ---------------------------------------------------------------------------

export async function getSpeechPreprocessing(ctx: Context) {
  const profile = requestedProfile(ctx)
  const appConfig = await readAppConfig()
  const stored = appConfig.speechPreprocessing?.[profile]
  ctx.body = {
    profile,
    config: normalizeSpeechPreprocessingConfig(stored),
  }
}

export async function updateSpeechPreprocessing(ctx: Context) {
  const body = ctx.request.body as Record<string, unknown> | null
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    ctx.status = 400
    ctx.body = { error: 'body must be an object' }
    return
  }

  const profile = requestedProfile(ctx)
  const appConfig = await readAppConfig()
  const current = appConfig.speechPreprocessing?.[profile]

  // 归一化当前值（若从未保存则为默认值），再与请求体合并，保证部分更新不丢字段
  const merged = normalizeSpeechPreprocessingConfig({
    ...(current || {}),
    ...body,
    triggers: {
      ...(normalizeSpeechPreprocessingConfig(current).triggers),
      ...(typeof body.triggers === 'object' && body.triggers !== null ? (body.triggers as Record<string, unknown>) : {}),
    },
  })

  await writeAppConfig({
    speechPreprocessing: {
      ...(appConfig.speechPreprocessing || {}),
      [profile]: merged,
    },
  })

  ctx.body = { ok: true, profile, config: merged }
}

export async function getTtsFallback(ctx: Context) {
  const profile = requestedProfile(ctx)
  const fb = await readTtsFallbackConfig(ctx)
  ctx.body = { profile, config: fb }
}

export async function updateTtsFallback(ctx: Context) {
  if (!authUserId(ctx)) return
  const body = ctx.request.body as Record<string, unknown> | null
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    ctx.status = 400
    ctx.body = { error: 'body must be an object' }
    return
  }
  const profile = requestedProfile(ctx)
  const appConfig = await readAppConfig()
  const current = await readTtsFallbackConfig(ctx)

  const providers = Array.isArray(body.providers)
    ? (body.providers as unknown[]).filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map(p => p.trim())
    : current.providers
  // 约束：备用必须服务端已实现；未实现的直接剔除（避免存了永远切不过去的名字）
  const validProviders = providers.filter(p => getTtsProvider(p) && p !== 'custom')
  const merged: TtsFallbackConfig = {
    enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
    providers: validProviders,
    primaryTimeoutMs:
      typeof body.primaryTimeoutMs === 'number' && Number.isFinite(body.primaryTimeoutMs)
        ? Math.min(Math.max(Math.floor(body.primaryTimeoutMs), 5_000), 300_000)
        : current.primaryTimeoutMs,
    perProviderTimeoutMs:
      typeof body.perProviderTimeoutMs === 'number' && Number.isFinite(body.perProviderTimeoutMs)
        ? Math.min(Math.max(Math.floor(body.perProviderTimeoutMs), 3_000), 30_000)
        : current.perProviderTimeoutMs,
  }

  await writeAppConfig({
    ttsFallback: {
      ...(appConfig.ttsFallback || {}),
      [profile]: merged,
    },
  })

  ctx.body = { ok: true, profile, config: merged }
}

export async function prepareSpeechPreview(ctx: Context) {
  if (!authUserId(ctx)) return
  const body = ctx.request.body as { text?: unknown } | null
  if (!body || typeof body.text !== 'string' || !body.text.trim()) {
    ctx.status = 400
    ctx.body = { error: 'text is required' }
    return
  }
  const text = body.text.trim()
  if (text.length > 5000) {
    ctx.status = 400
    ctx.body = { error: 'text is too long (max 5000 characters)' }
    return
  }
  // 只跑预处理（规则清洗 → 触发判断 → 模型改写），不合成——供前端预览/编辑语音稿
  const controller = createRequestAbortController(ctx)
  const prepared = await prepareSpeechText(text, controller.signal, requestedProfile(ctx))
  const segments = splitSpeechSegments(prepared)
  if (segments.length > 1) {
    // 长文本走分段（渐进播放）：返回 segments 数组
    ctx.body = { segments, segmentCount: segments.length }
  } else {
    // 短文本兼容原逻辑：直接返回 text
    ctx.body = { text: prepared }
  }
}

// #11 用量统计：今日/本周/总，tts 与 stt 合并
export async function getVoiceUsage(ctx: Context) {
  if (!authUserId(ctx)) return
  const now = Date.now()
  const dayMs = 24 * 3600 * 1000
  // 从 ?days= 取区间天数（默认 30），限制 1..365
  const days = Math.max(1, Math.min(365, Number((ctx.query as any)?.days) || 30))
  const startMs = now - days * dayMs
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const startOfTodayMs = startOfToday.getTime()
  const profile = requestedProfile(ctx)
  const empty = {
    range: [],
    today: [],
    total: [],
    period: { days, start_at: startMs, end_at: now },
    generated_at: now,
  }
  try {
    const db = (await import('../infrastructure/database')).getDb()
    if (!db) { ctx.body = empty; return }
    // 区间内：按 source + provider 聚合
    const range = db.prepare(
      `SELECT source, provider, SUM(api_calls) as calls, SUM(input_tokens) as input_total, SUM(output_tokens) as output_total,
              MIN(created_at) as first_at, MAX(created_at) as last_at
       FROM session_usage WHERE source IN ('tts','stt') AND created_at >= ? AND profile = ?
       GROUP BY source, provider ORDER BY source, calls DESC`
    ).all(startMs, profile) as any[]
    // 今日
    const today = db.prepare(
      `SELECT source, provider, SUM(api_calls) as calls, SUM(input_tokens) as input_total, SUM(output_tokens) as output_total
       FROM session_usage WHERE source IN ('tts','stt') AND created_at >= ? AND profile = ?
       GROUP BY source, provider`
    ).all(startOfTodayMs, profile) as any[]
    // 全历史
    const total = db.prepare(
      `SELECT source, SUM(api_calls) as calls, SUM(input_tokens) as input_total, SUM(output_tokens) as output_total
       FROM session_usage WHERE source IN ('tts','stt') AND profile = ?
       GROUP BY source`
    ).all(profile) as any[]
    // 按日分桶
    const dailyRows = db.prepare(
      `SELECT date(created_at/1000, 'unixepoch', 'localtime') as day, source,
              SUM(api_calls) as calls, SUM(input_tokens) as input_total, SUM(output_tokens) as output_total
       FROM session_usage WHERE source IN ('tts','stt') AND created_at >= ? AND profile = ?
       GROUP BY day, source ORDER BY day ASC`
    ).all(startMs, profile) as any[]
    ctx.body = { range, today, total, daily: dailyRows, period: { days, start_at: startMs, end_at: now }, generated_at: now }
  } catch {
    ctx.body = empty
  }
}
