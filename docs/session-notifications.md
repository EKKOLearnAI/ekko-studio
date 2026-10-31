# Session notifications (Hermes cron results, terminal completions and external notices)

Studio delivers Hermes background results, and notices posted by authenticated external
services, to an exact Studio session, whichever session is currently selected.

| Producer | Delivery | Model context |
| --- | --- | --- |
| Scheduled cron fire of a job created in a Studio Hermes chat | Passive notice in the creating session's timeline, durable across reload and restart, sidebar attention raised once | Not automatic. The next intentional user question in that session receives a bounded, once-only context block |
| `terminal(background=true, notify_on_complete=true)` completion | Typed machine event that starts one turn in the owning session after any running turn | Yes: the native Hermes completion text, with the session's current history |
| `POST /api/studio/sessions/{id}/notifications` from an external service | Passive notice, like a cron result | Like a cron result: once, on the next intentional question |

## Cron results

Hermes captures a cron `origin` only from a chat id. The Agent Bridge has none, so Hermes
stores `deliver=local` and never routes the result back. Studio fixes this without
changing Hermes:

1. **Binding at creation.** The bridge wraps the registered `cronjob_manage` handler
   (the legacy `cronjob` name resolves to it). Only creates made inside a Studio Agent
   Bridge session are affected, and only when the request asks for this conversation:
   `deliver` omitted, or containing `origin`. For those requests the bridge:
   1. creates the job paused through the native tool;
   2. writes a durable binding (Studio instance, profile, session, session generation,
      job) to `<Web UI home>/session-notifications/cron-bindings.db`;
   3. resumes the job through the native tool action, unless the request asked for
      a paused job.

   An `origin` *delivery* target is stored natively as `local`, never a home-channel
   fallback. `failure_deliver` is the user's explicit choice and is passed to the native
   tool byte-for-byte. If writing the binding fails, or Studio did not declare the owner's
   session generation for this turn, the job stays paused and the tool reports the
   failure. Explicit targets (`local`, `slack:…`, `all`, …) are passed through untouched,
   are not bound, and are never mirrored.

   **Session generation.** `getSessionGeneration` returns the session's `generation_id`:
   assigned on first read, cleared by `clearSessionMessages` (reset), and new for a session
   recreated under the same id. Studio sends it with each bridge turn
   (`studio_session_generation`), and the binding records it.

   **Availability.** Hermes offers `cronjob_manage` only to interactive surfaces (its check
   reads `HERMES_EXEC_ASK` and similar flags), and it caches both that verdict and the
   resolved tool definitions process-wide. A resolution made outside a Studio run, such as
   the post-turn background review, would therefore hide the tool from later sessions. The
   bridge middleware marks the tool available in a Studio bridge worker and drops
   previously cached availability (`invalidate_check_fn_cache`, `_clear_tool_defs_cache`).
   It does this in memory only and changes no environment variable.
2. **Observation.** Every 15 seconds `ChatRunSocket` asks the profile's bridge worker
   (`studio_cron_observe`) for the terminal executions of bound jobs. The worker reads
   the native execution ledger (`list_executions`) a bounded page of 50 at a time: the
   newest page plus one older page per pass, continuing from the job's stored
   `observe_before` cursor (`before_claimed_at`). A backlog larger than one page is
   recovered over later passes while new fires keep arriving, and each execution is
   still accepted once. For agent-backed fires it also reads the canonical
   admission result of `cron_request_id(job, execution_id)`, which holds the exact
   final response. Output files are never correlated by name or time. Only scheduled
   fires are observed. A chat `cronjob_manage run` returns through its own
   async-delegation result. Studio registers that delegation from the tool result
   (`job.execution_mode == 'background'`, `job.delegation_id`), so the background poll stays
   active until the result is delivered once.
3. **Inbox.** Each execution is accepted once under
   `(instance, profile, cron:<job>:<execution>)` in `session_notifications`, with its
   disposition, payload, accepting session generation and its durable attention event
   (`session_attention_events`, key `cron-notice:<id>`) written in one transaction.
   The existing read cursor (`sessions.read`) clears it; a replay never re-arms it.
   - Replays (restart, a second poll) are rejected.
   - Ownership requires the same profile and an exact match between the binding's
     generation and the session's current generation. A deleted, reset or recreated session,
     or a binding without a generation, fails closed as `owner_missing` and is never
     rerouted.
   - An out-of-band edit of the native `deliver` value to another target stops
     observation (`target_changed`).

| Disposition | Meaning | Shown |
| --- | --- | --- |
| `notified` | Exact final response from the native receipt, or a known failure (`success=false`, with its error) even when the answer is empty or silent | yes |
| `status_only` | No exact receipt: `no_agent`/script jobs (`output_unavailable_for_runtime`), or an agent-backed fire without a readable receipt | yes, status only |
| `unknown` | Native execution outcome unknown; Studio never re-runs it | yes |
| `silent` | Successful fire with the Hermes silence sentinel (`[SILENT]`, `NO_REPLY`, …) via Hermes' own matcher | no |
| `no_content` | Successful exact receipt with an empty answer | no |
| `owner_missing`, `target_changed` | Fail-closed outcomes | no |

