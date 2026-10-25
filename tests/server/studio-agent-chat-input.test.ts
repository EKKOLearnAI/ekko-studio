import { expect, it } from 'vitest'
import { agentChatArtifactPath, parseAgentChatArtifactPath } from '../../packages/shared/agent-chat-artifact'
import { managedAgentChatInput } from '../../packages/server/src/modules/studio/services/agents/chat-input'

const id = 'ab012345-6789-0123-4567-0123456789ab'
it('forwards opaque image references and text without accepting client filesystem or URL inputs', () => {
  const path = agentChatArtifactPath('chat 中文', id)
  expect(parseAgentChatArtifactPath(path)).toEqual({ sessionId: 'chat 中文', artifactId: id })
  expect(managedAgentChatInput('chat 中文', [{ type: 'text', text: 'Describe' }, { type: 'image', path, name: 'private-name.png', media_type: 'image/png' }])).toEqual({
    content: [{ type: 'text', text: 'Describe' }, { type: 'image', artifactId: id, mediaType: 'image/png' }],
  })
  for (const path of ['/tmp/file.png', 'https://example.invalid/image.png', 'data:image/png;base64,AA==', agentChatArtifactPath('other-chat', id), 'agent-artifact:%ZZ/' + id]) {
    expect(() => managedAgentChatInput('chat 中文', [{ type: 'image', path, name: 'image', media_type: 'image/png' }])).toThrow(/reference/)
  }
  expect(() => managedAgentChatInput('chat', [{ type: 'file', path: '/tmp/file', name: 'file' }])).toThrow(/supports text and image/)
})
