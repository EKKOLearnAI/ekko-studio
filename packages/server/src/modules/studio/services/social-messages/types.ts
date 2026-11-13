export const SOCIAL_MESSAGE_PLATFORMS = ['telegram', 'feishu', 'weixin'] as const

export type SocialMessagePlatform = typeof SOCIAL_MESSAGE_PLATFORMS[number]

export type SocialMessageRecipientType =
  | 'chat_id'
  | 'open_id'
  | 'user_id'
  | 'union_id'
  | 'email'

export interface SocialMessageSendInput {
  platform: SocialMessagePlatform
  recipient: string
  recipientType: SocialMessageRecipientType
  content: string
  contextToken?: string
}

export interface SocialMessageSendResult {
  platform: SocialMessagePlatform
  recipient: string
  messageId: string | null
  sentAt: string
}

export interface SocialMessagePlatformCapability {
  id: SocialMessagePlatform
  configured: boolean
  active: boolean
  notificationLocale?: string
  pushReady: boolean
  recipientTypes: SocialMessageRecipientType[]
  defaultRecipientType: SocialMessageRecipientType
  maxContentLength: number
  supportsContextToken: boolean
}

export type SocialMessageCredentials = Record<string, string>

export interface SocialMessageAdapter {
  readonly platform: SocialMessagePlatform
  readonly recipientTypes: readonly SocialMessageRecipientType[]
  readonly defaultRecipientType: SocialMessageRecipientType
  readonly maxContentLength: number
  readonly supportsContextToken: boolean
  isConfigured(credentials: SocialMessageCredentials): boolean
  send(input: SocialMessageSendInput, credentials: SocialMessageCredentials): Promise<SocialMessageSendResult>
}
