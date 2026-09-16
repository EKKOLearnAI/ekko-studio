import type { OpenrouterTtsProviderOptions, TtsProvider, TtsProviderId } from './types'
import { cleanTtsText, clampTtsText } from './text'
import { assertSafeTtsBaseUrl } from './url-safety'

/**
 * OpenRouter 文本转语音 provider。
 *
 * 端点：POST https://openrouter.ai/api/v1/audio/speech
 *   （与 OpenAI Audio Speech API 兼容，返回原始音频字节流）
 *
 * 与通用 openai 兼容 provider 的关键差异——voice 字段的语义按模型分裂：
 *   - deepgram/flux-tts:free      → 必须显式 voice（36 个 flux-*-en），缺失即 400
 *                                   "An explicit voice is required for this TTS provider."
 *   - fish-audio/s2.1-pro-free:free → 不能传 voice，由服务端内置音色决定；
 *                                   传了（哪怕是 default）反而 400
 * 所以这里不做"永远带一个默认 voice"的兜底，而是按模型前缀决定是否附带该字段。
 */

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'
const DEFAULT_MODEL = 'fish-audio/s2.1-pro-free:free'

/** 音色由服务端固定、不接受 voice 参数的模型前缀（实测确认） */
const VOICE_OPTIONAL_MODEL_PREFIXES = ['fish-audio/'] as const

/**
 * 支持 stateless 声音克隆的模型前缀。
 *
 * 依据：`GET /api/v1/models/{id}/endpoints` 的 `supports_voice_cloning` 字段实测——
 *   fish-audio/s2.1-pro-free:free → true
 *   fish-audio/s2.1-pro          → true
 *   fish-audio/s2-pro            → false（注意别用 'fish-audio/s2' 当前缀，会误判）
 *   deepgram/flux-tts:free       → false
 * 前缀写成 'fish-audio/s2.1-pro' 恰好只覆盖支持的两个（含带日期版本
 * 如 fish-audio/s2.1-pro-free-20260729:free），不会误伤 s2-pro。
 */
const VOICE_CLONING_MODEL_PREFIXES = ['fish-audio/s2.1-pro'] as const

/** OpenRouter 对 input_references 的硬上限：base64 20 MiB */
const MAX_CLONE_DATA_URI_CHARS = 20 * 1024 * 1024
const CLONE_DATA_URI_RE = /^data:audio\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i

function needsExplicitVoice(model: string): boolean {
  return !VOICE_OPTIONAL_MODEL_PREFIXES.some(prefix => model.startsWith(prefix))
}

function supportsVoiceCloning(model: string): boolean {
  return VOICE_CLONING_MODEL_PREFIXES.some(prefix => model.startsWith(prefix))
}

/**
 * 把参考音频 data URI 转成 OpenRouter 的 input_references。
 *
 * stateless 克隆：每次合成都要带上参考音频（不像 aliyun qwen3-tts-vc 那样
 * 只需一个已注册的音色 id），所以分段播放时每段请求都会重复携带。
 * 实测不带 transcript 也能正常克隆，故只发 input_audio 一个 part。
 */
function buildCloneReferences(dataUri: string): Array<Record<string, unknown>> {
  const value = dataUri.trim()
  if (!CLONE_DATA_URI_RE.test(value)) {
    throw new Error('OpenRouter 音色克隆参考音频格式不合法（需 data:audio/...;base64,... 且为纯 base64）')
  }
  if (value.length > MAX_CLONE_DATA_URI_CHARS) {
    throw new Error(`OpenRouter 音色克隆参考音频过大（base64 上限 20MiB，当前 ${(value.length / 1048576).toFixed(1)}MiB）`)
  }
  return [{ type: 'input_audio', input_audio: { data: value } }]
}

/** 把用户填的 baseUrl 归一成 .../audio/speech（允许填根路径或完整路径） */
function buildSpeechUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  assertSafeTtsBaseUrl(url, 'OpenRouter')

  const search = url.search
  url.hash = ''

  const pathname = url.pathname.replace(/\/+$/, '')

  if (!pathname || pathname === '/') {
    return `${url.origin}/audio/speech${search}`
  }
  if (pathname.endsWith('/audio/speech')) {
    return `${url.origin}${pathname}${search}`
  }
  return `${url.origin}${pathname}/audio/speech${search}`
}

/**
 * OpenRouter 在拒绝未知响应格式时会把可选项写进报错正文
 * （如 `response_format must be one of [mp3]`）——照单重试一次，
 * 免得用户自己去猜格式。
 */
function supportedFormatsFromError(body: string): string[] {
  const match = body.match(/response_format must be one of \[([^\]]+)\]/i)
  if (!match) return []
  return match[1]
    .split(',')
    .map(value => value.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
}

export function createOpenrouterTtsProvider(id: TtsProviderId): TtsProvider<OpenrouterTtsProviderOptions> {
  return {
    id,
    async synthesize(req, opts) {
      const baseUrl = String(opts.baseUrl || DEFAULT_BASE_URL).trim()
      const speechUrl = buildSpeechUrl(baseUrl)
      const model = String(opts.model || DEFAULT_MODEL).trim()

      const text = clampTtsText(cleanTtsText(req.text))
      if (!text) {
        throw new Error('OpenRouter TTS text is empty after cleaning')
      }

      const voice = String(opts.voice || '').trim()
      const requireVoice = needsExplicitVoice(model)
      if (requireVoice && !voice) {
        throw new Error(
          `OpenRouter TTS 模型 ${model} 必须指定 voice（如 flux-alexis-en）。`
          + '若想免音色配置请改用 fish-audio/s2.1-pro-free:free。',
        )
      }

      // stateless 声音克隆：仅对实测支持克隆的模型附加参考音频；
      // 其他模型（如 flux）带上会被 OpenRouter 以 404 拒绝，直接忽略以免拖垮整条 fallback 链。
      const cloneDataUri = String(opts.voiceCloneDataUri || '').trim()
      const inputReferences = cloneDataUri && supportsVoiceCloning(model)
        ? buildCloneReferences(cloneDataUri)
        : undefined

      const speed = Number(opts.speed)
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (opts.apiKey) {
        headers.Authorization = `Bearer ${opts.apiKey}`
      }

      const speak = (format?: string) => fetch(speechUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          input: text,
          // fish-audio 等模型不接受 voice —— 整字段省略而非传空串
          ...(requireVoice ? { voice } : {}),
          ...(Number.isFinite(speed) && speed !== 1 ? { speed } : {}),
          ...(inputReferences ? { input_references: inputReferences } : {}),
          ...(format ? { response_format: format } : {}),
        }),
        signal: req.signal,
      })

      const requestedFormat = opts.format || 'mp3'
      let res = await speak(requestedFormat)

      if (!res.ok) {
        let body = await res.text().catch(() => '')
        const [fallbackFormat] = supportedFormatsFromError(body)
        if (fallbackFormat && fallbackFormat !== requestedFormat) {
          res = await speak(fallbackFormat)
          if (!res.ok) body = await res.text().catch(() => '')
        }
        if (!res.ok) {
          throw new Error(`OpenRouter TTS returned ${res.status}: ${body || res.statusText}`)
        }
      }

      return {
        audio: Buffer.from(await res.arrayBuffer()),
        contentType: res.headers.get('content-type') || 'audio/mpeg',
        engine: 'openrouter',
        provider: id,
      }
    },
  }
}

export const openrouterTtsProvider: TtsProvider<OpenrouterTtsProviderOptions> = createOpenrouterTtsProvider('openrouter')
