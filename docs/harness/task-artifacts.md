# Task artifacts and checkout hygiene

Keep one-off task reports, diagnostic dumps, screenshots, recordings, temporary
probe code and test reports outside every Git checkout. Put maintained project
documentation in `docs/`, reproducible tests and deliberate fixtures in `tests/`,
and product assets in their owned source directories. A task's output does not
become project documentation merely by placing it in `docs/`.

## Get an external task directory

```bash
export STUDIO_TASK_DIR="$(npm run --silent artifacts:new -- person-verification)"
# Write reports and temporary scripts under "$STUDIO_TASK_DIR".
npm run artifacts:check
```

`artifacts:new` creates a unique directory with a `.studio-task-artifact.json`
ownership marker. By default its parent is
`<os.tmpdir()>/ekko-studio-task-artifacts/<checkout-path-hash>/`; separate
worktrees have separate defaults. `npm run --silent artifacts:dir` prints that
parent without creating it. For evidence that must survive OS temporary-file
cleanup, set `STUDIO_TASK_ARTIFACTS_DIR` to an absolute, task-owned directory at a
user-approved location outside the checkouts. Use distinct overrides for
concurrent worktrees or runs.

The helper rejects relative overrides and paths inside the current checkout or
any worktree registered by Git. It resolves existing symlink ancestors before
accepting a path. It does not change Git configuration, install hooks or delete
anything. Source archives without Git metadata can validate only their own root.

## Test reports

Vitest coverage defaults to `<artifact-parent>/coverage`. Playwright defaults to
`playwright-results`, `playwright-html` and `playwright-blob` under that parent.
The HTML/blob reporter environment variables are set and validated in the
Playwright configuration, including when CLI `--reporter` replaces the reporter
list. Explicit `PLAYWRIGHT_HTML_OUTPUT_DIR` / `PLAYWRIGHT_BLOB_OUTPUT_DIR`
overrides must also be absolute and outside all registered checkouts.

The E2E workflow uses `runner.temp/studio-artifacts` and uploads the corresponding
external paths with a seven-day Actions retention period. The Build, Test and
E2E jobs run the artifact guard after their commands. Build also runs it through
the existing `npm run harness:check` entry point.

Do not move shipping output such as `dist`, firmware `.pio`, desktop runtime
resources, desktop releases or npm tarballs merely to satisfy this rule. Their
build and packaging contracts remain in effect. Dependency caches under
`node_modules` remain local and supported.

## What the executable guard checks

`scripts/task-artifacts.mjs` inspects actual filesystem entries, including ignored
and untracked paths. `npm run artifacts:check` and `npm run harness:check` reject:

- Task/output directories named `artifacts`, `.artifacts`, `reports`,
  `task-reports`, `screenshots`, `recordings`, `verification-output`, `tmp`, `.tmp`.
- Local test-report directories named `coverage`, `playwright-report`,
  `blob-report`, `all-blob-reports`, `test-results`.
- Files with a `report`, `verification`, `audit` or `test-results` name segment
  and a report extension (`md`, `txt`, `log`, `json`, `html`, `csv`, `zip`), or
  standalone `.log` files, outside the protected areas below.

The guard never reads file contents, follows directory symlinks, enters nested
repositories, or deletes files. It excludes `.git`, `node_modules`, `.pio`,
`__pycache__`, compiled `dist` / `dist-ssr`, shipping release/runtime directories,
application state (`hermes_data`, server `data`, `.hermes*`, `.ekko`), local agent
configuration (`.claude`, `.codex`) and runtime `logs`. See the explicit protected
paths in the script. These exemptions protect data and compatibility; they do
not declare all files in those locations to be generated, disposable or safe.

The established `docs/screenshots` product-documentation assets and the exact
tracked history document
`docs/chat-chain-changes/2026-09-27-hermes-bridge-compatibility-audit.md` also remain
supported. The latter is an explicit legacy exception, not an exemption for new
one-off audit reports elsewhere in `docs/`.

This is a workflow check, not a filesystem sandbox. It runs when invoked or in
CI; it cannot prevent an arbitrary process from writing a file. Unrecognized
filenames, alternate reporter/CLI output overrides, protected runtime areas,
nested repositories and symlink targets can bypass its inspection. A clean
result does not prove that every remaining file belongs to main or that it can
be removed. The development rule still applies in those areas.

## Retention and safe cleanup

1. Keep evidence only as long as the task or review needs it. Copy requested
   deliverables to an agreed external destination before OS temp cleanup.
2. Stop the task's writers. Verify the ownership marker and exact task path, then
   remove only that task directory when its evidence is no longer needed.
3. Framework report categories can be removed after their test run and evidence
   collection finish. Coordinate concurrent runs sharing an explicit override.
4. Never use a repository-wide `git clean -fdx`, age-based sweep or this guard as
   deletion authorization. Ignored files can contain credentials, user data,
   recovery backups, valuable source copies or nested repositories.
5. For legacy cleanup, record the exact approved paths, generator/provenance,
   tracked-file and nested-repository checks, usage checks, counts and sizes
   outside the checkout. Keep uncertain files and report the uncertainty.

There is intentionally no automatic garbage collector for user/runtime data or
unowned directories. Temporary storage lifetime and available disk space depend
on the host.

## Focused verification

```bash
npm test -- tests/harness/task-artifacts.test.ts
npm run artifacts:check
npm run harness:check
```

The tests exercise ignored/untracked outputs, source-adjacent leftovers,
dependency/runtime exemptions, symlink escapes and inspection without deletion.
When changing reporter configuration, also run a small real coverage run and a
focused Playwright run with HTML/blob reporters, then verify that the checkout
stays free of report directories.
