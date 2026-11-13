import { basename, extname } from 'path'

export type FilePreviewKind = 'image' | 'html' | 'pdf' | 'docx' | 'presentation' | 'spreadsheet' | 'csv'

export interface FilePreviewDescriptor {
  kind: FilePreviewKind
  mime: string
  maxBytes: number
}

const MEBIBYTE = 1024 * 1024

function envByteLimit(name: string, fallback: number): number {
  const value = Number.parseInt(String(process.env[name] || ''), 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const PREVIEW_LIMITS: Record<FilePreviewKind, number> = {
  image: envByteLimit('MAX_IMAGE_PREVIEW_SIZE', 50 * MEBIBYTE),
  html: envByteLimit('MAX_HTML_PREVIEW_SIZE', 10 * MEBIBYTE),
  pdf: envByteLimit('MAX_PDF_PREVIEW_SIZE', 50 * MEBIBYTE),
  docx: envByteLimit('MAX_DOCX_PREVIEW_SIZE', 25 * MEBIBYTE),
  presentation: envByteLimit('MAX_PRESENTATION_PREVIEW_SIZE', 50 * MEBIBYTE),
  spreadsheet: envByteLimit('MAX_SPREADSHEET_PREVIEW_SIZE', 25 * MEBIBYTE),
  csv: envByteLimit('MAX_CSV_PREVIEW_SIZE', 10 * MEBIBYTE),
}

const PREVIEW_BY_EXTENSION: Record<string, Omit<FilePreviewDescriptor, 'maxBytes'>> = {
  '.png': { kind: 'image', mime: 'image/png' },
  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.gif': { kind: 'image', mime: 'image/gif' },
  '.svg': { kind: 'image', mime: 'image/svg+xml' },
  '.webp': { kind: 'image', mime: 'image/webp' },
  '.bmp': { kind: 'image', mime: 'image/bmp' },
  '.ico': { kind: 'image', mime: 'image/x-icon' },
  '.html': { kind: 'html', mime: 'text/html; charset=utf-8' },
  '.htm': { kind: 'html', mime: 'text/html; charset=utf-8' },
  '.pdf': { kind: 'pdf', mime: 'application/pdf' },
  '.docx': { kind: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '.pptx': { kind: 'presentation', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  '.xlsx': { kind: 'spreadsheet', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  '.csv': { kind: 'csv', mime: 'text/csv; charset=utf-8' },
}

export function getFilePreviewDescriptor(fileName: string): FilePreviewDescriptor | null {
  const entry = PREVIEW_BY_EXTENSION[extname(fileName).toLowerCase()]
  return entry ? { ...entry, maxBytes: PREVIEW_LIMITS[entry.kind] } : null
}

export function assertPreviewFileSize(size: number, descriptor: FilePreviewDescriptor): void {
  if (!Number.isFinite(size) || size < 0) {
    throw Object.assign(new Error('Invalid file size'), { code: 'invalid_file', status: 400 })
  }
  if (size > descriptor.maxBytes) {
    throw Object.assign(
      new Error(`File too large to preview: ${size} bytes (limit ${descriptor.maxBytes})`),
      { code: 'file_too_large', status: 413 },
    )
  }
}

function safeAsciiFilename(fileName: string): string {
  return basename(fileName)
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/["\\]/g, '_')
    .replace(/[^\x20-\x7e]/g, '_') || 'file'
}

export function buildFileContentHeaders(options: {
  fileName: string
  mime: string
  size: number
  download?: boolean
}): Record<string, string> {
  const fileName = basename(options.fileName) || 'file'
  const disposition = options.download ? 'attachment' : 'inline'
  return {
    'Content-Type': options.mime,
    'Content-Disposition': `${disposition}; filename="${safeAsciiFilename(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    'Content-Length': String(options.size),
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  }
}
