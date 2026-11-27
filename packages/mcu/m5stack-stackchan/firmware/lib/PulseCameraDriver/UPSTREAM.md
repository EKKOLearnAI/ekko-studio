# Pinned ESP32-S3 camera driver

Upstream: https://github.com/espressif/esp32-camera

Commit: `f0bb42917cddcfba2c32c2e2fb2875b4fea11b7a` (2024-01-29).

This is the camera revision shipped with the Arduino ESP32 2.0.17 / ESP-IDF
4.4.7 SDK. The upstream Arduino library update records this revision:
https://github.com/espressif/arduino-esp32/pull/9339

Source archive:
https://codeload.github.com/espressif/esp32-camera/tar.gz/f0bb42917cddcfba2c32c2e2fb2875b4fea11b7a

Archive SHA-256:
`4776ab7b1ca394e5329e95d981bea603d56b036c146447d9ba189a8e3446f443`

All upstream files and licenses are retained. There is one driver change:
`driver/cam_hal.c` defines `CAM_TASK_STACK` as `4*1024` instead of using the
SDK's 2048-byte `CONFIG_CAMERA_TASK_STACK_SIZE`. Camera resolution, sensor
drivers, DMA handling, I2C behavior and diagnostics are otherwise unchanged.
This adds stack headroom; it does not establish that every possible cause of
the observed stack-canary failure has been eliminated.

The upstream `library.json` remains unchanged. The CoreS3 environment's
`tools/camera_driver_build.py` explicitly builds the source set selected by
upstream CMake for ESP32-S3 with the current IDF 4.4 SDK, removes the precompiled
SDK camera archive, and verifies the resulting link map. Other board
environments do not use this replacement.

The camera compile environment excludes `ARDUINO_ARCH_ESP32`, matching the
original SDK's ESP-IDF component build and preserving its normal tagged
`ESP_LOG` diagnostics. Application and other library build flags are unchanged.
