// Keep every Agent picker in the same order as single chat.
export const AGENT_OPTIONS = [
  { label: 'Hermes', value: 'hermes' },
  { label: 'Ekko', value: 'ekko-agent' },
  { label: 'Claude', value: 'claude-code' },
  { label: 'Codex', value: 'codex' },
  { label: 'Pi', value: 'pi' },
  { label: 'Grok', value: 'grok' },
  { label: 'OpenCode', value: 'opencode' },
  { label: 'DeepSeek Harness', value: 'dsh' },
  { label: 'Cursor', value: 'cursor' },
  { label: 'Antigravity', value: 'antigravity' },
] as const

export const GROUP_AGENT_OPTIONS = AGENT_OPTIONS.map(option => ({
  label: option.label,
  value: option.value === 'ekko-agent' ? 'ekko' as const
    : option.value === 'claude-code' ? 'claude' as const
      : option.value,
}))
