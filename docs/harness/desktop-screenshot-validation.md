# Desktop screenshot acceptance

Implementation record: 2026-10-07. Design: [cross-platform plan](../planning/desktop-screenshot-platform-adaptation.md).

The implementation keeps the composer result `{ dataUrl, width, height } | null` unchanged.
Windows/macOS and confirmed native X11 sessions use Electron capture. Every source must
have a unique matching `display_id` before desktop overlays are used. Unmapped sources
are independent images in a resizable editor, with an explicit image selector when
there is more than one. Selection and annotation coordinates are original image pixels.
Window fitting, zoom, and scrolling never resample exported pixels.

Wayland, Xwayland in a Wayland session, and unconfirmed Linux backends use Screenshot
Portal. `DISPLAY` alone does not enable overlays. Screenshot v3 prefers advertised
Area (4), otherwise Screen (1); v1/v2 never receive a v3 target. Only v2 and newer
receive the interactive hint. Area and legacy results start fully selected; Screen
results start unselected. The parent identifier is empty until Electron can export a
valid Wayland handle. Portal absence disables capture with an explanation.

The session D-Bus dependency is pinned to `dbus-next@0.10.2` and imported only when
Portal is used. Standard pathname Unix sockets work without its optional native addon.
Abstract sockets and native package loading still require Linux acceptance. The Portal
client subscribes before Screenshot, checks the returned handle and signal sender,
buffers early responses, closes requests on local abort/timeout, and disconnects after
cleanup. Technical waits are 10 seconds; system interaction is 120 seconds. Only local
PNG URIs from the system response are read, with file/pixel limits. Portal files are
preserved; Studio does not delete system-owned images.

Linux `hideWindows` is false. No Linux compositor has passed the native hidden-frame
matrix yet. Hidden requests fail explicitly without falling back to ordinary capture.
Windows and macOS save opacity and hide only visible, non-minimized Studio windows;
cleanup restores only affected windows. Ordinary capture does not change opacity.

## Automated checks

```bash
npm run harness:check
npm run test -- tests/desktop/screenshot*.test.ts tests/client/screenshot*.test.ts tests/client/group-chat-input-mentions.test.ts
npm run test:e2e -- tests/e2e/desktop-screenshot.spec.ts
npm run build
npm --prefix packages/desktop run build
npm ci --prefix packages/desktop --ignore-scripts --omit=optional
node packages/desktop/scripts/verify-screenshot-package.cjs
```

The archive smoke check performs a clean locked production dependency install with
optional addons omitted, creates an asar, and imports D-Bus messages in Electron.
If Electron was installed with scripts disabled, pass `--electron=/absolute/binary`.
This verifies the dependency closure; it is not a Windows/Linux installation test.

95 focused unit tests and 14 screenshot browser tests passed. A focused coverage run
also passed. Browser tests cover original pixels through zoom, scroll, resize, and
image switching, plus selection, all annotation tools, undo/redo, and composer attachment.
Portal tests cover v1/v2/v3, early responses, changed handles, sender checks, cancellation,
timeouts, missing targets, and local URI validation.

## Global screenshot shortcut

The dropdown places **Set screenshot shortcut** directly below hidden capture. It
records a modified physical key, offers ordinary/hidden capture, and can clear the
binding. No global shortcut is enabled by default. The desktop shell validates the
accelerator and hiding capability, atomically stores preferences in
`HERMES_WEB_UI_HOME/desktop-screenshot-shortcut.json`, and restores registration on
startup. Conflicts and save failures preserve the previous preference. Only the
screenshot binding is released during recording or shutdown; recording leases are
also released when a renderer closes, crashes, or navigates away.

The global callback targets one eligible composer in the focused Studio window,
otherwise the most recently operated composer. Composer IDs and event cleanup prevent
duplicate attachments and stale-session captures. The existing native capture path
and localized editor produce the attachment; no chat message is automatically sent.
Linux hiding remains unavailable in both the menu and shortcut settings.

Electron 42 enables `GlobalShortcutsPortal` before startup on Linux. Packaging sets
`desktopName` and `linux.syncDesktopName` so the installed launcher, window identity,
and Portal identity use `com.hermeswebui.studio.desktop`. The Debian installation hook
uses the same filename. Portal consent, actual global registration, and AppImage
desktop integration still require GNOME/KDE/wlroots acceptance.

