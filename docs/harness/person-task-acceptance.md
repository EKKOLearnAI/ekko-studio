# Optional task acceptance with automatic progression

Acceptance is opt-in per Person background task. Newly configured acceptance
uses host-owned automatic progression. Tasks without acceptance retain
the original execution, result callback and completion path.

## Configure

Supply `acceptance: {enabled:true, criteria:["observable check"],
verifier_agent_id:"saved-preset", max_attempts:3, timeout_minutes:30}` on
create/adopt, or configure_acceptance on an open unexecuted task. Criteria (1–20), original goal/request and the
verifier selection are retained. Attempts are 1–5, minutes 1–120. Settings cannot
be weakened/removed after first execution. The routing model interprets explicit
requests such as `写一个html，然后验收一下看好不好看`; confirm activation from
`acceptance_enabled`. Direct API callers must supply their own explicit opt-in.

For a named reviewing Bot such as `让暖暖验收`, resolve the actual account
conversation and set `reviewer_session_id`. This is separate from
`verifier_agent_id`, which selects the execution worker. The linked review task
and its decision callback belong to that Bot. After it records a verdict, the
host durably routes failed product findings to the original developer task for
automatic repair, and returns final results or blockers to its Bot. Do not silently use the developer Bot as the reviewer or create
a duplicate role flow for this acceptance. Other role handoffs keep their normal
flow path. Stage children remain gated by the original development task even
when the reviewing Bot is in a different conversation.

For enabled tasks, `goal` contains product requirements and runnable deliverables
only. Put browser walkthroughs, screenshots, UI reviews and review evidence in
`acceptance.criteria`. The host never appends that list to the developer brief.
Development may perform build checks; independent acceptance is a separate job.

## Automatic progression and task identity

1. The developer executes and returns runnable artifacts. Its execution finishes;
   the overall task stays open until acceptance passes.
2. The scheduler reads the persisted `awaiting_dispatch` state and dispatches the
   linked independent verification task. The assigned reviewing Bot owns this
   task; its worker preset remains separate from its Bot identity. Intermediate
   development callbacks are marked `handled` in the same transaction, so they
   cannot cause a second Bot-driven dispatch.
3. The verifier receives a readable Markdown brief and returns an ordinary
   written report. It explains actual checks, defects, blockers and evidence
   paths. No fixed response format or JSON report is required.
4. The report enters `awaiting_review` and returns to the assigned Bot. That Bot
   reads the full report and evidence and records its content judgment with
   `bot_task_control {action:"record_acceptance",task_ref,
   verification_execution_id,report}`. Only these existing tool arguments are
   structured. Long reports remain available through `bot_tasks_query`
   report_offset pages. Missing evidence can be corrected in the decision or
   explicitly rechecked with verify; it must not trigger developer repair.
5. A recorded failed product verdict creates `repair_required`. The scheduler
   continues the SAME development task and conversation with host-bound defect
   feedback. A repaired result automatically dispatches re-verification using
   the SAME verification task and worker preset, with a fresh execution,
   native identity, evidence directory and report. No Bot routing tool call is
   required for dispatch, repair or re-verification.
6. A validated pass completes both goals and returns the final result to the
   original developer Bot. Blocked/interrupted/failed states stop progression;
   they never create replacement tasks. The round limit and total deadline
   carry across repair rounds. Schedule repairs retain their original occurrence
   identity, and stage children retain their stage binding and completion gate.
7. A reviewing Bot reply without a recorded decision is not completion. The host
   retries the saved report at most three Bot decision turns (including provider
   failures), persisted per verification attempt; this does not rerun the native
   verifier or developer. Exhaustion blocks the task and returns a concrete
   reason to the original Bot. The total acceptance deadline still applies.

The host advances only durable, current states. The existing task operation
revision/execution fences and deterministic operation keys prevent duplicate
work after repeated scheduler calls or restart. Committed but undispatched
transitions survive restart. An in-flight native execution is fenced and needs
explicit continuation; automatic progression does not replay unknown side effects.
Stopping remains available throughout the workflow. Automatic review callbacks
cannot stop/close a task or create substitute work on their own.

