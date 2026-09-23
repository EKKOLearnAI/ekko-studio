# Shared JEV evaluations

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

Import the Studio public facade. Pass the Profile authorized for the operation:

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
- `PUT /api/studio/jev/settings`: save `baseUrl`, `model`, `timeoutMs`, optional `apiKey`.
- `DELETE /api/studio/jev/settings`: reset settings and remove the key.
- `POST /api/studio/jev/test`: test saved settings with a fixed sample.
- `POST /api/studio/jev/evaluate`: accept `{ state, questions, model? }`.

All endpoints require Studio authentication and an authorized Profile header.
Persistence uses private files in `config.appHome/models/jev`, named by the profile hash.
It does not write Hermes Agent configuration. No existing runtime or business
module is automatically routed through JEV by this change.

Protocol reference: [TypeSafe quickstart](https://docs.typesafe.ai/introduction/quickstart)
and [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript).