The macOS arm64 shortcut probe passed 13 checks in Electron 42.11.11. Three actual
system keyboard injections invoked the production shortcut manager while its app
was unfocused: ordinary, hidden, and restored-from-disk modes. Recording pause,
resume, and clearing also passed. This checks native binding/dispatch, separately
from the browser tests that verify composer attachment; it is not a combined
end-to-end acceptance of the packaged app. Raw report:
[macOS shortcut report](fixtures/desktop-screenshot-shortcut-macos-20261007.json).

```bash
electron packages/desktop/scripts/verify-screenshot-shortcut.cjs --output=/absolute/shortcut-report.json
```

This automated probe is macOS-only and requires existing System Events keyboard
access. On Windows/Linux, verify registration with another application focused,
conflicting shortcuts, recording the current binding, changing modes, restart,
clear/cancel, two detached chats, composer/session changes, and quitting. On Wayland,
also verify consent denial, compositor-assigned bindings, and the installed desktop
entry. These cases remain untested on native Windows/Linux desktops.

The initial full regression run had 753 passing test files, 31 failing files and
11 skipped files (7,345 passing tests, 60 failing tests, 29 skipped tests). Rechecking
failed files with two workers left 43 failures; the exact same 43 failures reproduced
on untouched `origin/main` at `942bb78fa`. The full browser run had 571 passing tests,
2 failures and 34 not run. Both failures passed when rerun with one worker. Keep these
baseline failures visible in PR validation; do not describe the full suites as green.
GitHub Build and all four Playwright shards for the initial screenshot PR #3310 passed.

## Interactive pixel probe

Build desktop first, then run with the Electron executable on the actual desktop:

```bash
electron packages/desktop/scripts/verify-screenshot-pixels.cjs --rounds=20 --output=/absolute/report.json
```

The probe temporarily displays a solid background and a high-contrast test window.
It captures a background baseline, verifies ordinary capture includes the window,
then checks its entire former area and surrounding shadow margin against that baseline
after hiding. It uses production capture, the isolated renderer bridge, and PNG validation;
confirmation and cancellation alternate. It records actual Electron, display geometry,
scale, refresh rate, desktop/session, GPU metadata, first/steady timing, restoration,
pixel deltas, and tolerance. Success requires zero changed pixels above the recorded
tolerance. A native result is stronger evidence than mocked IPC or Xvfb.

For Linux X11 timing experiments, use `--measure-linux-hide`. This independently
hides the test window and measures 50/100/200/350ms waits with the ordinary production
capture path. It does not bypass the production capability gate, enable hidden capture,
or change global animation settings. A measurement result is not approval to enable
a compositor: add its tested identity and a supported hiding strategy first.

## Native acceptance record

| Environment | Result | Remaining acceptance |
| --- | --- | --- |
| macOS arm64, Electron 42.11.11, 2560×1440, scale 1, 60Hz | 20 rounds passed on 2026-10-07; all hidden pixel deltas exactly 0; completion/cancel restored visibility | Mixed DPI, full-screen Spaces, additional displays |
| Windows 11 | Implementation and mocked lifecycle tests only | Real ordinary/hidden pixels, 100/125/150/200% DPI, negative-position and portrait displays, taskbar, focus, IME |
| GNOME Xorg / KDE Plasma X11 | Ordinary capture implemented; hiding disabled | Actual backend/source mapping and pixel timing experiments with animations enabled |
| GNOME / KDE Wayland, wlroots | Portal implementation and protocol/editor tests only | Actual backend dialogs, refusal/cancel, legacy/v3 capability combinations, repeat capture, missing portal |
| Linux x64 / arm64 packages | Portable dependency archive smoke tested on macOS only | Actual package builds, dependency loading, session bus, and interactive capture on both architectures |

macOS probe timing: first editor 210.79ms; warmed ordinary P95 129.88ms, hidden P95
176.00ms, cleanup P95 9.82ms. Raw pixel deltas were 0 in every round with a recorded
tolerance of 3. These timings apply only to that machine and test region, not Windows
or Linux. The [raw report](fixtures/desktop-screenshot-macos-20261007.json) was produced by the probe; rerun it on each target desktop.

The next release gate is the Windows/Linux interactive matrix above. No platform
should be advertised as natively accepted based only on builds or browser tests.
