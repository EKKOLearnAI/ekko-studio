import {
  deleteSocialMessageAccount,
  getActiveSocialMessageAccount,
  getSocialMessageAccount,
  listSocialMessageAccounts,
  setActiveSocialMessageAccount,
  setSocialMessageAccountLocale,
  SOCIAL_MESSAGE_BINDING_LOCALES,
  upsertSocialMessageAccount,
  type SocialMessageBindingLocale,
} from '../../repositories/social-message-store'
import type { SocialMessageCredentials, SocialMessagePlatform } from './types'

export interface StoredTelegramCredentials {
  botToken: string
}

export interface StoredFeishuCredentials {
  appId: string
  appSecret: string
}

export interface StoredWeixinCredentials {
  accountId: string
  token: string
  baseUrl: string
  userId?: string
}

export type SocialMessagePlatformCredentialInput =
  | { platform: 'telegram'; botToken: string; locale?: string }
  | { platform: 'feishu'; appId: string; appSecret: string; locale?: string }
  | { platform: 'weixin'; accountId: string; token: string; baseUrl?: string; userId?: string; locale?: string }

const DEFAULT_WEIXIN_BASE_URL = 'https://ilinkai.weixin.qq.com'

function storedCredentials(userId: number, platform: SocialMessagePlatform): Record<string, string> | undefined {
  return getSocialMessageAccount(userId, platform)?.credentials
}

export async function readSocialMessageCredentials(userId: number): Promise<SocialMessageCredentials> {
  const credentials: SocialMessageCredentials = {}
  for (const account of listSocialMessageAccounts(userId)) {
    if (account.platform === 'telegram') credentials.TELEGRAM_BOT_TOKEN = account.credentials.botToken
    else if (account.platform === 'feishu') {
      credentials.FEISHU_APP_ID = account.credentials.appId
      credentials.FEISHU_APP_SECRET = account.credentials.appSecret
    } else {
      credentials.WEIXIN_ACCOUNT_ID = account.credentials.accountId
      credentials.WEIXIN_TOKEN = account.credentials.token
      credentials.WEIXIN_BASE_URL = account.credentials.baseUrl
      if (account.credentials.userId) credentials.WEIXIN_USER_ID = account.credentials.userId
    }
  }
  return credentials
}

export async function readStoredWeixinCredentials(userId: number): Promise<StoredWeixinCredentials | undefined> {
  const value = storedCredentials(userId, 'weixin')
  if (!value?.accountId || !value.token) return undefined
  return {
    accountId: value.accountId,
    token: value.token,
    baseUrl: (value.baseUrl || DEFAULT_WEIXIN_BASE_URL).replace(/\/+$/, ''),
    ...(value.userId ? { userId: value.userId } : {}),
  }
}

export async function readStoredTelegramCredentials(userId: number): Promise<StoredTelegramCredentials | undefined> {
  const value = storedCredentials(userId, 'telegram')
  return value?.botToken ? { botToken: value.botToken } : undefined
}

export async function readStoredFeishuCredentials(userId: number): Promise<StoredFeishuCredentials | undefined> {
  const value = storedCredentials(userId, 'feishu')
  return value?.appId && value.appSecret
    ? { appId: value.appId, appSecret: value.appSecret }
    : undefined
}

export async function readActiveSocialMessagePlatform(userId: number): Promise<SocialMessagePlatform | undefined> {
  return getActiveSocialMessageAccount(userId)?.platform
}

export async function readSocialMessagePlatformLocale(
  userId: number,
  platform: SocialMessagePlatform,
): Promise<SocialMessageBindingLocale | undefined> {
  return getSocialMessageAccount(userId, platform)?.bindingLocale
}

export async function readSocialMessagePlatformPushReady(
  userId: number,
  platform: SocialMessagePlatform,
): Promise<boolean> {
  const account = getSocialMessageAccount(userId, platform)
  return Boolean(account?.recipient && account.recipientType)
}

export function isSocialMessageLocale(value: unknown): value is SocialMessageBindingLocale {
  return typeof value === 'string'
    && (SOCIAL_MESSAGE_BINDING_LOCALES as readonly string[]).includes(value)
}

export async function updateSocialMessagePlatformLocale(
  userId: number,
  platform: SocialMessagePlatform,
  locale: SocialMessageBindingLocale,
): Promise<boolean> {
  return setSocialMessageAccountLocale(userId, platform, locale)
}

export async function setActiveSocialMessagePlatform(
  userId: number,
  platform: SocialMessagePlatform,
): Promise<boolean> {
  return setActiveSocialMessageAccount(userId, platform)
}

export async function saveSocialMessagePlatformCredentials(
  userId: number,
  input: SocialMessagePlatformCredentialInput,
): Promise<void> {
  const credentials: Record<string, string> = input.platform === 'telegram'
    ? { botToken: input.botToken.trim() }
    : input.platform === 'feishu'
      ? { appId: input.appId.trim(), appSecret: input.appSecret.trim() }
      : {
          accountId: input.accountId.trim(),
          token: input.token.trim(),
          baseUrl: (input.baseUrl?.trim() || DEFAULT_WEIXIN_BASE_URL).replace(/\/+$/, ''),
          ...(input.userId?.trim() ? { userId: input.userId.trim() } : {}),
        }
  upsertSocialMessageAccount({
    userId,
    platform: input.platform,
    credentials,
    active: true,
    bindingLocale: input.locale,
  })
}

export async function clearSocialMessagePlatformCredentials(
  userId: number,
  platform: SocialMessagePlatform,
): Promise<void> {
  deleteSocialMessageAccount(userId, platform)
}
