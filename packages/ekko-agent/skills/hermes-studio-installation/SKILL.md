---
name: hermes-studio-installation
description: Install, detect, validate, update, remove, recover, or migrate Ekko Studio, its managed Hermes Runtime, or the Claude Code, Codex, Pi, and Grok coding-agent CLIs. Use for installation status, version checks, Runtime downloads and storage moves, PATH problems, or upgrade failures; do not use for model, Provider, credential, MCP, memory, or Skill configuration.
metadata:
  keywords:
    - hermes studio installation
    - hermes runtime
    - claude code installation
    - codex installation
    - pi installation
    - grok installation
---

# Ekko Studio installation

Handle installation and Runtime lifecycle work for Ekko Studio and every Agent shown on its Agents page.

## Keep the boundary narrow

- Cover installation, discovery, verification, upgrades, removal, Runtime activation, and Runtime storage migration.
- Do not create or edit model, Provider, API-key, OAuth, MCP, memory, prompt, or Skill configuration as part of this workflow.
- Installation may create package-manager files and Studio-owned Runtime manifests. Treat those as installer state, not user model configuration.
- Prefer the Agents page and Version Management UI because they use the same paths, pins, adapters, validation, and restart behavior as Studio itself.
- Do not hand-edit `runtime-manifest.json` or `active-version.json` when the UI is available.

## Load only the relevant reference

- Read [references/studio.md](references/studio.md) for installing, verifying, or upgrading the Desktop, npm, Docker, or source form of Ekko Studio.
- Read [references/hermes-runtime.md](references/hermes-runtime.md) for Hermes CLI detection, managed Runtime downloads, validation, activation, upgrades, recovery, or storage migration.
- Read [references/coding-agents.md](references/coding-agents.md) for Claude Code, Codex, Pi, or Grok installation, update checks, removal, PATH diagnosis, and success criteria.

Read more than one reference only when the request crosses those boundaries.

## Installation workflow

1. Identify the operating system, architecture, Studio installation form, requested component, and whether the user wants install, verify, update, remove, recover, or migrate.
2. Inspect the existing installation before mutating it. Reuse a healthy installation instead of installing a duplicate.
3. State the exact package, version policy, destination, and restart impact before running an installation or migration.
4. Execute the supported Studio workflow when available. Use manual package-manager commands only when the UI is unavailable or the user asks for them.
5. Validate the executable, version, resolved path, and Studio detection after the operation. A successful package-manager exit alone is not proof of a usable installation.
6. Report what changed, where it was installed, the detected version/source, whether a restart is required, and any retained old Runtime directory.

## Safety and recovery

- Never delete an active Hermes Runtime version.
- Do not remove user configuration or conversation data when uninstalling a CLI.
- Preserve the previous Runtime storage after a successful migration; Studio deliberately leaves it available for recovery.
- If Runtime verification, activation, or migration fails, keep the previous usable Runtime active and report the persisted error.
- If an executable works in a terminal but Studio cannot see it, diagnose the running Studio process's PATH and npm prefix before reinstalling.
- Follow the user's language for explanations and results.
