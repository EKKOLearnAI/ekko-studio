# Person context assembly

## Conversations and routing

Person conversations have independent generated `person-main-<uuid>` IDs and user-supplied names. Single chat and Person share the `SessionListSidebar` container for sizing, collapse, scrolling, themed surfaces and mobile drawer placement, as well as navigation, list rows and search UI. On mobile, switching between Chat and Person keeps both navigation columns open; selecting a conversation, opening search or naming a new conversation closes the drawer. Its search endpoint reads only the authenticated account's Person conversation names and messages; ordinary chats and task worker sessions are excluded. Creating a conversation never derives its ID from the account. An empty account shows a naming action instead of creating a fixed conversation implicitly.

The displayed transcript uses the same chat-store `switchSession` and `/chat-run`
Socket.IO `resume` path as ordinary chat. Once the conversation summary is known,
resume starts alongside the Person settings/task snapshot, including during page
initialization. A new selection cancels the previous snapshot instead of waiting
for it; stale results cannot overwrite the selected BOT. Message lists and
composers stay mounted across switches. Both surfaces use `useChatSurfaceReveal`
for the same 1.5-second ease fade after transcript readiness. Cached messages
reveal immediately; a fresh resume response does not replay that fade. The
animation never delays resume or replays on background refreshes. Reduced motion skips
the fade. This UI history path is separate from the model-context history loader
described below.
The shared message list shows its welcome logo/text only after history has been
confirmed empty (or for a new local draft). Pending/failed resumes and histories
whose rows are hidden by display filters do not count as empty conversations.

Model selection and reasoning effort are stored only in `person_conversation_settings`, keyed by the owned session ID. Setting a model, changing effort or restoring the global model requires `session_id`; unscoped writes are rejected. Unconfigured conversations use the Studio global default, never another Person conversation's selection. Obsolete account model/effort/context-budget fields are discarded at initialization without migration; existing conversation settings and history remain intact.

Memory, Agent presets and execution settings remain account-scoped. Each main turn includes the current conversation identity and the complete account-owned Person conversation directory (IDs and names), without search pagination. New turns reflect creation, renaming and deletion; conversations being deleted are excluded. Names are user-provided labels and do not define responsibilities, hierarchy or Agent bindings. `bot_sessions_query` remains available to search conversation content or refresh the directory during a turn. The directory is part of the system prompt and its context budget; it does not include message history. History search covers the account's Person conversations and carries each original's conversation ID and name. Recent dialogue remains local to the current conversation. One account-wide message boundary is captured before the current input is persisted, and edits/deletion of any captured source fence subsequent tools and requests. Indexing retains a 64-chunk bound across sources per pass.

Every Person task has a required owning `session_tasks.session_id`. A model can create or adopt background work only in its current conversation; cross-role attempts fail with `ROLE_HANDOFF_REQUIRED` before Agent selection or task creation. Use `bot_flow_create` to let another role receive the request in its main conversation and choose its own execution needs. Continuing an existing task preserves its task, runtime conversation and owner. Existing legacy planned task flows can still transfer ownership using `advance`. The task's current owning conversation is authoritative for result delivery, even when another conversation supplied the follow-up instruction. Durable questions and completion links also target that conversation. Task and schedule drawers are filtered to the selected conversation.

### Conversation stages and optional workers

Use `bot_flow_create` for fixed serial and parallel groups of roles, including a single stage to relay a message to one recipient. Praise, greetings and word games are conversation, not background execution. Flows and stages are separate from background tasks: a stage can answer directly with zero executions, or choose its own configured Agent using `bot_agents_list` and `bot_task_create`. Main chat and pure dialogue stages need an available interaction model, but no execution Agent preset. New task tools no longer advertise the legacy `next_steps` contract; existing legacy task flows retain their compatibility path.

