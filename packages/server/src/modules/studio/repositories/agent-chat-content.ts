import { agentChatArtifactPath } from '../../../../../shared/agent-chat-artifact'
import type { AgentRunInput } from '../contracts/plugins'

/** Existing transcript format, rendered from canonical input without byte copies. */
export function agentChatDisplayContent(sessionId: string, input: AgentRunInput): string {
  return input.content.every(block => block.type === 'text')
    ? input.content.map(block => block.type === 'text' ? block.text : '').join('\n')
    : JSON.stringify(input.content.map(block => block.type === 'image'
      ? { type: 'image', path: agentChatArtifactPath(sessionId, block.artifactId), name: `image.${block.mediaType.split('/')[1]}`, media_type: block.mediaType }
      : block))
}
