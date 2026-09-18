import { getSession, type HermesSessionRow } from '../../repositories/session-store'
import {
  getActiveSocialMessageAccount,
  normalizeSocialMessageBindingLocale,
  type SocialMessageBindingLocale,
} from '../../repositories/social-message-store'
import { logger } from '../../public/logging'
import {
  readActiveSocialMessagePlatform,
  readStoredFeishuCredentials,
  readStoredTelegramCredentials,
  readStoredWeixinCredentials,
} from './credentials'
import { listFeishuRecipients } from './feishu-runtime'
import { getSocialMessageService } from './service'
import {
  readActiveSocialMessageTarget,
  saveSocialMessageTarget,
  type SocialMessageTarget,
} from './targets'
import type { SocialMessagePlatform, SocialMessageRecipientType } from './types'
import { listTelegramRecipients } from './telegram-runtime'
import { listWeixinRecipients } from './weixin-runtime'

export type SessionPushEvent = 'run.completed' | 'approval.requested' | 'clarify.requested'
export type SessionPushAgent = 'bridge' | 'ekko' | 'claude-code' | 'codex' | 'pi' | 'grok' | 'opencode' | 'dsh'

interface SessionPushDependencies {
  readSession: (sessionId: string) => HermesSessionRow | null
  readTarget: (userId: number) => Promise<SocialMessageTarget | undefined>
  resolveTarget: (userId: number, existing: SocialMessageTarget | undefined) => Promise<SocialMessageTarget | undefined>
  readLocale: (userId: number) => SocialMessageBindingLocale
  send: (userId: number, input: Record<string, unknown>) => Promise<unknown>
  now: () => number
}

const SUPPORTED_EVENTS = new Set<SessionPushEvent>([
  'run.completed',
  'approval.requested',
  'clarify.requested',
])
const DEDUPE_TTL_MS = 10 * 60 * 1000
const MAX_PREVIEW_LENGTH = 1_200

const AGENT_DISPLAY_NAMES: Record<string, string> = {
  bridge: 'Hermes',
  hermes: 'Hermes',
  ekko: 'Ekko',
  'ekko-agent': 'Ekko',
  claude: 'Claude',
  'claude-code': 'Claude',
  codex: 'Codex',
  pi: 'Pi',
  grok: 'Grok',
  opencode: 'OpenCode',
}

