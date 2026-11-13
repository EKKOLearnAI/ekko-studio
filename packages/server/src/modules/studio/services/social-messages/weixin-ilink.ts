import { randomBytes } from 'crypto'

export const WEIXIN_ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const WEIXIN_CHANNEL_VERSION = '2.2.0'
export const WEIXIN_APP_CLIENT_VERSION = String((2 << 16) | (2 << 8))

type Fetcher = typeof fetch

function randomWeixinUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf-8').toString('base64')
}

function createRequestSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController()
  const abort = () => controller.abort(parent?.reason)
  if (parent?.aborted) abort()
  else parent?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('iLink request timed out')), timeoutMs)
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', abort)
    },
  }
}

function appHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': WEIXIN_APP_CLIENT_VERSION,
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`
    headers.AuthorizationType = 'ilink_bot_token'
    headers['X-WECHAT-UIN'] = randomWeixinUin()
  }
  return headers
}

async function parseResponse(response: Response, endpoint: string): Promise<Record<string, any>> {
  const raw = await response.text()
  if (!response.ok) throw new Error(`iLink ${endpoint} HTTP ${response.status}: ${raw.slice(0, 200)}`)
  try {
    return raw ? JSON.parse(raw) as Record<string, any> : {}
  } catch {
    throw new Error(`iLink ${endpoint} returned invalid JSON`)
  }
}

export async function weixinIlinkGet(options: {
  baseUrl?: string
  endpoint: string
  query?: Record<string, string | number>
  timeoutMs?: number
  signal?: AbortSignal
  fetcher?: Fetcher
}): Promise<Record<string, any>> {
  const url = new URL(options.endpoint.replace(/^\/+/, ''), `${(options.baseUrl || WEIXIN_ILINK_BASE_URL).replace(/\/+$/, '')}/`)
  for (const [key, value] of Object.entries(options.query || {})) url.searchParams.set(key, String(value))
  const requestSignal = createRequestSignal(options.signal, options.timeoutMs || 35_000)
  try {
    const response = await (options.fetcher || fetch)(url.toString(), {
      method: 'GET',
      headers: appHeaders(),
      signal: requestSignal.signal,
    })
    return parseResponse(response, options.endpoint)
  } finally {
    requestSignal.cleanup()
  }
}

export async function weixinIlinkPost(options: {
  baseUrl?: string
  endpoint: string
  token: string
  payload: Record<string, unknown>
  timeoutMs?: number
  signal?: AbortSignal
  fetcher?: Fetcher
}): Promise<Record<string, any>> {
  const url = new URL(options.endpoint.replace(/^\/+/, ''), `${(options.baseUrl || WEIXIN_ILINK_BASE_URL).replace(/\/+$/, '')}/`)
  const body = JSON.stringify({
    ...options.payload,
    base_info: { channel_version: WEIXIN_CHANNEL_VERSION },
  })
  const requestSignal = createRequestSignal(options.signal, options.timeoutMs || 15_000)
  try {
    const response = await (options.fetcher || fetch)(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...appHeaders(options.token) },
      body,
      signal: requestSignal.signal,
    })
    return parseResponse(response, options.endpoint)
  } finally {
    requestSignal.cleanup()
  }
}
