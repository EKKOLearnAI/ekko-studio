#pragma once

#include <stddef.h>
#include <stdint.h>
#include "face_tracker.h"
#include "scene_capture.h"

namespace facecam {

struct Detection {
  facetrack::BBox boxes[8];
  float landmarks[8][10] = {};  // Original MNP01 order; no inferred/reordered points.
  const char* sample_quality[8] = {};  // Static rejection reasons, nullptr = usable.
  size_t count = 0;
  int width = 0, height = 0;
  uint32_t sequence = 0, captured_ms = 0, inference_ms = 0;
};

struct Status {
  bool initialized = false, running = false, enabled = false;
  uint32_t frames = 0, errors = 0, stale_frames = 0;  // frames = completed inference calls.
  uint32_t last_ms = 0, inference_ms = 0;
  uint32_t worker_stack_bytes = 0, jpeg_crops = 0, jpeg_ready = 0, jpeg_prepare_ms = 0;
  uint32_t jpeg_crop_ms = 0, jpeg_encode_ms = 0;  // Latest candidate's separate stages.
  uint32_t frame_get_age_ms = 0, frame_inferred_age_ms = 0, frame_publish_age_ms = 0;
  uint32_t backlog_discards = 0, backlog_limit_hits = 0, frame_get_failures = 0, frame_timestamp_errors = 0;
  uint32_t scene_errors = 0, scene_frame_id = 0, scene_encode_ms = 0;
  int faces = 0;
  char error[96] = {};
};

// Call begin after M5.begin, before starting audio, sensors, or other workers.
// It temporarily transfers the internal I2C controller to the camera driver,
// configures the sensor, then returns it to M5Unified on every exit path.
bool begin();
bool start();
void setEnabled(bool enabled);
bool takeDetection(Detection& result);  // Latest observation only; never waits.
Status status();
bool end();  // Joins the worker before releasing the camera; false on timeout.

struct Snapshot {
  uint16_t* pixels = nullptr;  // Owned RGB565 PSRAM copy, not a camera DMA buffer.
  size_t bytes = 0;
  Detection detection;
};

// At most one pending/ready snapshot. The next inferred frame is copied without
// blocking the display. takeSnapshot transfers ownership; call freeSnapshot.
bool requestSnapshot();
bool takeSnapshot(Snapshot& result);
void freeSnapshot(Snapshot& image);
// Explicit main-loop scene requests: independent of face lock/tracking enable.
// One QVGA JPEG in PSRAM; no camera consumer or sensor reconfiguration is added.
// Scene capture and face ROI/diagnostic snapshot jobs are mutually exclusive.
SceneState requestSceneFrame(SceneFrame& result, uint32_t now);
SceneState takeSceneFrame(uint32_t requestId, SceneFrame& result, uint32_t now);
// Release after copying a borrowed result. Cancellation during encoding or a
// borrow is cooperative: the current owner completes before erasure/reuse.
void releaseSceneFrame();
void cancelSceneFrame();

constexpr size_t kSampleSide = 64;
constexpr size_t kSampleBytes = kSampleSide * kSampleSide;
constexpr size_t kJpegSampleSide = 112;
constexpr size_t kJpegScratchBytes = kJpegSampleSide * kJpegSampleSide * 2;
constexpr size_t kGray8HeaderReserve = 1536;
constexpr size_t kGray8WireMaximum = kGray8HeaderReserve + kSampleBytes;
enum class SampleState : uint8_t { Missing, Pending, Ready, Busy, Unavailable };
struct FaceSample {
  bool valid = false, locked = false, tracking = false, ambiguous = false;
  bool jpeg = false;
  size_t pixel_bytes = 0;
  float landmarks[10] = {};  // JPEG ROI pixels: left eye, right eye, nose, left/right mouth.
  uint32_t request_id = 0, track_id = 0, tracker_id = 0, frame_id = 0;
  uint32_t captured_ms = 0, age_ms = 0;
  size_t faces = 0;
  facetrack::BBox box;  // Normalized [0,1], in the unmirrored camera image.
  const char* reason = "unavailable";  // Static string; never owns storage.
  const uint8_t* pixels = nullptr;   // Borrowed PSRAM, only after takeSample.
};

// Main-loop only. Pass the exact observation just consumed by Controller,
// after observe/update, or nullptr on ticks without a new observation. The
// camera worker never chooses a target independently of Controller.
void updateTracking(const facetrack::Snapshot& target,
                    const Detection* observation, uint32_t now);
SampleState requestSample(FaceSample& result, uint32_t now, bool jpeg = false);
SampleState takeSample(uint32_t requestId, FaceSample& result, uint32_t now);
// Ends the borrowed lifetime and erases all candidate crops. No disk or log IO.
void releaseSample();
void maintainSamples(uint32_t now);  // Main loop; erases abandoned/expired crops.

// Pure bounded operations, shared by the worker and host boundary tests.
namespace sampling {
constexpr unsigned kMaximumBacklogDiscards = 2;
enum class FrameAdmission : uint8_t { Use, Discard, Limit, InvalidTimestamp };
// A driver timestamp older than the previous completed processing boundary is
// queued backlog, not a fresh exposure. Keep that boundary fixed during drain.
// This only rejects frames; it never substitutes a timestamp or extends 450ms.
FrameAdmission frameAdmission(uint32_t captured, uint32_t now,
                               bool havePreviousBoundary, uint32_t previousBoundary,
                               unsigned alreadyDiscarded);
// Metadata is already standard base64 of JSON without pixels. The pixel input
// is a separate borrowed crop; response storage is caller-owned PSRAM.
bool packGray8Response(const char* metadataBase64, size_t metadataLength,
                       const uint8_t* pixels, size_t pixelBytes,
                       char* response, size_t capacity, size_t& written);
bool packJpegResponse(const char* metadataBase64, size_t metadataLength,
                      const uint8_t* pixels, size_t pixelBytes,
                      char* response, size_t capacity, size_t& written);
bool validJpeg(const uint8_t* pixels, size_t bytes);  // Bounded SOI/EOI envelope, not a JPEG decoder.
// One caller-owned bounded encoder sink. Failure is latched because the
// vendored callback_stream does not propagate a short callback return value.
struct JpegSink {
  uint8_t* pixels = nullptr;
  size_t capacity = 0, used = 0;
  bool failed = false;
};
size_t appendJpeg(void* sink, size_t index, const void* data, size_t bytes);
struct SquareCrop { float left = 0, top = 0, side = 0; };
bool squareCrop(int width, int height, const facetrack::BBox& box, SquareCrop& roi);
// RGB565BE output, square 112 ROI, bilinear sampling without changing aspect.
// Q8 axis weights are prepared once; each output reads four BE565 pixels.
// Versus ideal floating bilinear of expanded RGB8 then RGB565 quantization,
// each native 5/6-bit output channel differs by at most one quantization code.
// Source, pixel output and landmark output must be disjoint caller buffers.
// Landmark positions use pixel-center coordinates in the output image.
bool cropRgb112(const uint8_t* rgb565be, size_t bytes, int width, int height,
                const facetrack::BBox& box, const float* legacyLandmarks,
                size_t landmarkCount, uint8_t* output, size_t capacity,
                float* outputLandmarks, size_t outputLandmarkCount);
const char* expiryReason(uint32_t now, uint32_t captured, uint32_t requested, bool haveFrame);
const char* frameRejection(const facetrack::Snapshot& target, const Detection& observation,
                           uint32_t now);
const char* requestAdmissionReason(bool available, const facetrack::Snapshot& target,
                                   const Detection& previous, uint32_t now);
const char* qualityReason(const facetrack::BBox& box, int width, int height,
                          const int* landmarks, size_t landmarkCount);
int exactTargetIndex(const Detection& observation, const facetrack::Snapshot& target);
bool cropGray64(const uint8_t* rgb565be, size_t bytes, int width, int height,
                const facetrack::BBox& box, uint8_t* output, size_t capacity);
}

}  // namespace facecam
