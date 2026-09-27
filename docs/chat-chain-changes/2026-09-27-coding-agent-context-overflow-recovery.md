---
date: 2026-09-27
pr: pending
feature: Recover coding-agent sessions after normal Codex turns exceed context
impact: Keep Studio history and workspace usable instead of repeatedly resuming an oversized native Codex thread.
---

When a normal scoped Codex turn fails with a recognized context-window error,
Studio now detaches the oversized native session, marks the in-memory runner for
disposal after the failed turn is persisted, and tells the user that the next
message will continue in a fresh Codex context. The visible Studio Session,
history, selected provider/model/API mode, and workspace remain unchanged.

This extends the existing native `/compact` overflow recovery to the regular
turn-failure path. Recoverable Codex stream errors remain provisional until the
child exits non-zero; successful retries keep the original native session.
Non-context failures and sessions without a persisted native ID are unchanged.

Regression coverage verifies that an authoritative non-zero Codex exit with
`context_length_exceeded` clears both the persisted and in-memory native IDs,
disables resume, disposes the stale runner after terminal persistence, emits the
recovery notice, and still records the failed turn. It also verifies that a
provisional context error followed by exit code `0` keeps the native session.

Validation: 120 focused coding-agent tests, `npm run harness:check`, and
`npm run build` passed.
