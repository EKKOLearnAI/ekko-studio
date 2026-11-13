const FEISHU_REGISTRATION_URL = 'https://accounts.feishu.cn/oauth/v1/app/registration'
const REQUEST_TIMEOUT_MS = 15_000

type Fetcher = typeof fetch

interface RegistrationResponse {
  supported_auth_methods?: unknown
  device_code?: unknown
  verification_uri_complete?: unknown
  user_code?: unknown
  interval?: unknown
  expire_in?: unknown
  client_id?: unknown
  client_secret?: unknown
  user_info?: { open_id?: unknown; tenant_brand?: unknown } | null
  error?: unknown
  error_description?: unknown
}

export interface FeishuQrRegistration {
  deviceCode: string
  qrUrl: string
  userCode: string
  pollIntervalMs: number
  expiresInMs: number
}

export type FeishuQrRegistrationStatus =
  | { status: 'pending' }
  | { status: 'denied' }
  | { status: 'expired' }
  | {
      status: 'confirmed'
      appId: string
      appSecret: string
      openId?: string
    }

function responseText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function secondsToMilliseconds(value: unknown, fallback: number, maximum: number): number {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback * 1000
  return Math.min(seconds, maximum) * 1000
}

function registrationError(data: RegistrationResponse, fallback: string): Error {
  const description = responseText(data.error_description)
  const code = responseText(data.error)
  return new Error(description || code || fallback)
}

async function postRegistration(
  values: Record<string, string>,
  fetcher: Fetcher,
): Promise<RegistrationResponse> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetcher(FEISHU_REGISTRATION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(values).toString(),
      signal: controller.signal,
    })
    const text = await response.text()
    let data: RegistrationResponse
    try {
      data = text ? JSON.parse(text) as RegistrationResponse : {}
    } catch {
      throw new Error(`Feishu registration returned invalid JSON (HTTP ${response.status})`)
    }
    if (!response.ok && !responseText(data.error)) {
      throw registrationError(data, `Feishu registration failed (HTTP ${response.status})`)
    }
    return data
  } finally {
    clearTimeout(timeout)
  }
}

export async function beginFeishuQrRegistration(
  fetcher: Fetcher = fetch,
): Promise<FeishuQrRegistration> {
  const initialized = await postRegistration({ action: 'init' }, fetcher)
  const authMethods = Array.isArray(initialized.supported_auth_methods)
    ? initialized.supported_auth_methods
    : []
  if (!authMethods.includes('client_secret')) {
    throw registrationError(initialized, 'Feishu does not support QR app registration')
  }

  const registration = await postRegistration({
    action: 'begin',
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id',
  }, fetcher)
  const deviceCode = responseText(registration.device_code)
  const verificationUrl = responseText(registration.verification_uri_complete)
  if (!deviceCode || !verificationUrl) {
    throw registrationError(registration, 'Feishu did not return a QR registration session')
  }

  let qrUrl: URL
  try {
    qrUrl = new URL(verificationUrl)
  } catch {
    throw new Error('Feishu returned an invalid QR registration URL')
  }
  if (qrUrl.protocol !== 'https:') {
    throw new Error('Feishu returned an insecure QR registration URL')
  }
  qrUrl.searchParams.set('from', 'hermes')
  qrUrl.searchParams.set('tp', 'hermes')

  return {
    deviceCode,
    qrUrl: qrUrl.toString(),
    userCode: responseText(registration.user_code),
    pollIntervalMs: secondsToMilliseconds(registration.interval, 5, 30),
    expiresInMs: secondsToMilliseconds(registration.expire_in, 600, 600),
  }
}

export async function pollFeishuQrRegistration(
  deviceCode: string,
  fetcher: Fetcher = fetch,
): Promise<FeishuQrRegistrationStatus> {
  const data = await postRegistration({
    action: 'poll',
    device_code: deviceCode,
    tp: 'ob_app',
  }, fetcher)
  const appId = responseText(data.client_id)
  const appSecret = responseText(data.client_secret)
  if (appId && appSecret) {
    if (responseText(data.user_info?.tenant_brand).toLowerCase() === 'lark') {
      throw new Error('This QR code created a Lark app, which is not supported by the Feishu connector')
    }
    const openId = responseText(data.user_info?.open_id)
    return {
      status: 'confirmed',
      appId,
      appSecret,
      ...(openId ? { openId } : {}),
    }
  }

  const error = responseText(data.error)
  if (error === 'authorization_pending') return { status: 'pending' }
  if (error === 'access_denied') return { status: 'denied' }
  if (error === 'expired_token') return { status: 'expired' }
  throw registrationError(data, 'Feishu returned an invalid QR registration response')
}
