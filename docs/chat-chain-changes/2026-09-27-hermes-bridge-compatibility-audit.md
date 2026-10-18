---
date: 2026-09-27
pr: pending
feature: Correct bridge worker lifecycle and runtime initialization
impact: Prevent replacement workers during shutdown and load the intended profile before Hermes imports.
---

The Hermes 0.21.5 compatibility audit found three additional problems after
the bootstrap and YAML fixes:

- `WorkerProcess.stop()` cleared its process reference, then used `request()`
  to send shutdown. That method starts a worker when none is referenced, so
  shutdown could launch a replacement that competes for the same endpoint.
  Send directly to the existing socket and serialize shutdown/endpoint cleanup
  with startup under the worker lock.
- Non-default workers imported Hermes before binding their profile home and
  dotenv. Bind those first, clearing sibling/default profile dotenv keys using
  the existing isolation policy. Refresh terminal YAML after bootstrap makes
  the selected runtime's dependencies available. This ordering also survives
  interpreter re-execution.
- Plugin discovery runs outside the persistent bridge and lacked the Hermes
  bootstrap. It could use an obsolete interpreter or fail to activate managed
  dependencies. Bootstrap before plugin imports and prefer `hermes_yaml` for
  both config and manifest metadata, retaining legacy fallbacks only when the
  respective upstream module is absent.

The audit checked the Python broker, transport, runtime, pool, worker handler,
Node manager/client contracts, and plugin probe. All 63 upstream import symbols
were checked against the installed runtime: the only absent symbol belongs to
the already-supported legacy MCP-loop fallback. AIAgent constructor and SessionDB
call keywords matched current signatures. Existing regression coverage exercises
streaming, resume, approvals, clarification, model/provider switching, compression,
MCP imports/filtering, background completion, and interruption.

New regression coverage catches shutdown auto-start without mocking away the
request method, validates profile selection across a real interpreter re-exec,
and exercises native/legacy plugin bootstrap, config inheritance, and manifest
metadata. The endpoint tests now set their own worker port/transport environment;
the previous failure came from inheriting the desktop's custom port base.

A real Hermes 0.21.5 probe against a local simulated model completed two streamed
turns, returned context estimation, and persisted exactly user/assistant/user/
assistant in a temporary database. External connections were blocked in the probe.
Real plugin discovery handed off from the old Python 3.12 to managed Python 3.14.7
and returned 104 plugins without YAML warnings (268 warnings before the YAML fix).

Validation completed:

- 277 focused bridge/plugin tests passed, followed by 49 lifecycle/bootstrap
  tests after adding the real worker-stop regression and shutdown lock.
- `npm run harness:check` and `npm run build` passed.
- The actual development server on port 8647 returned HTTP 200 for MCP servers
  (five entries) and plugins (104 entries, zero warnings). Final bridge reload
  completed successfully and the previous workers exited.
- Full coverage run: 6,363 passed, 58 failed, 14 skipped. An unchanged pre-audit
  checkout reproduced every one of those 58 failures (65 failures there in total,
  including the inherited port-test environment issue). No newly failing test
  names appeared in the changed checkout. These unrelated failures remain open.
- Full browser run: 246 passed, one session-category retry notification test
  failed. The same case failed when rerun individually, including on a fresh
  port/cache, while the unchanged pre-audit checkout passed the isolated case.
  That current-environment browser failure remains unresolved; no client code
  changed in this audit, and it is not classified as a proven baseline failure.

Windows-specific process handoff and provider network behavior still require
platform/live-provider validation. This audit does not claim compatibility with
future Hermes API changes or update the separately installed desktop bundle.
