# Shared JEV evaluations

Business integrations must follow the [JEV harness contract](harness/jev-integrations.md):
register the exact integration point, provide an independent default-off feature
switch, and expose adjustable options in the frontend. `npm run harness:check`
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
- `PUT /api/studio/jev/settings`: save `baseUrl`, `model`, `timeoutMs`, optional `apiKey` and `ekkoMemoryEnabled`.
- `DELETE /api/studio/jev/settings`: reset settings and remove the key.
- `POST /api/studio/jev/test`: test saved settings with a fixed sample.
- `POST /api/studio/jev/evaluate`: accept `{ state, questions, model? }`.

All endpoints require Studio authentication and an authorized Profile header.
Persistence uses private files in `config.appHome/models/jev`, named by the profile hash.
It does not write Hermes Agent configuration. No existing runtime or business
module is automatically routed through JEV by this change.

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
This adds the switch and configuration transport only; Ekko memory policies do
not yet call JEV automatically, even when the switch is enabled.
