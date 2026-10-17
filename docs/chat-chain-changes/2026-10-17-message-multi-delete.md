---
date: 2026-10-17
pr: pending
feature: Hermes and Ekko message multi-selection and deletion
impact: Delete complete uncompressed agent runs while preserving existing summaries and compression cursors.
---

Hermes and Ekko direct chats offer message selection from a message's context
menu. A user message is one item; all assistant fragments, reasoning and tool
records for an agent run are one item. Each group has a dashed outline until
selected, then a solid accent outline. Agent checkboxes sit at the inline start
and user checkboxes at the inline end, vertically centered over the complete
item. Selection uses persisted IDs after refreshing streamed messages. The
selection actions sit immediately above the composer's context-usage row.
Clicking a group's content or empty space toggles the whole item; the checkbox
also toggles once. While selecting, group clicks suppress nested buttons and
links, and compressed groups remain locked regardless of the click target. The
server expands a selection across display pages, including invisible tool-call
rows. The toolbar contains the selected count, delete and cancel actions; there
is no select-all action. Items are selected individually, while complete runs
are still removed across pages.

On desktop, the main and standalone chat windows use a native message context
menu. Selected text shows Copy and Select messages together; without selected
text, the menu contains Select messages. The localized action travels through
the preload/IPC bridge and uses the existing selection flow. IPC is restricted
to a trusted Studio main/chat window and its main frame. Menus are scoped to
their window and close on navigation, renderer exit, execution or selection
state changes. The renderer rejects stale results, including a run starting
and finishing before a pending menu action arrives, and session switch-away/
switch-back. Web and older desktop shells retain the browser Copy menu for
selected text and the custom message menu otherwise. Editable fields retain
their native editing menu, and child context-menu handlers take precedence.
Dragging text while in selection mode does not toggle the run; an ordinary
click still toggles it. Copy remains available while the session is producing
output, even though entering message selection is disabled.

Messages at or before the compression cursor are protected, including the
original protected head. A run touching that prefix is locked as a whole, even
if the visible answer is after the cursor. The UI disables these checkboxes and
explains the restriction. Legacy snapshots without a cursor, missing boundaries
and inconsistent snapshot revisions lock the entire history: their raw-row
boundary cannot be safely inferred from an ordinal in filtered runtime history.
Selection and deletion never clear or mark the compression status as failed.

The mutation hard-deletes only uncompressed Studio message rows. The current
snapshot is rechecked inside the SQLite transaction, since compression can
advance between selection and deletion without changing the history revision.
The transaction updates row counts and advances history_revision to reject
stale selections and in-flight summaries. A valid retained snapshot carries the
new revision while its summary, cursor, legacy indices, original message count
and compression timestamp remain unchanged. The next run uses the same summary
plus the remaining post-cursor messages; deletion itself does not recompress.

Legacy histories without run markers use contiguous agent rows between input
boundaries. Before removing an input, surviving uncompressed legacy runs receive
stable markers so deleting the separator cannot merge previously separate runs.
Existing run markers remain authoritative, including runs interrupted by an
inserted user message. Stale selections and IDs outside the session are rejected
atomically.

Deletion requires an idle session: foreground/aborting runs, manual compression,
queued work and known pending background tasks prevent it. Manual Hermes
compression holds an explicit history lock until its promise settles, including
failure; Ekko manual compression already reserves the run state. The Hermes
worker is also checked before the final synchronous idle check and transaction.
Successful mutations invalidate the server transcript cache and publish a
session-scoped event. Clients remove deleted items, replace stale context estimates,
and reload the current page without clearing compression status. Requests begun
before that revision cannot restore stale pages. Associated task plans and
workspace change previews are removed. Billing usage remains an accurate record
of past API calls.

When a run starts after cache invalidation, `getOrCreateSession` now restores an
existing conversation's persisted display page and pagination baseline
synchronously. Creating an empty placeholder in the run dispatcher previously
bypassed the agent handler's history load: only the next turn reached memory,
and a later `resume` replaced the browser transcript with that incomplete list.
This was a display-cache regression; the unselected database rows and the
snapshot were not deleted by that path. Bridge reattachment uses the same
hydration helper. Live cached state remains the same object, preserving pending
events and run ownership. Hermes input messages adopt their persisted IDs so
gaps left by deletion cannot collide with retained rows in the rendered list.