Persisted cycles created before automatic progression keep their original Bot
callback contract: `next_action:verify` asks that Bot to dispatch review and
`next_action:repair` asks it to continue the original developer. The verify API
and evidence recheck action remain compatible. No historical state or goal is
silently reopened or rewritten.

The reviewing Bot reconciles every concrete product issue as `repair`,
`resolved` or `out_of_scope`, with a reason. An unresolved issue within the
requested scope requires repair even when described as minor or non-blocking.
The host normalizes a claimed pass containing repair issues into a failed
decision, and SQLite rejects outstanding repair issues in a passed receipt.
Coverage limitations and unrequested features do not become repair obligations;
resolved/out-of-scope classifications must explain the evidence or scope.

The first verifier task is new; subsequent rechecks are additional executions of
that task. Closing it never silently creates a replacement. Explicit reopening
is supported. Do not confuse a task ID with per-round execution/session IDs.
`verification_task_for` in task-tool results identifies the parent; parent chat
acceptance details include `verification_task_id` and all rounds in the cycle.
Both tasks appear in the normal task list.

The host enforces allowed callback routing: a pending acceptance callback cannot
create a normal replacement worker or bypass verification. For persisted
Bot-driven cycles, Bot choosing verify still constitutes the dispatch. If that
Bot fails to dispatch, the goal stays open until the persisted time budget
expires into an explicit blocked reason. Newly configured automatic cycles use
the host scheduler for dispatch and repair.

## Evidence and completion gate

A verifier's output is retained as report text. The host does not parse it as
JSON or infer a verdict from keywords. Bot interprets the complete report and
records `{verdict,summary,checks:[{criterion_id,status,findings,
evidence:[{path,description}]}]}` through the task tool/API. Include every
criterion exactly once in this decision.
Every passed check needs a nonempty real file inside that round's confined
`.studio-acceptance/<development-execution>/<ordinal>/` directory. Host records
realpath, bytes, size and SHA-256 and rejects symlink escape, missing/empty files,
invalid decisions, incomplete checks, abnormal exits and reused native identities.
The decision receipt records the owning Bot session/run and exact verification
execution. Task revision, development revision, verifier identity, report state,
ownership and deadline are checked again when committing a decision.
Cross-Bot decision returns use a separate return identity. Completion/cancellation
from the initial development callback cannot consume a newer review return.
The queue ID is `person-result:<development-execution>:<verification-execution>`
for a cross-Bot decision return, and `person-result:<execution>` for ordinary
returns. Build and parse it through the shared helpers: only the first identity
is the execution lookup key or pending-count exclusion. Keep the optional review
identity in callback admission, tools, model-request guards and settlement.

Activity counts and task rows share the same SQL activity predicate. A developer
waiting for its linked verifier remains open and dependency-locked, but is not
listed as another running developer: the verifier owns that activity. Automatic
dispatch/repair transitions remain visible until their next worker is queued. An
accepted/completed task with a pending or queued report remains visible until
delivery settles. The snapshot supplies `active_tasks` separately from the
recent task page so older pending reports do not vanish from the capsule.

A same-Bot passing review reply includes both the accepted development card and
the verification card. The callback persists the exact accepted development
execution together with the verification receipt; realtime and history use the
same projection. Earlier replies without a recorded pass never gain a development
card retroactively. Cross-Bot callbacks retain their own conversation ownership.

SQLite gates **overall task completion**, requiring the latest development
execution/revision, a finished linked verification execution and its recorded
Bot decision with validated evidence.
Finishing development is not overall completion. Runtime success or the developer
claiming a pass cannot satisfy this gate. A failed verification procedure can
finish its execution while both task goals remain open for repair/recheck.

Attempts and total deadline carry across repair rounds. Each dispatched
review consumes an attempt; correcting invalid Bot tool arguments does not spend
another Agent run. Waiting for Bot review shares the total deadline. The automatic repair loop is bounded by these same persisted limits;
every repair and review has its own visible execution. Exhaustion/blocked/interrupted states retain reasons
and original evidence. An explicit new user continuation after a terminal failure
starts a fresh cycle; background callbacks cannot reset that budget themselves.

