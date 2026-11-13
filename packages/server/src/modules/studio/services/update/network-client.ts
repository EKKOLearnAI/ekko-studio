import http from 'http'
import https from 'https'
import { createHash } from 'crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, createWriteStream, createReadStream, truncateSync, writeFileSync, renameSync, statSync, fstatSync } from 'fs'
import { dirname } from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import type { ReadableStream as NodeReadableStream } from 'stream/web'

export type UpdateNetworkTransport = 'fetch' | 'node-http'
export type UpdateNetworkResponseType = 'json' | 'binary'

export interface UpdateNetworkResponse {
  ok: boolean
  status: number
  url: string
  transport: UpdateNetworkTransport
  buffer: Buffer
  attempts: number
}

export interface UpdateNetworkErrorDetail {
  name: string
  message: string
  code?: string
  syscall?: string
  address?: string
  port?: number
}

export class UpdateNetworkError extends Error {
  url: string
  responseType: UpdateNetworkResponseType
  timeoutMs: number
  attempts: number
  primaryError: UpdateNetworkErrorDetail
  fallbackError: UpdateNetworkErrorDetail

  constructor(
    url: string,
    responseType: UpdateNetworkResponseType,
    timeoutMs: number,
    attempts: number,
    primaryError: UpdateNetworkErrorDetail,
    fallbackError: UpdateNetworkErrorDetail,
  ) {
    super(
      `${responseType} request failed for ${url}: fetch failed (${primaryError.message}); `
      + `node-http fallback failed (${fallbackError.message})`,
    )
    this.name = 'UpdateNetworkError'
    this.url = url
    this.responseType = responseType
    this.timeoutMs = timeoutMs
    this.attempts = attempts
    this.primaryError = primaryError
    this.fallbackError = fallbackError
  }
}

export interface UpdateNetworkRequestOptions {
  timeoutMs?: number
  retries?: number
  retryDelayMs?: number
}

export interface UpdateBinaryDownloadOptions extends UpdateNetworkRequestOptions {
  expectedBytes?: number
  expectedSha256?: string
}

export interface UpdateBinaryDownloadResult {
  ok: boolean
  status: number
  url: string
  transport: UpdateNetworkTransport
  attempts: number
  bytesWritten: number
  sha256: string
}

export type UpdateBinaryValidationReason =
  | 'content_length_mismatch'
  | 'size_exceeded'
  | 'size_mismatch'
  | 'sha256_mismatch'

export class UpdateBinaryValidationError extends Error {
  url: string
  reason: UpdateBinaryValidationReason
  expectedBytes?: number
  actualBytes?: number
  expectedSha256?: string
  actualSha256?: string

  constructor(
    url: string,
    reason: UpdateBinaryValidationReason,
    message: string,
    details: {
      expectedBytes?: number
      actualBytes?: number
      expectedSha256?: string
      actualSha256?: string
    } = {},
  ) {
    super(message)
    this.name = 'UpdateBinaryValidationError'
    this.url = url
    this.reason = reason
    this.expectedBytes = details.expectedBytes
    this.actualBytes = details.actualBytes
    this.expectedSha256 = details.expectedSha256
    this.actualSha256 = details.actualSha256
  }
}

function toNetworkErrorDetail(err: any): UpdateNetworkErrorDetail {
  return {
    name: String(err?.name || 'Error'),
    message: String(err?.message || err || 'request failed'),
    code: typeof err?.code === 'string' ? err.code : undefined,
    syscall: typeof err?.syscall === 'string' ? err.syscall : undefined,
    address: typeof err?.address === 'string' ? err.address : undefined,
    port: typeof err?.port === 'number' ? err.port : undefined,
  }
}

function buildAcceptHeader(responseType: UpdateNetworkResponseType): string {
  return responseType === 'json' ? 'application/json' : 'application/octet-stream, */*'
}

