import type { CodingAgentConfigFileTemplate } from '../../contracts/definition'
import { join } from 'node:path'

export const QODER_DEFINITION = {
  id: 'qoder',
  name: 'Qoder',
  provider: 'Qoder',
  command: 'qoder',
  packageName: '@qoder-ai/qodercli',
  docsUrl: 'https://docs.qoder.com/cli/installation',
  acpArgs: ['--acp'],
  capabilities: { modes: ['global'], installation: 'npm', images: true, nativeCompact: false, automaticUpdates: true },
} as const

export const QODER_CONFIG_FILES: CodingAgentConfigFileTemplate[] = [{ key: 'mcp', path: join('coding-agent', 'native', 'qoder', 'mcp.json'), scopedPath: 'mcp.json', language: 'json' }]
