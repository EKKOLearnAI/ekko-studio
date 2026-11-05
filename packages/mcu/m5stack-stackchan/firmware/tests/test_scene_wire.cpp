#include "scene_wire.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <vector>

int main() {
  std::vector<uint8_t> jpeg(scene_wire::kMaximumJpegBytes, 0x55);
  jpeg[0] = 0xff; jpeg[1] = 0xd8;
  jpeg[jpeg.size()-2] = 0xff; jpeg[jpeg.size()-1] = 0xd9;
  std::vector<char> packet(scene_wire::kWireCapacity, 0);
  size_t written = 99;
  const char metadata[] = "eyJvayI6dHJ1ZX0=";
  assert(scene_wire::pack(metadata, strlen(metadata), jpeg.data(), jpeg.size(),
                          packet.data(), packet.size(), written));
  const char* boundary = strstr(packet.data(), "\r\n\r\n");
  assert(boundary);
  const size_t header = boundary + 4 - packet.data();
  assert(strstr(packet.data(), "Content-Type: image/jpeg\r\n"));
  assert(strstr(packet.data(), "Content-Length: 65536\r\n"));
  assert(strstr(packet.data(), "Cache-Control: no-store, private, max-age=0\r\n"));
  assert(strstr(packet.data(), "X-Pulse-Meta: eyJvayI6dHJ1ZX0=\r\n"));
  assert(written == header + jpeg.size());
  assert(!memcmp(packet.data()+header, jpeg.data(), jpeg.size()));
  assert(!scene_wire::pack(metadata, strlen(metadata), jpeg.data(), jpeg.size(),
                           packet.data(), written-1, written) && written == 0);
  assert(!scene_wire::pack("AA\r\nInjected: true", 18, jpeg.data(), jpeg.size(),
                           packet.data(), packet.size(), written) && written == 0);
  assert(!scene_wire::pack("=AAA", 4, jpeg.data(), jpeg.size(), packet.data(), packet.size(), written));
  assert(!scene_wire::pack("AAA", 3, jpeg.data(), jpeg.size(), packet.data(), packet.size(), written));
  assert(!scene_wire::pack("AB==", 4, jpeg.data(), jpeg.size(), packet.data(), packet.size(), written));
  assert(!scene_wire::pack("ABC=", 4, jpeg.data(), jpeg.size(), packet.data(), packet.size(), written));
  assert(!scene_wire::pack("AAAA\r\nAAAAAAAAAA", 16, jpeg.data(), jpeg.size(), packet.data(), packet.size(), written));
  assert(!scene_wire::pack(metadata, strlen(metadata), jpeg.data(), 0, packet.data(), packet.size(), written));
  assert(!scene_wire::pack(metadata, strlen(metadata), jpeg.data(), jpeg.size()+1,
                           packet.data(), packet.size(), written));
  jpeg[1] = 0;
  assert(!scene_wire::pack(metadata, strlen(metadata), jpeg.data(), jpeg.size(),
                           packet.data(), packet.size(), written));
  jpeg[1] = 0xd8;
  std::vector<char> longMetadata(scene_wire::kMaximumMetadataBytes+4, 'A');
  assert(!scene_wire::pack(longMetadata.data(), longMetadata.size(), jpeg.data(), jpeg.size(),
                           packet.data(), packet.size(), written));
  assert(!scene_wire::pack(nullptr, 4, jpeg.data(), jpeg.size(), packet.data(), packet.size(), written));
  assert(!scene_wire::pack(metadata, strlen(metadata), nullptr, jpeg.size(), packet.data(), packet.size(), written));
  assert(!scene_wire::pack(metadata, strlen(metadata), jpeg.data(), jpeg.size(), nullptr, packet.size(), written));
  puts("scene_wire: full-size JPEG framing, exact lengths, private no-store, bounded metadata and injection/overflow/null rejection passed");
}
