export interface ChatAgentAvatar {
  label: 'Hermes' | 'Ekko' | 'Claude' | 'Codex' | 'Pi' | 'Grok' | 'OpenCode' | 'DeepSeek Harness' | 'Cursor'
  src: string
}

interface ChatAgentSessionIdentity {
  source?: string
  agent?: string
  codingAgentId?: string
}

const AGENT_AVATARS = {
  hermes: { label: 'Hermes', src: '/coding-agents/hermes.png' },
  'ekko-agent': { label: 'Ekko', src: '/coding-agents/ekko-agent.png' },
  'claude-code': { label: 'Claude', src: '/coding-agents/claude-code.svg' },
  codex: { label: 'Codex', src: '/coding-agents/codex-openai.png' },
  pi: { label: 'Pi', src: '/coding-agents/pi.svg' },
  grok: { label: 'Grok', src: '/coding-agents/grok.svg' },
  opencode: { label: 'OpenCode', src: '/coding-agents/opencode.png' },
  dsh: { label: 'DeepSeek Harness', src: '/coding-agents/deepseek.svg' },
  cursor: { label: 'Cursor', src: '/coding-agents/cursor.svg' },
} as const satisfies Record<string, ChatAgentAvatar>

export function chatSessionAgentAvatar(session?: ChatAgentSessionIdentity | null): ChatAgentAvatar {
  if (!session) return AGENT_AVATARS['ekko-agent']
  const runtime = String(session?.codingAgentId || session?.agent || '').trim().toLowerCase()
  if (runtime === 'ekko-agent' || runtime === 'ekko_agent' || runtime === 'ekko') return AGENT_AVATARS['ekko-agent']
  if (runtime === 'claude' || runtime === 'claude-code') return AGENT_AVATARS['claude-code']
  if (runtime === 'codex') return AGENT_AVATARS.codex
  if (runtime === 'pi') return AGENT_AVATARS.pi
  if (runtime === 'grok') return AGENT_AVATARS.grok
  if (runtime === 'dsh') return AGENT_AVATARS.dsh
  if (runtime === 'opencode') return AGENT_AVATARS.opencode
  if (runtime === 'cursor') return AGENT_AVATARS.cursor
  if (session?.source === 'coding_agent') return AGENT_AVATARS['claude-code']
  return AGENT_AVATARS.hermes
}
