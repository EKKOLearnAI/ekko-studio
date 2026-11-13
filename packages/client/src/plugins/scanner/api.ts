import { request, getBaseUrl } from '@/api/client'

/**
 * 扫描 OCR 插件的前端 API 封装。
 *
 * 与服务端 packages/server/src/services/scanner/* + controllers/scanner.ts
 * 协议对齐：所有请求走 `/api/studio/scanner/*`，多页文档统一用 `pages: [...]`
 * 数组传递，便于后续扩展（批量识别、多页合并）。
 */

export interface ScannerPageInput {
  /** data:image/jpeg;base64,…；camera 拍照后直接 toDataURL('image/jpeg') 即可。 */
  image: string
}

export interface ScannerPageResult {
  text: string
  hasContent: boolean
}

export interface ScannerOcrRequest {
  pages: ScannerPageInput[]
  /** 主语言提示，如 'zh' / 'en' / 'auto'。 */
  language?: string
  /** 是否保留排版（段间距 / 缩进）。默认 true。 */
  preserveLayout?: boolean
  /** 模型名覆盖，默认 'qwen-vl-ocr'。 */
  model?: string
  /** 可选：临时覆盖 DashScope API key（不传则用服务端持久化的 key）。 */
  apiKey?: string
}

export interface ScannerOcrResponse {
  pages: ScannerPageResult[]
  model: string
}

export interface ScannerSavePage extends ScannerPageInput {
  text?: string
}

export interface ScannerPdfPageInput extends ScannerPageInput {
  /** 该页 OCR 文本；searchable PDF 的隐藏文字层数据源。 */
  text?: string
}

export interface ScannerPdfOptions {
  /** 页面布局：'image'（默认）满版跟随图片；'a4' 固定 A4 留白打印版。 */
  layout?: 'image' | 'a4'
  /** layout='image' 时的输出 DPI（72..600，默认 200）。 */
  dpi?: number
  /** 把 OCR 文本作为隐藏文字层嵌进 PDF（可搜索 / 可复制）。 */
  searchable?: boolean
}

export interface ScannerSaveRequest {
  pages: ScannerSavePage[]
  title?: string
  profile?: string
  workspace?: string
}

export interface ScannerSaveFileEntry {
  name: string
  kind: 'image' | 'text' | 'manifest'
  path: string
}

export interface ScannerSaveResponse {
  workspaceDir: string
  directory: string
  files: ScannerSaveFileEntry[]
  markdownPath: string
  manifestPath: string
}

export function runScannerOcr(input: ScannerOcrRequest): Promise<ScannerOcrResponse> {
  return request<ScannerOcrResponse>('/api/studio/scanner/ocr', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function saveScannerDocument(input: ScannerSaveRequest): Promise<ScannerSaveResponse> {
  return request<ScannerSaveResponse>('/api/studio/scanner/save', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

/**
 * 把多张扫描图打包成 PDF。返回 Blob URL，调用方负责 `URL.revokeObjectURL` 释放。
 * 不能复用 `request()`：服务端返回 application/pdf 流而非 JSON。
 */
export async function exportScannerPdf(
  pages: ScannerPdfPageInput[],
  options: ScannerPdfOptions = {},
): Promise<{ blob: Blob; url: string; filename: string }> {
  const apiKey = (typeof localStorage !== 'undefined' ? localStorage.getItem('hermes_api_key') : '') || ''
  const profile = (typeof localStorage !== 'undefined' ? localStorage.getItem('hermes_active_profile_name') : '') || ''
  const baseUrl = getBaseUrl()

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  if (profile) headers['X-Hermes-Profile'] = profile

  const response = await fetch(`${baseUrl}/api/studio/scanner/pdf`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      pages,
      layout: options.layout,
      dpi: options.dpi,
      searchable: options.searchable,
      texts: options.searchable ? pages.map(p => p.text || '') : undefined,
    }),
  })
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const data = await response.json()
      if (data?.error) message = data.error
    } catch {
      /* ignore parse errors */
    }
    throw new Error(message)
  }
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const filename = parseFilename(response.headers.get('content-disposition'))
    || `scanner-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}.pdf`
  return { blob, url, filename }
}

function parseFilename(disposition: string | null): string | null {
  if (!disposition) return null
  const match = /filename="?([^"]+)"?/i.exec(disposition)
  return match ? match[1]! : null
}
