import { randomUUID } from 'crypto'
import { SocialMessageError, upstreamMessage } from '../errors'
import { WEIXIN_ILINK_BASE_URL, weixinIlinkPost } from '../weixin-ilink'
import type {
  SocialMessageAdapter,
  SocialMessageCredentials,
  SocialMessageSendInput,
  SocialMessageSendResult,
} from '../types'

type Fetcher = typeof fetch

interface WeixinResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  msg?: string
}

function responseError(payload: WeixinResponse): string | null {
  const ret = payload.ret
  const errcode = payload.errcode
  if ((ret == null || ret === 0) && (errcode == null || errcode === 0)) return null
  const message = payload.errmsg || payload.msg || 'unknown error'
  return `${message} (ret=${ret ?? 0}, errcode=${errcode ?? 0})`
}

export class WeixinSocialMessageAdapter implements SocialMessageAdapter {
  readonly platform = 'weixin' as const
  readonly recipientTypes = ['user_id'] as const
  readonly defaultRecipientType = 'user_id' as const
  readonly maxContentLength = 2_000
  readonly supportsContextToken = true

  constructor(private readonly fetcher: Fetcher = fetch) {}

  isConfigured(credentials: SocialMessageCredentials): boolean {
    return Boolean(credentials.WEIXIN_TOKEN?.trim() && credentials.WEIXIN_ACCOUNT_ID?.trim())
  }

  async send(input: SocialMessageSendInput, credentials: SocialMessageCredentials): Promise<SocialMessageSendResult> {
    const token = credentials.WEIXIN_TOKEN?.trim() || ''
    const accountId = credentials.WEIXIN_ACCOUNT_ID?.trim() || ''
    const baseUrl = (credentials.WEIXIN_BASE_URL?.trim() || WEIXIN_ILINK_BASE_URL).replace(/\/+$/, '')
    if (!token || !accountId) {
      throw new SocialMessageError('platform_not_configured', 'Weixin account ID or token is not configured', 409)
    }

    const clientId = `studio-weixin-${randomUUID()}`
    const sendOnce = async (contextToken?: string) => {
      const message: Record<string, unknown> = {
        from_user_id: '',
        to_user_id: input.recipient,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text: input.content } }],
      }
      if (contextToken) message.context_token = contextToken
      return weixinIlinkPost({
        baseUrl,
        endpoint: 'ilink/bot/sendmessage',
        token,
        payload: { msg: message },
        timeoutMs: 15_000,
        fetcher: this.fetcher,
      })
    }

    try {
      let payload = await sendOnce(input.contextToken?.trim() || undefined)
      const sessionExpired = payload.ret === -14 || payload.errcode === -14 || (
        (payload.ret === -2 || payload.errcode === -2) && payload.errmsg?.toLowerCase() === 'unknown error'
      )
      if (sessionExpired && input.contextToken?.trim()) payload = await sendOnce()
      const detail = responseError(payload)
      if (detail) throw new Error(detail)
      return {
        platform: this.platform,
        recipient: input.recipient,
        messageId: clientId,
        sentAt: new Date().toISOString(),
      }
    } catch (error) {
      if (error instanceof SocialMessageError) throw error
      throw new SocialMessageError('platform_send_failed', `Weixin send failed: ${upstreamMessage(error)}`, 502)
    }
  }
}
