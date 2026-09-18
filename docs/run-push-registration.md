# Per-run push snapshots

Studio stores the initiating App identity and immutable notification data when accepting a root run. It does not manage push credential registration, refresh, expiry synchronization or receiver replacement.

## Admission

- Single chat: the App `run` event includes optional `push_snapshot`. Studio creates an independent root run ID and captures metadata before queuing. The snapshot field is removed before dispatching the chat input to agent execution. The socket later draining a queued run cannot change its destination.
- Group chat: the human message ID is the root run ID. The message submission carries its snapshot; trusted child/handoff links retain the original target. Snapshot credentials are not persisted in group messages or broadcast to members.
- Workflow: `POST /api/studio/workflows/:id/run` accepts the optional snapshot alongside the existing input. Admission persists it with the newly created workflow run; node runs inherit the root target.
- Web/scheduled/guest executions do not infer a phone recipient. Missing/invalid optional push data produces a run without a notification snapshot, never a backfill or fallback to another phone.

## Stored data

`run_push_targets` contains `kind`, `profile`, `run_id`, `subject_id`, the authenticated local user and phone installation, **`studio_device_id`**, and `push_snapshot_ciphertext`. The Studio ID comes from `getAppRelayDeviceIdentity().device_id`, the same identity used by App LAN/cloud connections. It is not the phone's `device_id`, a socket ID, or an App connection list ID. Body-supplied Studio/installation IDs must match before accepting a snapshot.

The snapshot is encrypted using AES-256-GCM and a mode-0600 `.push-token-key` under `config.appHome`. It includes only platform, application/environment, APNs address, dedicated push token/grant ID, cloud account and destination Studio/installation. App login tokens and claimed expiry are not copied. Token renewal/rotation, switching accounts or connecting another Studio cannot overwrite an existing run. `run_push_links` maps child runs/messages to the same immutable root.

## Reading and routing

`readRunPushNotification(ref)` reads only the selected run, decrypts its snapshot and returns a credential/recipient pair plus a separate allowlisted click route. The route contains `studio_device_id`, `cloud_user_id`, `run_kind`, `run_id`, `profile` and the appropriate session/room/workflow ID. Credential/address fields do not appear in the click route or public events. It does not consult a mutable device table or a local expiry cache.

The App uses this route to reconnect the saved Studio before opening the task. A removed/unreachable original connection or account mismatch must not redirect the notification to another Studio.

## Event-driven delivery

`services/notifications/run-push.ts` is an independent consumer of the webhook business-event hub. `ensureBusinessConsumers()` installs it for both chat and domain producers, so a workflow/group event can be the first event after startup; it does not depend on a foreground App socket or a configured HTTP webhook endpoint.

| Webhook event | Push category |
| --- | --- |
| `chat.run.completed`, `chat.run.failed` | completion / failure |
| `chat.approval.requested`, `chat.clarification.requested` | approval / interaction |
| `group.message.created` (final assistant reply), `group.run.failed` | completion / failure |
| `group.approval.requested`, `group.clarification.requested` | approval / interaction |
| `workflow.run.completed`, `workflow.run.failed` | completion / failure |

The group producers publish persisted reply/error facts and authenticated pending-interaction facts. Group runtime IDs link to the initiating root. Workflow nodes inherit the workflow root; their completion/failure events do not produce extra push notifications. Workflow node approvals are currently automatically answered with `once`, so they do not produce a user-action push; a node clarification retains the root workflow destination. Resolved interactions remain webhook events but do not send another push. Interrupted/replayed events, tool progress, missing snapshots and Android snapshots are skipped.

For each accepted event Studio reads only its immutable run snapshot and POSTs once to `/push/v1/send` on `config.appRelay.url`. The dedicated credential goes in `Authorization: Bearer`; the JSON contract is `{schema_version:1,event_id,event_type,recipient,notification:{title,body},ekko_run}`. `recipient` contains the saved platform/app/environment/APNs address, and `ekko_run` contains the saved click route. Titles/previews are bounded, with raw errors, commands and tool output excluded. The account server's pending endpoint must supply a generic notification when the preview is empty.

A bounded in-memory set suppresses duplicate terminal/interaction events (chat/workflow by root, group replies by response run/message). There is no persisted delivery history or replay after restart. The request has a 10-second timeout and rejects redirects. Every response, including 401/429/5xx, and every network failure ends the attempt; no credential checks/renewals, repairs, retries, delivery outbox or later backfill occur. Push errors do not affect the run or other consumers.

The account server's APNs send endpoint and signed-device validation are still pending. The Studio consumer and request contract are implemented; actual APNs delivery cannot work until that endpoint is implemented and configured. Existing Android notification behavior is unchanged.
