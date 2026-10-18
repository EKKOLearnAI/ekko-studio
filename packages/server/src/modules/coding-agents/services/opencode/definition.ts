import type { CodingAgentConfigFileTemplate } from '../../contracts/definition'
import { OPENCODE_CONFIG_FILE } from './config'

export const OPENCODE_DEFINITION = {
  id: 'opencode',
  name: 'OpenCode',
  provider: 'OpenCode',
  command: 'opencode',
  packageName: 'opencode-ai',
} as const

export const OPENCODE_CONFIG_FILES: CodingAgentConfigFileTemplate[] = [
  { key: 'settings', path: '~/.config/opencode/opencode.json', scopedPath: OPENCODE_CONFIG_FILE, language: 'json' },
  { key: 'memory', path: '~/.config/opencode/AGENTS.md', scopedPath: 'AGENTS.md', language: 'markdown' },
  { key: 'mcp', path: '~/.config/opencode/opencode.json', scopedPath: OPENCODE_CONFIG_FILE, language: 'json' },
  // Keep the native names as compatibility aliases for older clients.
  { key: 'config', path: '~/.config/opencode/opencode.json', scopedPath: OPENCODE_CONFIG_FILE, language: 'json' },
  { key: 'agents', path: '~/.config/opencode/AGENTS.md', scopedPath: 'AGENTS.md', language: 'markdown' },
]