Notices are not rows in `messages`, so they never become model history. Resume and the
paginated messages API merge them into the timeline as `role: 'system'` items carrying
`studio_notice`. They are scoped to the session generation that accepted them: a real
history clear or a delete and recreate under the same id hides them from the API, the
next-question context and attention (the attention rows are removed), while ordinary
turns and partial message deletion keep them. On each page a notice belongs to the
interval between the next older stored row and the page's newest stored row (equal
timestamps go to the older page), and `offset` keeps counting stored rows only, so the
client advances by stored rows and no notice is skipped or repeated across pages. Both
clients that page this API (the chat view and History) count stored rows only and keep a
notice's `studio_notice` metadata, so History shows its attribution, the known error of a
failed run without result text, and the status-only explanation.

Live `session.notice` events go to members of the session room and to signed-in account
sockets, and every one of them is authorized again when the notice is published, with the
read rules of `resume` applied to the session as it exists now: the user must be able to
access its current profile (person-private sessions: their owner only; a share viewer: its
shared session only). A socket that joined the room before the session was deleted or
recreated under another profile receives neither the content nor the metadata. Deleting a
session (HTTP single or batch delete, and every deleting `disposeSession`) also removes all
sockets from its `session:<id>` room synchronously, before the first await, and the HTTP routes
do so again immediately before removing the Studio row (a viewer may rejoin while the native
Hermes delete is pending, because the old row still authorizes it), so a session
recreated under the same id never streams its runs (including terminal-completion turns) to
viewers of the old one; joining again goes through the `resume` read checks. `/destroy` and a
same-owner history clear keep their viewers. Studio
login cannot be disabled (`isAuthEnabled()` is always true), so every ordinary chat
socket carries a user; a socket without one is never a recipient.

**Next-question context.** The block for the next intentional question holds at most
three notices and 8000 characters in total, including framing and metadata. Job names
and results are quoted as escaped JSON strings and labelled untrusted task data.
Notices that do not fit are not marked projected and reach a later question.

**`attach_to_session` is not supported.** Studio translates the delivery target to
`deliver=local`, so a pass-through `attach_to_session` has no effect, and the
next-question block is not native attachment.

**Limitation.** Full script-only (`no_agent`) output is not delivered. Hermes keeps no
execution-keyed receipt for it, so Studio shows the execution id and status only.
**UNIMPLEMENTED** in this version.

## Terminal completions

The bridge previously re-queued every non-delegation event, so `notify_on_complete`
completions never reached Studio. Now `poll_background` does the following:

- It drains owned `type=completion` events with Hermes' own
  `process_registry.drain_notifications(skip_poll_observed=False)`. Watch and heartbeat
  events are unchanged.
- It returns each one as `process_notifications[]` with the producer key
  `hermes-process:<profile>:<process id>:<started_at>`.
- It recovers the native immediate-exit race from the live process record. The terminal
  tool flags the record after spawning, so a process that exits first gets no event.
  Such a record is republished once through the registry's publisher, and duplicates
  of the same key are dropped.
- It reports sessions with live `notify_on_complete` processes or pending watchers
  (`notify_pending`), which keeps Studio polling. A watcher whose process has exited and
  been settled no longer counts, so idle polling stops. An immediate exit still waiting
  for its one-second recovery grace counts until it is republished, emitted or consumed,
  so Studio keeps polling long enough to recover it.
- Each event carries the owner session generation that was current when the process
  started (`owner_generation`). The bridge keeps a short history of generation changes;
  repeated declarations of an unchanged generation are coalesced, so any number of
  ordinary turns keeps a live process's owner.

Studio accepts the event once (`admitting`) and queues a typed `machineEvent` run behind
any busy turn. Before queueing, after the awaited admission, and again at the final run
seam (before the user turn is stored and immediately before the model call) it checks:

- the owner session still exists with the same profile (`owner_missing`);
- its generation still equals the producer's (`owner_reset`; a missing generation fails
  closed);
- the user has not pressed Stop, and the run still owns the session: admission gives it a
  run marker and a machine ownership token. Stop and `/destroy` revoke the token
  synchronously, before their first await, and a new turn replaces the marker, so the run
  ends (`owner_stopped`) even though the generation is unchanged and even if a later turn
  resets the working or stop flags. A run that lost ownership never claims or changes the
  session state of the run that replaced it. Ordinary runs keep their own Stop handling.
  `/destroy` captures the owner it destroys (the state object and its owner revision) before
  its interrupt, bridge-destroy and usage awaits. Every accepted run owner (a claimed turn, a
  dequeued item, a machine or background claim, a reattached run, the turn an expanded
  command such as `/plan` or `/moa` starts) and every Stop advances
  that revision synchronously; queueing behind a busy owner does not. If a new owner
  appears meanwhile, even one still preparing without a run marker,
  `/destroy` still reports its result once but leaves that turn's bridge agent, state and
  queue alone;
