import type { RoomAgentHandoffChain } from '@/api/studio/group-chat'

export function handoffErrorTranslationKey(error: unknown): string | null {
    const normalized = String(error || '').trim()
    if (!normalized) return null
    if (normalized === 'Continuation target admission was rejected') {
        return 'groupChat.agentHandoffErrorAdmissionRejected'
    }
    if (
        normalized === 'Remote target invocation outcome is unknown after restart'
        || normalized === 'Remote handoff outcome is unknown; automatic retry is disabled'
        || normalized.startsWith('Remote target invocation outcome is unknown:')
    ) {
        return 'groupChat.agentHandoffOutcomeUnknownDescription'
    }
    return 'groupChat.agentHandoffErrorGeneric'
}

export function isPresentableHandoffChain(chain: RoomAgentHandoffChain): boolean {
    const currentDepth = Number(chain.currentDepth)
    const maxDepth = Number(chain.maxDepth)
    const isOutcomeUnknown = chain.status === 'outcome_unknown'
        && chain.stopReason === 'outcome_unknown'
        && Boolean(chain.continueUsed)
        && Boolean(chain.attemptId)
        && typeof chain.lastError === 'string'
        && chain.lastError.trim().length > 0
    const hasPresentableReason = chain.stopReason === 'max_depth'
        || (chain.stopReason === 'continue_failed'
            && Boolean(chain.attemptId)
            && typeof chain.lastError === 'string'
            && chain.lastError.trim().length > 0)
    return ((chain.status === 'stopped' && hasPresentableReason) || isOutcomeUnknown)
        && !Boolean(chain.unlimited)
        && Boolean(chain.sourceMessageId)
        && Boolean(chain.targetAgentId)
        && Number.isSafeInteger(currentDepth)
        && Number.isSafeInteger(maxDepth)
        && currentDepth < Number.MAX_SAFE_INTEGER
        && maxDepth >= 1
        && currentDepth >= maxDepth
}
