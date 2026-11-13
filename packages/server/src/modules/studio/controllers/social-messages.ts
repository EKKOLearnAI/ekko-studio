import type { Context } from 'koa'
import { randomUUID } from 'crypto'
import {
  clearSocialMessagePlatformCredentials,
  clearSocialMessageTarget,
  getSocialMessageService,
  isSocialMessageLocale,
  listFeishuRecipients,
  listTelegramRecipients,
  listWeixinRecipients,
  readStoredFeishuCredentials,
  readStoredTelegramCredentials,
  readStoredWeixinCredentials,
  resetFeishuRuntimeState,
  resetWeixinRuntimeState,
  saveSocialMessagePlatformCredentials,
  saveSocialMessageTarget,
  setActiveSocialMessagePlatform,
  SOCIAL_MESSAGE_PLATFORMS,
  SocialMessageError,
  stopFeishuRuntime,
  stopTelegramRuntime,
  stopWeixinRuntime,
  updateSocialMessagePlatformLocale,
  type SocialMessagePlatform,
} from '../services/social-messages'
import {
  beginFeishuQrRegistration,
  pollFeishuQrRegistration,
} from '../services/social-messages/feishu-onboarding'
import { WEIXIN_ILINK_BASE_URL, weixinIlinkGet } from '../services/social-messages/weixin-ilink'

const weixinQrSessions = new Map<string, { baseUrl: string; createdAt: number; userId: number }>()
const feishuQrSessions = new Map<string, {
  deviceCode: string
  userId: number
  expiresAt: number
  pollIntervalMs: number
  nextPollAt: number
  locale?: string
}>()
const QR_SESSION_TTL_MS = 10 * 60 * 1000

function authenticatedUserId(ctx: Context): number | null {
  const userId = Number(ctx.state?.user?.id)
  if (Number.isSafeInteger(userId) && userId > 0) return userId
  ctx.status = 401
  ctx.body = { error: 'Unauthorized' }
  return null
}

function isPlatform(value: unknown): value is SocialMessagePlatform {
  return typeof value === 'string' && (SOCIAL_MESSAGE_PLATFORMS as readonly string[]).includes(value)
}

function requiredBodyText(body: Record<string, unknown>, key: string): string {
  const value = typeof body[key] === 'string' ? body[key].trim() : ''
  if (!value) throw new SocialMessageError('invalid_request', `${key} is required`, 400)
  return value
}

function pruneWeixinQrSessions() {
  const cutoff = Date.now() - QR_SESSION_TTL_MS
  for (const [qrcode, session] of weixinQrSessions) {
    if (session.createdAt < cutoff) weixinQrSessions.delete(qrcode)
  }
}

function pruneFeishuQrSessions() {
  const now = Date.now()
  for (const [sessionId, session] of feishuQrSessions) {
    if (session.expiresAt <= now) feishuQrSessions.delete(sessionId)
  }
}

function redirectedWeixinBaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`)
    if (url.protocol !== 'https:') return undefined
    if (url.hostname !== 'weixin.qq.com' && !url.hostname.endsWith('.weixin.qq.com')) return undefined
    return url.origin
  } catch {
    return undefined
  }
}

export async function listPlatforms(ctx: Context) {
  const userId = authenticatedUserId(ctx)
  if (!userId) return
  ctx.body = { platforms: await getSocialMessageService().listPlatforms(userId) }
}

export async function setActivePlatform(ctx: Context) {
  const userId = authenticatedUserId(ctx)
  if (!userId) return
  const platform = ctx.params.platform
  if (!isPlatform(platform)) {
    ctx.status = 400
    ctx.body = { error: 'platform is unsupported', code: 'invalid_request' }
    return
  }
  if (!await setActiveSocialMessagePlatform(userId, platform)) {
    ctx.status = 409
    ctx.body = { error: `${platform} is not configured`, code: 'platform_not_configured' }
    return
  }
  ctx.body = { success: true, platform }
}

export async function updatePlatformLocale(ctx: Context) {
  const userId = authenticatedUserId(ctx)
  if (!userId) return
  const platform = ctx.params.platform
  if (!isPlatform(platform)) {
    ctx.status = 400
    ctx.body = { error: 'platform is unsupported', code: 'invalid_request' }
    return
  }
  const locale = (ctx.request.body as { locale?: unknown } | undefined)?.locale
  if (!isSocialMessageLocale(locale)) {
    ctx.status = 400
    ctx.body = { error: 'locale is unsupported', code: 'invalid_request' }
    return
  }
  if (!await updateSocialMessagePlatformLocale(userId, platform, locale)) {
    ctx.status = 409
    ctx.body = { error: `${platform} is not configured`, code: 'platform_not_configured' }
    return
  }
  ctx.body = { success: true, platform, locale }
}

export async function sendMessage(ctx: Context) {
  try {
    const userId = authenticatedUserId(ctx)
    if (!userId) return
    const body = ctx.request.body as {
      platform: string
      recipient: string
      recipientType?: string
      content: string
      contextToken?: string
    } | undefined
    const result = await getSocialMessageService().send(userId, {
      platform: body?.platform,
      recipient: body?.recipient,
      recipientType: body?.recipientType,
      content: body?.content,
      contextToken: body?.contextToken,
    })
    await saveSocialMessageTarget(userId, {
      platform: result.platform,
      recipient: result.recipient,
      recipientType: (body?.recipientType || (result.platform === 'weixin' ? 'user_id' : 'chat_id')) as any,
    })
    ctx.status = 201
    ctx.body = { result }
  } catch (error) {
    if (error instanceof SocialMessageError) {
      ctx.status = error.status
      ctx.body = { error: error.message, code: error.code }
      return
    }
    ctx.status = 500
    ctx.body = { error: error instanceof Error ? error.message : String(error) }
  }
}

export async function savePlatformCredentials(ctx: Context) {
  try {
    const userId = authenticatedUserId(ctx)
    if (!userId) return
    const platform = ctx.params.platform
    if (!isPlatform(platform)) throw new SocialMessageError('invalid_request', 'platform is unsupported', 400)
    const body = (ctx.request.body || {}) as Record<string, unknown>
    if (platform === 'telegram') {
      await stopTelegramRuntime(userId)
      await saveSocialMessagePlatformCredentials(userId, {
        platform,
        botToken: requiredBodyText(body, 'botToken'),
        locale: typeof body.locale === 'string' ? body.locale : undefined,
      })
    } else if (platform === 'feishu') {
      const previous = await readStoredFeishuCredentials(userId)
      const appId = requiredBodyText(body, 'appId')
      await saveSocialMessagePlatformCredentials(userId, {
        platform,
        appId,
        appSecret: requiredBodyText(body, 'appSecret'),
        locale: typeof body.locale === 'string' ? body.locale : undefined,
      })
      stopFeishuRuntime(userId)
      if (previous) await resetFeishuRuntimeState(userId, previous.appId)
      await resetFeishuRuntimeState(userId, appId)
    } else {
      const accountId = requiredBodyText(body, 'accountId')
      await stopWeixinRuntime(userId)
      await resetWeixinRuntimeState(userId, accountId)
      await saveSocialMessagePlatformCredentials(userId, {
        platform,
        accountId,
        token: requiredBodyText(body, 'token'),
        baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : undefined,
        locale: typeof body.locale === 'string' ? body.locale : undefined,
      })
    }
    ctx.body = { success: true, platform }
  } catch (error) {
    if (error instanceof SocialMessageError) {
      ctx.status = error.status
      ctx.body = { error: error.message, code: error.code }
      return
    }
    ctx.status = 500
    ctx.body = { error: error instanceof Error ? error.message : String(error) }
  }
}

export async function clearPlatformCredentials(ctx: Context) {
  const userId = authenticatedUserId(ctx)
  if (!userId) return
  const platform = ctx.params.platform
  if (!isPlatform(platform)) {
    ctx.status = 400
    ctx.body = { error: 'platform is unsupported', code: 'invalid_request' }
    return
  }
  if (platform === 'weixin') {
    const credentials = await readStoredWeixinCredentials(userId)
    await stopWeixinRuntime(userId)
    if (credentials) await resetWeixinRuntimeState(userId, credentials.accountId)
  } else if (platform === 'feishu') {
    const credentials = await readStoredFeishuCredentials(userId)
    stopFeishuRuntime(userId)
    if (credentials) await resetFeishuRuntimeState(userId, credentials.appId)
  } else if (platform === 'telegram') {
    await stopTelegramRuntime(userId)
  }
  await clearSocialMessagePlatformCredentials(userId, platform)
  await clearSocialMessageTarget(userId, platform)
  ctx.body = { success: true, platform }
}

export async function getWeixinQrcode(ctx: Context) {
  try {
    const userId = authenticatedUserId(ctx)
    if (!userId) return
    pruneWeixinQrSessions()
    const data = await weixinIlinkGet({
      baseUrl: WEIXIN_ILINK_BASE_URL,
      endpoint: 'ilink/bot/get_bot_qrcode',
      query: { bot_type: 3 },
      timeoutMs: 15_000,
    })
    if (!data?.qrcode || !data?.qrcode_img_content) {
      ctx.status = 502
      ctx.body = { error: 'Weixin did not return a QR code' }
      return
    }
    weixinQrSessions.set(String(data.qrcode), {
      baseUrl: WEIXIN_ILINK_BASE_URL,
      createdAt: Date.now(),
      userId,
    })
    ctx.body = { qrcode: data.qrcode, qrcode_url: data.qrcode_img_content }
  } catch (error) {
    ctx.status = 502
    ctx.body = { error: error instanceof Error ? error.message : 'Failed to connect to Weixin iLink' }
  }
}

export async function pollWeixinQrcodeStatus(ctx: Context) {
  const userId = authenticatedUserId(ctx)
  if (!userId) return
  const qrcode = typeof ctx.query.qrcode === 'string' ? ctx.query.qrcode.trim() : ''
  if (!qrcode) {
    ctx.status = 400
    ctx.body = { error: 'Missing qrcode parameter' }
    return
  }
  try {
    pruneWeixinQrSessions()
    const session = weixinQrSessions.get(qrcode)
    if (!session || session.userId !== userId) {
      ctx.body = { status: 'expired' }
      return
    }
    const data = await weixinIlinkGet({
      baseUrl: session.baseUrl,
      endpoint: 'ilink/bot/get_qrcode_status',
      query: { qrcode },
      timeoutMs: 35_000,
    })
    const status = data?.status || 'wait'
    if (status === 'scaned_but_redirect') {
      const redirected = redirectedWeixinBaseUrl(data.redirect_host)
      if (redirected) weixinQrSessions.set(qrcode, { ...session, baseUrl: redirected, createdAt: Date.now() })
    }
    if (status === 'confirmed' || status === 'expired') weixinQrSessions.delete(qrcode)
    ctx.body = status === 'confirmed'
      ? {
          status,
          account_id: data.ilink_bot_id,
          token: data.bot_token,
          base_url: data.baseurl || session.baseUrl,
          user_id: data.ilink_user_id,
        }
      : { status }
  } catch (error) {
    ctx.status = 502
    ctx.body = { error: error instanceof Error ? error.message : 'Failed to poll Weixin QR status' }
  }
}

export async function getFeishuQrcode(ctx: Context) {
  try {
    const userId = authenticatedUserId(ctx)
    if (!userId) return
    pruneFeishuQrSessions()
    const registration = await beginFeishuQrRegistration()
    const sessionId = randomUUID()
    const now = Date.now()
    feishuQrSessions.set(sessionId, {
      deviceCode: registration.deviceCode,
      userId,
      expiresAt: now + registration.expiresInMs,
      pollIntervalMs: registration.pollIntervalMs,
      nextPollAt: now + registration.pollIntervalMs,
      locale: typeof ctx.query.locale === 'string' ? ctx.query.locale : undefined,
    })
    ctx.body = {
      session_id: sessionId,
      qrcode_url: registration.qrUrl,
      poll_interval_ms: registration.pollIntervalMs,
      expires_in_ms: registration.expiresInMs,
    }
  } catch (error) {
    ctx.status = 502
    ctx.body = { error: error instanceof Error ? error.message : 'Failed to start Feishu QR registration' }
  }
}

export async function pollFeishuQrcodeStatus(ctx: Context) {
  const userId = authenticatedUserId(ctx)
  if (!userId) return
  const sessionId = typeof ctx.query.session === 'string' ? ctx.query.session.trim() : ''
  if (!sessionId) {
    ctx.status = 400
    ctx.body = { error: 'Missing session parameter' }
    return
  }

  pruneFeishuQrSessions()
  const session = feishuQrSessions.get(sessionId)
  if (!session || session.userId !== userId) {
    ctx.body = { status: 'expired' }
    return
  }
  if (typeof ctx.query.locale === 'string') session.locale = ctx.query.locale

  const now = Date.now()
  if (now < session.nextPollAt) {
    ctx.body = { status: 'pending', retry_after_ms: session.nextPollAt - now }
    return
  }
  session.nextPollAt = now + session.pollIntervalMs

  try {
    const status = await pollFeishuQrRegistration(session.deviceCode)
    if (status.status === 'pending') {
      ctx.body = { status: 'pending', retry_after_ms: session.pollIntervalMs }
      return
    }
    if (status.status === 'expired' || status.status === 'denied') {
      feishuQrSessions.delete(sessionId)
      ctx.body = { status: status.status }
      return
    }

    try {
      const previous = await readStoredFeishuCredentials(session.userId)
      await saveSocialMessagePlatformCredentials(session.userId, {
        platform: 'feishu',
        appId: status.appId,
        appSecret: status.appSecret,
        locale: session.locale,
      })
      stopFeishuRuntime(session.userId)
      if (previous) await resetFeishuRuntimeState(session.userId, previous.appId)
      await resetFeishuRuntimeState(session.userId, status.appId)
    } catch (error) {
      ctx.status = 500
      ctx.body = { error: error instanceof Error ? error.message : 'Failed to save Feishu credentials' }
      return
    }
    feishuQrSessions.delete(sessionId)
    ctx.body = {
      status: 'confirmed',
      ...(status.openId ? { open_id: status.openId } : {}),
    }
  } catch (error) {
    ctx.status = 502
    ctx.body = { error: error instanceof Error ? error.message : 'Failed to poll Feishu QR registration' }
  }
}

export async function saveWeixinCredentials(ctx: Context) {
  const ownerUserId = authenticatedUserId(ctx)
  if (!ownerUserId) return
  const body = ctx.request.body as {
    account_id?: unknown
    token?: unknown
    base_url?: unknown
    user_id?: unknown
    locale?: unknown
  } | undefined
  const accountId = typeof body?.account_id === 'string' ? body.account_id.trim() : ''
  const token = typeof body?.token === 'string' ? body.token.trim() : ''
  const baseUrl = typeof body?.base_url === 'string' ? body.base_url.trim() : ''
  const weixinUserId = typeof body?.user_id === 'string' ? body.user_id.trim() : ''
  if (!accountId || !token) {
    ctx.status = 400
    ctx.body = { error: 'Missing account_id or token' }
    return
  }
  try {
    await stopWeixinRuntime(ownerUserId)
    await resetWeixinRuntimeState(ownerUserId, accountId)
    await saveSocialMessagePlatformCredentials(ownerUserId, {
      platform: 'weixin',
      accountId,
      token,
      baseUrl,
      userId: weixinUserId,
      locale: typeof body?.locale === 'string' ? body.locale : undefined,
    })
    ctx.body = { success: true }
  } catch (error) {
    ctx.status = 500
    ctx.body = { error: error instanceof Error ? error.message : String(error) }
  }
}

export async function getWeixinRecipients(ctx: Context) {
  const userId = authenticatedUserId(ctx)
  if (!userId) return
  const credentials = await readStoredWeixinCredentials(userId)
  if (!credentials) {
    ctx.status = 409
    ctx.body = { error: 'weixin is not configured', code: 'platform_not_configured' }
    return
  }
  ctx.body = await listWeixinRecipients(userId, credentials)
}

export async function getTelegramRecipients(ctx: Context) {
  const userId = authenticatedUserId(ctx)
  if (!userId) return
  const credentials = await readStoredTelegramCredentials(userId)
  if (!credentials) {
    ctx.status = 409
    ctx.body = { error: 'telegram is not configured', code: 'platform_not_configured' }
    return
  }
  ctx.body = await listTelegramRecipients(userId, credentials)
}

export async function getFeishuRecipients(ctx: Context) {
  const userId = authenticatedUserId(ctx)
  if (!userId) return
  const credentials = await readStoredFeishuCredentials(userId)
  if (!credentials) {
    ctx.status = 409
    ctx.body = { error: 'feishu is not configured', code: 'platform_not_configured' }
    return
  }
  ctx.body = await listFeishuRecipients(userId, credentials)
}