function parseContentLength(value: string | null | undefined): number | undefined {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function validateContentLength(url: string, contentLength: number | undefined, expectedBytes: number | undefined): void {
  if (expectedBytes == null || contentLength == null) return
  if (contentLength !== expectedBytes) {
    throw new UpdateBinaryValidationError(
      url,
      'content_length_mismatch',
      `Downloaded update binary size header mismatch for ${url}: expected ${expectedBytes} bytes but server announced ${contentLength}.`,
      {
        expectedBytes,
        actualBytes: contentLength,
      },
    )
  }
}

async function writeBinaryPayloadToFile(
  source: NodeJS.ReadableStream,
  targetFile: string,
  url: string,
  expectedBytes?: number,
  expectedSha256?: string,
): Promise<{ bytesWritten: number; sha256: string }> {
  let bytesWritten = 0
  const hash = createHash('sha256')
  const validator = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytesWritten += buffer.length
      if (expectedBytes != null && bytesWritten > expectedBytes) {
        callback(new UpdateBinaryValidationError(
          url,
          'size_exceeded',
          `Downloaded update binary exceeded the expected size for ${url}: expected ${expectedBytes} bytes but received more.`,
          {
            expectedBytes,
            actualBytes: bytesWritten,
          },
        ))
        return
      }
      hash.update(buffer)
      callback(null, buffer)
    },
  })

  try {
    await pipeline(source, validator, createWriteStream(targetFile))
    const sha256 = hash.digest('hex')
    if (expectedBytes != null && bytesWritten !== expectedBytes) {
      throw new UpdateBinaryValidationError(
        url,
        'size_mismatch',
        `Downloaded update binary size mismatch for ${url}: expected ${expectedBytes} bytes but received ${bytesWritten}.`,
        {
          expectedBytes,
          actualBytes: bytesWritten,
        },
      )
    }
    if (expectedSha256 && sha256 !== expectedSha256) {
      throw new UpdateBinaryValidationError(
        url,
        'sha256_mismatch',
        `Downloaded update binary checksum mismatch for ${url}.`,
        {
          expectedSha256,
          actualSha256: sha256,
          actualBytes: bytesWritten,
          expectedBytes,
        },
      )
    }
    return { bytesWritten, sha256 }
  } catch (error) {
    rmSync(targetFile, { force: true })
    throw error
  }
}

async function requestWithFetch(
  url: string,
  responseType: UpdateNetworkResponseType,
  timeoutMs: number,
): Promise<UpdateNetworkResponse> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: buildAcceptHeader(responseType),
        'User-Agent': 'hermes-web-ui-update-client',
      },
      redirect: 'follow',
      signal: controller.signal,
    })

    return {
      ok: response.ok,
      status: response.status,
      url: response.url || url,
      transport: 'fetch',
      buffer: Buffer.from(await response.arrayBuffer()),
      attempts: 1,
    }
  } finally {
    clearTimeout(timeout)
  }
}

function requestWithNodeHttp(
  url: string,
  responseType: UpdateNetworkResponseType,
  timeoutMs: number,
  redirectCount = 0,
): Promise<UpdateNetworkResponse> {
  if (redirectCount > 5) {
    return Promise.reject(new Error(`Too many redirects while downloading update resource: ${url}`))
  }

  const target = new URL(url)
  const client = target.protocol === 'https:' ? https : http

  return new Promise((resolve, reject) => {
    const req = client.request(target, {
      method: 'GET',
      headers: {
        Accept: buildAcceptHeader(responseType),
        'User-Agent': 'hermes-web-ui-update-client',
      },
      timeout: timeoutMs,
    }, (res) => {
      const status = res.statusCode || 0
      const location = res.headers.location

      if (status >= 300 && status < 400 && typeof location === 'string' && location.trim()) {
        res.resume()
        const redirectedUrl = new URL(location, target).toString()
        requestWithNodeHttp(redirectedUrl, responseType, timeoutMs, redirectCount + 1)
          .then(resolve)
          .catch(reject)
        return
      }

      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      res.on('end', () => {
        resolve({
          ok: status >= 200 && status < 300,
          status,
          url,
          transport: 'node-http',
          buffer: Buffer.concat(chunks),
          attempts: 1,
        })
      })
    })

    req.on('timeout', () => {
      const err = new Error(`request timed out after ${timeoutMs}ms`) as Error & { code?: string }
      err.code = 'ETIMEDOUT'
      req.destroy(err)
    })
    req.on('error', reject)
    req.end()
  })
}

