# Model API

Studio exposes one model gateway with several native protocol entrances:

- `GET /api/ekko-studio/models/v1/models`
- `POST /api/ekko-studio/models/v1/responses`
- `POST /api/ekko-studio/models/v1/chat/completions`
- `POST /api/ekko-studio/models/v1/messages`
- `POST /api/ekko-studio/models/v1/messages/count_tokens`
- `POST /api/ekko-studio/models/v1beta/models/{provider/model}:generateContent`
- `POST /api/ekko-studio/models/v1beta/models/{provider/model}:streamGenerateContent`

App model pickers use `supports_gateway_auth: true` on model groups returned by
`/api/hermes/available-models` and the Person model catalogs to enable scoped
Coding Agent OAuth choices through the gateway. This is separate from
`credential_configured`, which only describes stored credentials. Missing or
false capability fields mean clients must retain their older per-agent auth
rules; version numbers or the presence of a saved credential are not sufficient.
This additive field does not change logical Provider/model IDs or session storage.

New Studio/App clients set the optional query parameter `credential_format=metadata` when reading
`/api/hermes/available-models`; `api_key` stays empty and credential readiness is
reported by `credential_configured`. Older servers ignore this parameter, and
it survives older relay header allowlists without a relay upgrade.
For older clients without the parameter, configured groups receive the non-secret
`__studio_managed_credential__` marker in `api_key` so their required-key checks
still pass. Missing credentials remain empty. The marker cannot authenticate
Model API requests. HTTP credential fields and Socket run payloads discard it
before business logic, queueing or persistence; real key updates and explicit
clears retain their semantics. Internal catalogs never contain this marker.
This compatibility preserves existing old-App features; newly supported Coding
OAuth choices still require an App that understands `supports_gateway_auth`.

Use `http://localhost:8648/api/ekko-studio/models/v1` as the OpenAI SDK `base_url`
(replace the host and port for your instance). Authentication accepts a dedicated
**Model API key** or a Studio **user JWT** as `Authorization: Bearer …`. Provider
API keys stay on the server. Anthropic clients may use `x-api-key`; Gemini clients
may use `x-goog-api-key`. Set the Anthropic SDK base URL to
`http://localhost:8648/api/ekko-studio/models` (its SDK appends `/v1/messages`).

In **Models → Model API**, create a named API key and select the models it may call.
All currently callable models are selected by default. The key stores explicit
model IDs: models added later require editing the key to grant access. At least
one accessible, supported model must be selected. Keys belong to the current
Studio account and are **not bound to a Profile**. Copy the key when created:
plaintext is shown once, and only a SHA-256 hash is persisted in Studio storage.
Use it as the SDK `api_key` or `Authorization: Bearer …`. No Profile header is
needed. The API always aggregates the caller's accessible Provider configurations;
UI selections and caller-supplied Profile selectors do not change that directory.

Keys authenticate model listing and inference through these protocol entrances only.
They cannot access Studio settings, key management, other proxies or WebSocket
authentication. Each request rechecks the owner's active status and accessible
Profiles. Revocation blocks new requests, without cancelling requests in progress.
Keys remain valid until revoked. Account deletion or disabling also blocks them.

The settings tab lists the account's keys with creation and last-use times. It
provides the base URL, combined model IDs, a Python example and external usage.
Switching the Models page's Profile does not create a separate key configuration.
Edit a key to change its name or allowed models without rotating its secret.
The next request uses the updated scope; requests already running continue.
Existing Studio user JWTs remain supported with their configured expiry; clients
must log in again when they expire. Dedicated keys are preferable for clients.

Key management requires Studio user authentication:

- `GET /api/studio/models/api-keys` — list the account's key metadata.
- `POST /api/studio/models/api-keys` with `{"name":"My client","models":["glm/glm-5.3"]}` — returns
  `{key, apiKey}`; `apiKey` is the one-time plaintext secret.
- `PATCH /api/studio/models/api-keys/:id` with the same required `name` and `models`
  fields — update an owned key, returning `{key}` without the secret.
- `DELETE /api/studio/models/api-keys/:id` — revoke a key owned by the caller.

Responses use `Cache-Control: no-store`. A key name is required (1–80 characters);
up to 50 keys may be active per account. Key management does not modify Hermes config.

