import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'

// Agent file transfer stays in memory: uploads become page-side File objects and
// downloads are held as buffers until the agent reads them. Nothing is written to disk.
export const MAX_BROWSER_UPLOAD_FILES = 4
export const MAX_BROWSER_UPLOAD_BYTES = 10 * 1024 * 1024
export const MAX_BROWSER_DOWNLOAD_BYTES = 20 * 1024 * 1024
// One chunk must fit the remote relay's 2 MB message ceiling after base64 encoding.
export const BROWSER_DOWNLOAD_CHUNK_BYTES = 1024 * 1024
const DOWNLOAD_TTL_MS = 5 * 60_000
const MAX_PENDING_DOWNLOADS = 4

export type BrowserUploadMethod = 'auto' | 'input' | 'drop' | 'paste'

export interface BrowserUploadFile {
  name: string
  type: string
  data: string
}

export interface BrowserUploadResult {
  method: Exclude<BrowserUploadMethod, 'auto'>
  files: Array<{ name: string; type: string; size: number }>
}

export interface BrowserDownloadInfo {
  downloadId: string
  fileName: string
  mimeType: string
  size: number
  sourceUrl: string
  chunkSize: number
}

export interface BrowserDownloadChunk {
  downloadId: string
  offset: number
  data: string
  returnedBytes: number
  size: number
  done: boolean
  nextOffset?: number
}

function sanitizeFileName(input: unknown, fallback = 'file'): string {
  const name = basename(String(input ?? '').replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200)
  return name || fallback
}

function sanitizeMimeType(input: unknown): string {
  const value = String(input ?? '').trim().toLowerCase()
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value) && value.length <= 127 ? value : 'application/octet-stream'
}

export function parseBrowserUploadFiles(value: unknown): BrowserUploadFile[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BROWSER_UPLOAD_FILES) {
    throw new Error(`files must contain 1 to ${MAX_BROWSER_UPLOAD_FILES} files`)
  }
  let total = 0
  return value.map((item, index) => {
    const row = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {}
    if (typeof row.data !== 'string' || !row.data || !/^[A-Za-z0-9+/]*={0,2}$/.test(row.data)) {
      throw new Error(`files[${index}].data must be base64`)
    }
    total += Buffer.byteLength(row.data, 'base64')
    if (total > MAX_BROWSER_UPLOAD_BYTES) throw new Error('Uploaded files exceed the 10 MB limit')
    return { name: sanitizeFileName(row.name), type: sanitizeMimeType(row.type), data: row.data }
  })
}

export function parseBrowserUploadMethod(value: unknown): BrowserUploadMethod {
  if (value === undefined) return 'auto'
  if (value === 'auto' || value === 'input' || value === 'drop' || value === 'paste') return value
  throw new Error('method must be auto, input, drop or paste')
}

// Runs inside the page with `this` bound to the snapshot node. A visible upload button
// is usually paired with a hidden <input type=file>, so search the button and its
// nearest containers before falling back to a synthetic drop on the element itself.
export const UPLOAD_FUNCTION = `function (files, method) {
  const node = this;
  const element = node && node.nodeType === 3 ? node.parentElement : node;
  const isFileInput = item => item instanceof HTMLInputElement && item.type === 'file';
  // Pages may open a picker from an input that was never attached to the document.
  if (!element || !element.isConnected && !isFileInput(element)) throw new Error('Browser element was removed');
  const findInput = () => {
    if (isFileInput(element)) return element;
    if (element instanceof HTMLLabelElement && isFileInput(element.control)) return element.control;
    const inside = element.querySelectorAll('input[type="file"]');
    if (inside.length === 1) return inside[0];
    for (let parent = element.parentElement, depth = 0; parent && depth < 6; parent = parent.parentElement, depth++) {
      const found = parent.querySelectorAll('input[type="file"]');
      if (found.length === 1) return found[0];
      if (found.length > 1) break;
    }
    return null;
  };
  const transfer = new DataTransfer();
  for (const file of files) {
    const binary = atob(file.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    transfer.items.add(new File([bytes], file.name, { type: file.type, lastModified: Date.now() }));
  }
  const summary = Array.from(transfer.files, file => ({ name: file.name, type: file.type, size: file.size }));
  const input = method === 'auto' || method === 'input' ? findInput() : null;
  if (input) {
    if (input.disabled) throw new Error('File input is disabled');
    if (transfer.files.length > 1 && !input.multiple) throw new Error('This file input accepts only one file');
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { method: 'input', files: summary };
  }
  if (method === 'input') throw new Error('No file input was found for this element; try method=drop or method=paste');
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  if (method === 'paste') {
    if (typeof element.focus === 'function') element.focus();
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    return { method: 'paste', files: summary };
  }
  for (const type of ['dragenter', 'dragover', 'drop']) {
    element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }
  return { method: 'drop', files: summary };
}`

