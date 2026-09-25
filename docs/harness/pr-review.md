# PR Self-Review

Use this checklist before pushing or updating a pull request.

## Scope

- The PR title states the behavior being changed.
- The diff is limited to the requested task and required harness updates.
- Unrelated formatting or refactors are not bundled into the change.
- User-facing text has locale coverage.
- JEV consumers are registered with independent switches and frontend configuration; configuration-only status must not imply an active evaluation policy.

## Architecture

- Client code uses shared API helpers and existing UI patterns.
- Server routes stay thin and delegate reusable behavior to controllers/services.
- Web UI state uses `config.appHome` or documented helpers.
- Hermes Agent state and Web UI state remain separate.
- Subprocess calls use argument arrays instead of shell string construction.

## Tests And Validation

- A focused test was added or updated for behavior changes.
- Browser-visible flows have e2e coverage when the risk justifies it.
- `npm run harness:check` passes.
- The PR body lists validation commands that actually ran.
- Known limitations or follow-ups are called out.

## Release And CI

- Workflow changes were checked with `npm run harness:check`.
- Desktop release artifacts remain platform-specific.
- `fail_on_unmatched_files: true` is preserved when each matrix target has its
  own expected artifact list.
- Package manifest changes have matching lockfile changes when dependencies
  change.

## Before Merge

- CI is green or failures are explained as unrelated.
- The branch is mergeable.
- The PR does not depend on hidden local state, credentials, or uncommitted files.
