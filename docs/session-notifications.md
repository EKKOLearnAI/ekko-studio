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

## External notices (HTTP)

An authenticated service, such as a validation or review job, can append a passive notice
to one existing Studio Hermes chat. Arrival never starts or queues a turn;
`POST /api/studio/chat-run/runs` remains the API for active input.

**Targets.** Version 1 accepts ordinary, locally stored Hermes bridge chats only (source
`cli`, legacy `api_server` or empty, Hermes agent). Ekko, coding-agent, workflow, group chat,
global agent, person and worker sessions return `422 unsupported_notification_target`.

**Credential.** Send a Studio login token (the `token` returned by `POST /api/auth/login`)
in the `Authorization: Bearer` header. Login tokens carry a signed `purpose: "login"` claim,
and only those are accepted here. Tokens Studio issues to model runs (`purpose: "model_run"`),
App device tokens, query-string tokens, share links, model API keys, the server token and
run-scoped credentials are refused. A token issued before login tokens carried a purpose is
refused by this endpoint only; sign in again once to get one. Other endpoints keep accepting
every existing token. The `exp` claim is authoritative: 30 days by default, configured by
`HERMES_WEB_UI_AUTH_JWT_EXPIRES_IN`. The account must be active and have access to the
profile. There is no renewal: after expiry the operator supplies a new login token, and the
producer retries the same `event_id` with the same frozen generation.

**Freezing the target.** `GET /api/studio/sessions/{id}?profile=<profile>` returns
`session.session_generation`. Store it when the destination is chosen. A history reset or a
delete and same-id recreation changes it, and a stale value returns
`409 session_generation_mismatch` without writing anything. Choose the destination again
deliberately; never refetch the generation automatically after a failure.

```bash
curl -X POST "<studio-url>/api/studio/sessions/<session-id>/notifications" \
  -H "Authorization: Bearer <studio-login-token>" \
  -H "Content-Type: application/json" \
  -d '{"profile":"default","expected_session_generation":"<frozen-generation>",
       "source":"validator-review","event_id":"review-2026-10-30-1729",
       "title":"Validation complete","content":"All required checks passed.",
       "url":"https://example.org/reviews/1729"}'
```

| Field | Rule |
| --- | --- |
| `profile` | Required. Must be the session's profile and match any `x-hermes-profile` header or `profile` query |
| `expected_session_generation` | Required, the frozen generation |
| `source` | Required, at most 64 visible ASCII characters. A label chosen by the caller, not a verified identity |
| `event_id` | Required, at most 128 visible ASCII characters. Stable per producer event |
| `title` | Required, single line, at most 200 characters |
| `content` | Required plain text, at most 32 KiB of UTF-8 |
| `url` | Optional absolute `http(s)` link without credentials, at most 2,048 characters |

Other fields are rejected. The JSON body is limited to 64 KiB before the general request
parser reads it. Accepted values are stored exactly; nothing is truncated.

| Result | Status |
| --- | --- |
| New notice | `201` with `{ ok, notification_id, session_id, profile, session_generation, duplicate: false }` |
| Identical retry | `200` with the original receipt and `duplicate: true` |
| Stale generation / same identity, different content | `409 session_generation_mismatch` / `409 notification_conflict` |
| Unsupported session | `422 unsupported_notification_target` |
| Missing or invalid credential / valid credential that is not a login token | `401` / `403 login_token_required` |
| Unknown session, other profile or another user's private session | `404` |
| Invalid field / body too large / not JSON | `400` / `413` / `415` |

**Idempotency.** A notice is identified by Studio instance, profile, account, session,
generation, `source` and `event_id`. The generation is checked first, so an old receipt never
reports delivery to a reset or recreated session. An identical retry adds no timeline entry,
attention or live publication, and does not re-arm a notice that was already read. Changed `title`, `content` or `url` never overwrites the accepted notice.

**Display and delivery.** The notice shows its title, the unverified source label, the
content as plain text (never Markdown, HTML, images or file previews) and the link, which opens
only when clicked. Only a new acceptance is published live, after commit and only while its
generation is current; each recipient and each unread-attention subscriber is re-checked against
the current account (active, role, profile access) and share state rather than state cached on
its socket. Like every passive notice it never enters model history.
