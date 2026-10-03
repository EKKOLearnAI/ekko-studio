import type { CodingAgentConfigFileTemplate } from '../../contracts/definition'

export const CURSOR_DEFINITION = {
  id: 'cursor',
  name: 'Cursor',
  provider: 'Cursor',
  command: 'agent',
  packageName: 'cursor-agent',
} as const

export const CURSOR_CONFIG_FILES: CodingAgentConfigFileTemplate[] = [
  { key: 'settings', path: '~/.cursor/cli-config.json', scopedPath: 'cli-config.json', language: 'json' },
  { key: 'mcp', path: '~/.cursor/mcp.json', scopedPath: '.cursor/mcp.json', language: 'json' },
]
