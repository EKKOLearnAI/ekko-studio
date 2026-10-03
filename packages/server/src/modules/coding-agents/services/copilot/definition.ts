import type { CodingAgentConfigFileTemplate } from '../../contracts/definition'
import { join } from 'node:path'

export const COPILOT_DEFINITION = {
  id: 'copilot',
  name: 'GitHub Copilot',
  provider: 'GitHub',
  command: 'copilot',
  packageName: '@github/copilot',
  docsUrl: 'https://docs.github.com/en/copilot/get-started/cli-quickstart',
  acpArgs: ['--acp'],
  capabilities: { modes: ['scoped', 'global'], installation: 'npm', images: false, nativeCompact: false, automaticUpdates: true },
} as const

export const COPILOT_CONFIG_FILES: CodingAgentConfigFileTemplate[] = [{ key: 'mcp', path: join('coding-agent', 'native', 'copilot', 'mcp.json'), scopedPath: 'mcp.json', language: 'json' }]
