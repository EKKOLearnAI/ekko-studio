# Coding Agent services

`packages/server/src/modules/coding-agents/` is the implementation home for
managed Claude Code, Codex, Pi, and Grok runs. The services share one canonical event
pipeline, one stream subscription model, and one persistence path while keeping
agent-specific process and protocol behavior in named subdirectories.

The Coding family also includes OpenCode, DSH, Cursor, Antigravity, and the
[six native CLI integrations](native-coding-agents.md). Each runtime has its own
`services/<id>/` directory. The shared `protocol/acp/` adapter serves Qwen, Kimi,
CodeBuddy, Qoder, and Copilot; `services/zcode/` owns the official ZCode headless
JSONL protocol. Qwen, Kimi, CodeBuddy, Copilot,
and ZCode support isolated scoped model configuration and native global mode.
Qoder remains global. All six share the same run manager, event persistence,
group-chat and Workflow dispatch.

## Goals

- Provide shared protocol plumbing that can be used by:
  - Claude Code and Codex local proxy routes.
  - Pi RPC turns.
  - Grok headless `streaming-json` turns.
  - Hidden Coding Agent sessions launched from the Web UI Chat surface.
- Normalize upstream provider streams into one internal event shape.
- Let subscribers consume the same stream for HTTP/SSE responses, Socket.IO
  events, database persistence, usage accounting, and logs.
- Keep existing session storage under the current Web UI SQLite session tables.
- Keep Koa route handlers thin.

## Non-goals

- Do not rewrite the Hermes bridge runner in the first pass.
- Do not change the sessions/messages schema until a missing field is proven.
- Do not mix provider credential storage changes into the first refactor.
- Do not make one large class that owns Koa, Socket.IO, provider fetches, and DB
  writes at the same time.

## Current layout

```text
modules/coding-agents/
  contracts/               definition and configuration-file contracts
  protocol/                provider bridge, stream utilities, ACP sessions
  services/
    index.ts               public install/config/launch facade
    registry/              definitions and native adapter composition
    runtime/               shared managed-run and process lifecycle
    claude-code/           Claude Code definition and proxy
    codex/                 Codex definition, proxy, compaction and usage
    pi/                    Pi definition, RPC parsing and thinking levels
    grok/                  Grok definition, config, turns and events
    opencode/              OpenCode definition, config, turns and events
    dsh/                   DSH definition, configuration and ACP/Web adapters
    cursor/                Cursor definition, settings, turns and events
    antigravity/           Antigravity definition, config, turns and events
    qwen/                  Qwen definition and scoped configuration
    kimi/                  Kimi definition and scoped configuration
    codebuddy/             CodeBuddy definition and scoped configuration
    qoder/                 Qoder definition for the shared ACP transport
    copilot/               Copilot definition and scoped configuration
    zcode/                 ZCode definition, install discovery, config and JSONL
```

- `claude-code/proxy.ts` exposes an Anthropic-compatible local proxy for Claude
  Code.
- `codex/proxy.ts` exposes a Responses-compatible local proxy for Codex and Pi.
- `pi/jsonl-parser.ts` decodes Pi's RPC stdout stream.
- `grok/` owns Grok's isolated `GROK_HOME`, prompt-file launches, and
  `streaming-json` event adaptation.
- `protocol/provider-policy.ts` owns the scoped Coding Agent Provider allow/deny
  boundary used by launches and Workflow capability checks.
- `runtime/run-manager.ts` owns managed Claude Code, Codex, Pi, and Grok process
  lifecycle for chat-driven Coding Agent sessions.
- `index.ts` is the public facade for installation, configuration, and launch
  preparation. Consumers should not reach into an agent-specific directory.
- `run-chat/handle-bridge-run.ts` is the active Web UI Hermes bridge path.
- `run-chat/handle-api-run.ts` already contains a Responses-stream persistence
  path, but it remains separate from the Coding Agent runner.
- `run-chat/response-stream.ts` already maps Responses events into in-memory
  session messages and flushes assistant/tool messages to the DB.

## Architecture

Use Responses-style stream events as the canonical internal event format.

```
Provider protocol
  -> ProtocolAdapter
  -> CanonicalAgentEvent stream
  -> Subscribers
       -> HTTP SSE serializer
       -> Socket.IO emitter
       -> DB persistence subscriber
       -> Usage subscriber
       -> Debug/log subscriber
```

### Components

#### TargetRegistry

Owns local proxy targets and internal run targets.

Responsibilities:

- Normalize provider/model/base URL/api mode.
- Generate route keys and local proxy tokens.
- Keep upstream API keys out of launched agent config files.
- Optionally bind a target to profile/session metadata.

#### EndpointResolver