async function requestUpdateResource(
  url: string,
  responseType: UpdateNetworkResponseType,
  timeoutMs: number,
  attempts = 1,
): Promise<UpdateNetworkResponse> {
  try {
    const response = await requestWithFetch(url, responseType, timeoutMs)
    return { ...response, attempts }
  } catch (err: any) {
    const primaryError = toNetworkErrorDetail(err)
    try {
      const response = await requestWithNodeHttp(url, responseType, timeoutMs)
      return { ...response, attempts }
    } catch (fallbackErr: any) {
      throw new UpdateNetworkError(
        url,
        responseType,
        timeoutMs,
        attempts,
        primaryError,
        toNetworkErrorDetail(fallbackErr),
      )
    }
  }
}

function normalizeRequestOptions(
  optionsOrTimeout: UpdateNetworkRequestOptions | number | undefined,
  defaultTimeoutMs: number,
): Required<UpdateNetworkRequestOptions> {
  if (typeof optionsOrTimeout === 'number') {
    return {
      timeoutMs: optionsOrTimeout,
      retries: 0,
      retryDelayMs: 0,
    }
  }

  return {
    timeoutMs: Math.max(optionsOrTimeout?.timeoutMs ?? defaultTimeoutMs, 1),
    retries: Math.max(optionsOrTimeout?.retries ?? 0, 0),
    retryDelayMs: Math.max(optionsOrTimeout?.retryDelayMs ?? 0, 0),
  }
}

function shouldRetryResponse(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function delayForRetry(baseDelayMs: number, attempt: number): Promise<void> {
  const delayMs = Math.max(baseDelayMs, 0) * Math.max(attempt, 1)
  if (delayMs <= 0) {
    return Promise.resolve()
  }
  return new Promise(resolve => setTimeout(resolve, delayMs))
}

async function requestUpdateResourceWithRetry(
  url: string,
  responseType: UpdateNetworkResponseType,
  optionsOrTimeout: UpdateNetworkRequestOptions | number | undefined,
  defaultTimeoutMs: number,
): Promise<UpdateNetworkResponse> {
  const options = normalizeRequestOptions(optionsOrTimeout, defaultTimeoutMs)
  const maxAttempts = options.retries + 1
  let lastError: unknown = null
  let lastResponse: UpdateNetworkResponse | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await requestUpdateResource(url, responseType, options.timeoutMs, attempt)
      if (response.ok || !shouldRetryResponse(response.status) || attempt === maxAttempts) {
        return response
      }
      lastResponse = response
    } catch (error) {
      lastError = error
      if (attempt === maxAttempts) {
        throw error
      }
    }

    await delayForRetry(options.retryDelayMs, attempt)
  }

  if (lastResponse) {
    return lastResponse
  }
  throw lastError ?? new Error(`request failed for ${url}`)
}

export async function fetchUpdateJson(url: string, optionsOrTimeout?: UpdateNetworkRequestOptions | number): Promise<{
  ok: boolean
  status: number
  url: string
  transport: UpdateNetworkTransport
  data: unknown
  attempts: number
}> {
  const response = await requestUpdateResourceWithRetry(url, 'json', optionsOrTimeout, 10_000)
  const raw = response.buffer.toString('utf-8')
  const data = raw ? JSON.parse(raw) : {}
  return {
    ok: response.ok,
    status: response.status,
    url: response.url,
    transport: response.transport,
    data,
    attempts: response.attempts,
  }
}

