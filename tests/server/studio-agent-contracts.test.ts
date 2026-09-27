import { describe, expect, it } from 'vitest'
import {
  AGENT_FAMILIES,
  AGENT_RUNTIMES,
  RUN_MODES,
  RUN_SURFACES,
  agentFamilyForRuntime,
  isAgentFamily,
  isAgentRuntime,
  isRunMode,
  isRunSurface,
} from '../../packages/server/src/modules/studio'
import type { GroupChatRunService } from '../../packages/server/src/modules/studio/services/group-chat/agent-clients'

describe('Studio agent contracts', () => {
  it('keeps the three families distinct from the nine runtimes', () => {
    expect(AGENT_FAMILIES).toEqual(['hermes', 'ekko', 'coding'])
    expect(AGENT_RUNTIMES).toEqual(['hermes', 'ekko', 'claude-code', 'codex', 'pi', 'grok', 'opencode', 'dsh', 'cursor'])
    expect(AGENT_RUNTIMES.map(agentFamilyForRuntime)).toEqual([
      'hermes',
      'ekko',
      'coding',
      'coding',
      'coding',
      'coding',
      'coding',
      'coding',
      'coding',
    ])
  })

  it('validates canonical values without accepting legacy aliases', () => {
    expect(isAgentFamily('coding')).toBe(true)
    expect(isAgentRuntime('claude-code')).toBe(true)
    expect(isAgentRuntime('grok')).toBe(true)
    expect(isAgentRuntime('cursor')).toBe(true)
    expect(isAgentRuntime('claude')).toBe(false)
    expect(isAgentRuntime('ekko-agent')).toBe(false)
  })

  it('keeps launch surface and mode independent from runtime', () => {
    expect(RUN_SURFACES).toEqual(['chat', 'workflow', 'group-chat', 'global-agent', 'api'])
    expect(RUN_MODES).toEqual(['scoped', 'global'])
    expect(isRunSurface('workflow')).toBe(true)
    expect(isRunSurface('coding_agent')).toBe(false)
    expect(isRunMode('global')).toBe(true)
  })

  it('accepts cursor as a group-chat coding_agent_id', () => {
    type GroupCodingAgentId = NonNullable<
      Parameters<GroupChatRunService['runAndWait']>[0]['coding_agent_id']
    >
    const id: GroupCodingAgentId = 'cursor'
    expect(id).toBe('cursor')
  })
})
