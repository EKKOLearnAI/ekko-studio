import type { CodingAgentConfigFileTemplate } from '../../contracts/definition'
import { join } from 'node:path'

export const KIMI_DEFINITION = {
  id: 'kimi',
  name: 'Kimi Code',
  provider: 'Moonshot AI',
  command: 'kimi',
  packageName: '@moonshot-ai/kimi-code',
  docsUrl: 'https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html',
  acpArgs: ['acp'],
  capabilities: { modes: ['scoped', 'global'], installation: 'npm', images: false, nativeCompact: false, automaticUpdates: true },
} as const

export const KIMI_CONFIG_FILES: CodingAgentConfigFileTemplate[] = [{ key: 'mcp', path: join('coding-agent', 'native', 'kimi', 'mcp.json'), scopedPath: 'mcp.json', language: 'json' }]
