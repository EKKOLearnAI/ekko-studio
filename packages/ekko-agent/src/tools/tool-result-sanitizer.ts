import { createHash } from 'node:crypto'
import { readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AgentToolContentPart, AgentToolResult } from './types'
import { ensureToolAssetDirectory } from './workspace-temp'

const DATA_URL_RE = /data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\r\n]+)/g
const BASE64_FIELD_RE = /^(?:base64|b64|bodyBase64|dataUrl|image_base64|audio_base64)$/i
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024
const MIN_RAW_BASE64_CHARS = 4_096
export const DEFAULT_TOOL_RESULT_MAX_TEXT_BYTES = 256_000
export const DEFAULT_TOOL_RESULT_MAX_TEXT_ARTIFACT_BYTES = 25 * 1024 * 1024

export interface ToolResultSanitizerOptions {
  tempRoot?: string
  ttlMs?: number
  maxBytes?: number
  maxTextBytes?: number
  maxTextArtifactBytes?: number
  now?: number
  compactJson?: boolean
}

export async function sanitizeAgentToolResult(
  result: AgentToolResult,
  options: ToolResultSanitizerOptions = {},
): Promise<AgentToolResult> {
  const tempRoot = options.tempRoot || join(tmpdir(), 'ekko-agent', 'tool-assets')
  await cleanupExpiredToolAssets(tempRoot, options.ttlMs ?? DEFAULT_TTL_MS, options.now ?? Date.now())
  const seen = new WeakSet<object>()
  const sanitize = (value: unknown, key = ''): Promise<unknown> => sanitizeValue(value, key, tempRoot, options, seen)
  const content = String(await sanitizeStructuredText(result.content, sanitize, options.compactJson))
  const error = result.error === undefined
    ? undefined
    : String(await sanitizeStructuredText(result.error, sanitize))
  return {
    ...result,
    content: await boundToolResultText(content, tempRoot, options.maxTextBytes, options.maxTextArtifactBytes),
    data: result.data === undefined ? undefined : await sanitize(result.data),
    error: error === undefined
      ? undefined
      : await boundToolResultText(error, tempRoot, options.maxTextBytes, options.maxTextArtifactBytes),
    contentParts: result.contentParts?.reduce<AgentToolContentPart[]>((parts, part) => {
      if (part.type === 'text') parts.push({ type: 'text', text: part.text.slice(0, 100_000) })
      else if (/^image\/(?:png|jpeg|webp|gif)$/i.test(part.mimeType)
        && looksLikeBase64(part.data)
        && Buffer.byteLength(part.data, 'base64') <= (options.maxBytes ?? DEFAULT_MAX_BYTES)) {
        parts.push({ type: 'image', data: part.data, mimeType: part.mimeType.toLowerCase() })
      }
      return parts
    }, []),
  }
}

async function boundToolResultText(
  text: string,
  tempRoot: string,
  requestedMaxBytes = DEFAULT_TOOL_RESULT_MAX_TEXT_BYTES,
  requestedMaxArtifactBytes = DEFAULT_TOOL_RESULT_MAX_TEXT_ARTIFACT_BYTES,
): Promise<string> {
  const maxBytes = positiveInteger(requestedMaxBytes, DEFAULT_TOOL_RESULT_MAX_TEXT_BYTES)
  const maxArtifactBytes = positiveInteger(
    requestedMaxArtifactBytes,
    DEFAULT_TOOL_RESULT_MAX_TEXT_ARTIFACT_BYTES,
  )
  const buffer = Buffer.from(text)
  if (buffer.length <= maxBytes) return text
  const digest = createHash('sha256').update(buffer).digest('hex')
  const candidateArtifactPath = join(tempRoot, `tool-result-${digest}.txt`)
  const artifactBuffer = buffer.subarray(0, maxArtifactBytes)
  const artifactTruncated = artifactBuffer.length < buffer.length
  let artifactPath: string | undefined
  try {
    await ensureToolAssetDirectory(tempRoot)
    try {
      await writeFile(candidateArtifactPath, artifactBuffer, { flag: 'wx', mode: 0o600 })
      artifactPath = candidateArtifactPath
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const existing = await stat(candidateArtifactPath).catch(() => undefined)
        if (existing?.isFile() && existing.size === artifactBuffer.length) artifactPath = candidateArtifactPath
      }
    }
  } catch {
    // The bounded preview remains usable even when artifact persistence is unavailable.
  }
  const tailBytes = Math.max(1, Math.floor(maxBytes / 3))
  const headBytes = maxBytes - tailBytes
  const omittedBytes = buffer.length - maxBytes
  const marker = [
    '',
    '',
    `[tool result truncated: ${buffer.length} bytes total, ${omittedBytes} bytes omitted.`,
    artifactPath && artifactTruncated
      ? `The first ${artifactBuffer.length} bytes were saved to ${artifactPath}; the artifact reached its safety limit. Use a narrower tool query to retrieve later sections.]`
      : artifactPath
        ? `Full output saved to ${artifactPath}; inspect it with read_file using offsets or a bounded search.]`
      : 'Full output could not be saved; use a narrower tool query to retrieve the omitted section.]',
    '',
    '',
  ].join('\n')
  return `${buffer.subarray(0, headBytes).toString('utf8')}${marker}${buffer.subarray(-tailBytes).toString('utf8')}`
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback
}

