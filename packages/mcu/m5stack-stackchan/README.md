# M5Stack StackChan firmware

Development-preview companion firmware for **M5Stack StackChan K151 / CoreS3**
(ESP32-S3, 16 MiB Flash, 8 MiB PSRAM, GC0308 camera, two feedback servos). It
connects to an official Ekko Studio on the same LAN for voice conversation
(runtime `hermes`, profile `stackchan`) and exposes face, motion, sound and
camera control to a Studio Agent through an MCP bridge.

This board project lives under `packages/mcu/`, alongside `esp32-c3/` and
`esp32-s3/`. Its images are not registered with Studio's C3 OTA endpoints.

**局域网开发预览版：只适用于 StackChan K151 / CoreS3；不支持远程，也没有 OTA。**

## Contents

| Path | Content |
| --- | --- |
| [`firmware/`](firmware/) | Complete PlatformIO (Arduino) source, host tests, build scripts and sound assets |
| [`bridge/`](bridge/) | Python MCP bridge used by the Studio `stackchan` profile, persona prompt and unit tests |
| [`release/`](release/) | Application update and full-flash images |
| [`manifest.json`](manifest.json), [`SHA256SUMS.txt`](SHA256SUMS.txt) | Artifact metadata and checksums |
| [`docs/CURRENT-FIRMWARE.md`](docs/CURRENT-FIRMWARE.md) | Interfaces of the running firmware, for the upcoming Studio BOT integration |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) and other `docs/` | Target product plan and interface contracts |

## Artifacts

Firmware version `2.9-lively.1-dir.1-voice.3`, release label `2.9.1-voice.3`.

| File | Offset | Bytes | SHA-256 |
| --- | --- | --- | --- |
| [Application update](release/stackchan-cores3-2.9.1-voice.3-app-0x10000.bin) | `0x10000` | 3,074,592 | `f18fd07e1d170bcf2c9d7de545aae722e74aeb23508f6ce39c9bf66a1560d822` |
| [Full-flash image](release/stackchan-cores3-2.9.1-voice.3-full-0x0.bin) | `0x0` | 3,140,128 | `c7ee62bded852d1e183df00f8b3ecbfb017ceb2d5c47034b07de914518fe200d` |

Verify from this directory with `shasum -a 256 -c SHA256SUMS.txt`.

- The **application update** keeps Wi-Fi, Studio pairing and local settings. It
  requires the default 16 MB layout (`default_16MB.csv`, app0 at `0x10000`,
  6,553,600 bytes); check that the partition table at `0x8000` (length `0xC00`)
  has SHA-256 `bd0f7954aca2ef7d925ee21aaa1f3dc8822d1d6ce5cbbd26a135e5886bfff6ce`.
  This is the image that was flashed and run on hardware.
- The **full-flash image** contains bootloader, partition table, `boot_app0` and
  the same application. Its NVS is blank, so it erases Wi-Fi, pairing and
  settings. It was assembled from the same build outputs but has **not** been
  flashed onto hardware.

Back up the device privately before writing, for example
`esptool.py --chip esp32s3 read_flash 0x0 0x10000 boot-backup.bin` (contains NVS
with Wi-Fi credentials — keep it outside any repository), then:

```bash
esptool.py --chip esp32s3 -p <port> write_flash 0x10000 release/stackchan-cores3-2.9.1-voice.3-app-0x10000.bin
```

## Build from source

```bash
cd firmware
pio run -e m5stack-cores3          # PlatformIO, espressif32@6.9.0
bash tools/run_host_tests.sh       # host C++ tests with ASan/UBSan (g++)
```

A rebuild produces identical code; the image differs from the release only in
the embedded ELF SHA-256 and image checksum, which depend on the build
directory path. The `core2` and `core-esp32` environments in `platformio.ini`
are legacy and are not part of this release.

## Studio setup

1. Create a Hermes profile `stackchan` that enables only the `pulse` MCP server
   (`bridge/pulse_mcp.py`, see [bridge/README.md](bridge/README.md)) and uses
   `bridge/stackchan-persona.md` as its persona.
2. On the device, open the setup page (hold the screen for 3 s → settings),
   join Wi-Fi, enter the Studio URL and authorization code, select the profile,
   and enable voice. The consent is stored on the device.
3. Read the LAN control token over a trusted USB serial connection with
   `{"op":"pairing"}` and store it privately for the bridge.

After boot the device starts listening automatically once Studio is reachable;
tap its head to resume listening after it stops.

## Validation scope

- On hardware: 5 consecutive spoken turns were transcribed and answered with
  correct look-left, comforting emotion, explicit emotion and stop actions;
  agent consent survived a hard reset; rendering measured 12.1–13.2 FPS
  (6.8–7.4 FPS before the rendering changes); a 3-minute run showed no resets.
- Gate replay: 103 real device recordings from the same day were run through
  the new endpointing code — 19/19 transcribable utterances kept, 69/84
  non-speech uploads dropped.
- Host tests: 28/29 pass under clang. `test_care` does not compile under clang
  `-Warray-compare` on the unmodified baseline either. Bridge: 132 unit tests pass.
- Not yet validated: head-tap wake by a person, long-duration stability, the
  full-flash image on hardware, and other StackChan hardware revisions.

Known limits: half-duplex voice (no AEC, no spoken interruption, no wake word),
13–20 s from end of speech to spoken reply (Studio-side two-pass tool call and
whole-reply TTS), trusted-LAN HTTP without public-network hardening. See
[docs/CURRENT-FIRMWARE.md](docs/CURRENT-FIRMWARE.md) for the gap against the
roadmap.

## Third-party code

- `firmware/lib/PulseCameraDriver/` — Espressif `esp32-camera`, Apache-2.0
  ([LICENSE](firmware/lib/PulseCameraDriver/LICENSE), [UPSTREAM](firmware/lib/PulseCameraDriver/UPSTREAM.md)).
- `firmware/lib/PulseNetworkClient/` — Arduino-ESP32 `WiFiClient` with the
  upstream PR 10640 backport, LGPL-2.1 ([LICENSE](firmware/lib/PulseNetworkClient/LICENSE.md)).
- PlatformIO dependencies (M5Unified, M5GFX, ArduinoJson, WebSockets) are pinned
  in `firmware/platformio.ini` and downloaded at build time.
