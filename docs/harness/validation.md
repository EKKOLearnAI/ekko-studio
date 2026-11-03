# Validation Guide

The legacy automated tests and fixtures have been removed. Every new feature
must include small, focused tests; run the relevant files locally. See
`tests/README.md`.
Do not restore full coverage, browser sweeps or cross-platform test matrices as a
routine PR requirement.

## Always Run For PRs

```bash
npm run harness:check
npm run build
```

For a new feature, add and run focused Vitest tests for that behavior. New browser
journeys must also have focused Playwright tests, run locally before the PR.
The generic test commands allow an empty suite during the reset; existing
assertions still fail. This does not exempt new features from adding tests.

## Keep new tests small

- Cover behavior with local fixtures, mocked external APIs/sockets and temporary state.
- Keep setup local to the feature; avoid loading complete business runtimes for
  simple cases and duplicating source-level architecture checks.
- Avoid exact source-string/CSS assertions and exhaustive OS/theme/viewport products.
- Test and E2E CI automatically run all current Vitest and Playwright tests;
  adding new feature tests does not require editing either workflow.
- For workflow changes, run `actionlint` when available. For dependency changes,
  run `npm ci --ignore-scripts` and keep the lockfile synchronized.

## Managed MCP launch environment

Every MCP definition injected by Studio (Hermes, Ekko, or Coding Agent) must
include `ELECTRON_RUN_AS_NODE: '1'` in that MCP subprocess's `env`. Independent
Node ignores the flag; the Electron executable fallback requires it to execute
the MCP script instead of opening another desktop instance. External Gateway
processes may not inherit the desktop server's environment.

`npm run harness:check` inspects all three configuration factories. New managed
MCP injection paths must be added to that check. Keep configuration comparison
and migration aware of the flag so previously injected entries are repaired;
do not overwrite user-owned MCP definitions or globally enable Node mode for
the desktop app. Validate changes with the MCP injection and launch tests.

Long-running external Gateways may keep older MCP definitions in memory. The
packaged entrypoint must route the exact bundled MCP script invocation before
loading GUI or updater code, even when Node mode is absent. Test the real package:

```bash
node scripts/verify-desktop-mcp.mjs '<packaged executable>' '<resources directory>'
```

This checks all five toolsets with Node mode deliberately removed, validates the
JSON-RPC initialize response, and checks clean exit on stdin EOF. It uses temporary
state and does not require a running Gateway.

## CI Mapping

- Build (`build.yml`) runs `npm run harness:check` and the production build.
- Test (`test.yml`) runs `npm test` and reports its own Test check.
- E2E (`playwright.yml`) runs `npm run test:e2e` and reports its own E2E check.
  Chromium is installed only when browser test files are present. HTML reports,
  screenshots and traces are uploaded as available, including on test failure.
- All three workflows run independently on pushes to `main` and pull requests
  targeting `main` or `base`. Test and E2E also support manual dispatch. Any test
  failure fails its own check. Coverage is not required.
- The old Playwright shards and coding-agent, P2P and desktop-isolation test
  matrices remain removed.
- The NPM lockfile workflow still verifies dependency lockfile synchronization.
- Desktop/runtime/release workflows retain packaging, signing, artifact and
  isolated update-feed verification, without calls into the removed test suites.
- Docker publishing remains unchanged.

## Desktop startup failure evidence

On macOS, Desktop starts the Web UI in Node mode using the bundle's generic
Electron Helper (`LSUIElement=true`). Native Computer Use focus protection can
register the backend with AppKit; using the GUI executable creates a second Dock
icon that never finishes launching. Keep focus protection enabled and preserve
the existing executable on Windows, Linux, and plain Node hosts. Do not silently
fall back to the GUI executable if the Helper is missing. Startup diagnostics
record the selected executable.

Before release, verify real Helper IPC, SQLite, nested Node execution, and
Computer Use input, permissions, focus preservation and Dock registration, plus
backend restart, PTY, local STT and managed MCP launches from an isolated state
directory. Mocked tests do not establish OS permission or input compatibility.

