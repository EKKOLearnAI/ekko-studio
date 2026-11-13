# Workflow Page

This document records the current Workflow page implementation in Hermes Web UI.
The page is still a front-end workflow builder plus persistence layer. Workflow
execution is intentionally not wired yet.

## Entry Points

- Client route: `/hermes/workflow`
- Client view: `packages/client/src/views/hermes/WorkflowView.vue`
- Agent node component:
  `packages/client/src/components/hermes/workflow/WorkflowAgentNode.vue`
- Client API helper: `packages/client/src/api/studio/workflows.ts`
- Server routes: `packages/server/src/modules/studio/routes/workflows.ts`
- Server controller: `packages/server/src/modules/studio/controllers/workflows.ts`
- Server service singleton: `packages/server/src/modules/studio/services/workflow/manager.ts`
- Server socket: `packages/server/src/modules/studio/sockets/workflow.ts`
- Store: `packages/server/src/modules/studio/repositories/workflow-store.ts`
- Schema: `packages/server/src/modules/studio/infrastructure/database/schemas.ts`

The Workflow page is opened from the same left page sidebar used by chat,
history, and group chat. The workflow list also lives in the left sidebar.

## Implemented UI

- Vue Flow is used for the canvas.
- Users can create, edit, save, delete, and batch delete workflows.
- The create workflow drawer collects:
  - workflow name
  - profile
  - optional workspace directory
- If no workspace is selected, the server creates a default workspace:
  `~/.hermes-web-ui/workflow/<profile>/<workflowId>`.
- The workflow sidebar supports:
  - profile filter
  - batch mode
  - select all
  - batch delete
  - per-row delete
  - empty/loading states
- Workflow rows show name, profile, node count, and edge count.
- The canvas toolbar includes:
  - add node
  - save
  - start execution placeholder
- The start execution button currently only shows a "not connected yet" message.

## Node Behavior

Workflow nodes are custom agent nodes. Each node has:

- title
- agent selector: `hermes`, `claude-code`, `codex`
- provider/model selector
- API mode selector for coding agents
- skills tag input
- main input textarea
- file/image attachments
- one left input handle
- one right output handle

The node frame is resizable. The textarea grows with the node height instead of
being independently resized.

Attachments use the shared upload endpoint through `uploadRuntimeFiles`. Images
render as thumbnails and open in a full-screen preview overlay. Non-image files
render as file chips. The upload button remains last in the attachment flow.

## Edge Behavior

Edges are Vue Flow `smoothstep` edges with dashed styling and arrow markers.

Connections are constrained in two places:

- During dragging, `isValidWorkflowConnection` only allows right output to left
  input.
- During save, existing edges are validated again so bad loaded data cannot be
  saved silently.

Valid edge shape:

```json
{
  "id": "agent-1-agent-2",
  "source": "agent-1",
  "target": "agent-2",
  "sourceHandle": "output",
  "targetHandle": "input",
  "type": "smoothstep",
  "animated": true
}
```

Invalid examples:

- input to input
- output to output
- left input to right output
- self connection
- connection to a missing node

## Save Validation

Saving a workflow is blocked on the client when any of these checks fail:

- at least one node is required
- every node needs a title
- every node needs a provider
- every node needs a model
- coding-agent nodes need an API mode
- every node needs input text
- every edge must reference existing nodes
- every edge must go from `output` to `input`
- with more than one node, no node can be completely disconnected
- the graph must be one connected workflow, not multiple independent flows
- the directed graph must not contain a cycle

The graph allows:

- multiple start nodes
- multiple terminal nodes
- branching
- merging

The graph does not allow parallel disconnected flows. For example,
`A -> B` and `C -> D` in the same workflow is invalid until the two groups are
connected into one workflow graph.

Cycle detection is directed. Connectivity detection is undirected, because it is
only used to catch disconnected groups.

## Persistence

Workflow definitions are persisted in the `workflows` table.

