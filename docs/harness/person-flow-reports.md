# Collaboration completion reports

`person_flows.state=completed` means every stage saved its result. It does not
mean the creator has saved a summary. `completion_report`, returned by flow
queries, exposes that separate delivery state, attempt, run, saved message and
last error.

The last stage transaction inserts `person_flow_reports` with a unique
`(flow_id,generation,session_id)` key. Its snapshot retains the original goal,
workspace, return expectations and message references. Result text is read from
the originals under current session ownership, both at dispatch and before model
requests. The report continues the existing authorization; result text grants
no new permission.

The Person scheduler claims pending reports and sends them through the creator's
normal session queue, including busy sessions and sessions without a connected
client. Each attempt is fenced separately. `run.started` binds the runtime run
ID before messages can be saved. Only a nonempty final assistant message in
that creator session, with the bound run marker and no tool calls, confirms
delivery. A runtime success event alone cannot confirm it.

A live creator turn that queries a completed flow can claim its outstanding report.
The claim binds that turn’s run ID and fences any older queue item. Its saved final
reply uses the same confirmation gate; an unrelated turn or a participant cannot
claim delivery. A creator query can also retry an exhausted report explicitly.

Failures retry with exponential delay (2, 4, 8, 16 seconds), up to five attempts.
An exhausted report remains visibly failed. Stop persists a paused report,
including when its queued turn is dropped. Only a subsequent user turn resumes
paused reports; restarting Studio does not resume them. An admission rejected
because reporting is paused does not consume the retry budget.

Startup reconciles queued, starting and running receipts. If the final reply
already exists it confirms delivery without another model call; otherwise it
retains a retryable failure. Recovery runs only at startup, so it cannot replay a
live, slow model run. Clearing or deleting a target or source conversation
cancels outstanding reports. Changed flow generations and removed ownership
cannot start a report.

When the final group is a single creator stage, that saved reply confirms
delivery directly. A creator in a parallel group still summarizes all peers.
This also prevents scheduled single-role flows from waking
themselves again. Completion reports do not create new flows. Existing historical
completed flows are not backfilled or replayed on upgrade.

`person_flow_report_events` records completion, queueing, start, saved completion,
failure, pause and cancellation, with the attempt, run ID, message ID, reason and
timestamp. Join its report ID to `person_flow_reports` for the flow, generation
and target session.

Focused verification:

```bash
npm test -- tests/server/person-flow-reports.test.ts tests/server/person-schedules.test.ts --maxWorkers=1
npm run harness:check
npm run build
```

Tests use isolated SQLite state and mocked model execution. They exercise the
real stage completion, worker callback routing, outbox, socket queue, Stop and
history cleanup. They do not mutate production data or establish provider,
push-network or device UI delivery.
