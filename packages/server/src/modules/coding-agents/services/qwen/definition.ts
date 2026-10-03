import type { CodingAgentConfigFileTemplate } from '../../contracts/definition'
import { join } from 'node:path'

export const QWEN_DEFINITION = {
  id: 'qwen',
  name: 'Qwen Code',
  provider: 'Alibaba',
  command: 'qwen',
  packageName: '@qwen-code/qwen-code',
  docsUrl: 'https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/',
  acpArgs: ['--acp'],
  capabilities: { modes: ['scoped', 'global'], installation: 'npm', images: false, nativeCompact: false, automaticUpdates: true },
} as const

export const QWEN_CONFIG_FILES: CodingAgentConfigFileTemplate[] = [{ key: 'mcp', path: join('coding-agent', 'native', 'qwen', 'mcp.json'), scopedPath: 'mcp.json', language: 'json' }]
