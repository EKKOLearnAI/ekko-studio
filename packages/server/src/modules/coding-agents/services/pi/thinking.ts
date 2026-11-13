export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

const PI_THINKING_LEVELS = new Set<PiThinkingLevel>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

/** Translate Studio's reasoning-effort vocabulary to Pi RPC's thinking levels. */
export function normalizePiThinkingLevel(value: unknown): PiThinkingLevel | undefined {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized || normalized === 'default') return undefined
  if (normalized === 'none') return 'off'
  if (normalized === 'ultra') return 'max'
  return PI_THINKING_LEVELS.has(normalized as PiThinkingLevel)
    ? normalized as PiThinkingLevel
    : undefined
}

/** An explicit non-off Studio choice can opt an uncatalogued custom model into Pi thinking. */
export function piModelSupportsThinking(detected: boolean, reasoningEffort: unknown): boolean {
  const level = normalizePiThinkingLevel(reasoningEffort)
  return detected || (level != null && level !== 'off')
}

/** Pi requires explicit opt-in mappings before xhigh and max become selectable. */
export const PI_EXTENDED_THINKING_LEVEL_MAP = {
  xhigh: 'xhigh',
  max: 'max',
} as const
