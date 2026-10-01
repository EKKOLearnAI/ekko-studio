import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { normalizeUsageCost } from '../../../studio/public/usage'
import type { NativeUsageRow } from './native-usage'
import { findRollout, readCodexTurnModel } from './native-model'

export interface CodexUsageTurn {
  id: string
  startedAt: number
  endedAt?: number
  rows: NativeUsageRow[]
  /** False when a record is malformed or the per-request ledger is incomplete. */
  complete: boolean
}

const keys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const

/** Codex input includes cache; the Studio ledger uses disjoint buckets. */
function tokens(raw: any): NativeUsageRow['usage'] | undefined {
  if (!raw || typeof raw !== 'object') return
  const values = [raw.input_tokens, raw.output_tokens, raw.cached_input_tokens ?? 0,
    raw.cache_write_input_tokens ?? 0, raw.reasoning_output_tokens ?? 0]
  if (values.some(value => !Number.isSafeInteger(value) || value < 0)) return
  const [input, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens] = values
  if (cacheReadTokens + cacheWriteTokens > input || reasoningTokens > outputTokens) return
  return { inputTokens: input - cacheReadTokens - cacheWriteTokens, outputTokens,
    cacheReadTokens, cacheWriteTokens, reasoningTokens }
}

/** Parse only usage/identity envelopes; message bodies never enter the accounting model. */
export async function readCodexUsageFile(file: string, sessionId: string): Promise<CodexUsageTurn[] | undefined> {
  const stream = createReadStream(file, { encoding: 'utf8', signal: AbortSignal.timeout(2_000) })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  const turns = new Map<string, CodexUsageTurn & {
    calls: Map<string, NativeUsageRow>; legacy: Map<string, NativeUsageRow>
    hasLedger: boolean; invalid: boolean; legacyInvalid: boolean; total?: NativeUsageRow['usage']
  }>()
  let matched = false
  let provider = ''
  let model = ''
  let current: ReturnType<typeof turns.get>
  let previousTotal = ''
  try {
    for await (const line of lines) {
      let event: any
      try { event = JSON.parse(line) } catch { if (current) current.invalid = true; continue }
      const p = event.payload || {}
      if (event.type === 'session_meta') {
        if (matched || p.id !== sessionId) return
        matched = true
        provider = typeof p.model_provider === 'string' ? p.model_provider : ''
      }
      if (!matched) continue
      const time = Date.parse(event.timestamp)
      if (event.type === 'event_msg' && p.type === 'task_started') {
        if (typeof p.turn_id !== 'string' || !Number.isFinite(time) || turns.has(p.turn_id)) return
        current = { id: p.turn_id, startedAt: time, rows: [], complete: false,
          calls: new Map(), legacy: new Map(), hasLedger: false, invalid: false, legacyInvalid: false }
        turns.set(p.turn_id, current)
        model = ''
      }
      if (event.type === 'turn_context' && typeof p.model === 'string') model = p.model.trim()
      if (!current) continue
      if (event.type === 'event_msg' && p.type === 'task_complete') current.endedAt = time
      if (event.type === 'token_usage_record') {
        // A child thread is a separate accounting owner, even when it names this root turn.
        if (p.thread_id !== sessionId || p.turn_id !== current.id) continue
        current.hasLedger = true
        const usage = tokens(p.usage)
        if (!usage || typeof p.response_id !== 'string' || !p.response_id) { current.invalid = true; continue }
        const id = `codex:${sessionId}:${p.response_id}`
        const row: NativeUsageRow = { id, ledgerId: id, model: typeof p.model === 'string' ? p.model : model,
          provider, usage, scope: 'model_call', apiCalls: 1, cost: normalizeUsageCost(p, 'estimated'),
          ...(Number.isFinite(time) ? { createdAt: time } : {}) }
        const previous = current.calls.get(id)
        if (previous) {
          if (keys.some(key => previous.usage[key] !== usage[key]) || previous.model !== row.model) current.invalid = true
          continue
        }
        current.calls.set(id, row)
        if (p.turn_token_usage) {
          current.total = tokens(p.turn_token_usage)
          if (!current.total) current.invalid = true
        }
      }
      if (event.type === 'event_msg' && p.type === 'token_count' && p.info) {
        const total = JSON.stringify(p.info.total_token_usage)
        // Repeated context/limit notifications are not another API request.
        if (total !== previousTotal) {
          const usage = tokens(p.info.last_token_usage)
          if (usage) {
            const id = `codex:${sessionId}:${current.id}:${createHash('sha256').update(total || '').digest('hex')}`
            current.legacy.set(id, { id, ledgerId: id, model, provider, usage, scope: 'model_call', apiCalls: 1,
              ...(Number.isFinite(time) ? { createdAt: time } : {}) })
          } else current.legacyInvalid = true
        }
        previousTotal = total
      }
    }
  } catch { return } finally { lines.close(); stream.destroy() }
  if (!matched) return
  return [...turns.values()].map(turn => {
    const rows = [...(turn.hasLedger ? turn.calls : turn.legacy).values()]
    const consistent = !turn.total || keys.every(key => rows.reduce((sum, row) => sum + row.usage[key], 0) === turn.total![key])
    return { id: turn.id, startedAt: turn.startedAt, endedAt: turn.endedAt, rows,
      complete: !turn.invalid && (turn.hasLedger || !turn.legacyInvalid) && consistent && rows.length > 0 }
  })
}

export async function readCodexTurnUsage(home: string, sessionId: string, startedAt: number, endedAt = Date.now()): Promise<NativeUsageRow[] | undefined> {
  if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) return
  const file = await findRollout(join(home, 'sessions'), sessionId)
  if (!file) return
  const turns = await readCodexUsageFile(file, sessionId)
  const selected = turns?.filter(turn => turn.startedAt >= startedAt && turn.startedAt <= endedAt)
  // An ambiguous or incomplete log must not fall back to a cumulative CLI total.
  if (!selected?.length) return
  if (selected.length !== 1) return []
  if (selected.some(turn => !turn.complete)) return []
  return selected.flatMap(turn => turn.rows)
}

/** Bound discovery as well as file reads so accounting cannot hold a chat open. */
export async function readCodexTurnAccounting(home: string, sessionId: string, startedAt: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.all([readCodexTurnModel(home, sessionId, startedAt), readCodexTurnUsage(home, sessionId, startedAt)]),
      new Promise<[undefined, undefined]>(resolve => {
        timer = setTimeout(() => resolve([undefined, undefined]), 2_000)
        timer.unref()
      }),
    ])
  } finally { if (timer) clearTimeout(timer) }
}
