# Session Compression Cursor Plan

Date: 2026-07-19
Updated: 2026-07-20
Issue: https://github.com/EKKOLearnAI/ekko-studio/issues/2138

Status: Implemented on 2026-07-20. The legacy index fields remain available
for compatibility and are upgraded only by a successful compression cycle.

## Context

Live chat and History already load recent messages in bounded pages. The server
still has hidden full-history work when a session is resumed and when a
compression snapshot is applied.

Compression snapshots currently store `last_message_index`. The compressor
reconstructs the complete ordered context array and uses that index with
`slice()` to find the messages that have not yet been folded into the summary.
This makes the snapshot boundary dependent on an in-memory array and causes an
existing snapshot to load old message bodies that the model will never receive
again.

The current resume path also builds the full DB history to calculate context
usage, then performs another full session-detail query to obtain lightweight
metadata such as the workspace and parent-session fields. Those operations are
not required to render the latest message page.

The optimization must preserve the purpose of context compression: the first
protected messages remain verbatim, the summary represents a precise prefix of
the context history, and the uncompressed tail begins immediately after that
prefix without losing or duplicating a model-visible message.

## Goals

- Replace array-position compression boundaries with a stable database cursor.
- Preserve existing index-based snapshots and upgrade them in place only when
  that session next enters a real compression cycle.
- Build a cursor snapshot's effective model context from a bounded head,
  its summary, and only messages after the cursor.
- Keep the first compression accurate even though it must inspect the complete
  unsummarized history.
- Remove full-history reads and tokenization from session open, switch, and
  reconnect paths.
- Preserve tool-call/tool-result pairs and protected head/tail windows across
  compression boundaries.
- Invalidate or remap snapshots correctly when history is cleared, deleted,
  edited, imported, or copied into a branch.
- Keep the user-visible chat and History pagination behavior unchanged.
- Keep Coding Agent execution independent from Web UI context compression.

## Non-Goals

- Do not replace `node:sqlite` solely for this optimization.
- Do not move all persistence to a Worker Thread in the first implementation.
- Do not archive or delete old messages after they are summarized.
- Do not change compression prompts, summary budgets, or configured context
  thresholds unless required by a separate change.
- Do not make the first summary without reading the content that must be
  summarized.
- Do not invalidate all legacy compression snapshots during deployment or force
  old sessions to regenerate summaries solely because the cursor schema was
  added.
- Do not send Web UI message history to Codex or Claude Code. Coding Agents own
  their native session history and resume behavior.

## Scope Boundary

The compression cursor applies to Hermes Bridge chat sessions whose model
context is assembled by the Web UI server. It does not apply to Coding Agent
execution.

Coding Agent runs send only the current input and system prompt to the selected
agent. Claude Code resumes with its native session ID through `--resume`; Codex
resumes through `codex exec resume`. Their native runtimes own context retention
and any internal compaction.

The current Coding Agent path still performs complete Web UI history reads on a
cold UI resume and after a run to estimate local usage and `contextTokens`.
Those reads are display/accounting work, not model input, and should be removed
or replaced with persisted/native usage values. Reconstructing Web UI history
does not accurately describe a Coding Agent's internal context after native
compaction.

## Current Behavior

### Snapshot Representation

`chat_compression_snapshots` stores:

```text
session_id
summary
last_message_index
message_count_at_time
updated_at
```

`last_message_index` is an index into the normalized context history, not a
stable identity for a database message. Incremental compression reconstructs
the full array and selects:

```ts
history.slice(snapshot.lastMessageIndex + 1)
```

`message_count_at_time` is persisted but is not currently used to validate the
snapshot. Snapshot usability is primarily a bounds check against the newly
constructed array.

### Resume Flow

On a cold Socket.IO resume:

1. The latest message page is loaded for display.
2. The complete context history is loaded and normalized.
3. Snapshot-aware context is assembled to calculate `contextTokens`.
4. Full session detail is loaded again for workspace and parent metadata.
5. Only the paginated state is emitted to the client.

The full arrays created in steps 2 and 4 are temporary, but their synchronous
SQLite reads, row mapping, JSON parsing, and token counting still execute on the
server event loop.

