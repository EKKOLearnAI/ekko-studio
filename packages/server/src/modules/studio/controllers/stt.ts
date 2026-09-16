import type { Context } from 'koa'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  assertActiveSttProvider,
  assertStoredSttProvider,
  clearStoredSttSecret,
  deleteSttProviderSetting,
  getActiveSttProvider,
  getSttProviderSetting,
  isStoredSttProvider,
  listSttProviderSettings,
  removeSttBaseUrlPreset,
  saveActiveSttProvider,
  saveSttProviderSetting,
  SttSettingsValidationError,
  type StoredSttProvider,
  type SttStoredSecrets,
  type SttStoredSettings,
} from '../public/voice-settings'
import { config } from '../public/config'
import { SttProviderConfigError, transcribeWithProvider } from '../services/voice/stt'
import { updateUsage } from '../repositories/usage-store'
import { SttNoSpeechDetectedError } from '../services/voice/stt/types'
import { logger } from '../public/logging'
import { emitMcuVoiceEvent, startMcuVoiceChatTurn } from '../public/mcu-voice'
import { normalizeMcuAgentRuntime } from '../services/global-agent/mcu-agent-runtime'
import { MCU_TTS_SAMPLE_RATE, mcuPromptText, mcuPromptUrl } from '../services/voice/mcu/prompts'
import { syncVoiceConfigToHermesProfile } from '../services/voice/config-sync'
import { listProfileNames } from '../public/profile-config'
import {
  cancelLocalSttStreamSession,
  createLocalSttStreamSession,
  finishLocalSttStreamSession,
  getLocalSttModelStatus,
  LOCAL_STT_MODEL_ID,
  LocalSttStreamSessionError,
  pushLocalSttStreamAudio,
} from '../services/voice/stt/local-model-manager'

const MAX_STT_UPLOAD_SIZE = 50 * 1024 * 1024
const MCU_STT_TIMEOUT_MS = 120_000

interface ParsedPart {
  fieldName: string
  filename: string | null
  contentType: string | null
  data: Buffer
}

interface ParsedMultipartBody {
  fields: Record<string, string>
  files: ParsedPart[]
}

class MultipartParseError extends Error {}

function authUserId(ctx: Context): number | null {
  const rawUserId = ctx.state.user?.id
  const userId = typeof rawUserId === 'number' ? rawUserId : Number.NaN
  if (!Number.isInteger(userId) || userId <= 0) {
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

function bearerToken(ctx: Context): string {
  const header = ctx.get?.('authorization') || ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || ''
}

function localRuntimeSetting(): { settings: SttStoredSettings; secrets: SttStoredSecrets } {
  return { settings: { model: LOCAL_STT_MODEL_ID }, secrets: {} }
}

function resolveSttProfileStatus(profile: string) {
  const activeProvider = getActiveSttProvider(profile)
  if (!activeProvider || activeProvider === 'browser') {
    return {
      profile,
      configured: false,
      activeProvider: activeProvider || null,
      reason: activeProvider === 'browser' ? 'browser_stt_not_available_for_mcu' : 'active_stt_provider_missing',
    }
  }

  if (!isStoredSttProvider(activeProvider)) {
    return {
      profile,
      configured: false,
      activeProvider,
      reason: 'active_stt_provider_unsupported',
    }
  }

  if (activeProvider === 'local') {
    const model = getLocalSttModelStatus()
    return {
      profile,
      configured: model.usable,
      activeProvider,
      reason: model.usable ? null : 'local_stt_model_unavailable',
    }
  }

  const storedSetting = getSttProviderSetting(profile, activeProvider, { includeSecrets: true })
  const hasSecret = Boolean(storedSetting?.secrets.apiKey)
  return {
    profile,
    configured: hasSecret,
    activeProvider,
    reason: hasSecret ? null : 'active_stt_provider_secret_missing',
  }
}

function handleSettingsError(ctx: Context, error: unknown): boolean {
  if (error instanceof SttSettingsValidationError) {
    ctx.status = 400
    ctx.body = { error: error.message }
    return true
  }
  return false
}

function splitMultipart(raw: Buffer, boundary: Buffer): Buffer[] {
  const parts: Buffer[] = []
  let start = 0
  while (true) {
    const idx = raw.indexOf(boundary, start)
    if (idx === -1) break
    if (start > 0) {
      parts.push(raw.subarray(start + 2, idx))
    }
    start = idx + boundary.length
  }
  return parts
}

function parseMultipartPart(part: Buffer): ParsedPart | null {
  const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
  if (headerEnd === -1) return null

  const header = part.subarray(0, headerEnd).toString('utf-8')
  const data = part.subarray(headerEnd + 4, part.length - 2)
  const disposition = header.match(/Content-Disposition:\s*form-data;([^\r\n]*)/i)?.[1]
  if (!disposition) return null

  const fieldName = disposition.match(/\bname="([^"]+)"/)?.[1]
  if (!fieldName) return null

  let filename: string | null = null
  const encodedFilename = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  if (encodedFilename) {
    try {
      filename = decodeURIComponent(encodedFilename.trim().replace(/^"|"$/g, ''))
    } catch {
      throw new MultipartParseError('Malformed multipart filename')
    }
  } else {
    filename = disposition.match(/\bfilename="([^"]*)"/)?.[1] ?? null
  }

  const contentType = header.match(/Content-Type:\s*([^\r\n]+)/i)?.[1]?.trim() ?? null

  return {
    fieldName,
    filename,
    contentType,
    data,
  }
}

