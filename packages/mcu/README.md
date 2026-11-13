# MCU firmware

| Family | Projects and artifacts |
| --- | --- |
| ESP32-C3 | Independent [v1](esp32-c3/v1/README.md) and [v2](esp32-c3/v2/README.md) PlatformIO projects; checked-in firmware under `esp32-c3/release/v1` and `esp32-c3/release/v2`. |
| ESP32-S3 | [Board-specific firmware](esp32-s3/README.md), currently M5Stack Cardputer-Adv. |
| M5Stack StackChan | [Planning workspace](m5stack-stackchan/README.md) and [product and development roadmap](m5stack-stackchan/docs/ROADMAP.md); firmware implementation is not included in this documentation change. |

## C3 upgrades

From the repository root, `npm run build` packages C3 firmware into
`dist/mcu/v1/firmware.bin` and `dist/mcu/v2/firmware.bin`. It prefers each
PlatformIO build output and falls back to that version's checked-in release
image. The v1 image is also copied to `dist/mcu/firmware.bin` for legacy devices.

Moving the source projects here does not change the OTA URLs. The versioned
`/api/studio/mcu/firmware/v1/` and `/api/studio/mcu/firmware/v2/` endpoints
remain separate, and the unversioned manifest/download endpoints stay pinned
to v1. Released `/api/hermes/mcu/` URLs continue through the existing
compatibility middleware. Development mode reads the respective project's
`.pio/build/esp32-c3-devkitm-1/firmware.bin` after a local `pio run`.

The root `mcu:v1:flash:clean` and `mcu:v2:flash:clean` commands still target
only their respective C3 projects. ESP32-S3 images retain their board-specific
installation requirements and are not served by the C3 OTA endpoints.
