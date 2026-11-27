#pragma once
#include <stddef.h>
#include <stdint.h>

namespace facecam {
constexpr size_t kSceneJpegCapacity = 65536;
constexpr uint32_t kSceneRequestTimeoutMs = 2000;
constexpr uint32_t kSceneMaximumAgeMs = 5000;
enum class SceneState : uint8_t { Missing, Pending, Ready, Busy, Unavailable };
struct SceneFrame {
  bool valid = false;
  uint32_t request_id = 0, frame_id = 0, captured_ms = 0, age_ms = 0, encode_ms = 0;
  uint16_t width = 320, height = 240;
  const uint8_t* pixels = nullptr; // Borrowed PSRAM; valid until releaseSceneFrame().
  size_t pixel_bytes = 0;
  const char* reason = "unavailable";
};
namespace scene {
// Caller serializes all state operations. No image allocation or writes occur
// under this state machine: an erase owner calls erased() only after clearing
// the complete image buffer outside its publication mutex.
class Slot {
 public:
  SceneState request(SceneFrame& result, uint32_t now, bool available, bool contended);
  bool beginFrame(uint32_t captured, uint16_t width, uint16_t height, uint32_t now);
  bool finish(size_t bytes, const char* error, uint32_t encodeMs, uint32_t now);
  SceneState take(uint32_t request, SceneFrame& result, const uint8_t* pixels, uint32_t now);
  bool maintain(uint32_t now);
  bool cancel();
  bool release();
  void erased();
  bool wantsFrame() const;
  bool blocksOther() const;
  bool erasingFailure() const;
  uint32_t frameId() const { return frame_.frame_id; }
 private:
  enum class Phase : uint8_t { Idle, Requested, Encoding, Erasing, Ready, Borrowed };
  bool eraseFor(const char* reason, bool discard);
  SceneFrame frame_;
  Phase phase_ = Phase::Idle;
  uint32_t serial_ = 0, frameSerial_ = 0, requested_ = 0;
  bool cancelled_ = false, discard_ = false;
};
struct JpegSink {
  uint8_t* pixels;
  size_t capacity, used;
  bool failed;
  JpegSink(uint8_t* p = nullptr, size_t c = 0, size_t u = 0, bool f = false)
      : pixels(p), capacity(c), used(u), failed(f) {}
};
// A short callback does not abort the vendor encoder, so failure is latched
// and must be checked independently after its fixed one-frame encoding pass.
size_t appendJpeg(void* context, size_t index, const void* data, size_t bytes);
bool validJpeg(const uint8_t* pixels, size_t bytes);
} // namespace scene
} // namespace facecam
