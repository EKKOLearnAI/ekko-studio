import {
  isAgentAvailable,
  type AgentStatusId,
} from '../public/agent-status-registry'
import { isPluginAgentId, agentDescriptor } from './agents/registry'
import type { PluginAgentId } from '../contracts/plugins'

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
  antigravity: 'antigravity',
  qwen: 'qwen',
  kimi: 'kimi',
  codebuddy: 'codebuddy',
  qoder: 'qoder',
  copilot: 'copilot',
  zcode: 'zcode',

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
  antigravity: 'Antigravity',
  qwen: 'Qwen Code',
  kimi: 'Kimi Code',
  codebuddy: 'CodeBuddy',
  qoder: 'Qoder',
  copilot: 'GitHub Copilot',
  zcode: 'ZCode',

}

export const AGENT_NOT_INSTALLED = 'AGENT_NOT_INSTALLED'

export function resolveAgentStatusId(agent: unknown): AgentStatusId | PluginAgentId | null {
  const key = typeof agent === 'string' ? agent.trim().toLowerCase() : ''
  if (isPluginAgentId(key)) return key
  return AGENT_ALIASES[key] || null
}

export function assertAgentAvailable(agent: unknown): AgentStatusId | PluginAgentId {
  const id = resolveAgentStatusId(agent)
  if (!id) {
    throw Object.assign(new Error('Invalid agent'), { status: 400, code: 'INVALID_AGENT' })
  }
  if (isPluginAgentId(id)) {
    if (!agentDescriptor(id)) throw Object.assign(new Error('Agent plugin is disabled or unavailable'), { status: 409, code: AGENT_NOT_INSTALLED })
    return id
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
