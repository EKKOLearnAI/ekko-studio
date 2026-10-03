import type { CodingAgentConfigFileTemplate } from '../../contracts/definition'
import { ANTIGRAVITY_CAPABILITIES } from './capabilities'

export const ANTIGRAVITY_DEFINITION = {
  id: 'antigravity',
  name: 'Antigravity',
  provider: 'Google',
  command: 'agy',
  packageName: '',
  capabilities: ANTIGRAVITY_CAPABILITIES,
} as const

export const ANTIGRAVITY_CONFIG_FILES: CodingAgentConfigFileTemplate[] = [
  { key: 'settings', path: '~/.gemini/antigravity-cli/settings.json', scopedPath: 'settings.json', language: 'json' },
  { key: 'mcp', path: '~/.gemini/config/mcp_config.json', scopedPath: 'mcp_config.json', language: 'json' },
  { key: 'memory', path: '~/.gemini/config/AGENTS.md', scopedPath: 'AGENTS.md', language: 'markdown' },
]
