# Session notifications (Hermes cron results and terminal completions)

Studio delivers two kinds of Hermes background results to the exact Studio session
that produced them, whichever session is currently selected.

| Producer | Delivery | Model context |
| --- | --- | --- |
| Scheduled cron fire of a job created in a Studio Hermes chat | Passive notice in the creating session's timeline, durable across reload and restart, sidebar attention raised once | Not automatic. The next intentional user question in that session receives a bounded, once-only context block |
| `terminal(background=true, notify_on_complete=true)` completion | Typed machine event that starts one turn in the owning session after any running turn | Yes: the native Hermes completion text, with the session's current history |

## Cron results

Hermes captures a cron `origin` only from a chat id. The Agent Bridge has none, so Hermes
stores `deliver=local` and never routes the result back. Studio fixes this without
changing Hermes:

1. **Binding at creation.** The bridge wraps the registered `cronjob_manage` handler
   (the legacy `cronjob` name resolves to it). Only creates made inside a Studio Agent
   Bridge session are affected, and only when the request asks for this conversation:
   `deliver` omitted, or containing `origin`. For those requests the bridge:
   1. creates the job paused through the native tool;
   2. writes a durable binding (Studio instance, profile, session, job) to
      `<Web UI home>/session-notifications/cron-bindings.db`;
   3. resumes the job through the native tool action, unless the request asked for
      a paused job.

   `origin` is stored natively as `local`, never a home-channel fallback. If writing
   the binding fails, the job stays paused and the tool reports the failure.
   Explicit targets (`local`, `slack:…`, `all`, …) are passed through untouched, are
   not bound, and are never mirrored.
2. **Observation.** Every 15 seconds `ChatRunSocket` asks the profile's bridge worker
   (`studio_cron_observe`) for the terminal executions of bound jobs. The worker reads
   the native execution ledger. For agent-backed fires it also reads the canonical
   admission result of `cron_request_id(job, execution_id)`, which holds the exact
   final response. Output files are never correlated by name or time. Only scheduled
   fires are observed; a chat `cronjob_manage run` already returns through its own
   async-delegation result.
3. **Inbox.** Each execution is accepted once under
   `(instance, profile, cron:<job>:<execution>)` in `session_notifications`, with its
   disposition, payload and attention written in the same statement.
   - Replays (restart, a second poll) are rejected.
   - A deleted session, or a session recreated after the binding, fails closed as
     `owner_missing` and is never rerouted.
   - An out-of-band edit of the native `deliver` value to another target stops
     observation (`target_changed`).

| Disposition | Meaning | Shown |
| --- | --- | --- |
| `notified` | Exact final response from the native receipt | yes |
| `status_only` | No exact receipt: `no_agent`/script jobs (`output_unavailable_for_runtime`), or an agent-backed fire without a readable receipt | yes, status only |
| `unknown` | Native execution outcome unknown; Studio never re-runs it | yes |
| `silent` | Hermes silence sentinel (`[SILENT]`, `NO_REPLY`, …) via Hermes' own matcher | no |
| `no_content` | Exact receipt with an empty answer | no |
| `owner_missing`, `target_changed` | Fail-closed outcomes | no |

Notices are not rows in `messages`, so they never become model history. Resume and the
paginated messages API merge them into the timeline as `role: 'system'` items carrying
`studio_notice`.

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
  (`notify_pending`), which keeps Studio polling.

Studio accepts the event once (`admitting`) and queues a typed `machineEvent` run behind
any busy turn. At the dispatch boundary it re-checks three things:

- the owner session still exists;
- the user has not pressed Stop;
- Hermes has not seen the result consumed by `wait` or `log` since the drain
  (`process_notification_admit`). A plain `poll` is not consumption.

Only then does the run start. It is stored as the model's user turn and displayed as a
system notice. A crash between admission and dispatch leaves `unknown` and never
re-dispatches. Notifications that Hermes has not handed off are lost if the bridge
worker dies (Hermes keeps them in memory only).

## Verification

```bash
npx vitest run tests/server/session-notifications-cron.test.ts
HERMES_REAL_BRIDGE_E2E=1 HERMES_AGENT_ROOT=<read-only hermes checkout> \
  npx vitest run tests/server/hermes-session-notifications-real.test.ts
npm run build && HERMES_AGENT_ROOT=<read-only hermes checkout> \
  node tests/server/fixtures/session-notifications-e2e.mjs
```

The real harnesses use disposable `HOME`, `HERMES_HOME`, Web UI home and `TMPDIR`, a
scripted local model, `PYTHONDONTWRITEBYTECODE=1` and `HERMES_DISABLE_LAZY_INSTALLS=1`,
so the Hermes checkout is only read. The end-to-end script also runs a foreground
`hermes gateway run` in the temp home, which provides the cron ticker.
