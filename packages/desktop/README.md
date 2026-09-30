# Ekko Studio

Electron desktop distribution for Ekko Studio.

## Install

Download the latest macOS, Windows, or Linux installer for your CPU
architecture from the project
[GitHub Releases](https://github.com/EKKOLearnAI/ekko-studio/releases/latest).

The desktop app bundles the Web UI runtime and launches it locally from the
native shell app.

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