### First And Incremental Compression

The first compression needs the full unsummarized range because that content
must be sent to the summarizer. After a snapshot exists, the effective context
is conceptually:

```text
[protected head] [summary through boundary] [preserved tail and new messages]
```

Only the current index-based representation requires the already summarized
middle section to be loaded again.

### Compression Execution

Summary generation is not an in-process string transformation. Each actual
full or incremental summary first creates a fresh Ekko Agent runtime. That
runtime has tools, MCP, skills, and memory disabled, allows one model step, and
does not retry a failed model request. It receives only the summary prompt and
the fixed instruction to generate the checkpoint.

For Hermes Agent conversations, an Ekko failure or unusable summary falls back
to the previous Hermes `chat` run through Agent Bridge. The fallback uses a
temporary `compress_*` session ID, receives the same summary prompt as
conversation history, uses the dedicated
`<profile>:compression:<source-session-id>` worker key, waits for the result,
and destroys the temporary compression session afterward. Ekko Agent
conversations disable that fallback: an Ekko summarization failure stays in the
shared compressor's normal failure path and never starts Hermes Agent.

The first compression therefore sends the complete selected historical range
to a summarizer model. Incremental compression sends the previous summary and
only the newly selected range. Preserving legacy summaries avoids an expensive
and unnecessary full-history summarization after upgrade.

For Hermes Bridge chat, complete history is not cached across runs. Every run
currently calls `buildDbHistory()` again, and usage/context-token updates can
perform additional complete reads during the same run. Cursor adoption must
therefore update all of these consumers; optimizing only the initial context
assembly would leave repeated full-history reads in place.

## Proposed Design

### Stable Message Cursor

Add a stable boundary to the snapshot and keep the current history revision on
the session:

```sql
ALTER TABLE sessions
  ADD COLUMN history_revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE chat_compression_snapshots
  ADD COLUMN compressed_through_message_id INTEGER;

ALTER TABLE chat_compression_snapshots
  ADD COLUMN history_revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE chat_compression_snapshots
  ADD COLUMN protected_head_through_message_id INTEGER;
```

`compressed_through_message_id` is the ID of the last context message whose
content is represented by `summary`. `protected_head_through_message_id` freezes
the protected head selected when the snapshot was written so a later
`protect_first_n` configuration change cannot duplicate or omit messages.
Message ordering must continue to use the same database order as context
construction, currently message `id`, rather than timestamp.

Keep `last_message_index` for legacy snapshots, compatibility, diagnostics, and
rollback. Do not clear or rewrite existing snapshots during schema migration.
New snapshot writes should use the cursor as the source of truth while
continuing to populate the legacy field where it is inexpensive to do so. Keep
`message_count_at_time` as optional validation and observability data, but do
not use a count as the boundary identity.

Snapshot reads use this precedence:

1. When `compressed_through_message_id` is present, use the cursor path.
2. When the cursor is absent but `last_message_index` is present, use the
   existing index-based path unchanged.
3. When neither boundary exists, treat the session as having no snapshot.

Opening, switching, reconnecting, or merely starting a run must not discard a
legacy snapshot. A legacy snapshot remains valid under the same rules as before
until a compression cycle upgrades it.

### Cursor-Carrying Context Entries

Preserve database identity while normalizing messages:

```ts
interface ContextHistoryEntry {
  cursorId: number
  message: ChatMessage
}
```

The cursor is internal metadata and must not be sent to the model. Filtering
invalid or non-context rows must keep each surviving `ChatMessage` attached to
its original database ID. The compressor should return the cursor of the last
entry folded into the summary instead of returning only an array index.

This avoids deriving a database boundary from the length of a transformed
array, which can differ from raw row count when roles are filtered, assistant
messages are rejected, or tool-call metadata is normalized.

### Snapshot-Aware Context Query

For a valid cursor snapshot, query only the protected head recorded by the
snapshot and the range after the boundary:

```sql
SELECT *
FROM messages
WHERE session_id = ?
ORDER BY id
LIMIT ?;
```

