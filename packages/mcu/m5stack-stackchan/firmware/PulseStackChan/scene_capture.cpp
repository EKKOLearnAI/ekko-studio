#include "scene_capture.h"
#include <string.h>

namespace facecam { namespace scene {
SceneState Slot::request(SceneFrame& result, uint32_t now, bool available, bool contended) {
  result = SceneFrame();
  if (phase_ != Phase::Idle) {
    result = frame_; result.valid = false; result.pixels = nullptr; result.reason = "scene_busy";
    return SceneState::Busy;
  }
  if (contended) { result.reason = "camera_busy"; return SceneState::Busy; }
  if (!available) { result.reason = "camera_unavailable"; return SceneState::Unavailable; }
  frame_ = SceneFrame();
  if (++serial_ == 0) ++serial_;
  frame_.request_id = serial_; frame_.reason = "pending";
  requested_ = now; cancelled_ = discard_ = false; phase_ = Phase::Requested;
  result = frame_;
  return SceneState::Pending;
}
bool Slot::beginFrame(uint32_t captured, uint16_t width, uint16_t height, uint32_t now) {
  if (phase_ != Phase::Requested || cancelled_ || now - requested_ >= kSceneRequestTimeoutMs ||
      static_cast<int32_t>(captured - requested_) < 0 || now - captured > 450 ||
      width != 320 || height != 240) return false;
  phase_ = Phase::Encoding;
  if (++frameSerial_ == 0) ++frameSerial_;
  frame_.frame_id = frameSerial_; frame_.captured_ms = captured;
  frame_.width = width; frame_.height = height;
  return true;
}
bool Slot::eraseFor(const char* reason, bool discard) {
  frame_.valid = false; frame_.pixels = nullptr; frame_.pixel_bytes = 0;
  frame_.reason = reason; discard_ = discard; phase_ = Phase::Erasing;
  return true;
}
bool Slot::finish(size_t bytes, const char* error, uint32_t encodeMs, uint32_t now) {
  if (phase_ != Phase::Encoding) return false;
  frame_.encode_ms = encodeMs; frame_.age_ms = now - frame_.captured_ms;
  if (cancelled_) return eraseFor("cancelled", true);
  if (now - requested_ >= kSceneRequestTimeoutMs) return eraseFor("request_timeout", false);
  if (frame_.age_ms >= kSceneMaximumAgeMs) return eraseFor("stale", false);
  if (error || bytes < 4 || bytes > kSceneJpegCapacity)
    return eraseFor(error ? error : "invalid_jpeg", false);
  frame_.valid = true; frame_.pixel_bytes = bytes; frame_.reason = "ready";
  phase_ = Phase::Ready;
  return false;
}
SceneState Slot::take(uint32_t request, SceneFrame& result, const uint8_t* pixels, uint32_t now) {
  result = SceneFrame();
  if (phase_ == Phase::Idle || !request || request != frame_.request_id) return SceneState::Missing;
  result = frame_; result.pixels = nullptr;
  result.age_ms = frame_.frame_id ? now - frame_.captured_ms : 0;
  if (phase_ == Phase::Borrowed) {
    result.valid = false; result.reason = "scene_borrowed"; return SceneState::Busy;
  }
  if (phase_ == Phase::Encoding && now - requested_ >= kSceneRequestTimeoutMs) {
    result.valid = false; result.pixel_bytes = 0; result.reason = "request_timeout";
    return SceneState::Unavailable; // The encoder retains ownership until finish/release cancellation.
  }
  if (phase_ != Phase::Ready) return SceneState::Pending;
  if (frame_.valid && !pixels) { result.valid = false; result.reason = "storage_unavailable"; return SceneState::Unavailable; }
  phase_ = Phase::Borrowed;
  if (frame_.valid) result.pixels = pixels;
  return SceneState::Ready;
}
bool Slot::maintain(uint32_t now) {
  if (phase_ == Phase::Requested && now - requested_ >= kSceneRequestTimeoutMs)
    return eraseFor("request_timeout", false);
  if (phase_ == Phase::Ready && frame_.valid && now - frame_.captured_ms >= kSceneMaximumAgeMs)
    return eraseFor("stale", false);
  if (phase_ == Phase::Ready && !frame_.valid && now - requested_ >= kSceneMaximumAgeMs)
    return eraseFor(frame_.reason, true);
  return false; // Never race an encoder, eraser or borrowed HTTP reader.
}
bool Slot::cancel() {
  cancelled_ = true;
  if (phase_ == Phase::Idle) return false;
  if (phase_ == Phase::Encoding || phase_ == Phase::Borrowed) return false;
  if (phase_ == Phase::Erasing) { discard_ = true; return false; }
  return eraseFor("cancelled", true);
}
bool Slot::release() {
  cancelled_ = true;
  if (phase_ == Phase::Idle || phase_ == Phase::Encoding) return false;
  if (phase_ == Phase::Erasing) { discard_ = true; return false; }
  return eraseFor("cancelled", true);
}
void Slot::erased() {
  if (phase_ != Phase::Erasing) return;
  if (discard_ || cancelled_) { frame_ = SceneFrame(); phase_ = Phase::Idle; }
  else phase_ = Phase::Ready;
  cancelled_ = discard_ = false;
}
bool Slot::wantsFrame() const { return phase_ == Phase::Requested; }
bool Slot::blocksOther() const { return phase_ != Phase::Idle; }
bool Slot::erasingFailure() const { return phase_ == Phase::Erasing && !discard_; }
size_t appendJpeg(void* context, size_t index, const void* data, size_t bytes) {
  if (!context) return 0;
  auto& sink = *static_cast<JpegSink*>(context);
  if (sink.failed) return 0;
  if (!sink.pixels || !sink.capacity || sink.capacity > kSceneJpegCapacity || index != sink.used ||
      sink.used > sink.capacity || bytes > sink.capacity - sink.used || (bytes && !data)) {
    sink.failed = true; return 0;
  }
  if (bytes) memcpy(sink.pixels + sink.used, data, bytes);
  sink.used += bytes;
  return bytes;
}
bool validJpeg(const uint8_t* pixels, size_t bytes) {
  return pixels && bytes >= 4 && bytes <= kSceneJpegCapacity && pixels[0] == 0xff && pixels[1] == 0xd8 &&
         pixels[bytes - 2] == 0xff && pixels[bytes - 1] == 0xd9;
}
} } // namespace facecam::scene
