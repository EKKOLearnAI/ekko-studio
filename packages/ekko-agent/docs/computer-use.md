# Computer Use

Ekko includes a `computer_use` tool for native desktop applications on macOS,
Windows and Linux. It controls the machine running Ekko; connecting from a phone
or a remote browser does not give it access to that client's desktop.

The agent declares `@trycua/cua-driver` 0.35.4 as a runtime dependency. npm
installs the SDK and its matching platform native library together; no separate
`cua-driver` executable, CuaDriver.app, daemon or Hermes installation is required.
The library is loaded lazily, and each run owns a same-process configured SDK
runtime. Ekko does not search PATH, connect to an installed daemon or install
software during a model call. The configured constructor limits the native
runtime to standard permission mode, independently of Cua environment overrides.

In Studio, **Ekko → Settings → Tools** edits the agent's own
`tools.computerUse` config: enable/disable the tool and adjust its operation
timeout. The UI stores no separate desktop configuration. Computer Use is
enabled by default; enabling it alone does not load the native library.

Source installations must keep npm optional dependencies enabled because Cua
uses platform-selected native packages. `npm ci --ignore-scripts` still installs
these prebuilt libraries; no postinstall compiler or runtime download is needed.
If optional dependencies were omitted, reinstall with `npm install --include=optional`.
Studio's distribution manifest also declares the SDK because its server bundles
the agent's JavaScript while shipping native dependencies separately. The existing
desktop packaging copies these production dependencies outside ASAR.

OS grants are still required. On macOS, Accessibility and Screen Recording
permissions belong to the host running Ekko (Studio or the terminal), not to a
separate driver app. The adapter reads permission status without prompting or
granting access. Windows needs an interactive desktop. Linux needs a graphical
session and the native library's system dependencies, including X11/AT-SPI where
applicable; the SDK's Linux builds target glibc, not musl. macOS and Windows
packages support x64/arm64, as do the published Linux native packages. Native
acceptance for this integration has been performed on macOS only.

```json
{
  "tools": {
    "computerUse": {
      "enabled": true,
      "timeoutMs": 30000
    }
  }
}
```

## Tool workflow

1. `computer_use({action: "status"})` initializes the bundled native SDK and reads
   permission status without raising system dialogs. Connected is not proof of
   successful capture or input.
2. `computer_use({action: "list"})` lists supported desktop operations. The list
   comes from the SDK's canonical tool schema and an explicit Ekko allowlist.
3. `computer_use({action: "describe", tool: "list_windows"})` returns the
   caller-facing argument schema. Ekko removes its managed session/output fields
   and disables permission prompts/probes. Describe each operation before calling
   it in each new run, and again after `close`.
4. `computer_use({action: "call", tool: "list_windows", arguments: {}})` discovers
   native process/window IDs. Describe and call `get_window_state` for one target.
5. Use the returned `element_token` with input operations. Always supply exact
   process/window IDs or an explicit desktop target. Old snapshot tokens remain
   invalid; inspect fresh state after changes instead of reusing them.
6. Verify the requested result with `verify_state` or a fresh window observation.
   A dispatched action or `effect: unverifiable` is not success. Never blindly
   replay input after cancellation or a timeout.

If background input fails, prefer an exact-window foreground delivery
before desktop scope. Desktop input acts on whichever app is frontmost, so
confirm the target immediately before acting.

Pixel coordinates refer to the returned screenshot, including any size cap.
Use the current capture's geometry and the operation's schema; do not multiply
coordinates by an assumed Retina/DPI factor. `zoom` takes screenshot pixels.
For operations that advertise `from_zoom`, use coordinates from the latest zoom.

The surface covers application/window discovery, window/desktop observations,
accessibility trees, screenshots and zoom, click/double/right/middle click
(middle via `click.button`), typing, keys/hotkeys, scrolling, dragging, values,
native menus, app launch, foreground activation, window geometry, cursor
movement and outcome verification, when advertised by the bundled SDK.
Driver configuration, grants, browser-profile attachment, installation, shell
execution, process termination and recording are not exposed through this tool.
Studio browser requests continue to use `ekko_studio_browser_toolset`.

Screenshots are forwarded as image content to vision-capable models and saved
as unique files under the workspace's `.ekko-tmp/tool-assets`. The returned
`data.screenshots` paths can be shared with the user. Text-only models use the
accessibility tree; whole-desktop image observations require vision. These
artifact files remain available after the driver exits and can be removed with
the workspace's other temporary outputs.

The native structured result is included in model-visible text, alongside the
native summary and image parts. This preserves window IDs, capture geometry,
snapshot handles and verification fields even when the summary only says
"Found 2 window(s)." `data.result` retains the same payload for direct callers.

Input uses Ekko's existing approval service. Grants are keyed by operation and
background/foreground mode, so permission for background clicks does not cover
visible desktop or foreground control. Headless execution without an approval
handler refuses inputs when approvals are enabled. Disabling Ekko approvals
does not change Cua's standard permission mode or OS permissions.

The runtime provides a separate `computerUseSessionSignal` for each run and
aborts it on completion, failure or cancellation. Cancellation and operation
timeouts reach the SDK's native Rust future through `AbortSignal`; the adapter
then shuts down the runtime and releases its binding handle. One run at a time may own
the desktop in an Ekko process. Delegated agents hand desktop work to their
parent. This lease does not coordinate separate Studio processes or unrelated
automation programs. `action: "close"` explicitly releases the current run's
runtime; it must rediscover schemas and capture fresh state before resuming.

Direct tool callers must supply their own `computerUseSessionSignal` and abort
it when done. A standalone `status` probe manages its own connection.

## Validation

```sh
npx vitest run tests/ekko-agent/computer-use.test.ts tests/ekko-agent/runtime.test.ts
npx playwright test tests/e2e/ekko-computer-use-settings.spec.ts
```

The SDK fixture uses native-style short summaries with separate structured
payloads; a full AgentRuntime regression checks the next model request for
window identities, screenshot geometry, image parts and input verification.
It also exercises snapshot expiry, image delivery, approval denial,
controller contention, serialization, cancellation, timeout handling and late
initialization cleanup. It does not prove native UI behavior on every platform.
Native desktop acceptance requires a graphical session with the host's OS grants
and should use a disposable application window. Verify the compiled agent from
an unrelated working directory with an empty PATH and an invalid
`CUA_DRIVER_RS_SOCKET` to detect accidental dependence on a preinstalled CLI or
daemon. Capture the target window, send background input, then independently
read the fixture's actual value to verify delivery.
