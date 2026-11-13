import { getWebUiHome } from '../../public/config'
import path from 'path'
import { logger } from '../../public/logging'
import { readStoredDashScopeKey } from '../meeting-asr/dashscope-key-store'
import { getRealtimeModelSetting } from '../../repositories/realtime-settings-store'

/**
 * 扫描 OCR 服务。
 *
 * 浏览器调用 `navigator.mediaDevices.getUserMedia({ video: true })` 拿到 UVC
 * USB 摄像头（UVC 是 USB Video Class，绝大多数 USB 摄像头、文档拍摄仪、内置
 * 笔记本摄像头都按这个 class 暴露给操作系统，浏览器无需特殊驱动），拍下
 * 高清 JPEG 后通过本服务走 DashScope 兼容端点调用 Qwen-VL-OCR 模型识别
 * 文档文字。
 *
 * 调用形态（依据百炼官方文档 help.aliyun.com/zh/model-studio/qwen-vl-ocr）：
 *   - 仅支持 OpenAI 兼容端点
 *     `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`
 *     （中国大陆账号；国际区 dashscope-intl 的 key 与大陆不互通）；
 *   - 单张图片走 `image_url` content part，`{type:"image_url", image_url:{url}}`；
 *   - `qwen-vl-ocr` 是专用 OCR 模型，输出结构化文本（保留换行 / 段落）。
 *
 * Key 解析与 meeting-asr 保持一致：优先用请求方提供的 apiKey，否则读
 * meeting-asr 持久化目录（config.json / config.env）。
 */

export const SCANNER_DEFAULT_MODEL = 'qwen-vl-ocr'
export const SCANNER_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
/** 单张图片 base64 长度上限：约 6MB 原图（与 meeting-asr/direct-llm 同级防御）。 */
export const SCANNER_IMAGE_MAX_CHARS = 6_000_000
/** 单次请求最大图片数（多页批量识别）。 */
export const SCANNER_PAGES_MAX = 30
/** 单次请求超时（OCR 单张约 3-8s，留 60s 给 10 页以上的批量）。 */
const SCANNER_TIMEOUT_MS = 60_000

export interface ScannerOcrPageInput {
  /** data:image/jpeg;base64,… 或 data:image/png;base64,…；base64-only 也接受。 */
  image: string
}

export interface ScannerOcrOptions {
  /** 文档主语言提示，如 'zh'、'en'、'zh+en'；缺省让模型自动识别。 */
  language?: string
  /** 是否保留原始排版（段间距 / 缩进）。默认 true。 */
  preserveLayout?: boolean
  /** 模型名覆盖，默认 'qwen-vl-ocr'。 */
  model?: string
  /** DashScope API key（推荐由调用方提供）。 */
  apiKey?: string
  /** 当前 Hermes profile，用于在服务端回落到 Realtime 模型存储。 */
  profile?: string | null
  /** baseUrl 覆盖，主要用于测试与代理。 */
  baseUrl?: string
}

export interface ScannerOcrPageResult {
  /** OCR 文本（保留换行）。 */
  text: string
  /** 模型是否识别到内容；false 时 text 通常为空串。 */
  hasContent: boolean
}

export interface ScannerOcrResult {
  /** 单页识别结果，按入参顺序返回。 */
  pages: ScannerOcrPageResult[]
  /** 使用的模型 id。 */
  model: string
}

const DATA_URL_RE = /^data:(image\/(?:jpeg|jpg|png|webp));base64,/i

function normalizeImageDataUrl(raw: string): string | null {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return null
  if (trimmed.startsWith('data:')) {
    return DATA_URL_RE.test(trimmed) ? trimmed : null
  }
  // 没有前缀时按 jpeg 处理（摄像头原生 toDataURL('image/jpeg')）
  return `data:image/jpeg;base64,${trimmed}`
}