// Resolves the URL a link, image or media element points to, in absolute form.
export const DOWNLOAD_SOURCE_FUNCTION = `function () {
  const node = this;
  const element = node && node.nodeType === 3 ? node.parentElement : node;
  if (!element) throw new Error('Browser element was removed');
  const link = element.closest('a[href]');
  if (link) return { url: link.href, fileName: link.getAttribute('download') || '' };
  const media = element.matches('img,video,audio,source') ? element : element.querySelector('img,video,audio');
  const source = media && (media.currentSrc || media.src);
  if (source) return { url: source, fileName: '' };
  throw new Error('Element is not a link, image or media element');
}`

// blob: URLs only exist inside the page, so they are read there and returned as base64.
export const PAGE_BLOB_FUNCTION = `async function (url, limit) {
  const response = await fetch(url);
  const blob = await response.blob();
  if (blob.size > limit) throw new Error('Download exceeds the size limit');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { data: btoa(binary), type: blob.type || '' };
}`

export function fileNameFromResponse(url: string, contentDisposition: string | null, suggested = ''): string {
  if (suggested) return sanitizeFileName(suggested, 'download')
  const header = contentDisposition || ''
  const encoded = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header)?.[1]
  if (encoded) {
    try { return sanitizeFileName(decodeURIComponent(encoded.trim().replace(/^"|"$/g, '')), 'download') } catch { /* fall through */ }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header)?.[1]
  if (plain) return sanitizeFileName(plain, 'download')
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return sanitizeFileName(decodeURIComponent(parsed.pathname.split('/').pop() || ''), 'download')
    }
  } catch { /* fall through */ }
  return 'download'
}

interface PendingDownload {
  buffer: Buffer
  info: BrowserDownloadInfo
  expiresAt: number
  timer: NodeJS.Timeout
}

export class BrowserDownloadStore {
  private readonly pending = new Map<string, PendingDownload>()

  add(buffer: Buffer, meta: { fileName: string; mimeType: string; sourceUrl: string }): BrowserDownloadInfo {
    if (buffer.length > MAX_BROWSER_DOWNLOAD_BYTES) throw new Error('Download exceeds the 20 MB limit')
    while (this.pending.size >= MAX_PENDING_DOWNLOADS) this.remove(this.pending.keys().next().value!)
    const downloadId = randomUUID()
    const info: BrowserDownloadInfo = {
      downloadId, fileName: sanitizeFileName(meta.fileName, 'download'), mimeType: sanitizeMimeType(meta.mimeType),
      size: buffer.length, sourceUrl: meta.sourceUrl, chunkSize: BROWSER_DOWNLOAD_CHUNK_BYTES,
    }
    const timer = setTimeout(() => this.remove(downloadId), DOWNLOAD_TTL_MS)
    timer.unref?.()
    this.pending.set(downloadId, { buffer, info, expiresAt: Date.now() + DOWNLOAD_TTL_MS, timer })
    return info
  }

  read(downloadId: string, offset: number): BrowserDownloadChunk {
    const entry = this.pending.get(downloadId)
    if (!entry || entry.expiresAt <= Date.now()) throw new Error('Browser download expired or was already read; download it again')
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > entry.buffer.length) throw new Error('offset is outside the download')
    const chunk = entry.buffer.subarray(offset, offset + BROWSER_DOWNLOAD_CHUNK_BYTES)
    const next = offset + chunk.length
    const done = next >= entry.buffer.length
    if (done) this.remove(downloadId)
    return {
      downloadId, offset, data: chunk.toString('base64'), returnedBytes: chunk.length, size: entry.buffer.length, done,
      ...(done ? {} : { nextOffset: next }),
    }
  }

  clear(): void {
    for (const id of [...this.pending.keys()]) this.remove(id)
  }

  private remove(downloadId: string): void {
    const entry = this.pending.get(downloadId)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(downloadId)
  }
}

export async function readLimitedBody(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > limit) throw new Error('Download exceeds the 20 MB limit')
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.length
    if (length > limit) {
      await reader.cancel().catch(() => undefined)
      throw new Error('Download exceeds the 20 MB limit')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, length)
}