```sql
SELECT *
FROM messages
WHERE session_id = ?
  AND id > ?
ORDER BY id;
```

Apply the same context-message normalization used by the full-history path.
The model context becomes:

```ts
[
  ...protectedHead,
  summaryMessage,
  ...messagesAfterCursor,
]
```

For a new snapshot, the head query ends at
`protected_head_through_message_id`; the current `protect_first_n` value is used
only when creating a new protected-head boundary. The query may need to read
slightly more raw rows until it obtains the requested number of valid context
entries. This remains a small bounded query.

Context construction must also preserve the current `excludeLastUser` behavior.
When the latest persisted user message is supplied separately as the current
run input, it must not also be included in the post-cursor history.

### Incremental Compression

The compression semantics do not change. The current implementation also uses
the previous summary plus messages after `last_message_index`; the cursor only
replaces how that boundary is represented and queried so the summarized middle
does not need to be loaded.

When the snapshot-aware context exceeds the compression threshold:

1. Treat `messagesAfterCursor` as the incremental range.
2. Keep the configured last N messages verbatim.
3. Fold the earlier part of the incremental range into the existing summary.
4. Save the database ID of the final folded entry as the new cursor.
5. Retain the previous cursor when no incremental entry is summarized.

The token decision must be based on the exact effective context sent to the
model: protected head, summary, and post-cursor range. Tokenizing the already
summarized middle section is unnecessary and would produce the wrong decision
surface.

If the post-cursor range grows unusually large before compression runs, read it
in bounded batches. Batching should limit temporary memory without changing
message order or compression semantics.

### First Compression

Without a snapshot, load the complete normalized context history. The first
summary cannot be accurate without reading the content it represents.

When full compression selects the protected tail, save the ID of the message
immediately before that tail as `compressed_through_message_id`. If no message
is successfully summarized, do not create or advance the snapshot cursor.

### Turn-Aware Boundaries

Do not advance a cursor into the middle of an assistant tool call and its tool
results. Before finalizing a compression range:

- keep an assistant `tool_calls` message with all corresponding tool results;
- do not start a post-cursor range with an orphaned tool result;
- keep existing fallback inference for legacy rows missing `tool_call_id`, or
  normalize those relationships before choosing the boundary;
- move the boundary backward when the desired cut would split a logical turn.

The cursor must identify the final database row of the complete folded turn,
not merely the row at a desired numeric tail size.

### Snapshot Validation And History Revision

Append-only writes do not invalidate a cursor. Destructive or rewriting
operations must invalidate it transactionally.

A cursor snapshot is usable only when:

- its captured `history_revision` matches `sessions.history_revision`;
- its cursor row still exists and belongs to the same session;
- the cursor row still participates in the normalized context order;
- the summary and cursor were committed together.

Append-only message inserts do not increment `sessions.history_revision`.
Increment the session revision and delete or invalidate its snapshot in the same
transaction when an operation:

- clears session messages;
- deletes or edits a message at or before the cursor;
- replaces imported history;
- rewrites message ordering or context eligibility.

Deleting a session must also delete its snapshot. Clearing history must not
leave an old summary available to future messages. This needs explicit coverage
because the current clear path does not invalidate the compression snapshot.

Compression calls the summarizer outside a database transaction. Snapshot save
must therefore be compare-and-swap: it receives the revision observed when the
compression input was read and writes only if the session still has that
revision. A clear, edit, import, or delete that happens while summarization is in
flight must prevent the old compression result from recreating a stale
snapshot.

### Branched Sessions

Branch creation copies messages into new rows with new IDs, so the parent's
cursor cannot be copied unchanged.

While copying branch messages:

1. Preserve the source message ID alongside each copied message.
2. Record the mapping from source ID to child ID.
3. Translate the parent's `compressed_through_message_id` through that map.
4. Copy the summary only when the cursor is present in the copied prefix.
5. Otherwise start the child without a compression snapshot.

The existing index can remain useful as a migration fallback because a 1:1
branch copy preserves ordinal position, but the child snapshot must ultimately
store its own message cursor.

