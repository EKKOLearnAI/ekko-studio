import { getActiveProfileName, getApiKey } from '../client'

export interface TtsOptions {
  text: string
  lang?: string
  rate?: string   // Edge TTS rate format: "+NN%" or "-NN%"
  pitch?: string  // Edge TTS pitch format: "+NNHz" or "-NNHz"
  /** 语速倍率 0.5~2.0（1.0=正常）。支持：edge/zhipu/siliconflow/fishaudio/openai/mimo/minimax/custom/deepinfra */
  speed?: number
  /** 音量增益（语义由 provider 解释）：zhipu volume(0~10)、siliconflow/fishaudio gain dB[-10,10]、minimax vol(0,10] */
  volume?: number
}

export type TtsProviderId =
  | 'edge'
  | 'openai'
  | 'custom'
  | 'mimo'
  | 'doubao'
  | 'elevenlabs'
  | 'gemini'
  | 'xai'
  | 'mistral'
  | 'minimax'
  | 'deepinfra'
  | 'siliconflow'
  | 'zhipu'
  | 'fishaudio'
  | 'aliyun'
  | 'openrouter'

const TTS_PROVIDER_IDS = new Set<TtsProviderId>([
  'edge',
  'openai',
  'custom',
  'mimo',
  'doubao',
  'elevenlabs',
  'gemini',
  'xai',
  'mistral',
  'minimax',
  'deepinfra',
  'siliconflow',
  'zhipu',
  'fishaudio',
  'aliyun',
  'openrouter',
])

export function isServerTtsProvider(value: unknown): value is TtsProviderId {
  return typeof value === 'string' && TTS_PROVIDER_IDS.has(value as TtsProviderId)
}

export interface SynthesizeSpeechRequest {
  provider?: TtsProviderId
  profile?: string
  text: string
  options?: Record<string, unknown>
  signal?: AbortSignal
  /** true=已编辑好的语音稿直接合成，跳过预处理避免二次改写 */
  skipPreprocess?: boolean
  /** 顶层语速（与 options.speed 等价，方便 useVoiceSettings.ttsSpeed 直接注入） */
  speed?: number
  /** 顶层音量（zhipu 用 volume；siliconflow/fishaudio 映射为 gain） */
  gain?: number
}

async function readTtsError(res: Response): Promise<string> {
  try {
    const data = await res.clone().json() as { error?: unknown; detail?: unknown }
    const error = typeof data.error === 'string' ? data.error : 'TTS request failed'
    const detail = typeof data.detail === 'string' && data.detail.trim() ? data.detail.trim() : ''
    return detail ? `${error}: ${detail}` : `${error}: ${res.status}`
  } catch {
    const text = await res.text().catch(() => '')
    return text ? `TTS request failed: ${res.status} ${text.slice(0, 300)}` : `TTS request failed: ${res.status}`
  }
}

function ttsHeaders(explicitProfile?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  const apiKey = getApiKey()
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }
  const profile = explicitProfile?.trim() || getActiveProfileName()
  if (profile) {
    headers['X-Hermes-Profile'] = profile
  }
  return headers
}

export async function generateSpeech(opts: TtsOptions): Promise<{ audio: Blob; engine: string }> {
  const res = await fetch(
    `${localStorage.getItem('hermes_server_url') || ''}/api/studio/tts`,
    {
      method: 'POST',
      headers: ttsHeaders(),
      body: JSON.stringify(opts),
    },
  )

  if (!res.ok) {
    throw new Error(await readTtsError(res))
  }

  const audio = await res.blob()
  const engine = res.headers.get('X-TTS-Engine') || 'unknown'
  return { audio, engine }
}

export async function synthesizeSpeech(
  req: SynthesizeSpeechRequest,
): Promise<{ audio: Blob; engine: string; provider: string }> {
  const res = await fetch(
    `${localStorage.getItem('hermes_server_url') || ''}/api/studio/tts/synthesize`,
    {
      method: 'POST',
      headers: ttsHeaders(req.profile),
      body: JSON.stringify({
        provider: req.provider,
        text: req.text,
        options: req.options || {},
        ...(req.skipPreprocess === true ? { skipPreprocess: true } : {}),
        // 顶层 speed/gain 直传——server 端 openai/fishaudio 等 provider 直接读 opts
        ...(typeof req.speed === 'number' ? { speed: req.speed } : {}),
        ...(typeof req.gain === 'number' ? { gain: req.gain } : {}),
      }),
      signal: req.signal,
    },
  )

  if (!res.ok) {
    throw new Error(await readTtsError(res))
  }

  const audio = await res.blob()
  const engine = res.headers.get('X-TTS-Engine') || 'unknown'
  const provider = res.headers.get('X-TTS-Provider') || req.provider || 'unknown'
  return { audio, engine, provider }
}

export function playAudioBlob(blob: Blob): HTMLAudioElement {
  const url = URL.createObjectURL(blob)
  const audio = new Audio(url)
  audio.play()
  audio.onended = () => URL.revokeObjectURL(url)
  return audio
}

/** 只跑语音预处理（不合成），返回改写后的语音稿——供设置页试听台预览/编辑 */
export async function prepareSpeechPreview(
  req: { text: string; profile?: string; signal?: AbortSignal },
): Promise<string> {
  const data = await prepareSpeechSegmentsRaw(req)
  // 兼容旧调用：预览面板期望 string；若返回了分段，用全文（去分隔符）拼回
  return 'segments' in data ? data.segments.join('\n') : data.text
}

/** 预处理并返回分段数组（长文本 faithful 按 ===SEG=== 切好，供渐进播放逐段合成） */
export async function prepareSpeechSegments(
  req: { text: string; profile?: string; signal?: AbortSignal },
): Promise<string[] | null> {
  const data = await prepareSpeechSegmentsRaw(req)
  if ('segments' in data) return data.segments
  return data.text ? [data.text] : null
}

async function prepareSpeechSegmentsRaw(
  req: { text: string; profile?: string; signal?: AbortSignal },
): Promise<{ text: string } | { segments: string[]; segmentCount: number }> {
  const res = await fetch(
    `${localStorage.getItem('hermes_server_url') || ''}/api/studio/tts/prepare`,
    {
      method: 'POST',
      headers: ttsHeaders(req.profile),
      body: JSON.stringify({ text: req.text }),
      signal: req.signal,
    },
  )
  if (!res.ok) {
    throw new Error(await readTtsError(res))
  }
  const data = (await res.json()) as { text?: string; segments?: string[]; segmentCount?: number }
  if (Array.isArray(data.segments)) return { segments: data.segments, segmentCount: data.segmentCount || data.segments.length }
  return { text: typeof data.text === 'string' ? data.text : '' }
}

