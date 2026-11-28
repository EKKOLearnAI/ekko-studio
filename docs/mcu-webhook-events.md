# MCU Webhook event subscriptions

Studio exposes all events in `CHAT_WEBHOOK_EVENT_TYPES` through the existing
Socket.IO `/global-agent` namespace. This is an independent, opt-in module:
ESP32-C3 v1/v2 firmware is unchanged and receives no new events unless it subscribes.
No HTTP Webhook endpoint needs to be configured. Existing voice/tool/audio events
continue to use their current names and behavior.

## Voice requests awaiting desktop input

An MCU voice turn uses a normal chat session in its selected Profile. Tool
approvals and clarification requests remain pending in that same Studio session;
the MCU transport never chooses an approval option or supplies a clarification
answer. Open the session in Studio to approve, deny or answer. This uses normal
chat notifications and does not require a Webhook subscription.

Both local and relayed voice connections send a `working` status every 30 seconds
while waiting for desktop input, so the device's 180-second idle deadline does
not end an otherwise live request. The existing five-minute foreground turn
deadline remains in force; a background human-input wait is also capped at five
minutes. A longer native clarification timeout does not extend these bounds.
At timeout, the transport aborts an active request that it owns or removes only
its own queued item by queue ID, leaving another active request untouched.
Requests must belong to the current session and native run. A failed desktop
RPC acknowledgement leaves the human-input wait pending; only a matching
successful resolution or run termination clears it. Denial never creates an
automatic approval response or a retry.

After a native run starts, duplicate start events and late queue snapshots do
not discard pending desktop input. Text, tool and terminal events from an older
native run are ignored. A rejected item from another queue cannot terminate
the MCU's active request, including a rejection before that item has a run ID.

## Subscribe and unsubscribe

On an authenticated MCU/agent connection, send `mcu.events.subscribe` with:

```json
{
  "type": "mcu.events.subscribe",
  "schema_version": 1,
  "apiToken": "<MCU login JWT>",
  "profile": "default",
  "include_content": false,
  "include_user_content": false
}
```

Omitting `types` selects the complete Webhook catalog. A `types` array narrows
the selection; `[]` selects none. Optional `session_ids`, `room_ids`, and
`workflow_ids` arrays further narrow events; all supplied filters are intersected.
Profile is an exact event-profile filter, including a group's summary Profile.
Omitted/blank profile resolves to `default`. Unknown event types, unsupported
schema versions and malformed filters are rejected.

The named response `mcu.events.subscribed` has `type`, `schema_version:1`, `ok`,
and on success `profile`, selected `types`, `include_content` and
`include_user_content`. Failure returns `ok:false,error:"event_subscription_denied"`.
An optional Socket.IO callback receives the same response; raw-frame clients and
remote relays can use the named response without a callback.

Send `mcu.events.unsubscribe` with the same `apiToken` to stop delivery. Its
response is `mcu.events.unsubscribed` with `schema_version:1` and `ok`. Replacing a
subscription cancels pending deliveries for the previous selection. Invalid
replacement subscriptions leave the channel unsubscribed. Disconnect removes the
subscription and hub listener; LAN clients must resubscribe after reconnect.

## Delivery

The single Socket.IO event `mcu.webhook.event` contains:

```json
{
  "type": "mcu.webhook.event",
  "schema_version": 1,
  "event": {
    "schema_version": 1,
    "id": "stable-event-id",
    "type": "chat.tool.failed",
    "occurred_at": "2026-10-25T08:00:00.000Z",
    "profile": "default",
    "source": "coding_agent",
    "agent": "codex",
    "subject": { "session_id": "session-id", "tool_call_id": "tool-call-id" },
    "summary": { "status": "failed", "tool_name": "example" }
  }
}
```

The nested `event` uses the same `buildChatWebhookEnvelope` serializer as HTTP
Webhooks. It preserves event IDs, timestamps, subjects, summaries, state, task
cards and session tasks. `include_content` enables assistant message text and
task/card text; `include_user_content` enables user message text. Both default to
false. Content follows the existing Webhook truncation and field projections.
Raw business-event payloads, tool outputs and internal push credentials are not
forwarded. The wrapper keeps `chat.tool.failed` distinct from the voice protocol's
`tool.completed` representation of a tool failure.

