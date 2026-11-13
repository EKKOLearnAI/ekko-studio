import {
  getSocialMessageAccount,
  markSocialMessageBindingNotified,
  normalizeSocialMessageBindingLocale,
  setSocialMessageAccountTarget,
  type SocialMessageBindingLocale,
} from '../../repositories/social-message-store'
import { logger } from '../../public/logging'
import { getSocialMessageService } from './service'
import type { SocialMessagePlatform, SocialMessageRecipientType } from './types'

const BINDING_SUCCESS_MESSAGES: Record<SocialMessageBindingLocale, string> = {
  zh: '✅ 通知绑定成功',
  'zh-TW': '✅ 通知綁定成功',
  en: '✅ Notification binding successful',
  ja: '✅ 通知の連携に成功しました',
  ko: '✅ 알림 연결에 성공했습니다',
  fr: '✅ Liaison des notifications réussie',
  es: '✅ Vinculación de notificaciones completada',
  de: '✅ Benachrichtigungen erfolgreich verknüpft',
  pt: '✅ Vinculação de notificações concluída',
  ru: '✅ Уведомления успешно привязаны',
  ar: '✅ تم ربط الإشعارات بنجاح',
}

const WEIXIN_BINDING_SUCCESS_MESSAGES: Record<SocialMessageBindingLocale, string> = {
  zh: '✅ 微信推送已绑定成功。\n\n受微信会话机制限制，长时间未互动或连续推送多条消息后，推送可能暂时失效；如未收到后续通知，请主动给机器人发送任意消息以恢复推送。',
  'zh-TW': '✅ 微信推送已綁定成功。\n\n受微信會話機制限制，長時間未互動或連續推送多則訊息後，推送可能暫時失效；若未收到後續通知，請主動傳送任意訊息給機器人以恢復推送。',
  en: '✅ Weixin notifications are connected.\n\nDue to Weixin conversation limits, notifications may temporarily stop after a long period without interaction or several consecutive notifications. If that happens, send the bot any message to restore notifications.',
  ja: '✅ Weixin通知の連携が完了しました。\n\nWeixinの会話制限により、長時間やり取りがない場合や通知が連続した場合、通知が一時的に停止することがあります。その際は、Botに任意のメッセージを送信すると通知が再開します。',
  ko: '✅ Weixin 알림 연결이 완료되었습니다.\n\nWeixin 대화 제한으로 인해 오랫동안 상호작용이 없거나 알림이 여러 번 연속 전송되면 알림이 일시적으로 중단될 수 있습니다. 이 경우 봇에 아무 메시지나 보내면 알림이 다시 활성화됩니다.',
  fr: '✅ Les notifications Weixin sont connectées.\n\nEn raison des limites de conversation de Weixin, les notifications peuvent être temporairement interrompues après une longue période sans interaction ou plusieurs notifications consécutives. Dans ce cas, envoyez un message au bot pour les réactiver.',
  es: '✅ Las notificaciones de Weixin están conectadas.\n\nDebido a los límites de conversación de Weixin, las notificaciones pueden detenerse temporalmente tras un largo periodo sin interacción o varios avisos consecutivos. Si ocurre, envía cualquier mensaje al bot para reactivarlas.',
  de: '✅ Weixin-Benachrichtigungen sind verbunden.\n\nAufgrund der Gesprächsbeschränkungen von Weixin können Benachrichtigungen nach längerer Inaktivität oder mehreren aufeinanderfolgenden Mitteilungen vorübergehend aussetzen. Sende dem Bot dann eine beliebige Nachricht, um sie wieder zu aktivieren.',
  pt: '✅ As notificações do Weixin estão conectadas.\n\nDevido aos limites de conversa do Weixin, as notificações podem parar temporariamente após um longo período sem interação ou várias notificações consecutivas. Se isso acontecer, envie qualquer mensagem ao bot para reativá-las.',
  ru: '✅ Уведомления Weixin подключены.\n\nИз-за ограничений диалога Weixin уведомления могут временно прекратиться после долгого отсутствия активности или нескольких последовательных отправок. В таком случае отправьте боту любое сообщение, чтобы восстановить уведомления.',
  ar: '✅ تم ربط إشعارات Weixin.\n\nبسبب قيود المحادثات في Weixin، قد تتوقف الإشعارات مؤقتًا بعد فترة طويلة دون تفاعل أو بعد عدة إشعارات متتالية. إذا حدث ذلك، فأرسل أي رسالة إلى الروبوت لاستعادة الإشعارات.',
}

export interface FirstBindingNotificationInput {
  userId: number
  platform: SocialMessagePlatform
  recipient: string
  recipientType: SocialMessageRecipientType
  contextToken?: string
}

const notificationTasks = new Map<string, Promise<boolean>>()

export function formatBindingSuccessMessage(locale: unknown, platform?: SocialMessagePlatform): string {
  const normalizedLocale = normalizeSocialMessageBindingLocale(locale)
  return platform === 'weixin'
    ? WEIXIN_BINDING_SUCCESS_MESSAGES[normalizedLocale]
    : BINDING_SUCCESS_MESSAGES[normalizedLocale]
}

async function sendFirstBindingNotification(input: FirstBindingNotificationInput): Promise<boolean> {
  const account = getSocialMessageAccount(input.userId, input.platform)
  if (!account || account.bindingNotified) return false
  const recipient = input.recipient.trim()
  if (!recipient) return false

  const targetSaved = setSocialMessageAccountTarget({
    userId: input.userId,
    platform: input.platform,
    recipient,
    recipientType: input.recipientType,
    active: true,
  })
  if (!targetSaved) return false

  try {
    await getSocialMessageService().send(input.userId, {
      platform: input.platform,
      recipient,
      recipientType: input.recipientType,
      content: formatBindingSuccessMessage(account.bindingLocale, input.platform),
      ...(input.contextToken ? { contextToken: input.contextToken } : {}),
    })
    return markSocialMessageBindingNotified(input.userId, input.platform)
  } catch (error) {
    logger.warn({
      error,
      userId: input.userId,
      platform: input.platform,
      recipient,
    }, '[social-messages] failed to send first binding notification')
    return false
  }
}

export async function notifyFirstSocialMessageBinding(
  input: FirstBindingNotificationInput,
): Promise<boolean> {
  const key = `${input.userId}:${input.platform}`
  const existing = notificationTasks.get(key)
  if (existing) return existing
  const task = sendFirstBindingNotification(input).finally(() => {
    if (notificationTasks.get(key) === task) notificationTasks.delete(key)
  })
  notificationTasks.set(key, task)
  return task
}
