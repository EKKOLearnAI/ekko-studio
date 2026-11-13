import type { CodingAgentConfigFileTemplate } from '../../contracts/definition'

export const DSH_DEFINITION = {
  id: 'dsh',
  name: 'DeepSeek Harness',
  provider: 'DeepSeek',
  command: 'dsh',
  packageName: '@deepseek-ai/dsh',
} as const

export const DSH_CONFIG_FILES: CodingAgentConfigFileTemplate[] = [
  { key: 'settings', path: '~/.dsh/settings.yaml', scopedPath: 'settings.yaml', language: 'yaml' },
  { key: 'memory', path: '~/.dsh/AGENTS.md', scopedPath: 'AGENTS.md', language: 'markdown' },
  { key: 'mcp', path: '~/.dsh/cordis.patch.yml', scopedPath: 'cordis.patch.yml', language: 'yaml' },
]
