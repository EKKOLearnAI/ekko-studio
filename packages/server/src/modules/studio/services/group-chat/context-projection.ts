import type { StoredMessage } from './types'

export type GroupHistoryMessage = { role: 'user' | 'assistant'; content: string }

export type ProjectableGroupChatMessage = Pick<
    StoredMessage,
    'senderId' | 'senderName' | 'content' | 'role' | 'tool_calls' | 'tool_name'
>

export type GroupChatProjectionAgent = {
    agentId?: string
    socketId?: string
    name: string
}

export function isWorkspaceDiffToolMessage(message: Pick<ProjectableGroupChatMessage, 'role' | 'tool_name'>): boolean {
    return String(message.role || '') === 'tool' && String(message.tool_name || '') === 'workspace_diff'
}

export function projectGroupChatMessage(
    message: ProjectableGroupChatMessage,
    ownAgent: GroupChatProjectionAgent,
): GroupHistoryMessage {
    const senderName = String(message.senderName || 'unknown')
    const senderId = typeof message.senderId === 'string' ? message.senderId.trim() : ''
    const ownAgentId = typeof ownAgent.agentId === 'string' ? ownAgent.agentId.trim() : ''
    const ownSocketId = typeof ownAgent.socketId === 'string' ? ownAgent.socketId.trim() : ''
    const role = String(message.role || 'user')
    const isOwnAgent = Boolean(
        (senderId && ownAgentId && senderId === ownAgentId)
        || (senderId && ownSocketId && senderId === ownSocketId)
        || (!senderId && senderName === ownAgent.name),
    )

    if (role === 'tool') {
        const label = message.tool_name ? `Tool result: ${message.tool_name}` : 'Tool result'
        return { role: 'user', content: `[${senderName}] [${label}]\n${String(message.content || '')}` }
    }

    if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        const toolsInfo = message.tool_calls.map((toolCall) => {
            const name = toolCall?.function?.name || 'unknown'
            let args = String(toolCall?.function?.arguments || '{}')
            if (args.length > 4000) args = `${args.slice(0, 4000)}...`
            return `[Calling tool: ${name} with arguments: ${args}]`
        }).join('\n')
        const content = String(message.content || '').trim()
        return {
            role: isOwnAgent ? 'assistant' : 'user',
            content: content
                ? `${formatAttributedContent(senderName, content)}\n${formatAttributionPrefix(senderName)}${toolsInfo}`
                : `${formatAttributionPrefix(senderName)}${toolsInfo}`,
        }
    }

    return {
        role: isOwnAgent ? 'assistant' : 'user',
        content: formatAttributedContent(senderName, String(message.content || '')),
    }
}

export function buildProjectedGroupChatHistory(
    summary: string,
    messages: ProjectableGroupChatMessage[],
    ownAgent: GroupChatProjectionAgent,
): GroupHistoryMessage[] {
    const history: GroupHistoryMessage[] = []

    if (summary) {
        history.push(
            { role: 'user', content: `[Previous conversation summary]\n${summary}` },
            { role: 'assistant', content: 'I have reviewed the conversation history and understand the context.' },
        )
    }

    history.push(...messages
        .filter((message) => !isWorkspaceDiffToolMessage(message) && message.tool_name !== 'task_plan')
        .map((message) => projectGroupChatMessage(message, ownAgent)))
    return history
}

export function stripMentionsForContextProjection(content: string): string {
    return String(content || '')
        .replace(/@([^\s@]+)/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/^\s+/, '')
}

function formatAttributedContent(senderName: string, content: string): string {
    return `${formatAttributionPrefix(senderName)}${stripMentionsForContextProjection(content)}`
}

function formatAttributionPrefix(senderName: string): string {
    return `[${senderName}]: `
}
