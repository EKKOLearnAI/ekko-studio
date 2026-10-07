import { usageRepairHash, type RepairUsageRow, type UsageCost } from '../../../studio/public/usage'
import type { CodexUsageTurn } from './usage'
import type { NativeUsageRow } from '../runtime/native-usage'

/** Only the legacy Codex aggregate format has a verified invocation timestamp. */
export function planCodexUsageRepair(before: RepairUsageRow[], turns: CodexUsageTurn[], price: (row: NativeUsageRow, old: RepairUsageRow) => UsageCost | undefined) {
  const skipped: Array<{ id: number; reason: string }> = []
  const replacements: Array<{ oldId: number; rows: RepairUsageRow[] }> = []
  const usedTurns = new Set<string>()
  const existingIds = new Set(before.map(row => row.run_id))
  for (const old of before) {
    if (old.agent !== 'codex' || old.source !== 'coding_agent' || old.run_id.startsWith('codex:')) continue
    const match = /^resp_(\d+):turn$/.exec(old.run_id)
    const selected = match && turns.filter(turn => turn.startedAt >= Number(match[1]) && turn.startedAt <= old.created_at)
    if (!selected || selected.length !== 1 || !selected[0].complete || !selected[0].endedAt
      || selected[0].endedAt > old.created_at || usedTurns.has(selected[0].id)) {
      skipped.push({ id: old.id, reason: 'No unique completed native turn with a complete request ledger' }); continue
    }
    if (old.cost_source === 'reported') {
      skipped.push({ id: old.id, reason: 'Preserve authoritative reported cost; reconcile separately' }); continue
    }
    const turn = selected[0]
    if (turn.rows.some(row => !row.ledgerId || !row.createdAt || existingIds.has(row.ledgerId))) {
      skipped.push({ id: old.id, reason: 'Missing native request identity/time or request already recorded' }); continue
    }
    const rows = turn.rows.map(row => {
      const cost = row.cost || price(row, old)
      return { ...old, run_id: row.ledgerId!, usage_scope: 'model_call', api_calls: 1, api_duration: null,
        input_tokens: row.usage.inputTokens, output_tokens: row.usage.outputTokens,
        cache_read_tokens: row.usage.cacheReadTokens, cache_write_tokens: row.usage.cacheWriteTokens,
        reasoning_tokens: row.usage.reasoningTokens, model: row.model, provider: row.provider || '',
        is_estimated: 0, created_at: row.createdAt!, cost_usd: cost?.costUsd ?? null,
        cost_source: cost?.costSource || 'unknown', cost_pricing: cost?.costPricing ? JSON.stringify(cost.costPricing) : null,
      }
    })
    usedTurns.add(turn.id)
    for (const row of rows) existingIds.add(row.run_id)
    replacements.push({ oldId: old.id, rows })
  }
  return { fingerprint: usageRepairHash({ before, replacements }), replacements, skipped }
}