async function readMultipartBody(ctx: Context): Promise<ParsedMultipartBody | { error: string; status: number }> {
  const contentType = ctx.get('content-type') || ''
  if (!contentType.startsWith('multipart/form-data')) {
    return { error: 'Expected multipart/form-data', status: 400 }
  }

  const boundaryStr = contentType.split('boundary=')[1]
  if (!boundaryStr) {
    return { error: 'Missing boundary', status: 400 }
  }

  const boundary = Buffer.from(`--${boundaryStr.split(';')[0].trim()}`)
  const chunks: Buffer[] = []
  let totalSize = 0

  for await (const chunk of ctx.req) {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalSize += bufferChunk.length
    if (totalSize > MAX_STT_UPLOAD_SIZE) {
      return { error: `Upload too large (max ${MAX_STT_UPLOAD_SIZE / 1024 / 1024}MB)`, status: 413 }
    }
    chunks.push(bufferChunk)
  }

  const fields: Record<string, string> = {}
  const files: ParsedPart[] = []
  const raw = Buffer.concat(chunks)

  for (const part of splitMultipart(raw, boundary)) {
    let parsed: ParsedPart | null
    try {
      parsed = parseMultipartPart(part)
    } catch (error) {
      if (error instanceof MultipartParseError) {
        return { error: error.message, status: 400 }
      }
      throw error
    }
    if (!parsed) continue

    if (parsed.filename !== null) {
      files.push(parsed)
      continue
    }

    fields[parsed.fieldName] = parsed.data.toString('utf-8').trim()
  }

  return { fields, files }
}

async function readRawAudioBody(ctx: Context): Promise<Buffer | { error: string; status: number }> {
  const chunks: Buffer[] = []
  let totalSize = 0

  for await (const chunk of ctx.req) {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalSize += bufferChunk.length
    if (totalSize > MAX_STT_UPLOAD_SIZE) {
      return { error: `Upload too large (max ${MAX_STT_UPLOAD_SIZE / 1024 / 1024}MB)`, status: 413 }
    }
    chunks.push(bufferChunk)
  }

  const audio = Buffer.concat(chunks)
  if (audio.length === 0) {
    return { error: 'audio body is required', status: 400 }
  }
  return audio
}

function findAudioPart(files: ParsedPart[]): ParsedPart | null {
  return files.find(part => part.fieldName === 'audio') || null
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}

