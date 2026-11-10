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
- an identical replay is a `duplicate` with no new attention; a key is bound to its session,
  generation and kind, so different content, disposition or destination under the same key is a
  `conflict` and never overwrites;
- `silent` is recorded without attention and never shown or published; `notified`,
  `status_only` and `unknown` are shown;
- private Person conversations (`person-main-*`, `person-task-*`) are not destinations
  (`unsupported`) and never show notices.

A history clear or deletion removes the attention of the old generation's notices, and readers
only show notices of the current generation.

**Timeline.** The paginated messages API, History and `resume` merge shown notices as
`role: 'system'` items carrying `studio_notice`. A page boundary is the latest stored timestamp at
or after that page offset, so boundaries never increase with the offset; a notice belongs to the
page between its two boundaries (equal timestamps go to the older page) and is on exactly one
page even if stored timestamps are not monotonic. Stored rows keep their order; `offset` keeps
counting stored rows only, and the clients count stored rows only. Notice text is
rendered as plain text, never Markdown.

**Live delivery.** After commit, `session.notice` goes to members of the session room and to
signed-in account sockets, each authorized again at publication: the account as stored now must be
active with access to the profile (a share viewer only for its shared session), and only while
the accepting generation is current. Unread attention is synced through the session-state sync.

## Next-question projection

A passive notice never invokes the model on arrival. On the user's next intentional question in
that session, Studio prepends one bounded block with the pending notices (at most 3 notices and
8,000 characters in total; each notice's encoded result body is capped at 4,000 characters, its
header is additional) to the model input, then marks them projected so they are never projected
again. Notices that do not fit stay pending for a later question.

- Every name and result is quoted as an untrusted JSON string, so framing, markup and the block's
  closing marker cannot be injected; the block tells the model to treat it as information only.
- Studio and the native Hermes history store only the user's own question, never the projected
  text.
- Autonomous turns, background delegations, group chats, workflows and global agents never build
  or consume a projection.
- Only shown notices of the session's current generation are projected: silent notices, a cleared
  or recreated conversation and private Person conversations are never projected.

**Dispatch admission.** The projected notices are reserved for the dispatch (Studio instance and
user message id) before it is sent, and the Agent Bridge records that dispatch id durably, at most
once, before it starts the run (`<HERMES_HOME>/ekko-bridge/dispatch-receipts.db`). An accepted reply
consumes the notices, also when this Studio owner was replaced meanwhile; a definite bridge refusal
releases them for a later question. If the reply is lost, the notices stay reserved and the next
intentional question first resolves the dispatch with the bridge: an admitted dispatch is consumed,
and one that was never admitted is claimed as refused, so a delayed request can no longer start,
and its notices are released. While the bridge cannot answer, they stay reserved and are neither
repeated nor consumed.
