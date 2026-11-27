# PulseNetworkClient

`vendor/WiFiClient.cpp` is the complete Espressif Arduino 2.0.17 translation
unit, with its original LGPL notice preserved. Only `WiFiClient::connected()`
is changed. No shared PlatformIO package is modified.

- Upstream repository: <https://github.com/espressif/arduino-esp32>
- Base tag: `2.0.17`
- Base commit: `5e19e086c43d0fa5e5a596497ff8f11a0a43f6c2`
- Base path: `libraries/WiFi/src/WiFiClient.cpp`
- Base SHA-256: `87f2786b1d7c4617eb4de7e0ada8da1da7c684c35da4ace39b3d051bfaf7494a`
- Upstream fix: <https://github.com/espressif/arduino-esp32/pull/10640>

The backport probes one byte with `MSG_PEEK | MSG_DONTWAIT`, preserving pending
application data. It reads `errno` only when `recv()` returns a negative value;
zero explicitly means an orderly peer close. Thus an earlier HTTP operation's
stale error (observed as newlib `ENOTCONN=128`) cannot disconnect a healthy
WebSocket in the same task. The explicit EOF branch complements the upstream
one-byte probe; all remaining translation-unit code is unchanged.

CoreS3's `pre:tools/network_client_build.py` middleware replaces only the
framework `WiFiClient.cpp` compilation input. It retains the original object
basename inside `libWiFi.a`, so the archiver replaces the cached member rather
than retaining both implementations. The library manifest excludes automatic
LDF compilation. The middleware validates the framework source fingerprint and
checks the final link map, archived object bytes, and unique linked symbol.

Run the native regression without PlatformIO or hardware:

```sh
python3 lib/PulseNetworkClient/tests/test_connected.py
```

The test compiles the actual vendored function body under ASan/UBSan. Its host
fixture maps native `ENOTCONN` to the ESP32/newlib value 128; the real host
`recv()` result is otherwise unchanged. It checks
stale errno 128 with idle/pending-data sockets, non-consuming probing, peer EOF,
a real socket error, and an already stopped client. Temporary build files are
automatically removed. The pristine upstream implementation fails the idle
socket assertion; the backport passes all cases.
