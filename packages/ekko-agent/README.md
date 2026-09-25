# Ekko Agent

Ekko Agent is a standalone TypeScript agent runtime used by Ekko Studio. It
owns the model loop, provider adapters, tools, memory, skills, delegation,
approvals, and structured request logging.

The recommended entry is a Profile-oriented container: `new EkkoAgent()`
creates one `EkkoProfileAgent` per configured Profile, so modules are used as
`ekko.default.skill`, `ekko.default.memory`, or
`ekko.agent.get('work').tool`. See the complete field, method, parameter, and
configuration reference in [docs/API.md](docs/API.md).

Ekko includes its own optional JEV evaluator through `ekko.jev` and `runtime.jev`.
Persist defaults in `config.jev`, or pass a `jev` object to the constructor/runtime
to override fields in memory without rewriting the local configuration. The host
passes settings, and Ekko creates the SDK client itself. See the
[JEV module API](docs/API.md#jev-模块) for precedence and fallback behavior.
`jev.memoryEnabled` gates optional category routing, per-card relevance filtering, candidate reranking and foreground
write review. Each feature has its own default-off switch and retains the original
flow when JEV is unavailable. See [memory JEV behavior](docs/memory-jev.md).

`default` is always created, even when `profiles` is omitted or does not list
it. Existing first-level Profile directories under `.ekko/skills`,
`.ekko/logs`, and `.ekko/workspace` are discovered automatically; explicit
`profiles` are merged with those names and missing managed directories are
created before the Profile Agent is validated.

The first implemented layer is model-provider requests. Internally, the agent
uses one request shape and provider adapters translate it to external APIs.

Supported request styles:

- OpenAI Chat Completions style
- OpenAI-compatible providers such as DeepSeek, Qwen, Moonshot, Ollama
- OpenAI Responses
- Anthropic Messages
- Gemini Contents
- prompt completion
- custom runtime

First-class OAuth provider presets:

- `nous` — OpenAI Chat Completions at the Nous inference API
- `openai-codex` — OpenAI Responses at the ChatGPT Codex backend
- `xai-oauth` — OpenAI Responses at the xAI API
- `qwen-oauth` — OpenAI Chat Completions at the Qwen Portal API
- `claude-oauth` — Anthropic Messages at the Anthropic API
- `minimax-oauth` — Anthropic Messages for the MiniMax Coding Plan

Callers still own the interactive login flow, then store its result through
`setModelAuthorization`. Ekko persists and refreshes those credentials before
requests through a supplied provider refresher or a standard configured OAuth
token endpoint. Passing `apiKey` remains available as a one-process override.
MiniMax Coding Plan requests use Bearer-only authentication and do not send
`x-api-key`.

Default endpoints:

| Style | Default endpoint |
| --- | --- |
| `openai-chat` | `https://api.openai.com/v1/chat/completions` |
| `openai-responses` | `https://api.openai.com/v1/responses` |
| `anthropic-messages` | `https://api.anthropic.com/v1/messages` |
| `gemini-contents` | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` |
| `prompt-completion` | `https://api.openai.com/v1/completions` |
| `custom-runtime` | `http://127.0.0.1:11434/v1/agent` |

Use `baseUrl` and `endpointPath` to override these defaults.

## Message Shape

All adapters receive the same internal message shape:

```ts
type AgentMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
  toolCallId?: string
  toolCalls?: AgentToolCall[]
}
```

Use `normalizeAgentMessage()` or `normalizeAgentMessages()` at the boundary.
Model responses can be converted back to a single assistant message with
`modelResponseToAgentMessage()`. Streaming events can be collected into the same
shape with `collectModelEvents()`.

## Tools

Built-in tools:

- `clarify` asks one blocking user question, with optional answer choices, when
  the host provides an interactive clarification handler.
- `read_file` reads a text file from the local filesystem. Relative paths use
  the current working directory; absolute paths and paths outside
  `workspaceRoot` are supported.
- `view_image` loads a local PNG, JPEG, WebP, or GIF as multimodal model
  input while enforcing the runtime workspace boundary and a size limit.
- `write_file` writes text content and creates parent directories by default.
- `terminal_exec` runs a command with an argument array and `shell: false`.
- `code_exec` runs a one-shot Node.js or Python script. Scripts can call the
  allowed `read_file`, `write_file`, and `terminal_exec` tools through the
  generated `ekko_tools.mjs` or `ekko_tools.py` RPC bridge. Intermediate tool
  results remain inside the child script; only its reduced stdout is returned
  to the model.
- `skill_list` lists or searches skills under the agent's configured `skillDirectory`. It returns names, concise descriptions, and built-in identity; maintained routing keywords remain internal to the host matcher.
- `skill_view` loads `SKILL.md` or an allowed support file for one skill in that directory and returns the Skill's absolute `baseDirectory` so bundled scripts can be executed.
- `skill_manage` creates, patches, edits, archives, or manages support files when
  `skillDirectory` is configured. Created and updated skills require non-empty
  compact English ASCII frontmatter `metadata.keywords`; built-in skills cannot be deleted.
- `ekko_diagnostics` reports active component incidents and exact recovery paths.
- `ekko_database_schema` exposes the migration-owned SQLite tables and fields.
- `ekko_repair_skills` re-syncs package-owned Skills and runs its self-check.
- `ekko_repair_database` retries compiled migrations or performs an explicitly
  confirmed quarantine-and-rebuild, then runs its self-check.
- `ekko_self_check` validates Skills/database state and clears only the matching
  current incident revision.

Use `workspaceRoot` to set the default working directory and to isolate
`write_file` and `view_image`. It is not a read or process sandbox:
`read_file` and `terminal_exec` may use explicit paths outside the workspace.

```ts
import { createDefaultToolRegistry } from 'ekko-agent'

const tools = createDefaultToolRegistry()

await tools.execute('write_file', {
  path: 'notes/todo.txt',
  content: 'ship tools',
}, {
  workspaceRoot: process.cwd(),
})

const result = await tools.execute('terminal_exec', {
  command: 'node',
  args: ['-v'],
}, {
  workspaceRoot: process.cwd(),
})

const batchResult = await tools.execute('code_exec', {
  language: 'node',
  code: `
    import { read_file } from './ekko_tools.mjs'
    const result = await read_file({ path: 'README.md' })
    console.log(result.content.split('\\n').slice(0, 5).join('\\n'))
  `,
}, {
  workspaceRoot: process.cwd(),
})
```

`code_exec` accepts `language: "node"` or `language: "python"`, runs for at
most the configured tool execution timeout, permits at most 50 nested tool
calls, caps stdout at 50KB, scrubs the child environment, and rejects recursive
or non-allowlisted tool calls.

Dangerous tools are authorized before execution. `code_exec` always requires
authorization because ordinary Node.js and Python source can access the host;
`terminal_exec` requires authorization for destructive, privileged,
remote-shell, package-publishing, service-control, and similar commands. The
available decisions are `once`, `session`, `always`, and `deny`. A session
decision stays in process memory for the matching chat session. An always
decision is stored in the global config under
`tools.approvals.permanentAllow`; denial fails closed before the tool starts.
The host supplies `requestToolApproval` in the per-run tool context to bridge
these decisions into its UI.

## Runtime

`AgentRuntime` ties messages, model requests, tools, skills, system prompt, and
events together. The default `maxSteps` is `90`, matching Hermes' regular agent
turn budget.

Tools execute serially unless their `AgentTool.concurrency` is explicitly set
to `parallel`. Consecutive parallel-safe calls run with an eight-call limit;
serial tools remain ordered barriers, and results are replayed to the model in
the original tool-call order. Built-in file/image/skill/memory reads opt in.
MCP tools opt in per server with `supports_parallel_tool_calls: true`.

The default registry exposes `clarify` only for a foreground run whose
`AgentToolContext` provides `requestUserClarification`. Delegated subagents and
non-interactive hosts do not receive the tool. When available, the runtime
prompt requires blocking clarification questions to use the tool instead of
being returned as an ordinary assistant response.

When Ekko runs inside a host that owns conversation persistence, the host also
owns context compression. `estimateContext()` exposes the provider-visible
system, tool, message, and provider-context estimate needed for that external
threshold decision without starting a model call. A standalone Ekko host can
instead implement and own its internal compression lifecycle. The global
`compression` config provides a host policy surface for future integrations:
`enabled`, `threshold`, `targetRatio`, `protectLastN`, and `protectFirstN`.
Ekko Studio currently continues to read compression policy from its main
configuration and does not apply this Ekko config section.

Model context and memory evidence are separate inputs. A host that adds derived
summaries, retrieved context, routing instructions, or other application-owned
content to the model input should pass only its trusted conversation evidence
through `memoryInput.messages`. The optional `memoryInput.writePolicy` lets the
host choose normal direct writes or explicit-request-only writes without teaching
the Ekko runtime about host-specific product concepts. A host can also attach
an opaque `memoryInput.origin` and declare `recallScopes`, `writeScopes`, and a
`defaultWriteScope`. Ekko understands only the generic `profile`, `context`, and
`session` scope shapes; identifiers and namespaces belong to the host. Calls
that omit scope configuration remain backward compatible and can access only
profile-scoped memory.

The foreground agent can search, inspect, create, update, and delete authorized
memory directly. `memory_write.operations` applies multiple creates, updates,
expirations, and exact deletions atomically in one SQLite transaction while the
legacy single-operation shape remains compatible. Deletion-only requests may
use `memory_forget`, whose multi-target and broad deletions are also atomic.
Both tools keep the host's trusted evidence and scope boundary. Run completion only records trusted
conversation evidence; it does not start a memory model or create a hidden
Session summary. See
[`docs/MEMORY_HARNESS.md`](docs/MEMORY_HARNESS.md) for the executable quality
contract.

Call `new EkkoAgent()` (or the compatible `setupEkkoAgent()`) once during host
startup, before accepting agent work.
The setup entry owns `EkkoDirectoryManager`, creates
`<base>/.ekko/config/config.json`, the skills, logs, and workspace directories,
and opens and migrates the SQLite database. Development keeps the complete
layout under the package-local `.ekko` directory, including `.ekko/ekko.db`;
production uses `<base>/.ekko/ekko.db`. It returns
shared SQLite-backed memory and conversation stores (using an in-memory fallback
when the persistent target is degraded) and closes that
process-level resource through `setup.close()`. The global JSON file drives
runtime limits, model defaults and providers, tools, approvals, profile-scoped
MCP servers, delegation, context compression, memory, skills, logging, and
prompt instructions. Configuration upgrades merge
new defaults one field at a time: existing user values, arrays, and unknown
forward-compatible fields are never replaced as a whole module. Startup
validation upgrades older schemas in place. A malformed config or one written
by a newer schema is copied to `config.invalid-<timestamp>-<uuid>.json` before
the current defaults are restored, so startup continues without a restart;
filesystem read failures remain fatal and never trigger replacement. A
configured profile uses
`<base>/.ekko/skills/<profile>` for its skills and
`<base>/.ekko/logs/<profile>` for its log. Its default per-session workspace is
`<base>/.ekko/workspace/<profile>/<session-id>`; an explicitly supplied
`workspaceRoot` or `cwd` takes precedence. The server supplies its Web UI home as
the base directory. Ekko never imports or synchronizes Hermes Skills. During the
first startup after upgrading from the legacy import behavior, the server supplies
the Hermes root only as a read-only inventory: matching non-built-in copies are
removed from Ekko-owned Profile directories, while the Hermes source directories
are never changed. A migration marker prevents later startups from repeating the
cleanup or removing Skills installed afterward.

Skills and persistent SQLite are optional capabilities around a minimal Core.
If bundled Skill synchronization fails, Ekko records a process-local incident,
disables Skill discovery/routing for that Profile, and keeps model dialogue and
packaged built-in tools available. If persistent SQLite cannot initialize or
recover, Ekko uses an in-memory SQLite fallback so chat and storage-backed APIs
do not fail startup. Every run receives current recovery details as temporary
system context; this context is never captured as memory. Built-in repair tools
own the source/target paths and migrations, run a deterministic self-check after
repair, and clear an incident only when the matching revision passes. A repaired
persistent database leaves the current run on ephemeral storage; Ekko Studio
automatically closes that Setup after all active runs finish, so the next run
opens the repaired persistent database. Standalone hosts must recreate their
Setup at the same completed-run boundary.

Each Profile may additionally reference read-only Skill roots through
`skills.profiles.<profile>.externalDirectories`; those directories stay in
place and are never copied into Ekko storage. `disabled` in the same Profile
entry contains Skill names hidden from prompt injection and automatic routing.
Local Skills take precedence over same-name external Skills. For example:

```json
{
  "skills": {
    "enabled": true,
    "reviewEveryToolCalls": 0,
    "profiles": {
      "work": {
        "externalDirectories": ["~/shared-skills", "$TEAM_SKILLS"],
        "disabled": ["weather"]
      }
    }
  }
}
```

Ekko's package-owned built-in skills are the only Skills installed automatically.
Each Profile receives `1password`, `apple-notes`, `apple-reminders`,
`document-to-action-items`, `docx`, `gh-issues`, `github`,
`grok-image-to-video`, `hermes-studio-installation`, `image-gen`,
`node-inspect-debugger`, `obsidian`,
`ocr-and-documents`, `pdf`, `powerpoint`, `python-debugpy`,
`skill-creator`, `spike`, `tmux`, `video-frames`, `weather`, and
`xlsx`. Startup
installs missing built-ins and updates only
an unchanged Ekko-installed copy. A user-edited or pre-existing same-name Skill
is never overwritten. `image-gen` and `grok-image-to-video` use Ekko Studio's
local media endpoints and require a matching configured Studio Profile. The
document Skills bundle their Python helpers, references, tests, and license
notices; optional Python, LibreOffice, Poppler, OCR, and model dependencies are
checked at use time rather than installed during Ekko startup.

```ts
import { EkkoAgent } from 'ekko-agent'

const ekko = new EkkoAgent({
  baseDirectory: '/path/to/base',
  profiles: ['work'],
  config: {
    runtime: { maxSteps: 60 },
    compression: { threshold: 0.6, protectLastN: 16 },
  },
})
ekko.config.setModelProvider('deepseek', {
  type: 'openai-compatible',
  requestStyle: 'openai-chat',
  baseUrl: 'https://api.deepseek.com/v1',
  defaultModel: 'deepseek-chat',
  apiKey: 'sk-...',
})
ekko.config.setDefaultModel('deepseek')

const runtime = ekko.agent.get('work').runtime.create()

try {
  const result = await runtime.run({
    messages: ['Read README.md and summarize it.'],
    toolContext: {
      workspaceRoot: process.cwd(),
    },
    onEvent(event) {
      console.log(event.type)
    },
  })
} finally {
  ekko.close()
}
```

Set `toolsEnabled: false` to omit all tool sources (built-ins, MCP, memory,
and skill tools). Set `skillsEnabled: false` to omit constructor and per-run
skills. The switches are independent and default to `true`.

## Configuration and Models

`new EkkoAgent(options)` is the all-in-one public facade and multi-Profile
container. Every Profile gets an independent Agent instance with bound
`skill`, `tool`, `memory`, `conversation`, `runtime`, `directory`, and `log`
modules. Shared config, model Provider, authorization, and database modules are
also reachable through each Profile Agent. `setupEkkoAgent(options)` returns
the same facade for compatibility with the existing setup style.

Pass `config: EkkoConfigPatch` to either constructor style to apply and persist
installation-wide values before Profile agents and runtime services are
created. Every top-level config section supports nested partial values;
explicit per-run runtime options still take precedence over these defaults.

`setup.config` is an `EkkoConfigStore`. It exposes `read`, `update`, `replace`,
`reset`, MCP server CRUD, provider-preset CRUD, configured-provider CRUD,
authorization CRUD, `installModelProviderPreset`, and `setDefaultModel`. Nested
`update` patches merge at field level, so changing `runtime.maxSteps` does not
replace other runtime settings. `setup.modelProviderConfig()` resolves the
active provider, and `setup.createModelClient()` creates a client without
starting a runtime.

MCP servers live in the same file under
`mcp.profiles.<profile>.servers`. Use `setMcpServer`, `getMcpServer`,
`listMcpServers`, and `deleteMcpServer`; newly created runtimes automatically
load the selected Profile's enabled servers. Local servers use `command`,
`args`, and `env`; remote servers use `type: "streamable_http"`, `url`, and
optional string `headers`. Both transports run through the official MCP client.

The config contains a curated `model.providerCatalog` derived from Hermes
Studio. It includes common API-key providers and the `nous`, `openai-codex`,
`xai-oauth`, `qwen-oauth`, `claude-oauth`, and `minimax-oauth` authorization
providers. Every preset has an explicit `apiMode`; Ekko validates that its
adapter-level `requestStyle` matches instead of relying on endpoint inference.

API-key credentials live in the provider object under `apiKey`. OAuth state
lives under `model.authorizations`. The
`.ekko/config/config.json` file is created with user-only `0600` permissions.
A caller can still pass `apiKey` to `setup.createModelClient()` or
`setup.createRuntime()` to override the persisted value for one process.

```ts
setup.config.update({
  runtime: { maxSteps: 60 },
  model: { reasoningEffort: 'high', maxTokens: 8_192 },
  tools: { codeExec: { enabled: false } },
})

const providers = setup.config.listModelProviders()
const client = setup.createModelClient({ provider: providers[0].id })
```

Install and manage a built-in provider with the exported config-store methods:

```ts
const agent = new EkkoAgent({ baseDirectory: '/path/to/base' })

agent.installModelProviderPreset('openai-codex', {
  defaultModel: 'gpt-5.6-terra',
})
agent.updateModelProvider('openai-codex', {
  defaultModel: 'gpt-5.6-sol',
})
agent.deleteModelProvider('openai-codex')
```

OAuth providers refresh before a request when their configured expiry is
within `model.authorizationRefreshLeewayMs`. Supply a provider-aware refresher
to `setupEkkoAgent`, or configure `tokenUrl`, `refreshToken`, and optional OAuth
client fields to use the exported standard refresh-token implementation.
Refreshes are deduplicated per provider, rotated credentials are persisted,
and refresh failures never fall back to an expiring stale token.

```ts
const setup = setupEkkoAgent({
  authorizationRefresher: async ({ provider, authorization }) => {
    const refreshed = await refreshProviderAuthorization(provider, authorization)
    return {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      baseUrl: refreshed.baseUrl,
      apiMode: refreshed.apiMode,
    }
  },
})

setup.config.setModelAuthorization('openai-codex', {
  type: 'oauth',
  accessToken,
  refreshToken,
  expiresAt,
})

await setup.authorizations.refresh('openai-codex')
setup.config.updateModelAuthorization('openai-codex', { refreshToken: rotatedToken })
setup.config.deleteModelAuthorization('openai-codex')
```

## Sessions and Messages

The standalone database owns Studio-compatible `sessions` and `messages`
tables. `setup.conversations` exposes Session operations `createSession`,
`getSession`, `listSessions`, `updateSession`, `renameSession`,
`setSessionArchived`, `endSession`, `reopenSession`, `deleteSession`, and
`getSessionDetail`. Message operations are `addMessage`, `addMessages`,
`getMessage`, `listMessages`, `updateMessage`, `deleteMessage`, and
`clearMessages`. `recordSessionUsage` accumulates model usage independently of
message edits.

```ts
const session = setup.conversations.createSession({
  profile: 'default',
  provider: 'deepseek',
  model: 'deepseek-chat',
  title: 'Repository review',
})

setup.conversations.addMessage({
  sessionId: session.id,
  role: 'user',
  content: 'Review this repository.',
})

setup.conversations.renameSession(session.id, 'Ekko repository review')
const history = setup.conversations.listMessages(session.id)
```

## Memory

`setup.memory` exposes the standalone memory API. Memory-node operations are
`list`, `get`, `search`, `create`, `update`, `expire`, `delete`, `applyBatch`, and `forget`.
Conversation-derived memory data can be read with `listMessages`,
and `listAuditEvents`. The lower-level SQLite implementation remains available
as `setup.memoryStore`.

Foreground runs write and forget durable memories synchronously through
`memory_write` and `memory_forget`. Prefer `memory_write.operations` when one
request implies multiple changes; the response is terminal (`done=true`) after
the whole batch commits. There is no memory approval queue, review
worker, or background Session-summary pass.

Database migrations are transactional and retry SQLite lock conflicts. A
non-lock migration failure preserves the original database as a timestamped
backup, rebuilds the schema, restores compatible memory/conversation rows, and
rebuilds the memory search index. Ekko never handles migration failure by
silently disabling memory or switching to an untracked temporary database.

```ts
const created = await setup.memory.create({
  kind: 'general_preference',
  itemKey: 'interface_theme',
  reason: 'User selected a persistent preference.',
  explicitUserIntent: true,
  identity: { sessionId: session.id, profileId: 'default' },
  node: {
    valueJson: 'dark',
    title: 'Interface theme',
    content: 'The user prefers a dark interface.',
  },
})

const memories = await setup.memory.list({ profileId: 'default', limit: 20 })
const updated = await setup.memory.update(created.nodeId!, {
  reason: 'User changed the preference.',
  expectedRevision: created.node!.revision,
  identity: { sessionId: session.id, profileId: 'default' },
  node: { valueJson: 'light' },
})

const batch = await setup.memory.applyBatch({
  identity: { sessionId: session.id, profileId: 'default' },
  explicitUserIntent: true,
  operations: [
    {
      operation: 'create',
      kind: 'language_preference',
      reason: 'User selected Chinese.',
      node: { valueJson: 'zh-CN', title: 'Language', content: 'The user prefers Chinese.' },
    },
    {
      operation: 'expire',
      targetId: updated.nodeId!,
      expectedRevision: updated.node!.revision,
      reason: 'The old preference is no longer current.',
      node: {},
    },
  ],
})

// Soft delete is the default; mode: 'hard' deletes immediately as well.
await setup.memory.delete(updated.nodeId!, {
  reason: 'User asked Ekko to forget it.',
  expectedRevision: updated.node!.revision,
  identity: { sessionId: session.id, profileId: 'default' },
})
```

## Skill Evolution

Ekko exposes `skill_manage` to the foreground agent when `skillDirectory` is
configured. Existing files must first be loaded through `skill_view` in the
same run. The mutation is rejected if the file changed after it was viewed.
Overwrites create a recoverable copy under
`.ekko/skills/<profile>/.ekko-backups`, while confirmed skill deletion moves
the directory under `.ekko/skills/<profile>/.ekko-archive`. Synchronized
built-in skills are identified by the Profile manifest and cannot be deleted.

Before the first model response, the runtime injects only the current Profile's
file-backed Skill names. The main model maps requests in any language to one of
those names and calls `skill_view` directly. The host also compares the latest
effective user message with Skill names and compact English
`metadata.keywords`; exact matches are preloaded deterministically through
`skill_view`, producing the same visible tool events as an ordinary Skill load.
Descriptions remain available to `skill_list` for fallback discovery, while
keywords remain host-only and are not returned by `skill_list`.

After 10 cumulative tool calls in one session, the runtime schedules a
background procedural review. The review uses a dedicated conservative prompt
and only `skill_list`, `skill_view`, and `skill_manage`; it does not block the
foreground response. It can create a reusable class-level skill, but can update
only skills marked as created by Ekko and cannot delete. Set
`skillReviewEveryToolCalls: 0` to disable this review or provide another positive
threshold.

## File Logging

Each profile writes structured JSON Lines to one file:
`.ekko/logs/<profile>/ekko-agent.jsonl`. The file is capped at 10 MiB. When the
next event would exceed that cap, the existing content is discarded and
logging continues in the same file; no rotated or per-session files are
created.

Every model-client request attempt writes one terminal `model.request` record after it completes or fails.
That single record combines safe request metadata, status, duration, usage, and
response sizes. Runtime events, streaming deltas, tool events, prompts, and
response bodies are not written, so log volume tracks model calls instead of
the much larger runtime event stream. Optional memory JEV also writes compact
`memory.jev` stage summaries with timings, routing probabilities, thresholds and
sanitized fallback reasons, correlated by session/run/turn. It never logs card
content, query text or credentials.

Endpoints and common credential shapes are redacted, large strings are
truncated, and base64 payloads are omitted. `EkkoFileLogReader.query()` can
filter the current file by session, run, turn, category, level, event, time, or
text without acquiring write ownership. The Hermes Web UI Logs page exposes the
same file as the `ekko-agent` source for the selected profile.

## Commands

```bash
npm install
npm run check
npm test
npm run build
```

## Example

```ts
import { createModelClient } from 'ekko-agent'

const client = createModelClient({
  id: 'deepseek',
  type: 'openai-compatible',
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseUrl: 'https://api.deepseek.com/v1',
  defaultModel: 'deepseek-chat',
})

const response = await client.create({
  messages: [{ role: 'user', content: 'Say hello.' }],
})
```
