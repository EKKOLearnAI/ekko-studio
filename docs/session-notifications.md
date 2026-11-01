# Passive session notices

Studio can append a passive notice to one existing Hermes chat. A notice is display data: it is
never a `messages` row, never enters model history and never starts or queues a turn. Producers
(the first is the opt-in script invocation report) arrive in follow-up changes.

**Session generation.** `getSessionGeneration(id)` returns the session's `generation_id`:
assigned on first read, rotated by a history clear (`clearSessionMessages`) and new for a session
deleted and recreated under the same id. `GET /api/studio/sessions/{id}?profile=` returns it as
`session.session_generation`. A producer freezes it when it chooses the destination.

**Inbox.** `acceptFencedSessionNotification` writes `session_notifications` under
`(namespace, profile, producer_key)` in one transaction with its unread attention event
(`session_attention_events`, key `session-notice:<id>`):

- the session must exist with the same profile and the frozen generation, checked before an
  existing key is recognized, so an old receipt never reports delivery to a reset or recreated
  session and nothing is rerouted (`generation_mismatch`);
- an identical replay is a `duplicate` with no new attention; different content or disposition
  under the same key is a `conflict` and never overwrites;
- `silent` is recorded without attention and never shown; `notified`, `status_only` and
  `unknown` are shown.

A history clear or deletion removes the attention of the old generation's notices, and readers
only show notices of the current generation.

**Timeline.** The paginated messages API, History and `resume` merge shown notices as
`role: 'system'` items carrying `studio_notice`. A notice belongs to the page interval between the
next older stored row and the page's newest stored row (equal timestamps go to the older page);
`offset` keeps counting stored rows only, and the clients count stored rows only. Notice text is
rendered as plain text, never Markdown.

**Live delivery.** After commit, `session.notice` goes to members of the session room and to
signed-in account sockets, each authorized again at publication: the account as stored now must be
active with access to the profile (a share viewer only for its shared session), and only while
the accepting generation is current. Unread attention is synced through the session-state sync.
