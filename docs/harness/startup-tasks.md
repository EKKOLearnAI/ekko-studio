# One-time startup tasks

Register file, configuration and data upgrades in
`packages/server/src/bootstrap/startup-tasks.ts`. This ordered task list runs
before runtime discovery, model catalogs, gateway startup and request handling.
Keep each operation in its owning module; bootstrap composes the registry.
Regular startup initialization, such as refreshing caches or reconciling managed
MCP servers, stays outside this list.

Execution records live in `startup-tasks.json` under `config.appHome`
(`HERMES_WEB_UI_HOME`, then `HERMES_WEBUI_STATE_DIR`, default `~/.hermes-web-ui`).
The file records task ID, data scope, completion/failure status, attempt count
and timestamps. It contains no configuration contents or credentials.

- A completed task is skipped without invoking its operation or rewriting the
  state file. New task IDs run on the next startup.
- Tasks execute in declaration order. A failed task is recorded and stops the
  remaining task list for that startup. The application continues to start;
  unfinished tasks retry on the next startup.
- Every successful task is recorded immediately using atomic file replacement.
  Earlier completed tasks remain skipped when a later task fails.
- Malformed or unsupported state is preserved, and startup tasks are skipped
  with a warning. Do not silently reset the file: that would repeat completed
  operations. A `.bak` file is maintained when state changes.
- Concurrent calls within one server serialize execution and state writes.
  Separate server processes must not run against the same data directories
  concurrently; this runner does not provide a cross-process execution lock.

## Adding a task

1. Append a task with a permanent, descriptive ID such as
   `2026-09-12-hermes-apikey-domain-v1`. Do not rename or reuse an executed ID.
2. Set `scope` to the data directory or another stable data identity. Use the
   Hermes root directory for Hermes operations and `config.appHome` for Studio
   operations. Changing data directories then creates a separate completion
   record instead of incorrectly skipping the new data.
3. Implement `run()` in the module that owns the data. Resolve only when all
   required work succeeds; throw on partial failures. The runner does not infer
   failure from returned values.
4. Make the operation safe to retry and back up changed files. A crash after
   changing data but before saving completion can repeat that unfinished task;
   the runner cannot provide an atomic transaction across arbitrary files and
   its completion record.
5. Add focused tests for the operation and run the startup-task runner tests,
   `npm run harness:check`, and `npm run build`.

The initial registered task replaces old apikey domains in existing Hermes
profiles. Completion is scoped to the Hermes root directory, not each profile.
Once completed, later imports of old profiles into that same root are not
rescanned. Changes that must run again need a new task ID or an explicit import
upgrade step, rather than changing the implementation behind a completed ID.
