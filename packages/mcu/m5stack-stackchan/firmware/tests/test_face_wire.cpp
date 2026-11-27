#include "face_camera.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <string>
#include <vector>

int main(int argc, char** argv) {
  // Standard base64 of synthetic JSON metadata. No real face or credentials.
  const char* metadata = argc == 3 && !strcmp(argv[1], "--wire") ? argv[2] : "eyJvayI6dHJ1ZX0=";
  uint8_t pixels[facecam::kSampleBytes];
  for (size_t i = 0; i < sizeof(pixels); ++i) pixels[i] = (uint8_t)((i * 37 + i / 64) & 255);
  std::vector<char> guarded(8194, (char)0xa5);
  char* wire = guarded.data() + 1;
  size_t written = 99;
  assert(facecam::sampling::packGray8Response(metadata, strlen(metadata), pixels, sizeof(pixels),
                                             wire, 8192, written));
  assert(written <= 5632 && guarded.front() == (char)0xa5 && guarded.back() == (char)0xa5);
  const std::string packet(wire, written);
  const size_t headerEnd = packet.find("\r\n\r\n");
  assert(headerEnd != std::string::npos && headerEnd + 4 <= 1536);
  assert(written - headerEnd - 4 == facecam::kSampleBytes);
  assert(!memcmp(wire + headerEnd + 4, pixels, sizeof(pixels)));
  assert(packet.find("Content-Type: application/vnd.pulse.gray8\r\n") != std::string::npos);
  assert(packet.find("Content-Length: 4096\r\n") != std::string::npos);
  assert(packet.find(std::string("X-Pulse-Meta: ") + metadata + "\r\n") != std::string::npos);
  assert(packet.find("Cache-Control: no-store") != std::string::npos);
  if (argc == 3 && !strcmp(argv[1], "--wire")) {
    assert(fwrite(wire, 1, written, stdout) == written);
    return 0;
  }
  assert(!facecam::sampling::packGray8Response(metadata, strlen(metadata), pixels, sizeof(pixels) - 1,
                                              wire, 8192, written) && written == 0);
  assert(!facecam::sampling::packGray8Response(metadata, strlen(metadata), pixels, sizeof(pixels),
                                              wire, 5631, written) && written == 0);
  assert(!facecam::sampling::packGray8Response("AAAA\r\nInjected:x", 16, pixels, sizeof(pixels),
                                              wire, 8192, written) && written == 0);
  assert(!facecam::sampling::packGray8Response("=AAA", 4, pixels, sizeof(pixels),
                                              wire, 8192, written) && written == 0);
  const std::string oversized(1536, 'A');
  assert(!facecam::sampling::packGray8Response(oversized.c_str(), oversized.size(), pixels, sizeof(pixels),
                                              wire, 8192, written) && written == 0);
  std::vector<uint8_t> jpeg(facecam::kSampleBytes + 1, 0x37);
  jpeg[0] = 0xff; jpeg[1] = 0xd8;
  for (size_t size : {size_t(4), size_t(1731), facecam::kSampleBytes}) {
    jpeg[size - 2] = 0xff; jpeg[size - 1] = 0xd9;
    std::vector<char> bounded(facecam::kGray8WireMaximum + 2, (char)0xa5);
    assert(facecam::sampling::packJpegResponse(metadata, strlen(metadata), jpeg.data(), size,
        bounded.data() + 1, facecam::kGray8WireMaximum, written));
    const std::string encoded(bounded.data() + 1, written);
    const size_t start = encoded.find("\r\n\r\n") + 4;
    assert(start >= 4 && start <= facecam::kGray8HeaderReserve);
    assert(written == start + size && written <= facecam::kGray8WireMaximum);
    assert(!memcmp(bounded.data() + 1 + start, jpeg.data(), size));
    assert(encoded.find("Content-Type: image/jpeg\r\n") != std::string::npos);
    assert(encoded.find("Content-Length: " + std::to_string(size) + "\r\n") != std::string::npos);
    assert(bounded.front() == (char)0xa5 && bounded.back() == (char)0xa5);
    jpeg[size - 2] = jpeg[size - 1] = 0x37;
  }
  jpeg[6] = 0xff; jpeg[7] = 0xd9;
  for (const std::string& invalid : {std::string("AAAA\r\nInjected:x"), std::string("AA_A"),
      std::string("A=AA"), std::string("=AAA"), std::string("AB=="), std::string("AAB="),
      std::string("AAAA="), std::string("AAA\0", 4), std::string("AAA "),
      std::string(""), std::string(1536, 'A')}) {
    assert(!facecam::sampling::packJpegResponse(invalid.data(), invalid.size(), jpeg.data(), 8,
        wire, 8192, written) && written == 0);
  }
  assert(facecam::sampling::packJpegResponse("AQ==", 4, jpeg.data(), 8, wire, 8192, written));
  assert(!facecam::sampling::packJpegResponse(metadata, strlen(metadata), jpeg.data(), 7,
      wire, 8192, written) && written == 0);  // Missing EOI.
  assert(!facecam::sampling::packJpegResponse(metadata, strlen(metadata), jpeg.data(), 3,
      wire, 8192, written) && written == 0);
  assert(!facecam::sampling::packJpegResponse(metadata, strlen(metadata), jpeg.data(), jpeg.size(),
      wire, 8192, written) && written == 0);
  assert(!facecam::sampling::packJpegResponse(metadata, strlen(metadata), jpeg.data(), 8,
      wire, 5631, written) && written == 0);
  jpeg[0] = 0;
  assert(!facecam::sampling::packJpegResponse(metadata, strlen(metadata), jpeg.data(), 8,
      wire, 8192, written) && written == 0);
  assert(guarded.front() == (char)0xa5 && guarded.back() == (char)0xa5);
  puts("face_wire: gray/JPEG bytes, media/length, <=5632 wire, canonical base64, guards/injection passed");
}
