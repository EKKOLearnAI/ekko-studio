# Workspace Run Diffs

## Goal

Record files changed during each chat run so the chat timeline can show a compact
file-level summary below the final assistant response. The default chat view
should show only changed files and line counts; full per-file patches load only
when the user expands a file.

The feature must work for any language or project type. Git repositories should
use Git for ignore/status semantics, while non-Git workspaces should fall back to
a bounded filesystem snapshot.

## User Experience

Each completed run can show a small workspace change block:

```text
Changed 3 files
M src/Login.vue        +12 -4
A src/api/auth.ts      +48 -0
D old/login.js         +0 -22
```

Clicking a file opens or expands that file's patch. The timeline does not load
patch bodies by default.

If a diff is too large or binary:

```text
M package-lock.json    diff truncated
M assets/logo.png      binary changed
```

## Correlation Model

Use `change_id` as the primary correlation key. Run-level change ids use
`run:<run_id>`.

- Run start creates a checkpoint keyed by `session_id + change_id`.
- Run completion or failure computes the delta from that checkpoint before the
  terminal run event is emitted.
- Persisted change rows store `run_id` and `change_id`.
- The client inserts run change summaries below the final assistant response.

## Data Model

Store summaries separately from patch bodies so normal history loading stays
small.

### `workspace_run_changes`

One row per run.

```sql
CREATE TABLE IF NOT EXISTS workspace_run_changes (
  change_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'run',
  workspace TEXT,
  workspace_kind TEXT NOT NULL DEFAULT 'unknown',
  started_at INTEGER,
  finished_at INTEGER,
  changed_count INTEGER NOT NULL DEFAULT 0,
  added_count INTEGER NOT NULL DEFAULT 0,
  modified_count INTEGER NOT NULL DEFAULT 0,
  deleted_count INTEGER NOT NULL DEFAULT 0,
  renamed_count INTEGER NOT NULL DEFAULT 0,
  binary_count INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  total_patch_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspace_run_changes_session
  ON workspace_run_changes(session_id, created_at);
```

### `workspace_run_change_files`

One row per changed file.

```sql
CREATE TABLE IF NOT EXISTS workspace_run_change_files (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  path TEXT NOT NULL,
  old_path TEXT,
  change_type TEXT NOT NULL,
  additions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  size_before INTEGER,
  size_after INTEGER,
  patch TEXT,
  patch_bytes INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  binary INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspace_run_change_files_change
  ON workspace_run_change_files(change_id);
```

`patch` is optional and bounded. Large/binary files keep metadata only.

## Capture Flow

### 1. Resolve Workspace

Only enable tracking when the run has a concrete local workspace path.

- Chat sessions use `session.workspace` or the resolved Hermes run workspace.
- Workflow node sessions use the workflow workspace passed to bridge runs.
- Coding-agent runs use the launched workspace directory.
- If the path is missing or inaccessible, skip tracking for that run.
- User home directories, their ancestors and filesystem roots remain valid
  execution directories, but automatic diff tracking skips them. Apply this
  boundary to both the supplied path and canonical filesystem/Git roots so a
  symlink or a home-wide repository cannot trigger a whole-account scan.
  Protected or cloud-backed directories can block a synchronous filesystem
  call; the scan's elapsed-time budget cannot interrupt an in-flight call.

### 2. Run Start Checkpoint

At `run.started`:

1. Resolve workspace root.
2. Detect Git with `git rev-parse --show-toplevel`.
3. Build a lightweight checkpoint:
   - relative path
   - size
   - mtimeMs
   - optional hash for small tracked/candidate text files
   - optional content snapshot for small text files
4. Store checkpoint in memory with a TTL.

Do not persist checkpoints. If the server restarts mid-tool, skip the diff for
that tool and emit no change block.

### 3. Tool Complete Delta

At `tool.completed`:

1. Load the in-memory checkpoint.
2. Scan the workspace again.
3. Compare before/after metadata.
4. Read/hash only candidate files whose size or mtime changed.
5. Generate per-file line stats and bounded patches.
6. Persist summary and file rows.
7. Emit a socket event with summary only.

