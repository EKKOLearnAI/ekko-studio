#!/usr/bin/env python3
"""Exercise the installed SDK's HWCDC::write under USB backpressure.

Usage: python3 tests/test_usb_tx_timeout.py /path/to/framework-arduinoespressif32
The C++ function is extracted verbatim, never reimplemented. Only its hardware
dependencies are stubbed: connected USB, a full ring buffer, and successful
zero-byte sends. A simulated delay above 20 ms aborts a stuck write. Temporary
sources, binaries, and sanitizer artifacts are removed automatically.
"""

import argparse
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def extract_write(source):
    signature = re.search(
        r"size_t\s+HWCDC::write\s*\(\s*const\s+uint8_t\s*\*\s*buffer\s*,"
        r"\s*size_t\s+size\s*\)\s*\{", source
    )
    if not signature:
        raise ValueError("SDK HWCDC::write(buffer, size) definition not found")
    tokens = re.compile(r'//[^\n]*|/\*[\s\S]*?\*/|"(?:\\.|[^"\\])*"|'
                        r"'(?:\\.|[^'\\])*'|[{}]")
    depth = 0
    for token in tokens.finditer(source, signature.end() - 1):
        if token.group() == "{":
            depth += 1
        elif token.group() == "}":
            depth -= 1
            if depth == 0:
                return source[signature.start():token.end()]
    raise ValueError("Unterminated SDK HWCDC::write definition")


HARNESS = r"""
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>

static int ring_token, lock_token;
static void *tx_ring_buf = &ring_token, *tx_lock = &lock_token;
static uint32_t tx_timeout_ms, delayed_ms, zero_byte_sends;
static bool connected = true, locked = false;
constexpr int pdPASS = 1, pdTRUE = 1;
constexpr uint32_t portTICK_PERIOD_MS = 1;
constexpr uint32_t USB_SERIAL_JTAG_INTR_SERIAL_IN_EMPTY = 1;

static int xSemaphoreTake(void*, uint32_t) {
    if (locked) throw std::runtime_error("unexpected recursive lock");
    locked = true;
    return pdPASS;
}
static void xSemaphoreGive(void*) { locked = false; }
static size_t xRingbufferGetCurFreeSize(void*) { return 0; }
static int xRingbufferSend(void*, void*, size_t size, uint32_t) {
    if (size != 0) throw std::runtime_error("full ring accepted nonempty data");
    ++zero_byte_sends;
    return pdTRUE;
}
static void usb_serial_jtag_ll_txfifo_flush() {}
static void usb_serial_jtag_ll_ena_intr_mask(uint32_t) {}
static bool usb_serial_jtag_ll_txfifo_writable() { return false; }
static void log_w(const char*) {}
static void delay(uint32_t ms) {
    delayed_ms += ms;
    if (delayed_ms > 20) throw std::runtime_error("write exceeded 20 ms");
}
class HWCDC {
public:
    bool isCDC_Connected() const { return connected; }
    void flushTXBuffer(const uint8_t*, size_t) {}
    size_t write(const uint8_t*, size_t);
};
"""

MAIN = r"""
int main(int argc, char** argv) {
    if (argc != 2) return 3;
    tx_timeout_ms = static_cast<uint32_t>(std::stoul(argv[1]));
    const uint8_t payload[] = {0x55};
    HWCDC serial;
    try {
        size_t written = serial.write(payload, sizeof(payload));
        std::cout << "returned=" << written << " delayed_ms=" << delayed_ms
                  << " connected=" << connected << " lock_released=" << !locked
                  << " zero_byte_sends=" << zero_byte_sends << '\n';
        return written == 0 && !connected && !locked && zero_byte_sends > 0
               ? 0 : 3;
    } catch (const std::runtime_error& error) {
        std::cout << error.what() << "; delayed_ms=" << delayed_ms
                  << " connected=" << connected << " lock_held=" << locked
                  << " zero_byte_sends=" << zero_byte_sends << '\n';
        return delayed_ms > 20 && connected && locked && zero_byte_sends > 20
               ? 2 : 3;
    }
}
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sdk_root", type=Path)
    parser.add_argument("--app", type=Path, default=(
        Path(__file__).resolve().parents[1] / "PulseStackChan" / "app.cpp"))
    parser.add_argument("--compiler", default=os.environ.get("CXX", "clang++"))
    args = parser.parse_args()
    app = re.sub(r"//[^\n]*|/\*[\s\S]*?\*/", "", args.app.read_text())
    values = re.findall(r"\bSerial\.setTxTimeoutMs\s*\(\s*(\d+)\s*\)", app)
    if len(values) != 1:
        raise ValueError("Expected one literal Serial.setTxTimeoutMs in app.cpp")
    configured = int(values[0])
    sdk = args.sdk_root / "cores" / "esp32" / "HWCDC.cpp"
    function = extract_write(sdk.read_text())

    with tempfile.TemporaryDirectory(prefix="pulse-usb-tx-") as temporary:
        directory = Path(temporary)
        source, binary = directory / "probe.cpp", directory / "probe"
        source.write_text(HARNESS + "\n" + function + "\n" + MAIN)
        subprocess.run([
            args.compiler, "-std=c++17", "-O1", "-g", "-Wall", "-Wextra",
            "-pedantic", "-fsanitize=address,undefined", "-fno-omit-frame-pointer",
            str(source), "-o", str(binary),
        ], check=True)

        def probe(timeout):
            return subprocess.run([str(binary), str(timeout)], text=True,
                                  capture_output=True, timeout=5)

        zero, one = probe(0), probe(1)
        print("SDK:", sdk)
        print("0 ms control:", zero.stdout.strip())
        print("1 ms control:", one.stdout.strip())
        if zero.returncode != 2 or one.returncode != 0:
            print(zero.stderr + one.stderr, file=sys.stderr)
            print("FAIL: SDK behavior differs from this regression's assumptions")
            return 1
        current = zero if configured == 0 else one if configured == 1 else probe(configured)
        print(f"app.cpp configured {configured} ms:", current.stdout.strip())
        if current.returncode != 0:
            print(current.stderr, file=sys.stderr, end="")
            print("FAIL: configured HWCDC write did not return within 20 simulated ms")
            return 1
        print("PASS: full-buffer write exits and releases the TX lock")
        return 0


if __name__ == "__main__":
    sys.exit(main())
