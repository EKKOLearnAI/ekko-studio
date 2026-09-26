const KNOWN_CODING_AGENTS = new Set([
  'claude',
  'claude-code',
  'codex',
  'pi',
  'grok',
  'opencode',
  'dsh',
  'cursor',
])

export function storedPriorAgentMode(value: unknown): 'scoped' | 'global' | undefined {
  return value === 'global' || value === 'scoped' ? value : undefined
}

export function nextCodingAgentMode(input: {
  previousAgent: string
  nextAgent: string
  agentMode: 'scoped' | 'global'
  priorAgentMode?: 'scoped' | 'global'
}): { agentMode: 'scoped' | 'global'; priorAgentMode?: 'scoped' | 'global' } {
  if (input.previousAgent === input.nextAgent) {
    return { agentMode: input.agentMode, priorAgentMode: input.priorAgentMode }
  }
  if (input.nextAgent === 'cursor') {
    return {
      agentMode: 'global',
      priorAgentMode: input.previousAgent === 'cursor' ? input.priorAgentMode : input.agentMode,
    }
  }
  if (input.previousAgent === 'cursor') {
    return {
      agentMode: input.priorAgentMode === 'global' ? 'global' : 'scoped',
      priorAgentMode: undefined,
    }
  }
  if (!KNOWN_CODING_AGENTS.has(input.nextAgent)) {
    return { agentMode: 'scoped', priorAgentMode: undefined }
  }
  return { agentMode: input.agentMode, priorAgentMode: input.priorAgentMode }
}

export function submittedCodingAgentSelection<Agent extends string>(input: {
  agent: Agent
  agentMode: 'scoped' | 'global'
  priorAgentMode?: 'scoped' | 'global'
  provider: string
  model: string
  usesGlobal: boolean
}): {
  agent: Agent
  agentMode: 'scoped' | 'global'
  priorAgentMode: '' | 'scoped' | 'global'
  provider: string
  model: string
} {
  return {
    agent: input.agent,
    agentMode: input.usesGlobal ? 'global' : 'scoped',
    priorAgentMode: input.priorAgentMode || '',
    provider: input.usesGlobal ? '' : input.provider,
    model: input.usesGlobal ? '' : input.model,
  }
}

export function workflowSavedAgentFields(data: {
  agent: string
  agentMode: 'scoped' | 'global'
  priorAgentMode?: 'scoped' | 'global'
  provider: string
  model: string
}): {
  agent: string
  agentMode: 'scoped' | 'global'
  priorAgentMode?: 'scoped' | 'global'
  provider: string
  model: string
} {
  return {
    agent: data.agent,
    agentMode: data.agent === 'cursor' ? 'global' : data.agentMode,
    priorAgentMode: storedPriorAgentMode(data.priorAgentMode),
    provider: data.provider,
    model: data.model,
  }
}
