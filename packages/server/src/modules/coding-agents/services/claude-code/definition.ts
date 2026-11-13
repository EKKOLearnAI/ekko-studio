import type { CodingAgentConfigFileTemplate } from '../../contracts/definition'

export const CLAUDE_CODE_DEFINITION = {
  id: 'claude-code',
  name: 'Claude Code',
  provider: 'Anthropic',
  command: 'claude',
  packageName: '@anthropic-ai/claude-code',
} as const

export const CLAUDE_CODE_CONFIG_FILES: CodingAgentConfigFileTemplate[] = [
  { key: 'settings', path: '~/.claude/settings.json', scopedPath: 'settings.json', language: 'json' },
  { key: 'mcp', path: '~/.claude/mcp.json', scopedPath: 'mcp.json', language: 'json' },
  { key: 'memory', path: '~/.claude/CLAUDE.md', scopedPath: 'CLAUDE.md', language: 'markdown' },
  { key: 'prompt', path: '~/.claude/hermes-rules.md', scopedPath: 'hermes-rules.md', language: 'markdown' },
]