## Per-key USD budgets

Creation and editing accept `budgetUsd`: a number from 0 to 1,000,000 USD, or
`null` (also the default when omitted) for unlimited use. Zero pauses new model
requests. The UI defaults to unlimited. Each key exposes `budgetUsd`, `spentUsd`
and `unpricedRequests` in management responses. Editing its name, model scope or
budget preserves all recorded spending and its secret. Raising the cap or removing
it restores access when the recorded balance permits it; there is no periodic reset.

Budget checks apply to Model API key inference, independently for each key and
account, across all accessible Profiles. Model listing remains available. A Studio
user JWT is not a Model API key and has no per-key budget. Authentication, model
scope and current account permissions still apply.

The counter uses the same request cost records as external usage: manual model
pricing takes priority, then provider-reported USD cost, then the model catalog.
Each key request is registered before contacting the provider and settled once. A crash or failed settlement leaves an unknown-cost entry. Missing cost is unknown, never free. A limited key with an unpriced request returns
`429` with `quota_cost_unknown`; delayed catalog pricing can resolve that state.
If usage or pricing cannot be recovered, the owner can revoke the key or explicitly
remove its limit. Unlimited keys show the unknown-cost state but can continue.

An exhausted key returns `429` with `insufficient_quota` before a new provider
request. This is a limit on settled cumulative spending: the last request and
other requests already in flight can take spending above the configured cap.
It is not a prepaid balance or an upper-bound reservation. JSON and SSE calls
are attributed once by request ID, including usage reported before failure or
cancellation. Costs are not reset by editing, refreshing or restarting Studio.

## Models and routing

With a Model API key, `GET /models` lists only its allowed models, and
`POST /responses` rejects other model IDs before contacting a provider. Both
checks use the owner’s account Provider pool. Studio user JWTs
retain the complete account catalog used by the management UI.

The catalog lists the account's shared Providers, initially imported from every
accessible Profile. IDs use a stable Provider namespace, for example
`deepseek/deepseek-reasoner` or `openrouter/vendor/model`. Only the first slash
separates the namespace; the complete upstream model ID remains intact. Slashes
and percent signs in Provider names are escaped as `%2F` and `%25`.

Provider namespaces and names are unique per account. Migration keeps the first
same-name Provider even when endpoints or credentials differ: the default Profile
wins, followed by the remaining Profiles in sorted order. Names are compared
after Unicode normalization, lowercasing and whitespace normalization. Later
creation and renaming reject duplicate names or display labels with HTTP 409.
Every Profile of that account uses the same records. Previously issued
Profile-derived IDs and draft suffixed duplicate IDs remain aliases for existing
clients and sharing-key grants. Use IDs returned by the catalog for new clients.
The list includes `api_mode` and `responses_supported`, with no credentials or
upstream URLs. Self-referencing local gateways and MoA presets are excluded.
Bedrock Converse and Codex app-server require native runtimes and return an
explicit unsupported-mode error through this HTTP gateway.

The selected source configuration supplies the upstream protocol and credential.
Current upstream adapters support Chat Completions, Responses and Anthropic
Messages; Gemini Providers using Google's OpenAI-compatible endpoint use Chat
Completions upstream. Native Chat and Messages requests retain vendor fields;
cross-protocol calls translate text, images, function calls/results and streamed
responses using the shared Agent protocol codecs. Protocol-specific vendor
features remain subject to adapter and model support.

OpenAI Codex subscription inference uses `/backend-api/codex/responses` without
an inserted `/v1`. The gateway applies Codex's native streaming-only, `store=false`
request policy and omits unsupported sampling/output-limit fields. JSON callers
receive the collected terminal Responses object from that upstream stream.

When Chat Completions thinking models are exposed through Responses, the gateway
seals their reasoning text in `encrypted_content` for clients such as Hermes to
retain and replay. The gateway restores that text for subsequent tool calls;
DeepSeek-compatible history without captured reasoning receives a non-empty
placeholder. Upstream SSE keep-alive comments become `response.in_progress`
events so Responses clients can observe an active connection during inference
queues or long thinking pauses.

## Provider ownership and migration