```json
{
  "title": "Deliver a reviewed page",
  "goal": "Prepare copy, implement it and report the result",
  "stages": [
    { "session_id": "person-main-copy", "goal": "Prepare page copy", "return_expectation": "Save approved copy" },
    { "session_id": "person-main-code", "goal": "Implement the approved copy", "return_expectation": "Verify the page and save links" },
    { "session_id": "person-main-boss", "goal": "Prepare final deliverables", "return_expectation": "Summarize for the user" }
  ]
}
```

For A and B to work concurrently and C to summarize both results, use:

```json
{
  "title": "Research and summarize",
  "goal": "Combine competitor research and user needs into a proposal",
  "stages": [
    { "session_id": "person-main-a", "group": 0, "goal": "Research competitors", "return_expectation": "Save findings and sources" },
    { "session_id": "person-main-b", "group": 0, "goal": "Analyze user needs", "return_expectation": "Save findings and evidence" },
    { "session_id": "person-main-c", "group": 1, "goal": "Summarize both research results", "return_expectation": "Write the combined proposal" }
  ]
}
```

A single parallel group needs no synthetic summary stage: each role replies independently and the flow finishes when all results are saved. Planning is done by the conversation Bot through the tool; dispatch, joining, fencing and recovery belong to the host.

The host fixes the creator from the originating conversation. Route data is immutable and bounded to 13 role stages and 32,000 characters. Omit `group` on every stage for a serial route. For mixed execution, set `group` on every stage to ordered, contiguous integers starting at zero. Roles in the same group run independently; every result must be saved before the next group is dispatched. A role may appear only once per group. Each stage first wakes its owning Person main conversation. Outstanding handoffs light all current recipients, even without workers; a creator waiting for other roles and future recipients remain idle unless they have their own foreground or background work. Settled or failed deliveries do not leave a role lit just because its stage remains active. Internal handoff instructions do not count as unread. Replies and the creator's final completion notice become unread only after execution settles; reading during execution cannot consume the partial reply. Socket receipts acknowledge observed message and completion-notice cursors across devices. Any optional worker gets a distinct task and hidden worker conversation; continuing that child preserves its Agent and conversation. Ownership never moves from one stage to another. Stage children cannot be scheduled for later recurrence.

The directory entry marked `current:true` is the speaking role. A request naming that role is its own work. The service rejects a creator-only first group and consecutive singleton groups for the same role with `SELF_HANDOFF`, before persisting a flow or delivery. A first parallel group may include the creator alongside other roles, which supports “everyone introduce yourself”. The creating turn acknowledges dispatch and ends; its own introduction is produced only by its assigned stage turn. Comparisons use session IDs, not names; returning in a later group remains valid. Finish local work before handing its artifact to another role: a pending worker created in the same turn blocks flow creation with `WORK_PENDING`. For “programmer makes HTML, then copywriter reviews” inside the programmer conversation, the programmer starts its own worker once, waits for the artifact, then sends only the review to the copywriter. Worker result callbacks may continue handoffs already requested by the user; they do not authorize new work.

`bot_flows_query` returns fresh revision-bound references. `bot_flow_control complete` prepares the active stage; it cannot complete another stage or leave unfinished workers. The host completes a branch only after the final assistant result from that same run is successfully saved. Normal replies and worker completion alone do not advance a flow. The last completed branch atomically activates every role in the next group and inserts their durable deliveries, so duplicate callbacks cannot wake a downstream role twice. Each completion changes the flow revision, but an assigned branch may complete using its already observed reference when peers advance that shared revision. The host validates its exact stage, generation, active group and live run; stop/resume still require the current flow revision. Peer completions never force model retries or share another role’s step budget. Startup recovery reconciles a saved final result with an unfinished completion marker without repeating advancement. Failed, streamed, interrupted or truncated replies are not final stage results.