The macOS Computer Use permission guide reads Electron's host-app permissions via
trusted local-window IPC. Reads must use `isTrustedAccessibilityClient(false)` and
`getMediaAccessStatus('screen')`; only the user's Authorize action may request a
grant or open a fixed System Settings pane. Remote-server pages must not query or
change local permissions. Verify missing/granted/restricted/error states, returning from Settings,
light/dark and wallpaper themes, and narrow windows. On a disposable macOS install,
also verify first-time grants and any system-requested restart; never reset a user's
TCC database to simulate a fresh install.

The chat reminder uses only live tool-start events from the active Ekko session,
never replayed history. Its native claim must stay atomic across all windows and
renderer reloads, with one reminder per desktop launch. Verify both new runs and reattached live runs,
standalone chat windows, dismissal, settings navigation, and silence in other
agents/platforms/remote mode. No reminder check may request an OS grant.

`Web UI server exited before becoming ready code=1 signal=null` reports a
failed backend process, without identifying its cause. Desktop captures the
last stdout/stderr separately, waits for the child pipes to close, and includes
that output in the startup error. Failed attempts are also recorded under
`HERMES_WEB_UI_HOME/logs/desktop-startup.log`, including Desktop/Electron/Node
versions and the actual Web UI entry path. Log history is bounded and retains
both active and bundled Web UI failures. `logs/server.log` can be missing or
stale if module loading fails before the backend logger is initialized.

On Windows the default data home is `%USERPROFILE%\.hermes-web-ui`. Reinstalling
the app preserves this home, including its database and downloaded runtime
selection. Collect the failed app version, startup log, and recent server log
before changing state. Do not delete the database or Hermes profiles to diagnose
a startup crash.

To distinguish retained Web UI state from an installation/environment problem,
fully quit Studio, then launch its installed executable from PowerShell with
`HERMES_WEB_UI_HOME` set to a new temporary directory. A successful launch with
that directory points to state/cache/migration behavior; a failure still needs
the child-process exception to distinguish missing modules, native DLL loading,
permissions, and port conflicts. This check preserves the original data and is
not a complete reset of Electron userData, Hermes profiles, or system environment.

Build the desktop main process with `npm --prefix packages/desktop run build:main`
and inspect startup diagnostics from an isolated state directory.

## Release Workflow Guardrail

Published GitHub Releases should still trigger Web UI artifact packaging and
Docker image publishing, but those workflows must keep the GitHub Release out
of latest.

Full desktop packaging is manually dispatched through
`.github/workflows/desktop-release.yml`; published GitHub Releases must not
automatically start desktop packaging. After a full desktop release finishes,
the workflow must mark the target GitHub Release as latest.

Desktop release jobs must upload only the artifacts that their matrix target can
produce. Keep artifact globs in matrix data and keep `fail_on_unmatched_files:
true` so missing expected files still fail.

Expected desktop release outputs:

| Target | Required release globs |
| --- | --- |
| macOS | `*.dmg`, `*.dmg.blockmap`, `*.zip`, `*.zip.blockmap`, `latest*.yml` |
| Windows x64 | `*-x64.exe`, `*-x64.exe.blockmap`, `latest.yml` |
| Windows ARM64 | `*-arm64.exe`, `*-arm64.exe.blockmap`, `latest-arm64.yml` |
| Linux x64 | `*.AppImage`, `*.deb`, `latest*.yml` |
| Linux arm64 | `*.AppImage`, `latest*.yml` |

### Desktop updater changes

For Windows ARM64 packaging changes, build `win32` / `arm64` through the manual
workflow without a release tag. Follow
[Windows ARM64 acceptance](../../packages/desktop/WINDOWS-ARM64.md) before
publishing; the installer and its first-launch Hermes runtime ship separately.

The legacy `test:updater` suite has been removed from desktop packaging workflows.
Build the desktop main process and validate actual update artifacts and manual
upgrade behavior for the affected platform.