The delta is checkpoint-to-checkpoint. It must not use plain `git diff HEAD`,
because the workspace may already be dirty before the tool starts.

## Git Workspace Strategy

When `git rev-parse --show-toplevel` succeeds:

- Use Git to determine repository root.
- Use Git ignore semantics instead of parsing `.gitignore` manually:
  - `git check-ignore --stdin`
  - `git status --porcelain --untracked-files=normal`
- Use checkpoint comparison to isolate this tool call's changes.
- Use Git only as an optimization for:
  - ignored file filtering
  - tracked/untracked classification
  - optional patch formatting for currently changed tracked files

Important behavior:

- Files already dirty before the tool call are not included unless their content
  changes during this tool call.
- Tracked files remain eligible even if they match `.gitignore`, matching Git's
  normal semantics.
- Untracked ignored files are skipped.

## Non-Git Workspace Strategy

For non-Git workspaces:

- Use built-in ignore rules.
- Optionally apply root `.gitignore` as best-effort, but do not rely on full Git
  semantics.
- Use filesystem snapshots only within limits.

Default ignored directories:

```text
.git
node_modules
dist
build
target
.gradle
.mvn
.venv
venv
__pycache__
.pytest_cache
.cache
coverage
```

Default skipped file classes:

```text
*.pyc
*.class
*.o
*.so
*.dylib
*.dll
*.exe
*.png
*.jpg
*.jpeg
*.gif
*.webp
*.zip
*.tar
*.sqlite
*.db
```

## Limits

The tracker must degrade gracefully instead of blocking the tool run.

Suggested defaults:

```text
max scanned files per workspace: 20,000
max changed files stored per tool: 50
max patch bytes per file: 128 KiB
max total patch bytes per tool: 512 KiB
max content snapshot file size: 512 KiB
max scan time per phase: 1,000 ms soft limit
checkpoint TTL: 30 minutes
```

When a limit is hit:

- Store file metadata.
- Mark `truncated = 1`.
- Omit or truncate `patch`.
- Continue rendering the summary.

## API And Socket Surface

### Socket Event

Emit after run diff is stored and before the terminal run event:

```ts
workspace.diff.completed
```

Payload:

```ts
{
  event: 'workspace.diff.completed',
  session_id: string,
  run_id: string,
  change_id: string,
  changed_count: number,
  files: Array<{
    id: string,
    path: string,
    old_path?: string | null,
    change_type: 'added' | 'modified' | 'deleted' | 'renamed',
    additions: number,
    deletions: number,
    binary: boolean,
    truncated: boolean
  }>,
  truncated: boolean
}
```

### History API

Normal session detail should include summary metadata without patch bodies, or
the client can request summaries separately:

```text
GET /api/studio/sessions/:id/workspace-run-changes
```

Patch bodies load on demand:

```text
GET /api/studio/sessions/:id/workspace-run-changes/:changeId/files/:fileId
```

The patch endpoint returns one file row with `patch`.

## Frontend Rendering

Store change summaries by `change_id`.

During message rendering:

1. Render the final assistant response.
2. Insert the compact file list below that assistant response.
3. Clicking a file lazily loads the patch body.
4. Respect `binary` and `truncated` flags.

The chat timeline should not render full patches inline by default.

## Retention

Workspace diffs can be larger than ordinary messages. Add cleanup behavior:

- Delete rows when a session is deleted.
- Consider keeping only the latest N tool change records per session, or a
  time-based cleanup policy such as 30 days.
- Keep indexes session-scoped for efficient cleanup.

## First Implementation Slice

1. Add SQLite tables and store helpers.
2. Implement Git workspace checkpoint/delta with ignore filtering and limits.
3. Hook checkpoint/delta into bridge tool started/completed events.
4. Emit summary socket events.
5. Add client store state keyed by `tool_call_id`.
6. Render compact file summaries under tool cards.
7. Add lazy patch endpoint and expandable file patch UI.

Non-Git snapshot support can follow after the Git path is stable.
