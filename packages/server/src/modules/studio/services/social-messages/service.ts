import { FeishuSocialMessageAdapter } from './adapters/feishu'
import { TelegramSocialMessageAdapter } from './adapters/telegram'
import { WeixinSocialMessageAdapter } from './adapters/weixin'
import {
  readActiveSocialMessagePlatform,
  readSocialMessageCredentials,
  readSocialMessagePlatformLocale,
  readSocialMessagePlatformPushReady,
  readStoredWeixinCredentials,
} from './credentials'
import { SocialMessageError } from './errors'
import { resolveWeixinContextToken } from './weixin-runtime'
import {
  SOCIAL_MESSAGE_PLATFORMS,
  type SocialMessageAdapter,
  type SocialMessagePlatform,
  type SocialMessagePlatformCapability,
  type SocialMessageRecipientType,
  type SocialMessageSendInput,
  type SocialMessageSendResult,
} from './types'

const defaultAdapters: SocialMessageAdapter[] = [
  new TelegramSocialMessageAdapter(),
  new FeishuSocialMessageAdapter(),
  new WeixinSocialMessageAdapter(),
]

async function defaultContextTokenResolver(
  userId: number,
  platform: SocialMessagePlatform,
  recipient: string,
  credentials: Record<string, string>,
): Promise<string | undefined> {
  if (platform !== 'weixin') return undefined
  const stored = await readStoredWeixinCredentials(userId)
  if (!stored || stored.accountId !== credentials.WEIXIN_ACCOUNT_ID || stored.token !== credentials.WEIXIN_TOKEN) {
    return undefined
  }
  return resolveWeixinContextToken(userId, stored, recipient)
}

function isPlatform(value: unknown): value is SocialMessagePlatform {
  return typeof value === 'string' && (SOCIAL_MESSAGE_PLATFORMS as readonly string[]).includes(value)
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SocialMessageError('invalid_request', `${field} is required`, 400)
  }
  const result = value.trim()
  if (result.length > maxLength) {
    throw new SocialMessageError('invalid_request', `${field} exceeds the ${maxLength} character limit`, 400)
  }
  return result
}

export class SocialMessageService {
  private readonly byPlatform: Map<SocialMessagePlatform, SocialMessageAdapter>

  constructor(
    private readonly adapterList: SocialMessageAdapter[] = defaultAdapters,
    private readonly credentialReader = readSocialMessageCredentials,
    private readonly contextTokenResolver = defaultContextTokenResolver,
    private readonly activePlatformReader = readActiveSocialMessagePlatform,
    private readonly platformLocaleReader = readSocialMessagePlatformLocale,
    private readonly platformPushReadyReader = readSocialMessagePlatformPushReady,
  ) {
    this.byPlatform = new Map(adapterList.map(adapter => [adapter.platform, adapter]))
  }

  async listPlatforms(userId: number): Promise<SocialMessagePlatformCapability[]> {
    const credentials = await this.credentialReader(userId)
    const activePlatform = await this.activePlatformReader(userId)
    return Promise.all(this.adapterList.map(async adapter => ({
      id: adapter.platform,
      configured: adapter.isConfigured(credentials),
      active: adapter.platform === activePlatform,
      notificationLocale: await this.platformLocaleReader(userId, adapter.platform),
      pushReady: await this.platformPushReadyReader(userId, adapter.platform),
      recipientTypes: [...adapter.recipientTypes],
      defaultRecipientType: adapter.defaultRecipientType,
      maxContentLength: adapter.maxContentLength,
      supportsContextToken: adapter.supportsContextToken,
    })))
  }

  async send(userId: number, value: Record<string, unknown>): Promise<SocialMessageSendResult> {
    if (!isPlatform(value.platform)) {
      throw new SocialMessageError('invalid_request', 'platform is unsupported', 400)
    }
    const adapter = this.byPlatform.get(value.platform)
    if (!adapter) {
      throw new SocialMessageError('invalid_request', 'platform is unsupported', 400)
    }
    const recipient = requiredText(value.recipient, 'recipient', 512)
    const content = requiredText(value.content, 'content', adapter.maxContentLength)
    const recipientType = typeof value.recipientType === 'string' && value.recipientType.trim()
      ? value.recipientType.trim() as SocialMessageRecipientType
      : adapter.defaultRecipientType
    if (!adapter.recipientTypes.includes(recipientType)) {
      throw new SocialMessageError('invalid_request', `recipientType is unsupported for ${adapter.platform}`, 400)
    }
    if (value.contextToken !== undefined && typeof value.contextToken !== 'string') {
      throw new SocialMessageError('invalid_request', 'contextToken must be a string', 400)
    }
    const credentials = await this.credentialReader(userId)
    if (!adapter.isConfigured(credentials)) {
      throw new SocialMessageError('platform_not_configured', `${adapter.platform} is not configured`, 409)
    }
    const suppliedContextToken = adapter.supportsContextToken
      ? String(value.contextToken || '').trim() || undefined
      : undefined
    const input: SocialMessageSendInput = {
      platform: adapter.platform,
      recipient,
      recipientType,
      content,
      contextToken: suppliedContextToken || await this.contextTokenResolver(
        userId,
        adapter.platform,
        recipient,
        credentials,
      ),
    }
    return adapter.send(input, credentials)
  }
}

let singleton: SocialMessageService | undefined

export function getSocialMessageService(): SocialMessageService {
  singleton ||= new SocialMessageService()
  return singleton
}
