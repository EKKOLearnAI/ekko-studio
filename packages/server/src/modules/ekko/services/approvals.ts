import type {
  AgentToolApprovalChoice,
  AgentToolApprovalRequest,
} from '../../../../../ekko-agent/src'

interface PendingEkkoToolApproval {
  request: AgentToolApprovalRequest
  requestedAt: number
  runId?: string
  sessionId: string
  resolve: (choice: AgentToolApprovalChoice) => void
  timer: NodeJS.Timeout
  signal?: AbortSignal
  onAbort?: () => void
  onResolved?: (choice: AgentToolApprovalChoice) => void
}

export interface WaitForEkkoToolApprovalOptions {
  sessionId: string
  runId?: string
  signal?: AbortSignal
  onRequested: (request: AgentToolApprovalRequest) => void
  onResolved?: (choice: AgentToolApprovalChoice) => void
}

export interface EkkoToolApprovalResponse {
  handled: boolean
  resolved: boolean
  choice: AgentToolApprovalChoice
}

const pendingApprovals = new Map<string, PendingEkkoToolApproval>()

export function waitForEkkoToolApproval(
  request: AgentToolApprovalRequest,
  options: WaitForEkkoToolApprovalOptions,
): Promise<AgentToolApprovalChoice> {
  if (options.signal?.aborted) return Promise.resolve('deny')
  if (
    pendingApprovals.has(request.approvalId) ||
    [...pendingApprovals.values()].some(pending => pending.sessionId === options.sessionId)
  ) {
    return Promise.resolve('deny')
  }

  return new Promise((resolve) => {
    const finish = (choice: AgentToolApprovalChoice) => {
      const pending = pendingApprovals.get(request.approvalId)
      if (!pending) return
      pendingApprovals.delete(request.approvalId)
      clearTimeout(pending.timer)
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener('abort', pending.onAbort)
      }
      pending.onResolved?.(choice)
      pending.resolve(choice)
    }
    const timer = setTimeout(() => finish('deny'), request.timeoutMs)
    timer.unref?.()
    const onAbort = () => finish('deny')
    pendingApprovals.set(request.approvalId, {
      sessionId: options.sessionId,
      runId: options.runId,
      request: { ...request, choices: [...request.choices] },
      requestedAt: Date.now(),
      resolve,
      timer,
      signal: options.signal,
      onAbort,
      onResolved: options.onResolved,
    })
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      options.onRequested(request)
    } catch {
      finish('deny')
    }
  })
}

/** Read the live broker slots independently of the bounded chat event history. */
export function pendingEkkoToolApprovalEvents(sessionId: string) {
  return [...pendingApprovals.values()].filter(pending => pending.sessionId === sessionId).map(pending => ({
    event: 'approval.requested',
    data: {
      event: 'approval.requested', session_id: sessionId, run_id: pending.runId,
      approval_id: pending.request.approvalId, command: pending.request.command,
      description: pending.request.description, choices: [...pending.request.choices],
      allow_permanent: pending.request.allowPermanent, timeout_ms: pending.request.timeoutMs,
      requested_at: pending.requestedAt, tool: pending.request.toolName, permission_key: pending.request.key,
    },
  }))
}

export function respondToEkkoToolApproval(
  sessionId: string,
  approvalId: string,
  rawChoice: unknown,
): EkkoToolApprovalResponse {
  const choice = normalizeChoice(rawChoice)
  const pending = pendingApprovals.get(approvalId)
  if (!pending) return { handled: false, resolved: false, choice }
  if (pending.sessionId !== sessionId) return { handled: true, resolved: false, choice }

  pendingApprovals.delete(approvalId)
  clearTimeout(pending.timer)
  if (pending.signal && pending.onAbort) {
    pending.signal.removeEventListener('abort', pending.onAbort)
  }
  pending.onResolved?.(choice)
  pending.resolve(choice)
  return { handled: true, resolved: true, choice }
}

export function denyPendingEkkoToolApprovals(sessionId?: string): number {
  const targets = [...pendingApprovals.entries()]
    .filter(([, pending]) => !sessionId || pending.sessionId === sessionId)
  for (const [approvalId, pending] of targets) {
    pendingApprovals.delete(approvalId)
    clearTimeout(pending.timer)
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener('abort', pending.onAbort)
    }
    pending.onResolved?.('deny')
    pending.resolve('deny')
  }
  return targets.length
}

function normalizeChoice(value: unknown): AgentToolApprovalChoice {
  return value === 'once' || value === 'session' || value === 'always'
    ? value
    : 'deny'
}
