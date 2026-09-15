---
date: 2026-09-15
pr: pending
feature: Shared MCP task plans
impact: Hermes and coding agents can publish task progress into the existing Studio and App single-chat task cards.
---

## Tool and transport

The managed `use` MCP catalog includes `ekko_studio_update_plan`. Discover its
schema through `ekko_studio_use_toolset` with `action=describe`, then invoke it
with `action=call`. The tool posts to `/api/studio/task-plans/update` using the
existing profile authentication. No extra MCP server or database table is needed.

Each non-Ekko turn receives a fresh `context_id` in its instructions. A call
provides that context, an optional explanation, and the full ordered plan:

```json
{
  "context_id": "<context from the current turn instructions>",
  "plan": [
    { "id": "inspect", "step": "Inspect the implementation", "status": "completed" },
    { "id": "verify", "step": "Verify the change", "status": "in_progress" }
  ]
}
```

Plans allow 1–30 steps, unique stable ids, and at most one `in_progress` step.
The service resolves session and history run marker itself; supplied session,
run, revision, and execution-state fields cannot redirect or finish a plan.
Contexts expire at the end of a turn and reject other profiles. Coding runtime
ids can span turns, so snapshots use the response stream's per-turn history
marker instead. Ekko continues using its native `update_plan` tool. Its managed
MCP definitions set `HERMES_MCP_NATIVE_TASK_PLAN=1`, which excludes shared planning
from tool discovery, descriptions, and direct/catalog calls. Existing managed
definitions receive this flag during configuration synchronization.

## Persistence and lifecycle

Updates commit to the existing `task_plans` table before emitting `plan.updated`.
Studio and App reuse their existing revision merging, live cards, paginated
history, and resume snapshots. The HTTP chat-run wrapper also records plan
events when requested. Group-chat card presentation is outside this change.

Completion, failure, explicit stop, queue interruption, session disposal, and
server shutdown invalidate the context. Completed steps remain completed;
unfinished steps remain pending with an ended/interrupted/failed execution state.
The runtime never claims unfinished work was completed. Startup recovery marks
orphaned running snapshots interrupted; contexts are intentionally not restored.

After upgrading, restart Studio and persistent MCP clients to load the new tool.
New turns receive the planning instructions; already-running turns do not acquire
a context retroactively. Tool use still depends on the agent following those
instructions and having the managed `use` MCP enabled.

## Validation

- Service/controller tests cover validation, persistence ordering, revisions,
  profile isolation, stale contexts, failed writes, and terminal states.
- Socket tests cover Codex completion/failure/stop and Hermes completion/interruption.
- MCP subprocess tests describe and call the tool through its compact catalog.
- Browser tests cover live progress and Ekko/Codex task-card recovery after reload.
