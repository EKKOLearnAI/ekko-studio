# Agent Map

This file is a short map for coding agents. Keep detailed guidance in `docs/`
and keep this file small enough to fit into every task context.

## First Reads

- `DEVELOPMENT.md` - project commands, coding rules, test rules, and PR shape.
- `ARCHITECTURE.md` - package boundaries, data ownership, and runtime flow.
- `docs/harness/README.md` - how this repository is prepared for agent work.
- `docs/harness/validation.md` - which checks to run for each change type.
- `docs/harness/upstream-sync-runbook.md` - how to sync `upstream/main` into local `main` safely.
- `docs/harness/worktree-runbook.md` - isolated local dev and test setup.
- `docs/harness/pr-review.md` - self-review checklist before pushing.

- `docs/harness/server-module-boundaries.md` - module ownership and allowed dependencies.
- `docs/harness/frontend-ui.md` - semantic theme surfaces and narrow preview exceptions.
- `docs/harness/task-artifacts.md` - keep temporary evidence outside all checkouts.

## Common Commands

```bash
npm ci --ignore-scripts
npm run harness:check
npm run test
npm run test:e2e
npm run build
```

Use the smallest relevant check while iterating. Before a broad PR, run
`npm run harness:check`, `npm run test:coverage`, `npm run test:e2e`, and
`npm run build`.

## Code Ownership Map

- `packages/client/src` - Vue 3 client, stores, routes, i18n, API helpers.
- `packages/server/src` - Koa API, Socket.IO, persistence, Hermes integration.
- `packages/desktop` - Electron wrapper, bundled Python/Hermes runtime, release artifacts.
- `tests/client`, `tests/server`, `tests/shared` - Vitest coverage.
- `tests/e2e` - Playwright browser coverage with mocked backend services.
- `.github/workflows` - CI, release, Docker, and desktop packaging automation.

## Hard Rules

