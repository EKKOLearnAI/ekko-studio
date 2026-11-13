import type { Context } from 'koa'
import { logger } from '../public/logging'
import {
  callScannerOcr,
  ScannerOcrOptions,
  ScannerOcrPageInput,
} from '../services/scanner/ocr'
import { buildScannerImagePdf, ScannerPdfImagePage } from '../services/scanner/pdf'
import { saveScannerPages, ScannerSavePage } from '../services/scanner/storage'
import { getDefaultProfileForUser } from '../public/users'

const MAX_BODY_BYTES = 32 * 1024 * 1024 // 32MB
const PDF_MAX_PAGES = 60

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
  const explicit = (ctx.state?.profile?.name
    || (typeof ctx.query?.profile === 'string' ? ctx.query.profile : '')
    || ctx.get?.('x-hermes-profile')
    || '').trim()
  if (explicit) return explicit
  const user = ctx.state?.user
  if (user && user.role !== 'super_admin' && !ctx.state?.serverTokenAuth) {
    const bound: string[] = user.profiles || []
    if (bound.length === 1) return bound[0]
    if (bound.length > 1) {
      const fallback = getDefaultProfileForUser(user.id)
      if (bound.includes(fallback)) return fallback
      const err: any = new Error('Profile is required')
      err.status = 400
      err.code = 'profile_required'
      throw err
    }
  }
  return 'default'
}

function dataUrlToBuffer(dataUrl: string): { buffer: Buffer; mime: string } | null {
  const trimmed = String(dataUrl || '').trim()
  const match = /^data:([^;]+);base64,(.+)$/i.exec(trimmed)
  if (!match) return null
  const mime = match[1]!.toLowerCase()
  try {
    const buffer = Buffer.from(match[2]!, 'base64')
    if (buffer.length === 0) return null
    return { buffer, mime }
  } catch {
    return null
  }
}

function ensureBodySize(body: any): asserts body is object {
  if (!body || typeof body !== 'object') {
    const err: any = new Error('scanner: invalid JSON body')
    err.status = 400
    err.code = 'scanner_bad_body'
    throw err
  }
}

function handleServiceError(ctx: Context, error: any) {
  if (error && typeof error === 'object' && 'status' in error) {
    ctx.status = Number(error.status) || 500
    ctx.body = { error: error.message || 'scanner error', code: error.code || 'scanner_error' }
    return
  }
  logger.error({ err: (error as Error)?.message }, '[scanner] unhandled controller error')
  ctx.status = 500
  ctx.body = { error: (error as Error)?.message || 'scanner internal error', code: 'scanner_internal' }
}

/**
 * POST /api/studio/scanner/ocr
 * body: { pages: [{ image: 'data:image/jpeg;base64,…' }], language?, preserveLayout?, model?, apiKey? }
 */
export async function runOcr(ctx: Context): Promise<void> {
  const userId = authUserId(ctx)
  if (!userId) return
  const body = (ctx.request as any).body
  ensureBodySize(body)
  const rawPages = Array.isArray((body as any).pages) ? (body as any).pages : []
  const pages: ScannerOcrPageInput[] = []
  for (const raw of rawPages) {
    if (raw && typeof raw.image === 'string') pages.push({ image: raw.image })
  }
  const options: ScannerOcrOptions = {
    language: typeof (body as any).language === 'string' ? (body as any).language : undefined,
    preserveLayout: typeof (body as any).preserveLayout === 'boolean' ? (body as any).preserveLayout : undefined,
    model: typeof (body as any).model === 'string' ? (body as any).model : undefined,
    apiKey: typeof (body as any).apiKey === 'string' ? (body as any).apiKey : undefined,
    baseUrl: typeof (body as any).baseUrl === 'string' ? (body as any).baseUrl : undefined,
    profile: requestedProfile(ctx),
  }
  try {
    const result = await callScannerOcr(pages, options)
    ctx.body = result
  } catch (error) {
    handleServiceError(ctx, error)
  }
}

/**
 * POST /api/studio/scanner/pdf
 * body: { pages: [{ image, mime? }], layout?: 'image'|'a4', dpi?, searchable?, texts?: string[] }
 * 返回 application/pdf 流。
 */