Deletion returns a fresh context estimate based on the protected head, retained
summary and remaining post-cursor messages, with runtime tool-result truncation
and known Hermes/Ekko fixed prompt/tool overhead. Estimation only reads the
compression snapshot. A separate `sessions.context_usage_estimate` checkpoint
keeps that estimate and overhead across repeated edits, refreshes and restarts;
its history revision, last message ID, model/provider and summary cursor/time
must still match. A new run, history edit or compression invalidates it. A cold
resume without a valid checkpoint estimates the current effective history.
Neither estimation nor the checkpoint writes billing totals or usage records.

The composer no longer substitutes cumulative input/output consumption when
current context usage is absent. A valid zero stays zero; unavailable usage and
remaining capacity display as an em dash with no percentage bar. Native coding
agent session totals retain their existing cumulative display.

This operates on Studio conversation history. It does not erase independently
stored Hermes Agent history, uploaded files, exports, or Ekko long-term memory.
Those stores are not substituted for the ordinary next-run conversation input.
Coding Agent native sessions, group chats, workflows and shared-session viewers
are outside this feature.

Validation covers transactional rollback, cross-session/profile access,
cross-page and legacy grouping, cursor-spanning runs, preserved snapshots,
advancing compression cursors, stale summary writes, manual compression locks,
cache invalidation, two-tab command fanout, right-click selection, checkbox
alignment, dashed/solid boundaries, individual selection/cancel, deletion and reload, and
narrow light/dark layouts with and without wallpaper.

Verification: 396 relevant unit/regression tests and 36 browser cases passed.
The production build, theme/module harness and generated API documentation
checks passed. The full coverage sweep was also run; after fixing the selection
watcher and rerunning load-sensitive failures, the remaining 39 failures across
20 files exactly match the failures previously reproduced on untouched HEAD.
The composer-toolbar and whole-row click follow-up passed 72 focused tests,
all eight selection browser cases (including nested-button suppression), the
production build and harness checks.
The context-usage follow-up passed 299 focused/regression tests and all eight
selection browser cases, including 19k context alongside 136.1k cumulative
usage, post-deletion refresh, compressed-prefix protection and valid zero
context. SQLite integration covers retained summaries, fixed overhead,
consecutive deletions, cold resume and stale checkpoint invalidation. The final
production build and harness checks passed.
The resume follow-up passed 342 focused/regression tests and ten browser cases.
It covers real SQLite deletion followed by two appended turns, warm and cold
resume, histories on both sides of the 150-row display limit, the socket run
dispatcher, and Hermes/Ekko send/switch-back/reload flows. Persisted input IDs
are also checked against retained rows with gaps. The production build and
harness passed. A fresh full sweep ran 8,350 tests: 8,271 passed, 38 skipped,
and 41 failed. The two additional failures were timeouts and their 27-test
focused rerun passed; the remaining 39 failures exactly match the previously
verified untouched-HEAD baseline.

The development-session investigation found an old, unchanged user row in the
database after a previous warm resume had returned only the latest two rows.
The corrected cold resume returned the persisted history. Existing logs did
not record the IDs selected for prior deletions, so they cannot establish
whether that particular old row was ever selected. A successful deletion now
logs the session, requested IDs, expanded deleted IDs, group count and before/
after history revisions, without message content. Failed transactions do not
emit a successful deletion log.

Regression coverage also distinguishes two user inputs with identical text:
deleting the newer input and its answer preserves the older row and timestamp;
deleting that older row removes it from both display history and model context
through another run and cold resume, for Hermes and Ekko. The investigation
used read-only access to the development database and did not delete, restore,
or rewrite that session's records.

The busy-session follow-up reproduced four failing cases before the fix:
aborting and queued sessions could retain selection, and a selection request
could reopen selection after a run started and ended before its response arrived.
Selection now checks the same busy states as deletion (including compression),
and a synchronous generation watcher cancels selections even when busy/idle
transitions occur within one Vue update. Starting a run also closes the delete
dialog and stale context menu. The selection-only hydration request carries a
generation guard into the store, so its late page response cannot overwrite live
output. A separate failing store case reproduced deletion's automatic refresh
overwriting the next completed turn. That refresh now verifies the transcript
identity, length and idle state before applying its result, with real browser
coverage for immediately sending after deletion. The selection HTTP endpoint now performs the server runtime idle check;
the deletion transaction retains its final synchronous recheck.

