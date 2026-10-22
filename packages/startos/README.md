<p align="center">
  <img src="icon.svg" alt="Ekko Studio Logo" width="21%">
</p>

# Ekko Studio on StartOS

> Everything not listed in this document should behave the same as upstream
> Ekko Studio. If a feature, setting, or behavior is not mentioned here,
> the upstream documentation is accurate and fully applicable — see the
> Documentation section of `instructions.md` for links.

A StartOS wrapper for [Ekko Studio](https://github.com/EKKOLearnAI/ekko-studio),
a self-hosted workspace for AI agents, chat, coding, and visual workflows.
This repository retains upstream branding and its Business Source License.

## Table of Contents

- [Image and Container Runtime](#image-and-container-runtime)
- [Volume and Data Layout](#volume-and-data-layout)
- [File Models](#file-models)
- [Dependencies](#dependencies)
- [Network Access and Interfaces](#network-access-and-interfaces)
- [Installation and First-Run Flow](#installation-and-first-run-flow)
- [Actions](#actions)
- [Tasks](#tasks)
- [Health Checks](#health-checks)
- [Backups and Restore](#backups-and-restore)
- [Limitations and Differences](#limitations-and-differences)
- [Quick Reference for AI Consumers](#quick-reference-for-ai-consumers)

## Image and Container Runtime

The package copies the prebuilt `/app` payload from the upstream
`ekkoye8888/hermes-web-ui` image into a Node-based image. Both source images
are pinned by digest in `Dockerfile`. Hermes source and its Python environment
are excluded from the final image; the upstream Studio entrypoint is preserved. It supports x86_64
and aarch64 and runs the upstream entrypoint in the `studio` subcontainer.
The image's root user remains confined to the service container; no host Docker
socket or host directories are mounted. The temporary `credential-setup`
subcontainer exists only while applying administrator credentials.

## Volume and Data Layout

The complete application home is persistent. File work outside this home is
outside the package's persistence contract.

| Volume | Container path | Contents |
| --- | --- | --- |
| `main` | `/home/agent` | Studio database, credentials, uploads, Hermes profiles, runtime-installed tools, workspaces, caches |
| `startos` | Not mounted into application containers | Package-managed administrator credential in `store.json` |

Studio data is under `.hermes-web-ui/`, Hermes data under `.hermes/`, and the
workspace browser is rooted at `workspaces/`, all inside the mounted home.
Hermes runtimes installed through Studio live under
`.hermes-web-ui/desktop-runtime/hermes/` and are included in persistence and backups.
The package neither installs Hermes at startup nor replaces an installed runtime
on application upgrade. Runtime installation and selection use Studio’s existing
version manager; the bundled Ekko Agent remains available without Hermes.

Runtime-installed npm tools use `.hermes-web-ui/coding-agent/npm/`.

## File Models

The package owns `startos/store.json`, a loose JSON model containing the generated
`adminPassword`. It is separate from the application's own SQLite database.
It is only written after the upstream API has accepted the new password and a
real login has succeeded. An interrupted reset clears this field and blocks
normal startup until the setup action succeeds again.

## Dependencies

There are no mandatory StartOS package dependencies or sidecar databases.
Configure a model provider inside Studio to run AI tasks. Local endpoints or
external provider accounts can be used; no provider account or API key is bundled.
Provider calls and runtime tool downloads require their respective network
access. This package does not provide a local inference engine or GPU integration.

## Network Access and Interfaces

The `ui` interface serves browser access, the authenticated HTTP API, and
Socket.IO on the same internal HTTP port, `6060`. StartOS handles the interface's
addresses. No fixed external hostname, LAN IP, or public exposure is assumed.

The package fixes `BIND_HOST` and `PORT`, sets the data paths, and disables UDP
LAN discovery and direct P2P with `HERMES_LAN_DISCOVERY_ENABLED=false` and
`STUDIO_P2P_ENABLED=0`. The Docker image's optional preview-development port,
xAI callback listener, and direct UDP port range are not exported.

## Installation and First-Run Flow

A critical setup task prevents the regular daemon from starting without a
package-managed admin password. The setup action runs upstream's
`reset-default-login` command inside a temporary container, starts the server
on loopback only, applies a random password through `/api/auth/change-password`,
verifies login, checks rejection of the upstream default, and stops that server.
Only then is the startup gate cleared. The normal daemon uses the upstream
entrypoint with its own data home.

## Actions

Administrator reset is intentionally performed while the service is stopped,
so it cannot race the application database or expose the intermediate default
credential. It generates a fresh password on each successful run and returns it
masked and copyable. Run it again if the password is lost; there is no separate
credential-display action. Keep `admin` as the package-managed account name and
use Studio's user management for other accounts. Existing login sessions follow
upstream behavior; the reset makes no promise to revoke them.

## Tasks

A critical credential task appears when the package has no successfully applied
administrator password, including after an interrupted setup/reset. Completing
the password action resolves it. There are no recurring provider-setup tasks;
model configuration remains in Studio.

## Health Checks

The `studio` daemon checks that its web port is listening. This indicates server
readiness, not model-provider availability, a successful AI request, or healthy
external agents. If the port never opens, inspect the service log; if it is ready
but an AI request fails, inspect the selected provider and agent inside Studio.

## Backups and Restore

Both `main` and `startos` are included. StartOS stops the service during backup,
so the SQLite database and its WAL are copied together without concurrent writes.
Restoration includes account credentials, conversations, uploads, workspaces,
and the StartOS credential state. Restored instances retain their passwords.
Caches and installed tools are included because they share the persistent home;
backups can grow with workspaces and installed runtimes. No external share,
model-provider data, or files outside the mounted home are backed up.

## Limitations and Differences

This is an initial packaging submission. **It has not been installed on a StartOS
device.** Container smoke tests and package builds do not verify StartOS runtime
confinement, interface routing, actions/tasks, backup/restore, or uninstall.
Those remain required before a production listing is claimed.

The package exposes the main browser service only. Direct LAN device discovery,
UDP P2P, preview development servers, OAuth providers needing a separate callback
listener, arbitrary development ports, and host-device integrations are outside
this package's supported interface set. Use provider API credentials where
appropriate. Updating the application image is managed through package releases;
upstream update notifications are disabled. Running agents can execute code
inside this service's container and mounted application home.

## Quick Reference for AI Consumers

The following summary describes the package-managed surface.

```yaml
package_id: ekko-studio
image: ekkoye8888/hermes-web-ui
architectures: [x86_64, aarch64]
subcontainers: [studio, credential-setup]
volumes:
  main: /home/agent
  startos: not-mounted
file_models:
  - startos/store.json
startos_managed_env_vars:
  - HOME
  - HERMES_HOME
  - HERMES_WEB_UI_HOME
  - HERMES_WEBUI_STATE_DIR
  - WORKSPACE_BASE
  - NPM_CONFIG_PREFIX
  - HERMES_WEB_UI_MANAGED_GATEWAY
  - HERMES_ALLOW_ROOT_GATEWAY
  - HERMES_WEB_UI_DISABLE_UPDATE_CHECK
  - HERMES_LAN_DISCOVERY_ENABLED
  - STUDIO_P2P_ENABLED
  - BIND_HOST
  - PORT
dependencies: []
interfaces:
  ui: { type: ui, port: 6060 }
actions:
  - set-admin-password
tasks:
  - { action: set-admin-password, severity: critical }
health_checks:
  - studio
```