function createRequestAbortController(ctx: Context): AbortController {
  const controller = new AbortController()

  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort()
    }
  }

  if (ctx.req?.on) {
    ctx.req.on('aborted', abort)
  }

  if (ctx.res?.on) {
    ctx.res.on('close', () => {
      if (!ctx.res.writableEnded) {
        abort()
      }
    })
  }

  return controller
}

function safeDebugName(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'unknown'
}

async function saveMcuSttDebugAudio(input: {
  userId: number
  profile: string
  provider: string
  contentType: string
  audio: Buffer
}): Promise<{ audioPath: string; metadataPath: string }> {
  const dir = join(config.appHome, 'debug', 'mcu-stt')
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const baseName = `${stamp}_u${input.userId}_${safeDebugName(input.profile)}_${safeDebugName(input.provider)}`
  const audioPath = join(dir, `${baseName}.wav`)
  const metadataPath = join(dir, `${baseName}.json`)
  await writeFile(audioPath, input.audio)
  await writeFile(metadataPath, JSON.stringify({
    createdAt: new Date().toISOString(),
    userId: input.userId,
    profile: input.profile,
    provider: input.provider,
    contentType: input.contentType,
    audioBytes: input.audio.length,
    audioPath,
  }, null, 2) + '\n', 'utf-8')
  return { audioPath, metadataPath }
}

export async function listSettings(ctx: Context) {
  const userId = authUserId(ctx)
  if (!userId) return

  try {
    const profile = requestedProfile(ctx)
    ctx.body = {
      settings: listSttProviderSettings(profile),
      activeProvider: getActiveSttProvider(profile),
    }
  } catch (error) {
    if (handleSettingsError(ctx, error)) return
    throw error
  }
}

export async function profileStatus(ctx: Context) {
  const userId = authUserId(ctx)
  if (!userId) return

  ctx.body = resolveSttProfileStatus(requestedProfile(ctx))
}

export async function missingProfileAudio(ctx: Context) {
  const userId = authUserId(ctx)
  if (!userId) return

  const status = resolveSttProfileStatus(requestedProfile(ctx))
  if (status.configured) {
    ctx.status = 204
    return
  }

  ctx.status = 302
  ctx.set('Location', mcuPromptUrl('missing-stt'))
  ctx.set('Cache-Control', 'public, max-age=31536000, immutable')
  ctx.set('X-Hermes-STT-Configured', 'false')
  ctx.set('X-Hermes-STT-Reason', status.reason || 'stt_not_configured')
  ctx.body = { url: mcuPromptUrl('missing-stt') }
}

export async function saveSettings(ctx: Context) {
  const userId = authUserId(ctx)
  if (!userId) return

  const provider = ctx.params.provider || ''
  const body = ctx.request.body as {
    settings?: unknown
    secrets?: unknown
    activeProvider?: unknown
  } | undefined

  try {
    const profile = requestedProfile(ctx)
    const storedProvider = assertStoredSttProvider(provider)
    const setting = saveSttProviderSetting(profile, storedProvider, {
      settings: body?.settings,
      secrets: body?.secrets,
    })
    const activeProvider = body?.activeProvider === undefined
      ? saveActiveSttProvider(profile, storedProvider)
      : saveActiveSttProvider(profile, assertActiveSttProvider(String(body.activeProvider)))

    await syncVoiceConfigToHermesProfile(profile)
    ctx.body = { setting, activeProvider }
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
    const storedProvider = assertStoredSttProvider(provider)
    const setting = removeSttBaseUrlPreset(profile, storedProvider, rawUrl)
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
    const storedProvider = assertStoredSttProvider(provider)
    const setting = clearStoredSttSecret(profile, storedProvider, secretName)
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
    const storedProvider = assertStoredSttProvider(provider)
    const deleted = deleteSttProviderSetting(profile, storedProvider)
    const currentActiveProvider = getActiveSttProvider(profile)
    const activeProvider = currentActiveProvider === storedProvider
      ? saveActiveSttProvider(profile, 'browser')
      : currentActiveProvider
    await syncVoiceConfigToHermesProfile(profile)
    ctx.body = { success: true, deleted, activeProvider }
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
    const requestedProvider = assertActiveSttProvider(String(body?.provider || ''))
    if (requestedProvider === 'local') {
      const model = getLocalSttModelStatus()
      if (!model.usable) {
        ctx.status = 409
        ctx.body = { error: model.validationError || 'Local STT model is not installed and usable' }
        return
      }
      saveSttProviderSetting(profile, 'local', {
        settings: { model: LOCAL_STT_MODEL_ID },
        secrets: {},
      })
    }
    const activeProvider = saveActiveSttProvider(profile, requestedProvider)
    await syncVoiceConfigToHermesProfile(profile)
    ctx.body = { activeProvider }
  } catch (error) {
    if (handleSettingsError(ctx, error)) return
    throw error
  }
}