const SESSION_PUSH_MESSAGES: Record<SocialMessageBindingLocale, Record<SessionPushEvent, string>> = {
  zh: {
    'run.completed': '{agent} 有一条已完成消息，请到 Ekko Studio 查看',
    'approval.requested': '{agent} 有一条待授权消息，请到 Ekko Studio 授权',
    'clarify.requested': '{agent} 有一条待回答消息，请到 Ekko Studio 回答',
  },
  'zh-TW': {
    'run.completed': '{agent} 有一則已完成訊息，請到 Ekko Studio 查看',
    'approval.requested': '{agent} 有一則待授權訊息，請到 Ekko Studio 授權',
    'clarify.requested': '{agent} 有一則待回答訊息，請到 Ekko Studio 回答',
  },
  en: {
    'run.completed': '{agent} has a completed message. Open Ekko Studio to view it.',
    'approval.requested': '{agent} has a message awaiting authorization. Open Ekko Studio to authorize it.',
    'clarify.requested': '{agent} has a message awaiting your response. Open Ekko Studio to answer it.',
  },
  ja: {
    'run.completed': '{agent} から完了済みのメッセージがあります。Ekko Studio で確認してください。',
    'approval.requested': '{agent} から承認待ちのメッセージがあります。Ekko Studio で承認してください。',
    'clarify.requested': '{agent} から回答待ちのメッセージがあります。Ekko Studio で回答してください。',
  },
  ko: {
    'run.completed': '{agent}에 완료된 메시지가 있습니다. Ekko Studio에서 확인해 주세요.',
    'approval.requested': '{agent}에 승인 대기 중인 메시지가 있습니다. Ekko Studio에서 승인해 주세요.',
    'clarify.requested': '{agent}에 답변 대기 중인 메시지가 있습니다. Ekko Studio에서 답변해 주세요.',
  },
  fr: {
    'run.completed': '{agent} a un message terminé. Consultez-le dans Ekko Studio.',
    'approval.requested': '{agent} a un message en attente d’autorisation. Ouvrez Ekko Studio pour l’autoriser.',
    'clarify.requested': '{agent} a un message en attente de réponse. Ouvrez Ekko Studio pour y répondre.',
  },
  es: {
    'run.completed': '{agent} tiene un mensaje completado. Ábrelo en Ekko Studio.',
    'approval.requested': '{agent} tiene un mensaje pendiente de autorización. Abre Ekko Studio para autorizarlo.',
    'clarify.requested': '{agent} tiene un mensaje pendiente de respuesta. Abre Ekko Studio para responderlo.',
  },
  de: {
    'run.completed': '{agent} hat eine abgeschlossene Nachricht. Öffne Ekko Studio, um sie anzusehen.',
    'approval.requested': '{agent} hat eine Nachricht, die auf Freigabe wartet. Öffne Ekko Studio, um sie freizugeben.',
    'clarify.requested': '{agent} hat eine Nachricht, die auf deine Antwort wartet. Öffne Ekko Studio, um zu antworten.',
  },
  pt: {
    'run.completed': '{agent} tem uma mensagem concluída. Abra o Ekko Studio para visualizá-la.',
    'approval.requested': '{agent} tem uma mensagem aguardando autorização. Abra o Ekko Studio para autorizá-la.',
    'clarify.requested': '{agent} tem uma mensagem aguardando resposta. Abra o Ekko Studio para respondê-la.',
  },
  ru: {
    'run.completed': 'У {agent} есть завершённое сообщение. Откройте Ekko Studio, чтобы посмотреть его.',
    'approval.requested': 'У {agent} есть сообщение, ожидающее разрешения. Откройте Ekko Studio, чтобы разрешить его.',
    'clarify.requested': 'У {agent} есть сообщение, ожидающее ответа. Откройте Ekko Studio, чтобы ответить.',
  },
  ar: {
    'run.completed': 'لدى {agent} رسالة مكتملة. افتح Ekko Studio لعرضها.',
    'approval.requested': 'لدى {agent} رسالة بانتظار التفويض. افتح Ekko Studio لتفويضها.',
    'clarify.requested': 'لدى {agent} رسالة بانتظار الإجابة. افتح Ekko Studio للإجابة عنها.',
  },
}

function isSessionPushEvent(event: string): event is SessionPushEvent {
  return SUPPORTED_EVENTS.has(event as SessionPushEvent)
}

function target(
  platform: SocialMessagePlatform,
  recipient: string,
  recipientType: SocialMessageRecipientType,
): SocialMessageTarget {
  return { platform, recipient, recipientType, updatedAt: new Date().toISOString() }
}

