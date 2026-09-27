---
date: 2026-09-27
pr: pending
feature: Bootstrap the Hermes interpreter before accepting bridge requests
impact: Prevent first-chat connection loss after Hermes upgrades replace the Python runtime.
---

Hermes 0.21.5 can re-execute an old virtualenv interpreter into its managed
Python during `hermes_bootstrap` import. Studio previously loaded that module
indirectly during the first `run_agent` import, after the worker had reported
ready and accepted a context-estimation/chat request. Re-execution closes those
sockets, producing `worker closed without a response` followed by connection
refused while the worker restarts.

Run Hermes bootstrap after resolving its source/home and before attribution,
other Hermes imports, or broker/worker readiness. The upstream bootstrap owns
interpreter and dependency selection. Older runtimes without that module keep
their existing startup path; a missing dependency inside an existing bootstrap
must fail startup instead of being treated as a legacy runtime.

No profile/config migration or Hermes source modification is needed. Installed
Studio bridge processes must restart after deploying the fix. Already-failed
chat turns need to be retried.

Regression coverage starts real bridge subprocesses with a fixture bootstrap
that re-executes the interpreter. It verifies bootstrap precedes broker/worker
readiness, the first context/chat requests reach the agent import boundary
without losing their socket, subsequent pings work, and legacy/missing-dependency
cases remain distinct.

Validation: 147 focused bridge/chat tests, `npm run harness:check`, and
`npm run build` passed. A separate temporary profile against the locally
updated Hermes 0.21.5 started with the old Python 3.12 command, became ready
under managed Python 3.14.7, successfully returned `context_estimate`, and
answered a follow-up ping. This smoke check made no model-completion request;
Windows interpreter handoff still needs platform validation.
