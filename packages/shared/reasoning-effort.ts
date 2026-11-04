export interface ReasoningModelMetadata {
  reasoning?: boolean
  reasoning_efforts?: readonly string[]
}

export const FALLBACK_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const ACTIVE_EFFORTS = ['minimal', ...FALLBACK_REASONING_EFFORTS, 'ultra', 'enabled']

/** An unset selection means the least supported thinking level, never "off". */
export function lowestReasoningEffort(efforts: readonly string[] = FALLBACK_REASONING_EFFORTS): string | undefined {
  return ACTIVE_EFFORTS.find(effort => efforts.includes(effort))
}

export function resolveModelReasoningEffort(value: string | null | undefined, metadata?: ReasoningModelMetadata): string | undefined {
  if (metadata?.reasoning === false) return undefined
  const selected = value?.trim()
  const supported = metadata?.reasoning_efforts
  if (selected && selected !== 'default' && (supported === undefined || supported.includes(selected))) return selected
  return lowestReasoningEffort(supported)
}
