# Model API

Studio exposes a stateless OpenAI Responses-compatible model endpoint:

- `GET /api/ekko-studio/models/v1/models`
- `POST /api/ekko-studio/models/v1/responses`

Use `http://localhost:8648/api/ekko-studio/models/v1` as the OpenAI SDK `base_url`
(replace the host and port for your instance). Authentication accepts a dedicated
**Model API key** or a Studio **user JWT** as `Authorization: Bearer …`. Provider
API keys stay on the server.

In **Models → Model API**, create a named API key and select the models it may call.
All currently callable models are selected by default. The key stores explicit
model IDs: models added later require editing the key to grant access. At least
one accessible, supported model must be selected. Keys belong to the current
Studio account and are **not bound to a Profile**. Copy the key when created:
plaintext is shown once, and only a SHA-256 hash is persisted in Studio storage.
Use it as the SDK `api_key` or `Authorization: Bearer …`. No Profile header is
needed. The API always aggregates the caller's accessible Provider configurations;
UI selections and caller-supplied Profile selectors do not change that directory.

Keys authenticate only `GET /models` and `POST /responses` below this API base URL.
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
up to 50 keys may be active per account. Settings do not modify Hermes config.

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
checks also enforce the owner’s current Profile permissions. Studio user JWTs
retain the complete account catalog used by the management UI.

The list combines configured models from every accessible Profile (all Profiles
for a super admin), deduplicated by provider/model, with IDs
such as `glm/glm-5.3`, `deepseek/deepseek-reasoner`, and
`openrouter/vendor/model`. Native IDs containing slashes remain intact. The list
includes `api_mode` and `responses_supported`; it contains no keys or upstream URLs.
Slashes and percent signs in custom provider names are escaped in the provider
segment (`%2F`, `%25`) to avoid collisions; use the exact ID returned by the list.

A custom provider pointing at this instance's Model API using a locally issued
Model API key is not re-exported. It can still be used by Studio chats, but its
cached model IDs must not create recursive copies of the public catalog.
Providers connected to another instance with its own key remain available.

Duplicate IDs use a callable configuration before a disabled/unsupported one.
Among equivalent candidates, `default` takes priority, followed by Profile names
in lexical order. This order is independent of load timing or the UI's active
Profile. Distinct models from duplicate Providers are retained and each uses its
own source configuration. There is no retry/fallback to a different Profile.

The server matches the complete ID against this unified catalog, resolves the
source configuration's credentials and API mode, and calls the existing Ekko
ModelClient adapter. This supports Chat Completions, Responses, Anthropic Messages and Gemini Contents,
including configured custom providers using these protocols. Disabled models are
not callable. MoA presets are excluded from this catalog and direct requests to
`moa/...` return `model_not_found`; internal MoA features are unchanged.
Bedrock Converse and Codex app-server need separate runtimes;
they remain listed with `responses_supported: false` and requests return an
explicit error. OpenAI Codex OAuth using the Responses HTTP transport is supported.

Coding Agent already performs protocol conversion in its own proxy. It remains
separate: this endpoint reuses Ekko model adapters without starting an agent,
executing tools, or modifying Hermes provider configuration.

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

Reasoning output carries an opaque `encrypted_content` envelope. Preserve it:
it retains DeepSeek reasoning content, Anthropic thinking signatures and Gemini
thought signatures needed for valid tool continuation. Native replay is scoped to
the Profile, provider, model, endpoint and protocol. Switching targets discards
incompatible native data instead of forwarding another provider's encrypted data.
The encryption key lives in Studio state as `model-api-reasoning.key`; retain this
file across restarts/backups. Replicas serving one history must share it.

This is a model-inference subset of Responses. It explicitly rejects stored
conversations, `previous_response_id`, background requests, hosted tools, strict
tool schemas, structured text output, remote image URLs/file IDs, forced named
tool choice and disabling parallel tool calls. These features are not silently
emulated. There are no response retrieval/delete routes or `/chat/completions`
endpoint in this API.

## Usage

Every attempted upstream request through this endpoint records **external** usage,
including calls from Studio configured with its own endpoint. Authentication and
validation failures before an upstream request do not create model usage. Existing
chat, workflow and Coding Agent accounting stays **internal**. A Studio call to its
own endpoint can therefore appear once in each category; these are two accounting
views and must not be summed as a deduplicated provider bill.

The usage page switches between Internal and External. The stats endpoint accepts
`origin=internal|external` and defaults to internal for existing clients. API usage
belongs to the authenticated Studio user and the source Profile used for the
model credentials, with one API call
per request and no synthetic chat session. Repeated usage snapshots within one
stream produce one external record. Failure/cancellation retains usage already
reported; missing usage remains unknown instead of claiming a measured zero cost.
Responses `input_tokens` includes cached input; Studio's ledger keeps ordinary
input and cache counters separate.
