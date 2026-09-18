# App business-event subscriptions

The in-process hub in `services/webhooks/business-events.ts` is shared by HTTP
webhooks, existing social-message push and the App adapter. `observeChatRunWebhookEvent`
is the backwards-compatible producer entry; it normalizes before publishing. Group
Agent reply persistence publishes `group.message.created`; workflow socket's manager
terminal callback verifies persisted run status before publishing
`workflow.run.completed` / `workflow.run.failed`. A workflow node's chat event cannot
become a workflow-terminal or ordinary single-chat App notification.

## Wire contract v1

On the existing authenticated `/chat-run` namespace, send `app.events.subscribe`
with `{schema_version:1, profile:"default", types:[...]}`. Optional `session_ids`,
`room_ids`, `workflow_ids` narrow the subscription. Empty/omitted profile resolves
to `default` before authorization; omitted types select the supported App set.
Unknown types and malformed filters are rejected. Ack is `{ok:true,schema_version:1}`.
Android requests `include_snapshot:true`; the same ACK also contains `timestamp`
and `snapshot`, an authorized array of current run states, task cards and pending
interactions. This is a state snapshot, not a replay of historical completion events.
`app.events.unsubscribe` removes the selection. Disconnect removes the hub listener.
Reconnect must explicitly resubscribe; there is no backlog or offline delivery.

`app.event` carries `schema_version`, stable `id`, `type`, ISO `occurred_at`, `profile`,
`source`, `subject` identifiers and bounded `display` title/preview/Agent/roster fields.
Types: chat.run.completed/failed, chat.approval.requested/resolved,
chat.clarification.requested/resolved, group.message.created,
workflow.run.completed/failed, group.run.failed, group.approval.requested/resolved,
group.clarification.requested/resolved, chat.run.updated, group.run.updated,
workflow.run.updated, chat.plan.updated, group.plan.updated, workflow.plan.updated.
State and progress envelopes carry `notify:false`, numeric `timestamp` and either
`state` or `task_plan`; they do not need `display`. Interaction metadata includes only
resolution/reason and timeout fields, never commands or answers. Interaction IDs remain in subject so requested and
resolved update the same UI item even though their event IDs differ.

JWT/account and current profile assignments are checked for every delivery. Group
membership/visibility is also rechecked using the existing group access policy.
Group approvals require the agent owner; group clarifications require room management.
The same permissions and subscription filters apply to initial snapshots.
Filters only narrow this authorization. Internal payloads are never sent verbatim.

## Compatibility and channels

New App sends `auth.appEventVersion=1`, subscribes on this single namespace and does
not open legacy group/workflow notification listeners. Old clients retain the three
legacy event names through a hub consumer. Version-1 clients never get both channels.
An old server rejects the new command: new App records unsupported/denied and does
not silently enable competing legacy channels. Deploy server before the App.

LAN and manual-address connections use LocalAppRelayServer; cloud uses AppRelayClient.
Both whitelist the two commands and forward the same namespace/auth/query/envelope.
No new cloud binding, endpoint, APNs, OS push, or relay event-specific transport exists.

HTTP consumers receive a metadata projection with optional assistant/user message
content controlled by the endpoint switches. They can also subscribe to
`group.message.created`, `group.run.failed`, `group.approval.requested/resolved`,
`group.clarification.requested/resolved`, `workflow.run.completed/failed` and
`chat.plan.updated` / `group.plan.updated` / `workflow.plan.updated`.
Domain envelopes use room/workflow/run subjects and omit an inapplicable chat session
or agent field. Group tool messages never expose tool output as message content.
`domain-events.ts` owns these producers independently of the App socket adapter.
The foreground JS adapter selects only alert types; the Android native adapter also
consumes state, progress and pending interactions. Social push retains its
original three event types, session push flag, recipient binding and generic message
format; the new domains do not automatically expand social delivery. Consumers catch
sync/async failures independently. App ignores snapshots, old events, canceled,
interrupted and queued-continuation completions; UI preferences stay on the device.

Studio mobile push is another independent hub consumer. It uses only the event's
internal `push_target_id` to read the saved run snapshot; that field and the snapshot
credentials are excluded from HTTP/App envelopes. No HTTP webhook configuration is
needed for mobile push. Mobile push has its own single-attempt behavior and never
uses the HTTP dispatcher's retry queue. See [run push snapshots](run-push-registration.md).

## Task-card progress webhooks

There are 26 HTTP webhook event types, including three task-card progress types and
three `*.run.updated` state types.
Chat and workflow `plan.updated` runtime events publish `chat.plan.updated` and
`workflow.plan.updated`; workflow subjects also retain workflow/node identifiers.
Group cards publish `group.plan.updated` only after the versioned tool message is
persisted. Updating the same group message ID must not hide later plan revisions.
History loads and native group runtime events do not publish a second progress event.

Each envelope has `summary.status: "updated"`, `subject.plan_id` and a `task_plan`
object containing session/run/card IDs, revision, execution state, timestamps, steps
and `progress: {total,completed,in_progress,pending,percent}`. Percent is the floored
percentage of completed steps. The execution states are `running`, `ended`,
`interrupted`, `failed`; ending a run does not force unfinished steps to completed.

Step entries always include `id` and `status`. The endpoint's `include_content`
option adds step text and the optional explanation; neither is exposed by default.
Unknown runtime fields, commands, credentials and MCP input objects are excluded.
Malformed or foreign-session snapshots are ignored.

Event identity includes the card and revision. A bounded in-memory revision map
rejects duplicate/older updates without preventing concurrent cards from updating.
As with other webhooks there is no event history/backfill; HTTP delivery still uses
the endpoint's existing retry policy. Consumers can use the event ID and revision
for idempotence. Progress events do not trigger APNs alerts or social-message push;
the App's existing task-card transport continues to display its live updates.

## Android background notifications

The native relay reuses the existing App connection and opens only a `/chat-run`
notification observer per authenticated profile. It subscribes to `app.events` with
`include_snapshot:true`. Notification observers never issue per-session `app.resume`,
`load_room_agent_activities`, `load_pending_approvals` or `workflow.status.subscribe`.
UI chat/group/workflow sockets remain responsible for their actual screens.

Live state and task-card events update the quiet Android foreground progress
notification, including completed/total steps, current step and waiting status.
Completion/failure events and pending interactions provide system alerts; the real
UI's raw events cannot produce a duplicate native alert. Chat result unread counts
use the unified event ID. Group and workflow result identities are deduplicated.

On reconnect, the native observer resubscribes and buffers live events until the
snapshot ACK arrives. Connection generations reject stale ACKs. Snapshot timestamps
and task-card revisions prevent buffered older updates from replacing newer state.
An empty authorized snapshot clears stale confirmed tasks without inventing a result
notification. Snapshots restore pending interactions and progress for active runs.
Workflow notification state contains only identifiers, status, timing, approval IDs
and active node session IDs; execution inputs/outputs and errors are excluded.
