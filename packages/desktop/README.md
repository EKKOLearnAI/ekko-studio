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

   Environment variables cannot carry request headers.

2. A persisted settings file at `$HERMES_WEB_UI_HOME/desktop-remote-server.json`
   (default `~/.hermes-web-ui/desktop-remote-server.json`), with a single server:

   ```json
   { "serverUrl": "https://studio.example.com" }
   ```

   or with several named servers (see below):

   ```json
   { "active": "home", "servers": [
     { "name": "home", "url": "http://192.168.1.20:6060" },
     { "name": "work", "url": "https://ekko.example.com",
       "headers": { "CF-Access-Client-Id": "<id>", "CF-Access-Client-Secret": "<secret>" } }
   ] }
   ```

Each URL must use `http://` or `https://` without a username or password;
query strings and hashes are dropped. On startup (and on every server switch)
the app polls `<serverUrl>/health/ready` for up to 30 seconds (override with
`EKKO_STUDIO_DESKTOP_REMOTE_READY_TIMEOUT_MS`) before loading the remote Web UI.
Delete the settings file or clear `serverUrl` and relaunch to return to local
mode; switching between local and remote mode requires an app restart.

Log in with the deployment's own accounts. The desktop shared token is never
injected into a remote page, and the tray's "Reset Login" action is hidden
because it only manages the local server.

### Several servers

With a `servers` list, `active` names the server to open. Invalid entries are
skipped with a console warning that never includes the URL or headers. If the
file cannot be read or `active` does not name a valid entry, the app shows an
error dialog and starts in local mode.

With more than one valid server the tray menu has a **Servers** submenu.
Choosing a server saves it as `active`, closes chat windows from the previous
server and reloads the main and pet windows on the new one. Each server keeps
its own browser login.

### Request headers per server

A server entry may carry static request headers, for example a Cloudflare Access
service token so the app skips the Access login page.

- The main process adds the headers only to requests whose origin (scheme, host and
  port) is exactly that server's origin: the readiness probe, page loads, fetch/XHR
  and the WebSocket upgrade. Requests to any other origin, including redirects
  elsewhere, get none. The headers are never passed to the page, the preload script
  or IPC, and are never logged.
- `headers` is an object of at most 16 string values. Names must be RFC 7230 tokens;
  values must not contain CR, LF or NUL. `Host`, `Cookie`, `Origin`, `Content-Length`,
  `Transfer-Encoding`, `Connection` and `Upgrade` are refused. An invalid `headers`
  object skips the whole entry.
- The file then holds secrets. Restrict it to your user (`chmod 600`). A tray server
  switch rewrites the file with mode 600.

### Behavior differences in remote mode

- Chat, coding agents, files, and workflows execute on the server; local
  Runtime downloads and managed command shims are skipped.
- Server-side password policies apply unchanged; the desktop patch that hides
  the "change the default password" prompt is local-mode only.
- Desktop integrations that act on this computer are off: the embedded browser,
  screenshots and their global shortcut, update controls, app restart, the runtime
  directory picker and the open-external-URL call. Links open in the system browser
  instead. The tray hides **Check for Updates**.
- The desktop pet window and the desktop MCP bridge stay on this computer, and
  agents on the remote server cannot reach them. The remote page still gets
  notifications, microphone access and chat windows, so only connect to servers
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
