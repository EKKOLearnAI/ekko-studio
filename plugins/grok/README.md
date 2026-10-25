# Studio Grok plugin

Independent native Grok Build adapter. The artifact bundles the public Studio SDK/agent drivers and TOML parser; it does not import Studio server/client code.

The native CLI is pinned to `@xai-official/grok@1.0.70`. Its npm install uses a host-owned installer home and `GROK_HOME`; Unix uses the package's native executable, while Windows still requires platform acceptance of the npm launcher. Native account login remains `grok login`.

Each instance has a private shadow `GROK_HOME`. Global mode copies the user's native auth, policies, config, instructions and extension resources without editing the source home; `HOME` stays native. Scoped mode keeps editable native preferences, instructions and imported Skills in persistent `grok-resources`, separate from the generated `grok` runtime overlay and its session history. Source defaults are imported once without account credentials; later edits and Skill deletion survive new turns and restart. Shared read-only Skills remain a separate source. Scoped execution uses a private home and a Responses gateway, preserving non-routing settings and MCP. Gateway credentials exist only in the child environment. Conflicting project or managed model routing fails before native input. Native project instructions, MCP, plugins and permissions remain native-owned.

Turns use `--prompt-file`, JSON content blocks for images, `--session-id` for new sessions and explicit `--resume` for persisted sessions. A checkpoint requires `end_turn`, the same session identity, exit code zero, native history and confirmed cleanup. Missing history is an error. Any observed process, gateway or prompt cleanup failure makes that runtime unavailable even when a later retry finishes. Outstanding cleanup is retried by disposal; the checkpoint is committed after cleanup and a final cancellation check. Cancellation disposes the managed process and prompt file before admitting another turn.

The adapter retains the previous integration's `--always-approve` behavior and declares approvals/clarifications unsupported. Grok 1.0.70 retains its original rule snapshot during resume, including when `--rules` changes. Ordinary resumed turns therefore receive current editable instructions as explicit turn context in the native prompt file; this preserves native history and does not replace cached system/user rules. Slash commands retain their exact native arguments and cached-rule limitations. The native command catalog is relayed to Studio; `/compact` requires an existing conversation and remains a native operation. Grok 1.0.70 rejects degenerate summaries and can reject native commands; these remain failed Runs. SSE MCP is explicitly unsupported; stdio and HTTP MCP are supported.

Global native input usage excludes cached input, so the adapter adds cache reads/writes into total input and reports cache/reasoning breakdowns. Native per-model totals replace aggregates only when input, output and cache totals agree; inconsistent multi-model ledgers are not falsely charged to the configured alias. Scoped accounting belongs to the host gateway. Grok 1.0.70's explicit compaction terminal event omits summary usage, and title/background calls are not exposed consistently in the headless ledger; global complete usage parity remains open.

Management inspection runs `--version`/`models` under a disposable working directory and Home, with a credential-free copy of model catalog configuration. It neither copies native auth nor infers the real account status from this shadow; authentication stays unknown. Native `models` otherwise creates metadata/logs/session indexes and modifies configuration, so the original Home is never used for that probe.

Focused worker tests run normally. Optional real native tests use a temporary home and local model/MCP servers:

```sh
STUDIO_GROK_BINARY=/absolute/pinned/grok npx vitest run tests/server/studio-grok-plugin.test.ts
STUDIO_GROK_INSTALL=1 npx vitest run tests/server/studio-grok-plugin.test.ts
```

The second opt-in downloads the pinned npm package into host-managed private staging and verifies its binary version. It never logs into a native account.
