# Architecture

Ekko Studio is a TypeScript monorepo that ships a local-first AI workspace
through a web console, a Koa backend, and an Electron desktop app. It integrates
Ekko Agent, Hermes Agent, and coding agents for chat, coding, and workflows.

## Package Boundaries

| Area | Path | Responsibility |
| --- | --- | --- |
| Client | `packages/client/src` | Vue UI, routing, Pinia stores, API wrappers, i18n, browser-visible state. |
| Server | `packages/server/src` | HTTP API, auth, Socket.IO, SQLite stores, file access, Hermes runtime integration. |
| Ekko Agent | `packages/ekko-agent` | Canonical Ekko runtime, profile facade, providers, tools, memory, skills, conversations, and package API. |
| Desktop | `packages/desktop` | Electron shell, local Web UI server bootstrap, updater, bundled Python/Hermes runtime. |
| MCU | `packages/mcu` | ESP32-C3 source projects and release firmware; board-specific ESP32-S3 firmware. |
| Tests | `tests` | Vitest unit/integration tests and Playwright browser tests. |
| CI | `.github/workflows` | Build, e2e, lockfile, Docker, and desktop release automation. |

## Request Flow

1. The browser loads the Vite-built client from the Koa server.
2. Client modules call API helpers from `packages/client/src/api`.
3. Server routes in `packages/server/src/modules/*/routes` wire HTTP paths to controllers.
4. Controllers validate request concerns and delegate reusable behavior to services.
5. Services own side effects: files, SQLite, Hermes profiles, subprocesses, bridges, and credentials.
6. Long-running chat and group-chat flows use Socket.IO namespaces managed by server services.

Keep each layer narrow. Routes should not grow business logic, and client code
should not duplicate server persistence rules.

## State And Data Ownership

- Web UI state defaults to `~/.hermes-web-ui` through `config.appHome`.
- `HERMES_WEB_UI_HOME` and `HERMES_WEBUI_STATE_DIR` override Web UI state location.
- Hermes Agent state lives under Hermes profile directories and must stay distinct from Web UI state.
- Uploads default to `config.uploadDir`, which is derived from the Web UI home unless `UPLOAD_DIR` is set.
- Runtime data directories must also live under the Web UI home, not beside built `dist` assets.
- Profile-scoped Hermes data should use existing profile helpers instead of manually joining paths.

## Server Structure

Server code is separated by business ownership under `modules/studio`,
`modules/hermes`, `modules/ekko`, and `modules/coding-agents`; concrete module
composition belongs in `bootstrap`.
See `docs/harness/server-module-boundaries.md` for the complete target tree,
ownership decisions, allowed dependency matrix, and migration rules.

- Module `routes/` register HTTP entry points; `sockets/` own Socket.IO transports.
- Module `controllers/` handle request-level behavior.
- Module `services/` own reusable IO, domain behavior, processes, and integrations.
- Studio `repositories/` and `infrastructure/` own application persistence.
- Studio `middleware/legacy-app-api.ts` is the only released App and MCU firmware URL compatibility map.

Architecture rules:

- Register local API routes before proxy catch-all routes.
- Keep auth behavior under `packages/server/src/modules/studio/services/auth`.
- Prefer `execFile` or `spawn` with argument arrays over shell command strings.
- Use structured file and YAML/JSON parsers when editing structured data.

## Client Structure

- `views/` contains route-level screens.
- `components/` contains reusable UI.
- `stores/` contains Pinia state.
- `api/` contains HTTP clients and should use `packages/client/src/api/client.ts`.
- `i18n/` contains locale messages for user-facing strings.
- `styles/` contains global styling and theme primitives.

Frontend rules:

- Use Vue 3 Composition API with `<script setup lang="ts">`.
- Use existing Naive UI patterns before adding new UI conventions.
- Add visible text to all locale files.
- Keep component styles scoped unless the style is intentionally global.

## Desktop Release Flow

Desktop packaging is intentionally split:

- Pull requests run the web UI build and tests in `.github/workflows/build.yml`.
- Published GitHub Releases run Web UI artifact packaging and Docker image publishing without
  marking the release as GitHub latest.
- Manual dispatches run full desktop artifact packaging in `.github/workflows/desktop-release.yml`.
- `.github/workflows/desktop-manual-build.yml` builds one desktop target for targeted repairs or re-runs.
- Windows x64 and ARM64 use native runners and separate updater manifests
  (`latest.yml` and `latest-arm64.yml`). See `packages/desktop/WINDOWS-ARM64.md`
  for native speech staging and runtime acceptance.
- Each release matrix target uploads only the artifact globs for its own platform.
- A successful full desktop release marks the target GitHub Release as latest after all desktop artifacts
  and the merged macOS updater manifest have been uploaded.

Do not make a Windows job require macOS `.dmg` files or a Linux job require
Windows installers. Keep `fail_on_unmatched_files: true` where platform-specific
artifact lists make the expectation explicit.

### Desktop Hermes Runtime

Hermes runtime assets are built separately by
`.github/workflows/desktop-runtime.yml`. `packages/desktop/scripts/runtime-config.mjs`
pins an upstream Hermes version, Git ref, and full commit; version overrides
must supply the ref and commit together.

For releases that declare placeholder package metadata (`0.0.0`), the runtime
requires the matching `v<version>` source tag and uses upstream's install-stamp
writer without changing tracked files. Installation and relocation checks read
the canonical Hermes identity. Manual dispatches can override `python_version`
and `python_build_tag` together; Hermes 0.22.2 uses Python 3.14.7 from the
python-build-standalone `20260901` release.

The portable Node.js included in runtime assets is pinned independently from
the GitHub Actions runner. Manual runtime dispatches take a target release tag;
when the release does not exist, the upload step creates it with the workflow's
`GITHUB_TOKEN`. Do not pre-publish runtime-only releases with a user token,
because that emits `release.published` and starts the normal Web UI and Docker
release workflows.

The published runtime keeps this updateable layout:

```text
python/                 Hermes Agent Git checkout and source root
  .git/
  base/                 Windows python-build-standalone base runtime
  venv/                 bundled Python environment
    Scripts/python.exe  Windows PEP 405 venv interpreter
  agent-browser/
  node/                  browser CLI npm prefix
  ms-playwright/
node/                    bundled Node.js
git/                     bundled MinGit on Windows
runtime-manifest.json
```

`prepare:runtime` fetches the exact source commit and installs its locked
dependencies into `python/venv`. On Windows, the standalone base interpreter is
embedded at `python/base` and a sibling PEP 405 venv wraps it. Windows requires
an absolute `pyvenv.cfg` home, so the build, package validation, extraction, and
runtime migration paths rebase that value before launching Python. This lets
upstream `hermes update` safely target the environment through `VIRTUAL_ENV`.
The build also creates the upstream TUI/dashboard and verifies that the retained
checkout is clean. `package:runtime` includes the source and Git metadata in the
GitHub/CF archive and records them in schema 2 of the runtime manifest. Do not
patch tracked Hermes source during this build:
Studio-specific integration belongs in Studio, and the clean checkout is what
allows users to run the upstream `hermes update` command directly.

## Validation Surface

The minimum mechanical harness is:

- `npm run harness:check` for repository docs, workflow, and package-script invariants.
- `npm run test` or focused Vitest tests for local logic.
- `npm run test:e2e` for browser-visible routing/auth/chat regressions.
- `npm run build` for type checking and production bundles.

See `docs/harness/validation.md` for change-specific commands.
