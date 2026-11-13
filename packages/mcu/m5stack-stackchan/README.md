# M5Stack StackChan firmware

Dedicated development workspace for the new StackChan integration with Ekko Studio.
This board project lives directly under `packages/mcu/`, alongside the existing
`esp32-c3/` and `esp32-s3/` projects.

## Development status

This directory publishes the StackChan planning and interface contracts.
Experimental C++/ESP-IDF Wi-Fi/BLE firmware remains in the local development
workspace and is not included in this documentation change. No StackChan
firmware has been flashed or validated on the device; Studio integration and
voice support remain pending.

Planning currently takes priority over implementation. The
[StackChan product and development roadmap](docs/ROADMAP.md) records the
proposed product scope, device/Studio/App responsibilities, user flows,
development stages, and acceptance gates. App development, the animation
player implementation, and character asset production are deferred.

The target voice experience is continuous listening with automatic end-of-speech
submission and spoken interruption during playback. See the
[real-time voice design](docs/VOICE-INTERACTION.md) and the
[device action and future Studio MCP design](docs/DEVICE-CONTROL.md).
These are planned contracts; the prototype does not implement them yet.

Firmware will also expose animation discovery, playback, stop, and default-state
methods for the future Agent/MCP. The [animation control design](docs/ANIMATION-CONTROL.md)
defines playback ownership, cancellation, asset availability, and system UI priority.

## Initial milestones

1. Review the roadmap and confirm the device and recovery baseline.
2. When development resumes, finish the Wi-Fi/BLE prototype and board validation.
3. Connect to Studio over the LAN and verify authentication, state events, and reconnection.
4. Complete continuous voice interaction with AEC/VAD, automatic submission, Opus, subtitles, and spoken interruption.
5. Validate motion, animation scheduling, connected standby, stability, and board-specific updates.
6. Connect a future dedicated Studio Agent/MCP to the firmware's unified device methods.

Keep this board's firmware and future updates independent from the existing
C3 v1/v2 and Cardputer-Adv images. The current CoreS3 BSP and partition settings
are prototype choices; they do not establish compatibility with every StackChan
hardware or display revision.
