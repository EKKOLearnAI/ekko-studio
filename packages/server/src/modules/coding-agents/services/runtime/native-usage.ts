import { createHash } from 'crypto'
import { normalizeTokenUsage, normalizeUsageCost, type UsageCost, type NormalizedTokenUsage } from '../../../studio/public/usage'

export interface NativeUsageRow {
  id: string
  /** Stable native request identity, independent of a Studio process or replay. */
  ledgerId?: string
  createdAt?: number
  model: string
  provider?: string
  usage: NormalizedTokenUsage
  apiCalls?: number
  apiDuration?: number
  scope: 'run' | 'model_call'
  cost?: UsageCost
}

const tokenKeys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const

function apiDurationSeconds(value: any): number | undefined {
  const milliseconds = value?.duration_api_ms
  return typeof milliseconds === 'number' && Number.isFinite(milliseconds) && milliseconds > 0
    ? milliseconds / 1000 : undefined
}

function measured(value: unknown): NormalizedTokenUsage | undefined {
  const usage = normalizeTokenUsage(value)
  return usage.isEstimated ? undefined : usage
}

function modelName(value: unknown): string {
  return typeof value === 'string' && value.trim() !== 'unknown' ? value.trim() : ''
}

function sameTotals(rows: NativeUsageRow[], usage: NormalizedTokenUsage): boolean {
  return tokenKeys.every(key => rows.reduce((sum, row) => sum + row.usage[key], 0) === usage[key])
}

/** Per-turn native accounting. Never mixes a session total with a turn total. */
export class NativeTurnUsage {
  model = ''
  provider?: string
  codexRows?: NativeUsageRow[]
  codexResumed = false
  private readonly messages = new Map<string, NativeUsageRow>()
  private claudeMessage?: { id: string; model: string; usage: Record<string, unknown> }
  private readonly claudeModels = new Set<string>()
  private modelUsage?: Record<string, any>
  private pendingUsage?: unknown
  private pendingCost?: UsageCost
  private apiDuration?: number
  private readonly grokResponses = new Map<string, unknown>()

  observeClaude(event: any) {
    if (event.type === 'system' && event.subtype === 'init') {
      this.model = modelName(event.model)
      this.provider = modelName(event.provider) || this.provider
    }
    const message = event.type === 'assistant' ? event.message : undefined
    if (message && !event.isApiErrorMessage) {
      const model = modelName(message.model)
      if (model) { this.claudeModels.add(model); this.model = model }
      const usage = measured(message.usage)
      // Some CLIs emit placeholder zero-usage top-level messages before the
      // authoritative message_delta. Do not overwrite a completed stream row.
      if (message.id && usage && !this.messages.has(message.id)) {
        this.messages.set(message.id, { id: message.id, model, provider: this.provider, usage, apiCalls: 1, scope: 'model_call' })
      }
    }
    if (event.type === 'stream_event') {
      const frame = event.event || {}
      if (frame.type === 'message_start') {
        const model = modelName(frame.message?.model)
        if (model) { this.claudeModels.add(model); this.model = model }
        this.claudeMessage = { id: String(frame.message?.id || ''), model, usage: { ...frame.message?.usage } }
      } else if (frame.type === 'message_delta' && this.claudeMessage) {
        Object.assign(this.claudeMessage.usage, frame.usage)
        const { id, model, usage: raw } = this.claudeMessage
        const usage = measured(raw)
        if (id && usage) this.messages.set(id, { id, model, provider: this.provider, usage, apiCalls: 1, scope: 'model_call' })
      } else if (frame.type === 'message_stop' && this.claudeMessage) {
        const { id, model, usage: raw } = this.claudeMessage
        const usage = measured(raw)
        if (id && usage) this.messages.set(id, { id, model, provider: this.provider, usage, apiCalls: 1, scope: 'model_call' })
        this.claudeMessage = undefined
      }
    }
    if (event.type === 'result') {
      this.apiDuration = apiDurationSeconds(event)
      this.pendingUsage = event.usage
      this.modelUsage = event.modelUsage
      this.pendingCost = normalizeUsageCost(event, 'estimated')
    }
  }

