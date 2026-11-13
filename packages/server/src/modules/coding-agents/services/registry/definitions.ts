import type { CodingAgentDefinition, CodingAgentConfigFileTemplate } from '../../contracts/definition'
import type { CodingAgentRuntime } from '../../../studio/contracts/agents/runtime'
import { QWEN_CONFIG_FILES } from '../qwen/definition'
import { KIMI_CONFIG_FILES } from '../kimi/definition'
import { CODEBUDDY_CONFIG_FILES } from '../codebuddy/definition'
import { QODER_CONFIG_FILES } from '../qoder/definition'
import { COPILOT_CONFIG_FILES } from '../copilot/definition'
import { ZCODE_CONFIG_FILES } from '../zcode/definition'
import { ANTIGRAVITY_DEFINITION, ANTIGRAVITY_CONFIG_FILES } from '../antigravity/definition'
import { CLAUDE_CODE_DEFINITION, CLAUDE_CODE_CONFIG_FILES } from '../claude-code/definition'
import { CODEX_DEFINITION, CODEX_CONFIG_FILES } from '../codex/definition'
import { PI_DEFINITION, PI_CONFIG_FILES } from '../pi/definition'
import { GROK_CODING_AGENT_DEFINITION, GROK_CODING_AGENT_CONFIG_FILES } from '../grok/definition'
import { OPENCODE_DEFINITION, OPENCODE_CONFIG_FILES } from '../opencode/definition'
import { DSH_DEFINITION, DSH_CONFIG_FILES } from '../dsh/definition'
import { CURSOR_DEFINITION, CURSOR_CONFIG_FILES } from '../cursor/definition'
import { NATIVE_CODING_AGENTS } from './native-agents'

export const TOOL_DEFINITIONS: CodingAgentDefinition[] = [
  ...NATIVE_CODING_AGENTS.map(({ acpArgs, docsUrl, ...agent }) => agent),
  ANTIGRAVITY_DEFINITION,
  CLAUDE_CODE_DEFINITION,
  CODEX_DEFINITION,
  PI_DEFINITION,
  GROK_CODING_AGENT_DEFINITION,
  OPENCODE_DEFINITION,
  DSH_DEFINITION,
  CURSOR_DEFINITION,
]

export const CONFIG_FILE_DEFINITIONS: Record<CodingAgentRuntime, CodingAgentConfigFileTemplate[]> = {
  qwen: QWEN_CONFIG_FILES,
  kimi: KIMI_CONFIG_FILES,
  codebuddy: CODEBUDDY_CONFIG_FILES,
  qoder: QODER_CONFIG_FILES,
  copilot: COPILOT_CONFIG_FILES,
  zcode: ZCODE_CONFIG_FILES,
  antigravity: ANTIGRAVITY_CONFIG_FILES,
  'claude-code': CLAUDE_CODE_CONFIG_FILES,
  codex: CODEX_CONFIG_FILES,
  pi: PI_CONFIG_FILES,
  grok: GROK_CODING_AGENT_CONFIG_FILES,
  opencode: OPENCODE_CONFIG_FILES,
  dsh: DSH_CONFIG_FILES,
  cursor: CURSOR_CONFIG_FILES,
}