```sql
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  profile TEXT NOT NULL DEFAULT 'default',
  workspace TEXT,
  nodes_json TEXT NOT NULL DEFAULT '[]',
  edges_json TEXT NOT NULL DEFAULT '[]',
  viewport_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

The schema sync code adds new workflow columns safely on startup. Existing
databases do not need a manual migration for `viewport_json`.

`nodes_json` stores the serialized Vue Flow nodes with runtime callbacks removed.
`edges_json` stores Vue Flow edge definitions. `viewport_json` stores the current
canvas viewport:

```json
{
  "x": 80,
  "y": 80,
  "zoom": 0.75
}
```

The page restores the saved viewport when switching to a workflow or reloading
the workflow list. Save sends the current `x`, `y`, and `zoom` together with
nodes and edges.

## API

Routes:

- `GET /api/studio/workflows`
- `GET /api/studio/workflows?profile=<profile>`
- `POST /api/studio/workflows`
- `GET /api/studio/workflows/:id`
- `PATCH /api/studio/workflows/:id`
- `DELETE /api/studio/workflows/:id`
- `POST /api/studio/workflows/batch-delete`

Socket namespace:

- `/workflow`
- `workflows.list` returns the same workflow list shape as the HTTP list API.
- `workflow.status.subscribe` subscribes to accessible workflow status rooms, or
  to a single workflow by `workflowId`.
- `workflow.status.unsubscribe` leaves the matching status room.
- `workflow.status.updated` is emitted when the server-side workflow manager
  publishes a runtime status change.

Create body:

```json
{
  "name": "Research Flow",
  "profile": "default",
  "workspace": null,
  "nodes": [],
  "edges": [],
  "viewport": { "x": 80, "y": 80, "zoom": 0.75 }
}
```

Patch body supports partial updates:

```json
{
  "name": "Updated Flow",
  "workspace": "/path/to/workspace",
  "nodes": [],
  "edges": [],
  "viewport": { "x": -200, "y": 120, "zoom": 0.9 }
}
```

Batch delete body:

```json
{
  "ids": ["workflow-id-1", "workflow-id-2"]
}
```

The controller enforces profile access for non-super-admin users. The store
persists data in SQLite when available and falls back to the JSON store helpers
when no SQLite database is active.

## Execution Design

Workflow execution is implemented through the shared chat-run and coding-agent
runtime paths.

### Implemented

- The schema includes run-oriented tables:
  - `workflow_runs`
  - `workflow_run_node_sessions`
- Workflow node messages are not duplicated in workflow-specific message tables.
  They are read from the shared `messages` table through the node's
  `sessions.id`.
- Chat sessions created for workflow nodes use `sessions.source = "workflow"`
  so normal chat and Hermes history lists stay clean.
- The `workflow_run_messages` table is no longer used.
- Workflow runtime status can be pushed over the `/workflow` socket through
  `workflow.status.updated`.
- Workflow node agent mapping is defined in the server workflow manager:
  - Hermes nodes are workflow sessions but execute through the existing
    bridge/API-server path because the upstream Hermes bridge does not
    understand `workflow` as an execution source.
  - Claude Code and Codex nodes are workflow sessions but execute through the
    existing coding-agent path with the matching `coding_agent_id`.
- `POST /api/studio/workflows/:id/run` starts a run asynchronously.
- `packages/server/src/modules/studio/services/workflow/manager.ts` owns immediate execution,
  run status, stop/delete behavior, run snapshots, and node session cleanup.
- Each run persists a `workflow_runs` row and a
  `workflow_run_node_sessions` row per executed node.
- The executor schedules nodes from the workflow graph and applies the fan-in
  failure rule documented below.
- Each node receives one assembled user message containing upstream outputs,
  selected skill content, the current node task, and current node images.
- `packages/server/src/modules/studio/public/runs/prompt.ts` injects workflow-specific context
  when the run source is `workflow`.
- Workflow node sessions are hidden from normal chat/history lists by default.
- Workflow runs can be listed, selected, stopped, deleted, and inspected from
  the workflow page.
- Selecting a run shows the workflow snapshot. Nodes in snapshot mode are
  read-only and can open their associated session transcript.
- Hermes workflow nodes auto-respond to tool approval requests with the
  one-time `once` choice. Normal single-chat approvals still require the user
  to respond from the chat UI.

### Execution Source Model

`workflow` is a Web UI session source and scheduler marker. It is not a new
upstream agent backend.

- Persisted node sessions use `sessions.source = "workflow"`.
- Hermes nodes still execute through the existing bridge/API-server path.
- Claude Code and Codex nodes still execute through the existing coding-agent
  path.
- The executor decides the concrete run path from the node's selected agent.

### Node User Message Assembly

Each workflow node receives exactly one user message per node execution.
That user message is assembled from upstream outputs and the current node's
configured input, plus selected skill content when configured.

For a node with upstream dependencies, the format should be stable and
debuggable:

```text
[Workflow upstream results]

[Upstream: <node title or node id>]
<last assistant output from that upstream node session>

[Current task]
<current node input>
```

Rules:

- Use the last assistant message from each completed upstream node session as
  that upstream node's output.
- Include selected skill content in the assembled user message before the
  current node task.
- Do not copy upstream messages into the downstream node session as separate
  messages.
- Do not forge assistant messages in the downstream node session.
- Preserve a stable upstream order, preferably by incoming edge order in the
  workflow snapshot.
- Node attachments belong to the current node. Upstream attachments are not
  inherited automatically in the first implementation.

### Workflow System Context

Workflow runs inject a small system context when `source` is `workflow`.
The injection point is `packages/server/src/modules/studio/public/runs/prompt.ts`.

The system context tells the model that it is executing one workflow node,
that upstream results are context, and that it should focus only on the current
node task.

```text
You are executing one node in a workflow.

Focus only on the current node task. Use upstream node results as context, but
do not rerun upstream work. If upstream results conflict, call out the conflict
and proceed with the best supported answer.

Return the result for this node clearly and concisely. Do not describe the
workflow mechanics unless the task asks for it.
```

### Fan-in Execution Rule

When multiple upstream nodes connect into the same downstream node, the
downstream node must wait until every upstream node has completed successfully
before it starts.

For example:

```text
A ─┐
   ├─> C
B ─┘
```

Node `C` starts only after both `A` and `B` are completed. If either `A` or `B`
fails, the entire workflow run is marked as failed and `C` must not run.

## Current Limitations

- Server-side save validation currently validates request shapes and profile
  access. Graph semantic validation is implemented in the client save path.
- Attachments are stored as uploaded file paths on node data. There is no
  separate workflow attachment table.
- Skills are stored as names on the node and resolved at run time.
- Workflow node sessions are persisted through the shared chat/message tables.
  Coding-agent sessions may only show assistant messages after the underlying
  run flushes its database writes.

## Validation

Relevant checks used while building this feature:

```bash
npm run test -- tests/server/workflow-store.test.ts tests/server/schema-sync.test.ts
npm run test -- tests/server/workflow-controller.test.ts tests/server/workflow-manager.test.ts tests/server/run-chat-queued-item.test.ts
npx tsc --noEmit -p packages/server/tsconfig.json
npx vue-tsc -b
npm run build
git diff --check
```