Shared hydration was exercised against real in-memory SQLite for eleven
source/agent combinations (Hermes, Ekko, native coding agents, group chat,
workflow and global agent), each with 6 and 180 persisted messages. All 22
cases match direct database loading, preserve the 150-row pagination boundary,
leave billing/history untouched, and retain the exact cached state object,
run owner, abort controller, pending events and queue. This covers ordinary
sessions that have never used deletion as well as the deletion-specific tests.
The focused server/store/selection suite passed 226 tests; all 18 selection
browser cases passed, including peer-run cancellation, working resume, late
hydration, immediate continuation after deletion and idle re-entry for Hermes
and Ekko. The final production build and harness/API documentation checks passed.

A separate session, `mvbzfm25c377c6`, was created on development backend 8647
for real-provider acceptance. The existing user-owned fixture was not changed.
The new session started with 120 synthetic messages and 102,868 estimated
history tokens, without a snapshot. `/compact` in the authenticated Studio
browser performed real DeepSeek compression and produced cursor 7554, locking
the first 100 messages and retaining 20 history messages after the cursor.
The displayed context fell from 102.9k to 7.0k. Deleting a compressed ID was
rejected with HTTP 409. Deleting tail IDs 7559 and 7560 returned 6,809 context
tokens; all other 119 rows were field-for-field equivalent, billing was
unchanged, and every snapshot field except its
history revision remained equal (including summary, cursor and timestamp).

The next real Ekko run loaded all 119 retained rows into its cold display cache
and answered a question about the retained TAIL-10 history. Both selection and
deletion endpoints returned 409 during that run. After completion, the database
contained those same 119 rows plus the new user/assistant pair, with the same
snapshot. Navigating away and returning through real Socket.IO resume returned
121 messages; the Studio browser showed the oldest prefix, retained tail and
new response, while the deleted TAIL-03 pair was absent. Real-provider acceptance
here covers Ekko; Hermes, native coding agents, group chat and workflow are
covered by the deterministic storage/runtime/browser regression suites.

The latest full coverage sweep ran 8,380 tests: 8,293 passed, 38 skipped and
49 failed. Comparing exact failure names against the untouched-HEAD baseline
identified the same 39 pre-existing failures plus 10 additional failures. All
10 additional cases passed in focused reruns of their 136 tests; the last three
timing-sensitive cases were also run unchanged on the baseline and then the
working tree (29 tests passed in each). The newly added deletion-refresh race
test was verified failing before its fix and passing afterward. The full suite
is therefore not reported as green; the remaining 39 failures match the
previously reproduced baseline.

The broader browser regression covered 101 distinct cases for streaming,
multi-tab session restore, Ekko/Cursor commands, workflow chat models, session
search pagination and group chat (including history cursor pagination, live
room switching, approvals and native-agent presets). The first run passed 76,
failed three and skipped 22 dependent serial cases. Rerunning the affected
multi-tab/group-chat files passed all 59 cases, completing the 101-case set.
Together with the 18 deletion-specific cases, all 119 distinct browser cases
passed after verification reruns. Browser suites use deterministic HTTP/socket
fixtures; the separate 8647 acceptance above used the real runtime and provider.

The desktop-copy follow-up reproduced both regressions before fixing them:
selected-text context menus were prevented, and dragging text during selection
checked the whole run. All 22 selection browser cases and 13 focused unit tests
now pass, along with the production build and harness. A separate real Electron
window loaded the same mocked Hermes/Ekko conversations and the production
`installSelectionContextMenu`: native `context-menu` events built the Copy role
for selected user/agent text in idle, selection and streaming states; editable
fields retained Cut/Copy/Paste/Select All. Unselected right-click still opened
the message menu and remained disabled during output. Native menu construction
and popup dispatch were verified; OS popup painting and clipboard writes were
not exercised.

The native message-menu follow-up passed 28 browser cases and 155 focused
client/desktop tests, including native bridge selection in main/standalone
windows, same-batch peer run completion, stale results after session switching,
window isolation, IPC authorization and existing screenshot behavior. The
production client/server build, desktop main-process build and harness passed.
Four real Electron scenarios (Hermes/Ekko × main/chat window) used the production
preload and menu IPC handlers. Native MenuItem actions entered selection in the
renderer, retained Copy alongside the localized selection action, rejected stale
and disabled actions, and preserved ordinary native editing menus. Test popup
dispatch was intercepted, so OS painting and clipboard writes remain outside
this automated verification. A running desktop shell must reload the rebuilt
main process and preload to expose the new bridge; older shells keep the
previous web-menu fallback.
