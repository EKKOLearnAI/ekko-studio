# Usage cost accounting

`session_usage` stores nullable `cost_usd` and `cost_source` (`reported`,
`estimated`, or `unknown`) alongside each deduplicated call/run. Missing costs
stay NULL, including pre-migration rows. Explicit provider USD zero is known
free usage; zero from an unpriced native CLI catalog is not proof of free usage.

Studio keeps `total_cost` and daily `cost` numeric for older clients. New
`cost_coverage` counts reported, estimated and unknown records. Clients show
"Not recorded" for wholly unknown usage and label partial totals. Empty days
still show zero. A provider report is not a reconciled account invoice.

The Usage page's Model pricing dialog stores Profile-scoped USD prices per
million ordinary input, output, cache read and cache write tokens. Provider and
model IDs must match exactly; no cross-provider model-name fallback is used.
Native runs without provider metadata use `global`. Missing cache rates leave
cached usage unpriced. Reasoning is already included in output tokens. Reported
cost wins over configured rates, which win over models.dev rates. A partial
manual price does not borrow missing rates from the catalog. Prices apply at
recording time, so price edits do not reprice historical rows or duplicate run IDs.

## Shared models.dev catalog

Studio downloads `https://models.dev/api.json` once on each server startup, in
the background, to `config.appHome/models/models.dev.json`. This is Web UI
state (default `~/.hermes-web-ui`), separate from Hermes Agent's own cache.
Context matching, output limits, model capabilities and cost estimates share
the same in-memory snapshot, loaded from disk before the download completes.
Manual context overrides and existing configuration remain higher priority.

Downloads have a 15-second timeout and a 20 MiB limit. JSON/provider/model
validation runs before atomic replacement; HTTP, network, malformed response
and disk errors preserve the last good snapshot. Concurrent callers share one
download; cold-start cost recording can retry after a five-minute cooldown.
No cache plus no network preserves the existing context fallback and unknown
costs. The first successful download fills only new records awaiting that
download, without duplicating tokens or resurrecting deleted rows.

Automatic pricing requires the exact provider/model pair (or a known provider
alias). Unknown custom relays do not inherit official model prices. Catalog
prices are reference estimates, not a relay invoice, subscription charge or
account-specific discount; configure custom rates when appropriate. Missing
rates for used token categories leave cost unknown. Context tiers include cache
tokens; a run aggregate above a tier threshold stays unknown unless it represents
a single API call. Ekko subtask totals use run scope; an explicit call count takes
precedence over scope when determining whether tier pricing is safe. Explicit
tiers take precedence over legacy `context_over_200k`.
Separate reasoning rates replace the reasoning portion of the output charge.
App Live Activity token totals include these disjoint Ekko subtask records along
with individual model calls, while excluding other run summaries and estimates.

Studio's built-in `glm` points to the domestic GLM Coding Plan endpoint and maps
to `zhipuai-coding-plan` for both pricing and context limits. It does not borrow
`zai`/`zhipuai` metered API prices. A catalog plan rate of zero is retained as an
estimate; it does not account for the subscription fee or imply a free plan.
When a Coding Plan catalog omits an older model such as GLM-4.5, context/output
limits and capabilities may fall back to that vendor's ordinary API catalog
(`zhipuai-coding-plan` → `zhipuai`, `zai-coding-plan` → `zai`). Existing plan
specifications and manual overrides take priority. This metadata fallback does
not make the model available on the endpoint or supply metered API prices.

Estimated records retain nullable `cost_pricing` JSON with the rate source,
effective USD-per-million rates, catalog SHA-256 version, download time and
selected context threshold. `cost_source` remains `estimated`, so existing
Studio/App coverage and total-cost displays work without a new API contract.
Catalog refreshes never reprice previously stored records.

## Coding Agent accounting boundaries

Every scoped agent uses the provider proxy's measured terminal usage, including
failed/incomplete responses that contain counters. Native events must never add
a second ledger entry to those calls. In global mode, the adapters use:

| Agent | Authoritative boundary | Deduplication / fallback |
| --- | --- | --- |
| Codex | Rollout `token_usage_record` for this thread and turn, including compaction | Native response ID; validate the per-turn total. Older rollouts use distinct `token_count.last_token_usage` records. Resumed CLI cumulative totals are never inserted as a new turn. |
| Claude Code | Native result usage and USD estimate, with streamed assistant message counters | One result per turn; complete message counters survive cancellation. Per-message pricing when the final counters match and no native cost is available. |
| Grok | Native turn/model cost, otherwise distinct response usage | Message ID; price individual calls only when they reconcile with the final aggregate. |
| Cursor | Current invocation's result usage (disjoint input/cache), including explicit native USD fields | One result per turn; older versions without usage stay unknown. |
| Pi | Assistant `message_end` usage | Native message ID or stable message hash; repeated terminal messages are excluded. |
| OpenCode | `step_finish` part tokens/cost plus its exact assistant message model | Native part ID; ordinary input/cache are disjoint and reasoning is added to output once. |
| DSH | Private ACP plugin's `llm/stream` usage chunk for each model call, including compaction and child calls | Generated request ID; record before turn completion. The context-window `usage_update` is not billing usage. |

Persisted `parent_run_id` connects each request to its Studio run. Native Codex
request timestamps preserve daily attribution. Session totals sum the same
ledger that populates completed run cards; a run's cost stays NULL if any of its
recorded calls has no price. Cancellation retains measured completed calls,
but tokens not reported by an interrupted upstream cannot be reconstructed.
Separate native threads are not charged merely because they appear nearby in
a file; they need an identified accounting owner.

Accounting is isolated from chat lifecycle errors: native/proxy usage failures
must not suppress text, tool results, terminal events or cancellation cleanup.
DSH usage notification/callback failures must not replace the model's original
result/error or dispose the ACP connection. Codex's end-of-turn discovery and
file reads share a two-second wait budget; on timeout the run settles with
available/unknown accounting and releases the next input. Fault-injection tests
exercise these guarantees alongside resume and queue-interruption tests.

Terminal events carry the recorded session totals as well as the per-run card.
This keeps Pi's cumulative display current before the client releases its run
listeners; its deferred usage/context refresh does not delay completion. Error,
cancellation and queue-interruption events retain already measured usage, while
a session without ledger entries leaves cumulative usage unknown.

Native USD catalog estimates remain estimates. Aggregate-only CLI versions
cannot supply per-request context tiers; missing model/provider/price metadata
remains unknown. Configure exact provider/model manual rates where appropriate.
Do not infer a zero, official-provider price or account invoice from missing data.

## Explicit legacy Codex repair

`scripts/repair-codex-usage.ts` is an offline maintenance command. It defaults to
a read-only preview, does not fetch prices, and never runs on server startup.
Use an explicit database path, Studio session ID and the native CODEX_HOME for
that session. Start with a SQLite backup/copy; close the app before applying to
its database. The catalog is optional: without known rates, costs stay NULL.

```bash
npx vite-node scripts/repair-codex-usage.ts \
  --db /absolute/path/hermes-web-ui.db \
  --session STUDIO_SESSION_ID \
  --codex-home /absolute/path/native-codex-home \
  --catalog /absolute/path/models.dev.json
```

After reviewing the preview, repeat it with `--apply --expect FINGERPRINT
--backup /absolute/path/new-backup.db`. The command creates a SQLite backup,
rechecks the session ledger under a write lock and atomically replaces only
uniquely matched, completed legacy turns. It refreshes existing run snapshots,
retains assistant links and native dates, and is idempotent. Concurrent ledger
changes abort the operation. Restore the backup with the app stopped to undo it.

Reported costs, ambiguous/missing logs, incomplete turns and already recorded
request IDs are skipped. Saved manual price contracts are retained; catalog
tiers are selected again per request using the explicitly supplied snapshot.
The preview fingerprint covers both old records and planned replacement costs.
This is an explicit historical estimate, not invoice reconciliation or automatic
recovery for agents that never persisted native usage.

Hermes token deduplication and cost recovery are separate. A native session bill
can supplement a local session only if all its local rows are unpriced and the
whole session falls inside the period. It cannot be added to a partly priced
session. Native aggregate costs retain Hermes's session-start date; for sessions
spanning days, daily coverage stays unknown where charges cannot be attributed.

Validation: `model-catalog.test.ts`, `model-context.test.ts`, `usage-cost.test.ts`,
`usage-store.test.ts`, `usage-analytics-db.test.ts`, native usage/model adapter
tests and `tests/e2e/usage-cost.spec.ts` cover refresh/offline behavior, shared
context limits, persistence, precedence, deduplication and UI.