On the authenticated user's first access, Studio imports all accessible Profiles
before changing primary inference configuration. Configuration, credential files,
model context overrides and display preferences become account-owned state under
`HERMES_WEB_UI_HOME/providers/users/<user-id>`. Import markers make this idempotent;
private source snapshots support recovery and later imports by another user who
shares the same Profile. Changes in Studio do not overwrite the imported backup.
Live Provider configuration, environment credentials, OAuth state, catalog,
display preferences and the generated internal key live directly in this account
directory. Additional OAuth identities have Provider-owned `credentials/` slots.
The `profiles/` directory holds source backups, import/projection metadata and
runtime model selections; it does not partition the live Provider pool.

Refreshing one Provider resolves only its own credentials. A global refresh skips
unavailable grants and keeps the last working catalog when a probe fails. Live
catalogs and their restore snapshots are shared across Profiles, and catalog
changes update the Hermes gateway projection. Removing a Provider clears its
account record, catalog and runtime selections; credentials still referenced by
another Provider are retained. Source backups and other accounts are unchanged.

Session and message tables, history formats and session IDs are unchanged.
Stored logical Provider IDs and gateway-qualified selections are resolved to the
retained Provider when continuing a session; migration does not rewrite message
history. Draft duplicate pools are backed up before being coalesced. Continuing
a session on a discarded configuration uses the retained endpoint and credential,
so its model must still be available there.

Scoped Coding Agent runtimes moved from the shared application directory into
the account directory. On continuation, Studio copies an owned session's existing
runtime directory before preparing its launch, retaining the original files and
native session ID. It also handles a Provider ID changed by migration. Existing
destination histories are never replaced. Machine-native global CLI homes keep
their existing storage layout.

Hermes primary inference uses Provider `ekkostudio`, the local gateway URL, an
automatically generated internal credential, and qualified models such as
`deepseek/deepseek-v4`. The UI continues to display separate logical Provider and
model names. One internal credential is shared across the account's Profiles;
HTTP calls recheck account status. Internal credentials cannot create sharing
keys or access management APIs.

Existing auxiliary, MoA, fallback and delegation configurations are **not**
automatically rewritten. Their native Provider definitions, environment and OAuth
files remain available. When a user edits a slot in Studio, only that slot is
written as a gateway route. Unchanged slots in a submitted settings group remain
native. Reads display logical names for edited slots, and continue to reflect
native Hermes changes to untouched slots. Resetting a slot to `auto` retains
inheritance rather than fixing it to a model.

Ekko and scoped Coding/plugin Agents use the same gateway. Native CLI launch
configuration and its gateway binding are account-scoped; upstream credentials
are resolved from the account store after restart. Previously generated proxy
URLs are accepted as compatibility aliases through the same authenticated
handler. CLI modes explicitly using a machine-native account keep that mode.
Legacy URL compatibility lives in the shared model gateway middleware. The
unmounted proxy routers/controllers and their separate model-list handlers have
been removed; the gateway reuses the active Coding Agent protocol adapters.

Ekko keeps logical model IDs and sends the Provider ID in `x-studio-provider`.
This internal header uses `encodeURIComponent` with
`x-studio-provider-encoding: uri`, so Chinese and other Unicode Provider names
remain valid HTTP headers.
The gateway decodes it before account routing; older unencoded headers retain
their literal meaning, including percent signs. Stored Provider names and IDs
do not need to change.

Gateway composition is confined to `bootstrap/model-gateway-adapter.ts`: Studio
owns credential persistence/restoration and outbound HTTP policy; Coding Agents
own protocol dispatch and target lifetimes behind their public adapter. Studio
does not import concrete agent implementations.

Saved native CLI credentials are loaded on demand. Startup does not rebuild their
targets or validate every historical model selection. On the first request for a
saved credential, Studio reads its SHA-256-named record in each active account,
checks ownership, Profile access and the current model configuration, then
registers that target with current upstream credentials. Concurrent requests for
the same credential share the lookup. Restored targets use a 128-entry LRU cache;
credential and route lookups in the protocol registry are indexed. Normal session
continuation still prepares its own target through the existing launch path.

