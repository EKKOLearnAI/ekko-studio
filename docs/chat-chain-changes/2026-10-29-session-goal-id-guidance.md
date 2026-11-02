# Session goal id guidance in the turn prompt

The unknown-id error now names the rejected id and its remedy, and the tool schema
documents `id`. The Session Goals turn prompt still told the model only to reuse an
id, so a model that had not yet created a goal could still invent one and collect
the rejection. The prompt is the instruction the model reads on every turn, so the
rule belongs there too.

The prompt now says to create a new goal without `id` so the host assigns it, and to
reuse only ids that `list_session_tasks` returned. Behaviour is unchanged: an unknown
`id` is still rejected, because resolving it silently would adopt a goal id from
another session or from a stale ledger.

Validation: `tests/ekko-agent/session-tasks.test.ts` asserts the prompt carries the
rule and that `update_session_tasks` documents `id` on its schema. This completes
the guidance added with the repository error and the tool schema.