### Legacy Snapshot Compatibility And Upgrade

Existing snapshots have only `last_message_index`. They must not be invalidated
as a deployment migration and must not be forced through a new full-history
summary. Until upgraded, they continue through the current index-based read and
compression path.

Upgrade a legacy snapshot only when that session next actually enters a
compression cycle:

1. Load the legacy normalized history using the existing path. This is work the
   old compression cycle already requires; do not add a separate full read on
   resume, session open, or a run that does not compress.
2. Carry each surviving context entry's database message ID through
   normalization.
3. Resolve the existing `last_message_index` to the corresponding database
   message ID and resolve the protected-head boundary used for the new
   snapshot.
4. Validate that the resolved boundary belongs to the session and does not
   split a tool interaction.
5. Reuse the existing summary as the previous summary and summarize only the
   incremental range selected by the normal compression algorithm. Do not
   summarize the already compacted history again.
6. Atomically save the resulting summary, cursor, protected-head boundary, and
   captured session revision. Keep `last_message_index` populated for
   compatibility and diagnostics.
7. Use the new cursor path on later runs.

If compression is not triggered, the legacy snapshot remains unchanged and the
session continues to behave exactly as it does today. If summarization or the
compare-and-swap save fails, retain the legacy snapshot rather than partially
migrating it.

If the legacy index cannot be resolved or would split a tool interaction, do
not guess a cursor and do not discard the existing summary automatically. Log
the reason and keep the snapshot on the legacy path. A separately designed
repair or explicit invalidation path can handle irrecoverable snapshots without
making normal upgrades destructive.

Using SQL `OFFSET last_message_index` alone is not sufficient for the permanent
design. It avoids materializing old content but still depends on a shifting
ordinal and may not match the normalized context array when rows are filtered.
The upgrade uses the already constructed cursor-carrying normalized history so
the persisted cursor identifies the same model-visible boundary as the legacy
index.

### Resume And Display Separation

Opening or reconnecting a session must not prepare the next model request.

The resume path should:

- load only the latest display page;
- query session and parent metadata without message bodies;
- return persisted usage values when available;
- defer snapshot-aware context construction until a run actually starts.

Starting a run should be the only path that assembles compression context. If
fresh context-token usage is needed before the next run, calculate it from the
summary, bounded head, and post-cursor range, preferably outside the latency
critical resume response.

## Data Access Boundaries

Introduce focused helpers instead of reusing full `getSessionDetail()`:

```ts
getSessionMetadata(sessionId)
getContextHead(sessionId, validLimit)
getContextAfterCursor(sessionId, cursorId, batchOptions?)
getContextHistoryForFirstCompression(sessionId)
resolveLegacyCompressionCursor(entries, lastMessageIndex)
```

Routes and Socket.IO handlers should not select message bodies when they need
only session metadata. Compression services should consume cursor-carrying
context entries rather than generic session-detail objects.

Inventory and migrate every Hermes snapshot consumer, including run-context
assembly, usage calculation, Bridge compression events, forced compression,
session commands, and export compression. Updating only the primary
`buildCompressedHistory()` call would leave hidden complete-history reads in
the runtime path.

Coding Agent usage and resume paths are separate consumers. They should use the
latest display page plus persisted or native-agent usage values and must not use
compression snapshot helpers to reconstruct a model context that the Web UI
does not send.

## Observability

Add structured timings around:

- display-page query and mapping;
- session metadata query;
- post-cursor context query;
- token estimation;
- first and incremental compression;
- legacy cursor migration.

Log the number of raw rows read, valid context messages produced, cursor ID,
snapshot revision, and elapsed time. Do not log message content or summary text.
Warn when a synchronous stage exceeds a defined threshold, initially one
second.

## Tests

### Snapshot And Cursor

- First compression stores the final summarized message ID.
- Incremental compression reads only protected head and post-cursor messages.
- A no-op incremental compression does not advance the cursor.
- Summary plus cursor produces the same effective context as the legacy full
  array implementation for representative histories.
- Filtered messages do not shift or corrupt the cursor.
- Tool calls and results are never split across the boundary.

