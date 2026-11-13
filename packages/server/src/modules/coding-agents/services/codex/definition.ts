import type { CodingAgentConfigFileTemplate } from '../../contracts/definition'

export const CODEX_DEFINITION = {
  id: 'codex',
  name: 'Codex',
  provider: 'OpenAI',
  command: 'codex',
  packageName: '@openai/codex',
} as const

export const CODEX_CONFIG_FILES: CodingAgentConfigFileTemplate[] = [
  { key: 'auth', path: '~/.codex/auth.json', scopedPath: 'auth.json', language: 'json' },
  { key: 'config', path: '~/.codex/config.toml', scopedPath: 'config.toml', language: 'ini' },
  { key: 'agents', path: '~/.codex/AGENTS.md', scopedPath: 'AGENTS.md', language: 'markdown' },
]