function resolveStoredProvider(fields: Record<string, string>): StoredSttProvider {
  return assertStoredSttProvider(fields.provider || '')
}

function localStreamOwnerKey(userId: number, ctx: Context): string {
  return `${userId}:${requestedProfile(ctx)}`
}

function requireActiveLocalStt(ctx: Context): boolean {
  const profile = requestedProfile(ctx)
  if (getActiveSttProvider(profile) !== 'local') {
    ctx.status = 409
    ctx.body = { error: 'Local STT is not the active provider for this profile' }
    return false
  }

  const model = getLocalSttModelStatus()
  if (!model.usable) {
    ctx.status = 409
    ctx.body = { error: model.validationError || 'Local STT model is not installed and usable' }
    return false
  }
  return true
}

function handleLocalStreamError(ctx: Context, error: unknown): void {
  if (isAbortError(error)) {
    ctx.status = 499
    ctx.body = { error: 'STT request aborted' }
    return
  }
  if (error instanceof LocalSttStreamSessionError) {
    ctx.status = 404
    ctx.body = { error: error.message }
    return
  }

  const detail = error instanceof Error ? error.message : String(error)
  if (detail.startsWith('Local STT accepts') || detail.startsWith('Local STT raw PCM')) {
    ctx.status = 400
    ctx.body = { error: detail }
    return
  }
  ctx.status = 502
  ctx.body = { error: detail ? `Local STT streaming failed: ${detail}` : 'Local STT streaming failed' }
}

export async function startLocalStream(ctx: Context) {
  const userId = authUserId(ctx)
  if (!userId || !requireActiveLocalStt(ctx)) return

  try {
    ctx.body = await createLocalSttStreamSession(localStreamOwnerKey(userId, ctx))
  } catch (error) {
    handleLocalStreamError(ctx, error)
  }
}

export async function pushLocalStreamChunk(ctx: Context) {
  const userId = authUserId(ctx)
  if (!userId || !requireActiveLocalStt(ctx)) return

  const audio = await readRawAudioBody(ctx)
  if ('error' in audio) {
    ctx.status = audio.status
    ctx.body = { error: audio.error }
    return
  }

  const controller = createRequestAbortController(ctx)
  try {
    ctx.body = await pushLocalSttStreamAudio(
      ctx.params.sessionId || '',
      localStreamOwnerKey(userId, ctx),
      audio,
      ctx.get('content-type') || 'audio/wav',
      controller.signal,
    )
  } catch (error) {
    handleLocalStreamError(ctx, error)
  }
}

export async function finishLocalStream(ctx: Context) {
  const userId = authUserId(ctx)
  if (!userId) return

  const controller = createRequestAbortController(ctx)
  try {
    ctx.body = await finishLocalSttStreamSession(
      ctx.params.sessionId || '',
      localStreamOwnerKey(userId, ctx),
      controller.signal,
    )
  } catch (error) {
    handleLocalStreamError(ctx, error)
  }
}

