# Windows ARM64 packaging

The release matrix, manual desktop build, runtime build, and isolated update
test workflow support `win32` / `arm64` on `windows-11-arm`. Use native ARM64
Node.js so npm selects matching sharp, node-pty, and other native dependencies.

For a manual installer build, select `target_os=win32` and `target_arch=arm64`
in **Manual Desktop Build**. Leave `release_tag` empty to keep the result in
Actions artifacts. Expected files are `Ekko.Studio-<version>-arm64.exe`, its
blockmap, and `latest-arm64.yml`.

Windows x64 retains `latest.yml`. The ARM64 application requests
`latest-arm64.yml` from both the primary and fallback update servers. Do not
merge the two Windows manifests: electron-updater's NSIS implementation selects
the first EXE, without filtering by CPU architecture. The desktop build wrapper
builds one Windows architecture at a time; specify `--arm64` or `--x64` (otherwise
it uses the host architecture). Invoke the wrapper through `npm run dist:win`,
not electron-builder directly.

## Native speech binding

`sherpa-onnx-node` 1.13.3 has no Windows ARM64 npm package. After pruning Web UI
dependencies, the workflows run `scripts/build-windows-arm64-speech.mjs` to:

1. Download the matching upstream ARM64 shared libraries and verify their pinned
   SHA-256; download the addon source at a pinned Git commit.
2. Build the Node-API extension with MSVC ARM64, pinned node-addon-api headers,
   and the current Node.js SDK (verified against Node's published checksums).
3. Stage `sherpa-onnx-win-arm64` beside `sherpa-onnx-node`, then load the speech
   API in native ARM64 Node.js. The package verifier requires the extension and
   its DLLs along with the other ARM64 dependencies.

Run this step after the final `npm prune`: npm treats the generated platform
package as extraneous. When upgrading sherpa-onnx, update the source commit,
library checksum, and version together. A version mismatch stops the build.

## Hermes runtime and acceptance

Publish the `hermes-runtime-win-arm64.json` and matching archive from
**Publish Desktop Runtime to Release** into the runtime release used by the app
before distributing the installer. Python, Node.js, and MinGit target ARM64.
The optional Hermes standalone browser bundle is omitted, as on Linux ARM64;
the desktop's Electron browser remains available.

Before release, validate on Windows 11 ARM64: launch the packaged app, download
and start Hermes, open a terminal, use local speech recognition, and complete
an A → B upgrade using the `win32-arm64` isolated update-test target. Local
configuration tests on another OS do not substitute for this acceptance.
