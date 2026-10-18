---
date: 2026-09-20
pr: pending
feature: Android task notification progress
impact: Single-chat notification state and reconnect snapshots use the same turn identity as task cards.
---

The unified notification subscription introduced in #3093 used `SessionState.runId`
for `chat.run.updated` and for selecting persisted task cards. Coding-agent runtime
IDs can span turns, while task cards use `activeRunMarker` or
`responseRun.runMarker`. Android rejects a card whose `run_id` differs from the
monitored run. Consequently, live progress was discarded and reconnect snapshots
omitted the current card.

Both notification paths now select the current turn marker before falling back
to the runtime ID. Snapshot filtering still excludes cards from previous turns.
The Android protocol and application sources are unchanged; the correction takes
effect when Studio loads the rebuilt server.

Validation: the two regression cases failed before the fix and passed afterward.
The focused server suite passed 58 tests; the repository harness, server type
check, and server bundle build passed. Android notification state and service
tests passed using the current native sources. The connected vivo's existing
notification had no progress extras before deployment; on-device verification
with the rebuilt Studio server remains outstanding.