export async function fetchUpdateBinary(
  url: string,
  optionsOrTimeout?: UpdateNetworkRequestOptions | number,
): Promise<UpdateNetworkResponse> {
  return requestUpdateResourceWithRetry(url, 'binary', optionsOrTimeout, 60_000)
}

async function downloadWithFetchToFile(
  url: string,
  targetFile: string,
  options: Required<UpdateNetworkRequestOptions> & Pick<UpdateBinaryDownloadOptions, 'expectedBytes' | 'expectedSha256'>,
): Promise<UpdateBinaryDownloadResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: buildAcceptHeader('binary'),
        'User-Agent': 'hermes-web-ui-update-client',
      },
      redirect: 'follow',
      signal: controller.signal,
    })
    const contentLength = parseContentLength(response.headers?.get?.('content-length'))
    if (!response.ok) {
      response.body?.cancel?.().catch(() => {})
      return {
        ok: false,
        status: response.status,
        url: response.url || url,
        transport: 'fetch',
        attempts: 1,
        bytesWritten: 0,
        sha256: '',
      }
    }
    validateContentLength(response.url || url, contentLength, options.expectedBytes)
    const bodyStream = response.body
      // Node's fromWeb expects the stream/web definition, while fetch() here is typed
      // against the global Web stream. Bridge the types without changing runtime behavior.
      ? Readable.fromWeb(response.body as unknown as NodeReadableStream)
      : Readable.from([Buffer.from(await response.arrayBuffer())])
    const result = await writeBinaryPayloadToFile(
      bodyStream,
      targetFile,
      response.url || url,
      options.expectedBytes,
      options.expectedSha256,
    )
    return {
      ok: true,
      status: response.status,
      url: response.url || url,
      transport: 'fetch',
      attempts: 1,
      ...result,
    }
  } finally {
    clearTimeout(timeout)
  }
}

function downloadWithNodeHttpToFile(
  url: string,
  targetFile: string,
  options: Required<UpdateNetworkRequestOptions> & Pick<UpdateBinaryDownloadOptions, 'expectedBytes' | 'expectedSha256'>,
  redirectCount = 0,
): Promise<UpdateBinaryDownloadResult> {
  if (redirectCount > 5) {
    return Promise.reject(new Error(`Too many redirects while downloading update resource: ${url}`))
  }

  const target = new URL(url)
  const client = target.protocol === 'https:' ? https : http

  return new Promise((resolve, reject) => {
    const req = client.request(target, {
      method: 'GET',
      headers: {
        Accept: buildAcceptHeader('binary'),
        'User-Agent': 'hermes-web-ui-update-client',
      },
      timeout: options.timeoutMs,
    }, (res) => {
      const status = res.statusCode || 0
      const location = res.headers.location

      if (status >= 300 && status < 400 && typeof location === 'string' && location.trim()) {
        res.resume()
        const redirectedUrl = new URL(location, target).toString()
        downloadWithNodeHttpToFile(redirectedUrl, targetFile, options, redirectCount + 1)
          .then(resolve)
          .catch(reject)
        return
      }

      if (status < 200 || status >= 300) {
        res.resume()
        resolve({
          ok: false,
          status,
          url,
          transport: 'node-http',
          attempts: 1,
          bytesWritten: 0,
          sha256: '',
        })
        return
      }

      try {
        validateContentLength(url, parseContentLength(typeof res.headers['content-length'] === 'string' ? res.headers['content-length'] : undefined), options.expectedBytes)
      } catch (error) {
        res.resume()
        reject(error)
        return
      }

      writeBinaryPayloadToFile(res, targetFile, url, options.expectedBytes, options.expectedSha256)
        .then(result => resolve({
          ok: true,
          status,
          url,
          transport: 'node-http',
          attempts: 1,
          ...result,
        }))
        .catch(reject)
    })

    req.on('timeout', () => {
      const err = new Error(`request timed out after ${options.timeoutMs}ms`) as Error & { code?: string }
      err.code = 'ETIMEDOUT'
      req.destroy(err)
    })
    req.on('error', reject)
    req.end()
  })
}

