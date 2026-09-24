import { describe, expect, it } from 'vitest'
import {
  getCodingAgentDefinitions,
  piMcpAdapterInstallArgs,
  withCodingAgentRegistry,
} from '../../packages/server/src/modules/coding-agents/services'

describe('coding Agent npm registry policy', () => {
  it('does not pin coding Agent or Pi MCP Adapter package versions', () => {
    for (const agent of getCodingAgentDefinitions()) {
      expect(agent.packageName).not.toMatch(/@\d+\.\d+\.\d+(?:$|[-+])/)
    }
    expect(piMcpAdapterInstallArgs('/tmp/pi-adapter')).toEqual([
      'install',
      '--prefix',
      '/tmp/pi-adapter',
      'pi-mcp-adapter',
    ])
  })

  it.each([
    ['codex', '@openai/codex'],
    ['grok', '@xai-official/grok'],
    ['dsh', '@deepseek-ai/dsh'],
  ] as const)('uses the official npm Registry for %s package operations', (agentId, packageName) => {
    expect(withCodingAgentRegistry(agentId, ['install', '-g', packageName])).toEqual([
      'install',
      '-g',
      packageName,
      ...(agentId === 'dsh' ? ['--prefer-dedupe'] : []),
      '--registry=https://registry.npmjs.org',
    ])
    expect(withCodingAgentRegistry(agentId, ['view', packageName, 'version'])).toEqual([
      'view',
      packageName,
      'version',
      '--registry=https://registry.npmjs.org',
    ])
  })

  it.each(['claude-code', 'pi'] as const)(
    'keeps the configured npm Registry for %s',
    (agentId) => {
      expect(withCodingAgentRegistry(agentId, ['install', '-g', 'package'])).toEqual([
        'install',
        '-g',
        'package',
      ])
      expect(withCodingAgentRegistry(agentId, ['view', 'package', 'version'])).toEqual([
        'view',
        'package',
        'version',
      ])
    },
  )
})
