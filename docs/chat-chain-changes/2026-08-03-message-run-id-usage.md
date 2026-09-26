---
date: 2026-08-03
pr: 2240
feature: Per-message run_id persistence and usage read-back
impact: Messages now store their originating run_id so provider usage can be attached on history read-back, surviving refresh and reload.
---

The `messages` table gains a `run_id` column (`TEXT NOT NULL DEFAULT ''`).
All assistant tool-call flush sites (bridge, ekko `handle-ekko-agent-run.ts`,
coding-agent, response-stream) now pass the active run id into `addMessage`
so it is persisted with the row.

`getConversationMessagesPaginated` calls `attachRunUsageToMessages` before
returning history. That helper joins `session_usage` by `run_id` (trying
`hermes`, `ekko_agent`, `coding_agent` sources in order) and returns usage
on the matching assistant row.

The client `HermesMessage` interface surfaces `run_id` and `usage`.
`mapHermesMessages` passes them through to the `Message` object so
`MessageItem` renders usage on reloaded conversations without a live run.
