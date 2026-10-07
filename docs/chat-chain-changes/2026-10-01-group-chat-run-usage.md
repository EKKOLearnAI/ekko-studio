# Group chat run usage cards

Group Agent replies now reuse the single-chat `RunUsageCard` for input/output
tokens, cache reads and hit rate, cost, and token speed. Each Agent/run has one
card inside its reply bubble, after the response text and before the associated
workspace diff card, matching single chat. Cards are hidden while that run is streaming.
Unavailable metrics remain unknown rather than being reported as zero.

Coding Agent and Ekko terminal `run_usage` snapshots are rebased to the group
response identity. Internal cancellation without a usage payload recovers the
exact runtime run from its ledger before disposing the temporary session.
Hermes model usage events use the same call ledger recorder
as single chat; a completed/interrupted run is aggregated before its temporary
bridge session is destroyed. Model time supplies measured speed when available;
otherwise the existing whole-run average remains explicitly approximate.

Usage snapshots travel as persisted `run_usage` metadata messages through the
existing group socket and remote relay. Updates reuse a deterministic message
identity. The browser maps these rows to display metadata, so hiding Tool traces
does not hide usage cards and reloads restore the stored snapshot. Cards do not
consume the Agent context window, room Token estimate, or summary scan budget.
Usage metadata does not publish a new chat-message webhook or notification.
Existing replies without recorded run usage do not receive fabricated counts.

Task plan cards also reuse the assistant message background in both single and
group chat, avoiding a bright white surface in light mode.

Validation covers transport identity and invalid metrics, group persistence and
context exclusion, terminal and interrupted native runs, Hermes usage event
recording, live browser updates, history reloads, and light/dark mobile layouts.