function promptForOcr(options: ScannerOcrOptions): string {
  const lang = String(options.language || '').trim().toLowerCase()
  const langHint = lang && lang !== 'auto' ? `主要语言：${lang}。` : ''
  const layout = options.preserveLayout === false
    ? '请仅输出纯文本，不要保留任何格式、连字符或项目符号。'
    : '请保留原始的段落结构、空行与缩进，便于后续阅读。'
  return [
    '你是一名专业的 OCR 文字识别助手。请逐字识别图片中的文字内容，',
    layout,
    langHint,
    '输出要求：',
    '- 仅输出识别出的文字本身，不要解释、不要添加引言或总结；',
    '- 若图片为空或没有可识别文字，输出空字符串。',
  ].filter(Boolean).join('')
}

/** Mirror MeetingASRService.getDataDir() so the scanner picks up the same
 *  persisted key as the rest of the app. Resolution order: env var → canonical Web UI home/meeting-asr. */
export function scannerDashScopeDataDir(): string {
  return process.env.MEETING_ASR_DATA_DIR
    || path.join(getWebUiHome(), 'meeting-asr')
}

/**
 * 按 profile 从「Realtime 模型设置」里读 DashScope API key。
 * 「设置 → 模型 → Realtime 模型」里的 DashScope key 实际存在 SQLite
 * (`realtime_settings` 表) 的 secrets 字段，meeting-asr 的
 * `readStoredDashScopeKey` 只读 config.json / config.env，找不到这处。
 * 所以 scanner 必须额外接 Realtime store 才能复用同一个 key。
 */
export function scannerRealtimeApiKey(profile?: string | null): string | null {
  const profileName = (profile || '').trim() || 'default'
  try {
    const row = getRealtimeModelSetting(profileName, { includeSecrets: true })
    const key = row?.secrets?.apiKey?.trim()
    return key || null
  } catch (error: any) {
    logger.warn({ err: error?.message, profile: profileName }, '[scanner] failed to read realtime model setting')
    return null
  }
}

export async function resolveScannerDashScopeKey(provided?: string, profile?: string | null): Promise<string | null> {
  if (provided && provided.trim()) return provided.trim()
  // 1) Realtime 模型（统一入口，用户在 设置 → 模型 → Realtime 模型 填的就是这里）
  const realtimeKey = scannerRealtimeApiKey(profile)
  if (realtimeKey) return realtimeKey
  // 2) meeting-asr 持久化目录（兼容老的 config.json / config.env）
  const stored = await readStoredDashScopeKey(scannerDashScopeDataDir()).catch(() => null)
  if (stored) return stored
  // 3) 进程环境变量
  const env = process.env.DASHSCOPE_API_KEY
  return env && env.trim() ? env.trim() : null
}

export function validateScannerInput(pages: ScannerOcrPageInput[]): ScannerOcrPageInput[] {
  if (!Array.isArray(pages) || pages.length === 0) {
    const err: any = new Error('scanner: at least one page is required')
    err.status = 400
    err.code = 'scanner_no_pages'
    throw err
  }
  if (pages.length > SCANNER_PAGES_MAX) {
    const err: any = new Error(`scanner: too many pages (max ${SCANNER_PAGES_MAX})`)
    err.status = 413
    err.code = 'scanner_too_many_pages'
    throw err
  }
  const cleaned: ScannerOcrPageInput[] = []
  for (const [index, page] of pages.entries()) {
    const url = normalizeImageDataUrl(page?.image || '')
    if (!url) {
      const err: any = new Error(`scanner: page ${index + 1} image is missing or unsupported`)
      err.status = 400
      err.code = 'scanner_bad_image'
      throw err
    }
    const base64 = url.split(',')[1] || ''
    if (base64.length > SCANNER_IMAGE_MAX_CHARS) {
      const err: any = new Error(`scanner: page ${index + 1} image too large (max ${SCANNER_IMAGE_MAX_CHARS} base64 chars)`)
      err.status = 413
      err.code = 'scanner_image_too_large'
      throw err
    }
    cleaned.push({ image: url })
  }
  return cleaned
}

/**
 * 调用 DashScope Qwen-VL-OCR 模型对单张图片做识别。导出便于单测（注入 fetch）。
 */
