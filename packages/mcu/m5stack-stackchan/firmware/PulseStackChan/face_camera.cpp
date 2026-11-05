#include "face_camera.h"

#include <stdio.h>
#include <string.h>
#include <math.h>

namespace facecam { namespace sampling {
namespace {
int base64Value(unsigned char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}
bool packResponse(const char* metadata, size_t metadataLength,
                   const uint8_t* pixels, size_t pixelBytes, const char* mediaType,
                   char* response, size_t capacity, size_t& written) {
  written = 0;
  if (!metadata || !metadataLength || metadataLength > kGray8HeaderReserve ||
      metadataLength % 4 || !pixels || !pixelBytes || pixelBytes > kSampleBytes || !response ||
      capacity < kGray8WireMaximum) return false;
  bool padding = false;
  unsigned paddingCount = 0;
  for (size_t i = 0; i < metadataLength; ++i) {
    const unsigned char c = (unsigned char)metadata[i];
    if (c == '=') {
      if (i < metadataLength - 2 || ++paddingCount > 2) return false;
      padding = true;
    } else if (padding || base64Value(c) < 0) return false;
  }
  if (paddingCount && (base64Value((unsigned char)metadata[metadataLength - paddingCount - 1]) &
                       (paddingCount == 2 ? 15 : 3))) return false;
  const int header = snprintf(response, kGray8HeaderReserve,
      "HTTP/1.1 200 OK\r\nContent-Type: %s\r\n"
      "Content-Length: %u\r\nX-Pulse-Meta: %.*s\r\n"
      "Cache-Control: no-store, private, max-age=0\r\nPragma: no-cache\r\nConnection: close\r\n\r\n",
      mediaType, (unsigned)pixelBytes, (int)metadataLength, metadata);
  if (header <= 0 || (size_t)header >= kGray8HeaderReserve) return false;
  memmove(response + header, pixels, pixelBytes);
  written = header + pixelBytes;
  return written <= kGray8WireMaximum;
}
}  // namespace

bool validJpeg(const uint8_t* pixels, size_t bytes) {
  return pixels && bytes >= 4 && bytes <= kSampleBytes &&
         pixels[0] == 0xff && pixels[1] == 0xd8 &&
         pixels[bytes - 2] == 0xff && pixels[bytes - 1] == 0xd9;
}

size_t appendJpeg(void* context, size_t index, const void* data, size_t bytes) {
  if (!context) return 0;
  JpegSink& sink = *static_cast<JpegSink*>(context);
  if (sink.failed) return 0;
  // jpge may finish with put_buf(nullptr, 0). It contributes no bytes.
  if (index != sink.used || !sink.pixels || sink.capacity > kSampleBytes || sink.used > sink.capacity ||
      bytes > sink.capacity - sink.used || (bytes && !data)) {
    sink.failed = true;
    return 0;
  }
  if (bytes) memcpy(sink.pixels + sink.used, data, bytes);
  sink.used += bytes;
  return bytes;
}

bool packGray8Response(const char* metadata, size_t metadataLength,
                       const uint8_t* pixels, size_t pixelBytes,
                       char* response, size_t capacity, size_t& written) {
  written = 0;
  return pixelBytes == kSampleBytes && packResponse(metadata, metadataLength, pixels,
      pixelBytes, "application/vnd.pulse.gray8", response, capacity, written);
}

bool packJpegResponse(const char* metadata, size_t metadataLength,
                      const uint8_t* pixels, size_t pixelBytes,
                      char* response, size_t capacity, size_t& written) {
  written = 0;
  return validJpeg(pixels, pixelBytes) && packResponse(metadata, metadataLength, pixels,
      pixelBytes, "image/jpeg", response, capacity, written);
}

FrameAdmission frameAdmission(uint32_t captured, uint32_t now,
                               bool havePreviousBoundary, uint32_t previousBoundary,
                               unsigned alreadyDiscarded) {
  if (alreadyDiscarded >= kMaximumBacklogDiscards) return FrameAdmission::Limit;
  const uint32_t age = now - captured;
  // Reject a future/incomparable timestamp; all legitimate camera frames are
  // far less than uint32 half a range old, including uptime wraparound.
  if (age >= 0x80000000u) return FrameAdmission::InvalidTimestamp;
  const bool queuedDuringPreviousWork = havePreviousBoundary &&
                                        ((captured - previousBoundary) & 0x80000000u);
  if (!queuedDuringPreviousWork && age <= 450) return FrameAdmission::Use;
  return alreadyDiscarded + 1 >= kMaximumBacklogDiscards
           ? FrameAdmission::Limit : FrameAdmission::Discard;
}

const char* expiryReason(uint32_t now, uint32_t captured, uint32_t requested, bool haveFrame) {
  if (haveFrame && now - captured > 450) return "stale";
  if (now - requested > 1200) return "timeout";
  return nullptr;
}

const char* frameRejection(const facetrack::Snapshot& target, const Detection& d,
                           uint32_t now) {
  if (target.ambiguous) return "ambiguous";
  if (!d.count) return "no_face";
  if (!target.locked || !target.lock_id) return "unlocked";
  if (!target.tracking) return "target_lost";
  if (now - d.captured_ms > 450 || target.lost_ms > 450) return "stale";
  return nullptr;
}

const char* requestAdmissionReason(bool available, const facetrack::Snapshot& target,
                                   const Detection& previous, uint32_t) {
  if (!available) return "disabled";
  if (target.ambiguous) return "ambiguous";
  if (!target.locked || !target.lock_id) return previous.count ? "unlocked" : "no_face";
  // Admission asks the worker for a subsequent observation of this lock. The
  // previous observation can be old or temporarily lost; it supplies no image.
  // Selection and consumption still require frameRejection on the new frame.
  return nullptr;
}

const char* qualityReason(const facetrack::BBox& b, int width, int height,
                          const int* landmarks, size_t count) {
  if (width <= 0 || height <= 0 || !isfinite(b.x1) || !isfinite(b.y1) ||
      !isfinite(b.x2) || !isfinite(b.y2) || !isfinite(b.score) ||
      b.x2 <= b.x1 || b.y2 <= b.y1) return "invalid_box";
  if (b.score < .80f) return "low_confidence";
  const float w = b.x2 - b.x1, h = b.y2 - b.y1;
  if (w < 32.f || h < 32.f) return "face_too_small";
  if (b.x1 < 2.f || b.y1 < 2.f || b.x2 > width - 2.f || b.y2 > height - 2.f)
    return "clipped";
  if (w / h < .55f || w / h > 1.25f || !landmarks || count < 10)
    return "occlusion_suspected";
  for (size_t i = 0; i < 10; i += 2)
    if (landmarks[i] <= b.x1 || landmarks[i] >= b.x2 ||
        landmarks[i + 1] <= b.y1 || landmarks[i + 1] >= b.y2)
      return "occlusion_suspected";
  // Legacy MNP01: left eye, mouth left, nose, right eye, mouth right.
  const float eyes = fabsf((float)landmarks[0] - landmarks[6]);
  const float mouth = fabsf((float)landmarks[2] - landmarks[8]);
  const float eyeY = (landmarks[1] + landmarks[7]) * .5f;
  const float mouthY = (landmarks[3] + landmarks[9]) * .5f;
  if (eyes < .18f * w || eyes > .75f * w ||
      fabsf((float)landmarks[1] - landmarks[7]) > .18f * h ||
      mouth < .12f * w || mouth > .80f * w ||
      landmarks[5] < eyeY + .06f * h || mouthY < landmarks[5] + .04f * h)
    return "occlusion_suspected";
  return nullptr;
}

int exactTargetIndex(const Detection& d, const facetrack::Snapshot& s) {
  if (!s.locked || !s.tracking || s.ambiguous || !s.lock_id ||
      d.width <= 0 || d.height <= 0 || d.count > 8) return -1;
  int found = -1;
  for (size_t i = 0; i < d.count; ++i) {
    const auto& b = d.boxes[i];
    // Controller normalizes and restores these coordinates, causing only tiny
    // float round-off. This is exact detection correspondence, not association.
    if (fabsf(b.x1 - s.target.x1) <= .05f && fabsf(b.y1 - s.target.y1) <= .05f &&
        fabsf(b.x2 - s.target.x2) <= .05f && fabsf(b.y2 - s.target.y2) <= .05f &&
        fabsf(b.score - s.target.score) <= .0001f) {
      if (found >= 0) return -1;  // Duplicate boxes cannot authorize a crop.
      found = (int)i;
    }
  }
  return found;
}

bool cropGray64(const uint8_t* src, size_t bytes, int width, int height,
                const facetrack::BBox& b, uint8_t* out, size_t capacity) {
  if (!src || !out || capacity < kSampleBytes || width <= 0 || height <= 0 ||
      width > 4096 || height > 4096 || bytes != (size_t)width * height * 2 ||
      !isfinite(b.x1) || !isfinite(b.y1) || !isfinite(b.x2) || !isfinite(b.y2) ||
      b.x1 < 0 || b.y1 < 0 || b.x2 > width || b.y2 > height ||
      b.x2 <= b.x1 || b.y2 <= b.y1) return false;
  const int left = (int)floorf(b.x1), top = (int)floorf(b.y1);
  const int right = (int)ceilf(b.x2), bottom = (int)ceilf(b.y2);
  for (size_t y = 0; y < kSampleSide; ++y) {
    const int sy = top + (int)((2 * y + 1) * (bottom - top) / (2 * kSampleSide));
    for (size_t x = 0; x < kSampleSide; ++x) {
      const int sx = left + (int)((2 * x + 1) * (right - left) / (2 * kSampleSide));
      const size_t offset = ((size_t)sy * width + sx) * 2;
      // GC0308/SDK inference uses network-order RGB565 bytes, not native-endian
      // uint16_t colors. Keep all output rows in the camera's original order.
      const uint16_t p = ((uint16_t)src[offset] << 8) | src[offset + 1];
      const unsigned r5 = p >> 11, g6 = (p >> 5) & 63, b5 = p & 31;
      const unsigned r = (r5 << 3) | (r5 >> 2);
      const unsigned g = (g6 << 2) | (g6 >> 4);
      const unsigned blue = (b5 << 3) | (b5 >> 2);
      out[y * kSampleSide + x] = (uint8_t)((77 * r + 150 * g + 29 * blue + 128) >> 8);
    }
  }
  return true;
}

bool squareCrop(int width, int height, const facetrack::BBox& b, SquareCrop& roi) {
  roi = SquareCrop();
  if (width <= 0 || height <= 0 || width > 4096 || height > 4096 ||
      !isfinite(b.x1) || !isfinite(b.y1) || !isfinite(b.x2) || !isfinite(b.y2) ||
      b.x1 < 0 || b.y1 < 0 || b.x2 > width || b.y2 > height ||
      b.x2 <= b.x1 || b.y2 <= b.y1) return false;
  const float longest = fmaxf(b.x2 - b.x1, b.y2 - b.y1);
  const float available = (float)(width < height ? width : height);
  // A square inside the image must still enclose the entire detection. When
  // impossible, reject instead of distorting or silently clipping the face.
  if (longest < 1.f || longest > available) return false;
  roi.side = fminf(longest * 1.15f, available);
  roi.left = fmaxf(0.f, fminf((b.x1 + b.x2 - roi.side) * .5f, width - roi.side));
  roi.top = fmaxf(0.f, fminf((b.y1 + b.y2 - roi.side) * .5f, height - roi.side));
  return true;
}

namespace {
struct AxisSample {
  uint16_t low, high, fraction;
};
void prepareAxis(AxisSample* axis, float origin, float scale, int limit, unsigned stride) {
  for (size_t i = 0; i < kJpegSampleSide; ++i) {
    const float position = fmaxf(0.f, fminf(origin + (i + .5f) * scale - .5f, limit - 1.f));
    const unsigned low = (unsigned)position; // Nonnegative truncation is floor.
    const unsigned high = low + 1 < (unsigned)limit ? low + 1 : low;
    axis[i].low = (uint16_t)(low * stride);
    axis[i].high = (uint16_t)(high * stride);
    axis[i].fraction = (uint16_t)((position - low) * 256.f + .5f);
  }
}
inline unsigned read565(const uint8_t* pixel) {
  return ((unsigned)pixel[0] << 8) | pixel[1];
}
inline unsigned interpolateChannel(unsigned p00, unsigned p01, unsigned p10, unsigned p11,
                                    unsigned fx, unsigned fy) {
  // Native 5/6-bit components, Q8 horizontal and Q16 vertical. Signed
  // differences use three bounded multiplies, never exceeding +/-63*65536.
  // Q8 coordinate error is <=1/512 per axis. At dimensions <=4096, float
  // coordinate preparation adds <1/1024 per axis; expanded-RGB8 rounding
  // adds <=.3 of a 6-bit code. Combined pre-quantization error is <.67 code,
  // hence nearest output differs from ideal RGB8 bilinear by at most one code.
  const int upper = ((int)p00 << 8) + ((int)p01 - (int)p00) * (int)fx;
  const int lower = ((int)p10 << 8) + ((int)p11 - (int)p10) * (int)fx;
  return (unsigned)(((upper << 8) + (lower - upper) * (int)fy + 32768) >> 16);
}
}

bool cropRgb112(const uint8_t* src, size_t bytes, int width, int height,
                const facetrack::BBox& b, const float* landmarks, size_t landmarkCount,
                uint8_t* out, size_t capacity, float* mapped, size_t mappedCount) {
  SquareCrop roi;
  if (!src || !out || capacity < kJpegScratchBytes || !landmarks || landmarkCount < 10 ||
      !mapped || mappedCount < 10 || !squareCrop(width, height, b, roi) ||
      bytes != (size_t)width * height * 2) return false;
  for (size_t i = 0; i < 10; i += 2)
    if (!isfinite(landmarks[i]) || !isfinite(landmarks[i + 1]) ||
        landmarks[i] < b.x1 || landmarks[i] > b.x2 ||
        landmarks[i + 1] < b.y1 || landmarks[i + 1] > b.y2) return false;
  const float scale = roi.side / kJpegSampleSide;
  AxisSample columns[kJpegSampleSide], rows[kJpegSampleSide];
  // 2 * 112 * 6 bytes on the worker stack; no per-call heap or image copy.
  // Column entries are byte offsets, row entries are source row numbers.
  prepareAxis(columns, roi.left, scale, width, 2);
  prepareAxis(rows, roi.top, scale, height, 1);
  uint8_t* destination = out;
  for (size_t y = 0; y < kJpegSampleSide; ++y) {
    const uint8_t* upper = src + (size_t)rows[y].low * width * 2;
    const uint8_t* lower = src + (size_t)rows[y].high * width * 2;
    const unsigned fy = rows[y].fraction;
    for (size_t x = 0; x < kJpegSampleSide; ++x) {
      const AxisSample& column = columns[x];
      const unsigned p00 = read565(upper + column.low), p01 = read565(upper + column.high);
      const unsigned p10 = read565(lower + column.low), p11 = read565(lower + column.high);
      const unsigned fx = column.fraction;
      const unsigned r = interpolateChannel(p00 >> 11, p01 >> 11, p10 >> 11, p11 >> 11, fx, fy);
      const unsigned g = interpolateChannel((p00 >> 5) & 63, (p01 >> 5) & 63,
                                             (p10 >> 5) & 63, (p11 >> 5) & 63, fx, fy);
      const unsigned blue = interpolateChannel(p00 & 31, p01 & 31, p10 & 31, p11 & 31, fx, fy);
      const unsigned p = (r << 11) | (g << 5) | blue;
      *destination++ = (uint8_t)(p >> 8); *destination++ = (uint8_t)p;
    }
  }
  constexpr size_t order[] = {0, 6, 4, 2, 8};
  for (size_t p = 0; p < 5; ++p) {
    mapped[2 * p] = (landmarks[order[p]] + .5f - roi.left) / scale - .5f;
    mapped[2 * p + 1] = (landmarks[order[p] + 1] + .5f - roi.top) / scale - .5f;
  }
  return true;
}
} }  // namespace facecam::sampling

