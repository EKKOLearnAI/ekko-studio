#include "scene_wire.h"
#include <stdio.h>
#include <string.h>

namespace scene_wire {
namespace {
bool disjoint(const void* left, size_t leftSize, const void* right, size_t rightSize) {
  const uintptr_t a = reinterpret_cast<uintptr_t>(left);
  const uintptr_t b = reinterpret_cast<uintptr_t>(right);
  if (leftSize > UINTPTR_MAX-a || rightSize > UINTPTR_MAX-b) return false;
  return a+leftSize <= b || b+rightSize <= a;
}
bool base64(const char* value, size_t size) {
  if (!size || size > kMaximumMetadataBytes || size % 4) return false;
  bool padding = false;
  for (size_t i=0; i<size; ++i) {
    const char ch = value[i];
    if (ch == '=') {
      if (i < size-2) return false;
      padding = true;
    } else if (padding || !((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') ||
                            (ch >= '0' && ch <= '9') || ch == '+' || ch == '/')) return false;
  }
  // Padding carries no data: unused trailing bits must be zero as well.
  static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (value[size-1]=='=') {
    const bool two = value[size-2]=='=';
    const char* digit = strchr(alphabet, value[size-(two?3:2)]);
    if (!digit || ((digit-alphabet) & (two?15:3))) return false;
  }
  return true;
}
}
bool pack(const char* metadata, size_t metadataBytes, const uint8_t* jpeg,
          size_t jpegBytes, char* output, size_t capacity, size_t& written) {
  written = 0;
  if (!metadata || !jpeg || !output || !capacity || jpegBytes < 4 || jpegBytes > kMaximumJpegBytes ||
      !base64(metadata, metadataBytes) || jpeg[0] != 0xff || jpeg[1] != 0xd8 ||
      jpeg[jpegBytes-2] != 0xff || jpeg[jpegBytes-1] != 0xd9 ||
      !disjoint(metadata, metadataBytes, output, capacity) || !disjoint(jpeg, jpegBytes, output, capacity))
    return false;
  const int length = snprintf(output, capacity,
      "HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: %u\r\n"
      "X-Pulse-Meta: %.*s\r\nCache-Control: no-store, private, max-age=0\r\n"
      "Pragma: no-cache\r\nConnection: close\r\n\r\n",
      static_cast<unsigned>(jpegBytes), static_cast<int>(metadataBytes), metadata);
  if (length <= 0 || static_cast<size_t>(length) >= kHeaderReserve ||
      static_cast<size_t>(length) >= capacity || jpegBytes > capacity-static_cast<size_t>(length)) return false;
  memcpy(output+length, jpeg, jpegBytes);
  written = static_cast<size_t>(length)+jpegBytes;
  return true;
}
}