export async function callScannerOcr(
  pages: ScannerOcrPageInput[],
  options: ScannerOcrOptions = {},
  deps: { fetchImpl?: typeof fetch; apiKeyOverride?: string | null; profileOverride?: string | null } = {},
): Promise<ScannerOcrResult> {
  const cleaned = validateScannerInput(pages)
  const model = String(options.model || SCANNER_DEFAULT_MODEL)
  const baseUrl = String(options.baseUrl || SCANNER_BASE_URL).replace(/\/+$/, '')
  const profile = deps.profileOverride !== undefined ? deps.profileOverride : options.profile
  const apiKey = deps.apiKeyOverride !== undefined
    ? deps.apiKeyOverride
    : await resolveScannerDashScopeKey(options.apiKey, profile)
  if (!apiKey) {
    const err: any = new Error('scanner: DashScope API key is not configured')
    err.status = 400
    err.code = 'scanner_missing_api_key'
    throw err
  }

  const content: Array<Record<string, unknown>> = [{ type: 'text', text: promptForOcr(options) }]
  for (const page of cleaned) {
    content.push({ type: 'image_url', image_url: { url: page.image } })
  }

  const body = {
    model,
    messages: [{ role: 'user', content }],
    stream: false,
  }

  const fetchImpl = deps.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    const err: any = new Error('scanner: global fetch is not available')
    err.status = 500
    err.code = 'scanner_no_fetch'
    throw err
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SCANNER_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error: any) {
    clearTimeout(timer)
    if (error?.name === 'AbortError') {
      const err: any = new Error(`scanner: DashScope OCR timed out after ${SCANNER_TIMEOUT_MS / 1000}s`)
      err.status = 504
      err.code = 'scanner_timeout'
      throw err
    }
    logger.error({ err: error?.message }, '[scanner] DashScope request failed')
    const err: any = new Error(`scanner: DashScope request failed: ${error?.message || 'unknown'}`)
    err.status = 502
    err.code = 'scanner_network'
    throw err
  }
  clearTimeout(timer)

  if (!response.ok) {
    const snippet = await response.text().catch(() => '')
    logger.error(
      { status: response.status, snippet: snippet.slice(0, 500) },
      '[scanner] DashScope returned non-OK',
    )
    const err: any = new Error(`scanner: DashScope OCR failed (HTTP ${response.status}): ${snippet.slice(0, 200) || 'no body'}`)
    err.status = response.status >= 500 ? 502 : 400
    err.code = 'scanner_upstream_error'
    throw err
  }

  const json = await response.json().catch(() => null) as any
  const choice = json?.choices?.[0]
  const rawText = choice?.message?.content
  const text = extractOcrText(rawText)
  if (!text) {
    const err: any = new Error('scanner: DashScope OCR returned empty content')
    err.status = 502
    err.code = 'scanner_empty_response'
    throw err
  }

  // qwen-vl-ocr 对单条 user 消息里包含多张图片时，content 是一段 Markdown，
  // 每张图对应一段；用 ---PAGE--- 分隔。 单张图片则直接是文本。
  const segments = text.split(/^---PAGE---\s*$/m)
  const pages_out: ScannerOcrPageResult[] = []
  if (segments.length === cleaned.length) {
    for (const seg of segments) {
      const t = seg.trim()
      pages_out.push({ text: t, hasContent: t.length > 0 })
    }
  } else {
    // 不分页时按页数复制同一段（多页合并识别时的合理 fallback）
    for (let i = 0; i < cleaned.length; i += 1) {
      const t = i === 0 ? text.trim() : ''
      pages_out.push({ text: t, hasContent: t.length > 0 })
    }
  }

  return { pages: pages_out, model }
}

function extractOcrText(raw: unknown): string {
  if (raw == null) return ''
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && 'text' in part) {
          const t = (part as Record<string, unknown>).text
          return typeof t === 'string' ? t : ''
        }
        return ''
      })
      .join('')
  }
  return ''
}
