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
| Grok | `models` | available; builtin when the CLI advertises defaults without authentication |
| OpenCode | `models` using its connected providers/configuration | configured |
| Cursor | `models` | available |
| Antigravity | `models` | available |
| Qoder | `--list-models` | available |
| Qwen, Kimi, CodeBuddy | ACP `initialize` and `session/new` selectors | configured |
| Copilot | SDK transport `models.list` with Content-Length framing | available |
| DSH | Native `acp` profile selectors | configured |
| ZCode | Desktop bundle `builtinProviderModelRules` | builtin |

ACP discovery can create an empty native session to obtain its selectors. It
never sends `session/prompt` or accepts permission/tool/filesystem callbacks. It
closes the native session when the agent advertises that capability, then stops
the discovery process. Native CLI plugins and configuration are still native
code and may execute during initialization. DSH's native ACP profile can differ
from the Web profile used by Studio runs. ZCode installations without a supplied
builtin provider config return `unsupported` rather than an invented directory.

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
