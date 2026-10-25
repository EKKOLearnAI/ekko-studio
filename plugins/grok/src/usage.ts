import type { JsonValue } from '@ekko-studio/plugin-sdk'
interface Tokens { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens?: number }
const record = (value: unknown): Record<string, any> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined
function tokens(value: unknown): Tokens | undefined {
  const raw = record(value)
  if (!raw) return
  const nativeCache = ['cache_read_input_tokens', 'cache_creation_input_tokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'].some(key => raw[key] !== undefined)
  const cacheReadTokens = raw.cache_read_input_tokens ?? raw.cacheReadInputTokens ?? raw.input_tokens_details?.cached_tokens ?? raw.prompt_tokens_details?.cached_tokens ?? 0
  const cacheWriteTokens = raw.cache_creation_input_tokens ?? raw.cacheCreationInputTokens ?? 0
  const inputTokens = (raw.input_tokens ?? raw.inputTokens ?? raw.prompt_tokens) + (nativeCache ? cacheReadTokens + cacheWriteTokens : 0)
  const outputTokens = raw.output_tokens ?? raw.outputTokens ?? raw.completion_tokens
  const reasoningTokens = raw.reasoning_tokens ?? raw.reasoningTokens ?? raw.thinkingTokens ?? raw.output_tokens_details?.reasoning_tokens ?? raw.completion_tokens_details?.reasoning_tokens
  if (![inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, ...(reasoningTokens === undefined ? [] : [reasoningTokens])].every(value => Number.isSafeInteger(value) && value >= 0)) return
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, ...(reasoningTokens === undefined ? {} : { reasoningTokens }) }
}
/** Native aggregates already contain response usage. Per-model totals must agree before replacing the aggregate. */
export function grokUsageRows(aggregate: JsonValue | undefined, models: JsonValue | undefined, responses: Map<string, unknown>, fallbackModel?: string): Array<Tokens & { id: string; model: string }> {
  const total = tokens(aggregate), modelRecords = record(models), names = modelRecords ? Object.keys(modelRecords) : []
  const rows = names.flatMap(model => { const value = tokens(modelRecords![model]); return value ? [{ id: `model-${model}`, model, ...value }] : [] })
  const sums = (key: keyof Tokens) => rows.reduce((sum, row) => sum + (row[key] || 0), 0)
  if (total && rows.length === names.length && rows.length && (['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const).every(key => sums(key) === total[key])) {
    if (rows.length === 1 && rows[0].reasoningTokens === undefined && total.reasoningTokens !== undefined) rows[0].reasoningTokens = total.reasoningTokens
    return rows
  }
  const model = names.length === 1 ? names[0] : names.length ? undefined : fallbackModel
  if (!model) return []
  if (total) return [{ id: 'turn', model, ...total }]
  return [...responses.entries()].flatMap(([id, raw]) => { const value = tokens(raw); return value ? [{ id, model, ...value }] : [] })
}
