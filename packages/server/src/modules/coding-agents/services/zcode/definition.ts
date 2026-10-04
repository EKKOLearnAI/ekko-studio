import type { CodingAgentConfigFileTemplate } from '../../contracts/definition'

export const ZCODE_DEFINITION = {
  id: 'zcode',
  name: 'ZCode',
  provider: 'Z.ai',
  command: 'zcode',
  packageName: '',
  docsUrl: 'https://github.com/zai-org/ZCode',
  acpArgs: [],
  capabilities: { modes: ['scoped', 'global'], installation: 'manual', images: true, nativeCompact: false, automaticUpdates: false },
} as const

export const ZCODE_CONFIG_FILES: CodingAgentConfigFileTemplate[] = []
