import type { CodingAgentConfigFileTemplate } from '../../contracts/definition'
import { join } from 'node:path'

export const CODEBUDDY_DEFINITION = {
  id: 'codebuddy',
  name: 'CodeBuddy',
  provider: 'Tencent',
  command: 'codebuddy',
  packageName: '@tencent-ai/codebuddy-code',
  docsUrl: 'https://www.codebuddy.ai/docs/cli/README',
  acpArgs: ['--acp'],
  capabilities: { modes: ['scoped', 'global'], installation: 'npm', images: true, nativeCompact: false, automaticUpdates: true },
} as const

export const CODEBUDDY_CONFIG_FILES: CodingAgentConfigFileTemplate[] = [{ key: 'mcp', path: join('coding-agent', 'native', 'codebuddy', 'mcp.json'), scopedPath: 'mcp.json', language: 'json' }]
