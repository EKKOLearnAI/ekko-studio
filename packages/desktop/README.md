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

In the desktop app, open **Device Connections → Remote devices**. Add a name
and the HTTP or HTTPS address of another running Studio server. Saved devices
are kept on this computer, including when connected to a remote server. Adding
a device saves its connection without switching immediately.

Use **Switch to device** to check its connection and restart all desktop windows
on that server. Save your work before switching. If the connection check fails,
the current device stays selected. Choose **This computer** to return to the
local server. Switch away from a device before deleting its connection; deletion
only removes the saved connection, preserving the server and its data.

When a remote server is unavailable or its Web UI is too old to show this tab,
use **Switch to this computer (restart)** in the system tray menu. The remote
startup failure page also offers this action without requiring a login.

The existing configuration sources remain supported (the environment variable
wins on launch):

1. `EKKO_STUDIO_DESKTOP_SERVER_URL` — one-off or automated launches:

   ```sh
   EKKO_STUDIO_DESKTOP_SERVER_URL=http://192.168.1.20:6060 npm run dev
   ```

2. A persisted settings file at `$HERMES_WEB_UI_HOME/desktop-remote-server.json`
   (default `~/.hermes-web-ui/desktop-remote-server.json`):

   ```json
   { "serverUrl": "https://studio.example.com" }
   ```

The URL must use `http://` or `https://` at the root of a domain or port;
query strings and hashes are dropped. Subpath deployments such as
`https://example.com/studio` are rejected because API, Socket.IO and asset URLs
currently target the origin root. Use a dedicated hostname or port for each
Studio deployment. On startup the app polls `<serverUrl>/health/ready` for up to 30
seconds (override with `EKKO_STUDIO_DESKTOP_REMOTE_READY_TIMEOUT_MS`) before
loading the remote Web UI. This route must return Studio's `{ "status": "ready" }`
JSON without an authentication or canonical-URL redirect; configure the final
server address directly. The device manager extends this same file with a
`devices` list and keeps `serverUrl` as the selected server (or `null` for local
mode). Existing single-URL settings and the active environment URL appear in
the device list automatically. A switch from the UI clears the one-off
environment override for its relaunch; a fresh launch with an explicit
environment variable can still override the saved selection.

A desktop-owned device button stays in the main window's upper-right corner on
macOS, and immediately before the window controls on Windows/Linux, with 8px
spacing. It opens a desktop-owned themed menu and a local management window for
adding, deleting and switching servers. These views are shipped with Desktop and remain usable
when an older remote UI lacks device management, the server is offline, or the
remote renderer crashes. The desktop reserves header space in older pages too.
The toolbar, manager and confirmation windows use isolated local documents and a restricted preload;
remote pages, unrelated windows and child frames cannot invoke their IPC.

The button remains hidden during the normal startup splash
and appears after the Studio header is ready; the local recovery page also keeps
it available. Its hit region is explicitly excluded from window dragging in both
the main page and the isolated view. The button, menu and manager read an allowlist
of resolved Studio appearance tokens in an isolated world, including regional
colors/alpha/radius/filter/border/shadow and global text/accent/font settings.
They retain the last appearance if the remote page stops responding. Wallpaper
resources and remote scripts are never loaded into the desktop-owned UI; a
separate management window cannot sample the main window's wallpaper backdrop.

The desktop device UI follows the language selected in Studio (the main page's
`html.lang`) across all twelve supported locales. Open menus, window titles,
forms, existing errors and switching progress update live; Arabic uses RTL layout
with left-to-right server addresses. Before Studio provides a supported language,
the desktop uses the OS locale, falling back to English. If the remote page goes
offline or crashes, the desktop keeps the last language for that running window.

The local device is consistently named `localhost` in all languages; only the
display name changes, and local mode still uses a null remote server URL.
The header button is 120px wide and its menu is 224px; long names truncate with
full-name/address tooltips. The manager uses device cards and a collapsible add
form. Switch and delete confirmation use a compact local themed window. Only
that exact window and its current operation token can confirm or cancel the
operation. Once confirmed, connection checking and restart have explicit spinner,
stage and elapsed-time feedback; duplicate operations are blocked. A failed
check keeps the old connection and offers retry in the same window. Checking
cannot be dismissed by closing the child window; quitting the app is preserved.

Each remote server has its own persistent Electron session and embedded-browser
profile directory under `desktop-remote-devices/<address-hash>/` in the Web UI
home. The hash includes the normalized full server address, including scheme,
port and base path. Cookies, login tokens, localStorage, IndexedDB, service
workers, theme caches and embedded-browser tabs/site logins therefore stay with
their device, including servers that share a hostname or origin. Main, chat and
pet windows share only the current device's session. Switching back reuses that
device's saved login and preferences.

Existing local storage and local browser profiles keep their original locations.
Remote logins from older versions that used the default session are not copied
into the new device sessions: sign in once on each remote device after upgrading.
Deleting a connection preserves its cached login and browser profile for reuse
if the same address is added again. Desktop settings such as screenshot
shortcuts and application updates remain shared on this computer.

Storage regression checks: `npm run test -- tests/desktop/desktop-device-storage.test.ts tests/desktop/desktop-device-storage-electron.test.ts`. The second test runs real
Chromium twice when the macOS Electron development binary is installed; it checks
same-origin paths, same-host ports, HTTP cache, login storage, cookies, IndexedDB,
CacheStorage, service workers and embedded-browser profile restoration.

Log in with the deployment's own accounts. The desktop shared token is never
injected into a remote page, and the tray's "Reset Login" action is disabled
because it only manages the local server.

Behavior differences in remote mode:

- Chat, coding agents, files, and workflows execute on the server; local
  Runtime downloads and managed command shims are skipped.
- Runtime restarts target the connected server. Local Runtime directory picking
  and legacy Windows data migration prompts are unavailable in remote mode.
  The native bridge also withholds local service restart and Runtime directory
  APIs from older remote pages. Update the remote Web UI to use the corrected
  server restart flow; desktop updates and explicit device switching still
  restart this computer's desktop app through their own operations.
- Server-side password policies apply unchanged; the desktop patch that hides
  the "change the default password" prompt is local-mode only.
- Desktop integrations (embedded browser, screenshots, update controls) remain
  available to pages loaded from the remote origin. Only connect to servers
  you control.
- The embedded browser and screenshot capture run on this computer. The browser
  Agent broker is a local loopback service; a remote Agent cannot control the
  client's embedded browser without an additional bridge. File uploads transfer
  client files to the server before server-side tools use them.
- Browser microphone capture needs a secure context. Use HTTPS for remote hosts
  other than loopback addresses, including deployments on a local network.
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

Native switcher verification: `npm --prefix packages/desktop run build:main`, then
`node packages/desktop/scripts/verify-native-device-switcher.cjs`. This uses real
OS pointer input and requires a graphical desktop (and existing event-posting
permission on macOS). The manual Windows build runs it before packaging, checks
that the control is not a draggable caption, and uploads its interaction report.
The Vitest Electron fixture uses renderer pointer events by default; set
`STUDIO_TEST_NATIVE_MOUSE=1` to exercise OS hit testing locally as well.