async function downloadUpdateBinaryToFileAttempt(
  url: string,
  targetFile: string,
  options: Required<UpdateNetworkRequestOptions> & Pick<UpdateBinaryDownloadOptions, 'expectedBytes' | 'expectedSha256'>,
  attempts = 1,
): Promise<UpdateBinaryDownloadResult> {
  try {
    const response = await downloadWithFetchToFile(url, targetFile, options)
    return { ...response, attempts }
  } catch (err: any) {
    if (err instanceof UpdateBinaryValidationError) {
      throw err
    }
    const primaryError = toNetworkErrorDetail(err)
    try {
      const response = await downloadWithNodeHttpToFile(url, targetFile, options)
      return { ...response, attempts }
    } catch (fallbackErr: any) {
      throw new UpdateNetworkError(
        url,
        'binary',
        options.timeoutMs,
        attempts,
        primaryError,
        toNetworkErrorDetail(fallbackErr),
      )
    }
  }
}

export async function downloadUpdateBinaryToFile(
  url: string,
  targetFile: string,
  optionsOrTimeout?: UpdateBinaryDownloadOptions | number,
): Promise<UpdateBinaryDownloadResult> {
  const options = normalizeRequestOptions(optionsOrTimeout, 60_000) as Required<UpdateNetworkRequestOptions>
    & Pick<UpdateBinaryDownloadOptions, 'expectedBytes' | 'expectedSha256'>
  if (typeof optionsOrTimeout !== 'number') {
    options.expectedBytes = typeof optionsOrTimeout?.expectedBytes === 'number' && optionsOrTimeout.expectedBytes > 0
      ? optionsOrTimeout.expectedBytes
      : undefined
    options.expectedSha256 = typeof optionsOrTimeout?.expectedSha256 === 'string' && optionsOrTimeout.expectedSha256.trim()
      ? optionsOrTimeout.expectedSha256.trim().toLowerCase()
      : undefined
  }

  const maxAttempts = options.retries + 1
  let lastError: unknown = null
  let lastResponse: UpdateBinaryDownloadResult | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await downloadUpdateBinaryToFileAttempt(url, targetFile, options, attempt)
      if (response.ok || !shouldRetryResponse(response.status) || attempt === maxAttempts) {
        return response
      }
      lastResponse = response
    } catch (error) {
      lastError = error
      if (attempt === maxAttempts) {
        throw error
      }
    }

    await delayForRetry(options.retryDelayMs, attempt)
  }

  if (lastResponse) {
    return lastResponse
  }
  throw lastError ?? new Error(`request failed for ${url}`)
}

export interface RangeResumeDownloadOptions extends UpdateNetworkRequestOptions {
  /** Mirror list; round-robined across attempts so one CDN is not punished. */
  urls: string[]
  expectedSize?: number
  expectedSha256: string
  /** Partial download path, per task: partial-<taskId>.part */
  partialFile: string
  /** Sidecar recording expected sha/size and the last durable byte. */
  metaFile: string
  /** Where the verified artifact lands on success (atomic rename). */
  finalFile?: string
}

export interface RangeResumeDownloadResult {
  ok: boolean
  url: string
  bytesWritten: number
  resumedFromByte: number
  attempts: number
  sha256: string
}

interface PartialMeta {
  expectedSha256: string
  expectedSize?: number
  lastByte: number
}

const RANGE_META_FLUSH_BYTES = 1024 * 1024

function readPartialMeta(metaFile: string, expectedSha256: string): PartialMeta | null {
  try {
    if (!existsSync(metaFile)) return null
    const parsed = JSON.parse(readFileSync(metaFile, 'utf8')) as PartialMeta
    if (parsed?.expectedSha256 !== expectedSha256) return null
    if (!Number.isInteger(parsed.lastByte) || parsed.lastByte < 0) return null
    return parsed
  } catch {
    return null
  }
}

