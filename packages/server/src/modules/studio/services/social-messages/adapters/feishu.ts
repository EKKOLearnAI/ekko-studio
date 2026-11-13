import * as lark from '@larksuiteoapi/node-sdk'
import { createHash } from 'crypto'
import { SocialMessageError, upstreamMessage } from '../errors'
import type {
  SocialMessageAdapter,
  SocialMessageCredentials,
  SocialMessageRecipientType,
  SocialMessageSendInput,
  SocialMessageSendResult,
} from '../types'

type FeishuRecipientType = 'open_id' | 'user_id' | 'union_id' | 'email' | 'chat_id'

export class FeishuSocialMessageAdapter implements SocialMessageAdapter {
  readonly platform = 'feishu' as const
  readonly recipientTypes: readonly SocialMessageRecipientType[] = [
    'chat_id', 'open_id', 'user_id', 'union_id', 'email',
  ]
  readonly defaultRecipientType = 'chat_id' as const
  readonly maxContentLength = 20_000
  readonly supportsContextToken = false
  private readonly clients = new Map<string, lark.Client>()

  isConfigured(credentials: SocialMessageCredentials): boolean {
    return Boolean(credentials.FEISHU_APP_ID?.trim() && credentials.FEISHU_APP_SECRET?.trim())
  }

  private client(appId: string, appSecret: string): lark.Client {
    const key = createHash('sha256').update(`${appId}\0${appSecret}`).digest('hex')
    const existing = this.clients.get(key)
    if (existing) return existing
    const client = new lark.Client({
      appId,
      appSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
    })
    if (this.clients.size >= 16) this.clients.delete(this.clients.keys().next().value!)
    this.clients.set(key, client)
    return client
  }

  async send(input: SocialMessageSendInput, credentials: SocialMessageCredentials): Promise<SocialMessageSendResult> {
    const appId = credentials.FEISHU_APP_ID?.trim() || ''
    const appSecret = credentials.FEISHU_APP_SECRET?.trim() || ''
    if (!appId || !appSecret) {
      throw new SocialMessageError('platform_not_configured', 'Feishu App ID or App Secret is not configured', 409)
    }

    try {
      const client = this.client(appId, appSecret)
      const response = await client.im.v1.message.create({
        params: { receive_id_type: input.recipientType as FeishuRecipientType },
        data: {
          receive_id: input.recipient,
          msg_type: 'text',
          content: JSON.stringify({ text: input.content }),
        },
      })
      if (response.code != null && response.code !== 0) {
        throw new Error(response.msg ? `${response.msg} (${response.code})` : `Feishu error ${response.code}`)
      }
      return {
        platform: this.platform,
        recipient: input.recipient,
        messageId: response.data?.message_id || null,
        sentAt: new Date().toISOString(),
      }
    } catch (error) {
      if (error instanceof SocialMessageError) throw error
      throw new SocialMessageError('platform_send_failed', `Feishu send failed: ${upstreamMessage(error)}`, 502)
    }
  }
}