Handoff instructions are transient model context (`displayInput: null`, no user-message write, no memory writes). Stages store original result message IDs, not copied output text. Each role in the next group loads all previous-group results by reference, sharing a 6,000-character inline budget and keeping every original ID for further reads. Those IDs are excluded from normal recalled evidence in that turn. Peers do not consume each other’s partial results. A missing upstream result blocks delivery with a visible error rather than omitting that branch. Shared account recall remains available. For an idiom chain, history stores A, B and C once in their respective role conversations, without storing A→B or B→C handoff messages. Optional worker callbacks retain no copied originating transcript for stage tasks.

The creator or current role can stop a flow. Stop cancels durable handoffs and worker callbacks, aborts only flow-tagged main turns and stops its child work. Other ordinary turns in those conversations keep their normal behavior. Late callbacks are fenced by the flow generation. Only the creator or authenticated account API can resume a stopped or failed flow; this increments the generation and requeues only unfinished branches after all their workers finish stopping. Completed branches and their saved results remain intact. Replaying an old stop request cannot stop a resumed flow.

A failed handoff, assigned role turn or stage-worker result callback automatically marks that branch and flow failed, settles its deliveries and stops only its own remaining workers. It preserves messages, original results, task records and error details. Parallel peers retain their generation and can finish normally; dependent groups stay pending. Failed deliveries do not retry on a timer or require the user to clear history to release a role. Resume is explicit and waits for live peers and worker shutdown before requeuing unfinished branches. History/workspace checks continue to protect actual live work and upstream results currently in use, while an idle failed flow holds no lock. Startup recovery also settles legacy errored handoffs that older versions left pending. The drawer displays failed flows with their error and Resume action.

The Person settings drawer defaults to a compact list of at most the 50 most recently updated flows for the selected conversation, with status filters, title/goal/role search, completion counts and a short route (`A ∥ B → C`). Search and status counts apply to those same 50 flows. Older flows remain saved and available through offset-based API queries. Only one flow can be expanded at a time; filtering out the selected flow closes its detail. Expanding reveals the role collaboration graph: parallel role cards sit side by side on desktop, serial groups are connected through a handoff, and phones stack roles inside a labeled parallel group. Each card shows the saved Bot appearance, role goal and status, opens its conversation, and links to original results. Background workers are collapsed under their owning role with their actual execution states and Agent logos. Pending roles name their unfinished upstream dependencies instead of appearing to be queued for execution. Saved completions remain completed while their peers work; delivery errors and failed open workers require attention, and settled unfinished role turns show that a follow-up is pending. The header counts completed roles and retains stop/resume controls. The account API exposes `/api/studio/person/flows/query` and `/flows/apply`. Completion is restricted to the trusted assigned model turn and cannot be forged through that API. Deleting any involved conversation stops its active flows; clearing history is blocked while an involved flow remains active. Missing original results leave a visible delivery error instead of silently reconstructing lost context.

Deleting a conversation blocks new dispatch into it, cancels its schedules and result deliveries, interrupts queued/follow-up work and waits for active native workers and the main run to stop. Its messages, tasks, worker sessions, execution records, questions, schedules, return cards and derived context are then removed together. Shared memory, presets, workspace files and other conversations remain. A failed native stop leaves the conversation present so deletion can be retried. There is no legacy task reassignment: obsolete account-only tasks without an owning conversation are discarded at initialization.

Person main chats use their own bounded history loader. Ordinary single chats,
Person worker sessions and the shared `sessions` / `messages` schemas retain
their existing behavior. The shared run path skips the ordinary history compressor for `person-main-*`;
Person's adapter supplies history. Stage completion hooks activate only for
trusted Person stage deliveries or their worker callbacks.
There is no fallback to the old Person substring scan or shared compression
snapshots.

Person main also opts out of the runtime's generic shell/code execution guidance:
its registered tools dispatch background tasks rather than execute commands.
The runtime default and ordinary Ekko chats retain their existing instructions.

## Scheduled goals and execution contexts