- Put server code under `modules/{studio,hermes,ekko,coding-agents}` and compose modules only in `bootstrap`; Studio must use injected agent ports.
- Expert Center and Experts Marketplace have been removed; preserve plugin and skill markets.
- Keep routes thin: put request handling in controllers and reusable behavior in services.
- Keep Web UI state under `HERMES_WEB_UI_HOME` or `HERMES_WEBUI_STATE_DIR`.
- Keep Hermes Agent state separate from Web UI state.
- Keep in-app updates orchestration-only unless a release plan explicitly enables a wider scope.
- Do not make Hermes Agent upgrades the default side effect of Web UI updates.
- Treat bootstrap, runtime reconcile, Web UI update, and Hermes Agent upgrade as separate seams.
- **Modifying a script in `.github/device-package-release.json#packageAllowlist`** (e.g. `scripts/install-device-package.sh`, `scripts/hermes-web-ui-update-runner.sh`, `scripts/deploy-source-armbian.sh`) means devices will compare their on-disk install script against the manifest's `installerScriptSha256` on the next update. After such a change, verify `npm run build:device-package` re-emits a manifest whose `installerScriptPath` and `installerScriptSha256` are present, and ensure the change ships in the next device-package release (0.7.x tag). Without that, devices will refuse the update with `update_installer_script_stale` until the next release that includes the fix.
- **Tags and release packaging live on `org`, never on `origin`**: `origin` (Therainclouds/hermes-web-ui) is a code mirror only — it hosts no release tags, no GitHub Releases, and its `device-package-release.yml` run would fail (no OSS secrets). `org` (tangledup-ai/hermes-web-ui) is the release home: publish tags with `git push org <tag>` — never `git push origin <tag>`. The device-package-release two-stage flow (candidate → promote) is driven by tag pushes on `org`. If a tag was pushed to the wrong remote, delete it there (`git push <remote> :refs/tags/<tag>`) before re-pushing to `org`; force-updating an existing `org` tag (`git push org <tag> --force`) is the normal correction *before* promotion — after promotion it requires rolling `releases/<channel>/latest.json` back instead.
- Register local API routes before proxy catch-all routes.
- Use structured APIs and argument arrays instead of shell string construction.
- Add user-facing strings to every locale file.
- Do not mix unrelated refactors into a bug fix.
- **Building/CSP/Storage/Process**: see [meeting-asr-safety-audit.md](./docs/harness/meeting-asr-safety-audit.md) for hard rules derived from the v0.7.7 speaker-diarization incident.
- **Device update strategy**: `WEBUI_UPDATE_STRATEGY` and `WEBUI_UPDATE_PACKAGE_TYPE` default to `source-deploy`. New device installations, must not change this default — `device-package` is opt-in only. The default is set in `scripts/deploy-source-armbian.sh` (function-level `WEBUI_UPDATE_STRATEGY="${...:-source-deploy}"`) and the build manifest is generated with matching `packageType` by `scripts/build-device-package.mjs`.
- **Manifest `packageType` ↔ device `WEBUI_UPDATE_PACKAGE_TYPE` must match**: the manifest's `packageType` field, validated by `packages/server/src/modules/studio/services/update/manifest-client.ts` (one of the two `update_manifest_invalid` throw sites), must equal the device's `WEBUI_UPDATE_PACKAGE_TYPE`. Mismatch makes the device log `[update] source-deploy manifest lookup failed, falling back to npm registry` and silently fall through to a different update path — leaving stale `staging/` files and triggering `409 update_in_progress` on subsequent updates. The CI guard test `tests/release/device-package-manifest.test.ts` enforces this contract.
- **Source-deploy manifest requires sourceUrl/sourceSha256**: when `packageType=source-deploy`, `manifest.sourceUrl` and `manifest.sourceSha256` must be present (devices download from `sourceUrl` and verify against `sourceSha256`). When `packageType=device-package`, `manifest.installerScriptSha256` must be present (devices compare on-disk script against this SHA on every update). These are emitted by `scripts/build-device-package.mjs` based on the `packageType` config; `scripts/update-source-deploy.sh` must be in `.github/device-package-release.json#packageAllowlist` for the source-deploy installer SHA to be captured.
- **Deployed scripts must carry `+x` (git index, tarball, and device all agree)**: every `.sh` and `.py`-with-shebang under `scripts/` must be tracked as `100755` in git (`git ls-tree HEAD -- scripts/` to verify), built into a tarball with `+x` preserved, and re-applied by `fixup_script_modes` in `scripts/_lib/fixup-script-modes.sh` after any `tar | tar` pipeline. Missing `+x` is the root cause of systemd `203/EXEC` on `ExecStartPre`. Three defences are required: (1) repo-level `git update-index --chmod=+x scripts/*.sh scripts/*.py`, (2) `build-device-package.mjs`'s `assertArchiveScriptModes` post-build assertion which refuses to publish a broken tarball, (3) `deploy-source-armbian.sh`'s end-of-script self-check which iterates all scripts and exits non-zero if any is missing `+x`. Windows contributors: set `core.filemode=true` or always run `git update-index --chmod=+x` after touching scripts, otherwise git silently records `100644` and the whole chain breaks downstream. See `tests/release/device-package-executable-bits.test.ts` and `scripts/_lib/fixup-script-modes.sh`.
- **Stateful services must resolve paths through `getWebUiHome()`**: server-side services that store user data (uploads, meetings, profiles, transcripts) must read their base dir via `getWebUiHome()` from `packages/server/src/modules/studio/public/config.ts` — never via `process.env.HERMES_WEB_UI_HOME` directly, and never via `process.cwd()`. `getWebUiHome()` honours both `HERMES_WEB_UI_HOME` and `HERMES_WEBUI_STATE_DIR` (per `AGENTS.md` rule on state dirs) and falls back to `~/.hermes-web-ui`. A direct `process.env` read silently ignores one of the two vars when the other is unset, which in practice meant `MeetingStorageService` wrote audio into `cwd` instead of the real home, producing 404s on `/api/meeting-storage/:id/audio` with no log trail. See `tests/server/meeting-storage-path-resolution.test.ts`.
- **deploy-source-armbian.sh must never `chown -R` across mount points**: recursive ownership changes must go through `chown_r_mount_safe` (`scripts/deploy-source-armbian.sh`), never plain `chown -R`. The Web UI mounts user USB drives under `$HERMES_WEB_UI_HOME/mnt/usb` — exFAT/NTFS filesystems don't support ownership changes, so `chown -R` aborts the whole deploy with `Operation not permitted` mid-update (6.6.6.31 v0.8.0). `chown_r_mount_safe` prunes mount points via `find -xdev` + `mountpoint -q` and falls back to `find -exec chown` when `mountpoint(1)` is absent.
- **`sourcePathAllowlist` must cover every file the device build needs**: `npm run build` on the device runs from the unpacked source archive root, so `.github/device-package-release.json#sourcePathAllowlist` must include every root file the build touches — `docs/` (openapi:generate writes `docs/openapi.json`), `tsconfig.app.json`, `tsconfig.node.json` (vue-tsc `-b` references), `vite.config.ts` (tsconfig.node.json includes it and vite build loads it). A missing entry fails the update on-device with `ENOENT docs/openapi.json` or `TS5083: Cannot read file 'tsconfig.X.json'` after the archive already unpacked (6.6.6.31 v0.8.0). The regression test `tests/release/device-package-manifest.test.ts` asserts these entries ship in the source artifact.
- **Phase (a) update invariants** (spec: [docs/harness/source-deploy-refactor.md](./docs/harness/source-deploy-refactor.md); violation of any of these reopens the v0.7.x incident class):
  - The upgrade path must never call `deploy-source-armbian.sh` — after phase (a) it is bootstrap/first-install only. `scripts/update-orchestrator.sh` owns the upgrade lifecycle (journal → preflight → download → atomic swap → healthcheck → identity); new update logic goes there or in `scripts/_lib/`, never in the deploy script.
  - Rollback is one generation (`lastgood` via `scripts/_lib/atomic-swap.sh`), rename-based, never hardlinks (`cp -al` breaks on mount points). There is no multi-version rollback store, and disk exhaustion must refuse the update (503-class) — never degrade the safety margin.
  - `state/identity.json` is the device's record of what actually runs. `agentManifestSha` stays the opaque sentinel `"0.0.0-noop"` until phase (c); treat it as a string, never a version range. Drift repair is always "re-stamp identity from the current deploy" (`POST /api/update/identity/repair`), never "force reinstall".
  - Operator policy precedence is `updates/policy.json` > `HERMES_WEB_UI_UPDATE_PINNED_VERSION` env > default; a missing file means no override. `manifest.installerScriptPath` is `scripts/update-orchestrator.sh` for `source-deploy`; changing it invalidates every deployed device's `installerScriptSha256` pin.
  - Release promotion is two-stage: tag pushes write `candidates/<channel>/<version>.json` only; `releases/<channel>/latest.json` changes exclusively through the manual `promote` workflow (≥ 24h candidate age). Do not add an auto-promote path.
  - **Never pin `WEBUI_UPDATE_MANIFEST_URL`/`WEBUI_UPDATE_MANIFEST_URLS` to a versioned or candidate path in device env** (`releases/vX.Y.Z/manifest.json` or `candidates/<channel>/<version>.json`): a version pin always answers successfully, so every update check "succeeds" with a frozen version — freshness green, empty `remoteError`, no update button, no error anywhere. Device 6.6.6.73 froze on `candidates/stable/0.8.6.json` this way and missed every release after 0.8.1 (0.8.7 and 0.8.8 never auto-detected); the pin came from v0.8.6-era manual deploys and outlived them. A config override that always answers is indistinguishable from a healthy source, so this failure class is silent by construction. Env URL forms rank ahead of `WEBUI_UPDATE_MANIFEST_BASE_URL + channel`, so a stale pin silently overrides the correct fallback. Versioned manifests exist on **four shapes** — OSS object, GitHub Release asset, `release-manifests` branch archive, and `candidates/<channel>/<version>.json` — and a device pin may point at any one; compat mirroring must cover all four (and `raw.githubusercontent.com` serves up to ~5 min stale after a commit). v0.8.9 adds `manifest_pinned_stale` detection (channel tip wins when the pinned version ≤ local; spec: `docs/knowledge/specs/task-12-auto-vaults-and-quotas.md` § Update-source hardening). Until then: after any manual deploy, check `/api/update/identity` → `manifestCache.version` ≥ the deployed version; if not, grep `MANIFEST` in `/etc/default/hermes-web-ui` — a pinned env URL is the suspect. Deploy-side: deploys must not write versioned/candidate manifest URLs (planned guard: refuse unless `ALLOW_PINNED_MANIFEST=1`).
  - **`promote: true` workflow runs must use a fresh dispatch, never "Re-run jobs"**: re-running an old run pins the workflow definition to that run's original commit, so workflow fixes pushed to `main` afterwards do not apply (run #89 → #91 failed twice on this). Also: a step's own `if` cannot resolve env vars defined only in a sibling step's env block — the `Setup OSS util` step in the promote job must stay unconditional.
- **Local Hermes bridge: stale broker after working-dir deletion → `[Errno 2] No such file or directory`**: the bridge broker is a long-lived Python process on the fixed endpoint `ipc:///tmp/hermes-agent-bridge.sock`; a restarted Web UI server attaches to it because it still answers pings. If the broker's original working directory was deleted (deploy/re-clone), every worker spawn fails with a bare `[Errno 2]` (no filename) surfaced in chat. Fixed by `_safe_cwd()` in `bridge_transport.py` (validate cwd, fall back to the bridge script dir). Manual recovery: `lsof /tmp/hermes-agent-bridge.sock` → kill the stale pid → `rm -f /tmp/hermes-agent-bridge.sock` → restart the server. Full write-up: `packages/server/src/modules/hermes/services/bridge/README.md#troubleshooting`. Only applies to deployments that run the bridge against a **local Hermes Agent**; deployments without a local agent never hit this path.

## When The Agent Gets Stuck

Improve the harness instead of repeating the same prompt. Add missing docs,
tests, logs, scripts, or CI checks so the next agent can see and verify the
constraint directly.
