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
cost wins over configured rates. Prices apply at recording time, so price edits
do not reprice historical rows or duplicate run IDs.

Hermes token deduplication and cost recovery are separate. A native session bill
can supplement a local session only if all its local rows are unpriced and the
whole session falls inside the period. It cannot be added to a partly priced
session. Native aggregate costs retain Hermes's session-start date; for sessions
spanning days, daily coverage stays unknown where charges cannot be attributed.

Validation: `usage-cost.test.ts`, `usage-analytics-db.test.ts`, native usage and
model adapter tests, and `tests/e2e/usage-cost.spec.ts` cover accounting and UI.
