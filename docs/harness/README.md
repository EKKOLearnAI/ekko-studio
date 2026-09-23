# Harness Overview

This harness turns recurring project knowledge into files and checks that an
agent can discover without chat history.

## Goals

- Make repository context legible through short maps and deeper docs.
- Keep architecture constraints close to the code they protect.
- Give agents a deterministic validation path before opening or updating a PR.
- Prefer mechanical checks over reminder text when a rule can be verified.

## Entry Points

- `AGENTS.md` is the root map for coding agents.
- `ARCHITECTURE.md` documents package boundaries and state ownership.
- `DEVELOPMENT.md` remains the contributor rules and command reference.
- `docs/harness/validation.md` maps change types to checks.
- `docs/harness/worktree-runbook.md` explains isolated worktree development.
- `docs/harness/pr-review.md` provides a PR self-review checklist.
- `docs/harness/startup-tasks.md` describes one-time startup operations and their persistent execution records.
- `docs/harness/server-module-boundaries.md` defines backend ownership and the migration target.
- `docs/harness/jev-integrations.md` defines JEV feature switches, frontend configuration and integration registration.
- `scripts/harness-check.mjs` is the single harness entry point. It enforces
  repository, desktop release/runtime, and backend module-boundary invariants.
- `scripts/server-module-boundaries.mjs` implements the backend boundary portion
  consumed by the unified harness and its focused unit tests.
- `scripts/jev-integrations.json` registers concrete JEV consumers and their UI fields;
  `scripts/jev-harness.mjs` checks them through the same unified harness.

The only public harness command is:

```bash
npm run harness:check
```

## Operating Model

1. Read the root map and the specific doc for the task.
2. Make the smallest scoped change.
3. Add or update focused tests when behavior changes.
4. Run `npm run harness:check` and the relevant validation commands.
5. If a failure pattern repeats, improve this harness with docs, tests, scripts,
   or CI instead of relying on a longer prompt.

## What Belongs In The Harness

- Facts that future agents must know to work safely.
- Checklists that prevent repeated PR review comments.
- Scripts that fail fast on repository-wide invariants.
- Runbooks for local, CI, release, and desktop packaging flows.

Do not put long implementation notes in `AGENTS.md`. Add them under `docs/` and
link to them from the map.
