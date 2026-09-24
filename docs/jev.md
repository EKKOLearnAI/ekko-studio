# Shared JEV evaluations

Business integrations must follow the [JEV harness contract](harness/jev-integrations.md):
register the exact integration point, provide an independent feature switch with a
declared Studio default, and expose adjustable options in the frontend. `npm run harness:check`
enforces the registration and configuration wiring.

The Models page has a **JEV** tab for the selected `modelProfile`. Save a TypeSafe
API key, API root (default `https://api.typesafe.ai`, without `/v1`), model
(`jev-latest`) and timeout. **Test saved configuration** submits one fixed sample
with Choice, Score and Noul questions; it uses the saved settings, not unsaved form
values, and consumes a provider request.

Changing the page Profile only changes the configuration being edited. Each HTTP
request explicitly sends `X-Hermes-Profile`; it does not change the active global
Profile. Keys stay on the server and settings responses contain only `hasApiKey`.
An empty key field preserves the existing key. Delete resets this Profile's JEV
settings and removes its saved key.

## Server modules

Import the Studio public facade. Pass the Profile authorized for the operation.
The following is a low-level evaluation example; business callers must first gate
it on their registered feature switch and retain their fallback behavior:

```ts
import { evaluateJev, choice, score, noul } from '../modules/studio/public/jev'

const result = await evaluateJev(profile, {
  state: { message: 'Please fix this billing error.' },
  questions: {
    category: choice('Which team should handle this?', {
      billing: 'Payments and invoices', technical: 'Software problems',
    }),
    urgency: score('How urgent is the request?', ['Routine', 'Urgent']),
    actionable: noul('Does the message ask for an action?'),
  },
}, { signal })

result.answers.category.choice // inferred as 'billing' | 'technical'
result.answers.urgency.score
result.answers.actionable.noul
```

The facade uses `@typesafe-ai/sdk`. It returns answers, confidence, probability
distributions, model and usage unchanged. Each call reads the latest saved
settings, with no fallback to another Profile or environment key. Requests have
the configured timeout, support cancellation, and do not automatically retry.
`JevError.status` identifies missing configuration (409), provider errors (502),
timeout (504), cancellation (499) and invalid input (400). Provider errors are
sanitized so credentials and request state are not exposed in API errors.
Errors also expose a stable `JevError.code` (`jev_*`), returned as `code` by HTTP
endpoints, so the UI can translate them without parsing English diagnostic text.

## Client modules and HTTP

Use `evaluateJev(profile, input, signal?)` from `@/api/studio/jev`. It has the same
typed request/response shape and routes through the authenticated Studio server.

- `GET /api/studio/jev/settings`: read non-secret settings.
- `PUT /api/studio/jev/settings`: save `baseUrl`, `model`, `timeoutMs`, optional `apiKey` and the memory/skill options listed below.
- `DELETE /api/studio/jev/settings`: reset settings and remove the key.
- `POST /api/studio/jev/test`: test saved settings with a fixed sample.
- `POST /api/studio/jev/evaluate`: accept `{ state, questions, model? }`.

All endpoints require Studio authentication and an authorized Profile header.
Persistence uses private files in `config.appHome/models/jev`, named by the profile hash.
It does not write Hermes Agent configuration. No existing runtime or business
module is routed through JEV without its feature switch being enabled.