async function defaultTargetResolver(
  userId: number,
  existing: SocialMessageTarget | undefined,
): Promise<SocialMessageTarget | undefined> {
  if (existing) return existing
  const activePlatform = await readActiveSocialMessagePlatform(userId)
  let inferred: SocialMessageTarget | undefined
  if (activePlatform === 'telegram') {
    const telegramCredentials = await readStoredTelegramCredentials(userId)
    if (!telegramCredentials) return undefined
    const recipient = (await listTelegramRecipients(userId, telegramCredentials)).recipients[0]
    if (recipient) inferred = target('telegram', recipient.chatId, 'chat_id')
  } else if (activePlatform === 'feishu') {
    const feishuCredentials = await readStoredFeishuCredentials(userId)
    if (!feishuCredentials) return undefined
    const recipient = (await listFeishuRecipients(userId, feishuCredentials)).recipients[0]
    if (recipient) inferred = target('feishu', recipient.chatId, 'chat_id')
  } else if (activePlatform === 'weixin') {
    const weixinCredentials = await readStoredWeixinCredentials(userId)
    if (!weixinCredentials) return undefined
    const recipient = (await listWeixinRecipients(userId, weixinCredentials)).recipients[0]
    if (recipient) inferred = target('weixin', recipient.userId, 'user_id')
  }
  if (!inferred) return undefined
  await saveSocialMessageTarget(userId, inferred).catch(error => {
    logger.warn({ error, userId, platform: inferred.platform }, '[session-push] failed to remember inferred target')
  })
  return inferred
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function preview(value: unknown): string {
  const normalized = text(value).replace(/\n{3,}/g, '\n\n')
  if (normalized.length <= MAX_PREVIEW_LENGTH) return normalized
  return `${normalized.slice(0, MAX_PREVIEW_LENGTH - 1)}…`
}

export function formatSessionPushContent(
  agent: SessionPushAgent | string | undefined,
  event: SessionPushEvent,
  locale: unknown,
): string {
  const agentName = AGENT_DISPLAY_NAMES[text(agent)] || 'Hermes'
  const message = SESSION_PUSH_MESSAGES[normalizeSocialMessageBindingLocale(locale)][event]
  return message.replace('{agent}', agentName)
}

function eventIdentity(event: SessionPushEvent, payload: Record<string, unknown>): string {
  const id = text(payload.approval_id)
    || text(payload.clarify_id)
    || text(payload.run_id)
    || text(payload.response_id)
    || text(payload.message_id)
    || text(payload.queue_id)
  if (id) return id
  return preview(payload.question || payload.command || payload.description || payload.output || event)
}

export class SessionPushNotifier {
  private readonly recent = new Map<string, number>()
  private readonly dependencies: SessionPushDependencies

  constructor(dependencies: Partial<SessionPushDependencies> = {}) {
    this.dependencies = {
      readSession: getSession,
      readTarget: readActiveSocialMessageTarget,
      resolveTarget: defaultTargetResolver,
      readLocale: userId => getActiveSocialMessageAccount(userId)?.bindingLocale || 'en',
      send: (userId, input) => getSocialMessageService().send(userId, input),
      now: Date.now,
      ...dependencies,
    }
  }

  async notify(
    sessionId: string,
    event: string,
    rawPayload: unknown,
    agent?: SessionPushAgent,
  ): Promise<number> {
    if (!isSessionPushEvent(event)) return 0
    const payload = rawPayload && typeof rawPayload === 'object'
      ? rawPayload as Record<string, unknown>
      : {}
    if (event === 'run.completed' && payload.interrupted === true) return 0

    const session = this.dependencies.readSession(sessionId)
    const userId = Number(session?.user_id)
    if (!session || session.push_enabled !== 1 || !Number.isSafeInteger(userId) || userId <= 0) return 0

    const now = this.dependencies.now()
    for (const [key, seenAt] of this.recent) {
      if (now - seenAt > DEDUPE_TTL_MS) this.recent.delete(key)
    }
    const dedupeKey = `${sessionId}:${event}:${eventIdentity(event, payload)}`
    if (this.recent.has(dedupeKey)) return 0
    this.recent.set(dedupeKey, now)

    const storedTarget = await this.dependencies.readTarget(userId)
    const target = await this.dependencies.resolveTarget(userId, storedTarget)
    if (!target) {
      // This notifier is only for Telegram/Feishu/Weixin-style social
      // destinations. A missing social destination is normal and says
      // nothing about the independent mobile run-push/APNs target.
      logger.debug({ sessionId, userId, event }, '[social-messages] skipped notification: no configured social target')
      return 0
    }
    const content = formatSessionPushContent(agent || session.agent, event, this.dependencies.readLocale(userId))
    try {
      await this.dependencies.send(userId, {
        platform: target.platform,
        recipient: target.recipient,
        recipientType: target.recipientType,
        content,
      })
      return 1
    } catch (error) {
      logger.warn({
        error,
        sessionId,
        userId,
        platform: target.platform,
        event,
      }, '[session-push] failed to send notification')
      return 0
    }
  }
}

const singleton = new SessionPushNotifier()

export async function notifySessionPush(
  sessionId: string,
  event: string,
  payload: unknown,
  agent?: SessionPushAgent,
): Promise<number> {
  return singleton.notify(sessionId, event, payload, agent)
}