Schedules have two explicit modes. `assistant` stores the owning conversation,
title and goal without requiring a background task or execution preset. Each
occurrence enqueues a fresh single-role stage through the existing durable flow
lifecycle: the role can reply directly or select optional workers. This internal
scheduled wake-up is not a self-handoff through `bot_flow_create`. Stage completion
updates the occurrence only after the final result is persisted. An unfinished
stage, including waiting for its workers, prevents overlapping occurrences of
that schedule. Pause and cancel affect future triggers; stop active work through
the existing flow/task controls.

`worker` binds an existing open task. Every fresh start and scheduled occurrence
allocates an independent hidden `person-task-<execution UUID>` conversation, with
no native session binding or previous occurrence's decisions. The task goal and
shared workspace persist; cross-occurrence progress belongs in explicit workspace
state rather than an ever-growing native chat. Manual follow-ups reuse the selected
execution's conversation and queue under the existing per-task lease. Requirement
changes prevent resuming a stale conversation. The task drawer lists recent
execution conversations and result cards open the exact execution that produced
the result. Worker ownership and history cleanup follow execution records rather
than parsing a task ID from the conversation ID.

Person is not released: initialization discards the old worker-only schedule table,
its occurrence records and schedule idempotency results. Recreate those schedules
with an explicit mode. Conversation history, task goals, account memory and Agent
presets remain. Subsequent initialization preserves schedules in the new schema.

## Storage and retrieval

The settings drawer separates General settings from Agents, Schedules and Memory.
General settings shows the current interaction model's context capacity, resolved
through the same model metadata/configuration lookup as ordinary chat. Historical
fixed Person budgets are ignored. Switching models updates both the displayed
capacity and the next run's compression trigger.

The compression threshold is a fraction of that model window (5–95%). By default
it inherits the selected model resource's global compression threshold (50% when
unset); an account override is optional. Global automatic-compression enablement
is respected. Output reservations remain a hard limit even when automatic
compression is disabled. A provider's smaller input limit also constrains requests.
This does not enlarge automatic history retrieval or prefill the whole window.
Within a run, checkpoints replace matching completed source blocks on subsequent
requests; only new original evidence is summarized, never an earlier summary.
The current user input and latest complete tool interaction stay intact.

