# Upstream Merge Rules

The product keeps its Quanthermes identity while following the module architecture
of `EKKOLearnAI/ekko-studio`. The November 2026 architecture migration supersedes
the September 2026 cherry-pick-only policy. It adopts upstream's module tree and
ports the local capability slices into that tree. Future syncs merge onto this
integrated baseline; do not resurrect the legacy server source directories.

## Capabilities to preserve

- USB monitor, safe file access and workspace import (`hermes_data/bots/usb`).
- LAN discovery, signed pairing, peer terminals and file transfer.
- XiaoZhi provisioning, camera and voice integrations.
- Meetings, ASR/diarization, recording storage and bundled analysis skills.
- Knowledge vaults, SQLite/FTS/vector indexing, scanning and grading.
- Managed browser broker and the upstream Desktop browser integration.
- Optional built-in client capabilities, plus upstream plugin/skill markets.
- Independent device, desktop and npm update/distribution channels.

Expert Center and Experts Marketplace were explicitly removed during the
migration. Do not restore their routes, stores, services or installation tables.
Existing user data does not need a destructive cleanup migration.

## Ownership and contracts

All server TypeScript belongs to `modules/{studio,hermes,ekko,coding-agents}` or
`bootstrap`. Preserve upstream boundaries and use Studio public ports injected
from bootstrap for concrete agent behavior. Routes delegate to controllers;
controllers delegate state access and side effects to services.

Canonical Studio HTTP APIs use `/api/studio/*`. Auth recovery endpoints require
a separately configured `HERMES_WEB_UI_RECOVERY_PASSWORD`. Released App/device aliases stay
centralized in `modules/studio/middleware/legacy-app-api.ts`. Meeting WebSocket
paths and signed LAN peer wire paths remain compatible with deployed clients.
Stateful services resolve paths through `getWebUiHome()`, including its alias
`HERMES_WEBUI_STATE_DIR`; Hermes profile state remains separate.

Keep `@quanthermes/hermes-web-ui`, desktop appId/productName, Quanthermes default
credentials and independent OSS endpoints. Review branding values by owner;
upstream protocol identifiers and internal package names can remain unchanged.
Version manifests and the current changelog must agree.

## Update and release invariants

See `source-deploy-refactor.md` and `AGENTS.md`. Preserve:

- `source-deploy` as the default; `device-package` remains opt-in.
- Matching manifest/device package types and required source URL/SHA fields.
- `scripts/update-orchestrator.sh` as the source-deploy installer entrypoint.
- Installer fingerprints, executable modes, complete source/package allowlists.
- One-generation rename rollback, disk safety margin, identity and policy rules.
- Candidate publication followed by manual promotion after at least 24 hours.
- Web UI orchestration separate from host bootstrap and Agent upgrades.
- Release tags on `org`, after checking its URL, never a code mirror.

When moving modules, update Python assets, source archive paths, scripts, tests
and build resources together. Retain maintained safety/history documents, and
keep new temporary evidence outside checkouts.

## Verification

Run `npm run harness:check`, `npm run test:coverage`, `npm run test:e2e`,
`npm run build` and `npm run build:verify` for a broad architecture sync.
Run focused update/release tests and `npm run build:device-package` whenever
release allowlists or installer scripts change. Verify produced manifests and
archive modes before any publication. Do not tag or publish as a side effect
of a local integration task.
