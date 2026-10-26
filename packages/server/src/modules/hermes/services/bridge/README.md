# Agent Bridge

Backend-side bridge for talking to Hermes Agent by instantiating
`run_agent.AIAgent` directly in a Python process.

Hermes chat, context estimation, and MCP management use this bridge. Plugin
management uses a separate short-lived Python probe with the same interpreter
resolver.

Workers bind their profile home and environment before importing Hermes or its
bootstrap. Bootstrap must finish before any socket reports ready, since Hermes
upgrades can replace the interpreter and dependency environment. Configuration
reads prefer Hermes' YAML adapter, with PyYAML support for older installations.
Shutdown sends directly to the existing worker socket: the normal request path
can start a worker and must not be used while stopping one.

## Python Service

Python bridge code lives under `python/` so it stays separate from the Node/TS
bridge client and manager code. The executable entrypoint is
`python/hermes_bridge.py`, and the implementation is split across sibling
Python modules:

- `bridge_runtime.py` - environment, config, import discovery, JSON helpers.
- `bridge_pool.py` - in-process agent sessions, runs, callbacks, approvals.
- `bridge_server.py` - worker-side request handling.
- `bridge_transport.py` - socket protocol and worker process helpers.
- `bridge_broker.py` - broker-side profile worker routing.

```bash
python packages/server/src/modules/hermes/services/bridge/python/hermes_bridge.py
```

Default endpoint:

```text
ipc:///tmp/hermes-agent-bridge.sock
```

On Windows, the default endpoint is TCP because Python may not support Unix
domain sockets there:

```text
tcp://127.0.0.1:18765
```

Override with:

```bash
HERMES_AGENT_BRIDGE_ENDPOINT=tcp://127.0.0.1:8765 python packages/server/src/modules/hermes/services/bridge/python/hermes_bridge.py
```

Profile workers use the same platform defaults: TCP on Windows and IPC on
macOS/Linux. Override worker transport with:

```bash
HERMES_AGENT_BRIDGE_WORKER_TRANSPORT=tcp HERMES_AGENT_BRIDGE_WORKER_PORT_BASE=18780 python packages/server/src/modules/hermes/services/bridge/python/hermes_bridge.py
```

The service discovers Hermes Agent in this order:

1. `--agent-root`
2. `HERMES_AGENT_ROOT`
3. the installed `hermes` command path
4. current working directory and parent directories
5. common locations such as `~/.hermes/hermes-agent`, `~/hermes-agent`, and `/opt/hermes-agent`
6. the `hermes-agent` package installed in the selected Python environment

Hermes home is resolved from `--hermes-home`, `HERMES_HOME`, then `~/.hermes`.

Default agent root:

```text
~/.hermes/hermes-agent
```

You can pass both paths explicitly:

```bash
python packages/server/src/modules/hermes/services/bridge/python/hermes_bridge.py \
  --agent-root ~/.hermes/hermes-agent \
  --hermes-home ~/.hermes
```

If no source checkout containing `run_agent.py` is found, the bridge falls back
to importing `run_agent` from the Python environment. This supports package
installs such as `pip install hermes-agent`. The Node manager prefers the source
checkout's virtualenv when a checkout exists, then the Python interpreter from
the installed `hermes` command, then the system Python.

The socket transport uses Python and Node standard libraries. No ZMQ dependency
is required.

## Backend Usage

```ts
import { AgentBridgeClient } from './modules/hermes/services/bridge'

const bridge = new AgentBridgeClient()
// Select this policy when the cached Hermes AgentSession is first created.
// contextEstimate may be the creation boundary before the first chat call.
await bridge.contextEstimate(
  sessionId,
  [],
  instructions,
  profile,
  { background_delegation_enabled: false },
)
const run = await bridge.chat(sessionId, message, undefined, instructions, profile, {
  // Creation fallback if chat is the first Bridge operation for this session.
  background_delegation_enabled: false,
})

for await (const chunk of bridge.streamOutput(run.run_id)) {
  if (chunk.delta) {
    // forward chunk.delta to Socket.IO/SSE/etc.
  }
}
```

