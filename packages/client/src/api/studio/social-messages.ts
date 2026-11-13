import { request } from '@/api/client'

export type SocialMessagePlatform = 'telegram' | 'feishu' | 'weixin'
export type SocialMessageRecipientType = 'chat_id' | 'open_id' | 'user_id' | 'union_id' | 'email'

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

export interface SendSocialMessageInput {
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

export interface WeixinQrCode {
  qrcode: string
  qrcode_url: string
}

export interface WeixinQrStatus {
  status: 'wait' | 'scaned' | 'scaned_but_redirect' | 'expired' | 'confirmed'
  account_id?: string
  token?: string
  base_url?: string
  user_id?: string
}

export interface FeishuQrCode {
  session_id: string
  qrcode_url: string
  poll_interval_ms: number
  expires_in_ms: number
}

export interface FeishuQrStatus {
  status: 'pending' | 'confirmed' | 'expired' | 'denied'
  retry_after_ms?: number
  open_id?: string
}

export interface WeixinRecipient {
  userId: string
  lastSeenAt: string
  hasContextToken: boolean
}

export interface WeixinRecipientsResponse {
  recipients: WeixinRecipient[]
  runtimeStatus: 'running' | 'error'
  runtimeError?: string
}

export interface FeishuRecipient {
  chatId: string
  chatType: string
  lastSeenAt: string
}

export interface TelegramRecipient {
  chatId: string
  chatType: string
  title?: string
  username?: string
  displayName?: string
  lastSeenAt: string
}

export interface TelegramRecipientsResponse {
  recipients: TelegramRecipient[]
  runtimeStatus: 'running' | 'error'
  runtimeError?: string
}

export interface FeishuRecipientsResponse {
  recipients: FeishuRecipient[]
  runtimeStatus: 'running' | 'error'
  runtimeError?: string
}

export async function fetchSocialMessagePlatforms(): Promise<SocialMessagePlatformCapability[]> {
  const response = await request<{ platforms: SocialMessagePlatformCapability[] }>('/api/social-messages/platforms')
  return response.platforms
}

export async function sendSocialMessage(input: SendSocialMessageInput): Promise<SocialMessageSendResult> {
  const response = await request<{ result: SocialMessageSendResult }>('/api/social-messages/send', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return response.result
}

export async function setActiveSocialMessagePlatform(platform: SocialMessagePlatform): Promise<void> {
  await request(`/api/social-messages/active/${encodeURIComponent(platform)}`, {
    method: 'PUT',
  })
}

export async function updateSocialMessageNotificationLocale(
  platform: SocialMessagePlatform,
  locale: string,
): Promise<void> {
  await request(`/api/social-messages/locale/${encodeURIComponent(platform)}`, {
    method: 'PUT',
    body: JSON.stringify({ locale }),
  })
}

export async function fetchWeixinQrCode(): Promise<WeixinQrCode> {
  return request<WeixinQrCode>('/api/social-messages/weixin/qrcode')
}

export async function pollWeixinQrStatus(qrcode: string): Promise<WeixinQrStatus> {
  return request<WeixinQrStatus>(`/api/social-messages/weixin/qrcode/status?qrcode=${encodeURIComponent(qrcode)}`)
}

export async function fetchFeishuQrCode(locale: string): Promise<FeishuQrCode> {
  return request<FeishuQrCode>(
    `/api/social-messages/feishu/qrcode?locale=${encodeURIComponent(locale)}`,
  )
}

export async function pollFeishuQrStatus(sessionId: string, locale: string): Promise<FeishuQrStatus> {
  return request<FeishuQrStatus>(
    `/api/social-messages/feishu/qrcode/status?session=${encodeURIComponent(sessionId)}&locale=${encodeURIComponent(locale)}`,
  )
}

export async function saveWeixinCredentials(data: {
  account_id: string
  token: string
  base_url?: string
  user_id?: string
  locale?: string
}): Promise<void> {
  await request('/api/social-messages/weixin/credentials', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function saveSocialMessageCredentials(
  platform: SocialMessagePlatform,
  values: Record<string, string>,
): Promise<void> {
  await request(`/api/social-messages/credentials/${encodeURIComponent(platform)}`, {
    method: 'PUT',
    body: JSON.stringify(values),
  })
}

export async function clearSocialMessageCredentials(platform: SocialMessagePlatform): Promise<void> {
  await request(`/api/social-messages/credentials/${encodeURIComponent(platform)}`, {
    method: 'DELETE',
  })
}

export async function fetchWeixinRecipients(): Promise<WeixinRecipientsResponse> {
  return request<WeixinRecipientsResponse>('/api/social-messages/weixin/recipients')
}

export async function fetchTelegramRecipients(): Promise<TelegramRecipientsResponse> {
  return request<TelegramRecipientsResponse>('/api/social-messages/telegram/recipients')
}

export async function fetchFeishuRecipients(): Promise<FeishuRecipientsResponse> {
  return request<FeishuRecipientsResponse>('/api/social-messages/feishu/recipients')
}
