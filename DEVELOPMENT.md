# Development Guidelines

This document defines project-level development rules for Ekko Studio. It is tool-agnostic and applies to all contributors and coding agents.

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
- `npm run test:coverage` is what the Build workflow runs before `npm run build`.
- `npm run test:e2e` runs Playwright browser tests against a mocked BFF API.
- `npm run build` type-checks and builds both client and server.

## Architecture

- Frontend code lives under `packages/client/src`.
- Server code lives under `packages/server/src`.
- Hermes-specific client code stays under `hermes` namespaces: API modules, views, stores, and components.
- Server routes should stay thin. Put request handling in controllers and reusable behavior in services.
- The chat runtime is Socket.IO based and lives under `packages/server/src/services/hermes/run-chat`.
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

## Server Rules

- Register local API routes before proxy catch-all routes.
- Keep auth behavior centralized in `packages/server/src/services/auth.ts`.
- Use `config.appHome` for Web UI state paths.
- Keep Hermes home paths separate from Web UI home paths.
- Use `getActiveProfileDir()` or related profile helpers for Hermes profile files.
- Avoid shell string construction for CLI calls; prefer `execFile`/`spawn` with argument arrays.

## Testing Rules

- Add focused Vitest coverage for server and store logic changes.
- Add Playwright coverage for browser-visible flows and routing/auth regressions.
- For frontend browser tests, prefer API/socket mocks over real external services.
- Before opening a PR, run the smallest relevant tests plus `npm run build`.
- For broad changes, run:

```bash
npm run test:coverage
npm run test:e2e
npm run build
```

## npm Publishing

`.github/workflows/npm-publish.yml` publishes `hermes-web-ui` when a GitHub
Release is published. It can also be run manually with an existing release tag.
The tag must match `package.json`'s version (with an optional `v` prefix).
Stable releases use npm's `latest` dist-tag; prerelease versions or GitHub
prereleases use `next`.

Configure the repository Actions secret `NPM_TOKEN` with npm publish permission
and non-interactive publishing enabled. The workflow builds and checks the
packed CLI, client, and server files before publishing the tarball. The token is
available only to the publish step. A version already published to npm cannot
be overwritten; use a new version for changed packages.

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
- `npm run test:coverage`
- `npm run build`
```