To stop only the foreground run at a Hermes-owned safe boundary, bind the
request to the active Bridge run ID:

```ts
const boundary = await bridge.requestBoundaryInterrupt(
  sessionId,
  run.run_id,
  profile,
)
```

The model phase is interrupted immediately. An in-flight `_execute_tool_calls`
batch is allowed to finish before Hermes starts another model request. The
Bridge checks the installed Hermes runtime before enabling this capability and
returns `status: 'unsupported'` with `guarantee: 'none'` when its private
whole-batch boundary is incompatible; it never falls back to the broader user
stop that also interrupts tools and detached subagents.

The external chat call only sends `session_id` and `message`. Provider, model,
keys, tools, reasoning, and session DB are resolved by hermes-agent from the
normal Hermes config and environment.

`background_delegation_enabled` is an Agent-session creation setting. It is
optional and defaults to `true` for Bridge consumers that do not select a
policy. The created `AgentSession` retains the value, and later runs bind the
Hermes context from that cached setting instead of changing it per turn.
Passing `false` binds `async_delivery=false`, so `delegate_task` remains
available but requests for background execution fall back to the synchronous
path. Hermes currently exposes this as its session-level async-delivery
capability, so other detached-completion tools in that AgentSession also see it
disabled.

Hermes Web UI creates ordinary single-chat agents with this value set to
`true`, enabling background task delivery by default. Group-chat agents and
Hermes workflow-node agents set it to `false` at their own call sites and remain
intentionally disabled. Coding Agent and Ekko Agent calls do not receive this
Hermes Bridge field.

The bridge instantiates `AIAgent` with `platform="cli"` by default so behavior
matches CLI chat. Override it only if a caller intentionally needs a distinct
platform identity:

```bash
HERMES_AGENT_BRIDGE_PLATFORM=agent-bridge python packages/server/src/modules/hermes/services/bridge/python/hermes_bridge.py
```

### Completed run usage

The bridge `model.usage` hook supplies per-request token buckets and `api_duration`
in seconds. Studio records each request once under its request identity, and also
stores the parent run identity. At completion, `run_usage` contains that run's
input (including cache reads/writes), output, cache-read tokens, cache hit rate, USD cost and
weighted speed: total output tokens divided by total model request seconds.
Model time includes first-token latency and excludes tools and user interaction.
Coding Agent proxies time provider requests, including the first-token wait.
Native CLI API durations are used when available. If any request duration is
missing, Coding Agents estimate output tokens / (foreground turn time − tool
execution time), persisting `run_duration_seconds` and `tool_duration_seconds`.
The tool time is the union of complete native execution intervals; parallel and
nested tools are counted once. Claude argument generation is excluded from tool
time, and OpenCode uses the native tool timestamps. The UI labels this
`speedSource: 'estimated'`: startup, network and other overhead still remain.
Missing tool boundaries retain the whole-run average (`speedSource: 'run'`)
instead of guessing a duration. A nonpositive remaining duration yields `null`.
The turn timer resets on each send, even when the CLI process is reused, and
freezes at completion. Unknown token counts or missing
timing still yield `null`; partially missing prices also remain `null`.
Each completed run is stored once in `run_usage`, keyed by `(session_id, run_id)`,
with its exact assistant message ID and completion/update timestamps. History and
resume read this table directly. Late usage or catalog prices update the stored
summary. Cache hit rate is total cache-read tokens / total input tokens for the
run (a fraction in [0, 1]); zero or unknown total input yields `null`. Cache writes
count toward input, never toward hits. No legacy-table migration is needed.
The UI displays this non-expandable card above the turn's file changes, after
completion only. The thinking indicator carries no token speed.
