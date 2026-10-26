import type { CodingAgentConfigFileTemplate } from '../../contracts/definition'

export const PI_DEFINITION = {
  id: 'pi',
  name: 'Pi',
  provider: 'Pi',
  command: 'pi',
  packageName: '@earendil-works/pi-coding-agent',
} as const

export const PI_CONFIG_FILES: CodingAgentConfigFileTemplate[] = [
  { key: 'auth', path: '~/.pi/agent/auth.json', scopedPath: 'auth.json', language: 'json' },
  { key: 'settings', path: '~/.pi/agent/settings.json', scopedPath: 'settings.json', language: 'json' },
  { key: 'agents', path: '~/.pi/agent/AGENTS.md', scopedPath: 'AGENTS.md', language: 'markdown' },
  { key: 'mcp', path: '~/.pi/agent/mcp.json', scopedPath: 'mcp.json', language: 'json' },
]
