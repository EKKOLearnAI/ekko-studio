import type { AvailableModelGroup } from '@/api/hermes/system'

export const DEFAULT_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export function agentReasoningEffortOptions<T extends { value: string }>(
  options: T[],
  useHermesDefault: boolean,
  defaultValue = '',
): T[] {
  const none = options.find(option => option.value === 'none')
  if (useHermesDefault || !none) return options
  return [none, ...options.filter(option => option.value !== defaultValue && option.value !== 'none')]
}

export function agentReasoningEffortValue(
  value: string,
  options: { value: string }[],
  defaultValue = '',
): string {
  return value === defaultValue && options[0]?.value === 'none' ? 'none' : value
}

export function modelReasoningEfforts(
  groups: Pick<AvailableModelGroup, 'provider' | 'model_meta'>[],
  provider: string,
  model: string,
  fallback: string[] = DEFAULT_REASONING_EFFORTS,
): string[] {
  const meta = groups.find(group => group.provider === provider)?.model_meta?.[model]
  if (meta?.reasoning === false) return []
  return meta?.reasoning_efforts === undefined ? fallback : meta.reasoning_efforts
}
