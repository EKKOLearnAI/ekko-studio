#pragma once

#include <stddef.h>
#include <stdint.h>

// Geometry-based target continuity, not biometric identity recognition.
// Input images must have a consistent, unmirrored orientation. Image right maps
// to positive pan; image down maps to positive tilt.
namespace facetrack {

struct BBox {
  float x1, y1, x2, y2, score;
  BBox(float left = 0, float top = 0, float right = 0, float bottom = 0,
       float confidence = 0)
      : x1(left), y1(top), x2(right), y2(bottom), score(confidence) {}
};

struct Config {
  float pan_min = -45.f, pan_max = 45.f;
  float tilt_min = -20.f, tilt_max = 8.f;
  float pan_speed = 35.f, tilt_speed = 20.f;
  float pan_acceleration = 100.f, tilt_acceleration = 70.f;
  float pan_gain = 40.f, tilt_gain = 24.f;
  float dead_zone_x = .08f, dead_zone_y = .10f;
  float filter_seconds = .18f;
  float minimum_score = .55f;
  uint32_t fresh_ms = 450;
  uint32_t return_after_ms = 900;
  uint32_t release_after_ms = 1200;
  uint32_t acquisition_ms = 120;
  uint8_t acquisition_frames = 3;
};

struct Snapshot {
  bool locked = false;
  bool tracking = false;
  bool ambiguous = false;
  bool returning = false;  // Keep ownership while gently returning to centre.
  uint32_t lock_id = 0;
  uint32_t lost_ms = 0;
  BBox target;  // Pixels in the latest accepted image dimensions.
  float error_x = 0, error_y = 0;  // Filtered, normalized [-1, 1].
  float pan = 0, tilt = 0;
  float pan_velocity = 0, tilt_velocity = 0;
};

// Single-owner object: publish detector results to the control task rather
// than calling observe() and update() concurrently from separate tasks.
class Controller {
 public:
  static const size_t kMaxFaces = 8;
  explicit Controller(const Config& config = Config());
  void reset(float pan = 0, float tilt = 0, uint32_t nowMs = 0);
  // Invalid boxes are discarded. Out-of-order/duplicate observations are not
  // used to acquire a target. A nullptr/zero count reports a missed detection.
  void observe(const BBox* boxes, size_t count, int width, int height,
               uint32_t nowMs);
  // Supply real elapsed time, not a display-animation time cap. A scheduling
  // gap over 250 ms cancels velocity instead of catching up with a large jump.
  void update(float dt, uint32_t nowMs);
  // Perception continues while a leased directed look owns the actuators.
  // Disabled calls and the resume edge seed from the current physical gaze;
  // no invisible velocity or elapsed interval is replayed on handback.
  void setActuationEnabled(bool enabled, float pan, float tilt, uint32_t nowMs);
  Snapshot snapshot() const { return _state; }

 private:
  Config _cfg;
  Snapshot _state;
  BBox _target, _candidate;  // Normalized coordinates.
  int _width = 0, _height = 0;
  uint8_t _candidate_hits = 0;
  uint32_t _candidate_since = 0, _candidate_last = 0;
  uint32_t _last_seen = 0, _last_observation = 0, _last_update = 0;
  bool _have_observation = false, _have_target = false;
  bool _matched_observation = false;
  bool _actuationEnabled = true;
  void refresh(uint32_t nowMs);
  void accept(const BBox& box, uint32_t nowMs, bool acquiring);
};

}  // namespace facetrack
