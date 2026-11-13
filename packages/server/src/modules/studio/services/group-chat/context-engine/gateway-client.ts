import type { StoredMessage, GatewayCaller } from '../types'
import {
    buildSummarizationSystemPrompt,
    buildFullSummaryPrompt,
    buildIncrementalUpdatePrompt,
} from '../agent-prompt'
import { logger } from '../../../public/logging'
import { createGroupPrimaryAgentBridge } from '../../../public/group-chat-agent-runtime'

/**
 * Calls the local bridge to produce LLM-generated summaries.
 * The context engine owns history assembly; gateway storage/chaining is not used.
 */
export class GatewaySummarizer implements GatewayCaller {
    private timeoutMs: number

    constructor(timeoutMs = 30_000) {
        this.timeoutMs = timeoutMs
    }

    async summarize(
        _upstream: string,
        _apiKey: string | null,
        systemPrompt: string,
        messages: StoredMessage[],
        roomId: string,
        profile: string,
        previousSummary?: string,
    ): Promise<{ summary: string; sessionId: string }> {
        const history: Array<{ role: string; content: string }> = messages.map(m => ({
            role: 'user',
            content: summarizeMessageForPrompt(m),
        }))

        if (previousSummary) {
            history.unshift(
                { role: 'user', content: `[Previous summary]\n${previousSummary}` },
                { role: 'assistant', content: 'Understood, I will update the summary.' },
            )
        }

        const userPrompt = previousSummary
            ? buildIncrementalUpdatePrompt()
            : buildFullSummaryPrompt()

        const bridge = createGroupPrimaryAgentBridge({ timeoutMs: this.timeoutMs + 15_000 })
        const sessionId = `gc_compress_${roomId}_${profile}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .slice(0, 160)

        try {
            const result = await bridge.request({
                action: 'chat',
                session_id: sessionId,
                message: userPrompt,
                instructions: systemPrompt || buildSummarizationSystemPrompt(),
                conversation_history: history,
                profile,
                source: 'api_server',
                wait: true,
                timeout: Math.ceil(this.timeoutMs / 1000),
            }, { timeoutMs: this.timeoutMs + 15_000 })

            if (result.status === 'error') {
                throw new Error(result.error || 'Summarization bridge run failed')
            }

            const payload = result.result as any
            const output = String(payload?.final_response || result.output || '').trim()
            if (!output) throw new Error('Empty summarization response')

            logger.debug(`[GatewaySummarizer] Bridge compression completed for room ${roomId} (profile=${profile})`)
            return { summary: output, sessionId }
        } finally {
            await bridge.destroy(sessionId, profile).catch(() => undefined)
        }
    }
}

function summarizeMessageForPrompt(message: StoredMessage): string {
    if (message.role === 'tool') {
        const label = message.tool_name ? `Tool result: ${message.tool_name}` : 'Tool result'
        return `[${label}]\n${message.content || ''}`
    }

    if (message.role === 'assistant' && message.tool_calls?.length) {
        const toolsInfo = message.tool_calls.map(tc => {
            const name = tc.function?.name || 'tool'
            const args = tc.function?.arguments || '{}'
            return `${name}(${args})`
        }).join(', ')
        const content = message.content?.trim()
        return `[${message.senderName}]: ${content ? `${content}\n` : ''}[Tool calls: ${toolsInfo}]`
    }

    return `[${message.senderName}]: ${message.content}`
}
