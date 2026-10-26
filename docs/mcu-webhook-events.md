# MCU Webhook event subscriptions

Studio exposes all events in `CHAT_WEBHOOK_EVENT_TYPES` through the existing
Socket.IO `/global-agent` namespace. This is an independent, opt-in module:
ESP32-C3 v1/v2 firmware is unchanged and receives no new events unless it subscribes.
No HTTP Webhook endpoint needs to be configured. Existing voice/tool/audio events
continue to use their current names and behavior.

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
