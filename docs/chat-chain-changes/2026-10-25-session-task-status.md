# Manual session task status

Studio Web/Desktop and the companion App let users select Incomplete, Completed
or Closed from a task row's status control. The status filter includes Closed.
Saving disables that row's control; failed writes leave its previous status
visible and show an error. Successful writes refresh the active filters and
pagination. Status controls never navigate to the conversation.

`PATCH /api/studio/sessions/:id/tasks/:taskId/status` accepts only `status` and
`expected_updated_at`, using the timestamp from the list row. The controller
checks session/profile access and pending deletions and rejects run credentials.
The repository rechecks the session's profile/history/ledger revisions and task
timestamp inside the transaction. A stale row returns 409; status changes advance
both the row timestamp and ledger revision. Selecting the same status is a no-op.
Startup upgrades the legacy SQLite status CHECK constraint transactionally,
preserving existing task rows, columns, indexes and triggers. The upgrade is
idempotent and leaves existing ledger revisions unchanged.

Closed tasks remain in the ledger and list. They follow open and completed tasks
in the default list, and link to the original request. The model's update tools
continue to accept only open/completed. They can read closed tasks, but cannot
change them by id or normalized title; an attempted mixed batch is rejected
atomically. Only a manual status change can reopen a closed task. Turn prompts,
native tool descriptions and MCP descriptions state that boundary explicitly.

Manual completion records `Manually marked completed by the user.` as evidence,
with the original request as its message anchor, so it does not claim model
verification or invent a completion turn. Reopening or closing clears completion
metadata. Existing task-completed webhooks apply to manual completion; closing
does not emit a completion event. Session/history cleanup remains unchanged.

Focused tests cover permissions, stale writes, all status transitions, model
protection and atomic rejection, filtering, original message links and the
desktop/mobile controls. The App browser fixture exercises real components in
Chromium and WebKit, including disabled and failed-save states.
