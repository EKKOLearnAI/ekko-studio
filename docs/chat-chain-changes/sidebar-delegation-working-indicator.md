# Sidebar working indicator during background delegation

## Scope

The session-list working glow reflects foreground execution **or** a positive,
server-reported background delegation count. Foreground completion must not stop
that glow while delegated work is pending. The existing `isSessionLive`,
`isStreaming`, and `isRunActive` contracts remain foreground-only: queue insertion,
voice interruption, and composer controls must not change just for a sidebar cue.

Session lists now subscribe once to account-wide state over `/chat-run`, using
`query.session_state=1`. The server sends `sessions.state.snapshot` on connect
and reconnect and `sessions.state.updated` for changes. Both ordinary chats and
owned Person conversations are included, even if no device has opened their
transcripts. An outstanding collaboration handoff lights only its recipient,
without requiring worker execution rows. A creator waiting for other roles is
idle unless its own foreground or background work is running. Delivered handoffs
and failed deliveries awaiting retry do not keep an otherwise idle role lit.
Internal handoff instructions do not create unread notices; legacy handoff
notice rows are ignored. Final returns to the creator retain durable notice
cursors (`lastAttentionId` / `readAttentionId`) because no chat message is copied
there. `sessions.read` includes the observed `attentionId` with its message cursor.

The subscription uses its own Socket.IO Manager (`forceNew: true`). Other
namespaces, including Person presence, connect first in the real app. Reusing
their Manager retains the original Engine.IO query and silently drops
`session_state`, so a successful connection alone does not prove subscription.
The local and cloud App bridges apply the same isolation when opening a
`/chat-run` state observer. Each state also includes its session's `profile`, so
native App unread records and receipts retain the correct Profile association.

Profile permissions filter ordinary chats; Person conversations are
restricted to their owner; worker, group, workflow and Global Agent sessions are
excluded. Global Agent retains its separate runtime and list state.

Each state carries `working`, `backgroundPending`, `lastMessageId`,
`readMessageId`, and `unread`. Foreground lifecycle and delegation events update
all connected devices. Person execution/delivery changes also refresh the owning
account. A completed foreground run keeps the indicator active while background
work or result delivery remains. Historical tool traces cannot start this light.
Once a server state exists, it takes precedence over local streaming flags.
Execution and unread indicators are mutually exclusive: while any foreground,
background or queued handoff work remains, `unread` is false. Stored replies and
completion notices become unread after that work settles. Read receipts during
execution are rejected, so a partial reply cannot be marked read before its final
content is available. The client also guards this transition for older servers.

Visible, loaded conversations send `sessions.read` with
`{ sessionId, messageId, attentionId }` (the notice cursor is optional for older
servers).
The server persists a monotonically increasing, account/session-specific cursor
in `session_read_state` and broadcasts the resulting state to that account's
other devices. Cursors are bounded by the latest stored assistant message; a
stale receipt cannot clear newer replies or completion notices, or move either cursor
backwards. Hidden
pages do not mark conversations read. Fresh snapshots recover read and execution
state after disconnects. Login-disabled installations use a separate local scope;
shared-session guests cannot subscribe to account state.

The existing chat store still owns execution listeners and composer/queue rules.
Its per-background-session observers remain available for transcript delivery;
the account subscription owns the list's synchronized appearance and unread dot.
Authentication invalidation disconnects the subscription and clears its data.

Person's background-task capsule uses the current conversation's pending count
and character. It renders inside the message region, centered horizontally there,
without a global Teleport or a viewport-level position. Switching conversations
cannot show another conversation's tasks.

## Regression coverage

- `tests/server/session-state-sync.test.ts`: real Socket.IO devices, background-only
  activity, shared read receipts, stale cursors, reconnect/restart, ownership,
  profile boundaries and the login-disabled local scope.
- `tests/client/session-state.test.ts`: authoritative snapshots, receipts, visible
  session ownership and account invalidation.
- `tests/client/session-state-transport.test.ts`: real client transport after an
  existing presence connection, collaboration activity, two-device read receipts,
  completion and reconnect snapshots.
- `tests/server/person-presence.test.ts`: conversation-specific background counts.
- `tests/e2e/person.spec.ts`: conversation isolation, unread state, centered capsule,
  narrow layouts, themes and reduced motion; a real Socket.IO client/server case
  verifies relay lights and unread notices after the app's presence connection.

- `tests/client/chat-store-working-state.test.ts`: foreground/background overlap,
  multiple delegations and terminal outcomes, session/profile separation,
  authoritative resume/reconnect versus stale history, runtime reset and late
  callbacks, visibility wake/passive listener attachment.
- `tests/client/chat-store-working-transport.test.ts`: real API/store auth invalidation,
  socket-room loss/reconnect, profile replacement, cancellation payloads, resource
  disposal, delayed old-auth callbacks/uploads/model readiness, and fresh login.
- `tests/e2e/chat-streaming.spec.ts`: foreground → background-only → terminal glow,
  with the real center transcript and right-hand subagent panel rendered together.
- `tests/e2e/sidebar-working.spec.ts`: navigation, reload, enabled composer, partial
  completion, aggregate zero, and terminal reload despite historical task events.
- Browser regression screenshots use fixture data, not live tasks. The relay
  transport case keeps HTTP fixtures but uses real Socket.IO handshakes and events,
  checking execution before unread and the creator becoming idle after handoff.

## Validation

```sh
PATH=/opt/homebrew/bin:$PATH NODE_ENV=test npm run test -- tests/client
PATH=/opt/homebrew/bin:$PATH NODE_ENV=development PLAYWRIGHT_PORT=14387 PLAYWRIGHT_CHANNEL=chrome npm run test:e2e -- tests/e2e/chat-streaming.spec.ts tests/e2e/sidebar-working.spec.ts --workers=2
PATH=/opt/homebrew/bin:$PATH NODE_ENV=production npm run build
PATH=/opt/homebrew/bin:$PATH npm run harness:check
```

The absolute Node path and Chrome channel are local environment choices; CI can use
its supported Node and managed Playwright browser. Bound browser workers on a busy
developer machine to avoid unrelated five-second initial-render timeouts.
