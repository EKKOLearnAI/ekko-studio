---
date: 2026-08-20
feature: steer-a-queued-message-into-the-running-turn
pr: 2646
impact: A queued message can be handed to the run that is already going, without stopping it. Queueing and inserting are unchanged, and the entry leaves the queue only after the bridge accepts the text.
---

# Steering a queued message

A message typed while a run is going has had two ways in: wait for the turn to end, or use the insert action, which stops the current response at a safe boundary first ("Waiting for the current tools to finish", "Stopping the current response safely"). Neither lets you add to a turn that is already producing what you wanted to adjust.

Hermes has supported steering for a while, and Studio already exposes `/steer <text>` as a bridge session command — but only as typed text, with nothing in the queue offering it.

A third action on the queued row now sends that message through the same bridge `steer` call. `MessageQueueFloatPanel` gains a `canSteer` prop and a `steer` event beside the existing `insert` and `remove`; `MessageList` shows it only for a Hermes bridge session that is live, since coding agents run their own CLI and have no such channel.

Ordering matters on the server: `steer_queued_run` awaits `bridge.steer()` and only then removes the entry and re-broadcasts `run.queued`. If the bridge refuses — an older agent raises `agent does not support steer` — the message stays queued and the failure is reported over `session.command`, so nothing is lost to a delivery that never happened.

No change to how runs are queued, dequeued, inserted or cancelled.
