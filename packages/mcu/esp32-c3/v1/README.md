# ESP32-C3 Wi-Fi Setup Firmware v1

PlatformIO source project for the ESP32-C3 Wi-Fi setup firmware.

The firmware manages Wi-Fi provisioning, the I2C OLED status UI, Hermes Web UI
and desktop discovery, MCU voice interaction, remote relay access, and OTA.

## Hardware

- Chip: ESP32-C3, 16MB flash
- I2C OLED: SDA GPIO3, SCL GPIO4, address `0x3C`

The current partition table uses the first 4MB for its dual-OTA layout. The
remaining physical flash is reserved for future storage or partition changes.

## Commands

```bash
cd packages/mcu/esp32-c3/v1
pio run
pio run -t upload
pio device monitor
```

After `pio run`, run `npm run build` from the repository root to sync the
firmware into `packages/mcu/esp32-c3/release/v1/firmware.bin` and package it into
`dist/mcu/v1/firmware.bin`. GitHub release builds reuse the checked-in release
firmware and do not build ESP32 firmware in CI.

## Speak Subtitles

During MCU speech playback, the OLED renders the active audio segment's text
with the compressed WenQuanYi 12px GB2312 font. Long text is wrapped into
three-line pages. Page timing follows elapsed playback time capped by queued
PCM or ADPCM sample progress, so DMA prebuffering cannot advance the first page
early. The playback progress bar is removed to make room for the third line.
The subtitle is cleared or replaced only when that audio segment finishes, is
interrupted, or the next segment starts. The complete audio-segment text is
retained for paging rather than being shortened to the OLED status-preview
length. Wrapped lines are prepared once before playback, and only the subtitle
rows are sent over I²C when the page changes.

## Voice Modes

The device page can switch between the existing push-to-talk mode and an
automatic listening mode. Automatic listening runs a lightweight VAD entirely
on the ESP32-C3 while the device is idle. It keeps about 250 ms of local
pre-roll, opens the existing ADPCM voice stream only after sustained
speech-like activity, and ends the turn after one second of silence.

Listening is suspended while a turn is transcribing, thinking, using tools, or
playing speech, so device playback cannot trigger a new turn. The existing
button controls remain unchanged: long press talks, single click stops the
current response, and double click clears the session.

## Agent Runtime

The device page can select Ekko or Hermes for MCU voice turns. Ekko is selected
by default, including after upgrading from firmware that did not have this
setting. The choice is stored in MCU preferences and sent with each voice turn.
Ekko and Hermes use separate deterministic session IDs, so their histories,
workspaces, and background tasks are never shared. Switching back to an agent
continues only that agent's own MCU session.

From the repository root, use:

```bash
npm run mcu:v1:flash:clean
```

The current macOS serial port is configured as:

```text
/dev/cu.usbmodem11101
```

If upload fails, hold `BOOT`, start upload, then release it after flashing
begins.

## First Boot

1. The device tries the saved Wi-Fi credentials first.
2. If Wi-Fi is missing or connection fails, it starts the open `Ekko Studio-WIFI`
   setup hotspot.
3. Join `Ekko Studio-WIFI` and open `http://192.168.4.1/`.
4. Select the target Wi-Fi SSID from the scanned list, or enter it manually,
   then enter the password and save.
5. The setup page connects once, shows the router-assigned IP, opens that IP,
   and the device restarts into normal Wi-Fi station mode.

Use `/clear` from the device page to clear saved Wi-Fi and return to setup mode.

## Idle Power Saving

After three minutes by default without a voice, audio, or status interaction,
the firmware turns off the OLED and power amplifier and enables Wi-Fi modem
power saving. The device page can set this timeout from 1 to 60 minutes, or set
it to 0 to disable automatic standby. Wi-Fi, the selected profile, and the
Socket.IO session stay connected. Pressing the Listen/BOOT button or receiving a
new MCU interaction immediately restores the low-latency Wi-Fi mode and turns
the OLED back on.

This is connected standby, not ESP32 deep sleep, so waking does not require a
Wi-Fi reconnect or a new login.

## LAN Device Discovery

After Wi-Fi is connected, open the device page and use the `设备` tab. The
firmware sends a UDP `hermes.discover` probe to the fixed Hermes discovery port
`48640`. Hermes Web UI and desktop responders return `hermes.announce` payloads
with their `endpoint_kind` (`web`, `desktop`, or `custom`) and HTTP port, so Web
and desktop endpoints are listed separately.

The device tab also includes an MCU login flow. Select a discovered or manually
added endpoint, enter the Hermes account and password, and the firmware posts to
`/api/auth/mcu-login`. On success it shows the returned profile list, stores the
selected profile locally, and connects to the selected Web UI `/global-agent`
Socket.IO namespace with the returned login token.
