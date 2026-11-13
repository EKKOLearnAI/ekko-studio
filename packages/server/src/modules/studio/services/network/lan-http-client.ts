import http from 'http'
import https from 'https'

export type LanJsonTransport = 'fetch' | 'node-http'

export type LanNetworkErrorDetail = {
  name: string
  message: string
  code?: string
  syscall?: string
  address?: string
  port?: number
}

export type LanJsonPostResponse = {
  ok: boolean
  status: number
  data: Record<string, unknown>
  transport: LanJsonTransport
  primaryError?: LanNetworkErrorDetail
}

export class LanJsonPostError extends Error {
  primaryError: LanNetworkErrorDetail
  fallbackError: LanNetworkErrorDetail

  constructor(primaryError: LanNetworkErrorDetail, fallbackError: LanNetworkErrorDetail) {
    super(`fetch failed: ${primaryError.message}; node-http fallback failed: ${fallbackError.message}`)
    this.name = 'LanJsonPostError'
    this.primaryError = primaryError
    this.fallbackError = fallbackError
  }
}

function networkErrorDetail(err: any): LanNetworkErrorDetail {
  return {
    name: String(err?.name || 'Error'),
    message: String(err?.message || err || 'request failed'),
    code: typeof err?.code === 'string' ? err.code : undefined,
    syscall: typeof err?.syscall === 'string' ? err.syscall : undefined,
    address: typeof err?.address === 'string' ? err.address : undefined,
    port: typeof err?.port === 'number' ? err.port : undefined,
  }
}

async function jsonWithFetch(url: string, method: 'GET' | 'POST', body: unknown, timeoutMs: number): Promise<LanJsonPostResponse> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method,
      headers: method === 'POST'
        ? { 'Content-Type': 'application/json' }
        : { Accept: 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    })
    const data = await response.json().catch(() => ({})) as Record<string, unknown>
    return {
      ok: response.ok,
      status: response.status,
      data,
      transport: 'fetch',
    }
  } finally {
    clearTimeout(timeout)
  }
}

function parseJsonObject(raw: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function jsonWithNodeHttp(url: string, method: 'GET' | 'POST', body: unknown, timeoutMs: number, primaryError: LanNetworkErrorDetail): Promise<LanJsonPostResponse> {
  const target = new URL(url)
  const payload = method === 'POST' ? JSON.stringify(body) : ''
  const client = target.protocol === 'https:' ? https : http

  return new Promise((resolve, reject) => {
    const req = client.request(target, {
      method,
      headers: {
        'Accept': 'application/json',
        ...(method === 'POST'
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            }
          : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      res.on('end', () => {
        const status = res.statusCode || 0
        resolve({
          ok: status >= 200 && status < 300,
          status,
          data: parseJsonObject(Buffer.concat(chunks).toString('utf-8')),
          transport: 'node-http',
          primaryError,
        })
      })
    })

    req.on('timeout', () => {
      const err = new Error(`request timed out after ${timeoutMs}ms`) as Error & { code?: string }
      err.code = 'ETIMEDOUT'
      req.destroy(err)
    })
    req.on('error', reject)
    req.end(payload || undefined)
  })
}

async function lanJson(url: string, method: 'GET' | 'POST', body: unknown, timeoutMs: number): Promise<LanJsonPostResponse> {
  try {
    return await jsonWithFetch(url, method, body, timeoutMs)
  } catch (err: any) {
    const primaryError = networkErrorDetail(err)
    try {
      return await jsonWithNodeHttp(url, method, body, timeoutMs, primaryError)
    } catch (fallbackErr: any) {
      throw new LanJsonPostError(primaryError, networkErrorDetail(fallbackErr))
    }
  }
}

export async function getLanJson(url: string, timeoutMs = 5000): Promise<LanJsonPostResponse> {
  return lanJson(url, 'GET', undefined, timeoutMs)
}

export async function postLanJson(url: string, body: unknown, timeoutMs = 5000): Promise<LanJsonPostResponse> {
  return lanJson(url, 'POST', body, timeoutMs)
}

export function describeLanJsonPostError(err: any): Record<string, unknown> | null {
  if (err instanceof LanJsonPostError) {
    return {
      message: err.message,
      primary: err.primaryError,
      fallback: err.fallbackError,
    }
  }
  if (!err) return null
  return { message: String(err?.message || err) }
}
