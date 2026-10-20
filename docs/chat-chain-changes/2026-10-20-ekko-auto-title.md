# Studio AI conversation titles across Agent runtimes

## Problem

Native Ekko and external coding-agent completion paths did not schedule Studio AI titles. Hermes had its own producer, but the bridge used a removed positional argument, accepted only a one-argument callback, swallowed failures, and stopped polling after the first nonempty derived placeholder.

## Studio contract

| Runtime | Producer | Automatic model selection |
| --- | --- | --- |
| Native Ekko | Shared Studio title service | Reuse the authorized session model client |
| Codex, Claude Code, Pi, Grok and other external coding runtimes | Shared Studio title service after a successful persisted turn | Profile default model, never assume CLI-native model IDs or credentials are HTTP-compatible |
| Hermes bridge | Hermes native generator, adapted to old/new signatures | Hermes auxiliary title settings; Studio must not issue a duplicate generation request |

Explicit auxiliary provider/model selections go through the existing authorized runtime resolver. The enabled/model-upgrade switches are honored. Group-chat rooms and workflow node names keep their separate naming policies.

## Safety and synchronization

- Native/CLI title requests are detached from foreground completion, tool-free, deadline-bound, deduplicated, and limited to two persisted attempts.
- Studio-owned schema synchronization adds title provenance and an attempt budget. Conditional updates protect manual/AI titles using exact Agent/source identity, history revision and message anchors.
- Hermes compatibility is detected with `inspect.signature`, not version guesses or retrying an internal `TypeError`. Both `(title)` and `(title, source)` callbacks are accepted, and unstarted native upgrade threads are started once after the main turn.
- Hermes generations are bound to a run and session identity. A guarded native title DB proxy blocks obsolete producers; callbacks and polling carry the producer run ID.
- Polling reads an atomic cached callback record rather than pairing independent title/source reads. Legacy native database titles have no claimed AI provenance.
- Derived placeholders remain replaceable while Studio polls for the final LLM upgrade. Renames, clears, recreation and stale generations invalidate writes.
- Provider exceptions, keys and prompts are not included in failure logs.

## Validation

- 263 related Vitest tests passed, including Agent completion, title policy, Hermes polling, and queue regressions.
- 20 Python compatibility/provenance/generation tests passed without requiring an installed Hermes or external provider.
- Repository harness, service TypeScript checking and server bundle build passed with isolated build dependencies.
- Real-model title-service checks generated and persisted AI titles for five synthetic completed histories (Ekko, Codex, Claude Code, Pi and Grok) in an isolated database. These validate the real shared producer, not five real CLI process end-to-end runs.

The separate HTTP chat-run transport authentication issue observed during an earlier acceptance attempt is not claimed fixed by this title change.