  observePi(event: any): NativeUsageRow | undefined {
    const message = event.type === 'message_end' ? event.message : undefined
    if (message?.role !== 'assistant') return
    const raw = message.usage
    const usage = measured(raw && {
      inputTokens: raw.input, outputTokens: raw.output,
      cacheReadTokens: raw.cacheRead, cacheWriteTokens: raw.cacheWrite,
      reasoningTokens: raw.reasoning,
    })
    if (!usage) return
    if (['error', 'aborted'].includes(message.stopReason) && tokenKeys.every(key => usage[key] === 0)) return
    // Pi repeats the same message in turn_end and agent_end. Only message_end
    // owns accounting; the native timestamp/content identify duplicate delivery.
    const id = String(message.id || createHash('sha256').update(JSON.stringify(message)).digest('hex'))
    if (this.messages.has(id)) return
    const model = modelName(message.model)
    const row: NativeUsageRow = { id, model, provider: modelName(message.provider), usage, apiCalls: 1, scope: 'model_call', cost: normalizeUsageCost(raw, 'estimated') }
    this.messages.set(id, row)
    this.model = model
    return row
  }

  observeGrok(event: { type: string; usage?: unknown; modelUsage?: unknown; messageId?: string }) {
    if (event.type === 'usage' && event.usage) {
      this.grokResponses.set(event.messageId || `response-${this.grokResponses.size}`, event.usage)
    }
    if (event.type === 'end' || event.type === 'error') {
      if (event.usage) this.pendingUsage = event.usage
      this.pendingCost = normalizeUsageCost(event, 'estimated')
      if (event.modelUsage && typeof event.modelUsage === 'object' && !Array.isArray(event.modelUsage)) {
        this.modelUsage = event.modelUsage as Record<string, any>
        const models = Object.keys(this.modelUsage)
        if (models.length === 1) this.model = modelName(models[0])
      }
    }
  }

  rows(agent: string, finalUsage: unknown, fallbackModel = ''): NativeUsageRow[] {
    const rows = this.buildRows(agent, finalUsage, fallbackModel)
    const apiDuration = this.apiDuration ?? apiDurationSeconds(finalUsage)
    // A native turn total must be counted once, never once per model.
    if (rows.length === 1 && apiDuration != null) rows[0] = { ...rows[0], apiDuration }
    return rows
  }

