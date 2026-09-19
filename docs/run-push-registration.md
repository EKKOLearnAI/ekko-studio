# User-scoped mobile notifications

## Ownership shared by Android and iOS

Both the App relay event stream and the APNs consumer use `canReceiveAppEvent`.
The recipient is the authenticated **Studio login user**, not a Profile, cloud
account ID, last viewer or phone that submitted a run.

- Single chat: the session's persisted `user_id`, with current Profile access.
- Group: only `ownerAuthUserId`, with current room access. Approval notifications
  additionally require permission to handle that request.
- Workflow: persisted `workflow_runs.user_id` (including the schedule owner),
  with current Profile access.

Missing owners/subjects and disabled users receive nothing. Sharing a Profile,
being a group member or being a super-admin does not make someone the recipient.
This does not change permissions to view a workspace or execute tasks.

## Device registration and token storage

After native iOS registration and account-server grant renewal, the App calls
`PUT /api/studio/push/registration` through its authenticated Studio connection.
Registration is independent of task submission. It retries after reconnect and
refreshes on foreground, Studio/login changes and APNs token rotation.

The request body is `{schema_version:1, studio_device_id, installation_ref,
cloud_user_id, platform:'ios', app_id, apns_environment, apns_token, grant_id,
push_token}`. Only an active App connection JWT can register; a browser login
cannot. Studio derives `user_id`, installation and connection identity from the
JWT and connection store. Body-supplied Studio and installation IDs must match;
cloud connections also require the authenticated cloud account ID to match.
No client-supplied Studio user ID is used.

`user_push_devices` stores the Studio user, installation, connection ID and
connection-token hash, app/environment, recipient hash and encrypted registration.
It supports multiple phones per user. A phone/app/environment has one current
owner; re-registration replaces its old owner/credentials. The same APNs address
for an app/environment is not duplicated across installations.

APNs addresses and dedicated push credentials are encrypted with AES-256-GCM
using the mode-0600 `.push-token-key` under `config.appHome`. Studio login tokens
are never stored in the registration. The gateway retains its existing hashed
grant contract and validates login session, account entitlement and recipient
scope on each send. It does not need a new APNs device table.

`DELETE /api/studio/push/registration` removes the authenticated connection's
registrations, used when notification permission is denied. Delivery rechecks
connection identity, token rotation/expiry/revocation and user status. Account
logout revokes the gateway login session, invalidating its grants. Offline local
logout alone cannot revoke remote state until a server learns of it. APNs
`apns_recipient_unregistered` and `apns_invalid_recipient` responses remove the
failed registration; a late response cannot delete a newer registration.

## Events and routing

Each App connection in Device Connections has a **Push notifications** switch,
enabled by default for new and existing devices. The connection owner and
super-admin can change it through
`PATCH /api/studio/app-connections/:id/push` with `{push_enabled:boolean}`.
The preference is persisted on the connection and survives login/token renewal;
LAN and cloud connection rows have separate preferences.

Disabling it skips APNs delivery and notification observer events/snapshots for
that connection. Other devices and ordinary chat streams are unaffected. Device
registration is retained so enabling the switch resumes future notifications
without reconnecting. Already delivered or in-flight notifications are not recalled.

Completion/failure and approval/clarification request events trigger sending;
there is no polling of run records or delayed notification queue. Eligible owner
devices receive one request each, even when the task originated on desktop or a
schedule and has no `push_snapshot` or `push_target_id`.

Group final assistant replies notify the group owner. Child chat events from
groups/workflows are excluded; workflow terminal events notify the workflow
owner. Replay, restored/background snapshots, interrupted runs, resolved
interactions and progress events do not send. Single-chat intermediate completions
with queued work follow the same suppression policy as Android.

Studio POSTs to `/push/v1/send` using the current Device Connections cloud route:
official uses `config.appRelay.url` (default `https://api.ekkostudio.xyz`), and
Cloudflare uses `https://cn.ekkostudio.xyz`. Each notification event reads the
current setting, so route changes apply without restarting Studio. Requests use
the current device's dedicated credential. The payload carries a single-line conversation/group title (up to 40 visible
characters) and a plain-text preview of this final reply (up to 160). Markdown
is converted before truncation; Unicode grapheme segmentation preserves complete
emoji and combining sequences. Empty replies never fall back to an older turn.
Failure/interaction events omit raw errors and commands and use the gateway
default body. The gateway accepts custom plain text, enforces the same character
limits, and measures the complete serialized APNs payload against 4096 UTF-8 bytes.
It trims body then title further if needed, rejecting an oversized route with 413
instead of changing identifiers. It carries a separate
`ekko_run` click route with Studio ID, cloud account ID, run kind/ID, Profile and
session/room/workflow ID. Tokens and raw errors/commands never appear in this
route or public events. The gateway sets `aps.badge: 1` as a new-reminder
indicator (not an unread total); the App clears it on foreground entry. App clicks reconnect the exact saved Studio and verify
the account before opening the subject.

A bounded in-memory set suppresses duplicates per device/event (interactions by
request ID). Requests have a 10-second timeout, reject redirects and do not retry.
Failure on one phone does not prevent delivery to other phones or affect the task.
There is no durable delivery outbox or replay after process restart. APNs acceptance
does not establish when iOS displayed the notification.

## Upgrade and validation

Update both Studio and App. Older Apps only attach per-run snapshots and do not
register devices, so they must be upgraded and connected once before receiving
notifications through the new consumer. Legacy `run_push_targets`/`run_push_links`
and their admission parsing remain for older clients and run provenance, but are
not used to select notification recipients. Existing run snapshots are not migrated
into the device table. Current App submissions no longer include push credentials.

Unit tests cover multiple owner phones, foreign users, device reassignment, token
rotation, revoked/expired connections, permissions, group/workflow ownership,
invalid-token cleanup and per-device failure isolation. Signed iPhone testing is
still required for foreground/background delivery, permission changes, logout,
multiple phones and notification clicks.