export async function cancelLocalStream(ctx: Context) {
  const userId = authUserId(ctx)
  if (!userId) return

  try {
    await cancelLocalSttStreamSession(
      ctx.params.sessionId || '',
      localStreamOwnerKey(userId, ctx),
    )
    ctx.body = { success: true }
  } catch (error) {
    handleLocalStreamError(ctx, error)
  }
}

export async function transcribe(ctx: Context) {
  const userId = authUserId(ctx)
  if (!userId) return

  const parsed = await readMultipartBody(ctx)
  if ('error' in parsed) {
    ctx.status = parsed.status
    ctx.body = { error: parsed.error }
    return
  }

  let provider: StoredSttProvider
  try {
    provider = resolveStoredProvider(parsed.fields)
  } catch (error) {
    if (handleSettingsError(ctx, error)) return
    throw error
  }

  const audio = findAudioPart(parsed.files)
  if (!audio) {
    ctx.status = 400
    ctx.body = { error: 'audio is required' }
    return
  }

  const storedSetting = getSttProviderSetting(requestedProfile(ctx), provider, { includeSecrets: true })
  const runtimeSetting = storedSetting || (provider === 'local' && getLocalSttModelStatus().usable
    ? localRuntimeSetting()
    : null)
  if (!runtimeSetting) {
    ctx.status = 400
    ctx.body = { error: `STT settings are required for provider ${provider}` }
    return
  }

  if (provider !== 'local' && !runtimeSetting.secrets.apiKey) {
    ctx.status = 400
    ctx.body = { error: `STT settings are incomplete for provider ${provider}` }
    return
  }

  const controller = createRequestAbortController(ctx)

  try {
    const result = await transcribeWithProvider({
      provider,
      audio: audio.data,
      fileName: audio.filename || 'audio',
      mimeType: audio.contentType || 'application/octet-stream',
      settings: runtimeSetting.settings,
      secrets: runtimeSetting.secrets,
      signal: controller.signal,
    })

    ctx.body = result
  } catch (error) {
    if (isAbortError(error)) {
      ctx.status = 499
      ctx.body = { error: 'STT request aborted' }
      return
    }

    if (error instanceof SttProviderConfigError) {
      ctx.status = 400
      ctx.body = { error: error.message }
      return
    }

    if (error instanceof SttNoSpeechDetectedError) {
      ctx.status = 400
      ctx.body = { error: error.message, code: 'no_speech_detected' }
      return
    }

    ctx.status = 502
    const detail = error instanceof Error ? error.message : ''
    ctx.body = { error: detail ? `STT transcription failed: ${detail}` : 'STT transcription failed' }
  }
}

/**
 * OpenAI-compatible STT endpoint used by the Hermes `hermes-studio` command
 * provider. The profile is encoded in the URL written to that profile's
 * config.yaml, so no process-global profile inference is needed.
 */