- Hermes has not seen the result consumed by `wait` or `log` since the drain
  (`process_notification_admit`). A plain `poll` is not consumption.

Only then does the run start (`admitted`, then `dispatched` at the model call). If the
Agent Bridge reports itself not ready after admission, the event is settled as
`bridge_unavailable` (it is not retried) and the session is released only if the machine run
still owns it, so the next turn runs normally. Stop,
history clear and explicit queue cancel settle any queued machine event: the bridge
claim is completed (never re-queued) and the disposition becomes `cancelled`. It is stored as the model's user turn and displayed as a
system notice. A crash between admission and dispatch leaves `unknown` and never
re-dispatches. Notifications that Hermes has not handed off are lost if the bridge
worker dies (Hermes keeps them in memory only).

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

**Publisher grants (unattended producers).** A login token is account-wide and cannot be
revoked on its own, so a recurring producer should use a publisher grant instead. The session
owner issues one with a login token (a legacy session without an owner: a super admin only;
profile access alone is not enough, `403 session_owner_required`):

Keep tokens off command lines and out of terminal output: process arguments and shell
history are readable. In these examples curl reads the `Authorization: Bearer …` line from a
private file (curl 7.55+ `-H @file`). The issue response, which carries the grant secret once,
goes to a new file in a fresh private directory instead of the terminal (an existing file would
keep its permissions, and curl follows symlinks):

```bash
grant_dir="$(mktemp -d)"   # new directory, mode 0700
curl -sS -X POST "http://127.0.0.1:8648/api/studio/sessions/<session-id>/notification-publishers" \
  -H @"<private file with the login Authorization header>" \
  -H "X-Hermes-Profile: default" -H "Content-Type: application/json" \
  -d '{"profile":"default","expected_session_generation":"<generation>",
       "sources":["repo-puller","pr-review-cron"],"expires_in_days":90,"label":"background producers"}' \
  -o "$grant_dir/publisher-grant.json"
```

The response carries the secret (`esnp_…`) once; Studio stores only its SHA-256. A grant is
bound to one Studio instance, profile, session and **session generation**, lists the `source`
values it may post (at most 8), and expires after `expires_in_days` (default 90, at most 180).
A history reset or a delete and same-id recreation invalidates it. The auth middleware accepts a
grant only as `Authorization: Bearer` on `POST /api/studio/sessions/{id}/notifications`; every
other route, method, query-string token and WebSocket refuses it (`403
publisher_token_route_not_allowed`), and it can neither issue, list nor revoke grants. A notice
outside the grant's session, profile or generation returns `403 publisher_scope_mismatch`, a
source not in the grant returns `403 publisher_source_not_allowed`, and a revoked, expired or
unknown grant, or one whose owner is disabled or lost the profile, returns `401
publisher_token_invalid`. Accepted notices use the same identity, idempotency and passive
delivery as login-token notices, attributed to the owner. The owner lists grants (without
secrets) with `GET …/notification-publishers` and revokes one with `DELETE
…/notification-publishers/{publisherId}`.

**Freezing the target.** `GET /api/studio/sessions/{id}?profile=<profile>` returns
`session.session_generation`. Store it when the destination is chosen. A history reset or a
delete and same-id recreation changes it, and a stale value returns
`409 session_generation_mismatch` without writing anything. Choose the destination again
deliberately; never refetch the generation automatically after a failure.

```bash
curl -X POST "http://127.0.0.1:8648/api/studio/sessions/<session-id>/notifications" \
  -H @"<private file with the Authorization header>" \
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
attention, live publication or context, and does not re-arm a notice that was already read
or projected. Changed `title`, `content` or `url` never overwrites the accepted notice.

**Display, delivery and context.** The notice shows its title, the unverified source label,
the content as plain text (never Markdown, HTML, images or file previews) and the link, which
opens only when clicked. Only a new acceptance is published live, after commit and only while
its generation is current; each recipient is re-checked against the current account (active,
role, profile access) and share state rather than state cached on its socket. The once-only
projection uses the same three-notice, 8,000-character block as cron results, quoting external
fields as untrusted JSON-string data. Studio and native Hermes history keep the user's own
question, not the projected text, for every notice-projected turn.

## Verification

```bash
npx vitest run tests/server/session-notifications-cron.test.ts tests/server/session-notifications-external.test.ts
HERMES_REAL_BRIDGE_E2E=1 HERMES_AGENT_ROOT=<read-only hermes checkout> \
  npx vitest run tests/server/hermes-session-notifications-real.test.ts
npm run build && HERMES_AGENT_ROOT=<read-only hermes checkout> \
  node tests/server/fixtures/session-notifications-e2e.mjs
```

The real harnesses use disposable `HOME`, `HERMES_HOME`, Web UI home and `TMPDIR`, a
scripted local model, `PYTHONDONTWRITEBYTECODE=1` and `HERMES_DISABLE_LAZY_INSTALLS=1`,
so the Hermes checkout is only read. The end-to-end script also runs a foreground
`hermes gateway run` in the temp home, which provides the cron ticker.