Builds upstream endpoint URLs for each API mode.

Responsibilities:

- Avoid duplicated URL rules in Claude and Codex proxy services.
- Support base URLs that already include API roots such as `/v1`,
  `/v1beta/openai`, `/api/paas/v4`, or `/openai`.
- Build paths for `chat/completions`, `responses`, and `messages`.

#### ProtocolAdapter

Converts request and stream shapes.

Initial adapters:

- `anthropic_messages <-> canonical responses events`
- `chat_completions <-> canonical responses events`
- `codex_responses <-> canonical responses events`

The adapter layer must not know about Koa, Socket.IO, or SQLite.

#### AgentRunGateway

The facade used by routes and internal chat code.

Responsibilities:

- Accept an `AgentRunRequest`.
- Select the correct target and adapter.
- Call upstream with `fetch`.
- Yield `CanonicalAgentEvent` values.
- Respect abort signals.
- Surface provider errors in one structured shape.

#### StreamSerializers

Serialize canonical events for client-specific protocols.

Initial serializers:

- Responses SSE for Codex.
- Anthropic Messages SSE for Claude Code.
- Socket.IO event payloads for Web UI chat.

#### RunPersistenceSubscriber

Consumes canonical events and writes to existing session tables.

Responsibilities:

- Create sessions when needed.
- Insert user messages once.
- Accumulate assistant text deltas.
- Insert assistant tool calls and tool results.
- Update session stats and usage at terminal events.

This should reuse or extract the existing behavior from
`run-chat/response-stream.ts`.

## Canonical Event Contract

The internal stream should preserve the subset of Responses events already used
by `run-chat/response-stream.ts`:

- `response.created`
- `response.output_text.delta`
- `response.output_text.done`
- `response.output_item.added`
- `response.function_call_arguments.delta`
- `response.output_item.done`
- `response.completed`
- `response.failed`

Each event should carry:

- `type`
- `response_id` or `run_id` when available
- `model`
- `output_index` and `item_id` when applicable
- `usage` on terminal events when available
- provider error details on failure events

## External Proxy Flow

Claude Code:

1. Route authenticates local target token.
2. Route passes Anthropic request body to `AgentRunGateway`.
3. Gateway normalizes upstream output to canonical events.
4. Optional persistence subscriber records the run when session metadata exists.
5. Route serializes canonical events back to Anthropic SSE or JSON.

Codex:

1. Route authenticates local target token.
2. Route passes Responses request body to `AgentRunGateway`.
3. Gateway normalizes upstream output to canonical events.
4. Optional persistence subscriber records the run when session metadata exists.
5. Route serializes canonical events back to Responses SSE or JSON.

## Internal Web UI Flow

1. Chat creates or reuses a managed Coding Agent session.
2. The session launches Claude Code, Codex, Pi, or Grok in the existing scoped
   `profile/provider/agent` config/workspace layout.
3. Chat input is sent to the agent process.
4. The process calls a local Claude/Codex-compatible proxy instead of the upstream
   provider directly.
5. The proxy tees provider SSE: one branch goes back to the CLI, the other is
   normalized to canonical Responses events for DB persistence and Chat events.
6. Claude Code and Codex sessions are recycled after 30 minutes of inactivity
   and on service shutdown. Pi restores native session state into a fresh RPC
   process for each turn. Grok runs one headless CLI process per turn and resumes
   the native Grok session on later turns.

## Session Binding

External proxy requests do not naturally know the Web UI session. The first
implementation should support optional binding in this order:

1. Target metadata created during agent launch.
2. `X-Hermes-Session-Id` request header.
3. Request body metadata, only for internal callers.

If no session ID is present, the proxy should not write to the chat DB.

## Security Rules

- Never persist upstream API keys in launched Claude/Codex/Grok config files.
- Keep local proxy tokens per route target.
- Do not accept arbitrary session writes without validating target token first.
- Do not let external request bodies override upstream provider/model unless the
  target explicitly allows it.

## Migration Plan

### Phase 1: Shared utilities

- Extract target registration/token validation.
- Extract endpoint URL building.
- Extract SSE frame parsing and make it CRLF-safe.
- Add focused tests around URL building and SSE parsing.

Status:

- Added `shared/target-registry.ts`, `shared/endpoint-resolver.ts`, and
  `shared/sse.ts`.
- Moved proxy implementations under `claude-code/` and `codex/`.
- Updated `run-chat/sse-utils.ts` to reuse the shared CRLF-safe parser.
- Removed the old `services/agent-runner/` import surface.

### Phase 2: Canonical adapters

- Move existing Claude/Codex conversion functions behind adapter interfaces.
- Keep old route behavior unchanged.
- Add tests that compare old route output to adapter output.