General settings also exposes the main-reply step limit (2–30), concurrent
background tasks (1–12, default 6 shared across the account's BOTs), and timezone.
The worker process also allows up to 12 active executions in total. Explicitly
saved account limits are preserved. Settings use revision-checked partial updates
and apply to subsequent replies and task dispatch. Existing schedules retain their
own timezone.

`person_context_progress`, `person_context_chunks`, `person_context_search` and
`person_context_summaries` contain derived data. FTS maintenance triggers attach
only to the new chunk table. Original chat messages remain authoritative and
are not rewritten by indexing or summarization.

Each run captures the owned session's history revision and maximum message ID
before its new user message is saved. History is read through this boundary,
avoiding duplicate current input and inclusion of later messages. History edits
fence in-flight model requests, tools and cache writes. On the next read, changed
revisions discard derived data and rebuild it. Search hits are checked against
live originals before being returned, including after an out-of-band edit.

The loader interleaves recent dialogue and lexical search hits within 30% of
the interaction model's context window, capped at 3,000 estimated tokens. Evidence carries
its original role, message ID, timestamp, character offset and pagination cursor.
Chinese bigrams support text without spaces. Search pages contain at most six
chunks and recent reads at most eight messages. Explicit IDs and offsets allow
the model to read complete originals rather than treating excerpts as complete
documents. Search itself is paginated; a thirteenth result is not inaccessible.

Indexing processes at most 64 chunks per transaction. A background queue yields
between batches and resumes from persisted progress. Streaming records suspend
indexing instead of being skipped forever or busy-polled. Long text uses
overlapping 2,000-character chunks; offsets use SQLite Unicode characters.
Incomplete index coverage is reported explicitly. This mechanism also supports
rebuilding an index after months of new conversation; it is not a legacy-data
migration. FTS drives the search join to avoid scanning the session's entire
chunk index for each match.

## Budget and checkpoints

Every provider request includes message and tool-definition overhead in the
budget check, reserving output tokens and a safety margin. Provider-native
continuations are disabled for Person so hidden history cannot bypass assembly.
Runtime context events report the prepared provider request, not the discarded
history. Estimates remain estimates, not exact provider token counts.

Image parts reserve 4,096 tokens each before the usual 15% estimation margin;
Base64 transport bytes are never counted as prose. The original image parts
are forwarded unchanged, including during checkpoint summarization. This is
a conservative local reservation, not a provider-specific vision billing
formula. Multiple images still consume the configured budget, and an oversized
required interaction is still rejected. Prepared context events use the same
estimator as the request guard.

`bot_artifact_read` returns metadata and a verified absolute path for images and
binary files, never UTF-8-decoded file bytes. Known media need not be loaded to
return a reference, and are not subject to the 2 MB text limit. Unknown binary
files are detected before text pagination; valid text and empty-path execution
output retain their paginated read behavior. Owner and real workspace checks
apply equally to references and text. Person may use Markdown image/file links
when delivering requested artifacts; a file reference does not prove visual
contents and does not trigger independent review of completed work.

When a long current turn needs compression, completed earlier tool groups are
summarized without splitting calls from results. The current user message and
latest complete tool group remain intact. A source hash, selected model and
history revision key each checkpoint; unchanged sources reuse it across runs.
Checkpoints are generated from originals, not recursively rewritten summaries.
Each session keeps at most 64 cached checkpoints. Summary model calls are
accounted separately. Cancellation or a history revision change rejects late
cache writes, and an oversized required current interaction fails explicitly.

Retrieved text and summaries are data, not new authorization. Existing task,
revision, ownership and approval checks remain authoritative. This implementation
does not derive executable permission decisions from model-produced status fields.

## Validation and limits

Focused tests cover owner isolation, shared-schema preservation, history edits,
streaming rows, long Unicode originals, chunk-boundary identifiers, pagination,
checkpoint reuse, cancellation, actual request estimates and budget rejection.
The scale case indexes 100,000 messages and checks bounded result sizes and old
evidence retrieval. Ordinary chat routing, compression and deletion tests assert
that their paths remain unchanged.

Search is lexical; the model can request synonyms through `bot_context_search`,
but this does not guarantee semantic recall or complete evidence for every
question. A local scale test is not a concurrency SLA or a months-long accuracy
evaluation. The earlier isolated experiments are separate from these production
integration tests and must not be reported as this implementation's accuracy.


## Account memory

Person uses Ekko Agent's `MemoryService`, `SqliteMemoryStore` and native structured
memory tools. Each Studio account has an independent database at
`<Web UI home>/person/<account id>/memory.db` and a stable `person:<account id>`
identity. Selecting a different model Profile does not select another memory
store. Ordinary Ekko chat continues to use its existing store and scopes.

The first model request automatically recalls memory within a 1,000-token card
budget. The overall Person request budget still includes system text, tool
schemas, retrieved history, memory, output and safety reserves. Name queries can
use the `profile_name` kind instead of guessing matching text. Person advertises
only the native writer's atomic batch schema, avoiding duplicate legacy fields.
It omits the model-supplied `sourceMessageIds` field: the host binds the current
user input automatically. History's transcript IDs are a different namespace from
native memory evidence IDs. Explicit unsupported IDs still fail native validation;
the adapter never rewrites a rejected citation into an accepted one.
Optional Person memory JEV enhancements use their independently configured global Person switches and default to disabled; model Profile changes do not select another memory store.

Only host-provided user evidence is captured for memory writes. When the current
user asks to remember a worker result, the main assistant sets `remember_result`
on `bot_task_create` or `bot_task_control` (`adopt`, `start`, `continue`). The host
binds the current persisted user message and history revision to exactly one
execution's delivery. On a successful, current return, the main assistant can save
the requested result without another confirmation. The original user text remains
the source; verified task output is separate host-stamped `authorizedContext` for
optional write review, rather than fabricated user-authored text.

The request is checked again before each memory write. Changed/deleted source
messages, changed history, cancelled/delivered callbacks, failed or superseded
executions and closed tasks cannot use it. It is consumed at enqueue, never
inherited by subsequent executions, schedules, or new tasks created from a callback.
It permits saving only, not forgetting/deleting/expiring memory. No grant is
inferred from retrieved history, queue payloads or worker instructions. Legacy
deliveries without this request remain read-only. Native revision checks, canonical keys,
account ownership and explicit forget intent apply. The memory panel lists
active cards and can delete an exact card at its current revision. New memories
and corrections are made in the Person conversation so the structured value,
content and source evidence are updated together.

The legacy `person_memories` table is dropped at database initialization. Its
contents are intentionally discarded; there is no migration or fallback reader.
Person's conversation/history index, tasks and ordinary chat data are retained.

Regression coverage includes the recorded `名字 称呼 姓名` search failure,
controlled-name lookup, automatic recall, evidence provenance, Profile changes,
account isolation, stale corrections/deletion, callback injection and the full
toolset under the minimum 8k request budget.

## Stopping a task

The task list and task conversation expose Stop task for queued, active and
waiting executions. The conversation's composer also shows Stop even with a
draft or before streaming begins. It uses the same task API, preserves the draft
and attachments, and disables Stop until acknowledgement. Person uses
`bot_task_create` for new work and `bot_task_control` for existing work. Queries
and operation receipts return an opaque `task_ref` plus `allowed_actions`.
The host binds each reference to the account, queried revision and execution ID;
the model supplies only its action and business fields. It never supplies retry
keys, revisions or target execution IDs for task mutations. Both the version and
execution ID are checked inside the mutation transaction, including when a
schedule enqueues a different execution without changing the task revision.

References belong to one main-turn toolset, expire after ten minutes, and have a
128-entry bound. They are not authorization grants. Ownership and resource access
checks still apply; old conversation references, changed or deleted tasks and
references from another account/turn are rejected. `INVALID_TASK_REF`,
`STALE_TASK`, `TASK_UNAVAILABLE`, `ACTION_NOT_ALLOWED` and `INVALID_ARGUMENT`
errors include recovery instructions and remain failed native tool events.
A stale reference requires a new query and reconsideration, never automatic
substitution of the latest version. Normal queued-to-running progress on the
same execution does not change its identity.

Identical normalized actions within a turn share a host-generated idempotency
key and in-flight promise. Successful replay returns the original receipt marked
`replayed`; query for current state rather than interpreting that receipt as a
new observation. Re-querying the same snapshot does not bypass deduplication.
This also means identical task creation requests in one turn create one task;
distinct intended tasks need distinct titles or requirements. There is no
cross-turn semantic deduplication or cross-restart continuation of references.
Task query results are paginated and bounded; detailed output stays in artifact
reads. The browser task API retains its explicit revision/execution protocol;
ordinary chat and database schemas are unchanged. Schedule tools retain their
existing interface.

Queued work becomes interrupted without starting. Active work first persists
`stopping` and fences its generation, expires pending questions and cancels its
result callback. The runner aborts the coordinator and native worker; only native
acknowledgement changes the execution to `interrupted`. Failed acknowledgements
remain durable and retry after a restart. Slow acknowledgements do not block
other task dispatch. During native initialization the intent stays stopping until
the worker can accept interruption; it is never prematurely reported as stopped.
Person requests termination confirmation from the chat runtime. It observes
native child/PTY exit before dispatching cancellation and also waits for the
original run handler to unwind. A terminal chat event or a sent kill signal alone
does not acknowledge the stop. Pending exit observers survive runtime
unregistration and retries; elapsed time never turns an unconfirmed stop into
success. Ordinary chat retains its existing immediate abort behavior.

Stopping retains the goal, conversation and existing artifacts. The goal stays
open, and a new message can continue it once interruption is acknowledged.
Already performed external actions are not undone. Future schedule occurrences
remain enabled; cancelling a schedule is a separate action. This path does not
use ordinary chat's socket stop control or change its behavior.

## Delegated execution approvals

Every Person task turn enables the host's internal `approvalChoice: 'once'`,
including initial dispatch, continuation in the saved conversation and scheduled
occurrences. Hermes approvals are answered through its runtime broker. Ekko uses
a run-scoped callback so parallel tool calls do not compete for the single human
approval slot; cancelled calls still return a denial. Coding Agents retain their existing unattended launch
configuration and use the same automatic response if a runtime requests approval.
These responses apply to individual requests; they do not write permanent allow
rules or change the ordinary chat approval settings.

Approval events remain in execution history but do not create durable human
interactions or put the task in `waiting_approval`. Real clarification questions
still go through Person's coordinator and can wait for missing user intent.
The host deduplicates approval requests, sends resolution after the request event,
and stops the run if its approval cannot be applied. Completed or cancelled runs
do not grant late approvals. Account, Profile and task ownership checks still apply.

## Account animation and inactivity

The Person navigation avatar uses the supplied transparent idle, thinking,
searching, completion, error and sleeping animations from the supplied 240 × 240 GIF pack without
transcoding. The main conversation's live reasoning row uses the thinking clip.
Static Person avatars and animations use square frames with small rounded
corners. Static photos fill the square crop; the square animations retain their
original framing. Completion plays for two seconds and error plays for three
seconds, then restores the current working, idle or sleeping state. A newer
outcome replaces the previous feedback; cancelled work does not celebrate completion.

The authenticated `/person-presence` Socket.IO namespace sends `person.presence`
snapshots with `state`, `backgroundTaskCount`, `lastActivityAt` and `sleepAt`, plus `feedbackId` and
`feedbackUntil` during outcome feedback. Its only client write is
`person.activity`, with no account, state or timestamp parameters. It is available
through both local and cloud App relay transports. Each connection is bound to
the authenticated Studio account, independently of Profile and open conversation.

Person shows a fixed capsule floating at the top center while this count is
positive, without reserving a row or shifting the conversation and composer.
It uses zhezhe's execution animation and opens the task drawer when
selected, expanding from the center on arrival and collapsing after the last task.
The server counts distinct account tasks across all pages, including queued and
waiting executions, stopping work and pending result delivery. Outcome feedback
does not replace the capsule's execution animation. Reduced motion uses a static
avatar and skips the transition.

The server checks connected accounts once per second and publishes only changed
snapshots. Persisted outcome events publish immediately, and server timers switch
all connected devices at feedback and sleep deadlines. Reconnecting during an
outcome uses the existing deadline; it does not restart the feedback. A running Person main turn shows thinking; a main tool or a task in
starting/running/stopping shows searching. Queued tasks, goals that are merely
open, completed/failed tasks, and waiting questions/approvals do not count as
executing work. Outcome feedback temporarily takes priority over work and sleep;
afterward active work takes priority over sleep. Outcomes do not reset inactivity.

The last user interaction is persisted in `person_presence` using server time.
With no executing work, ten minutes without input on any connected device shows
sleeping. Pointer, touch, keyboard and wheel input wakes the account on all its
connected devices; clients throttle reports with a trailing update. Snapshot
reads, timers, connecting and reconnecting do not wake Person. Offline input is
not buffered for replay, and reconnecting receives a fresh server snapshot.
Clients clear the previous account's state on logout; the server rejects revoked
credentials and disconnects their presence subscriptions.
