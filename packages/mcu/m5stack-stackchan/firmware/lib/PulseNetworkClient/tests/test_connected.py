#!/usr/bin/env python3
"""Compile the actual vendored connected() body against native socket fixtures.

No Arduino, PlatformIO, network listener or hardware is required. --source can
point at the pristine upstream file to demonstrate the original regression.
"""

import argparse
from pathlib import Path
import shutil
import subprocess
import tempfile


def connected_implementation(source: str) -> str:
    start = source.index("uint8_t WiFiClient::connected()")
    brace = source.index("{", start)
    depth = 1
    end = brace + 1
    while depth:
        if source[end] == "{":
            depth += 1
        elif source[end] == "}":
            depth -= 1
        end += 1
    return source[start:end]


PREAMBLE = r"""
#include <cassert>
#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <sys/socket.h>
#include <unistd.h>

// Match the device's ESP32/newlib ENOTCONN=128. Host recv() uses its native
// errno ABI (macOS ENOTCONN=57), so translate that one real error for the SUT.
static const int native_enotconn = ENOTCONN;
#undef ENOTCONN
#define ENOTCONN 128
#define log_d(...) ((void)0)
#define log_i(...) ((void)0)

static size_t recv_calls, recv_length;
static int recv_flags;
static ssize_t observed_recv(int fd, void* data, size_t count, int flags) {
  ++recv_calls; recv_length = count; recv_flags = flags;
  const ssize_t result = ::recv(fd, data, count, flags);
  if (result < 0 && errno == native_enotconn) errno = ENOTCONN;
  return result;
}
class WiFiClient {
 public:
  bool _connected;
  int socket_fd;
  explicit WiFiClient(int fd, bool connected=true) : _connected(connected), socket_fd(fd) {}
  int fd() const { return socket_fd; }
  uint8_t connected();
};
#define recv observed_recv
"""

TESTS = r"""
#undef recv
static void reset_observation() { recv_calls = recv_length = 0; recv_flags = 0; }
int main() {
  int pair[2];
  assert(socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0);
  WiFiClient client(pair[0]);

  reset_observation(); errno = ENOTCONN;
  assert(client.connected() == 1); // stale 128, healthy socket, no pending data
  assert(recv_calls == 1 && recv_length == 1 && (recv_flags & MSG_PEEK));
  assert(errno == EWOULDBLOCK || errno == EAGAIN);
  puts("PASS stale errno 128 with healthy idle socket");

  assert(write(pair[1], "x", 1) == 1);
  reset_observation(); errno = ENOTCONN;
  assert(client.connected() == 1); // pending Studio event + stale HTTP errno
  assert(recv_calls == 1 && recv_length == 1 && (recv_flags & MSG_PEEK));
  char byte = 0;
  assert(::recv(pair[0], &byte, 1, MSG_PEEK | MSG_DONTWAIT) == 1 && byte == 'x');
  assert(::recv(pair[0], &byte, 1, MSG_DONTWAIT) == 1 && byte == 'x');
  puts("PASS stale errno 128 with pending data; probe does not consume it");

  close(pair[1]); errno = ENOTCONN;
  assert(client.connected() == 0); // EOF must not consult stale errno
  close(pair[0]);
  puts("PASS orderly peer close");

  int unconnected = socket(AF_INET, SOCK_STREAM, 0); // no bind/listen/port
  assert(unconnected >= 0);
  WiFiClient broken(unconnected); errno = ENOTCONN;
  assert(broken.connected() == 0); // a real recv error (ENOTCONN)
  close(unconnected);
  puts("PASS real socket error");

  WiFiClient stopped(-1, false); reset_observation(); errno = ENOTCONN;
  assert(stopped.connected() == 0 && recv_calls == 0);
  puts("PASS stopped client does not probe a socket");
}
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1] / "vendor/WiFiClient.cpp")
    args = parser.parse_args()
    compiler = shutil.which("clang++") or shutil.which("g++")
    if not compiler:
        raise SystemExit("A host C++ compiler is required")
    body = connected_implementation(args.source.read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory(prefix="pulse-network-test-") as temporary:
        source = Path(temporary) / "connected.cpp"
        program = Path(temporary) / "connected-test"
        source.write_text(PREAMBLE + body + TESTS, encoding="utf-8")
        subprocess.run([compiler, "-std=c++11", "-O2", "-Wall", "-Wextra", "-Werror",
                        "-fsanitize=address,undefined", "-fno-omit-frame-pointer",
                        str(source), "-o", str(program)], check=True)
        subprocess.run([str(program)], check=True)


if __name__ == "__main__":
    main()