The current catalog has 28 types:

- `chat.message.created`
- `chat.run.queued`, `chat.run.started`, `chat.run.completed`, `chat.run.failed`
- `chat.tool.started`, `chat.tool.completed`, `chat.tool.failed`
- `chat.approval.requested`, `chat.approval.resolved`
- `chat.clarification.requested`, `chat.clarification.resolved`
- `chat.task.created`, `chat.task.completed`
- `group.message.created`, `group.run.failed`
- `group.approval.requested`, `group.approval.resolved`
- `group.clarification.requested`, `group.clarification.resolved`
- `workflow.run.completed`, `workflow.run.failed`
- `chat.run.updated`, `group.run.updated`, `workflow.run.updated`
- `chat.plan.updated`, `group.plan.updated`, `workflow.plan.updated`

The runtime uses the shared catalog directly, so additions do not require a
second MCU event allowlist. Non-Webhook events (such as `chat.session.removed`)
do not enter this channel.

## Authorization and transport

The subscription's API token authenticates the recipient independently of the
transport connection, which may be a Studio relay account. JWT/account validity,
current Profile assignment and event ownership are rechecked for every delivery.
The existing App business-event access policy restricts chat events to their
session owner and workflow events to their run owner. Group membership and
approval/clarification permissions use the existing group policy. Filters never
grant access. API tokens are not included in outbound envelopes.

The existing MCU Socket.IO relay forwards subscribe/unsubscribe commands,
responses and event envelopes. It preserves the subscriber's JWT instead of
substituting the relay account's token. It restores the last subscription when
the local bridge reconnects; a new MCU login token clears the old subscription
and requires an explicit new subscribe command. Event delivery bypasses the
audio-upload queue.

Delivery is live and best effort, without durable history, replay, retries or
per-event acknowledgement. A socket processes at most 100 pending events and
remembers up to 2,000 event IDs for deduplication. Excess events are dropped, and
volatile Socket.IO delivery avoids buffering event traffic on a congested
transport. Subscribe/unsubscribe responses use normal delivery. Consumers should
use event IDs and task-card revisions for idempotence and resubscribe after a
device reconnect. This module does not add firmware UI, notifications, speech
playback or responses to approval/clarification requests.

## Owned voice routing and session binding

The protected JSON endpoint `/api/studio/mcu/session-bindings` supports GET
(`device_code` query), PUT (`device_code`, `session_id`, `kind`,
`expected_revision`) and DELETE (`device_code`, `expected_revision`). The caller's
current account and Profile own the binding. The online recipient must match an
active App pairing token's physical device code, account and Profile; a claimed
handshake code or HTTP logical-client header is not identity. This requirement
also covers unbound legacy MCU voice uploads. Cloud relay audio uses the verified
remote MCU's App JWT for both its local socket and HTTP upload, never the relay
manager's JWT. Token rotation closes the previous recipient; disconnection,
revocation and mismatched owner/device/Profile fail closed. Local audio fetches
cannot send that credential to another origin.

Responses contain `capabilities:{version:1,manualApprovals:true,
clarificationWait:true}`, `device:{deviceCode,clientId,profile,agentRuntime,online}`,
`binding:null|{sessionId,kind,revision}`, and top-level `revision`. Offline metadata
uses `online:false`, `clientId:''` and `agentRuntime:''`, without exposing another
owner's connection. Deleting a binding retains its incremented revision as a
tombstone. A stale revision or busy device/target returns 409; clients must reload
and decide rather than blindly retry. Private BOT targets require ownership;
normal targets require the current Profile. Deleted or revoked targets cannot be
silently recreated by a later voice turn.