Protocol reference: [TypeSafe quickstart](https://docs.typesafe.ai/introduction/quickstart)
and [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript).

## Ekko runtime configuration

Ekko Agent also owns an independent JEV module (`ekko.jev` and `runtime.jev`).
Standalone users can persist `config.jev`, pass `new EkkoAgent({ jev: ... })`,
or override it when creating a runtime. Runtime values override persisted fields
without writing them back. See the [Ekko API](../packages/ekko-agent/docs/API.md#jev-模块).

Studio keeps using the Profile-scoped settings above. Before each Ekko run it
reads the current Profile's complete values through the server-only
`getJevRuntimeConfig(profile)` facade and passes configuration values to Ekko's
own client. Cached runtimes pick up edits on the next run. Missing credentials or
settings read failures disable JEV for the run, rather than using an Ekko-local
or another Profile's key. No client/evaluator implementation is injected.

The JEV settings panel includes **Use JEV for Ekko memory**, stored per Profile as
`ekkoMemoryEnabled` (default `false`). The runtime facade maps it to Ekko's
`jev.memoryEnabled`; Studio's explicit `false` overrides a locally saved `true`.
Edits take effect on the next run without changing Ekko's persisted settings.
Deleting Studio JEV settings resets the switch to `false`. This switch does not
disable other callers of the shared JEV evaluator.

Standalone Ekko users can persist `config.jev.memoryEnabled` or override it via
`new EkkoAgent({ jev: { memoryEnabled: true } })` and runtime creation options.
Standalone Ekko defaults every switch to false. Studio defaults the master to false
and the four child switches to true, so enabling the master activates all four
policies unless a child was explicitly disabled. Missing fields in older Studio
settings receive these defaults; saved values always take precedence, including false.

| Studio field | Ekko `jev` field | Studio default / range |
| --- | --- | --- |
| `ekkoMemoryKindRoutingEnabled` | `memoryKindRoutingEnabled` | true |
| `ekkoMemoryRelevanceFilterEnabled` | `memoryRelevanceFilterEnabled` | true |
| `ekkoMemoryRerankEnabled` | `memoryRerankEnabled` | true |
| `ekkoMemoryWriteReviewEnabled` | `memoryWriteReviewEnabled` | true |
| `ekkoMemoryCandidateLimit` | `memoryCandidateLimit` | 20 / integer 1–50 |
| `ekkoMemoryRecallMinConfidence` | `memoryRecallMinConfidence` | 0.5 / 0.5–1 (routing relevance and ranking confidence) |
| `ekkoMemoryFilterMinConfidence` | `memoryFilterMinConfidence` | 0.8 / 0.5–1 (minimum confidence to discard an irrelevant card) |
| `ekkoMemoryMinConfidence` | `memoryMinConfidence` | 0.8 / 0.5–1 (write review only) |
| `ekkoMemoryTimeoutMs` | `memoryTimeoutMs` | 3000 / integer 100–30000 ms |

The page groups provider connection settings and memory use cases. Feature switches
are in the expandable memory section; numeric controls are under Advanced parameters.
Turning the master switch off retains the child settings. Save applies the complete
Profile configuration on the next run. Delete resets all fields in that Profile.

Category routing uses actual eligible memory content to select controlled kinds,
with routing, individual relevance filtering and ranking bounded by the candidate limit. The recall threshold
is independent of write review. Older saved settings inherit recall 0.5 while
retaining their write threshold. Relevance filtering removes confident unrelated
cards from both ordinary baseline matches and semantic additions. Uncertain cards,
standing instructions, constraints and corrections remain. Explicit queries bypass
filtering. Its independent switch and confidence control appear in the same panel.
Reranking
changes candidate order before the existing token selection; exact matches and
always-recalled constraints retain their priority. Write review checks user evidence,
durability and kind after deterministic validation and before an atomic commit.
A reliable negative decision rejects the entire batch with corrective feedback.
Deletion, expiry, noops, exact search, get and list-all keep their existing behavior.

Each run snapshots its effective configuration, isolated even when memory services
are shared. A recall has at most one combined category/filter request and one batch scoring request;
a write batch has at most one review request. The memory timeout covers each complete
recall or write batch, while the shared provider timeout also limits each request.
Disabled/missing JEV makes no requests. Timeout, provider failures, invalid/unreliable
results, unavailable evidence, or oversized input preserve the original flow.
Cancellation propagates and cannot authorize a write. Result structures and stored
card confidence/importance remain unchanged; provider scores stay internal.
See [Ekko memory JEV behavior](../packages/ekko-agent/docs/memory-jev.md) for details.

Memory JEV diagnostics appear as `memory.jev` in the existing Ekko logs, correlated
by session/run/turn. They include timings, routing probabilities, thresholds and
sanitized failure codes; filter diagnostics also report per-card decisions, confidence
and removed ids, never card text or credentials. See the
[recall verification guide](../packages/ekko-agent/docs/memory-jev.md#diagnostics-and-manual-verification).

## Unified Ekko skill enhancement

Models → JEV includes **Use JEV for Ekko skills**. One Profile-scoped switch,
`ekkoSkillsEnabled`, enables semantic matching and background learning preflight
independently of memory. It defaults to false in Studio and standalone Ekko.

| Studio field | Ekko `jev` field | Default / range |
| --- | --- | --- |
| `ekkoSkillsEnabled` | `skillsEnabled` | false |
| `ekkoSkillsCandidateLimit` | `skillsCandidateLimit` | 20 / integer 1–50 |
| `ekkoSkillsMinConfidence` | `skillsMinConfidence` | 0.8 / 0.5–1 |
| `ekkoSkillsTimeoutMs` | `skillsTimeoutMs` | 3000 / integer 100–30000 ms |

All parameters are editable in the same skills section. Save applies on the next
run; disable retains parameters; delete resets them. Routing adds at most three
confident semantic matches after exact matches. Learning preflight skips the
existing full reviewer only when confidently no reusable experience is present.
Both use the run snapshot, one request per decision, bounded input and conservative
fallback. Background review snapshots remain isolated while queued. Skill JEV
logs use `skill.jev`; context estimation makes no JEV calls.
See [Ekko skill JEV behavior](../packages/ekko-agent/docs/skills-jev.md) for details.
