import { createHash, createHmac, timingSafeEqual } from 'crypto'

const MAX_CALLBACK_SKEW_MILLISECONDS = 5 * 60 * 1000
const KANBAN_TASK_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/
const DINGTALK_CARD_ACTIONS: Record<string, 'approve' | 'request_changes'> = {
  approve: 'approve',
  'request-changes': 'request_changes',
  reject: 'request_changes',
}

export interface DingTalkApprovalPayload {
  msgtype: 'markdown'
  markdown: {
    title: string
    text: string
  }
}

export interface DingTalkApprovalNotificationInput {
  task: { id: string; title: string; priority?: number }
  board: string
  eventId: string
  studioUrl: string
}

export interface DingTalkNotificationResult {
  configured: boolean
  api_accepted: boolean
  attempts: number
  recipient_confirmed: false
  retryable?: boolean
  error?: string
}

export class DingTalkNotificationError extends Error {
  readonly result: DingTalkNotificationResult

  constructor(message: string, attempts: number, retryable: boolean) {
    super(message)
    this.name = 'DingTalkNotificationError'
    this.result = {
      configured: true,
      api_accepted: false,
      attempts,
      recipient_confirmed: false,
      retryable,
      error: message,
    }
  }
}

export interface DingTalkApprovalReply {
  action: 'approve' | 'request_changes'
  taskId: string
  reason: string
}

export interface DingTalkCardCallbackDecision {
  taskId: string
  actor: string
  board: 'codex-tech'
  action: 'approve' | 'request_changes'
  reason: string
  eventId: string
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`)
  return value as Record<string, unknown>
}

function requiredCardString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`)
  const normalized = value.trim()
  if (normalized.length > maxLength) throw new Error(`${field} is too long`)
  return normalized
}

function callbackContent(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') throw new Error('content must be a JSON string')
  try {
    return objectValue(JSON.parse(value), 'content')
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('content must be valid JSON')
    throw error
  }
}

function cardAction(value: unknown): 'approve' | 'request_changes' | null {
  if (typeof value !== 'string') return null
  return DINGTALK_CARD_ACTIONS[value.trim().toLowerCase()] || null
}

export function buildDingTalkCardCallbackEventId(
  taskId: string,
  actor: string,
  actionId: string,
  action: 'approve' | 'request_changes',
  reason: string,
): string {
  const identity = JSON.stringify([taskId, actor, actionId, action, reason])
  return `dingtalk-card-${createHash('sha256').update(identity).digest('hex')}`
}

export function parseDingTalkCardCallback(payloadValue: unknown): DingTalkCardCallbackDecision {
  const payload = objectValue(payloadValue, 'request body')
  if (payload.type !== 'actionCallback') throw new Error('type must be actionCallback')

  const taskId = requiredCardString(payload.outTrackId, 'outTrackId', 128)
  if (!KANBAN_TASK_ID_RE.test(taskId)) throw new Error('outTrackId has an invalid task id format')
  const actor = requiredCardString(payload.userId, 'userId', 256)
  const content = callbackContent(payload.content)
  const privateData = objectValue(content.cardPrivateData, 'cardPrivateData')
  const actionIds = privateData.actionIds
  if (!Array.isArray(actionIds) || actionIds.length !== 1 || typeof actionIds[0] !== 'string' || !actionIds[0].trim()) {
    throw new Error('actionIds must contain exactly one action id')
  }
  const actionId = requiredCardString(actionIds[0], 'actionIds[0]', 128)
  const params = objectValue(privateData.params, 'cardPrivateData.params')
  if (params.action !== undefined && typeof params.action !== 'string') throw new Error('action must be a string')

  const paramsAction = cardAction(params.action)
  if (params.action !== undefined && !paramsAction) throw new Error('action is not supported')
  const actionIdAction = cardAction(actionId)
  if (paramsAction && actionIdAction && paramsAction !== actionIdAction) {
    throw new Error('action conflicts with actionIds')
  }
  const action = paramsAction || actionIdAction
  if (!action) throw new Error('action is not supported')

  if (params.board !== undefined && typeof params.board !== 'string') throw new Error('board must be a string')
  const board = typeof params.board === 'string' && params.board.trim() ? params.board.trim() : 'codex-tech'
  if (board !== 'codex-tech') throw new Error('DingTalk card approvals are only enabled for codex-tech')

  if (params.reason !== undefined && typeof params.reason !== 'string') throw new Error('reason must be a string')
  const suppliedReason = typeof params.reason === 'string' ? params.reason.trim() : ''
  if (suppliedReason.length > 2_000) throw new Error('reason is too long')
  if (action === 'request_changes' && !suppliedReason) throw new Error('reason is required for request-changes')
  const reason = suppliedReason || 'Approved via DingTalk card callback'

  return {
    taskId,
    actor,
    board: 'codex-tech',
    action,
    reason,
    eventId: buildDingTalkCardCallbackEventId(taskId, actor, actionId, action, reason),
  }
}

