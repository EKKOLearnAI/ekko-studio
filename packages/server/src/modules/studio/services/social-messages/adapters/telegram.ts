import { SocialMessageError, upstreamMessage } from '../errors'
import type {
  SocialMessageAdapter,
  SocialMessageCredentials,
  SocialMessageSendInput,
  SocialMessageSendResult,
} from '../types'

type Fetcher = typeof fetch

interface TelegramResponse {
  ok?: boolean
  description?: string
  error_code?: number
  result?: { message_id?: number | string }
}

export class TelegramSocialMessageAdapter implements SocialMessageAdapter {
  readonly platform = 'telegram' as const
  readonly recipientTypes = ['chat_id'] as const
  readonly defaultRecipientType = 'chat_id' as const
  readonly maxContentLength = 4_096
  readonly supportsContextToken = false

  constructor(private readonly fetcher: Fetcher = fetch) {}

  isConfigured(credentials: SocialMessageCredentials): boolean {
    return Boolean(credentials.TELEGRAM_BOT_TOKEN?.trim())
  }

  async send(input: SocialMessageSendInput, credentials: SocialMessageCredentials): Promise<SocialMessageSendResult> {
    const token = credentials.TELEGRAM_BOT_TOKEN?.trim() || ''
    if (!token) {
      throw new SocialMessageError('platform_not_configured', 'Telegram bot token is not configured', 409)
    }
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
      throw new SocialMessageError('platform_not_configured', 'Telegram bot token has an invalid format', 409)
    }

    try {
      const response = await this.fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: input.recipient, text: input.content }),
        signal: AbortSignal.timeout(15_000),
      })
      const payload = await response.json() as TelegramResponse
      if (!response.ok || payload.ok !== true) {
        const detail = payload.description || `HTTP ${response.status}`
        throw new Error(payload.error_code ? `${detail} (${payload.error_code})` : detail)
      }
      return {
        platform: this.platform,
        recipient: input.recipient,
        messageId: payload.result?.message_id == null ? null : String(payload.result.message_id),
        sentAt: new Date().toISOString(),
      }
    } catch (error) {
      if (error instanceof SocialMessageError) throw error
      throw new SocialMessageError('platform_send_failed', `Telegram send failed: ${upstreamMessage(error)}`, 502)
    }
  }
}
