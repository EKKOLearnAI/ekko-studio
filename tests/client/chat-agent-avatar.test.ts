import { beforeEach, describe, expect, it } from 'vitest'
import { chatSessionAgentAvatar, personAvatarAnimation } from '@/utils/chat-agent-avatar'
import { PERSON_BOTS } from '../../packages/shared/person-bots'
import { uiLocale } from '@/i18n/locale-state'

describe('single chat Agent avatars', () => {
  beforeEach(() => { uiLocale.value = 'en' })
  it.each(PERSON_BOTS)('keeps $name appearance and thinking animation after selecting its bot type', bot => {
    for (const locale of ['en', 'zh', 'zh-TW', 'zh-Hans', 'ja', 'ar']) {
      uiLocale.value = locale
      const avatar = chatSessionAgentAvatar({ id: 'person-main-new', agent: 'ekko-agent', bot_type: bot.type })
      expect(avatar).toEqual({ label: locale.startsWith('zh') ? bot.name : bot.type, src: bot.avatar })
      expect(personAvatarAnimation(avatar, 'thinking')).toBe(bot.animations.thinking)
      expect(personAvatarAnimation(avatar, 'idle')).toBe(bot.animations.idle)
    }
  })

  it('does not replace worker avatars with Person animations', () => {
    expect(personAvatarAnimation(chatSessionAgentAvatar({ id: 'person-task-1', agent: 'ekko-agent' }), 'thinking')).toBeUndefined()
  })

  it('uses stored bot identity independently of runtime and does not relabel unknown bots as zhezhe', () => {
    for (const identity of [{ botType: 'zhezhe' }, { bot_type: 'zhezhe' }]) {
      expect(chatSessionAgentAvatar({ id: 'conversation-1', agent: 'ekko-agent', ...identity }).label).toBe('zhezhe')
    }
    expect(chatSessionAgentAvatar({ id: 'person-main-future', botType: 'future-bot', agent: 'ekko-agent' }).label).toBe('Ekko')
  })
  it('names the personal assistant 折折 while keeping task worker identities', () => {
    expect(chatSessionAgentAvatar({ id: 'person-main-1', agent: 'ekko-agent' })).toEqual({
      label: 'zhezhe',
      src: '/coding-agents/person.jpg',
    })
    expect(chatSessionAgentAvatar({ id: 'person-task-1', agent: 'ekko-agent' })).toEqual({
      label: 'Ekko',
      src: '/coding-agents/ekko-agent.png',
    })
  })

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
    ['Hermes', { source: 'coding_agent', agent: 'hermes' }, '/coding-agents/hermes.png'],
    ['Hermes', { source: 'coding_agent', agent: ' Hermes ' }, '/coding-agents/hermes.png'],
    ['Hermes', { source: 'coding_agent', codingAgentId: 'hermes' }, '/coding-agents/hermes.png'],
    ['Ekko', { agent: 'ekko-agent' }, '/coding-agents/ekko-agent.png'],
    ['Ekko', { agent: 'ekko_agent' }, '/coding-agents/ekko-agent.png'],
    ['Claude', { agent: 'claude' }, '/coding-agents/claude-code.svg'],
    ['Claude', { codingAgentId: 'claude-code' }, '/coding-agents/claude-code.svg'],
    ['Codex', { codingAgentId: 'codex' }, '/coding-agents/codex-openai.png'],
    ['DeepSeek Harness', { codingAgentId: 'dsh' }, '/coding-agents/deepseek.svg'],
    ['Pi', { codingAgentId: 'pi' }, '/coding-agents/pi.svg'],
    ['Grok', { codingAgentId: 'grok' }, '/coding-agents/grok.svg'],
    ['Cursor', { codingAgentId: 'cursor' }, '/coding-agents/cursor-logo.png'],
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

import { personTaskAgentAvatar } from '../../packages/client/src/utils/chat-agent-avatar'
describe('task execution identity', () => {
  it.each(['hermes', 'ekko-agent', 'claude-code', 'codex'])('uses selected runtime %s', runtime => {
    expect(personTaskAgentAvatar({ selection_json: JSON.stringify({ runtime, bot_type: 'zhezhe' }) })).toEqual(chatSessionAgentAvatar({ agent: runtime }))
  })
  it.each(['', '{', 'null'])('handles invalid or missing selection %s', selection_json => {
    expect(personTaskAgentAvatar({ selection_json }).label).toBe('Ekko')
  })
})
