# Native Coding Agent model discovery

`GET /api/coding-agents/models` is the single authenticated API for the native
model directories of all fourteen Coding Agents. It does not read Studio's
Hermes Profile model picker or start a Studio chat/run. The server's global CLI
homes and existing native credentials determine the result.

Query parameters:

| Parameter | Meaning |
| --- | --- |
| `agent` | Optional Coding Agent ID, such as `codex` or `claude-code`. Omit to discover all agents. Unknown IDs return HTTP 400. |
| `refresh` | `true` bypasses the result cache; `false` is the default. Concurrent requests for the same agent still share an in-flight discovery. |

For example, `GET /api/coding-agents/models?agent=codex&refresh=true` returns:

```json
{
  "agents": [{
    "agentId": "codex",
    "name": "Codex",
    "status": "ready",
    "source": "app-server",
    "scope": "available",
    "models": [{ "id": "example-model", "name": "Example Model", "hidden": false }],
    "checkedAt": "2026-10-10T00:00:00.000Z",
    "cached": false
  }]
}
```

The array preserves the agent registry order. Each entry has its own status:
`ready`, `empty`, `not_installed`, `auth_required`, `unsupported`, `timeout`, or
`error`. Individual discovery failures still return HTTP 200 and do not discard
other agents' results. An empty list is not evidence that the account is logged
out; `auth_required` means the native command explicitly rejected authentication.
An older CLI that does not expose the required protocol returns `unsupported`.

`scope` distinguishes an account's `available` directory, the native
`configured` directory, and a shipped `builtin` directory. Neither a configured
nor a builtin directory proves that every entry can be used by the account.
Native model IDs, aliases and provider prefixes are preserved. In particular,
Claude Code aliases can refer to models selected in native settings. Optional
context limits, input modalities and reasoning efforts are returned only when
the native discovery response provides them. Codex includes hidden entries.

## Adapters

| Agent | Native discovery | Scope |
| --- | --- | --- |
| Codex | App Server `initialize` then paginated `model/list` | available |
| Claude Code | Stream JSON control initialization, with no prompt or persisted session | available |
| Pi | `--list-models` | available |
| Grok | Isolated `agent --no-leader stdio`: initialization model state and `x.ai/models/list`; older transport fallback to `models` | available; builtin when the text CLI advertises defaults without authentication |
| OpenCode | `models` using its connected providers/configuration | configured |
| Cursor | `models` | available |
| Antigravity | `models` | available |
| Qoder | `--list-models` | available |
| Qwen, Kimi, CodeBuddy | ACP `initialize` and `session/new` selectors | configured |
| Copilot | SDK transport `models.list` with Content-Length framing | available |
| DSH | Native `acp` profile selectors | configured |
| ZCode | Exact desktop `builtinProviderModelRules` IDs; native option rules supply reasoning levels | builtin |

ACP discovery can create an empty native session to obtain its selectors. It
never sends `session/prompt` or accepts permission/tool/filesystem callbacks. It
closes the native session when the agent advertises that capability, then stops
the discovery process. Native CLI plugins and configuration are still native
code and may execute during initialization. DSH's native ACP profile can differ
from the Web profile used by Studio runs. ZCode installations without a supplied
builtin provider config return `unsupported` rather than an invented directory.
Grok discovery uses only initialization and model-list requests; it does not
create a native session or attach to the user's running Grok leader. Its native
model metadata supplies the supported reasoning efforts, ordered from low to
high for the Studio selector.

ZCode resolves `reasoningLevel` from its native model, API, provider-site,
template and provider rule layers, including personal and manual overrides.
Regex rules describe capabilities of existing models; they do not add model IDs
to the directory. Choices vary by model: for example, GLM-5.3 can offer
`low`/`high`/`max`, while GLM-5-Turbo can offer `disabled`/`enabled`.

## Implementation

Shared orchestration and bounded transports live in
`packages/server/src/modules/coding-agents/services/models`. Each agent owns its
adapter in `services/<agent>/models.ts`. Platform command discovery is injected
from the existing Coding Agent service entrypoint, including desktop PATH
resolution, Windows command shims and ZCode desktop resources. Runtime scratch
directories are created under the Studio data home and removed after discovery.

At most three discoveries run concurrently. Each child process has a 20-second
total deadline and a 4 MiB output limit; cleanup kills its process tree. Successful
results cache for 60 seconds, failures for 5 seconds, with a bounded in-memory
cache. Native home/environment changes use different cache identities. Refresh
after editing credentials or model files to bypass the TTL. No credentials,
account objects, raw native configuration, CLI diagnostics, prompts or upstream
provider error bodies are returned by the endpoint.

The client API helper is `fetchCodingAgentModels({ agent?, refresh? })` in
`packages/client/src/api/coding-agents.ts`.

## New chats in global mode

The new-chat composer uses this endpoint for the selected global Coding Agent.
Its model list is independent of Hermes Profile providers, aliases and custom
models. Hidden entries are omitted. The default entry leaves model selection to
the native CLI; an explicit selection applies to this conversation. Choices are
remembered per agent, separately from scoped-mode settings. Discovery failures
leave the native default available, and the picker offers a refresh action.

Successful client discoveries are cached per server, Studio account and agent,
including local storage for page reloads (up to 24 hours). Reopening shows the
cached directory immediately and revalidates it in the background. Concurrent
consumers share one request, and failed refreshes retain the last usable list.
Discovery does not block starting a conversation with native defaults or a
remembered selection. The picker uses one loading indicator on its refresh button.

The reasoning selector uses the selected model's native `reasoningEfforts`.
Antigravity and Cursor encode effort in native model IDs. Discovery retains all
literal IDs and adds `modelFamily`, `modelFamilyName`, and `reasoningEffort`.
The picker shows one row per family, with only its discovered effort variants;
Fast and Thinking remain separate families. A native alias without an effort
suffix supplies a default choice when present. Otherwise, each offered choice
maps to a real fixed-effort ID, including families with just one read-only level.
The session reasoning-effort API supports paired updates with both
`reasoningEffort` and the target native `model`. The server
validates that the IDs belong to the same family and persists/broadcasts them
together. Failed writes restore both values. Fixed Antigravity variants launch
with `--model` alone; conflicting model/effort pairs are rejected before launch.
CLI adapters can supplement native model metadata with explicitly advertised
`--help` choices; Pi only applies these to models whose native table supports
thinking. ACP thought-level choices describe its current model and are attached
only to that model. Without advertised choices, Studio cannot offer a validated
effort selector; this does not establish that the model cannot reason. Some
agents fix their effort internally or do not expose it through discovery.
The new-chat draft allows effort selection before starting. Created and restored
global Coding Agent single chats display effort as read-only, even after native
discovery succeeds. Refreshing native capabilities never clears their saved
effort. Subsequent global messages retain the selected effort and native model ID.
Scoped Coding Agent single chats allow effort changes using the selected model's
supported levels, and subsequent messages use the updated effort.

Global runs carry the chosen model and reasoning effort through session storage
and resumed runs while retaining native authentication and provider settings.
CLI agents receive native flags, and ACP agents receive native session model and
thought-level configuration before prompting. ZCode selects builtin models via
a private provider-config overlay without changing the user's native settings.
The overlay also carries the selected ZCode `options.reasoningLevel`, validated
against that provider/model's native enum. Grok receives `--reasoning-effort`.
