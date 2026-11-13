# Passive session notices

Studio can append a passive notice to one existing Hermes chat. A notice is display data: it is
never a `messages` row, never enters model history and never starts or queues a turn. Cron results
of explicitly bound jobs are a producer (below); others arrive in follow-up changes.

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

## Cron session bindings

Hermes captures a Cron `origin` only from a chat id. The Agent Bridge has none, so a job created
from a Studio chat is stored with `deliver=local`. A binding records, explicitly, which Studio
session should receive that job's results, and the observer below delivers them. Nothing in
Hermes is changed.

`POST /api/hermes/cron/session-bindings` with
`{ profile, session_id, expected_session_generation, job_id }` binds an existing agent-backed
native job whose stored `deliver` is `local` to the session's frozen generation. It writes
`<Web UI home>/session-notifications/cron-bindings.db`; the Agent Bridge never wraps
`cronjob_manage` or writes bindings, so a job a model creates in a chat stays a plain native job
until the user binds it.

- The bearer token must be an interactive login token. `POST /api/auth/login` signs
  `purpose: "login"` into it (`authenticateLoginUserToken`); tokens Studio issues to model runs
  carry `purpose: "model_run"`, so a model run cannot bind on its own. App tokens, share links and
  tokens issued before purposes existed are refused here (`403 login_token_required`); every other
  endpoint keeps accepting them.
- `GET /api/studio/sessions/{id}` returns `session.session_generation`. Freeze it when the
  destination is chosen: a history clear or a delete and same-id recreation changes it, and a stale
  value returns `409 session_generation_mismatch` without writing.
- The account must be active with access to the profile, which must match any `x-hermes-profile`
  header or `profile` query (`400 profile_mismatch`). The target must be an ordinary, locally
  stored Hermes chat, never a private Person conversation (`422 unsupported_notification_target`).
  Script-only jobs (`422 script_job_requires_script_report`), explicit targets such as `slack:…`
  (`422 explicit_delivery_target`) and unknown jobs (`404 job_not_found`) are refused.
- Every (re)binding replaces the job's previous binding, writes a strictly later `bound_at`
  revision and resumes observation of a job the observer had stopped.

## Cron results in the bound session

Every 15 seconds, while a bindings database exists, `ChatRunSocket` asks the profile's bridge
worker (`studio_cron_observe`, `bridge_studio_cron.py`) for terminal executions of bound jobs since
their binding. The worker reads the native execution ledger 50 rows at a time, continuing from the
job's stored `observe_before` cursor, so a backlog is recovered over later passes. For agent-backed
fires it reads the canonical admission result of `cron_request_id(job, execution_id)`; it never
correlates output files by name or time. Manual `run` executions are ignored.

- Each scheduled execution is accepted once into the session notice inbox as kind `cron`, keyed by
  job and native execution id and fenced to the binding's frozen generation. A replay is a
  duplicate with no effects; a reset, deleted or re-profiled owner receives nothing and nothing is
  rerouted.
- An exact answer is shown as plain text (clipped at 100,000 characters and flagged); a known
  failure is shown even without answer text; Hermes silence and empty answers are recorded but
  never shown; script-only jobs and missing receipts are shown status-only; an unknown execution
  is shown as unknown and never re-run.
- A binding replaced while Hermes was answering owns the job: the stale answer is dropped. A job
  that disappeared, or whose stored `deliver` was changed out of band, stops being observed until
  it is deliberately bound again.
- Bindings written by another Studio instance are ignored.

## Consent requests and the chat card

The direct binding and enrollment endpoints accept only an interactive login credential. A model
turn's runtime credential is refused there (`403 login_token_required`, with
`hint: "request_user_consent"` and the `consent_path`); it may instead **request** consent, which only
the same account's login can approve.

```text
runtime credential -> POST /api/hermes/cron/consent-requests  { profile, context_id, kind, ... }
                   <- 202 pending                               (nothing created or run)
chat card (login)  -> POST /api/hermes/cron/consent-requests/:id/approve | deny
                   <- 200: the frozen plan is executed once, or discarded
```

- **Setup context.** Ordinary Hermes chats that can receive scheduled results offer "Allow MCP
  scheduled-result setup" in the session menu. It calls `POST /api/hermes/cron/consent-contexts`
  (login only) for the current session and profile and shows the returned `context_id` to copy.
  Opening a new one replaces the account's earlier unused setup context for that session. The
  destination session, profile, account and generation come from the context, never from the
  request body.
- **Card.** `GET /api/hermes/cron/consent-requests?profile=&session_id=` lists the account's
  pending requests for the open session. Each shows the frozen operation as plain text: destination,
  job, schedule, script and its SHA-256, working directory, interpreter, prompt, whether the job runs
  or stays paused after approval, a binding it would move, the requesting credential and the expiry.
  Approve and Deny send the login credential with the session's profile; one decision wins, and its
  outcome stays with its own session. The card refetches on the content-free `cron_consent.updated`
  socket hint for its own session and discards responses for a session the user has left. It does
  not touch the message composer.
- **Kinds.** `cron_session_binding` (an agent job with `deliver=local`), and
  `script_report_enrollment` with `mode: "new"` or `mode: "existing"` (adoption of an existing
  script-only job). A binding is recorded as described in [Cron session bindings](#cron-session-bindings)
  with the approving account; enrollment and adoption run the script report enrollment service.