#if defined(ARDUINO_ARCH_ESP32) || defined(ESP_PLATFORM)
#include <sdkconfig.h>
#endif

#if defined(PULSE_FACE_FOLLOW) && PULSE_FACE_FOLLOW && defined(CONFIG_IDF_TARGET_ESP32S3)

#include <Arduino.h>
#include <M5Unified.h>
#include <cmath>
#include <memory>
#include <new>
#include <vector>
#include <esp_camera.h>
#include <img_converters.h>
#include <esp_heap_caps.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <human_face_detect_msr01.hpp>
#include <human_face_detect_mnp01.hpp>

// Exported by the pinned Arduino 2.0.17 camera component. Unlike deleting the
// IDF I2C driver directly, this also clears SCCB's controller-ownership flag.
extern "C" int SCCB_Deinit(void);

namespace facecam {
namespace {
constexpr uint32_t kIntervalMs = 200;  // Sampling budget, not a measured FPS.
constexpr uint32_t kMaximumFrameAgeMs = 450;
portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
Status s_status;
Detection s_latest;
Snapshot s_snapshot;
const uint16_t* s_snapshotBorrowed = nullptr;
bool s_pending = false, s_snapshotRequested = false, s_stop = false;
uint32_t s_generation = 0, s_sequence = 0;
TaskHandle_t s_worker = nullptr;
SemaphoreHandle_t s_stopped = nullptr;
scene::Slot s_scene;
uint8_t* s_scenePixels = nullptr; // A single JPEG buffer; never a driver framebuffer.

void eraseSceneStorage() {
  if (s_scenePixels) memset(s_scenePixels, 0, kSceneJpegCapacity);
  portENTER_CRITICAL(&s_mux); s_scene.erased(); portEXIT_CRITICAL(&s_mux);
}
void maintainScene(uint32_t now) {
  portENTER_CRITICAL(&s_mux);
  const bool erase = s_scene.maintain(now);
  if (erase && s_scene.erasingFailure()) ++s_status.scene_errors;
  portEXIT_CRITICAL(&s_mux);
  if (erase) eraseSceneStorage();
}
bool sceneRequested() {
  portENTER_CRITICAL(&s_mux);
  const bool requested = s_status.running && s_status.initialized && !s_stop && s_scene.wantsFrame();
  portEXIT_CRITICAL(&s_mux);
  return requested;
}

enum class SamplePhase : uint8_t { Idle, Requested, Cropping, Selecting, AwaitSelection, Ready, Borrowed };
struct SampleStorage {
  Detection observation;
  uint8_t crops[8][kSampleBytes];
  size_t pixel_bytes[8] = {};
  float landmarks[8][10] = {};
};
SampleStorage* s_sampleStorage = nullptr;  // All image bytes are PSRAM only.
uint8_t* s_jpegScratch = nullptr;  // One reusable 112x112 RGB565BE PSRAM crop.
SamplePhase s_samplePhase = SamplePhase::Idle;
FaceSample s_sample;
facetrack::Snapshot s_tracking;
Detection s_trackingObservation;
uint32_t s_sampleSerial = 0, s_sampleAt = 0, s_sampleGeneration = 0;
uint32_t s_trackSerial = 0, s_publicTrack = 0, s_trackerId = 0;
bool s_wasLocked = false;

void eraseCrops(int keep = -1) {
  if (!s_sampleStorage) return;
  for (int i = 0; i < 8; ++i) {
    if (i == keep) continue;
    memset(s_sampleStorage->crops[i], 0, kSampleBytes);
    s_sampleStorage->pixel_bytes[i] = 0;
    memset(s_sampleStorage->landmarks[i], 0, sizeof(s_sampleStorage->landmarks[i]));
  }
}

void saveSampleCandidates(const camera_fb_t& frame, const Detection& result,
                          uint32_t generation) {
  portENTER_CRITICAL(&s_mux);
  const bool wanted = s_samplePhase == SamplePhase::Requested &&
                      s_sampleStorage && s_sampleGeneration == generation;
  const bool jpeg = s_sample.jpeg;
  if (wanted) s_samplePhase = SamplePhase::Cropping;
  portEXIT_CRITICAL(&s_mux);
  if (!wanted) return;
  s_sampleStorage->observation = result;
  for (size_t i = 0; i < result.count; ++i) {
    if (result.sample_quality[i]) continue;
    uint8_t* crop = s_sampleStorage->crops[i];
    bool valid;
    if (jpeg) {
      const uint32_t preparedAt = millis();
      const uint32_t cropAt = micros();
      valid = s_jpegScratch && sampling::cropRgb112(frame.buf, frame.len,
          result.width, result.height, result.boxes[i], result.landmarks[i], 10,
          s_jpegScratch, kJpegScratchBytes, s_sampleStorage->landmarks[i], 10);
      const uint32_t cropMs = (uint32_t)(micros() - cropAt) / 1000;
      sampling::JpegSink sink;
      sink.pixels = crop; sink.capacity = kSampleBytes;
      uint32_t encodeMs = 0;
      if (valid) {
        const uint32_t encodeAt = micros();
        valid = fmt2jpg_cb(s_jpegScratch, kJpegScratchBytes, kJpegSampleSide,
            kJpegSampleSide, PIXFORMAT_RGB565, 75, sampling::appendJpeg, &sink);
        encodeMs = (uint32_t)(micros() - encodeAt) / 1000;
      }
      valid = valid && !sink.failed && sampling::validJpeg(crop, sink.used);
      if (s_jpegScratch) memset(s_jpegScratch, 0, kJpegScratchBytes);
      if (valid) s_sampleStorage->pixel_bytes[i] = sink.used;
      const uint32_t stackBytes = uxTaskGetStackHighWaterMark(nullptr);
      const uint32_t preparedMs = millis() - preparedAt;
      portENTER_CRITICAL(&s_mux);
      ++s_status.jpeg_crops;
      if (valid) ++s_status.jpeg_ready;
      s_status.jpeg_prepare_ms = preparedMs;
      s_status.jpeg_crop_ms = cropMs; s_status.jpeg_encode_ms = encodeMs;
      s_status.worker_stack_bytes = stackBytes;
      portEXIT_CRITICAL(&s_mux);
    } else {
      valid = sampling::cropGray64(frame.buf, frame.len, result.width, result.height,
                                   result.boxes[i], crop, kSampleBytes);
      if (valid) s_sampleStorage->pixel_bytes[i] = kSampleBytes;
    }
    if (!valid) {
      memset(crop, 0, kSampleBytes);
      memset(s_sampleStorage->landmarks[i], 0, sizeof(s_sampleStorage->landmarks[i]));
      s_sampleStorage->pixel_bytes[i] = 0;
      s_sampleStorage->observation.sample_quality[i] = "invalid_pixels";
    }
  }
  portENTER_CRITICAL(&s_mux);
  const bool current = s_status.enabled && !s_stop && generation == s_generation;
  const char* expired = sampling::expiryReason(millis(), result.captured_ms, s_sampleAt, true);
  s_sample.frame_id = result.sequence;
  s_sample.captured_ms = result.captured_ms;
  s_sample.faces = result.count;
  portEXIT_CRITICAL(&s_mux);
  if (!current || expired) eraseCrops();
  portENTER_CRITICAL(&s_mux);
  s_sample.reason = !current ? "disabled" : (expired ? expired : "pending");
  s_samplePhase = current && !expired ? SamplePhase::AwaitSelection : SamplePhase::Ready;
  portEXIT_CRITICAL(&s_mux);
}

void error(const char* message) {
  portENTER_CRITICAL(&s_mux);
  ++s_status.errors;
  snprintf(s_status.error, sizeof(s_status.error), "%s", message);
  portEXIT_CRITICAL(&s_mux);
  Serial.printf("[facecam] %s\n", message);
}

void cameraError(const char* context, esp_err_t code) {
  char message[96];
  snprintf(message, sizeof(message), "%s: %s (0x%x)", context,
           esp_err_to_name(code), (unsigned)code);
  error(message);
}

uint32_t frameMillis(const camera_fb_t& frame) {
  const uint64_t us = (uint64_t)frame.timestamp.tv_sec * 1000000ULL +
                      (uint64_t)frame.timestamp.tv_usec;
  return (uint32_t)(us / 1000ULL);
}

bool enabled(uint32_t& generation) {
  portENTER_CRITICAL(&s_mux);
  const bool on = s_status.enabled && !s_stop;
  generation = s_generation;
  portEXIT_CRITICAL(&s_mux);
  return on;
}

bool stillCurrent(uint32_t generation) {
  portENTER_CRITICAL(&s_mux);
  const bool valid = s_status.enabled && !s_stop && generation == s_generation;
  portEXIT_CRITICAL(&s_mux);
  return valid;
}
bool frameWorkCurrent(uint32_t generation) { return stillCurrent(generation) || sceneRequested(); }

void saveSceneFrame(const camera_fb_t& frame) {
  portENTER_CRITICAL(&s_mux);
  const bool wanted = !s_stop && s_scenePixels && s_scene.beginFrame(frameMillis(frame),
      static_cast<uint16_t>(frame.width), static_cast<uint16_t>(frame.height), millis());
  portEXIT_CRITICAL(&s_mux);
  if (!wanted) return;
  // Exactly one fixed QVGA/Q75 pass on the sole camera consumer. Tracking was
  // published before this call. Vendor callbacks cannot abort CPU work early;
  // latch failures and never publish a truncated/cancelled image as valid.
  scene::JpegSink sink(s_scenePixels, kSceneJpegCapacity);
  const uint32_t started = millis();
  const bool encoded = fmt2jpg_cb(frame.buf, frame.len, frame.width, frame.height,
      PIXFORMAT_RGB565, 75, scene::appendJpeg, &sink);
  const uint32_t encodeMs = millis() - started;
  const char* failure = sink.failed ? "jpeg_too_large" : !encoded ? "jpeg_encode_failed" :
      !scene::validJpeg(s_scenePixels, sink.used) ? "invalid_jpeg" : nullptr;
  const uint32_t stackBytes = uxTaskGetStackHighWaterMark(nullptr);
  portENTER_CRITICAL(&s_mux);
  const bool erase = s_scene.finish(sink.used, failure, encodeMs, millis());
  s_status.scene_frame_id = s_scene.frameId(); s_status.scene_encode_ms = encodeMs;
  if (erase && s_scene.erasingFailure()) ++s_status.scene_errors;
  s_status.worker_stack_bytes = stackBytes;
  portEXIT_CRITICAL(&s_mux);
  if (erase) eraseSceneStorage();
}

void stale() {
  portENTER_CRITICAL(&s_mux);
  ++s_status.stale_frames;
  portEXIT_CRITICAL(&s_mux);
}

void saveSnapshot(const camera_fb_t& frame, const Detection& result,
                  uint32_t generation) {
  portENTER_CRITICAL(&s_mux);
  const bool wanted = s_snapshotRequested && !s_snapshot.pixels;
  portEXIT_CRITICAL(&s_mux);
  if (!wanted) return;
  auto* copy = static_cast<uint16_t*>(heap_caps_malloc(frame.len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!copy) {
    portENTER_CRITICAL(&s_mux);
    s_snapshotRequested = false;
    portEXIT_CRITICAL(&s_mux);
    error("snapshot PSRAM allocation failed");
    return;
  }
  memcpy(copy, frame.buf, frame.len);
  portENTER_CRITICAL(&s_mux);
  const bool keep = s_snapshotRequested && !s_snapshot.pixels &&
                    s_status.enabled && !s_stop && generation == s_generation;
  if (keep) {
    s_snapshot.pixels = copy;
    s_snapshot.bytes = frame.len;
    s_snapshot.detection = result;
    s_snapshotRequested = false;
  }
  portEXIT_CRITICAL(&s_mux);
  if (!keep) heap_caps_free(copy);
}

void worker(void*) {
  // Reuse the SDK's legacy, precompiled two-stage models. One task owns both
  // models and all framebuffer access; no sensor/I2C calls occur here.
  Serial.printf("[facecam] loading legacy models; internal=%u largest=%u PSRAM=%u largest=%u\n",
                (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
                (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM));
  std::unique_ptr<HumanFaceDetectMSR01> first(new (std::nothrow) HumanFaceDetectMSR01(.1f, .5f, 10, .2f));
  std::unique_ptr<HumanFaceDetectMNP01> second(new (std::nothrow) HumanFaceDetectMNP01(.5f, .3f, 8));
  std::vector<int> shape(3);
  bool firstInference = true;
  bool havePreviousBoundary = false;
  uint32_t previousBoundary = 0, previousGeneration = 0;
  if (!first || !second) error("face model allocation failed");
  while (first && second) {
    portENTER_CRITICAL(&s_mux);
    const bool stopping = s_stop;
    portEXIT_CRITICAL(&s_mux);
    if (stopping) break;
    uint32_t generation;
    const bool tracking = enabled(generation);
    if (!tracking && !sceneRequested()) {
      havePreviousBoundary = false;
      vTaskDelay(pdMS_TO_TICKS(40)); continue;
    }
    if (!tracking) havePreviousBoundary = false;
    if (generation != previousGeneration) havePreviousBoundary = false;
    previousGeneration = generation;
    const uint32_t started = millis();
    camera_fb_t* frame = nullptr;
    uint32_t captured = 0;
    bool slowRetry = false;
    // With two framebuffers, the worker holds one throughout inference and
    // the driver's one-slot LATEST queue can still hold the other old frame.
    // Release at most two such frames, never spin waiting for the queue to be
    // empty. A get with no ready frame uses the driver's existing timeout.
    for (unsigned discarded = 0; discarded < sampling::kMaximumBacklogDiscards; ++discarded) {
      frame = esp_camera_fb_get();
      if (!frame) {
        portENTER_CRITICAL(&s_mux); ++s_status.frame_get_failures; portEXIT_CRITICAL(&s_mux);
        if (frameWorkCurrent(generation)) error("camera returned no framebuffer");
        slowRetry = true; break;
      }
      captured = frameMillis(*frame);
      const uint32_t dequeuedAt = millis(), getAge = dequeuedAt - captured;
      portENTER_CRITICAL(&s_mux); s_status.frame_get_age_ms = getAge; portEXIT_CRITICAL(&s_mux);
      if (!frameWorkCurrent(generation)) { esp_camera_fb_return(frame); frame = nullptr; break; }
      const size_t expected = frame->width * frame->height * sizeof(uint16_t);
      if (!frame->buf || !frame->width || !frame->height ||
          frame->format != PIXFORMAT_RGB565 || frame->len != expected) {
        esp_camera_fb_return(frame); frame = nullptr;
        error("invalid RGB565 framebuffer"); slowRetry = true; break;
      }
      const auto admission = sampling::frameAdmission(captured, dequeuedAt,
          havePreviousBoundary, previousBoundary, discarded);
      if (admission == sampling::FrameAdmission::Use) break;
      esp_camera_fb_return(frame); frame = nullptr;
      portENTER_CRITICAL(&s_mux);
      if (admission == sampling::FrameAdmission::InvalidTimestamp) ++s_status.frame_timestamp_errors;
      else ++s_status.backlog_discards;
      if (admission == sampling::FrameAdmission::Limit) ++s_status.backlog_limit_hits;
      portEXIT_CRITICAL(&s_mux);
      if (getAge > kMaximumFrameAgeMs && getAge < 0x80000000u) stale();
      if (admission == sampling::FrameAdmission::InvalidTimestamp ||
          admission == sampling::FrameAdmission::Limit) break;
    }
    if (!frame) { vTaskDelay(pdMS_TO_TICKS(slowRetry ? kIntervalMs : 10)); continue; }
    if (!frameWorkCurrent(generation) || millis() - captured > kMaximumFrameAgeMs) {
      esp_camera_fb_return(frame);
      stale();
      vTaskDelay(pdMS_TO_TICKS(10));
      continue;
    }
    if (!stillCurrent(generation)) {
      // A scene-only request does not enable follow, select a face, run models,
      // publish a synthetic detection or touch sensor/SCCB configuration.
      saveSceneFrame(*frame);
      previousBoundary = millis(); havePreviousBoundary = true;
      esp_camera_fb_return(frame);
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }
    Detection result;
    result.width = (int)frame->width;
    result.height = (int)frame->height;
    result.captured_ms = captured;
    shape[0] = result.height;
    shape[1] = result.width;
    shape[2] = 3;  // SDK RGB565 inference still uses the RGB shape channel count.
    const uint32_t inferenceStart = millis();
    auto& candidates = first->infer(reinterpret_cast<uint16_t*>(frame->buf), shape);
    auto& faces = second->infer(reinterpret_cast<uint16_t*>(frame->buf), shape, candidates);
    result.inference_ms = millis() - inferenceStart;
    if (firstInference) {
      firstInference = false;
      Serial.printf("[facecam] first inference %ums; internal=%u PSRAM=%u\n",
                    (unsigned)result.inference_ms,
                    (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                    (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    }
    for (const auto& face : faces) {
      if (result.count == 8) break;
      if (face.box.size() < 4 || !std::isfinite(face.score)) continue;
      const float x1 = fmaxf(0.f, (float)face.box[0]);
      const float y1 = fmaxf(0.f, (float)face.box[1]);
      const float x2 = fminf((float)result.width, (float)face.box[2]);
      const float y2 = fminf((float)result.height, (float)face.box[3]);
      if (x2 > x1 && y2 > y1) {
        const size_t i = result.count++;
        result.boxes[i] = facetrack::BBox(x1, y1, x2, y2, face.score);
        result.sample_quality[i] = sampling::qualityReason(result.boxes[i], result.width,
            result.height, face.keypoint.data(), face.keypoint.size());
        if (face.keypoint.size() >= 10)
          for (size_t p = 0; p < 10; ++p) result.landmarks[i][p] = (float)face.keypoint[p];
      }
    }
    const uint32_t stackBytes = uxTaskGetStackHighWaterMark(nullptr);
    const uint32_t inferredAge = millis() - captured;
    portENTER_CRITICAL(&s_mux);
    ++s_status.frames;
    s_status.worker_stack_bytes = stackBytes;
    s_status.inference_ms = result.inference_ms;
    s_status.frame_inferred_age_ms = inferredAge;
    portEXIT_CRITICAL(&s_mux);
    if (stillCurrent(generation)) {
      result.sequence = ++s_sequence;
      if (millis() - captured <= kMaximumFrameAgeMs)
        saveSampleCandidates(*frame, result, generation);
      // Explicit diagnostic snapshots may show a slow inference's frame, but
      // the motion mailbox below never accepts that stale observation.
      saveSnapshot(*frame, result, generation);
    }
    const uint32_t publishAge = millis() - captured;
    portENTER_CRITICAL(&s_mux); s_status.frame_publish_age_ms = publishAge; portEXIT_CRITICAL(&s_mux);
    if (stillCurrent(generation) && publishAge <= kMaximumFrameAgeMs) {
      portENTER_CRITICAL(&s_mux);
      if (s_status.enabled && !s_stop && generation == s_generation) {
        // A requested crop must be selected by Controller using this same
        // observation. Do not overwrite that one bounded mailbox beforehand.
        const bool pinned = s_samplePhase == SamplePhase::AwaitSelection &&
                            s_pending && s_latest.sequence == s_sample.frame_id;
        if (!pinned) { s_latest = result; s_pending = true; }
        s_status.last_ms = captured;
        s_status.faces = (int)result.count;
        s_status.error[0] = 0;
      }
      portEXIT_CRITICAL(&s_mux);
    } else stale();
    saveSceneFrame(*frame);
    // This is only an admission boundary for the *next* driver dequeue. The
    // current result keeps the original exposure timestamp without alteration.
    previousBoundary = millis(); havePreviousBoundary = true;
    esp_camera_fb_return(frame);
    const uint32_t elapsed = millis() - started;
    vTaskDelay(pdMS_TO_TICKS(elapsed < kIntervalMs ? kIntervalMs - elapsed : 20));
  }
  second.reset();
  first.reset();
  portENTER_CRITICAL(&s_mux);
  s_status.running = false;
  s_status.enabled = false;
  s_worker = nullptr;
  portEXIT_CRITICAL(&s_mux);
  xSemaphoreGive(s_stopped);
  vTaskDelete(nullptr);
}
}  // namespace

bool begin() {
  if (status().initialized) return true;
  if (!psramFound()) { error("PSRAM unavailable; face camera disabled"); return false; }
  // M5.begin already supplies camera ALDO3 and releases AW9523 P1_0 reset.
  // Preserve all other expander bits. The external oscillator supplies XCLK.
  if (!m5::In_I2C.isEnabled() || !m5::In_I2C.bitOn(0x58, 0x03, 0x01, 400000)) {
    error("camera reset release failed on internal I2C");
    return false;
  }
  delay(10);
  camera_config_t cfg = {};
  cfg.pin_pwdn = cfg.pin_reset = cfg.pin_xclk = -1;
  cfg.pin_sccb_sda = 12; cfg.pin_sccb_scl = 11;
  cfg.pin_d0 = 39; cfg.pin_d1 = 40; cfg.pin_d2 = 41; cfg.pin_d3 = 42;
  cfg.pin_d4 = 15; cfg.pin_d5 = 16; cfg.pin_d6 = 48; cfg.pin_d7 = 47;
  cfg.pin_vsync = 46; cfg.pin_href = 38; cfg.pin_pclk = 45;
  cfg.xclk_freq_hz = 20000000;
  cfg.ledc_timer = LEDC_TIMER_0; cfg.ledc_channel = LEDC_CHANNEL_0;
  cfg.pixel_format = PIXFORMAT_RGB565;
  cfg.frame_size = FRAMESIZE_QVGA;
  cfg.fb_count = 2;
  cfg.fb_location = CAMERA_FB_IN_PSRAM;
  cfg.grab_mode = CAMERA_GRAB_LATEST;
  cfg.sccb_i2c_port = 1;
  m5::In_I2C.release();
  esp_err_t init = esp_camera_init(&cfg);
  if (init == ESP_OK) {
    sensor_t* sensor = esp_camera_sensor_get();
    if (!sensor || sensor->id.PID != GC0308_PID) init = ESP_ERR_CAMERA_NOT_SUPPORTED;
    else if (sensor->set_hmirror(sensor, 0) != 0 || sensor->set_vflip(sensor, 0) != 0)
      init = ESP_FAIL;
  }
  if (init != ESP_OK) esp_camera_deinit();
  const int sccb = SCCB_Deinit();
  const bool restored = m5::In_I2C.begin();
  if (init != ESP_OK) { cameraError("camera initialization failed", init); return false; }
  if (sccb != ESP_OK || !restored) {
    esp_camera_deinit();
    error("camera I2C handback failed; camera disabled");
    return false;
  }
  portENTER_CRITICAL(&s_mux);
  s_status.initialized = true;
  s_status.error[0] = 0;
  portEXIT_CRITICAL(&s_mux);
  Serial.println("[facecam] GC0308 RGB565 320x240; internal I2C restored");
  return true;
}

bool start() {
  if (!status().initialized) { error("start requires successful camera initialization"); return false; }
  if (status().running) return true;
  if (!s_stopped) s_stopped = xSemaphoreCreateBinary();
  if (!s_stopped) { error("worker semaphore allocation failed"); return false; }
  xSemaphoreTake(s_stopped, 0);
  portENTER_CRITICAL(&s_mux);
  s_stop = false;
  s_status.running = true;
  portEXIT_CRITICAL(&s_mux);
  if (xTaskCreatePinnedToCore(worker, "pulse_face", 8192, nullptr, 1, &s_worker, 0) != pdPASS) {
    portENTER_CRITICAL(&s_mux);
    s_status.running = false;
    s_worker = nullptr;
    portEXIT_CRITICAL(&s_mux);
    error("face worker task allocation failed");
    return false;
  }
  return true;
}

void setEnabled(bool on) {
  portENTER_CRITICAL(&s_mux);
  if (s_status.enabled != on) ++s_generation;
  s_status.enabled = on && s_status.initialized && s_status.running && !s_stop;
  if (!s_status.enabled) {
    s_pending = false;
    s_snapshotRequested = false;
    s_status.faces = 0;
    s_tracking = facetrack::Snapshot();
    s_wasLocked = false;
    if (s_samplePhase == SamplePhase::Requested) {
      s_sample.reason = "disabled";
      s_samplePhase = SamplePhase::Ready;
    }
  }
  portEXIT_CRITICAL(&s_mux);
}

bool takeDetection(Detection& result) {
  portENTER_CRITICAL(&s_mux);
  const bool ready = s_pending;
  if (ready) { result = s_latest; s_pending = false; }
  portEXIT_CRITICAL(&s_mux);
  return ready;
}

Status status() {
  portENTER_CRITICAL(&s_mux);
  const Status result = s_status;
  portEXIT_CRITICAL(&s_mux);
  return result;
}

void updateTracking(const facetrack::Snapshot& target, const Detection* observation, uint32_t now) {
  portENTER_CRITICAL(&s_mux);
  if (target.locked && (!s_wasLocked || s_trackerId != target.lock_id)) {
    if (++s_trackSerial == 0) ++s_trackSerial;
    s_publicTrack = s_trackSerial;
  }
  s_wasLocked = target.locked;
  s_trackerId = target.lock_id;
  s_tracking = target;
  if (observation) s_trackingObservation = *observation;
  const bool waiting = s_samplePhase == SamplePhase::AwaitSelection;
  const bool exact = waiting && observation && observation->sequence == s_sample.frame_id;
  const bool timedOut = waiting && now - s_sample.captured_ms > kMaximumFrameAgeMs;
  if (exact || timedOut) s_samplePhase = SamplePhase::Selecting;
  FaceSample result = s_sample;
  const uint32_t track = s_publicTrack;
  portEXIT_CRITICAL(&s_mux);
  if (!exact && !timedOut) return;
  const Detection& d = s_sampleStorage->observation;
  result.locked = target.locked; result.tracking = target.tracking;
  result.ambiguous = target.ambiguous; result.age_ms = now - d.captured_ms;
  const char* reason = timedOut ? "stale" : sampling::frameRejection(target, d, now);
  if (!reason && track != result.track_id) reason = "target_changed";
  const int index = !reason ? sampling::exactTargetIndex(d, target) : -1;
  if (!reason && index < 0) reason = "target_mismatch";
  if (!reason) reason = d.sample_quality[index];
  if (!reason) {
    const auto& b = d.boxes[index];
    result.box = facetrack::BBox(b.x1 / d.width, b.y1 / d.height,
                                 b.x2 / d.width, b.y2 / d.height, b.score);
    result.valid = true;
    result.reason = "ready";
    result.pixels = s_sampleStorage->crops[index];
    result.pixel_bytes = s_sampleStorage->pixel_bytes[index];
    if (result.jpeg) memcpy(result.landmarks, s_sampleStorage->landmarks[index], sizeof(result.landmarks));
  } else {
    result.valid = false; result.reason = reason; result.pixels = nullptr;
    result.pixel_bytes = 0; memset(result.landmarks, 0, sizeof(result.landmarks));
  }
  eraseCrops(result.valid ? index : -1);
  portENTER_CRITICAL(&s_mux);
  s_sample = result;
  s_samplePhase = SamplePhase::Ready;
  portEXIT_CRITICAL(&s_mux);
}

SampleState requestSample(FaceSample& result, uint32_t now, bool jpeg) {
  portENTER_CRITICAL(&s_mux);
  const SamplePhase phase = s_samplePhase;
  const bool expired = phase == SamplePhase::Ready && now - s_sampleAt > 1200;
  portEXIT_CRITICAL(&s_mux);
  if (expired) releaseSample();
  portENTER_CRITICAL(&s_mux);
  if (s_scene.blocksOther()) {
    result = FaceSample(); result.jpeg = jpeg; result.reason = "camera_busy";
    portEXIT_CRITICAL(&s_mux); return SampleState::Busy;
  }
  if (s_samplePhase != SamplePhase::Idle) {
    result = s_sample; result.pixels = nullptr;
    portEXIT_CRITICAL(&s_mux); return SampleState::Busy;
  }
  const bool available = s_status.running && s_status.enabled;
  s_sample = FaceSample();
  s_sample.jpeg = jpeg;
  if (++s_sampleSerial == 0) ++s_sampleSerial;
  s_sample.request_id = s_sampleSerial;
  s_sample.track_id = s_publicTrack;
  s_sample.tracker_id = s_trackerId;
  s_sample.locked = s_tracking.locked;
  s_sample.tracking = s_tracking.tracking;
  s_sample.ambiguous = s_tracking.ambiguous;
  s_sample.faces = s_trackingObservation.count;
  const char* rejected = sampling::requestAdmissionReason(available, s_tracking, s_trackingObservation, now);
  s_sample.reason = rejected ? rejected : "pending";
  s_sampleAt = now;
  s_sampleGeneration = s_generation;
  result = s_sample;
  if (rejected) s_samplePhase = SamplePhase::Ready;
  portEXIT_CRITICAL(&s_mux);
  if (rejected) return SampleState::Ready;
  // Allocate at most once, outside the spinlock, on an explicit local request.
  if (!s_sampleStorage) {
    void* storage = heap_caps_malloc(sizeof(SampleStorage), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (storage) s_sampleStorage = new (storage) SampleStorage();
  }
  if (jpeg && !s_jpegScratch)
    s_jpegScratch = static_cast<uint8_t*>(heap_caps_calloc(1, kJpegScratchBytes,
        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  portENTER_CRITICAL(&s_mux);
  if (!s_sampleStorage || (jpeg && !s_jpegScratch)) {
    s_sample.reason = "allocation_failed"; result = s_sample;
    s_samplePhase = SamplePhase::Ready;
    portEXIT_CRITICAL(&s_mux); return SampleState::Ready;
  }
  s_samplePhase = SamplePhase::Requested;
  portEXIT_CRITICAL(&s_mux);
  return SampleState::Pending;
}

SampleState takeSample(uint32_t id, FaceSample& result, uint32_t now) {
  portENTER_CRITICAL(&s_mux);
  if (!id || id != s_sample.request_id || s_samplePhase == SamplePhase::Idle ||
      s_samplePhase == SamplePhase::Borrowed) {
    portEXIT_CRITICAL(&s_mux); return SampleState::Missing;
  }
  if ((s_samplePhase == SamplePhase::Requested || s_samplePhase == SamplePhase::AwaitSelection) &&
      (!s_status.enabled || now - s_sampleAt > 1200)) {
    s_sample.reason = s_status.enabled ? "timeout" : "disabled";
    s_sample.valid = false; s_sample.pixels = nullptr;
    s_sample.pixel_bytes = 0; memset(s_sample.landmarks, 0, sizeof(s_sample.landmarks));
    s_samplePhase = SamplePhase::Ready;
  }
  if (s_samplePhase != SamplePhase::Ready) {
    result = s_sample; result.pixels = nullptr;
    portEXIT_CRITICAL(&s_mux); return SampleState::Pending;
  }
  if (s_sample.valid) {
    const char* rejected = sampling::frameRejection(s_tracking, s_trackingObservation, now);
    if (!rejected && s_publicTrack != s_sample.track_id) rejected = "target_changed";
    if (!rejected && now - s_sample.captured_ms > kMaximumFrameAgeMs) rejected = "stale";
    if (!rejected) {
      const int latestTarget = sampling::exactTargetIndex(s_trackingObservation, s_tracking);
      rejected = latestTarget >= 0 ? s_trackingObservation.sample_quality[latestTarget] : "target_mismatch";
    }
    if (rejected) {
      s_sample.valid = false; s_sample.reason = rejected; s_sample.pixels = nullptr;
      s_sample.pixel_bytes = 0; memset(s_sample.landmarks, 0, sizeof(s_sample.landmarks));
    }
  }
  s_sample.locked = s_tracking.locked;
  s_sample.tracking = s_tracking.tracking;
  s_sample.ambiguous = s_tracking.ambiguous;
  s_sample.age_ms = s_sample.captured_ms ? now - s_sample.captured_ms : 0;
  s_samplePhase = SamplePhase::Borrowed;
  result = s_sample;
  portEXIT_CRITICAL(&s_mux);
  return SampleState::Ready;
}

void releaseSample() {
  portENTER_CRITICAL(&s_mux);
  const bool idle = s_samplePhase == SamplePhase::Ready || s_samplePhase == SamplePhase::Borrowed;
  if (idle) s_samplePhase = SamplePhase::Selecting;
  portEXIT_CRITICAL(&s_mux);
  if (!idle) return;
  eraseCrops();
  portENTER_CRITICAL(&s_mux);
  s_sample = FaceSample();
  s_samplePhase = SamplePhase::Idle;
  portEXIT_CRITICAL(&s_mux);
}

void maintainSamples(uint32_t now) {
  maintainScene(now);
  portENTER_CRITICAL(&s_mux);
  // Never erase memory owned by the worker (Cropping), the selector, or a
  // borrowed HTTP encoder. Those owners finish before publishing Ready.
  const bool eligible = s_samplePhase == SamplePhase::Requested ||
                        s_samplePhase == SamplePhase::AwaitSelection ||
                        (s_samplePhase == SamplePhase::Ready && s_sample.valid);
  const char* reason = eligible ? sampling::expiryReason(now, s_sample.captured_ms,
                                                        s_sampleAt, s_sample.frame_id != 0) : nullptr;
  if (eligible && (!s_status.enabled || s_stop)) reason = "disabled";
  if (reason) s_samplePhase = SamplePhase::Selecting;
  portEXIT_CRITICAL(&s_mux);
  if (!reason) return;
  eraseCrops();
  portENTER_CRITICAL(&s_mux);
  s_sample.valid = false; s_sample.pixels = nullptr; s_sample.reason = reason;
  s_sample.pixel_bytes = 0; memset(s_sample.landmarks, 0, sizeof(s_sample.landmarks));
  s_sample.age_ms = s_sample.frame_id ? now - s_sample.captured_ms : 0;
  s_samplePhase = SamplePhase::Ready;
  portEXIT_CRITICAL(&s_mux);
}

bool requestSnapshot() {
  portENTER_CRITICAL(&s_mux);
  const bool accept = s_status.running && s_status.enabled &&
                      !s_snapshotRequested && !s_snapshot.pixels && !s_snapshotBorrowed && !s_scene.blocksOther();
  if (accept) s_snapshotRequested = true;
  portEXIT_CRITICAL(&s_mux);
  return accept;
}

bool takeSnapshot(Snapshot& result) {
  if (result.pixels) return false;
  portENTER_CRITICAL(&s_mux);
  const bool ready = s_snapshot.pixels != nullptr;
  if (ready) { result = s_snapshot; s_snapshotBorrowed = result.pixels; s_snapshot = Snapshot(); }
  portEXIT_CRITICAL(&s_mux);
  return ready;
}

void freeSnapshot(Snapshot& image) {
  if (image.pixels) {
    const uint16_t* released = image.pixels;
    heap_caps_free(image.pixels);
    portENTER_CRITICAL(&s_mux);
    if (s_snapshotBorrowed == released) s_snapshotBorrowed = nullptr;
    portEXIT_CRITICAL(&s_mux);
  }
  image = Snapshot();
}

SceneState requestSceneFrame(SceneFrame& result, uint32_t now) {
  maintainScene(now);
  portENTER_CRITICAL(&s_mux);
  const bool available = s_status.initialized && s_status.running && !s_stop;
  const bool contended = s_samplePhase != SamplePhase::Idle || s_snapshotRequested || s_snapshot.pixels || s_snapshotBorrowed;
  const bool allocate = available && !contended && !s_scene.blocksOther() && !s_scenePixels;
  portEXIT_CRITICAL(&s_mux);
  uint8_t* allocation = allocate ? static_cast<uint8_t*>(heap_caps_calloc(1, kSceneJpegCapacity,
      MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)) : nullptr;
  portENTER_CRITICAL(&s_mux);
  if (allocation && !s_scenePixels) { s_scenePixels = allocation; allocation = nullptr; }
  const bool currentAvailable = s_status.initialized && s_status.running && !s_stop;
  const bool currentContended = s_samplePhase != SamplePhase::Idle || s_snapshotRequested || s_snapshot.pixels || s_snapshotBorrowed;
  const SceneState state = s_scene.request(result, now, currentAvailable && s_scenePixels, currentContended);
  if (currentAvailable && !currentContended && !s_scenePixels) {
    result.reason = "allocation_failed"; ++s_status.scene_errors;
  }
  portEXIT_CRITICAL(&s_mux);
  if (allocation) heap_caps_free(allocation);
  return state;
}
SceneState takeSceneFrame(uint32_t id, SceneFrame& result, uint32_t now) {
  maintainScene(now);
  portENTER_CRITICAL(&s_mux);
  const SceneState state = s_scene.take(id, result, s_scenePixels, now);
  portEXIT_CRITICAL(&s_mux);
  return state;
}
void releaseSceneFrame() {
  portENTER_CRITICAL(&s_mux); const bool erase = s_scene.release(); portEXIT_CRITICAL(&s_mux);
  if (erase) eraseSceneStorage();
}
void cancelSceneFrame() {
  portENTER_CRITICAL(&s_mux); const bool erase = s_scene.cancel(); portEXIT_CRITICAL(&s_mux);
  if (erase) eraseSceneStorage();
}

bool end() {
  cancelSceneFrame();
  setEnabled(false);
  portENTER_CRITICAL(&s_mux);
  s_stop = true;
  const bool running = s_status.running;
  portEXIT_CRITICAL(&s_mux);
  if (running && xSemaphoreTake(s_stopped, pdMS_TO_TICKS(10000)) != pdTRUE) {
    error("face worker did not stop; camera retained");
    return false;
  }
  if (status().initialized) esp_camera_deinit();
  releaseSample();
  Snapshot abandoned;
  takeSnapshot(abandoned);
  freeSnapshot(abandoned);
  portENTER_CRITICAL(&s_mux);
  s_status.initialized = false;
  s_pending = false;
  portEXIT_CRITICAL(&s_mux);
  return true;
}
}  // namespace facecam

#else

namespace facecam {
bool begin() { return false; }
bool start() { return false; }
void setEnabled(bool) {}
bool takeDetection(Detection&) { return false; }
Status status() {
  Status result;
  snprintf(result.error, sizeof(result.error), "face camera requires enabled ESP32-S3 build");
  return result;
}
bool end() { return true; }
bool requestSnapshot() { return false; }
bool takeSnapshot(Snapshot&) { return false; }
void freeSnapshot(Snapshot& image) { image = Snapshot(); }
void updateTracking(const facetrack::Snapshot&, const Detection*, uint32_t) {}
SampleState requestSample(FaceSample& result, uint32_t, bool jpeg) {
  result = FaceSample(); result.jpeg = jpeg;
  result.reason = "disabled"; return SampleState::Unavailable;
}
SampleState takeSample(uint32_t, FaceSample&, uint32_t) { return SampleState::Missing; }
void releaseSample() {}
void maintainSamples(uint32_t) {}
SceneState requestSceneFrame(SceneFrame& result, uint32_t) {
  result = SceneFrame(); result.reason = "disabled"; return SceneState::Unavailable;
}
SceneState takeSceneFrame(uint32_t, SceneFrame&, uint32_t) { return SceneState::Missing; }
void releaseSceneFrame() {}
void cancelSceneFrame() {}
}  // namespace facecam

#endif
