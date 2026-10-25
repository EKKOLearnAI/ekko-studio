import { parseAgentChatArtifactPath } from '../../../../../../shared/agent-chat-artifact'
import type { ContentBlock } from '../../contracts/runs/session'
import { StudioError, type AgentRunInput } from '../../contracts/plugins'

/** Convert transport blocks into owned references; never read client paths. */
export function managedAgentChatInput(sessionId: string, input: string | ContentBlock[]): AgentRunInput {
  if (typeof input === 'string') return { content: [{ type: 'text', text: input }] }
  if (!Array.isArray(input) || input.length > 100) throw new StudioError('INVALID_ARGUMENT', 'Invalid Agent chat input')
  return { content: input.map(block => {
    if (block?.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text }
    if (block?.type !== 'image') throw new StudioError('CAPABILITY_UNSUPPORTED', 'Agent chat currently supports text and image artifacts')
    const ref = typeof block.path === 'string' ? parseAgentChatArtifactPath(block.path) : null
    if (!ref || ref.sessionId !== sessionId) throw new StudioError('INVALID_ARGUMENT', 'Image must reference this Agent chat')
    return { type: 'image', artifactId: ref.artifactId, mediaType: block.media_type }
  }) }
}
