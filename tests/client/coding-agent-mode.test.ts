import { describe, expect, it } from 'vitest'
import { nextCodingAgentMode, storedPriorAgentMode, submittedCodingAgentSelection, workflowSavedAgentFields } from '../../packages/client/src/utils/coding-agent-mode'

const existingAgents = ['claude', 'claude-code', 'codex', 'pi', 'grok', 'opencode', 'dsh'] as const

describe('storedPriorAgentMode', () => {
  it('keeps only a saved scoped or global mode', () => {
    expect(storedPriorAgentMode('global')).toBe('global')
    expect(storedPriorAgentMode('scoped')).toBe('scoped')
    expect(storedPriorAgentMode('')).toBeUndefined()
    expect(storedPriorAgentMode(undefined)).toBeUndefined()
  })
})

describe('nextCodingAgentMode', () => {
  it('restores the mode stashed when leaving Cursor', () => {
    for (const agent of existingAgents) {
      const entered = nextCodingAgentMode({
        previousAgent: agent,
        nextAgent: 'cursor',
        agentMode: 'scoped',
      })
      expect(entered).toEqual({ agentMode: 'global', priorAgentMode: 'scoped' })
      expect(nextCodingAgentMode({
        previousAgent: 'cursor',
        nextAgent: agent,
        agentMode: entered.agentMode,
        priorAgentMode: entered.priorAgentMode,
      })).toEqual({ agentMode: 'scoped', priorAgentMode: undefined })
    }
  })

  it('restores an original global mode instead of forcing scoped', () => {
    const entered = nextCodingAgentMode({
      previousAgent: 'codex',
      nextAgent: 'cursor',
      agentMode: 'global',
    })
    expect(nextCodingAgentMode({
      previousAgent: 'cursor',
      nextAgent: 'codex',
      agentMode: 'global',
      priorAgentMode: entered.priorAgentMode,
    })).toEqual({ agentMode: 'global', priorAgentMode: undefined })
  })

  it('saves the restored mode when leaving Cursor for each existing agent', () => {
    for (const agent of existingAgents) {
      const entered = nextCodingAgentMode({
        previousAgent: agent,
        nextAgent: 'cursor',
        agentMode: 'scoped',
      })
      expect(submittedCodingAgentSelection({
        agent: 'cursor',
        agentMode: entered.agentMode,
        priorAgentMode: entered.priorAgentMode,
        provider: 'openai',
        model: 'gpt-test',
        usesGlobal: true,
      })).toEqual({
        agent: 'cursor',
        agentMode: 'global',
        priorAgentMode: 'scoped',
        provider: '',
        model: '',
      })
      const left = nextCodingAgentMode({
        previousAgent: 'cursor',
        nextAgent: agent,
        agentMode: entered.agentMode,
        priorAgentMode: entered.priorAgentMode,
      })
      expect(submittedCodingAgentSelection({
        agent,
        agentMode: left.agentMode,
        priorAgentMode: left.priorAgentMode,
        provider: 'openai',
        model: 'gpt-test',
        usesGlobal: left.agentMode === 'global',
      })).toEqual({
        agent,
        agentMode: 'scoped',
        priorAgentMode: '',
        provider: 'openai',
        model: 'gpt-test',
      })
      expect(workflowSavedAgentFields({
        agent,
        agentMode: left.agentMode,
        priorAgentMode: left.priorAgentMode,
        provider: 'openai',
        model: 'gpt-test',
      })).toEqual({
        agent,
        agentMode: 'scoped',
        priorAgentMode: undefined,
        provider: 'openai',
        model: 'gpt-test',
      })
    }
  })
})
