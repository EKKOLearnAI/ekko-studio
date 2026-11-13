# Development Guidelines

This document defines project-level development rules for Quanthermes Studio. It is tool-agnostic and applies to all contributors and coding agents.

## Commands

```bash
npm install
npm run dev
npm run test
npm run test:coverage
npm run test:e2e
npm run build
```

- `npm run dev` starts the Vite client and Koa server together.
- `npm run test` runs Vitest unit tests.
- `npm run test:coverage` is an optional local command; CI does not run coverage.
- `npm run test:e2e` runs Playwright browser tests against a mocked BFF API.
- `npm run build` type-checks and builds both client and server.

## Independent Studio Plugins

Use `ekko-studio plugins create <id> [directory]`, `link <directory>`, `list`,
`dev [id|directory]` and `unlink <id>` to manage standalone projects. Start
debugging from the plugin center to build and watch a trusted project. The CLI
and host must use the same `HERMES_WEB_UI_HOME`. See `docs/plugins.md` for the
registry, local SDK, reload behavior and troubleshooting.

## Architecture

- Frontend code lives under `packages/client/src`.
- Server code lives under `packages/server/src`.
- Hermes-specific client code stays under `hermes` namespaces: API modules, views, stores, and components.
- Server routes should stay thin. Put request handling in controllers and reusable behavior in services.
- The chat runtime is Socket.IO based and lives under `packages/server/src/modules/studio/services/chat-run`.
- Web UI state lives under `HERMES_WEB_UI_HOME` or `HERMES_WEBUI_STATE_DIR`, defaulting to `~/.hermes-web-ui`.

## Coding Rules

- Prefer existing local patterns over new abstractions.
- Keep changes scoped to the requested behavior.
- Do not mix unrelated refactors into feature or bugfix commits.
- Do not reintroduce deprecated compatibility switches without a current caller.
- Use structured APIs and parsers for structured data instead of ad hoc string edits when possible.
- Add comments only where they explain non-obvious behavior or constraints.
- Every Studio-injected managed MCP server must explicitly set `ELECTRON_RUN_AS_NODE: '1'` in its own launch `env`, including when an independent Node executable is selected. Never rely on parent environment inheritance or set this globally for the desktop GUI. See `docs/harness/validation.md` for the guardrail.

## Frontend Rules

- Use Vue 3 Composition API with `<script setup lang="ts">`.
- Use Pinia setup stores.
- Use the shared API request helper in `packages/client/src/api/client.ts`.
- Add user-facing strings to all locale files.
- Keep component styles scoped with SCSS unless the style is intentionally global.
- Match existing Naive UI patterns and avoid adding a new UI library.
- Follow `docs/harness/frontend-ui.md` for theme ownership, wallpaper transparency,
  scoped exceptions and browser verification. `npm run harness:check` rejects new
  unowned backgrounds, literal colors and local Naive UI fill overrides.

## Server Rules

- Register local API routes before proxy catch-all routes.
- Keep auth behavior centralized in `packages/server/src/modules/studio/services/auth`.
- Resolve state paths through `getWebUiHome()` from `modules/studio/public/config`; this honors both supported state directory environment variables.
- Keep Hermes home paths separate from Web UI home paths.
- Use `getActiveProfileDir()` or related profile helpers for Hermes profile files.
- Avoid shell string construction for CLI calls; prefer `execFile`/`spawn` with argument arrays.

## Testing Rules

- The legacy tests and fixtures have been removed. Every new feature must include
  small, focused tests; do not rebuild a full regression suite by default.
- Keep tests scoped to the new behavior. Use Vitest for local logic and include
  Playwright coverage for new browser journeys.
- Use local fixtures and mocked external APIs/sockets. Avoid global setup,
  source-string assertions and repeated platform/theme/viewport matrices.
- Run `npm run harness:check` and `npm run build` before opening a PR, plus the
  specific tests added for new functionality.
- `npm test`, `npm run test:coverage` and `npm run test:e2e` allow an empty suite
  during the reset while continuing to fail on assertions in any tests that are
  present. An empty suite does not exempt new features from adding tests.
- Independent Test and E2E workflows run `npm test` and `npm run test:e2e`
  automatically on pushes to `main` and pull requests targeting `main` or `base`;
  both also support manual dispatch. Build reports harness and production-build
  results separately. E2E uses four Chromium shards with one worker each and a
  combined `E2E` result and HTML report. Lockfile checks remain separate. Blanket
  coverage and platform test matrices remain removed. See `tests/README.md`.

## npm Publishing

The package remains `@quanthermes/hermes-web-ui`, with its own release channel.
`npm run build` followed by `npm run pack:npm -- /absolute/output/directory`
creates the scoped package tarball. `npm run publish:npm -- --dry-run` validates
packaging without publishing. Publishing needs the release account's npm
credentials. This merge does not create a tag or publish a release.

Device release tags belong on `org` (`tangledup-ai/hermes-web-ui`); inspect the
actual remote URL before pushing. Candidate publication and manual promotion
remain separate, with a minimum 24-hour candidate age. Use a fresh workflow
dispatch for promotion. See `docs/harness/source-deploy-refactor.md`.

## Local Capabilities and Updates

USB, LAN peers, XiaoZhi, meetings, knowledge vaults, scanning and grading are
Studio-owned modules. Expert Center and Experts Marketplace are removed;
Hermes skills and the upstream plugin market remain available.

Web UI update orchestration, first-install bootstrap, runtime reconciliation
and Hermes Agent upgrades remain separate. The default device update strategy
is `source-deploy`, and Web UI updates do not upgrade Hermes Agent by default.
Preserve the source archive allowlist, installer fingerprint, executable script
modes, atomic one-generation rollback, identity stamping and policy precedence.

## Commit And PR Rules

- Branch from `main` for new work.
- Use short, descriptive branch names such as `codex/fix-login-token` or `feat/group-chat-copy`.
- Commit only files that belong to the change.
- Use concise commit messages that describe the change, for example `fix login token storage` or `add group chat clone naming`.
- Keep commits focused. Do not bundle unrelated cleanup with feature work unless the cleanup is required.
- Push the branch and open a PR against `main` unless the issue explicitly targets another base.
- Prefer draft PRs while validation is still running or when the change needs review before merge.
- Mark a PR ready only after the relevant tests and build pass.
- Keep PR titles concrete and scoped, for example `[codex] make Web UI state directory configurable`.
- Link issues in the PR body with `Closes #123`, `Fixes #123`, or `Refs #123` as appropriate.
- PR descriptions should include:
  - what changed
  - why it changed
  - user or developer impact
  - validation commands run
  - known limitations or follow-up work, if any
- Do not overwrite or revert unrelated user changes.

Use this PR body shape by default:

```md
## Summary
- ...
- ...

Closes #123

## Validation
- `npm run harness:check`
- `npm run build`
- Focused tests for each new feature, including E2E for new browser journeys
```

## Task Outputs

Keep one-off reports, temporary scripts and test evidence outside every checkout.
Use `npm run --silent artifacts:new -- <task>` for an owned external directory.
`npm run artifacts:check` and the existing harness reject known report/scratch
paths, including ignored files. See `docs/harness/task-artifacts.md` for supported
test output locations, protected runtime/dependency areas, cleanup and limits.
