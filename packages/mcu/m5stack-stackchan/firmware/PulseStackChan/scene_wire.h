#pragma once
#include <stddef.h>
#include <stdint.h>

namespace scene_wire {
constexpr size_t kMaximumJpegBytes = 65536;
constexpr size_t kMaximumMetadataBytes = 1536;
constexpr size_t kHeaderReserve = 2048;
constexpr size_t kWireCapacity = kMaximumJpegBytes + kHeaderReserve;

// metadata is canonical single-line base64; images have a JPEG SOI/EOI envelope.
// Both inputs must be disjoint from output. No allocation, logging or I/O.
// On every failure written=0; output is not a usable response until success.
bool pack(const char* metadata, size_t metadataBytes, const uint8_t* jpeg,
          size_t jpegBytes, char* output, size_t capacity, size_t& written);
}
