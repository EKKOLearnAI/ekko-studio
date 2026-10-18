# Ekko Studio installation

Use the installation form already chosen by the user. Desktop is the recommended end-user installation; npm, Docker, and source installs serve different deployment needs.

## Desktop application

Install the latest platform and architecture-specific package from the Ekko Studio GitHub Releases page. The packaged app bundles the Studio server and can manage a Hermes Runtime separately.

Once a managed Runtime is ready, packaged Desktop installs managed command shims:

- `ekko-studio` opens the Desktop app.
- `ekko-studio web ...` runs the bundled Web UI CLI.
- `ekko-studio cli ...` runs the managed Hermes CLI after a Runtime is installed.
- `ekko-studio-mcp [api|browser|devices|use]` starts one Studio MCP toolset.

First validate the Desktop installation by launching the app, opening the Agents page, and confirming Ekko appears as built in. After a Runtime is ready, validate its installed shims with:

```bash
ekko-studio -h
ekko-studio web version
```

Refresh the Agents page after each installation change. Hermes shows either a user CLI, a managed Runtime, or not installed.

Upgrade the packaged Desktop from its **Check for Updates** action. The updater checks the Cloudflare feed first and falls back to the GitHub latest-release feed. It downloads only after confirmation, then offers a restart to install. This upgrades the Desktop application; it is distinct from downloading a Hermes Runtime version or running `ekko-studio cli update`.

## npm installation

Requirements: Node.js 23 or newer and a working npm global prefix.

```bash
node --version
npm --version
npm install -g hermes-web-ui
hermes-web-ui version
hermes-web-ui start --no-open
hermes-web-ui status
```

The default address is `http://localhost:8648`. A successful installation must satisfy both `hermes-web-ui version` and `hermes-web-ui status` after startup.

Upgrade and restart with:

```bash
hermes-web-ui update --no-open
```

`upgrade` is an alias. The command performs a best-effort npm cache cleanup, installs `hermes-web-ui@latest` globally, locates the updated global CLI, and restarts on the previous or requested port.

## Docker Compose

Use the repository's Compose file. The prebuilt image already contains an integrated Hermes Agent runtime.

```bash
WEBUI_IMAGE=ekkoye8888/hermes-web-ui docker compose up -d
docker compose ps
docker compose logs -f hermes-webui
```

The default host address is `http://localhost:6060`. Validate the container and bundled Hermes executable:

```bash
docker compose exec hermes-webui hermes --version
```

Persistent data stays below `${HERMES_DATA_DIR}` (default `./hermes_data`), with Studio state below `${HERMES_DATA_DIR}/hermes-web-ui`. Recreating or upgrading the container must retain those mounts.

To upgrade the prebuilt image, use the same `WEBUI_IMAGE` value for both operations:

```bash
WEBUI_IMAGE=ekkoye8888/hermes-web-ui docker compose pull
WEBUI_IMAGE=ekkoye8888/hermes-web-ui docker compose up -d --force-recreate
docker compose ps
```

Do not use Desktop Runtime migration inside the container. Docker owns the runtime through the image and the Compose mounts.

## Source development install

Requirements: Git, Node.js 23 or newer, and npm.

```bash
git clone https://github.com/EKKOLearnAI/ekko-studio.git
cd ekko-studio
npm install
npm run dev
```

Development endpoints are frontend `http://localhost:8649` and backend `http://localhost:8647`. Validate the checkout with the smallest relevant tests, then `npm run build` before treating it as a production-ready build.

For an existing checkout, preserve local changes. Inspect `git status`, update only when the worktree and requested branch policy allow it, reinstall dependencies when the lockfile changes, and rebuild. Never discard a dirty worktree merely to upgrade Studio.

## Installation-owned paths

- Studio state: `HERMES_WEB_UI_HOME`, default `~/.hermes-web-ui`.
- Hermes data: `HERMES_HOME`; defaults to `~/.hermes` on Windows, macOS, and Linux.
- npm daemon PID, log, token, and database are stored under the Studio home.
- Docker maps Hermes and Studio state to separate container directories even when both originate below `./hermes_data` on the host.

These paths explain installation and persistence only. Do not create model or credential files during an installation task.