export async function transcribeVoiceProxy(ctx: Context) {
  const profile = requestedVoiceProxyProfile(ctx)
  if (!profile) {
    ctx.status = 404
    ctx.body = { error: 'unknown Hermes profile' }
    return
  }

  const parsed = await readMultipartBody(ctx)
  if ('error' in parsed) {
    ctx.status = parsed.status
    ctx.body = { error: parsed.error }
    return
  }

  const audio = parsed.files.find(part => part.fieldName === 'file' || part.fieldName === 'audio')
  if (!audio) {
    ctx.status = 400
    ctx.body = { error: 'file is required' }
    return
  }

  const activeProvider = getActiveSttProvider(profile)
  if (!activeProvider || activeProvider === 'browser' || !isStoredSttProvider(activeProvider)) {
    ctx.status = 409
    ctx.body = { error: 'no server-backed Web UI STT provider is active' }
    return
  }

  const storedSetting = getSttProviderSetting(profile, activeProvider, { includeSecrets: true })
  const setting = storedSetting || (activeProvider === 'local' && getLocalSttModelStatus().usable
    ? localRuntimeSetting()
    : null)
  if (!setting || (activeProvider !== 'local' && !setting.secrets.apiKey)) {
    ctx.status = 409
    ctx.body = { error: 'the active Web UI STT provider is not configured' }
    return
  }

  const controller = createRequestAbortController(ctx)
  try {
    const result = await transcribeWithProvider({
      provider: activeProvider,
      audio: audio.data,
      fileName: audio.filename || 'audio',
      mimeType: audio.contentType || 'application/octet-stream',
      settings: setting.settings,
      secrets: setting.secrets,
      signal: controller.signal,
    })
    // #11 用量统计
    try {
      updateUsage(profile, {
        runId: '',
        source: 'stt',
        agent: String(setting?.settings?.model || activeProvider || ''),
        usageScope: 'model_call',
        purpose: 'stt_transcribe',
        apiCalls: 1,
        inputTokens: audio.data.length,
        outputTokens: result.text.length,
        model: String(setting?.settings?.model || activeProvider || ''),
        provider: String(activeProvider || ''),
        profile,
        isEstimated: false,
      })
    } catch {}
    if (parsed.fields.response_format === 'text') {
      ctx.set('Content-Type', 'text/plain; charset=utf-8')
      ctx.body = result.text
    } else {
      ctx.body = { text: result.text }
    }
  } catch (error) {
    if (isAbortError(error)) {
      ctx.status = 499
      ctx.body = { error: 'STT request aborted' }
      return
    }
    if (error instanceof SttProviderConfigError) {
      ctx.status = 400
      ctx.body = { error: error.message }
      return
    }
    if (error instanceof SttNoSpeechDetectedError) {
      ctx.status = 400
      ctx.body = { error: error.message, code: 'no_speech_detected' }
      return
    }
    ctx.status = 502
    ctx.body = { error: error instanceof Error ? error.message : 'Ekko Studio transcription failed' }
  }
}

