# M5Stack Cardputer-Adv firmware

Development-preview **LAN application update** for [M5Stack Cardputer-Adv](https://docs.m5stack.com/en/core/Cardputer-Adv): Stamp-S3A / ESP32-S3FN8, 8 MiB Flash, no PSRAM.

This firmware connects directly to an unmodified official Ekko Studio on the same local network. It provides a 16-Agent selection catalog, Chinese keyboard input, paged chat history, and Fn+Space voice input with a five-second RAM recording limit. Runtime installation, authorization, Profile permissions and model configuration determine which Agents can actually reply.

**仅适用于已安装本项目双固件布局的 M5Stack Cardputer-Adv；这是局域网开发预览版，不支持远程，也不是新机首刷包。**

## Artifact

- [Download the application](firmware/ekko-stock-lan-update-0x10000.bin) — **3,284,000 bytes**.
- Firmware version: `cardputer-adv-v9.0.0-dev.10-ram-lan`; release label: `v9.0.0-dev.10-lan`.
- SHA-256: `e753a1b04f22b249c962ad9fb304a5f193a6cd067bf41deedf6654eb0d8b2fb5`.
- [Manifest](manifest.json) describes the artifact; it is **not** a web-installer manifest or a registration with Studio's MCU OTA controller.

Identify this release by its label and full-file SHA-256. The ESP-IDF application descriptor retains SDK builder metadata and a 2024 timestamp; it is not this release's version or publication date.

## Existing-layout installation only

This image contains only the Ekko application. It does not contain a bootloader, partition table, factory application, NVS or personal settings. Flash capacity alone does not establish compatibility.

| Required existing layout | Value |
| --- | --- |
| Ekko application offset | `0x10000` |
| Ekko application partition size | `0x330000` |
| Existing independent factory application offset | `0x340000` |
| Partition-table range to verify | `0x8000`, length `0xC00` |
| Partition-table SHA-256 | `ca0c296c78733ef25a84d9077f534dc90adf32d510a9d6d0704e4b86a39ee479` |

The application ends at `0x331c20` (exclusive), leaving 58,336 bytes before the factory partition. **Do not write it at `0x0`, erase the whole chip, use the C3 `mcu:*:flash:clean` commands, or install it on a blank/unknown-layout device.**

Follow the [pinned installation guide](https://github.com/thursdaycapital/ekko-cardputer-adv-stock-lan/blob/473f3daec09da9cf829c6168a4c346279a5ec6ea/安装教程.zh-CN.md): privately back up the entire device, verify the existing partition-table hash, then update only `0x10000`. The guide uses a private backup directory outside the shareable package and gates writing on successful backup and checksum checks. Its application and checksum paths also match this board directory; use this directory as the command working directory. Run `shasum -a 256 -c SHA256SUMS.txt` from this board directory to verify this artifact.

Studio's existing ESP32-C3 `v1`/`v2` download and OTA endpoints remain C3-only. This board contribution provides a separate manual download; it does not add a Studio firmware selector or automatic update path.

## Binding and controls

1. Keep the computer and M5Stack Cardputer-Adv on the same trusted local network and run official Studio.
2. Open `http://<device-ip>/device`, choose the computer, log in with that Studio's account, and select an allowed Profile. A missing discovery entry can be added using the computer's LAN URL and actual port.
3. Select an Agent with the direction keys, press OK, and send a short text. Ctrl+Space switches Chinese/English; Tab browses history.
4. Hold Fn+Space to record, then release to send. Chat recording uses compressed RAM rather than SD; single recordings are limited to five seconds. The existing factory tools remain in the independent factory application.

A saved binding is reused on subsequent starts. This version has no remote relay path. Its local device-management HTTP endpoints have not received public-network hardening; use a trusted LAN, as detailed in the [known issues](https://github.com/thursdaycapital/ekko-cardputer-adv-stock-lan/blob/473f3daec09da9cf829c6168a4c346279a5ec6ea/已知问题.zh-CN.md).

## Validation scope

- On unmodified official Studio **0.7.36**, the user confirmed M5 text replies, microphone transcription, answers and audible playback. Short-record telemetry shows no capture overruns or audio write timeouts.
- On official Studio **0.7.37**, reconnection and a new M5 text reply were confirmed. Voice was not re-tested on 0.7.37 in that follow-up.
- The user confirmed five-second automatic stop. The independently captured health snapshot retained an earlier short recording, so a full five-second byte-count measurement is not claimed.
- The directory contains 16 Agents. Isolated official-backend tests obtained replies from 13 runtimes; this does not establish that all 16 runtimes passed physical-device acceptance.
- The complete mid-voice network-loss, token-time-expiry and stress matrix remains incomplete. Compilation and host tests are not physical acceptance.

See the [pinned acceptance record](https://github.com/thursdaycapital/ekko-cardputer-adv-stock-lan/blob/473f3daec09da9cf829c6168a4c346279a5ec6ea/验收范围.zh-CN.md) for the full distinction between user observations, device telemetry and host tests.

## Corresponding source and notices

This is the same binary and filename as the published development preview, under the board-specific M5Stack Cardputer-Adv directory. Complete firmware source, fixed dependencies, Arduino corresponding source and modification/relink instructions are available at immutable commit `473f3daec09da9cf829c6168a4c346279a5ec6ea`:

- [Complete corresponding source](https://github.com/thursdaycapital/ekko-cardputer-adv-stock-lan/tree/473f3daec09da9cf829c6168a4c346279a5ec6ea/source)
- [Build, modify and relink](https://github.com/thursdaycapital/ekko-cardputer-adv-stock-lan/blob/473f3daec09da9cf829c6168a4c346279a5ec6ea/RELINK.md)
- [Third-party notices](https://github.com/thursdaycapital/ekko-cardputer-adv-stock-lan/blob/473f3daec09da9cf829c6168a4c346279a5ec6ea/THIRD_PARTY_NOTICES.md)
- [Ekko BSL 1.1 text](https://github.com/thursdaycapital/ekko-cardputer-adv-stock-lan/blob/473f3daec09da9cf829c6168a4c346279a5ec6ea/LICENSE)
- [Arduino LGPL text](https://github.com/thursdaycapital/ekko-cardputer-adv-stock-lan/blob/473f3daec09da9cf829c6168a4c346279a5ec6ea/source/arduino-esp32-2.0.17/LICENSE.md)

Each third-party component or asset retains its own notices; the root license does not replace those terms or imply endorsement by the hardware or Agent brands. Private credentials, device codes, recordings and full Flash backups are not included.
