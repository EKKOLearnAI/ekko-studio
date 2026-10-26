import { describe, expect, it } from 'vitest'
import catalog from '../../config/agents.json'
import { AGENT_OPTIONS, GROUP_AGENT_OPTIONS } from '../../packages/client/src/utils/agent-options'
import { NATIVE_CODING_AGENT_IDS, agentMetadata, isGlobalOnlyCodingAgent } from '../../packages/client/src/utils/agent-catalog'
import { nextCodingAgentMode, workflowSavedAgentFields } from '../../packages/client/src/utils/coding-agent-mode'
import { chatSessionAgentAvatar } from '../../packages/client/src/utils/chat-agent-avatar'
import { sessionAgentFields } from '../../packages/client/src/utils/hermes/session-agent'

describe('native runtime catalog and client selection', () => {
  it.each(NATIVE_CODING_AGENT_IDS)('preserves %s identity and supported modes across pickers and history', id => {
    expect(catalog.agents).toHaveLength(16)
    expect(agentMetadata(id)?.modes).toEqual(id === 'qoder' ? ['global'] : ['scoped', 'global'])
    expect(isGlobalOnlyCodingAgent(id)).toBe(id === 'qoder')
    expect(AGENT_OPTIONS.find(agent => agent.value === id)?.label).toBe(agentMetadata(id)?.name)
    expect(GROUP_AGENT_OPTIONS.find(agent => agent.value === id)).toBeDefined()
    expect(chatSessionAgentAvatar({ source: 'coding_agent', agent: id }).src).toBe(new URL(agentMetadata(id)!.icon).pathname)
    expect(sessionAgentFields({ source: 'coding_agent', agent: id, agent_mode: 'global' } as any)).toMatchObject({ codingAgentId: id, codingAgentMode: 'global' })
    const entered = nextCodingAgentMode({ previousAgent: 'codex', nextAgent: id, agentMode: 'scoped' })
    expect(entered).toEqual(id === 'qoder' ? { agentMode: 'global', priorAgentMode: 'scoped' } : { agentMode: 'scoped', priorAgentMode: undefined })
    expect(nextCodingAgentMode({ previousAgent: id, nextAgent: 'codex', ...entered })).toEqual({ agentMode: 'scoped', priorAgentMode: undefined })
    expect(workflowSavedAgentFields({ agent: id, agentMode: 'scoped', provider: '', model: '' }).agentMode).toBe(id === 'qoder' ? 'global' : 'scoped')
  })
  it('declares manual installation and unsupported editors without advertising fake capabilities', () => {
    for (const id of NATIVE_CODING_AGENT_IDS) {
      const agent = agentMetadata(id)!
      expect(agent.icon).toMatch(/^https:\/\/ekkostudio.xyz\/coding-agents\//)
      expect(agent.capabilities).toEqual({ context: false, compact: false, serverManagedAuth: false })
      expect(agent.config.skillsWritable).toBe(false)
      expect(agent.installation.method).toBe(id === 'zcode' ? 'manual' : 'npm')
      expect(agent.config.mcp).toBe(id !== 'zcode')
    }
  })
})
