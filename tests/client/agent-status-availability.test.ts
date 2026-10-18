// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  agentInstallationState,
  isAgentStatusAvailable,
  resolveAgentStatusId,
  type AgentAvailabilitySnapshot,
  type AgentStatusSnapshot,
} from '../../packages/client/src/api/agent-status'

function snapshot(): AgentStatusSnapshot {
  return {
    revision: 1,
    updatedAt: new Date(0).toISOString(),
    agents: [
      { id: 'hermes', installed: false, source: 'not-installed', path: '', version: '' },
      { id: 'ekko-agent', installed: true, source: 'built-in', path: '', version: '1.0.0' },
      { id: 'claude-code', installed: false, source: 'not-installed', path: '', version: '' },
      { id: 'codex', installed: true, source: 'user-cli', path: '/usr/local/bin/codex', version: '1.0.0' },
      { id: 'pi', installed: false, source: 'not-installed', path: '', version: '' },
      { id: 'opencode', installed: true, source: 'user-cli', path: '/usr/local/bin/opencode', version: '1.18.28' },
    ],
  }
}

describe('Agent status availability', () => {
  it.each(['qwen', 'kimi', 'codebuddy', 'qoder', 'copilot', 'zcode'] as const)(
    'recognizes installation changes for %s in every picker', id => {
      const status = snapshot()
      const agent = { id, installed: true, source: 'user-cli' as const, path: `/test/${id}`, version: '' }
      status.agents.push(agent)
      expect(resolveAgentStatusId(id.toUpperCase())).toBe(id)
      expect(isAgentStatusAvailable(status, id)).toBe(true)
      expect(agentInstallationState(status, id)).toBe('installed')
      agent.installed = false
      expect(isAgentStatusAvailable(status, id)).toBe(false)
      expect(agentInstallationState(status, id)).toBe('not-installed')
      expect(isAgentStatusAvailable(null, id)).toBe(false)
    },
  )
  it('normalizes group-chat and workflow Agent aliases', () => {
    expect(resolveAgentStatusId('ekko')).toBe('ekko-agent')
    expect(resolveAgentStatusId('claude')).toBe('claude-code')
    expect(resolveAgentStatusId('codex')).toBe('codex')
    expect(resolveAgentStatusId('OpenCode')).toBe('opencode')
  })

  it('only exposes Agents that the server inventory marks installed', () => {
    const status = snapshot()

    expect(isAgentStatusAvailable(status, 'hermes')).toBe(false)
    expect(isAgentStatusAvailable(status, 'ekko')).toBe(true)
    expect(isAgentStatusAvailable(status, 'claude-code')).toBe(false)
    expect(isAgentStatusAvailable(status, 'codex')).toBe(true)
    expect(isAgentStatusAvailable(status, 'opencode')).toBe(true)
  })

  it('uses the shared inventory state without requiring a version or executable path', () => {
    const availability: AgentAvailabilitySnapshot = {
      revision: 2,
      updatedAt: new Date(0).toISOString(),
      agents: [
        { id: 'hermes', installed: true, source: 'managed-runtime' },
      ],
    }

    expect(agentInstallationState(availability, 'hermes')).toBe('installed')
    availability.agents[0] = { id: 'hermes', installed: false, source: 'not-installed' }
    expect(agentInstallationState(availability, 'hermes')).toBe('not-installed')
    expect(agentInstallationState(null, 'hermes')).toBe('unknown')
    expect(agentInstallationState(snapshot(), 'opencode')).toBe('installed')
  })
})