export async function cleanupExpiredToolAssets(
  tempRoot = join(tmpdir(), 'ekko-agent', 'tool-assets'),
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now(),
): Promise<void> {
  let entries
  try {
    entries = await readdir(tempRoot, { withFileTypes: true })
  } catch {
    return
  }
  await Promise.all(entries.map(async entry => {
    if (!entry.isFile()) return
    const path = join(tempRoot, entry.name)
    try {
      const info = await stat(path)
      if (now - info.mtimeMs > ttlMs) await unlink(path)
    } catch {
      // A concurrent cleanup or writer may have changed the file.
    }
  }))
}

async function sanitizeStructuredText(
  text: string,
  sanitize: (value: unknown, key?: string) => Promise<unknown>,
  compact = false,
): Promise<string> {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(await sanitize(JSON.parse(trimmed)), null, compact ? undefined : 2)
    } catch {
      // Fall through to embedded data-URL replacement.
    }
  }
  return replaceEmbeddedDataUrls(text, sanitize)
}

async function sanitizeValue(
  value: unknown,
  key: string,
  tempRoot: string,
  options: ToolResultSanitizerOptions,
  seen: WeakSet<object>,
): Promise<unknown> {
  if (typeof value === 'string') {
    const dataUrl = parseDataUrl(value)
    if (dataUrl) return materializeBinary(dataUrl.mime, dataUrl.base64, tempRoot, options)
    if (BASE64_FIELD_RE.test(key) && value.length >= MIN_RAW_BASE64_CHARS && looksLikeBase64(value)) {
      return materializeBinary('application/octet-stream', value, tempRoot, options)
    }
    return replaceEmbeddedDataUrls(value, child => sanitizeValue(child, key, tempRoot, options, seen))
  }
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular value omitted]'
  seen.add(value)
  if (Array.isArray(value)) {
    return Promise.all(value.map(child => sanitizeValue(child, '', tempRoot, options, seen)))
  }
  const cleaned: Record<string, unknown> = {}
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    cleaned[childKey] = await sanitizeValue(child, childKey, tempRoot, options, seen)
  }
  return cleaned
}

async function replaceEmbeddedDataUrls(
  text: string,
  sanitize: (value: unknown, key?: string) => Promise<unknown>,
): Promise<string> {
  const matches = [...text.matchAll(DATA_URL_RE)]
  if (!matches.length) return text
  let output = ''
  let cursor = 0
  for (const match of matches) {
    const index = match.index ?? 0
    output += text.slice(cursor, index)
    output += String(await sanitize(match[0]))
    cursor = index + match[0].length
  }
  return output + text.slice(cursor)
}

function parseDataUrl(value: string): { mime: string; base64: string } | null {
  const match = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\r\n]+)$/.exec(value.trim())
  return match ? { mime: match[1].toLowerCase(), base64: match[2] } : null
}

function looksLikeBase64(value: string): boolean {
  const compact = value.replace(/[\r\n]/g, '')
  return compact.length % 4 === 0 && /^[a-zA-Z0-9+/]+={0,2}$/.test(compact)
}

async function materializeBinary(
  mime: string,
  base64: string,
  tempRoot: string,
  options: ToolResultSanitizerOptions,
): Promise<string> {
  const buffer = Buffer.from(base64.replace(/[\r\n]/g, ''), 'base64')
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  if (buffer.length > maxBytes) return `[base64 omitted: ${mime}, ${buffer.length} bytes exceeds limit]`
  const digest = createHash('sha256').update(buffer).digest('hex')
  const path = join(tempRoot, `${digest}.${extensionForMime(mime)}`)
  await ensureToolAssetDirectory(tempRoot)
  try {
    await writeFile(path, buffer, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return pathToFileURL(path).href
}

function extensionForMime(mime: string): string {
  const extensions: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'application/pdf': 'pdf',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
    'video/mp4': 'mp4',
  }
  return extensions[mime] || 'bin'
}
