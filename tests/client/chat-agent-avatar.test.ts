import { describe, expect, it } from 'vitest'
import { chatSessionAgentAvatar } from '@/utils/chat-agent-avatar'

describe('single chat Agent avatars', () => {
  it('shows Ekko before the session loads while preserving legacy Hermes sessions', () => {
    for (const session of [null, undefined]) {
      expect(chatSessionAgentAvatar(session)).toEqual({
        label: 'Ekko',
        src: '/coding-agents/ekko-agent.png',
      })
    }
    expect(chatSessionAgentAvatar({ source: 'cli' })).toEqual({
      label: 'Hermes',
      src: '/coding-agents/hermes.png',
    })
  })

  it.each([
    ['Hermes', { agent: 'hermes' }, '/coding-agents/hermes.png'],
    ['Ekko', { agent: 'ekko-agent' }, '/coding-agents/ekko-agent.png'],
    ['Ekko', { agent: 'ekko_agent' }, '/coding-agents/ekko-agent.png'],
    ['Claude', { agent: 'claude' }, '/coding-agents/claude-code.svg'],
    ['Claude', { codingAgentId: 'claude-code' }, '/coding-agents/claude-code.svg'],
    ['Codex', { codingAgentId: 'codex' }, '/coding-agents/codex-openai.png'],
    ['DeepSeek Harness', { codingAgentId: 'dsh' }, '/coding-agents/deepseek.svg'],
    ['Pi', { codingAgentId: 'pi' }, '/coding-agents/pi.svg'],
    ['Grok', { codingAgentId: 'grok' }, '/coding-agents/grok.svg'],
    ['Cursor', { codingAgentId: 'cursor' }, '/coding-agents/cursor.svg'],
    ['OpenCode', { codingAgentId: 'opencode' }, '/coding-agents/opencode.png'],
  ])('maps session identity to the $label avatar', (label, session, src) => {
    expect(chatSessionAgentAvatar(session)).toEqual({ label, src })
  })

  it('keeps legacy Coding Agent sessions without identity on the Claude avatar', () => {
    expect(chatSessionAgentAvatar({ source: 'coding_agent' })).toEqual({
      label: 'Claude',
      src: '/coding-agents/claude-code.svg',
    })
  })
})
