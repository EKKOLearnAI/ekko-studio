import { beforeEach, describe, expect, it } from 'vitest'
import {
  getAgentAvailabilitySnapshot,
  getAgentStatusSnapshot,
  isAgentAvailable,
  isHermesAgentAvailable,
  resetAgentStatusRegistryForTests,
  updateAgentStatus,
} from '../../packages/server/src/modules/studio/public/agent-status-registry'

describe('Agent status registry', () => {
  beforeEach(resetAgentStatusRegistryForTests)

  it('keeps one in-memory snapshot for every supported Agent', () => {
    const snapshot = getAgentStatusSnapshot()

    expect(snapshot.agents.map(agent => agent.id)).toEqual([
      'hermes',
      'ekko-agent',
      'claude-code',
      'codex',
      'pi',
      'grok',
      'opencode',
      'dsh',
      'cursor',
    ])
    expect(snapshot.agents.find(agent => agent.id === 'ekko-agent')).toMatchObject({
      installed: true,
      source: 'built-in',
    })
  })

  it('updates version, source, path, and installations atomically', () => {
    updateAgentStatus('hermes', {
      installed: true,
      version: '0.20.4',
      source: 'user-cli',
      path: '/Users/test/.local/bin/hermes',
      installations: [{
        path: '/Users/test/.local/bin/hermes',
        version: '0.20.4',
        source: 'user-cli',
        selected: true,
      }],
    })

    const snapshot = getAgentStatusSnapshot()
    expect(snapshot.revision).toBe(1)
    expect(snapshot.agents.find(agent => agent.id === 'hermes')).toMatchObject({
      installed: true,
      version: '0.20.4',
      source: 'user-cli',
      path: '/Users/test/.local/bin/hermes',
      installations: [expect.objectContaining({ selected: true })],
    })
  })

  it('exposes installation state without local paths or versions', () => {
    updateAgentStatus('hermes', {
      installed: true,
      version: '0.20.4',
      source: 'managed-runtime',
      path: '/private/runtime/hermes',
    })

    const hermes = getAgentAvailabilitySnapshot().agents.find(agent => agent.id === 'hermes')
    expect(hermes).toEqual({
      id: 'hermes',
      installed: true,
      source: 'managed-runtime',
    })
    expect(hermes).not.toHaveProperty('path')
    expect(hermes).not.toHaveProperty('version')
  })

  it('only reports Hermes available when the inventory has an executable path', () => {
    expect(isHermesAgentAvailable()).toBe(false)

    updateAgentStatus('hermes', {
      installed: true,
      version: '0.20.4',
      source: 'user-cli',
      path: '',
    })
    expect(isHermesAgentAvailable()).toBe(false)

    updateAgentStatus('hermes', { path: '/usr/local/bin/hermes' })
    expect(isHermesAgentAvailable()).toBe(true)
  })

  it('reports built-in and installed coding Agents as available', () => {
    expect(isAgentAvailable('ekko-agent')).toBe(true)
    expect(isAgentAvailable('codex')).toBe(false)

    updateAgentStatus('codex', {
      installed: true,
      source: 'user-cli',
      path: '/usr/local/bin/codex',
    })

    expect(isAgentAvailable('codex')).toBe(true)
  })
})
