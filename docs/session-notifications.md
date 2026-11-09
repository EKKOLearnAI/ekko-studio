# Session notifications: Hermes terminal completions

A `terminal(background=true, notify_on_complete=true)` completion is delivered to the exact
Studio session that started the process, whichever session is currently selected. It starts
one machine turn in that session after any running turn. The model receives the native Hermes
completion text with the session's current history; the timeline shows it as a system notice,
never as the user's words.

## Agent Bridge

The bridge `background_poll` action (`AgentPool.poll_background` in `bridge_pool.py`) uses the
terminal adapter in `bridge_studio_notifications.py`. It:

- drains owned `type=completion` events with Hermes' own
  `process_registry.drain_notifications(skip_poll_observed=False)`. Watch and heartbeat
  events stay queued. A Hermes without this drain API delivers no completions.
- returns each one as `process_notifications[]` with the producer key
  `hermes-process:<profile>:<process id>:<started_at>` and a fresh claim id, and returns it
  again on every poll until Studio admits, completes or releases the claim, so a lost poll
  response is recovered.
- recovers the native immediate-exit race from the live process record. The terminal tool
  flags the record after spawning, so a process that exits first gets no event. Such a
  record is republished once through the registry's publisher after a one-second grace;
  duplicates of the same key are dropped.
- reports sessions with live `notify_on_complete` processes, pending watchers or an
  immediate exit awaiting recovery (`notify_pending`), which keeps Studio polling. Studio
  also starts polling as soon as a terminal tool result accepts `notify_on_complete`.
- tags each event with the owner session generation that was current when the process
  started (`owner_generation`), as declared by Studio with every bridge turn
  (`studio_session_generation` on `chat`).

`process_notification_admit|complete|release` settle the in-memory claim. `admit` re-checks
that `wait` or `log` has not consumed the result since the drain (a plain `poll` is not
consumption). `release` (Studio shutting down) puts the event back into the Hermes queue.

## Studio

Studio accepts each event once into `session_notifications` under
`(Studio instance, profile, producer key)` with the producer's session generation. A
redelivered key never becomes a second turn: while its record is in flight it is ignored,
once settled its claim is completed. The event is queued as a typed `machineEvent` run behind any busy
turn. Before queueing, after the awaited bridge admission, and again at the final run seams
(before the machine turn is stored and immediately before the model call) Studio checks:

- the owner session still exists with the same profile (`owner_missing`);
- its generation still equals the producer's (`owner_reset`; a missing generation fails
  closed). A history clear rotates the generation, so a completion of the old conversation
  never enters the reset one;
- the user has not pressed Stop and the run still owns the session (`owner_stopped`).
  Stop and `/destroy` revoke the run's ownership token before their first await and a new
  turn replaces its run marker, so the run ends even with an unchanged generation. A run that
  lost ownership never changes the state of the run that replaced it.

Bridge admission is the consumption decision: it refuses a result that `wait` or `log`
already read (`consumed`). Studio then completes the claim, so a later read does not suppress
the admitted turn.

| Disposition | Meaning |
| --- | --- |
| `admitting` | Accepted, bridge admission pending |
| `admitted` | Admitted, run preparing |
| `dispatched` | Sent to the model as one turn |
| `consumed` | Read by `wait`/`log` first; no turn |
| `cancelled` | Removed from the queue by Stop, history clear, `/destroy` or queue cancel; the claim is completed, never re-queued |
| `owner_missing`, `owner_reset`, `owner_stopped` | Fail-closed owner fences |
| `bridge_unavailable` | The Agent Bridge reported itself not ready after admission; not retried, and the session is released only while the machine run still owns it |
| `unknown` | Admission check failed, or Studio stopped between admission and dispatch (settled at startup); never re-dispatched |

Completions Hermes has not handed off are lost if the bridge worker dies: Hermes keeps them in
memory only.

## Verification

```bash
npx vitest run tests/server/chat-run-machine-event-lifecycle.test.ts \
  tests/server/handle-bridge-run-machine-fence.test.ts tests/server/session-notification-store.test.ts
```
