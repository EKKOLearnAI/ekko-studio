#include "face_tracker.h"

#include <math.h>

namespace facetrack {
const size_t Controller::kMaxFaces;
namespace {
float clamp(float v, float lo, float hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}
float centerX(const BBox& b) { return (b.x1 + b.x2) * .5f; }
float centerY(const BBox& b) { return (b.y1 + b.y2) * .5f; }
float area(const BBox& b) { return (b.x2 - b.x1) * (b.y2 - b.y1); }
float overlap(const BBox& a, const BBox& b) {
  const float w = fmaxf(0.f, fminf(a.x2, b.x2) - fmaxf(a.x1, b.x1));
  const float h = fmaxf(0.f, fminf(a.y2, b.y2) - fmaxf(a.y1, b.y1));
  const float intersection = w * h;
  return intersection / (area(a) + area(b) - intersection);
}
float association(const BBox& a, const BBox& b) {
  const float ratio = area(b) / area(a);
  if (ratio < .45f || ratio > 2.2f) return -1.f;
  const float dx = centerX(a) - centerX(b), dy = centerY(a) - centerY(b);
  const float distance = sqrtf(dx * dx + dy * dy);
  // A narrow gate keeps an absent target's neighbour from stealing its lock.
  const float gate = fmaxf(.055f, sqrtf(area(a)) * .65f);
  const float iou = overlap(a, b);
  if (distance > gate || (iou < .10f && distance > gate * .5f)) return -1.f;
  return .65f * iou + .25f * (1.f - distance / gate) + .1f * b.score -
         .08f * fabsf(logf(ratio));
}
float acquisitionScore(const BBox& b) {
  const float dx = centerX(b) - .5f, dy = centerY(b) - .5f;
  const float centrality = 1.f - clamp(sqrtf(dx * dx + dy * dy) / .7072f, 0.f, 1.f);
  return .55f * centrality + .35f * sqrtf(area(b)) + .1f * b.score;
}
bool validBox(const BBox& b, int width, int height, float minimumScore, BBox& out) {
  if (!isfinite(b.x1) || !isfinite(b.x2) || !isfinite(b.y1) ||
      !isfinite(b.y2) || !isfinite(b.score) || b.score < minimumScore) return false;
  const float x1 = clamp(b.x1, 0.f, (float)width), x2 = clamp(b.x2, 0.f, (float)width);
  const float y1 = clamp(b.y1, 0.f, (float)height), y2 = clamp(b.y2, 0.f, (float)height);
  if (x2 - x1 < 4.f || y2 - y1 < 4.f) return false;
  out = BBox(x1 / width, y1 / height, x2 / width, y2 / height,
             clamp(b.score, 0.f, 1.f));
  return true;
}
float withoutDeadZone(float value, float zone) {
  const float magnitude = fabsf(value);
  if (magnitude <= zone) return 0.f;
  const float result = (magnitude - zone) / (1.f - zone);
  return value < 0.f ? -result : result;
}
void advanceAxis(float desired, float dt, float minimum, float maximum,
                 float speed, float acceleration, float& angle, float& velocity) {
  desired = clamp(desired, -speed, speed);
  const float remaining = desired >= 0 ? maximum - angle : angle - minimum;
  // Brake before a mechanical limit; the extra one-step margin keeps the
  // discrete integration inside the same acceleration envelope.
  const float safeSpeed = fmaxf(0.f, sqrtf(2.f * acceleration * fmaxf(0.f, remaining)) -
                                      acceleration * dt);
  desired = clamp(desired, -safeSpeed, safeSpeed);
  const float previous = velocity;
  velocity += clamp(desired - velocity, -acceleration * dt, acceleration * dt);
  angle += (previous + velocity) * .5f * dt;
  if (angle >= maximum) { angle = maximum; if (velocity > 0) velocity = 0; }
  if (angle <= minimum) { angle = minimum; if (velocity < 0) velocity = 0; }
}
}  // namespace

Controller::Controller(const Config& config) : _cfg(config) {
  // A malformed runtime configuration must not produce NaNs or unsafe limits.
  if (!isfinite(_cfg.pan_min) || !isfinite(_cfg.pan_max) || _cfg.pan_min >= _cfg.pan_max) {
    _cfg.pan_min = -45; _cfg.pan_max = 45;
  }
  if (!isfinite(_cfg.tilt_min) || !isfinite(_cfg.tilt_max) || _cfg.tilt_min >= _cfg.tilt_max) {
    _cfg.tilt_min = -20; _cfg.tilt_max = 8;
  }
  if (!isfinite(_cfg.pan_speed) || _cfg.pan_speed <= 0) _cfg.pan_speed = 35;
  if (!isfinite(_cfg.tilt_speed) || _cfg.tilt_speed <= 0) _cfg.tilt_speed = 20;
  if (!isfinite(_cfg.pan_acceleration) || _cfg.pan_acceleration <= 0) _cfg.pan_acceleration = 100;
  if (!isfinite(_cfg.tilt_acceleration) || _cfg.tilt_acceleration <= 0) _cfg.tilt_acceleration = 70;
  if (!isfinite(_cfg.pan_gain) || _cfg.pan_gain <= 0) _cfg.pan_gain = 40;
  if (!isfinite(_cfg.tilt_gain) || _cfg.tilt_gain <= 0) _cfg.tilt_gain = 24;
  _cfg.dead_zone_x = isfinite(_cfg.dead_zone_x) ? clamp(_cfg.dead_zone_x, 0, .8f) : .08f;
  _cfg.dead_zone_y = isfinite(_cfg.dead_zone_y) ? clamp(_cfg.dead_zone_y, 0, .8f) : .1f;
  if (!isfinite(_cfg.filter_seconds) || _cfg.filter_seconds < .001f) _cfg.filter_seconds = .18f;
  _cfg.minimum_score = isfinite(_cfg.minimum_score) ? clamp(_cfg.minimum_score, 0, 1) : .55f;
  if (_cfg.fresh_ms == 0) _cfg.fresh_ms = 450;
  if (_cfg.return_after_ms < _cfg.fresh_ms) _cfg.return_after_ms = _cfg.fresh_ms;
  if (_cfg.release_after_ms < _cfg.return_after_ms) _cfg.release_after_ms = _cfg.return_after_ms;
  if (_cfg.acquisition_frames < 2) _cfg.acquisition_frames = 2;
  reset();
}

void Controller::reset(float pan, float tilt, uint32_t nowMs) {
  _state = Snapshot();
  _state.pan = clamp(isfinite(pan) ? pan : 0, _cfg.pan_min, _cfg.pan_max);
  _state.tilt = clamp(isfinite(tilt) ? tilt : 0, _cfg.tilt_min, _cfg.tilt_max);
  _target = _candidate = BBox();
  _candidate_hits = 0;
  _width = _height = 0;
  _candidate_since = _candidate_last = _last_seen = _last_observation = _last_update = nowMs;
  _have_observation = _have_target = _matched_observation = false;
  _actuationEnabled = true;
}

void Controller::setActuationEnabled(bool enabled, float pan, float tilt, uint32_t nowMs) {
  if (int32_t(nowMs - _last_update) < 0 || (enabled && _actuationEnabled)) return;
  _last_update = nowMs;
  _state.pan_velocity = _state.tilt_velocity = 0;
  _actuationEnabled = enabled && isfinite(pan) && isfinite(tilt);
  if (isfinite(pan) && isfinite(tilt)) {
    _state.pan = clamp(pan, _cfg.pan_min, _cfg.pan_max);
    _state.tilt = clamp(tilt, _cfg.tilt_min, _cfg.tilt_max);
  }
  refresh(nowMs);
}

void Controller::refresh(uint32_t nowMs) {
  _state.lost_ms = _have_target ? (uint32_t)(nowMs - _last_seen) : 0;
  if (_state.locked && _state.lost_ms >= _cfg.release_after_ms) {
    _state.locked = false;
    _state.ambiguous = false;
    _candidate_hits = 0;
  }
  _state.tracking = _state.locked && _matched_observation && !_state.ambiguous &&
                    _state.lost_ms <= _cfg.fresh_ms;
  _state.returning = _have_target && !_state.tracking &&
                     _state.lost_ms >= _cfg.return_after_ms &&
                     (fabsf(_state.pan) > .15f || fabsf(_state.tilt) > .15f ||
                      fabsf(_state.pan_velocity) > .2f || fabsf(_state.tilt_velocity) > .2f);
}

void Controller::accept(const BBox& box, uint32_t nowMs, bool acquiring) {
  const float x = clamp(centerX(box) * 2.f - 1.f, -1.f, 1.f);
  const float y = clamp(centerY(box) * 2.f - 1.f, -1.f, 1.f);
  const float elapsed = (uint32_t)(nowMs - _last_seen) * .001f;
  const float alpha = acquiring ? 1.f : 1.f - expf(-elapsed / _cfg.filter_seconds);
  _state.error_x += (x - _state.error_x) * alpha;
  _state.error_y += (y - _state.error_y) * alpha;
  _target = box;
  _state.target = BBox(box.x1 * _width, box.y1 * _height,
                       box.x2 * _width, box.y2 * _height, box.score);
  _last_seen = nowMs;
  _have_target = true;
  _matched_observation = true;
  _state.ambiguous = false;
  if (acquiring) { _state.locked = true; ++_state.lock_id; }
  refresh(nowMs);
}

void Controller::observe(const BBox* boxes, size_t count, int width, int height,
                         uint32_t nowMs) {
  if (_have_observation && (int32_t)(nowMs - _last_observation) <= 0) return;
  _have_observation = true;
  _last_observation = nowMs;
  if (width <= 0 || height <= 0) {
    _matched_observation = false;
    _candidate_hits = 0;
    refresh(nowMs);
    return;
  }
  if (_width != width || _height != height) {
    _width = width; _height = height;
    _state.locked = false;
    _candidate_hits = 0;
  }
  refresh(nowMs);
  BBox valid[kMaxFaces];
  size_t n = 0;
  if (boxes) {
    const size_t bound = count < kMaxFaces ? count : kMaxFaces;
    for (size_t i = 0; i < bound; ++i)
      if (validBox(boxes[i], width, height, _cfg.minimum_score, valid[n])) ++n;
  }
  _matched_observation = false;
  _state.ambiguous = false;
  if (_state.locked) {
    int best = -1;
    float bestScore = -1, secondScore = -1;
    for (size_t i = 0; i < n; ++i) {
      const float score = association(_target, valid[i]);
      if (score > bestScore) { secondScore = bestScore; bestScore = score; best = (int)i; }
      else if (score > secondScore) secondScore = score;
    }
    // Geometrically indistinguishable candidates are safer to hold than switch.
    if (best >= 0 && secondScore >= 0 && bestScore - secondScore < .14f) {
      _state.ambiguous = true;
    } else if (best >= 0) {
      accept(valid[best], nowMs, false);
    }
  } else if (n != 0) {
    int candidate = -1;
    float match = -1;
    if (_candidate_hits && (uint32_t)(nowMs - _candidate_last) <= _cfg.fresh_ms) {
      for (size_t i = 0; i < n; ++i) {
        const float score = association(_candidate, valid[i]);
        if (score > match) { match = score; candidate = (int)i; }
      }
    }
    if (candidate < 0) {
      float score = -1;
      for (size_t i = 0; i < n; ++i) {
        const float s = acquisitionScore(valid[i]);
        if (s > score) { score = s; candidate = (int)i; }
      }
      _candidate_hits = 0;
      _candidate_since = nowMs;
    }
    _candidate = valid[candidate];
    _candidate_last = nowMs;
    if (_candidate_hits < 255) ++_candidate_hits;
    if (_candidate_hits >= _cfg.acquisition_frames &&
        (uint32_t)(nowMs - _candidate_since) >= _cfg.acquisition_ms) {
      accept(_candidate, nowMs, true);
      _candidate_hits = 0;
    }
  } else {
    _candidate_hits = 0;
  }
  refresh(nowMs);
}

void Controller::update(float dt, uint32_t nowMs) {
  const uint32_t elapsed = nowMs - _last_update;
  if (elapsed >= 0x80000000u) return;
  _last_update = nowMs;
  refresh(nowMs);
  if (!_actuationEnabled) { _state.pan_velocity = _state.tilt_velocity = 0; return; }
  if (elapsed == 0 || !isfinite(dt) || dt <= 0.f) return;
  if (dt > .25f || elapsed > 250) {
    _state.pan_velocity = _state.tilt_velocity = 0;
    return;
  }
  float panVelocity = 0, tiltVelocity = 0;
  if (_state.tracking) {
    panVelocity = withoutDeadZone(_state.error_x, _cfg.dead_zone_x) * _cfg.pan_gain;
    tiltVelocity = withoutDeadZone(_state.error_y, _cfg.dead_zone_y) * _cfg.tilt_gain;
  } else if (_have_target && _state.lost_ms >= _cfg.return_after_ms) {
    panVelocity = -_state.pan * 2.f;
    tiltVelocity = -_state.tilt * 2.f;
  }
  // Substeps preserve real elapsed time at both 9 Hz and 30 Hz.
  while (dt > .00001f) {
    const float step = fminf(dt, .01f);
    advanceAxis(panVelocity, step, _cfg.pan_min, _cfg.pan_max, _cfg.pan_speed,
                _cfg.pan_acceleration, _state.pan, _state.pan_velocity);
    advanceAxis(tiltVelocity, step, _cfg.tilt_min, _cfg.tilt_max, _cfg.tilt_speed,
                _cfg.tilt_acceleration, _state.tilt, _state.tilt_velocity);
    dt -= step;
  }
}

}  // namespace facetrack