function writePartialMeta(metaFile: string, meta: PartialMeta): void {
  const tmp = `${metaFile}.tmp`
  writeFileSync(tmp, JSON.stringify(meta))
  renameSync(tmp, metaFile)
}

/** Hash the durable prefix so resumed bytes continue the same digest. */
function hashFilePrefix(file: string, bytes: number): { hash: ReturnType<typeof createHash>; size: number } {
  const hash = createHash('sha256')
  const fd = openSync(file, 'r')
  try {
    const stat = fstatSync(fd)
    const size = Math.min(stat.size, bytes)
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let remaining = size
    while (remaining > 0) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, remaining), size - remaining)
      if (read <= 0) break
      hash.update(buffer.subarray(0, read))
      remaining -= read
    }
    return { hash, size }
  } finally {
    closeSync(fd)
  }
}

async function appendRangeToFile(
  source: NodeJS.ReadableStream,
  partialFile: string,
  metaFile: string,
  meta: PartialMeta,
  startHash: ReturnType<typeof createHash>,
  expectedBytes: number | undefined,
): Promise<{ bytesWritten: number; sha256: string }> {
  let bytesSinceFlush = 0
  let lastByte = meta.lastByte
  let flushedLastByte = meta.lastByte
  const hash = startHash
  const flushMeta = () => {
    writePartialMeta(metaFile, { ...meta, lastByte })
    flushedLastByte = lastByte
    bytesSinceFlush = 0
  }
  const tracker = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      lastByte += buffer.length
      hash.update(buffer)
      bytesSinceFlush += buffer.length
      if (bytesSinceFlush >= RANGE_META_FLUSH_BYTES) {
        flushMeta()
      }
      callback(null, buffer)
    },
    flush(callback) {
      flushMeta()
      callback(null)
    },
  })

  try {
    await pipeline(source, tracker, createWriteStream(partialFile, { flags: 'a' }))
    if (expectedBytes != null && lastByte !== expectedBytes) {
      throw new UpdateBinaryValidationError(
        partialFile,
        'size_mismatch',
        `Resumed download size mismatch for ${partialFile}: expected ${expectedBytes} bytes but received ${lastByte}.`,
        { expectedBytes, actualBytes: lastByte },
      )
    }
    const sha256 = hash.digest('hex')
    if (sha256 !== meta.expectedSha256) {
      throw new UpdateBinaryValidationError(
        partialFile,
        'sha256_mismatch',
        `Downloaded artifact checksum mismatch for ${partialFile}.`,
        { expectedSha256: meta.expectedSha256, actualSha256: sha256, actualBytes: lastByte },
      )
    }
    return { bytesWritten: lastByte, sha256 }
  } catch (error) {
    // Persist the durable offset so a later attempt can resume; the
    // partial file itself is kept (forensics + resume), unlike the
    // single-shot downloader which deletes its target on failure.
    try {
      writePartialMeta(metaFile, { ...meta, lastByte: Math.min(flushedLastByte, statSyncSafe(partialFile)) })
    } catch {
      /* meta persistence is best-effort on the failure path */
    }
    throw error
  }
}

function statSyncSafe(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

async function fetchRangeResponse(
  url: string,
  rangeStart: number,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; finalUrl: string; body: NodeJS.ReadableStream | null; serverSize?: number }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = {
      Accept: buildAcceptHeader('binary'),
      'User-Agent': 'hermes-web-ui-update-client',
    }
    if (rangeStart > 0) {
      headers.Range = `bytes=${rangeStart}-`
    }
    const response = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal,
    })
    const contentLength = parseContentLength(response.headers?.get?.('content-length'))
    if (!response.ok || !response.body) {
      response.body?.cancel?.().catch(() => {})
      return { ok: false, status: response.status, finalUrl: response.url || url, body: null }
    }
    return {
      ok: true,
      status: response.status,
      finalUrl: response.url || url,
      body: Readable.fromWeb(response.body as unknown as NodeReadableStream),
      serverSize: contentLength != null && contentLength > 0 ? contentLength + rangeStart : undefined,
    }
  } finally {
    clearTimeout(timeout)
  }
}