  private buildRows(agent: string, finalUsage: unknown, fallbackModel = ''): NativeUsageRow[] {
    if (agent === 'pi') return [...this.messages.values()]
    if (agent === 'codex') {
      if (this.codexRows) return this.codexRows
      // exec resume may report the thread total. Without a native per-turn
      // ledger it is not safe to charge that total again.
      if (this.codexResumed) return []
      const raw = finalUsage as any
      const usage = normalizeTokenUsage(raw && {
        ...raw,
        cache_write_tokens: raw.cache_write_input_tokens ?? raw.cache_write_tokens,
        reasoning_tokens: raw.reasoning_output_tokens ?? raw.reasoning_tokens,
      }, {}, { inputIncludesCache: true })
      return usage.isEstimated ? [] : [{ id: 'turn', model: this.model || fallbackModel, provider: this.provider, usage, scope: 'run', cost: normalizeUsageCost(raw, 'estimated') }]
    }

    let usage = measured(this.pendingUsage ?? finalUsage)
    let observedCost: UsageCost | undefined
    if (agent === 'grok' && !this.pendingUsage && this.grokResponses.size) {
      // A crash/error may omit the final aggregate. Per-response boundaries
      // are additive, whereas end.usage is already the aggregate.
      const observed = [...this.grokResponses.values()].map(measured).filter((row): row is NormalizedTokenUsage => !!row)
      if (observed.length) usage = Object.fromEntries(tokenKeys.map(key => [key, observed.reduce((sum, row) => sum + row[key], 0)])) as unknown as NormalizedTokenUsage
      const costs = [...this.grokResponses.values()].map(value => normalizeUsageCost(value, 'estimated'))
      if (observed.length === costs.length && costs.every(cost => cost !== undefined)) {
        observedCost = { costUsd: costs.reduce((sum, cost) => sum + cost!.costUsd, 0), costSource: 'estimated' }
      }
    }
    if (!usage) return agent === 'claude-code' ? [...this.messages.values()] : []
    const cost = this.pendingCost || (agent === 'grok' && !this.pendingUsage && this.grokResponses.size
      ? observedCost : normalizeUsageCost(finalUsage, 'estimated'))
    const hasModelCost = Object.values(this.modelUsage || {}).some(row => normalizeUsageCost(row, 'estimated'))
    if (agent === 'grok' && !cost && !hasModelCost && this.grokResponses.size) {
      const names = Object.keys(this.modelUsage || {})
      const model = names.length === 1 ? modelName(names[0]) : names.length > 1 ? '' : this.model || fallbackModel
      const calls = [...this.grokResponses].map(([id, raw]) => {
        const tokens = measured(raw)
        return tokens ? { id, model, provider: this.provider, usage: tokens, apiCalls: 1,
          scope: 'model_call' as const, cost: normalizeUsageCost(raw, 'estimated') } : undefined
      }).filter((row): row is NonNullable<typeof row> => !!row)
      if (calls.length === this.grokResponses.size && sameTotals(calls, usage)) return calls
    }
    if (agent === 'claude-code' && !cost && !hasModelCost && this.messages.size && sameTotals([...this.messages.values()], usage)) {
      return [...this.messages.values()]
    }

    const models = Object.entries(this.modelUsage || {}).map(([model, raw]) => {
      if (!raw || typeof raw !== 'object') return undefined
      const normalized = measured({
        inputTokens: raw.inputTokens, outputTokens: raw.outputTokens,
        cacheReadTokens: raw.cacheReadInputTokens,
        cacheWriteTokens: raw.cacheCreationInputTokens,
        reasoningTokens: raw.reasoningTokens ?? raw.thinkingTokens,
      })
      const messages = [...this.messages.values()].filter(row => row.model === modelName(model))
      const apiCalls = Number.isInteger(raw.modelCalls) && raw.modelCalls >= 0
        ? raw.modelCalls : normalized && messages.length && sameTotals(messages, normalized) ? messages.length : undefined
      return normalized ? {
        id: `model:${model}`, model: modelName(model), usage: normalized, scope: 'run' as const,
        cost: normalizeUsageCost(raw, 'estimated'),
        ...(apiCalls !== undefined ? { apiCalls } : {}),
      } : undefined
    }).filter((row): row is NonNullable<typeof row> => !!row)
    // Grok's per-model summaries omit reasoning in some versions. With one
    // model attribution is unambiguous; with several keep an aggregate fallback.
    if (models.length === 1 && !models[0].usage.reasoningTokens) models[0].usage.reasoningTokens = usage.reasoningTokens
    if (models.length && sameTotals(models, usage) && (!cost || models.every(row => row.cost) && Math.abs(models.reduce((sum, row) => sum + row.cost!.costUsd, 0) - cost.costUsd) < 1e-9)) return models

    const names = new Set([...models.map(row => row.model), ...this.claudeModels].filter(Boolean))
    const model = names.size === 1 ? [...names][0] : names.size > 1 ? '' : this.model || fallbackModel
    const modelCosts = Object.values(this.modelUsage || {}).map(row => normalizeUsageCost(row, 'estimated'))
    const aggregateCost = modelCosts.length && modelCosts.every(value => value !== undefined)
      ? { costUsd: modelCosts.reduce((sum, value) => sum + value!.costUsd, 0), costSource: 'estimated' as const }
      : undefined
    // Claude modelUsage can include auxiliary work absent from result.usage.
    // Keep the authoritative turn tokens, while retaining the complete run's bill once.
    return [{ id: 'turn', model, usage, scope: 'run', cost: cost || aggregateCost,
      ...(this.messages.size && sameTotals([...this.messages.values()], usage) ? { apiCalls: this.messages.size } : {}),
    }]
  }
}
