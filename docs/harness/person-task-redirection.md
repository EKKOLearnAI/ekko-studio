# Correct a task in its existing conversation

Users send ordinary task messages. The Bot compares each follow-up with the
saved goal and conversation. Compatible additions use the existing FIFO queue.
A replacement instruction stops the current execution and then sends the latest
request in the SAME task, Agent, workspace and native conversation. Never create
or switch to another conversation as part of correction, clear history, or ask
the user to choose an internal mode. Independent verifier sessions and scheduled
occurrences keep their existing lifecycle; they are not correction branches.

POST `/api/studio/person/tasks/:id/chat` uses the owning Bot's model and a
decision-only tool to route input. The model cannot run workers or write memory.
A saved idempotent decision dispatches existing continue/redirect/stop operations.
Stale revisions, invalid/contradictory model output and provider failure do not
silently append a possible correction. Internal Bot follow-ups use structured
task controls; no separate public direction-mode endpoint is needed.

## Stop before sending in the same conversation

One transaction saves the latest goal, title and requirements revision, cancels
old pending inputs and undelivered result callbacks, fences old active runs and
saves one replacement turn with the ORIGINAL execution session_id. It does not
create a session or change native session identity. If a task has never had an
execution conversation, its first turn provisions that single conversation.

The per-task `person_task_redirects` outbox blocks promotion, scheduler claims
and schedule dispatch until old workers, linked verification and active old
result handlers have confirmed termination. Native stop failures retain the
request for retry. The runner also waits for the previous task handler to finish
before claiming another turn, preventing session-level stop operations from
reaching the new request. A sent abort or terminal display event alone does not
satisfy the barrier.

Once released, the runner prepends an authoritative complete current brief to
the latest user input, explicitly superseding conflicting old instructions while
retaining applicable history and artifacts. The visible message is the ordinary
user input, preserving attachment blocks; host routing text stays out of chat.
Old answered questions are not promoted into the new authoritative brief.

Consecutive accepted corrections replace earlier pending requests in the same
session. Version checks and generations reject stale operations and late events.
Idempotent replay cannot replace newer requirements. Compatible additions wait
behind the correction in that same conversation. Explicit Stop cancels the saved
request and never revives it when an earlier stop completes.

Old result callbacks are cancelled and their handlers must unwind. Task changes
recheck callback authorization inside their transaction after asynchronous
capability validation. Independent tasks and newer main-Bot user turns are not
cancelled by a broad main-session stop.

## Conversation and UI continuity

The original conversation remains mounted and its full user/assistant history
stays visible. An earlier execution link preserves its historical receipt and opens the same
chat history; task controls still act on the current execution. A fresh observed revision can submit through that same
conversation after requirements change. No filtering hides correction-created
sessions, and no automatic session-switch code masks a split conversation.
Existing independently started/scheduled conversations remain browsable. A truly
separate obsolete conversation remains read-only; existing split history from the
previous implementation is not silently deleted or merged. A correction-created
empty split session that has never started is blocked before promotion/dispatch;
the saved latest request is retained and its original conversation binding needs
explicit repair. Already executed historical conversations are preserved.

## Boundaries and validation

Ownership, workspace, resource and stage checks remain authoritative. Closed
or expired stage tasks and fixed legacy role routes are not implicitly revived.
Correct the development task, not its linked independent verifier. Acceptance
retains criteria/presets and starts a fresh acceptance snapshot for corrected
requirements; its evidence history is not rewritten.

Main Bot messages still use its existing admission queue while that Bot is busy.
The task input endpoint works independently. Detached external work still relies
on the native runtime's termination guarantee; performed actions cannot be undone
by host cancellation.

Run person-task-redirection and person-task-input service tests, both acceptance
regression suites and person-task-redirection Playwright tests. Check actual
session identity, uninterrupted history/composer, latest authoritative input,
stop/unwind barriers, stale callbacks, retries and same-direction queue behavior.
