# Validation Guide

Run the smallest relevant checks while iterating. Escalate to the broad checks
when touching shared behavior, release automation, auth, persistence, or chat.

## Always Run For PRs

```bash
npm run harness:check
```

For broad or shared changes, also run:

```bash
npm run test:coverage
npm run test:e2e
npm run build
```

## Change-Type Matrix

| Change | Minimum local validation |
| --- | --- |
| Docs only | `npm run harness:check` |
| Client component/store/API | focused `npm run test -- <pattern>`, then `npm run build` |
| User-visible browser flow | focused Vitest plus `npm run test:e2e` |
| Server controller/service/db | focused `npm run test -- tests/server/<file>` |
| Server module move or dependency change | focused server boundary tests, then `npm run harness:check` |
| Auth, profile, or credential behavior | focused server tests plus relevant e2e auth tests |
| Chat, Socket.IO, group chat | focused server tests plus relevant e2e chat tests |
| Chat session chain, Agent Bridge, compression, or Group Chat | `npm run harness:check` plus focused chat/bridge/group-chat tests |
| Desktop packaging | `npm run harness:check`, `npm run build`, and a platform-specific desktop build when practical |
| GitHub workflow | `npm run harness:check` and `actionlint` when available |
| Package manifests | `npm ci --ignore-scripts` and lockfile workflow expectations |
| JEV consumers/settings | `npm run harness:check`, `tests/server/jev-harness.test.ts`, focused feature tests and JEV settings e2e |

## JEV integration controls

Follow [the JEV integration contract](jev-integrations.md) for every new consumer
or setting. Each feature needs a registered integration point, its own switch with
an explicitly registered Studio default, and frontend controls for user-adjustable
options. `harness:check` detects
unregistered consumers and missing configuration wiring; feature tests must prove
that disabling the switch prevents upstream requests and preserves the old flow.

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

- Build workflow: installs dependencies, runs coverage, and builds production
  assets on pushes and pull requests.
- Playwright workflow: runs browser e2e tests.
- NPM lockfile workflow: verifies `package-lock.json` is synchronized.
- Desktop release and manual desktop build workflows build and upload
  platform-specific desktop artifacts.
- Docker workflow: builds and publishes release images.

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
| Windows | `*.exe`, `*.exe.blockmap`, `latest*.yml` |
| Linux x64 | `*.AppImage`, `*.deb`, `latest*.yml` |
| Linux arm64 | `*.AppImage`, `latest*.yml` |

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

Web/ACP adapter upgrades additionally require the opt-in `dsh-web-real.test.ts`
against each supported installed DSH version, including new/resumed presets,
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

For settings changes, run `DSH_WEB_COMMAND=/absolute/path/to/dsh npx vitest run
tests/server/dsh-settings-real.test.ts`. Optionally set `DSH_MODLENS_PACKAGE` to
an installed ModLens package directory. This opens the real native slot in
Chromium through the production HTTP/WebSocket transport, verifies native form
saving and ModLens engine-dependent fields, and only mutates fixture homes.
Browser coverage in `tests/e2e/dsh-plugins.spec.ts` verifies the two Studio tabs,
native frame preservation, names/descriptions and native package removal.

For packaging changes run the Web build and `npm --prefix packages/desktop run
build`. The slot browser code must also be exercised from a minified server
bundle; runtime serialization must not capture build-generated helper closures.

The DSH Agent presets page is a Studio Vue component, separate from the native
plugin configuration iframe. Preset operations stay in `services/dsh/agent-presets.ts`
and use the existing management host. Run `dsh-agent-presets.test.ts`, the DSH route
and Web profile tests, `dsh-settings-real.test.ts` with the installed CLI, and
`tests/e2e/dsh-plugins.spec.ts` for changes. The real test covers native RPC, source
directory persistence, default updates, restart retention and read-only shipped
presets as well as plugin UI startup (including native directory-picker dependencies).

For DSH chat, group-member and workflow modes, keep the selector and roster API in the DSH client module,
and validation/ACP metadata in `services/dsh`. Shared chat code may carry and store
only the generic preset identifier. Run `dsh-session-presets.spec.ts`, the DSH
preset/runner tests and the real Web-to-ACP test on both supported releases. The
real test must select a non-default preset, contrast a second session’s tools,
and retain the original selection after resume and a default change.

For shared Coding Agent skill permissions, run `skills-controller.test.ts`,
`shared-skills-access.test.ts`, `skills-view.test.ts`, `skill-list.test.ts` and
`shared-coding-agent-skills.spec.ts`. Verify shared directory and file aliases
remain read-only, rejected deletion cannot fall back to Hermes, and DSH-private
skills stay writable. Register native skill formats from bootstrap; agent modules
must not import another agent’s implementation.
