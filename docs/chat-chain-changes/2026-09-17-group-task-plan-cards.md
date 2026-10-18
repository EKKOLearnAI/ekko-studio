# Group task plan cards

## Behavior

Studio and App render a task card at the end of the corresponding Agent response
in group chat. Tool trace visibility does not hide cards. Updates replace the
same card; reconnecting and paginating load the stored snapshot. Cards retain
sender identity, so concurrent Agents and separate turns stay distinct.

## Event and storage path

- Coding Agents and Ekko emit `plan.updated` through `ChatRunSocket`. The group
  executor serializes the snapshot into the existing group `message` transport
  with `role: tool` and `tool_name: task_plan`. The deterministic message ID hashes
  room, Agent session, and plan identity; `run_id` maps to the group response run.
- Hermes group bridge runs receive a per-turn, plan-only MCP context. Its
  publisher uses the same group message path and expires in the bridge finalizer.
  Hermes does not receive the MCP clarification instruction.
- Existing message storage, history pagination, and remote relay transport carry
  the snapshot, without adding a database column or a new relay event type.
- Storage rejects identity changes and older revisions; clients also reject old
  replay snapshots. Creation timestamps remain fixed across updates.
- Task cards do not enter model conversation history, summaries, token estimates,
  or Agent mention routing. They are rendered separately from ordinary tool traces.
- Interrupted/failed runs preserve unfinished steps. Startup recovery marks
  persisted running group plans interrupted, since their runs cannot resume.

## Validation

Focused socket tests cover broadcasts, history rejoin, revision ordering,
identity isolation, and startup recovery. Agent executor tests cover Coding
Agent forwarding and Hermes completion, interruption, failure and context expiry.
Browser coverage checks cards with tools hidden, multiple Agents, live updates,
collapse, and refresh. App tests exercise parsing and grouping; its H5 smoke
fixture compiles the actual list components and checks group card placement.
