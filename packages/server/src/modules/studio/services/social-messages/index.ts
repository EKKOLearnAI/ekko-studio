export { getSocialMessageService, SocialMessageService } from './service'
export { SocialMessageError } from './errors'
export {
  clearSocialMessagePlatformCredentials,
  isSocialMessageLocale,
  readActiveSocialMessagePlatform,
  readSocialMessageCredentials,
  readSocialMessagePlatformLocale,
  readSocialMessagePlatformPushReady,
  readStoredFeishuCredentials,
  readStoredTelegramCredentials,
  readStoredWeixinCredentials,
  saveSocialMessagePlatformCredentials,
  setActiveSocialMessagePlatform,
  updateSocialMessagePlatformLocale,
} from './credentials'
export type { StoredFeishuCredentials, StoredTelegramCredentials, StoredWeixinCredentials } from './credentials'
export {
  clearSocialMessageTarget,
  readActiveSocialMessageTarget,
  readSocialMessageTargets,
  saveSocialMessageTarget,
} from './targets'
export type { SocialMessageTarget } from './targets'
export {
  formatSessionPushContent,
  notifySessionPush,
  SessionPushNotifier,
} from './session-push'
export type { SessionPushAgent, SessionPushEvent } from './session-push'
export {
  ensureFeishuRuntime,
  listFeishuRecipients,
  resetFeishuRuntimeState,
  shutdownFeishuRuntimes,
  stopFeishuRuntime,
} from './feishu-runtime'
export type { FeishuRecipient } from './feishu-runtime'
export {
  ensureTelegramRuntime,
  listTelegramRecipients,
  resetTelegramRuntimeState,
  shutdownTelegramRuntimes,
  stopTelegramRuntime,
} from './telegram-runtime'
export type { TelegramRecipient } from './telegram-runtime'
export {
  ensureWeixinRuntime,
  listWeixinRecipients,
  resetWeixinRuntimeState,
  shutdownWeixinRuntimes,
  stopWeixinRuntime,
} from './weixin-runtime'
export * from './types'

import { shutdownFeishuRuntimes } from './feishu-runtime'
import { shutdownTelegramRuntimes } from './telegram-runtime'
import { shutdownWeixinRuntimes } from './weixin-runtime'

export async function shutdownSocialMessageRuntimes(): Promise<void> {
  shutdownFeishuRuntimes()
  await Promise.all([shutdownTelegramRuntimes(), shutdownWeixinRuntimes()])
}
