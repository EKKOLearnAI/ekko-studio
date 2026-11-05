import { afterEach, expect, it } from 'vitest'
import { computed, reactive } from 'vue'
import { chatSessionAgentAvatar, personAvatarAnimation, personAvatarStyle } from '../../packages/client/src/utils/chat-agent-avatar'
import { personBotLabel } from '../../packages/client/src/utils/person-bot-label'
import { uiLocale } from '../../packages/client/src/i18n/locale-state'
import { PERSON_BOTS } from '../../packages/shared/person-bots'

afterEach(() => { uiLocale.value = 'en' })

it.each(['zh', 'en'])('uses custom main Bot names without changing their appearance (%s)', locale => {
  uiLocale.value = locale
  for (const bot of PERSON_BOTS) {
    const identity = { id: 'person-main-named', title: '  我的助理  ', agent: 'ekko-agent' }
    const baseline = chatSessionAgentAvatar({ ...identity, title: '', botType: bot.type })
    for (const type of [{ botType: bot.type }, { bot_type: bot.type }]) {
      const avatar = chatSessionAgentAvatar({ ...identity, ...type })
      expect(avatar).toEqual({ label: '我的助理', src: bot.avatar })
      expect(personAvatarAnimation(avatar, 'thinking')).toBe(bot.animations.thinking)
      expect(personAvatarStyle(avatar)).toEqual(personAvatarStyle(baseline))
    }
  }
})

it('updates the author name when only the reactive session title changes', () => {
  const session = reactive({ id: 'person-main-renamed', title: '厨房助手', botType: 'dachu' })
  const avatar = computed(() => chatSessionAgentAvatar(session))
  const originalSrc = avatar.value.src
  expect(avatar.value.label).toBe('厨房助手')
  session.title = '菜谱管家'
  expect(avatar.value).toEqual({ label: '菜谱管家', src: originalSrc })
  uiLocale.value = 'zh'
  expect(avatar.value.label).toBe('菜谱管家')
  session.title = ' '
  expect(avatar.value.label).toBe('大厨')
})

it.each(['zh', 'en'])('falls back to localized appearance names for absent or blank titles (%s)', locale => {
  uiLocale.value = locale
  for (const title of [undefined, null, '', ' \n\t ']) {
    expect(chatSessionAgentAvatar({ id: 'person-main-unnamed', title, bot_type: 'nuannuan' }).label)
      .toBe(locale === 'zh' ? '暖暖' : 'nuannuan')
  }
})

it('keeps the default appearance for legacy main sessions while using their custom title', () => {
  uiLocale.value = 'zh'
  const avatar = chatSessionAgentAvatar({ id: 'person-main-legacy', title: '旧助手' })
  expect(avatar).toEqual({ label: '旧助手', src: '/coding-agents/person.jpg' })
  expect(chatSessionAgentAvatar({ id: 'person-main-legacy', title: '' }).label).toBe('折折')
})

it('keeps runtime names for ordinary chat and execution sessions instead of their task titles', () => {
  for (const [agent, label] of [['hermes', 'Hermes'], ['ekko-agent', 'Ekko'], ['codex', 'Codex']]) {
    expect(chatSessionAgentAvatar({ id: 'ordinary', agent, title: '聊天标题' }).label).toBe(label)
    expect(chatSessionAgentAvatar({ id: 'person-task-execution', agent, title: '任务标题' }).label).toBe(label)
  }
  uiLocale.value = 'zh'
  expect(chatSessionAgentAvatar({ bot_type: 'dachu', title: '仅查询外观' }).label).toBe('大厨')
})

it('retains missing-session and unknown-appearance fallbacks', () => {
  expect(chatSessionAgentAvatar(null).label).toBe('Ekko')
  expect(chatSessionAgentAvatar({ id: 'person-main-future', bot_type: 'unknown', agent: 'ekko-agent', title: '未来助手' }).label).toBe('Ekko')
})

it('keeps appearance picker labels independent of custom conversation names', () => {
  expect(personBotLabel(PERSON_BOTS[2], 'zh')).toBe('大厨')
  expect(personBotLabel(PERSON_BOTS[2], 'en')).toBe('dachu')
})