The updater's request-cancellation adapter accesses the upstream HTTP executor
because its cancellation token alone does not abort a full-download request.
Verify cancellation when upgrading `electron-updater`. macOS must wait
for Electron's native `update-downloaded` event before stopping local services;
the `electron-updater` event only indicates that the ZIP can be served to Squirrel.

Before release, also exercise a signed old-to-new macOS upgrade and an installed
Windows NSIS and Linux AppImage upgrade (download, stop/retry, Later/quit, restart, and installer
failure) on disposable installations. Local tests do not verify actual signing,
OS permissions, installer replacement, or relaunch into the new version.

Use the [isolated desktop update test workflow](../../packages/desktop/UPDATE-TESTING.md)
to produce A/B packages without publishing a production GitHub Release. The test
workflow's built-in token has read-only repository permissions, forces the builder's
`--publish never`, and requires macOS signing and notarization. It retains verified
Actions artifacts and uses a dedicated secret to upload to fixed per-target
prereleases in the public test repository. A test
feed failure or invalid packaged test configuration must never fall back to a
production feed; keep integration coverage for that invariant.

## Failure Handling

When a command fails:

1. Read the first actionable error, not just the final stack trace.
2. Check whether the failure indicates missing context, missing test coverage,
   or a missing mechanical rule.
3. Fix the product bug when there is one.
4. Update docs or `scripts/harness-check.mjs` when the same class of mistake
   should be prevented next time.

## DSH module boundary

DSH source discovery, Web composition, plugin commands, permission policy, ACP
lifecycle and protocol translation belong in
`packages/server/src/modules/coding-agents/services/dsh/`. Shared registry and
runtime files may pass configuration and generic callbacks, but must not own
DSH Web patches, permission defaults or ACP construction. DSH modules receive
platform helpers rather than importing the shared agent registry.
`npm run harness:check` runs `scripts/dsh-module-harness.mjs` to enforce this.

For Web/ACP adapter upgrades, verify supported installed DSH versions, including new/resumed presets,
scoped/global model routing, Web bundle tool execution, child inheritance and
unrestricted filesystem/shell access. Do not reject an otherwise compatible
installation by version number or whole-file hash. Validate the required adapter integration points and dependencies before
writing the private copy, and report the specific missing/ambiguous capability.
Keep the source hash as diagnostic metadata. Test an unlisted version with an
unrelated artifact change as well as incompatible integration points.

DSH plugin management has two client tabs under `components/coding-agents/dsh`
and one DSH API module under `api/coding-agents/dsh.ts`. Shared views may render
the entry component; they must not implement DSH transport or plugin forms.
The harness rejects obsolete `managedPluginPatches` / `getDshPluginStore` runtime
references. Keep native profile operations, the owned settings host and plugin
adapters in server `services/dsh`.

For new settings features, add focused tests for the new behavior and inspect the
real native slot through the production HTTP/WebSocket transport from isolated
state. Verify form saving, engine-dependent fields, tab navigation and native
package removal as applicable.

For packaging changes run the Web build and `npm --prefix packages/desktop run
build`. The slot browser code must also be exercised from a minified server
bundle; runtime serialization must not capture build-generated helper closures.

The DSH Agent presets page is a Studio Vue component, separate from the native
plugin configuration iframe. Preset operations stay in `services/dsh/agent-presets.ts`
and use the existing management host. For new preset features, verify native RPC,
source directory persistence, default updates, restart retention, read-only
shipped presets and plugin UI startup with isolated state.

For DSH chat, group-member and workflow modes, keep the selector and roster API
in the DSH client module, and validation/ACP metadata in `services/dsh`. Shared
chat code may carry and store only the generic preset identifier. For new preset
behavior, add focused tests and verify a non-default preset, session tool
isolation, resume and default changes.

For new shared Coding Agent skill permissions, add focused tests for read-only
shared aliases, rejected deletion without Hermes fallback and writable DSH-private
skills. Register native skill formats from bootstrap; agent modules must not
import another agent's implementation.