### Mutation And Branching

- Appending messages preserves snapshot validity.
- Clearing history invalidates the snapshot in the same operation.
- Deleting a session removes its snapshot.
- Editing or removing a pre-cursor message invalidates the snapshot.
- Branch creation maps the parent cursor to the correct child message ID.
- A partial branch that excludes the parent cursor does not copy the snapshot.

### Legacy Migration

- Deployment leaves legacy snapshots, summaries, and index fields unchanged.
- Opening, switching, reconnecting, and non-compressing runs do not migrate or
  invalidate a legacy snapshot.
- The next actual compression cycle reuses the old summary, resolves the legacy
  index, and persists a cursor without re-summarizing the compacted prefix.
- A failed compression or revision compare-and-swap leaves the legacy snapshot
  usable and does not partially migrate it.
- An invalid or turn-splitting legacy index remains on the legacy path and is
  reported without guessing a cursor.
- Later loads use the cursor path without another full-history query.

### Resume And Performance

- Socket resume emits only the configured latest page.
- Resume metadata does not call a full session-detail query.
- Resume does not build or tokenize complete DB history.
- A normal Hermes Bridge run with a cursor snapshot does not perform a complete
  history read through usage or context-token helpers.
- Coding Agent execution sends only current input through its native session;
  cold resume and post-run usage calculation do not reconstruct complete Web UI
  history.
- A synthetic session with at least 15,000 mixed user, assistant, and tool rows
  remains responsive while opening and switching sessions.
- A large session with a cursor snapshot reads a bounded head plus only the
  uncompressed range when starting a run.

## Implementation Slices

1. Add query instrumentation and focused metadata/context query helpers.
2. Remove full-history work from pure resume and reconnect paths, including the
   generic Coding Agent resume path.
3. Add session revision, snapshot cursor, protected-head, and snapshot revision
   fields without modifying existing snapshot rows or removing legacy fields.
4. Add transactional invalidation for clear, delete, edit, and import paths,
   plus compare-and-swap snapshot writes.
5. Carry database IDs through context normalization and update compressor
   results to return cursor boundaries.
6. Map new-format snapshot cursors during branch creation while preserving the
   current ordinal copy behavior for legacy snapshots.
7. Add dual-read behavior: cursor-first with an unchanged legacy-index fallback.
8. Switch new-format incremental context construction and all Hermes usage
   consumers to protected head plus post-cursor queries.
9. Remove complete-history Coding Agent context estimation and use
   persisted/native-agent usage values.
10. Upgrade a legacy snapshot only during its next actual compression cycle and
    add compatibility, performance, and operational-timing coverage.
11. Profile the completed path before deciding whether tokenization or SQLite
    work also needs a Worker Thread.

## Acceptance Criteria

- Opening, switching, or reconnecting to a session does not read or tokenize
  its complete message history.
- The first compression remains complete and accurate.
- After a cursor snapshot exists, context construction does not load message
  bodies already represented by the summary.
- Incremental compression never loses, duplicates, or reorders a model-visible
  message.
- Tool interactions remain structurally valid across every compression
  boundary.
- Clear, delete, edit, import, and branch operations cannot reuse an invalid
  summary.
- Legacy snapshots remain usable until a successful compression cycle upgrades
  them; their summaries are not discarded or regenerated solely because of the
  schema upgrade.
- A snapshot with both legacy and cursor fields always uses the cursor as the
  read boundary while retaining the legacy field for compatibility.
- Coding Agent runs never receive reconstructed Web UI history and do not use
  Web UI compression snapshots.
- Existing 150-message paging and live-chat rendering limits remain unchanged.
- Focused tests cover a history of at least 15,000 mixed-role rows.

## Open Questions

- Should large post-cursor ranges stream from SQLite in batches or move to a
  Worker Thread after cursor adoption?
- Should per-message token counts be completed and aggregated so resume can
  show fresh usage without tokenizing text?
- Should message edits be supported as snapshot-invalidating operations, or
  remain unsupported for persisted chat history?
- Is a per-session monotonic context sequence preferable to mapping global
  message IDs during branch creation?