export async function buildPdf(ctx: Context): Promise<void> {
  const userId = authUserId(ctx)
  if (!userId) return
  const body = (ctx.request as any).body
  ensureBodySize(body)
  const rawPages = Array.isArray((body as any).pages) ? (body as any).pages : []
  if (rawPages.length === 0) {
    ctx.status = 400
    ctx.body = { error: 'scanner: no pages provided', code: 'scanner_no_pages' }
    return
  }
  if (rawPages.length > PDF_MAX_PAGES) {
    ctx.status = 413
    ctx.body = { error: `scanner: too many pages (max ${PDF_MAX_PAGES})`, code: 'scanner_too_many_pages' }
    return
  }
  const pages: ScannerPdfImagePage[] = []
  for (const [idx, raw] of rawPages.entries()) {
    const dataUrl = typeof raw?.image === 'string' ? raw.image : ''
    const parsed = dataUrlToBuffer(dataUrl)
    if (!parsed) {
      ctx.status = 400
      ctx.body = { error: `scanner: page ${idx + 1} image is invalid`, code: 'scanner_bad_image' }
      return
    }
    pages.push({ buffer: parsed.buffer, mime: parsed.mime })
  }
  const rawLayout = typeof (body as any).layout === 'string' ? (body as any).layout : ''
  const layout = rawLayout === 'a4' ? 'a4' : 'image'
  const rawDpi = Number((body as any).dpi)
  const dpi = Number.isFinite(rawDpi) && rawDpi >= 72 && rawDpi <= 600 ? rawDpi : undefined
  // 可搜索 PDF：texts 与 pages 平行；长度不符时按短的那份截断，缺的页视为无文本
  const searchable = (body as any).searchable === true
  const rawTexts = Array.isArray((body as any).texts) ? (body as any).texts : []
  const texts = searchable
    ? pages.map((_, i) => (typeof rawTexts[i] === 'string' ? rawTexts[i] : ''))
    : undefined
  try {
    const pdf = await buildScannerImagePdf(pages, { layout, dpi, searchable, texts })
    const filename = `scanner-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}.pdf`
    ctx.set('Content-Type', 'application/pdf')
    ctx.set('Content-Disposition', `attachment; filename="${filename}"`)
    ctx.set('Content-Length', String(pdf.length))
    ctx.body = pdf
  } catch (error) {
    handleServiceError(ctx, error)
  }
}

/**
 * POST /api/studio/scanner/save
 * body: { pages: [{ image: 'data:image/jpeg;base64,…', text?, mime? }], title?, profile?, workspace? }
 * 把扫描图片 + 文本落到 Hermes profile 的 workspace 下。
 */
export async function saveScan(ctx: Context): Promise<void> {
  const userId = authUserId(ctx)
  if (!userId) return
  const body = (ctx.request as any).body
  ensureBodySize(body)
  const rawPages = Array.isArray((body as any).pages) ? (body as any).pages : []
  if (rawPages.length === 0) {
    ctx.status = 400
    ctx.body = { error: 'scanner: no pages provided', code: 'scanner_no_pages' }
    return
  }
  const profile = (() => {
    try {
      return requestedProfile(ctx)
    } catch (error) {
      const err: any = error as Error
      ctx.status = err.status || 400
      ctx.body = { error: err.message || 'profile required', code: err.code || 'profile_required' }
      return null
    }
  })()
  if (!profile) return

  const pages: ScannerSavePage[] = []
  let totalBytes = 0
  for (const [idx, raw] of rawPages.entries()) {
    const dataUrl = typeof raw?.image === 'string' ? raw.image : ''
    const parsed = dataUrlToBuffer(dataUrl)
    if (!parsed) {
      ctx.status = 400
      ctx.body = { error: `scanner: page ${idx + 1} image is invalid`, code: 'scanner_bad_image' }
      return
    }
    totalBytes += parsed.buffer.length
    if (totalBytes > MAX_BODY_BYTES) {
      ctx.status = 413
      ctx.body = { error: 'scanner: total upload too large', code: 'scanner_too_large' }
      return
    }
    pages.push({
      buffer: parsed.buffer,
      mime: parsed.mime,
      text: typeof raw?.text === 'string' ? raw.text : undefined,
    })
  }
  try {
    const result = await saveScannerPages(pages, {
      profile,
      title: typeof (body as any).title === 'string' ? (body as any).title : undefined,
      workspace: typeof (body as any).workspace === 'string' ? (body as any).workspace : undefined,
    })
    ctx.body = result
  } catch (error) {
    handleServiceError(ctx, error)
  }
}
