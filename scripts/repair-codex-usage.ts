import { DatabaseSync, backup } from 'node:sqlite'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { parseArgs } from 'node:util'

async function main() {
  // No default database, network fetch, migrations or automatic startup backfill.
  const { values } = parseArgs({ options: {
    db: { type: 'string' }, session: { type: 'string' }, 'codex-home': { type: 'string' }, catalog: { type: 'string' },
    apply: { type: 'boolean' }, expect: { type: 'string' }, backup: { type: 'string' },
  } })
  for (const key of ['db', 'codex-home'] as const) {
    if (!values[key] || !isAbsolute(values[key]!)) throw new Error(`--${key} requires an absolute path`)
  }
  if (!values.session) throw new Error('--session is required')
  if (values.apply && (!values.expect || !values.backup || !isAbsolute(values.backup) || existsSync(values.backup))) {
    throw new Error('--apply requires --expect <preview fingerprint> and --backup <new absolute path>')
  }
  // Server modules initialize logging/config on import. Isolate those side effects
  // from the user's running app; the explicit --db remains the only repair target.
  const scratch = mkdtempSync(join(tmpdir(), 'studio-usage-repair-'))
  process.env.HERMES_WEB_UI_HOME = scratch
  const { findRollout } = await import('../packages/server/src/modules/coding-agents/services/runtime/native-model')
  const { readCodexUsageFile } = await import('../packages/server/src/modules/coding-agents/services/runtime/codex-usage')
  const { planCodexUsageRepair } = await import('../packages/server/src/modules/coding-agents/services/runtime/codex-usage-repair')
  const { applyUsageRepair, usageRepairSnapshot, usageRepairHash, estimateUsageCost } = await import('../packages/server/src/modules/studio/public/usage')
  const { estimateCatalogUsageCost } = await import('../packages/server/src/modules/studio/services/usage/catalog-pricing')
  const db = new DatabaseSync(values.db!, { readOnly: !values.apply })
  try {
    db.exec('PRAGMA busy_timeout=5000')
    const session = db.prepare('SELECT agent, agent_mode, agent_native_session_id FROM sessions WHERE id = ?').get(values.session)
    if (session?.agent !== 'codex' || session.agent_mode !== 'global' || !/^[a-zA-Z0-9-]+$/.test(String(session.agent_native_session_id))) {
      throw new Error('Expected an identified global Codex session')
    }
    const nativeId = String(session.agent_native_session_id)
    const file = await findRollout(join(values['codex-home']!, 'sessions'), nativeId)
    const turns = file && await readCodexUsageFile(file, nativeId)
    if (!turns) throw new Error('Verified native request ledger unavailable')
    const before = usageRepairSnapshot(db, values.session)
    const data = values.catalog ? JSON.parse(readFileSync(values.catalog, 'utf8')) : undefined
    const catalog = data ? { data, version: usageRepairHash(data), fetchedAt: 0 } : undefined
    const plan = planCodexUsageRepair(before, turns, (row, old) => {
      // A saved manual contract is safe to reuse. Context-tier catalog snapshots
      // from an aggregate are not: reselect the tier using each actual request.
      const saved = old.cost_pricing && JSON.parse(String(old.cost_pricing))
      if (saved?.source === 'manual' && saved.rates?.provider === row.provider && saved.rates?.model === row.model) {
        const cost = estimateUsageCost(row.usage, saved.rates)
        return cost && { ...cost, costPricing: saved }
      }
      const setting = db.prepare('SELECT rates FROM usage_pricing WHERE profile = ?').get(old.profile)
      const manual = setting && JSON.parse(String(setting.rates)).find((rate: any) => rate.provider === row.provider && rate.model === row.model)
      if (manual) {
        const cost = estimateUsageCost(row.usage, manual)
        return cost && { ...cost, costPricing: { source: 'manual', rates: manual } }
      }
      return estimateCatalogUsageCost(catalog, row.provider || '', row.model, row.usage, 'model_call', 1)
    })
    if (values.apply) {
      if (values.expect !== plan.fingerprint) throw new Error('Preview fingerprint changed; review a fresh preview')
      await backup(db, values.backup!)
      applyUsageRepair(db, values.session, before, plan.replacements)
    }
    const replaced = new Set(plan.replacements.map(row => row.oldId))
    const after = [...before.filter(row => !replaced.has(row.id)), ...plan.replacements.flatMap(row => row.rows)]
    const totals = (rows: typeof before) => ({
      inputTokens: rows.reduce((n, r) => n + Number(r.input_tokens) + Number(r.cache_read_tokens) + Number(r.cache_write_tokens), 0),
      outputTokens: rows.reduce((n, r) => n + Number(r.output_tokens), 0),
      costUsd: rows.every(row => row.cost_usd != null) ? rows.reduce((n, r) => n + Number(r.cost_usd), 0) : null,
      unknownCosts: rows.filter(row => row.cost_usd == null).length,
    })
    const report = JSON.stringify({ session: values.session, applied: !!values.apply, fingerprint: plan.fingerprint,
      replacedRows: plan.replacements.length, requestRows: plan.replacements.reduce((n, r) => n + r.rows.length, 0),
      before: totals(before), after: totals(after), skipped: plan.skipped }, null, 2)
    await new Promise<void>((resolve, reject) => process.stdout.write(`${report}\n`, error => error ? reject(error) : resolve()))
  } finally { db.close(); rmSync(scratch, { recursive: true, force: true }) }
}
// Shared server logging owns a periodic timer; this standalone command is done.
main().then(() => process.exit(0), error => { console.error(String(error)); process.exit(1) })
