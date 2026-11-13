import type { ChatMessage, RoomAgent } from '@/api/studio/group-chat'
import type { ProfileAvatar } from '@/api/hermes/profiles'

import { chatSessionAgentAvatar } from './chat-agent-avatar'

export function parseStoredAvatar(raw: unknown): ProfileAvatar | null {
    if (!raw) return null
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (parsed?.type === 'generated' && typeof parsed.seed === 'string' && parsed.seed) {
            return { type: 'generated', seed: parsed.seed }
        }
        if (parsed?.type === 'image' && typeof parsed.dataUrl === 'string' && parsed.dataUrl) {
            return { type: 'image', dataUrl: parsed.dataUrl }
        }
    } catch {
        // Invalid persisted avatars fall back to the runtime's default icon.
    }
    return null
}

export function defaultGroupAgentAvatar(agent: RoomAgent['agent'] | undefined): ProfileAvatar {
    return { type: 'image', dataUrl: chatSessionAgentAvatar({ agent: agent || 'hermes' }).src }
}

export function groupAgentAvatar(agent: Pick<RoomAgent, 'agent' | 'avatar'> | null | undefined): ProfileAvatar {
    return parseStoredAvatar(agent?.avatar) || defaultGroupAgentAvatar(agent?.agent)
}

export function groupMessageAgent(message: ChatMessage, agents: RoomAgent[]): RoomAgent | undefined {
    const active = agents.find(agent =>
        agent.id === message.senderAgentRecordId
        || agent.agentId === message.senderId
        || (!message.senderAgentRecordId && agent.name === message.senderName)
    )
    if (active) return active
    if (message.senderType !== 'agent') return undefined

    const agentType = message.senderAgentType || 'hermes'
    return {
        id: message.senderAgentRecordId || `historical:${message.senderId}`,
        roomId: message.roomId,
        agentId: message.senderId,
        agent: agentType,
        agentMode: 'scoped',
        profile: message.senderAgentProfile || '',
        provider: message.senderAgentProvider || '',
        model: message.senderAgentModel || '',
        apiMode: '',
        reasoningEffort: '',
        name: message.senderName,
        description: message.senderAgentDescription || '',
        avatar: message.senderAvatar || '',
        invited: 0,
        executorType: 'server',
        connectionStatus: 'offline',
        ownerMemberId: message.senderOwnerMemberId || undefined,
        historical: true,
    }
}