## Recovery, stop and compatibility

Queued jobs, awaiting-dispatch callbacks and returned reports awaiting Bot review
survive restart. In-flight
native development/verification is fenced, stopped and recorded interrupted;
explicit continuation is required, never silent replay. Stopping/closing the
parent fences its linked verifier. Late/stale results cannot complete a stopped
or newer task revision. Lost Bot dispatch also has a deadline. Clearing an owned
conversation removes its linked receipts/tasks without affecting other owners.

Schema additions preserve existing rows. Receipts existing before this change
are marked legacy and remain readable; the legacy runner is retained for those
persisted executions, including their former JSON report contract. Previously
validated receipts stay readable. Newly dispatched Bot verification attempts use
ordinary reports and an explicit Bot decision receipt. Newly configured acceptance uses Bot orchestration and a host-owned
`progression:automatic` marker. Existing cycles/configurations without that marker
keep their prior Bot-driven progression contract; internal legacy fixtures
retain legacy orchestration.
No stored user goal or already-dispatched prompt is semantically rewritten.
Previously recorded version-one decisions remain readable without inventing an
issue reconciliation or a named reviewer after the fact. New decisions record
version two, including issue reconciliation and the actual assigned reviewing Bot.

Task details do not display the acceptance expansion panel or
developing/verifying/repairing phase labels at the top. Configuration, criteria,
reports and evidence remain available through the task tools and detail API.
Ordinary execution history/task status remains available.

## Supported scope and limits

Supported: standalone Person background tasks, stage background children and
worker schedule occurrences. Direct role stages, assistant schedules and legacy
next_steps routes reject direct acceptance. Verifier tasks cannot be scheduled
independently. Due worker occurrences treat an unsettled acceptance cycle as busy
and follow the existing skip policy. Parent stages cannot bypass a failed child.

While a new-style acceptance cycle is unsettled, extra development follow-up
queuing and mid-cycle insertion are explicitly rejected; Bot may continue the
original developer after a concrete failed review. This avoids silently replacing
the result under review. Stop/inspect/explicit continuation handles new scope.

Task/role independence is not OS sandboxing: capable Agents may use the same
runtime/model, and artifacts share the authorized workspace. A fresh verifier
session does not prove a model actually viewed an image; judge its evidence and
findings. Natural-language goal splitting remains a model/API caller decision;
only host-generated payload separation, routing and completion gates are hard
invariants. Artifact changes after acceptance need a new explicit cycle.

## Validation

After the legacy test reset, this feature has its own small fixtures and suites:

```bash
npm test -- tests/server/person-acceptance.integration.test.ts tests/server/person-acceptance-automatic.integration.test.ts
npm run test:e2e -- tests/e2e/person-task-return-activity.spec.ts
npm run harness:check
npm run build
```

The server suite uses current Bot task tools and real HTTP, callbacks,
SQLite, evidence files and a Node assertion subprocess. It covers same-task
rechecks/repairs, ordinary reports, paged report reading, Bot decision/evidence
validation, completion gates, bounded failures, stop and
restart recovery, worker occurrences and stage children. A single explicitly
persisted legacy receipt checks compatibility; the fixture never changes the
default parser to legacy mode. Model/runtime dispatch is stubbed, with no real
provider calls or live user task writes.

The automatic progression suite uses the same real Bot tool contract for content
decisions, while the host alone dispatches review, repair and re-verification.
It covers same-Bot and named-reviewer loops, duplicate scheduler calls, restart,
decision retries, budgets, explicit stop, environment/provider blockers, stage
children, schedule occurrence identity and pending-history/activity guards.
Compatibility fixtures remove only the automatic marker to represent earlier
persisted cycles; automatic fixtures exercise the current default parser.

The browser suite mounts the actual task activity capsule in a feature-local Vite
harness. It checks that accepted tasks remain visible while reporting, that the
row is inside the expanded capsule, that clicking keeps the original task and
execution IDs, and that the capsule disappears after delivery. It does not prove
a real native developer/verifier run. Set TASK_RETURN_EVIDENCE_DIR to save the
capsule screenshot. The removed task-detail acceptance expansion is not mounted.
