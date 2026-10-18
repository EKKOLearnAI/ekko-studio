# Ekko Studio

Electron desktop distribution for Ekko Studio.

## Install

Download the latest macOS, Windows, or Linux installer for your CPU
architecture from the project
[GitHub Releases](https://github.com/EKKOLearnAI/ekko-studio/releases/latest).

The desktop app bundles the Web UI runtime and launches it locally from the
native shell app.

## Remote server mode

By default the desktop app spawns the bundled Web UI server locally. Remote
mode points every window at an already-running deployment instead — for
example the [Docker Compose setup](../../docs/docker.md) — and skips all local
server and runtime bootstrap work.

Enable it through either source (the environment variable wins):

1. `EKKO_STUDIO_DESKTOP_SERVER_URL` — one-off or automated launches:

   ```sh
   EKKO_STUDIO_DESKTOP_SERVER_URL=http://192.168.1.20:6060 npm run dev
   ```

2. A persisted settings file at `$HERMES_WEB_UI_HOME/desktop-remote-server.json`
   (default `~/.hermes-web-ui/desktop-remote-server.json`):

   ```json
   { "serverUrl": "https://studio.example.com" }
   ```

The URL must use `http://` or `https://`; query strings and hashes are
dropped. On startup the app polls `<serverUrl>/health/ready` for up to 30
seconds (override with `EKKO_STUDIO_DESKTOP_REMOTE_READY_TIMEOUT_MS`) before
loading the remote Web UI. Delete the settings file or clear `serverUrl` and
relaunch to return to local mode; mode changes require an app restart.

Log in with the deployment's own accounts. The desktop shared token is never
injected into a remote page, and the tray's "Reset Login" action is disabled
because it only manages the local server.

Behavior differences in remote mode:

- Chat, coding agents, files, and workflows execute on the server; local
  Runtime downloads and managed command shims are skipped.
- Server-side password policies apply unchanged; the desktop patch that hides
  the "change the default password" prompt is local-mode only.
- Desktop integrations (embedded browser, screenshots, update controls) remain
  available to pages loaded from the remote origin. Only connect to servers
  you control.
- The server has no built-in TLS, so put public deployments behind an HTTPS
  reverse proxy; login tokens are bearer credentials sent on every request.

### Release asset names

Installers use `Ekko.Studio-${version}-${arch}.${ext}`. Publish the new
artifacts before deploying the website download page with the matching names.

Keep the application ID, signing identity, update feeds, and Linux package
identity stable. Update manifests reference the actual artifact filenames.
Validate an upgrade from the previous signed release on macOS and Windows
before rollout.

For isolated A → B testing without a production Release, use the
[desktop update testing guide](UPDATE-TESTING.md) and the **Desktop Update Test Build**
workflow. Test packages use a fixed HTTPS test feed and never fall back to production.

## Command shims

After the packaged desktop app starts, it installs managed command shims:

| Command | Description |
| --- | --- |
| `ekko-studio` | Open the Ekko Studio desktop app |
| `ekko-studio cli ...` | Run the bundled Hermes Agent CLI |
| `ekko-studio web ...` | Run the bundled `hermes-web-ui` command |
| `ekko-studio -h` | Show wrapper help |
| `ekko-studio-mcp` | Run the managed Web UI MCP bridge |

The desktop command is `ekko-studio`; the previous managed `hermes-studio`
command is removed when the new shim is installed. No compatibility alias is created.

Use `ekko-studio cli -h` for Hermes Agent CLI help and
`ekko-studio web -h` for Web UI CLI help.

## Data directories

On Windows, the first packaged launch after the rename updates the existing
Studio startup entry from `Hermes Studio.exe` to `Ekko Studio.exe` in the same
installation directory. Its Task Manager enabled/disabled state is preserved.
No entry is created if startup was never enabled; custom entries and machine-wide
entries are left alone. The migration is safe to retry on later launches.

Hermes Agent data is stored in `~/.hermes` on Windows, macOS, and Linux.

The desktop wrapper's own Web UI state is stored separately in
`~/.hermes-web-ui` unless `HERMES_WEB_UI_HOME` is set.

## Desktop and tray icons

Regenerate the rounded Windows desktop icon and macOS, Windows, and Linux tray
icons from `build/icon.png` by running this command from the repository root:

```sh
node packages/desktop/scripts/generate-rounded-icons.mjs
```

The script preserves the original artwork and applies a transparent rounded-square
mask at each output size (16% corner radius for Windows, 26% for macOS/Linux trays).
It writes `iconWindows.png`, the multi-resolution
`icon.ico`, and the platform tray PNGs. Linux uses a separate `trayLinux.png` asset.

## China mirror environment

These mirrors are optional and are not required in CI:

```sh
export NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

If GitHub release downloads are slow, `fetch-python.mjs` can also use a compatible
python-build-standalone release mirror:

```sh
export PBS_BASE_URL=https://github.com/astral-sh/python-build-standalone/releases/download
```
