import type { CodingAgentRuntime } from '../../studio/contracts/agents/runtime'

export interface CodingAgentDefinition {
  id: CodingAgentRuntime
  name: string
  provider: string
  command: string
  packageName: string
  capabilities?: { modes: readonly string[]; installation: string; images: boolean; nativeCompact: boolean; automaticUpdates: boolean }
}

export interface CodingAgentConfigFileDefinition {
  key: string
  path: string
  absolutePath: string
  language: string
}

export type CodingAgentConfigFileTemplate = Omit<CodingAgentConfigFileDefinition, 'absolutePath'> & { scopedPath: string }
