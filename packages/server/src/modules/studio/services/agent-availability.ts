import {
  isAgentAvailable,
  type AgentStatusId,
} from '../public/agent-status-registry'

const AGENT_ALIASES: Record<string, AgentStatusId> = {
  hermes: 'hermes',
  ekko: 'ekko-agent',
  'ekko-agent': 'ekko-agent',
  claude: 'claude-code',
  'claude-code': 'claude-code',
  codex: 'codex',
  pi: 'pi',
  grok: 'grok',
  opencode: 'opencode',
  dsh: 'dsh',
  cursor: 'cursor',
}

const AGENT_NAMES: Record<AgentStatusId, string> = {
  hermes: 'Hermes',
  'ekko-agent': 'Ekko',
  'claude-code': 'Claude',
  codex: 'Codex',
  pi: 'Pi',
  grok: 'Grok',
  opencode: 'OpenCode',
  dsh: 'DeepSeek Harness',
  cursor: 'Cursor',
}

export const AGENT_NOT_INSTALLED = 'AGENT_NOT_INSTALLED'

export function resolveAgentStatusId(agent: unknown): AgentStatusId | null {
  const key = typeof agent === 'string' ? agent.trim().toLowerCase() : ''
  return AGENT_ALIASES[key] || null
}

export function assertAgentAvailable(agent: unknown): AgentStatusId {
  const id = resolveAgentStatusId(agent)
  if (!id) {
    throw Object.assign(new Error('Invalid agent'), { status: 400, code: 'INVALID_AGENT' })
  }
  if (!isAgentAvailable(id)) {
    throw Object.assign(new Error(`${AGENT_NAMES[id]} is not installed`), {
      status: 409,
      code: AGENT_NOT_INSTALLED,
      agent: id,
    })
  }
  return id
}
