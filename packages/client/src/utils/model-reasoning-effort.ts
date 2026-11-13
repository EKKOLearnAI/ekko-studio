import type { AvailableModelGroup } from '@/api/hermes/system'
import { FALLBACK_REASONING_EFFORTS, lowestReasoningEffort } from '../../../shared/reasoning-effort'

export { lowestReasoningEffort }

export const DEFAULT_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export function agentReasoningEffortOptions<T extends { value: string }>(
  options: T[],
  defaultValue = '',
): T[] {
  return lowestReasoningEffort(options.map(option => option.value))
    ? options.filter(option => option.value !== defaultValue)
    : options
}

export function agentReasoningEffortValue(
  value: string,
  options: { value: string }[],
  defaultValue = '',
): string {
  return value === defaultValue
    ? lowestReasoningEffort(options.map(option => option.value)) || defaultValue
    : value
}

export function modelReasoningEfforts(
  groups: Pick<AvailableModelGroup, 'provider' | 'model_meta'>[],
  provider: string,
  model: string,
  fallback: string[] = FALLBACK_REASONING_EFFORTS,
): string[] {
  const meta = groups.find(group => group.provider === provider)?.model_meta?.[model]
  if (meta?.reasoning === false) return []
  return meta?.reasoning_efforts === undefined ? fallback : meta.reasoning_efforts
}
