import { countTextTokens } from '../../../../../../ekko-agent/src/model/tokens'
import { agentReasoningEstimatedTokens } from '../../../../../../ekko-agent/src/model/messages'
import type { AgentMessage, ModelRequest } from '../../../../../../ekko-agent/src/model/types'
import type { AgentRuntimeContextEstimate } from '../../../../../../ekko-agent/src/runtime/types'

// A conservative per-image reservation, not a provider billing calculation.
// Encoded byte length is unrelated to vision tokens. Keep the original image
// payload intact for the provider and count each image separately instead.
const IMAGE_TOKEN_RESERVE = 4096

export function personContextText(messages: AgentMessage[]) {
  // Runtime assistant messages also carry raw provider responses, usage and
  // continuation metadata. Those envelopes often repeat tools/instructions and
  // reasoning; they are neither conversation tokens nor checkpoint evidence.
  // Opaque reasoning must be replayed to its provider, never quoted to a summary.
  return messages.map(message => ({
    role: message.role, content: message.content, name: message.name,
    toolCalls: message.toolCalls, toolCallId: message.toolCallId,
    contentParts: message.contentParts?.map(part => part.type === 'image' ? { type: part.type, mimeType: part.mimeType } : part),
  }))
}

export function personMessageTokens(messages: AgentMessage[]) {
  return countTextTokens(JSON.stringify(personContextText(messages))) + imageTokens(messages) + reasoningTokens(messages)
}

function imageTokens(messages: AgentMessage[]) {
  return messages.reduce((sum, message) => sum + (message.contentParts?.filter(part => part.type === 'image').length || 0) * IMAGE_TOKEN_RESERVE, 0)
}

function reasoningTokens(messages: AgentMessage[]) {
  return messages.reduce((sum, message) => {
    const reasoning = message.reasoning
    const visible = countTextTokens(reasoning?.text || '')
    if (!reasoning?.native) return sum + visible
    // Ciphertext/signature byte length is not the model's reasoning token count.
    // Keep a conservative serialized fallback only when usage is unavailable.
    const native = agentReasoningEstimatedTokens(reasoning) ?? countTextTokens(JSON.stringify(reasoning.native.data) || '')
    return sum + Math.max(visible, native)
  }, 0)
}

export function estimatePersonContext(request: ModelRequest): AgentRuntimeContextEstimate {
  const systems = request.messages.filter(message => message.role === 'system')
  return {
    contextTokens: Math.ceil((countTextTokens(JSON.stringify({ messages: personContextText(request.messages), tools: request.tools })) + imageTokens(request.messages) + reasoningTokens(request.messages)) * 1.15),
    systemPromptTokens: personMessageTokens(systems),
    toolTokens: countTextTokens(JSON.stringify(request.tools || [])),
    messageTokens: personMessageTokens(request.messages.filter(message => message.role !== 'system')),
    modelContextTokens: 0, messageCount: request.messages.length, toolCount: request.tools?.length || 0,
    systemPromptChars: systems.reduce((sum, message) => sum + message.content.length, 0),
  }
}