The old shared Codex/Grok and Pi configuration directories are imported into these
account-owned credential records once by the startup-task registry. The completion
marker prevents subsequent launches from rescanning those directories. Shared
legacy credentials with ambiguous account ownership are left alone; continuing
the session creates an account-scoped credential. This does not change the
one-time Hermes Provider import or the on-demand Hermes gateway projection.

Plugins declaring `http` can intercept `/api/ekko-studio/models/*` through the
existing global HTTP middleware. `onRequest` receives the parsed client request
before authentication and protocol translation. Rewrites still pass normal
credential, Profile and model-grant checks. `onResponse` receives the translated
client response before Koa sends it, with the authenticated account and selected
Profile (or the bound Profile for run credentials). The gateway returns SSE as
a Readable, so plugins can attach a Transform without buffering the full stream.
The response callback runs once before transmission, not when the stream ends;
outgoing Provider requests are not a separate HTTP plugin interception point.

Messages token counting forwards to Anthropic's native endpoint when available.
For other upstream protocols it returns a conservative byte-based estimate,
marked by `x-studio-token-count-estimated: true`. Counting does not record a model
inference or consume a key's inference budget.

## Requests

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8648/api/ekko-studio/models/v1",
    api_key="YOUR_MODEL_API_KEY",
)
models = client.models.list()
response = client.responses.create(
    model="glm/glm-5.3",
    input="Hello",
    store=False,
)
print(response.output_text)

for event in client.responses.create(
    model="glm/glm-5.3", input="Hello", store=False, stream=True,
):
    if event.type == "response.output_text.delta":
        print(event.delta, end="")
```

Supported input includes text messages, `instructions`, `developer` messages,
function tool declarations, function calls/results, reasoning effort/summary,
temperature and maximum output tokens. User/tool images must use base64 data
URLs and a vision-capable model. Provider-specific capabilities still apply.
The endpoint returns JSON or named Responses SSE events, including terminal
`response.completed`, `response.incomplete` and `response.failed` states.
Disconnecting cancels the upstream request.

The API is stateless: send the full history for every continuation. Append the
returned `output` items unchanged, then append a `function_call_output` for every
outstanding `call_id`. Tools are executed by the caller. Send the tool declarations
again on subsequent requests. For example:

```python
history = [{"role": "user", "content": "Look up the status"}]
response = client.responses.create(model="deepseek/deepseek-reasoner",
    input=history, tools=tools, store=False)
history.extend(item.model_dump(exclude_none=True) for item in response.output)
for item in response.output:
    if item.type == "function_call":
        history.append({"type": "function_call_output", "call_id": item.call_id,
                        "output": run_allowed_tool(item.name, item.arguments)})
response = client.responses.create(model="deepseek/deepseek-reasoner",
    input=history, tools=tools, store=False)
```

Same-protocol calls preserve native vendor payloads. For Responses calls routed
to Anthropic, signed thinking blocks are retained in an opaque `encrypted_content`
envelope. Send returned reasoning items unchanged with subsequent tool results.
Replay is scoped to the account, Profile, Provider, model, endpoint and protocol.
The encryption key is stored as `model-api-reasoning.key` in Studio state; retain
it across backups and restarts.

The gateway performs inference only; it does not execute tools or create chat
sessions. Send complete conversation history for translated continuations. Native
Responses features are forwarded when using a Responses upstream; this gateway
does not implement response retrieval/delete or a universal stored-conversation
service across vendors. Audio, video and other vendor-only modalities are not
universally translatable.

## Usage

External calls through sharing keys or account JWTs record external usage once
per request. Generated internal credentials and run-scoped CLI/plugin credentials
retain their existing Agent/session accounting; the gateway does not add another
external charge. Authentication and validation failures before upstream dispatch
do not create model usage. Failure/cancellation retains reported usage.

The usage page switches between Internal and External. The stats endpoint accepts
`origin=internal|external` and defaults to internal for existing clients. API usage
belongs to the authenticated Studio user and the source Profile used for the
model credentials, with one API call
per request and no synthetic chat session. Repeated usage snapshots within one
stream produce one external record. Failure/cancellation retains usage already
reported; missing usage remains unknown instead of claiming a measured zero cost.
Responses `input_tokens` includes cached input; Studio's ledger keeps ordinary
input and cache counters separate.
