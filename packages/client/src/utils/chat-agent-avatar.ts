import { deploymentUrl } from './deployment-url'
import { personBotLabel } from './person-bot-label'
import { DEFAULT_PERSON_BOT_TYPE, PERSON_BOTS, personBot } from '../../../shared/person-bots'

export interface ChatAgentAvatar {
  label: string
  src: string
}

interface ChatAgentSessionIdentity {
  id?: string
  source?: string
  agent?: string
  codingAgentId?: string
  botType?: string
  bot_type?: string
}

export const PERSON_AVATAR = { get label() { return personBotLabel(PERSON_BOTS[0]) }, src: deploymentUrl('/coding-agents/person.jpg') } as const satisfies ChatAgentAvatar
export const PERSON_ANIMATIONS = {
  idle: deploymentUrl('/person/idle.gif'),
  thinking: deploymentUrl('/person/thinking.gif'),
  searching: deploymentUrl('/person/searching.gif'),
  done: deploymentUrl('/person/done.gif'),
  error: deploymentUrl('/person/error.gif'),
  sleeping: deploymentUrl('/person/sleeping.gif'),
} as const

export function personAvatarAnimation(avatar: ChatAgentAvatar, state: keyof typeof PERSON_ANIMATIONS) {
  const bot = PERSON_BOTS.find(bot => deploymentUrl(bot.avatar) === avatar.src)
  return bot ? deploymentUrl(bot.animations[state]) : undefined
}

export function personAvatarStyle(avatar: ChatAgentAvatar, state?: 'thinking') {
  const bot = PERSON_BOTS.find(bot => deploymentUrl(bot.avatar) === avatar.src)
  const offset = state === 'thinking' ? bot?.thinkingOffset : bot?.avatarOffset
  return {
    '--person-avatar-offset-x': offset?.x ?? 0,
    '--person-avatar-offset-y': offset?.y ?? 0,
  }
}

const AGENT_AVATARS = {
  hermes: { label: 'Hermes', src: deploymentUrl('/coding-agents/hermes.png') },
  'ekko-agent': { label: 'Ekko', src: deploymentUrl('/coding-agents/ekko-agent.png') },
  'claude-code': { label: 'Claude', src: deploymentUrl('/coding-agents/claude-code.svg') },
  codex: { label: 'Codex', src: deploymentUrl('/coding-agents/codex-openai.png') },
  pi: { label: 'Pi', src: deploymentUrl('/coding-agents/pi.svg') },
  grok: { label: 'Grok', src: deploymentUrl('/coding-agents/grok.svg') },
  opencode: { label: 'OpenCode', src: deploymentUrl('/coding-agents/opencode.png') },
  dsh: { label: 'DeepSeek Harness', src: deploymentUrl('/coding-agents/deepseek.svg') },
  cursor: { label: 'Cursor', src: deploymentUrl('/coding-agents/cursor-logo.png') },
  qwen: { label: 'Qwen Code', src: deploymentUrl('/coding-agents/qwen-logo.svg') },
  kimi: { label: 'Kimi Code', src: deploymentUrl('/coding-agents/kimi-logo.png') },
  codebuddy: { label: 'CodeBuddy', src: deploymentUrl('/coding-agents/codebuddy-logo.svg') },
  qoder: { label: 'Qoder', src: deploymentUrl('/coding-agents/qoder-logo.svg') },
  copilot: { label: 'GitHub Copilot', src: deploymentUrl('/coding-agents/copilot-logo.svg') },
  zcode: { label: 'ZCode', src: deploymentUrl('/coding-agents/zcode-logo.png') },
  antigravity: { label: 'Antigravity', src: deploymentUrl('/coding-agents/antigravity.png') },
} as const satisfies Record<string, ChatAgentAvatar>

export function personTaskAgentAvatar(task: { selection_json: string }): ChatAgentAvatar {
  try {
    const selection = JSON.parse(task.selection_json || '{}')
    return chatSessionAgentAvatar({ agent: selection?.runtime || 'ekko-agent' })
  } catch { return chatSessionAgentAvatar({ agent: 'ekko-agent' }) }
}

export function chatSessionAgentAvatar(session?: ChatAgentSessionIdentity | null): ChatAgentAvatar {
  if (!session) return AGENT_AVATARS['ekko-agent']
  const botType = session.botType || session.bot_type || (session.id?.startsWith('person-main-') ? DEFAULT_PERSON_BOT_TYPE : '')
  const bot = personBot(botType)
  if (bot) return { label: personBotLabel(bot), src: deploymentUrl(bot.avatar) }
  const runtime = String(session?.codingAgentId || session?.agent || '').trim().toLowerCase()
  if (runtime === 'hermes') return AGENT_AVATARS.hermes
  if (runtime === 'ekko-agent' || runtime === 'ekko_agent' || runtime === 'ekko') return AGENT_AVATARS['ekko-agent']
  if (runtime === 'claude' || runtime === 'claude-code') return AGENT_AVATARS['claude-code']
  if (runtime === 'codex') return AGENT_AVATARS.codex
  if (runtime === 'pi') return AGENT_AVATARS.pi
  if (runtime === 'grok') return AGENT_AVATARS.grok
  if (runtime === 'dsh') return AGENT_AVATARS.dsh
  if (runtime === 'opencode') return AGENT_AVATARS.opencode
  if (runtime === 'antigravity') return AGENT_AVATARS.antigravity
  if (runtime === 'qwen') return AGENT_AVATARS.qwen
  if (runtime === 'kimi') return AGENT_AVATARS.kimi
  if (runtime === 'codebuddy') return AGENT_AVATARS.codebuddy
  if (runtime === 'qoder') return AGENT_AVATARS.qoder
  if (runtime === 'copilot') return AGENT_AVATARS.copilot
  if (runtime === 'zcode') return AGENT_AVATARS.zcode
  if (runtime === 'cursor') return AGENT_AVATARS.cursor
  if (session?.source === 'coding_agent') return AGENT_AVATARS['claude-code']
  return AGENT_AVATARS.hermes
}