function exponentialDelayForRetry(baseDelayMs: number, attempt: number): Promise<void> {
  const delayMs = Math.min(Math.pow(2, Math.max(attempt, 1)), 60) * Math.max(baseDelayMs, 1) / 2
  return new Promise(resolve => setTimeout(resolve, delayMs))
}

/**
 * Streaming download with HTTP Range resume for the phase (a) update
 * system (master spec § Download & Resume).
 *
 * - Resumes from the durable offset recorded in the `.meta` sidecar;
 *   the partial file is truncated to that offset first so a crash
 *   between file append and meta flush can never poison the artifact.
 * - A server that ignores `Range:` (200 instead of 206) restarts the
 *   download from byte 0.
 * - Retries use exponential backoff (capped at 60s); after exhausting
 *   retries per URL the next mirror is tried, round-robined so the
 *   same CDN is not punished repeatedly.
 * - A completed download whose sha256 does not match is reported per
 *   mirror and moves to the next mirror; after all mirrors fail the
 *   mismatch is raised as UpdateBinaryValidationError.
 */
export async function downloadWithRangeResume(
  options: RangeResumeDownloadOptions,
): Promise<RangeResumeDownloadResult> {
  const urls = options.urls.map(u => (u || '').trim()).filter(Boolean)
  if (urls.length === 0) {
    throw new Error('downloadWithRangeResume requires at least one url')
  }
  const timeoutMs = Math.max(options.timeoutMs ?? 300_000, 1)
  const retries = Math.max(options.retries ?? 3, 0)
  const baseDelayMs = Math.max(options.retryDelayMs ?? 2_000, 0)

  mkdirSync(dirname(options.partialFile), { recursive: true })
  const expectedBytes = options.expectedSize != null && options.expectedSize > 0
    ? options.expectedSize
    : undefined

  const mismatchByMirror: Array<{ url: string; actualSha256?: string }> = []
  let lastNetworkError: unknown = null
  let totalAttempts = 0
  // Round-robin: rotate the starting mirror across callers/attempts so
  // a flaky primary CDN does not absorb every retry.
  const startOffset = Math.floor(Math.random() * urls.length)

  for (let mirrorIdx = 0; mirrorIdx < urls.length; mirrorIdx += 1) {
    const url = urls[(startOffset + mirrorIdx) % urls.length]

    // Establish (or validate) the resume offset for this mirror cycle.
    let meta = readPartialMeta(options.metaFile, options.expectedSha256)
    let resumedFromByte = 0
    let startHash = createHash('sha256')
    if (meta && existsSync(options.partialFile)) {
      // Truncate to the durable offset: bytes beyond it were written
      // after the last meta flush and may be torn.
      const currentSize = statSyncSafe(options.partialFile)
      if (currentSize > meta.lastByte) {
        truncateSync(options.partialFile, meta.lastByte)
      }
      if (meta.lastByte > 0) {
        const prefix = hashFilePrefix(options.partialFile, meta.lastByte)
        startHash = prefix.hash
        resumedFromByte = prefix.size
      }
    } else {
      meta = { expectedSha256: options.expectedSha256, expectedSize: expectedBytes, lastByte: 0 }
      rmSync(options.partialFile, { force: true })
      writePartialMeta(options.metaFile, meta)
    }
    if (expectedBytes != null && resumedFromByte >= expectedBytes && expectedBytes > 0) {
      // Already complete on disk from a previous run: verify and finish.
      const prefix = hashFilePrefix(options.partialFile, expectedBytes)
      const sha256 = prefix.hash.digest('hex')
      if (sha256 === options.expectedSha256 && prefix.size === expectedBytes) {
        finishDownload(options)
        return { ok: true, url, bytesWritten: expectedBytes, resumedFromByte, attempts: totalAttempts, sha256 }
      }
      meta = { expectedSha256: options.expectedSha256, expectedSize: expectedBytes, lastByte: 0 }
      rmSync(options.partialFile, { force: true })
      writePartialMeta(options.metaFile, meta)
      startHash = createHash('sha256')
      resumedFromByte = 0
    }

    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
      totalAttempts += 1
      let response: Awaited<ReturnType<typeof fetchRangeResponse>>
      try {
        response = await fetchRangeResponse(url, resumedFromByte, timeoutMs)
      } catch (err) {
        lastNetworkError = err
        if (attempt > retries) break
        await exponentialDelayForRetry(baseDelayMs, attempt)
        continue
      }

      if (!response.ok) {
        lastNetworkError = new Error(`HTTP ${response.status} for ${response.finalUrl}`)
        if (shouldRetryResponse(response.status) && attempt <= retries) {
          await exponentialDelayForRetry(baseDelayMs, attempt)
          continue
        }
        break
      }

      if (response.status === 200 && resumedFromByte > 0) {
        // Server ignored Range: restart from byte 0.
        rmSync(options.partialFile, { force: true })
        writePartialMeta(options.metaFile, { expectedSha256: options.expectedSha256, expectedSize: expectedBytes, lastByte: 0 })
        startHash = createHash('sha256')
        resumedFromByte = 0
      }

      try {
        const result = await appendRangeToFile(
          response.body as NodeJS.ReadableStream,
          options.partialFile,
          options.metaFile,
          { expectedSha256: options.expectedSha256, expectedSize: expectedBytes, lastByte: resumedFromByte },
          startHash,
          expectedBytes,
        )
        finishDownload(options)
        return { ok: true, url: response.finalUrl, bytesWritten: result.bytesWritten, resumedFromByte, attempts: totalAttempts, sha256: result.sha256 }
      } catch (err) {
        if (err instanceof UpdateBinaryValidationError && err.reason === 'sha256_mismatch') {
          mismatchByMirror.push({ url: response.finalUrl, actualSha256: err.actualSha256 })
          break
        }
        if (err instanceof UpdateBinaryValidationError && err.reason === 'size_mismatch') {
          throw err
        }
        lastNetworkError = err
        if (attempt > retries) break
        await exponentialDelayForRetry(baseDelayMs, attempt)
      }
    }
  }

  if (mismatchByMirror.length > 0) {
    const detail = mismatchByMirror.map(m => m.url).join(', ')
    throw new UpdateBinaryValidationError(
      urls[0],
      'sha256_mismatch',
      `Downloaded artifact checksum mismatch on every mirror (${detail}).`,
      { expectedSha256: options.expectedSha256, actualSha256: mismatchByMirror[0].actualSha256 },
    )
  }
  throw lastNetworkError ?? new Error(`download failed for ${urls[0]}`)
}

function finishDownload(options: RangeResumeDownloadOptions): void {
  if (options.finalFile) {
    mkdirSync(dirname(options.finalFile), { recursive: true })
    renameSync(options.partialFile, options.finalFile)
  }
  rmSync(options.metaFile, { force: true })
}

export function describeUpdateNetworkError(err: unknown): Record<string, unknown> | null {

  if (err instanceof UpdateNetworkError) {
    return {
      message: err.message,
      url: err.url,
      responseType: err.responseType,
      timeoutMs: err.timeoutMs,
      attempts: err.attempts,
      primary: err.primaryError,
      fallback: err.fallbackError,
    }
  }

  if (err instanceof UpdateBinaryValidationError) {
    return {
      message: err.message,
      url: err.url,
      reason: err.reason,
      expectedBytes: err.expectedBytes,
      actualBytes: err.actualBytes,
      expectedSha256: err.expectedSha256,
      actualSha256: err.actualSha256,
    }
  }

  if (!err) return null
  return { message: String((err as any)?.message || err) }
}
