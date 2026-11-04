---
date: 2026-10-22
pr: pending
feature: Conversation-maintained session goals
impact: The current conversational model reviews durable goals at turn start, creates concrete tasks before execution, and records results before its final response.
---

## Turn lifecycle

At the start of each primary single-chat turn, the current model reads the
session goals and reviews the past conversation: which requested outcomes were
delivered, which remain open, and which completed tasks need reopening after a
correction. It then identifies concrete tasks in the latest request and records
new goals before executing them when they have independent delivery value, need
ongoing follow-up, or the user explicitly asks to track them. Simple questions,
one-off lookups and trivial one-turn edits without lasting tracking value do not
create records. Tracking value, rather than step count, determines eligibility.
One user outcome keeps one goal: follow-ups, refinements, corrections and
implementation constraints update its existing id. Distinct outcomes worth
tracking may create separate goals. Reading an unchanged ledger requires no
write. Casual discussion, hypothetical suggestions and execution steps do not
become goals. Existing authorization still controls what work is performed.

Titles name the user outcome concisely. Summaries use one or two short sentences
about results and remaining blockers. Implementation symbols, pixel values,
file counts, commands and test logs remain in the conversation; verification
belongs in completion evidence. The turn instructions, native Ekko tools and MCP
instructions follow the same policy. Existing historical goals are retained.

Before the final response, the same model saves progress and verified outcomes.
`open` covers unfinished, blocked and interrupted work; `completed` requires a
concise `completion_evidence` explanation of verified delivery. The end of a
turn, successful execution or completed plan steps alone cannot establish goal
completion. If execution is interrupted before the last update, the next turn's
review reconciles the ledger from the conversation. This lifecycle is instructed
through tool descriptions and turn/system prompts; the host validates writes,
but does not independently decide whether the real-world outcome was achieved.

There is no separate summarization model, background worker, auxiliary model
configuration or extra extraction run after terminal events.

## Native tools and MCP

Ekko receives `list_session_tasks` and `update_session_tasks` as conditional
native tools in the normal tool-call loop. Studio supplies callbacks bound to
the live session, profile and history revision. Standalone runtimes without
callbacks, delegated subagents and background/group/workflow/global-agent
contexts do not receive these capabilities. Saved callbacks cannot write after
the foreground run finishes, is aborted, or changes profile/history.

Hermes and Coding Agents use direct `ekko_studio_list_session_tasks` and
`ekko_studio_update_session_tasks` tools on `ekko-studio-interaction`. The latest
input carries fresh turn instructions and a context id. POST endpoints
`/api/studio/session-tasks/list` and `/api/studio/session-tasks/update` resolve
that live capability to the session/profile; the model cannot select a session.
Expired contexts, foreign profiles and non-primary contexts are rejected.
Run-scoped credentials apply the same context/profile checks as planning.

Both tool families distinguish session goals (`open` / `completed`) from the
existing per-run execution plans (`pending` / `in_progress` / `completed`).
Reading/writing goals never creates a task-plan card or emits `plan.updated`.
There are no frontend, App display, pagination or resume-payload changes.

## Persistence and consistency

Studio owns `session_tasks`, with one row per goal and stable ids across turns.
The session row stores the ledger revision and update timestamp. Schema sync
creates the table and adds those fields for existing databases.

Writes send only changed/new goals, with the revision from the latest read or
write response. Omitted goals remain. A revision conflict requires rereading.
Explicit ids must belong to this session; normalized equal titles reuse ids
when omitted. Malformed/duplicate changes and unknown ids reject the entire
batch. A newly completed goal requires completion evidence. Evidence is the
current model's verification explanation, not an exact-quote assertion or an
independent judge. Creation is anchored to the latest user request that prompted
recording (including recovery of older goals); completion is anchored to the
latest durable message at the write boundary.

Profile, history and goal revision checks protect atomic upserts. Clearing or
deleting history cleans up goals and invalidates stale writes. Deleting request
anchors removes their goals; deleting completion anchors reopens affected goals.
`GET /api/studio/sessions/:id/tasks` remains an authorized read endpoint with
session existence, profile filter and account-profile access checks.

## Validation

Tests cover a single model's normal read/create/complete tool loop, conditional
native discovery, live callback expiry, multiple goals and stable ids, omitted
task retention, reopening, completion evidence, atomic rejection, history
cleanup, turn capability expiry, authenticated MCP process/HTTP round trips,
controller validation, prompt timing and unchanged run plan publication.
