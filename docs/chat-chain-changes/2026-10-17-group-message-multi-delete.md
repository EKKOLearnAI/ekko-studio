# Group chat message multi-select deletion

Extends PR #3422 to managed Studio group rooms. The confirmed behavior is that
messages already included in a summary cannot be deleted; unsummarized member
messages and complete Agent runs can be selected independently.

## UI and permissions

- Right-click a group message to enter selection. Desktop uses the existing
  native message-menu bridge (including Copy when text is selected); web and
  older desktop shells use the dropdown without replacing the text Copy menu.
- Whole-row clicks and checkboxes toggle an item. Dragging text preserves text
  selection. One Agent run includes its replies, reasoning, tools, usage and
  task-plan records across history pages. There is no select-all action.
- The delete/cancel toolbar sits above the composer. Deletion requires a
  confirmation. Summarized rows show a disabled checkbox and an explanation.
- The entry is available only to room managers in the local Studio group panel.
  Invite guests and standalone/shared viewers have no deletion entry. Both REST
  endpoints enforce the existing group-room management permission.
- Switching rooms, new messages, summary changes, active runs or queued work
  invalidate selection. A late menu response or selection fetch cannot select
  messages in another room.

## Persistence and concurrency

`GET /api/studio/group-chat/rooms/{roomId}/message-selection` returns persisted
selection identities, protected reasons and an opaque SHA-256 `historyRevision`.
It covers the full persisted room transcript, committed summary/snapshot state,
summary generation and deletion revision, rather than only the visible page.

`POST /api/studio/group-chat/rooms/{roomId}/messages/delete` accepts `messageIds`
and that revision. It rechecks idleness and permissions, holds the room summary
lock, and validates all selected identities in one immediate SQLite transaction.
Any missing, stale or protected item rejects the entire operation. Selecting any
part of a run expands to all its persisted messages, scoped by Agent identity.

The canonical order determines the protected prefix, inclusive of the current
rolling-summary anchor and any legacy context snapshot. A group touching either
prefix is locked. Missing anchors, inconsistent timestamps, or a nonempty summary
without an anchor lock all messages. Active runtime sessions, in-memory mention
queues, durable execution queues, uncertain/in-flight handoffs, persisted streams
and summary work block deletion.

Only selected transcript rows and their routing/queue/workspace-diff records are
removed. The committed summary body, cursor, version, turn count and timestamp
remain intact. An unfinished summary drain cutoff is cleared so the next run can
summarize the retained tail. The summary generation advances to reject stale JEV
review application, and pending room review/routing sidecars are cancelled.
Completed handoff audit records are retained; their deleted sources cannot be
resumed or presented through the existing source-message joins.

Context token totals are recalculated from the retained context window. Each new
Agent turn already rebuilds its input from the committed shared summary and the
persisted unsummarized tail; deleted rows therefore stay absent from later runs.
Separate runtime history, long-term memory and physical files are not erased.

## Client synchronization

`gc_rooms.messageDeletionRevision` is additive and defaults to zero. The deletion
response and `messages_deleted` room event include the new revision and exact
deleted IDs. Clients apply the result once, preserve the summary, clear deleted
references and routing cards, and reject late deleted-message events or in-flight
older history pages.

Join acknowledgements carry the persisted revision. When deletions were missed
while disconnected, cached older pages are discarded and can be reloaded. The
client compares with the revision and cached IDs captured when the join request
was sent, preserving new live messages even if another deletion arrives before
the acknowledgement. A stale acknowledgement cannot lower the known revision.

## Verification

- Real SQLite and Socket.IO tests cover summarized and legacy boundaries, runs
  spanning pages and summary anchors, all-or-nothing rejection, stale selection,
  busy states, room permissions, transaction rollback, future context, preserved
  summaries, frozen drain invalidation and reconnect revisions.
- Store tests cover duplicate HTTP/socket results, retained summaries, deleted
  references, late pages/events, room switches and reconnect acknowledgement races.
- Browser coverage exercises light/dark themes with and without wallpaper, narrow
  layout, row/checkbox selection, text Copy, protected and unknown boundaries,
  confirmation, refresh, busy/stale handling, manager permissions and desktop
  main/chat native-menu dispatch. OS menu painting is covered by the existing
  bridge implementation; these tests mock the bridge response.

Validation results on the final implementation:

- `npm run build`, `npm run harness:check`, and `git diff --check`: passed.
- Focused group/chat server, store, UI and single-chat deletion suites:
  **879 passed, 2 skipped** across 71 files.
- Browser group/chat/theme regression: **106 distinct cases passed after rerun**.
  The final 15-case run includes all 10 new group-deletion cases, four group-theme
  cases and the single-chat reload case that timed out in the wider run.
- Full coverage sweep: **8,343 passed, 35 failed, 38 skipped**. All 33 client and
  other exactly matching failures reproduced on untouched PR #3422 code. The two
  remaining Windows run-manager cases passed focused runs on both baseline and
  current code. The full suite is not claimed green; baseline comparison of the
  18 failing files itself reported 37 failures because timing-sensitive cases
  varied. The final reconnect-race follow-up passed the focused suites above.