A server-issued lease freezes each voice turn's target and runtime selection
through transcription, queuing, native execution and playback. The controller,
chat socket and output boundary revalidate it. Device disconnect/cancellation
aborts pending transcription and rejects its playback waiters. Cancellation and
settlement are distinct: the lease is released only after the ASR worker exits,
the exact queue item is removed, or the owned native execution actually ends.
The firmware cannot override the target with a session ID. Selected
ordinary sessions preserve their stored Agent, mode and model; BOT input goes
through the normal chat-run BOT policy. Firmware history-clear is rejected for a
bound desktop/BOT conversation; create and bind a new conversation instead.
After foreground playback completes, the next microphone turn is admitted even
if a background task retains its authorized recipient snapshot. That snapshot
still prevents rebinding during active background work. Cancellation suppresses
outbound status events that were awaiting asynchronous ownership checks; normal
terminal statuses remain deliverable after foreground cleanup.
After an owned voice request settles (including transcription or an owned queue
item), the host sends a content-free `interaction.status` with that request's
actual `interactionId` and `status:"completed",outcome:"cancelled"`. An interrupt
acknowledgement alone is not a turn terminal. Original StackChan firmware retires
its outstanding-upload fence only for an exact-ID `completed`; a standalone
`cancelled` or `failed` cannot retire it. A truly failed whole turn also settles
with `completed,outcome:"failed"`; a TTS segment failure does not settle a turn.
The terminal separately revalidates the active
App recipient's account, Profile and physical device; target deletion may suppress
content without preventing the same owner from settling its cancelled fence.
Revoked/replaced recipients receive no terminal. `mcu.interrupt.interactionId`
identifies the target voice turn, not the stop request. Only a nonempty matching
turn ID can cancel its owned lease, queue item or active run. Missing, unknown
and previous-turn IDs have no effect on a newer turn, including after debounce.
No API clears arbitrary firmware fences or reconstructs vanished legacy turns.
Foreground cleanup does not itself mark a terminal as delivered. Delivery is
recorded only after a successful emit, with a separate pending-cancellation guard.
If a binding revision changes while a terminal is awaiting authorization, old
content is discarded and the still-authorized same device can receive only a
content-free cancelled terminal to settle that known turn.
Immediately before the compatibility `completed`, a settled cancellation emits
the existing `aborted` phase, and a settled whole failure emits `failed`. Those
phases preserve the old firmware's stop/error behavior and generation fence;
the following `completed` clears only the backend fence without reviving old
audio or cues. After a local hardware stop already cleared the active ID, both
phases are ignored by its UI while exact-ID `completed` still retires that fence.
This sequence reports interaction settlement, not a successful Studio business
run or a rollback of tools that already ran.
Native cancellation ACKs must match the exact session and queue/run ID and prove
`settled:true`. Queue cancellation is serialized with admission; an admitted run
must be cancelled by its own run ID. Missing ACKs are bounded to 30 seconds,
wrong IDs and disconnected transports are unconfirmed. The host logs only
correlation metadata and reason codes and may deliver `failed` with
`reason:"cancel_unconfirmed"` to the still-authorized device. It does not emit
`completed` or release an uncertain lease merely because a timer elapsed.
An unconfirmed native stop therefore remains fail closed; it is not reported as
idle or recovered. No legacy unknown fence is cleared by guessing a turn ID.
Manual interrupt cancels only the owned queue item or active run. Late native
run events cannot transfer ownership, duplicate starts cannot erase pending human
input, and playback acknowledgements cannot resolve another device's segment.

Raw MCU microphone recordings are not written to disk by default. Explicitly
setting `HERMES_MCU_STT_DEBUG_AUDIO=1` enables the existing local audio/metadata
diagnostics; this does not remove previously saved diagnostic files.

MCU transcription alone can fall back to the usable official local model after
a structured cloud HTTP 401/403/408/429/5xx failure. The 60-second backoff is
isolated by Profile and configuration/credential fingerprint. Cancellation and
revocation do not trigger fallback, and the global selected STT provider remains
unchanged. `GET /api/studio/stt/profile-status` includes `mcuFallback` diagnostics. A local
synthetic TTS-to-STT benchmark establishes the software path only; physical
microphone and speaker behavior still require device acceptance.
