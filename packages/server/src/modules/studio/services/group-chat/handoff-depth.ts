export const DEFAULT_GROUP_CHAT_AGENT_HANDOFF_DEPTH = 4

export interface GroupChatAgentHandoffPolicy {
    enabled: boolean
    maxDepth: number | null
    unlimited: boolean
}

function finiteInteger(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null
    const number = Number(value)
    if (!Number.isFinite(number) || !Number.isInteger(number)) return null
    return number
}

export function recommendedGroupChatAgentHandoffDepth(activeAgentCount: number): number {
    const count = Math.max(0, finiteInteger(activeAgentCount) ?? 0)
    return Math.max(DEFAULT_GROUP_CHAT_AGENT_HANDOFF_DEPTH, count + 1)
}

export function resolveGroupChatAgentHandoffPolicy(
    room: { enabled?: unknown; maxDepth?: unknown; unlimited?: unknown },
    serverDefault?: unknown,
): GroupChatAgentHandoffPolicy {
    const enabled = room.enabled === undefined ? true : Boolean(room.enabled)
    if (!enabled) return { enabled: false, maxDepth: null, unlimited: false }
    if (room.unlimited === true) return { enabled: true, maxDepth: null, unlimited: true }
    const roomDepth = finiteInteger(room.maxDepth)
    const defaultDepth = finiteInteger(serverDefault)
    return {
        enabled: true,
        maxDepth: Math.max(1, roomDepth ?? defaultDepth ?? DEFAULT_GROUP_CHAT_AGENT_HANDOFF_DEPTH),
        unlimited: false,
    }
}

export function shouldRouteGroupChatAgentHandoff(
    depth: unknown,
    policy: GroupChatAgentHandoffPolicy,
): boolean {
    if (!policy.enabled) return false
    if (policy.unlimited) return true
    const normalizedDepth = Math.max(0, finiteInteger(depth) ?? 0)
    return normalizedDepth < (policy.maxDepth ?? DEFAULT_GROUP_CHAT_AGENT_HANDOFF_DEPTH)
}
