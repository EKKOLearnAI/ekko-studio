import { createHmac, timingSafeEqual } from 'crypto'

const MAX_CALLBACK_SKEW_SECONDS = 5 * 60

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
}

export interface DingTalkApprovalReply {
  action: 'approve' | 'request_changes'
  taskId: string
  reason: string
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

export function signDingTalkApprovalBody(body: string, timestamp: string, secret: string): string {
  return createHmac('sha256', secret).update(`${timestamp}\n${body}`).digest('hex')
}

function signaturesEqual(left: string, right: string): boolean {
  try {
    const a = Buffer.from(left, 'hex')
    const b = Buffer.from(right, 'hex')
    return a.length > 0 && a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export function verifyDingTalkApprovalSignature(
  body: string,
  timestamp: string,
  signature: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const parsedTimestamp = Number(timestamp)
  if (!secret || !Number.isSafeInteger(parsedTimestamp)) return false
  if (Math.abs(nowSeconds - parsedTimestamp) > MAX_CALLBACK_SKEW_SECONDS) return false
  return signaturesEqual(signature, signDingTalkApprovalBody(body, timestamp, secret))
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
  if (!webhookUrl) return { configured: false, api_accepted: false, attempts: 0, recipient_confirmed: false }

  const fetchImpl = options.fetchImpl || fetch
  const sleep = options.sleep || defaultSleep
  const maxRetries = Math.max(0, Math.min(5, options.maxRetries ?? 2))
  let attempts = 0
  let lastError: Error | null = null
  while (attempts <= maxRetries) {
    attempts += 1
    try {
      const response = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8_000),
      })
      if (response.ok) {
        return { configured: true, api_accepted: true, attempts, recipient_confirmed: false }
      }
      lastError = new Error(`DingTalk notification API returned ${response.status}`)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
    if (attempts <= maxRetries) await sleep(100 * 2 ** (attempts - 1))
  }
  throw lastError || new Error('DingTalk notification failed')
}
