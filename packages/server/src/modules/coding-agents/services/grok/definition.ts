import type { CodingAgentConfigFileTemplate } from '../../contracts/definition'

export const GROK_CODING_AGENT_DEFINITION = {
  id: 'grok',
  name: 'Grok',
  provider: 'xAI',
  command: 'grok',
  packageName: '@xai-official/grok',
} as const

export const GROK_PROVIDER_ID = 'hermes-studio'
export const GROK_API_KEY_ENV = 'HERMES_STUDIO_GROK_API_KEY'

export const GROK_CODING_AGENT_CONFIG_FILES: CodingAgentConfigFileTemplate[] = [
  { key: 'auth', path: '~/.grok/auth.json', scopedPath: 'auth.json', language: 'json' },
  { key: 'config', path: '~/.grok/config.toml', scopedPath: 'config.toml', language: 'ini' },
  { key: 'mcp', path: '~/.grok/config.toml', scopedPath: 'config.toml', language: 'ini' },
  { key: 'settings', path: '~/.grok/config.toml', scopedPath: 'config.toml', language: 'ini' },
  { key: 'agents', path: '~/.grok/AGENTS.md', scopedPath: 'AGENTS.md', language: 'markdown' },
]
