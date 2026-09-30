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

Hermes token deduplication and cost recovery are separate. A native session bill
can supplement a local session only if all its local rows are unpriced and the
whole session falls inside the period. It cannot be added to a partly priced
session. Native aggregate costs retain Hermes's session-start date; for sessions
spanning days, daily coverage stays unknown where charges cannot be attributed.

Validation: `model-catalog.test.ts`, `model-context.test.ts`, `usage-cost.test.ts`,
`usage-store.test.ts`, `usage-analytics-db.test.ts`, native usage/model adapter
tests and `tests/e2e/usage-cost.spec.ts` cover refresh/offline behavior, shared
context limits, persistence, precedence, deduplication and UI.
