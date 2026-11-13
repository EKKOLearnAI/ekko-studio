import { parseAnthropicContentArray } from './llm-json'
import { logger } from '../../public/logging'
import type { SessionMessage } from './types'

function cleanToolCalls(toolCalls: any): any[] {
  return Array.isArray(toolCalls)
    ? toolCalls
        .filter((tc: any) => tc?.id && String(tc.id).length > 0)
        .map((tc: any) => ({
          id: tc.id,
          type: tc.type,
          function: tc.function,
        }))
    : []
}

function hasSendableContent(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0
  if (Array.isArray(content)) {
    return content.some((block: any) => {
      if (!block || typeof block !== 'object') return false
      if (block.type === 'text') return typeof block.text === 'string' && block.text.trim().length > 0
      return Boolean(block.type && block.type !== 'thinking')
    })
  }
  return false
}

export function isAssistantMessageSendable(message: { content?: unknown; tool_calls?: any }): boolean {
  if (hasSendableContent(message.content)) return true
  return cleanToolCalls(message.tool_calls).length > 0
}

/**
 * Process raw DB messages into client-ready format.
 * Parses Anthropic content blocks, reconstructs tool_call_ids, etc.
 */
export function handleMessage(messages: SessionMessage[], sid: string): any[] {
  let _messages = []
  try {
    _messages = messages
      .filter(m => (m.role === 'user' || m.role === 'assistant' || m.role === 'tool' || m.role === 'command' || m.role === 'moa') && m.content !== undefined)
      .map((m, idx, arr) => {
        const msg: any = {
          id: m.id,
          session_id: sid,
          role: m.role,
          content: m.content || '',
          reasoning: m.reasoning || '',
          timestamp: m.timestamp,
        }
        if (m.display_role) msg.display_role = m.display_role
        if (m.display_content != null) msg.display_content = m.display_content
        if (Object.prototype.hasOwnProperty.call(m, 'finish_reason')) {
          msg.finish_reason = m.finish_reason ?? null
        }
        const runMarker = m.runMarker || m.run_marker
        if (runMarker) msg.runMarker = runMarker
        // Convert Anthropic format content to OpenAI format
        if (m.role === 'assistant' && typeof m.content === 'string') {
          let contentToParse = m.content
          const trimmed = m.content.trim()
          if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
            contentToParse = trimmed.slice(1, -1)
            logger.info('[chat-run-socket] resume message %s: double-serialized, removed outer quotes', m.id)
          }

          if (contentToParse.startsWith('[') && contentToParse.endsWith(']')) {
            try {
              const parsedContent = parseAnthropicContentArray(contentToParse)
              const textBlocks: string[] = []
              const toolCalls: any[] = []
              let reasoningContent: string | null = null

              for (const block of parsedContent) {
                if (block.type === 'thinking') {
                  reasoningContent = block.thinking || null
                } else if (block.type === 'text') {
                  textBlocks.push(block.text || '')
                } else if (block.type === 'tool_use') {
                  toolCalls.push({
                    id: block.id,
                    type: 'function',
                    function: {
                      name: block.name,
                      arguments: typeof block.input === 'object' ? JSON.stringify(block.input) : (block.input ?? '{}'),
                    },
                  })
                }
              }

              msg.content = textBlocks.join('') || ''
              if (toolCalls.length > 0) msg.tool_calls = toolCalls
              if (reasoningContent) msg.reasoning = reasoningContent
            } catch (e) {
              logger.warn(e, '[chat-run-socket] failed to parse array content for message %s, keeping original', m.id)
              msg.content = m.content
            }
          }
        } else if (Array.isArray(m.content)) {
          const textBlocks: string[] = []
          const toolCalls: any[] = []
          let reasoningContent: string | null = null

          for (const block of m.content) {
            if (block.type === 'thinking') {
              reasoningContent = block.thinking
            } else if (block.type === 'text') {
              textBlocks.push(block.text)
            } else if (block.type === 'tool_use') {
              toolCalls.push({
                id: block.id,
                type: 'function',
                function: {
                  name: block.name,
                  arguments: JSON.stringify(block.input ?? {}),
                },
              })
            }
          }

          msg.content = textBlocks.join('') || ''
          if (toolCalls.length > 0) msg.tool_calls = toolCalls
          if (reasoningContent) msg.reasoning = reasoningContent
        }

        if (m.tool_calls?.length) {
          const cleanedToolCalls = cleanToolCalls(m.tool_calls)
          if (cleanedToolCalls.length > 0) msg.tool_calls = cleanedToolCalls
        }

        if (m.role === 'assistant' && !isAssistantMessageSendable(msg)) {
          logger.warn('[chat-run-socket] skipped empty assistant message %s while loading session %s', m.id, sid)
          return null
        }

        // For tool messages, ensure tool_call_id exists
        if (m.role === 'tool') {
          let callId = m.tool_call_id
          if (!callId || callId.length === 0) {
            const prevMsg = arr[idx - 1]
            if (prevMsg?.role === 'assistant' && prevMsg.tool_calls?.length) {
              const tc = prevMsg.tool_calls.find((t: any) => t.function?.name === m.tool_name)
              if (tc?.id) callId = tc.id
            }
          }
          if (!callId || callId.length === 0) return null
          msg.tool_call_id = callId
        }
        if (m.role === 'moa' && m.tool_call_id) msg.tool_call_id = m.tool_call_id

        if (m.tool_name) msg.tool_name = m.tool_name
        if (m.reasoning) msg.reasoning = m.reasoning
        return msg
      })
      .filter(m => m !== null)
  } catch (error) {
  }
  return _messages
}