Status:

- Added `shared/adapters/responses.ts` for non-streaming Codex proxy conversions:
  - Responses request body to OpenAI Chat request body.
  - Responses request body to Anthropic Messages request body.
  - OpenAI Chat response to Responses response.
  - Anthropic Messages response to Responses response.
- Added `shared/adapters/responses-stream.ts` for streaming Codex proxy conversions:
  - OpenAI Chat SSE to canonical Responses events.
  - Anthropic Messages SSE to canonical Responses events.
  - Native Responses SSE to canonical Responses events.
- Added `shared/adapters/anthropic.ts` for non-streaming Claude proxy conversions:
  - Anthropic request body to OpenAI Chat request body.
  - Anthropic request body to OpenAI Responses request body.
  - OpenAI Chat response to Anthropic message.
  - OpenAI Responses response to Anthropic message.
- Added `shared/adapters/anthropic-stream.ts` for streaming Claude proxy conversions:
  - OpenAI Chat SSE to Anthropic Messages events.
  - OpenAI Responses SSE to Anthropic Messages events.
- Added focused adapter tests.
- Codex proxy stream-state adapters now live outside the proxy file.
- Claude proxy non-streaming adapters now live outside the proxy file.
- Claude proxy stream-state adapters now live outside the proxy file.

### Phase 3: Gateway facade

- Add `AgentRunGateway.stream()` and `AgentRunGateway.complete()`.
- Make Claude and Codex proxy routes call the gateway.
- Preserve existing auth responses and model endpoints.

Status:

- Added `shared/gateway.ts` with `completeJson()` and `streamBytes()`.
- Gateway centralizes upstream POST, bearer auth, provider JSON error parsing,
  and empty stream checks.
- Codex proxy now uses the gateway for non-streaming and streaming upstream
  calls.
- Claude proxy now uses the gateway for non-streaming and streaming upstream
  calls.

### Phase 4: Persistence subscriber

- Extract DB persistence from `run-chat/response-stream.ts`.
- Add optional persistence to proxy requests when session metadata is present.
- Add tests for assistant text, tool call, tool result, usage, and failure.

Status:

- Internal Web UI API runs reuse the existing `run-chat/response-stream.ts`
  persistence path by consuming canonical Responses events.
- External proxy request persistence remains intentionally disabled until
  session binding is added.

### Phase 5: Internal API run

- Keep `handleApiRun` separate from Coding Agent execution.
- Add a dedicated hidden Coding Agent runner class.
- Launch Claude/Codex with scoped provider config and local proxy targets.
- Capture proxy SSE into Chat DB and realtime events.

Status:

- Added `runtime/run-manager.ts` with managed process start/send/stop,
  idle recycling, turn-scoped Pi execution, and shutdown cleanup.
- `prepareCodingAgentLaunch()` can bind proxy targets to an `agentSessionId`
  and Chat `sessionId`.
- Codex now routes `codex_responses` providers through the local proxy too, so
  native Responses streams can be captured.
- Added protected API helpers for hidden run start, input, and stop.

### Phase 6: Cleanup

- Thin `claude-code-proxy.ts` and `codex-proxy.ts` into route adapters.
- Remove duplicated conversion and SSE parsing code.
- Revisit naming and export boundaries.

## Implementation Notes

Gateway adoption is complete for the current proxy and internal API-run paths:

- Claude and Codex proxy route handlers remain responsible for local auth, Koa
  response shape, and target lookup.
- `AgentRunGateway` owns upstream POSTs, bearer auth, stream validation, and
  provider error shape.
- `run-stream.ts` chooses the provider protocol and returns canonical Responses
  events to Web UI runs.
- Persistence stays optional and disabled for external proxy requests unless a
  session binding is provided.

Compatibility constraints:

- Claude Code expects Anthropic-shaped errors and Messages SSE events.
- Codex expects OpenAI/Responses-shaped errors and Responses SSE events.
- Pi expects LF-framed RPC JSONL and uses `agent_settled` as the authoritative
  turn boundary.
- Some OpenAI-compatible providers expect `/v1/chat/completions`.
- Some providers already include a non-`/v1` OpenAI root path in `baseUrl`.
- Endpoint resolver behavior should be driven by provider-preset tests, not
  only regexes.

The next safe extraction is a persistence subscriber for external proxy request
session binding. Internal Web UI runs already persist through
`run-chat/response-stream.ts`.

## Validation

Minimum checks for each phase:

- Focused server tests for changed services.
- `npm run test -- tests/server/coding-agents-launch.test.ts`
- `npm run test -- tests/server/run-chat-content-blocks.test.ts` when touching
  chat input conversion.
- `npm run build` before merging shared TypeScript contracts.
