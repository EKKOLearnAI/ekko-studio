# ESP32-C3 Firmware v2

PlatformIO project for the 16MB ESP32-C3 hardware revision. Firmware v2 started
from the v1 application logic but keeps an independent `src/main.cpp`, so v2
hardware and audio tuning cannot change the v1 source or release firmware.

## Hardware

- Chip: ESP32-C3, 16MB flash
- I2C: SDA GPIO3, SCL GPIO4
- Battery ADC: GPIO2
- I2S: DOUT GPIO5, WS GPIO6, DIN GPIO7, BCK GPIO8, MCLK GPIO10
- BOOT button: GPIO9
- Power amplifier enable: GPIO11
- ES8311 address: `0x18`
- ES8311 DAC volume register: `0xBF` (0dB)
- Default playback volume: 80%
- Playback gain: displayed percentage × 1.5, with a 100% UI maximum and soft limiter
- OLED address: `0x3C` or `0x3D`

The custom partition table intentionally retains v1's proven 4MB dual-OTA
layout. The remaining physical flash is left unused until a larger storage or
OTA layout is explicitly required.

## Commands

```bash
cd packages/mcu/esp32-c3/v2
pio run
pio run -t upload
pio device monitor
```

From the repository root, build, erase, and upload v2 with:

```bash
npm run mcu:v2:flash:clean
```

After `pio run`, `npm run build` copies the firmware into
`packages/mcu/esp32-c3/release/v2/firmware.bin` and `dist/mcu/v2/firmware.bin`.
Firmware v2 checks only the version-isolated v2 OTA manifest and cannot consume
v1 updates.

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