export async function mcuVoiceTurn(ctx: Context) {
  const userId = authUserId(ctx)
  if (!userId) return

  const profile = requestedProfile(ctx)
  const status = resolveSttProfileStatus(profile)
  if (!status.configured || !status.activeProvider || status.activeProvider === 'browser' || !isStoredSttProvider(status.activeProvider)) {
    ctx.body = {
      ok: false,
      profile,
      reason: status.reason || 'stt_not_configured',
      audio: {
        text: mcuPromptText('missing-stt'),
        url: mcuPromptUrl('missing-stt'),
        mimeType: 'audio/x-pcm',
        format: 's16le',
        sampleRate: MCU_TTS_SAMPLE_RATE,
        channels: 1,
      },
    }
    return
  }

  const audio = await readRawAudioBody(ctx)
  if ('error' in audio) {
    ctx.status = audio.status
    ctx.body = { error: audio.error }
    return
  }

  const persistedSetting = getSttProviderSetting(profile, status.activeProvider, { includeSecrets: true })
  const storedSetting = persistedSetting || (status.activeProvider === 'local' && getLocalSttModelStatus().usable
    ? localRuntimeSetting()
    : null)
  if (!storedSetting || (status.activeProvider !== 'local' && !storedSetting.secrets.apiKey)) {
    ctx.body = {
      ok: false,
      profile,
      reason: 'active_stt_provider_secret_missing',
      audio: {
        text: mcuPromptText('missing-stt'),
        url: mcuPromptUrl('missing-stt'),
        mimeType: 'audio/x-pcm',
        format: 's16le',
        sampleRate: MCU_TTS_SAMPLE_RATE,
        channels: 1,
      },
    }
    return
  }

  const contentType = ctx.get('content-type') || 'audio/wav'
  const isWavUpload = contentType.toLowerCase().includes('wav')
  const forceFfmpeg = status.activeProvider === 'doubao' && !isWavUpload
  const interactionId = ctx.get('x-hermes-mcu-interaction-id') || `mcu-voice-${Date.now()}`
  const token = bearerToken(ctx)
  const clientId = ctx.get('x-hermes-mcu-device-id') || undefined
  const agentRuntime = normalizeMcuAgentRuntime(ctx.get('x-hermes-mcu-agent-runtime'))
  let debugAudioPath = ''
  let debugMetadataPath = ''
  try {
    const saved = await saveMcuSttDebugAudio({
      userId,
      profile,
      provider: status.activeProvider,
      contentType,
      audio,
    })
    debugAudioPath = saved.audioPath
    debugMetadataPath = saved.metadataPath
  } catch (error) {
    logger.warn({
      err: error,
      userId,
      profile,
      provider: status.activeProvider,
      audioBytes: audio.length,
    }, '[mcu-stt] failed to save debug audio')
  }

  logger.info({
    userId,
    profile,
    provider: status.activeProvider,
    contentType,
    audioBytes: audio.length,
    forceFfmpeg,
    debugAudioPath,
    debugMetadataPath,
  }, '[mcu-stt] voice turn upload received')

  ctx.body = {
    ok: true,
    profile,
    accepted: true,
    interactionId,
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MCU_STT_TIMEOUT_MS)
  const provider = status.activeProvider
  const settings = {
    ...storedSetting.settings,
    audioTranscode: forceFfmpeg ? 'ffmpeg' : storedSetting.settings.audioTranscode,
  }
  const secrets = storedSetting.secrets

  void (async () => {
    emitMcuVoiceEvent({ type: 'interaction.status', interactionId, status: 'transcribing' }, { clientId })
    try {
      // 注: 讯飞流式转写要求 40ms 真流式分片，当前架构按整段上传，故走 IAT 整段识别
      const result = await transcribeWithProvider({ provider, audio, fileName: 'mcu-voice.wav', mimeType: contentType, settings, secrets, signal: controller.signal })

      logger.info({
        userId,
        profile,
        provider: result.provider,
        model: result.model,
        transcriptLength: result.text.length,
        durationMs: result.durationMs,
      }, '[mcu-stt] voice turn transcribed')

      const transcript = result.text.trim()
      if (!transcript) {
        emitMcuVoiceEvent({ type: 'interaction.status', interactionId, status: 'completed', text: '' }, { clientId })
        return
      }
      if (!token) {
        emitMcuVoiceEvent({
          type: 'interaction.status',
          interactionId,
          status: 'failed',
          text: 'missing Web UI auth token',
        }, { clientId })
        return
      }

      startMcuVoiceChatTurn({
        userToken: token,
        profile,
        interactionId,
        transcript,
        clientId,
        agentRuntime,
      })
    } catch (error) {
      if (error instanceof SttNoSpeechDetectedError) {
        logger.info({
          userId,
          profile,
          provider,
          audioBytes: audio.length,
          contentType,
          debugAudioPath,
        }, '[mcu-stt] voice turn completed without detected speech')
        emitMcuVoiceEvent({
          type: 'interaction.status',
          interactionId,
          status: 'completed',
          text: '',
        }, { clientId })
        return
      }

      const detail = error instanceof Error ? error.message : String(error)
      const text = isAbortError(error)
        ? 'STT request timed out'
        : error instanceof SttProviderConfigError
          ? error.message
          : detail || 'MCU voice turn failed'
      logger.warn({
        userId,
        profile,
        provider,
        audioBytes: audio.length,
        contentType,
        debugAudioPath,
        error: detail,
      }, '[mcu-stt] voice turn failed')
      emitMcuVoiceEvent({
        type: 'interaction.status',
        interactionId,
        status: 'failed',
        text,
      }, { clientId })
      emitMcuVoiceEvent({
        type: 'audio.enqueue',
        interactionId,
        segmentId: `${interactionId}-stt-failed`,
        text: mcuPromptText('stt-failed'),
        url: mcuPromptUrl('stt-failed'),
        mimeType: 'audio/x-pcm',
        format: 's16le',
        sampleRate: MCU_TTS_SAMPLE_RATE,
        channels: 1,
      }, { clientId })
    } finally {
      clearTimeout(timer)
    }
  })()
}
