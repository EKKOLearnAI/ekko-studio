# Person main-conversation display protocol

The server applies `person-display-v1` to `person-main-*` sessions after account
authorization. It never applies the projection to `person-task-*`, ordinary
chat, workflows or group chat. There is no client-controlled switch to bypass
the main-conversation projection.

`modules/studio/services/chat-run/person-display.ts` owns the projection. The
runtime, model history, database, internal event callbacks and presence observers
retain complete data. Only display clones cross the Socket.IO and HTTP response
boundaries.

Messages use declared display fields. Tool/MoA rows become empty assistant
slots; mixed assistant replies retain visible text and attachments without tool
calls, tool IDs, arguments, reasoning aliases or opaque provider objects. Native
content blocks and reasoning tags are normalized, including double-serialized
blocks. Code examples and user text remain display content. Malformed native
blocks fail closed.

The event allowlist preserves approvals, clarification, durable questions,
plans, terminal/abort/compression state, numeric usage and background status.
Approval command/description and user questions remain available for human
review. Tool/thinking events and unknown event families are suppressed. Opaque
context and raw background previews never pass through as arbitrary objects.
Live text projection retains boundaries across split tags. Replay deltas from a
bounded event ring are emitted only after a retained `run.started`; otherwise
the visible partial reply waits for terminal output or a persisted snapshot.

The boundaries include live Person Ekko events, external event fanout,
`resume`/`app.resume`, notification subscription snapshots, full/paginated history,
the legacy full-history fallback, conversation/context reads and exports. Search
snippets are reconstructed from the complete matched message; a match confined
to hidden content has a null snippet and message target. Such a session can
still appear in the existing raw search result set. The search query/index is
unchanged, so a newer hidden match does not automatically select an older
visible match. Unframed metadata previews are blanked for Person main sessions.

## Pagination and released App compatibility

Released clients advance raw `OFFSET` by `messages.length` and stop on an empty
array. Each existing source row therefore retains an inert slot, original ID,
timestamp and run marker. Display mappers ignore empty assistant slots. Tools,
arguments, results and reasoning do not survive in those slots.

`total`, `offset`, `limit`, `hasMore`, `messageTotal`, `messageLoadedCount` and
`hasMoreBefore` retain their original raw-row meanings. Paginated Person history
also reports `projection`, `consumedCount` and `nextOffset`. These fields are
additive; old clients can continue using array length. The Studio client counts
visible messages for its Person loading budget and treats a consumed hidden page
as progress, including during search navigation. Task plans are selected using
the original page before projection. Receipts and workspace changes retain their
exact assistant message IDs.

App cache IDs are calculated after projection, receipt/usage attachment, task
plan selection and workspace binding. `projection` participates in the hash and
is echoed on cache hits. Existing full-page IDs therefore miss. Cached responses
still contain live state and safe events.

New Apps opt into the shared Person timeline with `app.resume` payload
`{session_id, id, timeline:true}`. The first page contains at most 150 combined
message/card references in `personFlows.timeline`, lightweight `personFlows.cards`,
and the matching projected messages. Messages, cards and cursor all participate
in the conditional cache ID; on a hit the App restores them together from its
scoped cache. Released Apps omitting `timeline:true` retain raw message paging.

Timeline clients request older pages at the existing paginated-history endpoint
with `timeline=true&before=<opaque cursor>&limit=150`. Use `timeline.has_more` and
`timeline.before` to advance even when `messages` is empty. Keep at most 300
combined references, preserve an older reading window on reconnect, and reload
the latest page explicitly when returning to the tail. Recent `person.updated`
snapshots merge into retained cards rather than replacing paged history. Clear
history changes the timeline revision and invalidates previous cursors/windows.

No App repository change is required for the server filtering or raw-offset
compatibility. Already-installed Apps can display their old local cache before
the new server responds, or while offline. A server cannot erase those historical
bytes. Guaranteeing clean local/offline caches requires a separate App change:
version the Person cache namespace, reject full/old snapshots for that namespace,
and clear old Person entries. New-server filtering does not protect a client
connected to an older server. No App cache migration or App release is included.

Explicit approval/question text, user-provided examples, visible final answers,
task cards, task detail and authorized file artifacts are intentional business
content. This display policy does not perform arbitrary secret redaction within
that content. Raw OFFSET also retains its existing concurrent insertion/deletion
limitations; it is not an immutable cursor.

## Verification

- `tests/server/person-display.test.ts`: message/block/tag projection, every
  split of live reasoning, replay, interactions, metadata, raw paging, cache IDs,
  task/ordinary-chat scope and source immutability.
- Chat-run runtime and socket tests: actual delivery boundaries, complete
  internal callbacks and persistence, resume/cache behavior and task details.
- Session controller and Person tests: history/fallback/context/export paths,
  metadata, search hits and authorization.
- Client search/store tests and Person browser tests: hidden-page progress,
  receipt anchors, approvals and task-detail tools.