export function parseDingTalkApprovalReply(text: string): DingTalkApprovalReply | null {
  const match = text.trim().match(/^(批准|退回)\s+([A-Za-z0-9_.:-]{1,128})\s+(.{1,2000})$/s)
  if (!match) return null
  return {
    action: match[1] === '批准' ? 'approve' : 'request_changes',
    taskId: match[2],
    reason: match[3].trim(),
  }
}

export function buildDingTalkApprovalPayload(input: DingTalkApprovalNotificationInput): DingTalkApprovalPayload {
  const risk = (input.task.priority || 0) >= 3 ? '高风险' : (input.task.priority || 0) >= 2 ? '中风险' : '低风险'
  return {
    msgtype: 'markdown',
    markdown: {
      title: `待审批：${input.task.title}`,
      text: [
        `### 待 James 审批：${input.task.title}`,
        `- 看板：${input.board}`,
        `- 任务：${input.task.id}`,
        `- 风险：${risk}`,
        `- 事件 ID：${input.eventId}`,
        `- 建议操作：确认验证证据后批准；证据不足则退回。`,
        `- Studio：${input.studioUrl}`,
        '',
        `当前未验证 AI Card 回调权限，请用指令回复：`,
        `- \`批准 ${input.task.id} <原因>\``,
        `- \`退回 ${input.task.id} <原因>\``,
      ].join('\n'),
    },
  }
}

export function isDingTalkApprover(senderId: string, allowedUsers: string): boolean {
  const allowed = new Set(allowedUsers.split(',').map(value => value.trim().toLowerCase()).filter(Boolean))
  if (allowed.size === 0 || allowed.has('*')) return false
  return allowed.has(senderId.trim().toLowerCase())
}

export function signDingTalkCardCallbackTimestamp(timestamp: string, apiSecret: string): string {
  return createHmac('sha256', apiSecret).update(timestamp).digest('base64')
}

function signaturesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b)
}

export function verifyDingTalkCardCallbackSignature(
  timestamp: string,
  signature: string,
  apiSecret: string,
  nowMilliseconds = Date.now(),
): boolean {
  if (!/^\d{13}$/.test(timestamp)) return false
  const parsedTimestamp = Number(timestamp)
  if (!apiSecret || !signature || !Number.isSafeInteger(parsedTimestamp) || parsedTimestamp <= 0) return false
  if (Math.abs(nowMilliseconds - parsedTimestamp) > MAX_CALLBACK_SKEW_MILLISECONDS) return false
  return signaturesEqual(signature.trim(), signDingTalkCardCallbackTimestamp(timestamp, apiSecret))
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs))
}

export async function sendDingTalkApprovalNotification(
  payload: DingTalkApprovalPayload,
  options: {
    webhookUrl?: string
    fetchImpl?: typeof fetch
    maxRetries?: number
    sleep?: (delayMs: number) => Promise<void>
  } = {},
): Promise<DingTalkNotificationResult> {
  const webhookUrl = options.webhookUrl?.trim() || process.env.DINGTALK_APPROVAL_WEBHOOK_URL?.trim() || ''
  if (!webhookUrl) {
    return { configured: false, api_accepted: false, attempts: 0, recipient_confirmed: false }
  }

  const fetchImpl = options.fetchImpl || fetch
  const sleep = options.sleep || defaultSleep
  const maxRetries = Math.max(0, Math.min(5, options.maxRetries ?? 2))
  let attempts = 0
  let lastError: Error | null = null
  let lastRetryable = true
  while (attempts <= maxRetries) {
    attempts += 1
    let shouldRetry = true
    try {
      const response = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8_000),
      })
      if (response.ok) {
        let result: { errcode?: unknown; errmsg?: unknown }
        try {
          result = await response.json() as { errcode?: unknown; errmsg?: unknown }
        } catch {
          lastError = new Error('DingTalk notification API returned invalid JSON')
          shouldRetry = false
          lastRetryable = false
          break
        }
        if (result.errcode === 0) {
          return { configured: true, api_accepted: true, attempts, recipient_confirmed: false }
        }
        const message = typeof result.errmsg === 'string' ? ` ${result.errmsg}` : ''
        lastError = new Error(`DingTalk notification API rejected request: ${String(result.errcode)}${message}`)
        shouldRetry = false
        lastRetryable = false
        break
      }
      lastError = new Error(`DingTalk notification API returned ${response.status}`)
      shouldRetry = response.status === 408 || response.status === 429 || response.status >= 500
      lastRetryable = shouldRetry
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      lastRetryable = true
    }
    if (!shouldRetry) break
    if (attempts <= maxRetries) await sleep(100 * 2 ** (attempts - 1))
  }
  throw new DingTalkNotificationError(lastError?.message || 'DingTalk notification failed', attempts, lastRetryable)
}
