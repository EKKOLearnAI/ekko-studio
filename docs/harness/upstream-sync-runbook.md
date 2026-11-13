# Upstream Sync Runbook

Merge `EKKOLearnAI/ekko-studio` into a fresh `codex/` integration branch based on
local `main`. Read `upstream-merge-rules.md` before resolving conflicts.

## Preparation

1. Inspect `git status`, remotes, worktrees and the current main commit.
2. Preserve unrelated changes; use another worktree if the checkout is dirty.
3. Fetch the upstream main ref without publishing or fetching release tags.
4. Record the exact upstream SHA and create a local recovery branch.
5. Inspect changed ownership, schemas, routes, release contracts and local slices.

## Integration

Use the current integrated module tree as the baseline and resolve a real Git
merge on the integration branch. The first November 2026 migration used the
upstream tree as the architectural base and then restored local vertical slices;
that one-time reconstruction is not a shortcut for future merges.

Do not restore the legacy top-level `services`, `controllers`, `routes`, `db` or
`config.ts` source trees. Preserve local behavior inside the appropriate owner
module, with concrete module composition only in `bootstrap`.

Expert Center and Experts Marketplace are intentionally removed. Preserve USB,
LAN peers, XiaoZhi, meetings, knowledge/scanning/grading, managed browser support,
the optional local client registry and independent update channels. Keep the
upstream skill and plugin markets.

Review locale merges manually. Align package versions, branded distribution
identity, installer/source paths, Python resources and executable script modes.
Do not overwrite user state or trigger an Agent upgrade.

## Validation and completion

Run `npm run harness:check`, `npm run test:coverage`, `npm run test:e2e`,
`npm run build`, `npm run build:verify` and focused release/device-package checks.
Use isolated temporary Web UI state for runtime checks. Review the diff and
record the checked upstream SHA and meaningful limitations in maintained docs.

Commit the merge only after validation. Fast-forward local `main` to the reviewed
integration result when the user requested a local merge. Remote pushes and
release publication require their own task scope; release tags belong on `org`.
Keep the recovery branch until the integrated build is confirmed.
