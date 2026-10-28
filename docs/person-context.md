# Person context assembly

Person main chats use their own bounded history loader. Ordinary single chats,
Person worker sessions and the shared `sessions` / `messages` schemas retain
their existing behavior. The only shared run-path change skips the ordinary
history compressor for `person-main-*`; Person's adapter supplies history.
There is no fallback to the old Person substring scan or shared compression
snapshots.

Person main also opts out of the runtime's generic shell/code execution guidance:
its registered tools dispatch background tasks rather than execute commands.
The runtime default and ordinary Ekko chats retain their existing instructions.

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
background tasks (1–4), and timezone. Settings use revision-checked partial updates
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
The optional JEV enhancements remain disabled in this Person runtime; no Profile
JEV configuration or credentials are implicitly inherited.

Only the current host-provided user evidence is captured for memory writes.
Retrieved history and background callbacks cannot become fresh user evidence;
callback memory writes are rejected. Native revision checks, canonical keys,
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
