#include "../PulseStackChan/face_tracker.h"

#include <assert.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <limits>

using facetrack::BBox;
using facetrack::Controller;
using facetrack::Snapshot;

static BBox face(float cx, float cy = 120, float w = 70, float h = 90) {
  return BBox(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, .95f);
}
static float cx(const BBox& b) { return (b.x1 + b.x2) / 2; }
static void acquire(Controller& c, const BBox* b, size_t n, uint32_t t = 0) {
  c.observe(b, n, 320, 240, t);
  assert(!c.snapshot().locked);
  c.observe(b, n, 320, 240, t + 100);
  assert(!c.snapshot().locked);
  c.observe(b, n, 320, 240, t + 200);
  assert(c.snapshot().locked && c.snapshot().tracking);
}
static void testStableLockAndOrder() {
  Controller c;
  BBox faces[2] = {face(120), face(255, 120, 60, 70)};
  acquire(c, faces, 2);
  const uint32_t id = c.snapshot().lock_id;
  for (uint32_t t = 300; t <= 1500; t += 100) {
    BBox a = face(120 + 2.f * sinf(t * .01f), 120, (t / 100) & 1 ? 65 : 80, 90);
    BBox b = face(255, 120, (t / 100) & 1 ? 105 : 50, 90);
    faces[0] = (t / 100) & 1 ? a : b;
    faces[1] = (t / 100) & 1 ? b : a;
    c.observe(faces, 2, 320, 240, t);
    c.update(.1f, t);
    Snapshot s = c.snapshot();
    assert(s.locked && s.tracking && s.lock_id == id);
    assert(fabsf(cx(s.target) - 120) < 3);
  }
}
static void testOcclusionAndReacquisition() {
  Controller c;
  BBox a = face(120), b = face(255);
  acquire(c, &a, 1);
  const uint32_t id = c.snapshot().lock_id;
  for (uint32_t t = 300; t <= 900; t += 100) {
    c.observe(&b, 1, 320, 240, t);
    c.update(.1f, t);
    assert(c.snapshot().locked && !c.snapshot().tracking);
    assert(c.snapshot().lock_id == id);
    assert(fabsf(cx(c.snapshot().target) - 120) < 1);
  }
  c.observe(&a, 1, 320, 240, 1000);
  assert(c.snapshot().tracking && c.snapshot().lock_id == id);
  c.observe(nullptr, 0, 320, 240, 1100);
  c.update(.1f, 2200);
  assert(!c.snapshot().locked);
  c.observe(&b, 1, 320, 240, 2300);
  c.observe(&b, 1, 320, 240, 2400);
  assert(!c.snapshot().locked);
  c.observe(&b, 1, 320, 240, 2500);
  assert(c.snapshot().locked && c.snapshot().lock_id == id + 1);
}
static void testAmbiguousCandidatesHold() {
  Controller c;
  BBox a = face(160);
  acquire(c, &a, 1);
  BBox overlapping[2] = {face(158), face(162)};
  c.observe(overlapping, 2, 320, 240, 300);
  Snapshot s = c.snapshot();
  assert(s.locked && !s.tracking && s.ambiguous && cx(s.target) == 160);
  c.observe(&a, 1, 320, 240, 400);
  assert(c.snapshot().locked && c.snapshot().tracking && !c.snapshot().ambiguous);
}
static void testDeadZoneAndFreshness() {
  Controller c;
  BBox a = face(160);
  acquire(c, &a, 1);
  for (uint32_t t = 220; t <= 1500; t += 20) {
    if (t % 100 == 0) {
      a = face(160 + 5 * sinf(t * .01f), 120 + 4 * cosf(t * .01f));
      c.observe(&a, 1, 320, 240, t);
    }
    c.update(.02f, t);
    assert(fabsf(c.snapshot().pan) < .0001f && fabsf(c.snapshot().tilt) < .0001f);
  }
  c.update(.02f, 1980);
  assert(c.snapshot().locked && !c.snapshot().tracking);
}
static void testLimitsAndMotionEnvelope() {
  Controller c;
  BBox a = face(290, 204, 45, 55);
  acquire(c, &a, 1);
  Snapshot prev = c.snapshot();
  for (uint32_t t = 220; t < 16000; t += 20) {
    if (t % 100 == 0) c.observe(&a, 1, 320, 240, t);
    c.update(.02f, t);
    Snapshot s = c.snapshot();
    assert(s.pan >= -45 && s.pan <= 45 && s.tilt >= -20 && s.tilt <= 8);
    assert(fabsf(s.pan_velocity) <= 35.001f && fabsf(s.tilt_velocity) <= 20.001f);
    assert(fabsf(s.pan_velocity - prev.pan_velocity) <= 2.001f);
    assert(fabsf(s.tilt_velocity - prev.tilt_velocity) <= 1.401f);
    assert(fabsf(s.pan - prev.pan) <= 35 * .02f + .001f);
    assert(fabsf(s.tilt - prev.tilt) <= 20 * .02f + .001f);
    prev = s;
  }
  assert(c.snapshot().pan > 44.8f && c.snapshot().tilt > 7.8f);
  // Losing the face brakes first, then returns smoothly towards centre.
  c.observe(nullptr, 0, 320, 240, 16000);
  for (uint32_t t = 16000; t < 22500; t += 20) {
    c.update(.02f, t);
    Snapshot s = c.snapshot();
    assert(fabsf(s.pan_velocity - prev.pan_velocity) <= 2.001f);
    assert(fabsf(s.tilt_velocity - prev.tilt_velocity) <= 1.401f);
    prev = s;
  }
  assert(!c.snapshot().locked);
  assert(fabsf(c.snapshot().pan) < .2f && fabsf(c.snapshot().tilt) < .2f);
}
static void testNegativeLimitsAndIrregularUpdates() {
  Controller c;
  BBox a = face(30, 30, 45, 45);
  acquire(c, &a, 1);
  c.update(0, 200);
  Snapshot previous = c.snapshot();
  uint32_t seed = 7, now = 200;
  for (int i = 0; i < 1400; ++i) {
    seed = seed * 1664525u + 1013904223u;
    const uint32_t ms = 5 + seed % 176;
    now += ms;
    c.observe(&a, 1, 320, 240, now);
    c.update(ms * .001f, now);
    const Snapshot s = c.snapshot();
    assert(s.pan >= -45 && s.pan <= 45 && s.tilt >= -20 && s.tilt <= 8);
    assert(fabsf(s.pan_velocity - previous.pan_velocity) <= 100 * ms * .001f + .002f);
    assert(fabsf(s.tilt_velocity - previous.tilt_velocity) <= 70 * ms * .001f + .002f);
    previous = s;
  }
  assert(c.snapshot().pan < -44.8f && c.snapshot().tilt < -19.8f);
  const float pan = c.snapshot().pan;
  c.update(.1f, now);  // No elapsed time: cannot integrate a duplicate callback.
  assert(c.snapshot().pan == pan);
}
static Snapshot runAtRate(float hz) {
  Controller c;
  BBox a = face(215, 95);
  acquire(c, &a, 1);
  c.update(0, 200);  // The control task has also advanced during acquisition.
  float previous = 200;
  uint32_t observation = 400;
  for (float t = 200 + 1000 / hz; previous < 1500;) {
    if (t > 1500) t = 1500;
    while (observation <= (uint32_t)lroundf(t)) {
      c.observe(&a, 1, 320, 240, observation);
      observation += 200;
    }
    c.update((t - previous) * .001f, (uint32_t)lroundf(t));
    previous = t;
    t += 1000 / hz;
  }
  return c.snapshot();
}
static void testRealTimeIndependentOfRendering() {
  Snapshot a = runAtRate(30), b = runAtRate(9);
  assert(fabsf(a.pan - b.pan) < .5f);
  assert(fabsf(a.tilt - b.tilt) < .5f);
}
static void testLongGapInvalidAndWrap() {
  Controller c;
  BBox a = face(260);
  acquire(c, &a, 1);
  for (uint32_t t = 220; t <= 400; t += 20) c.update(.02f, t);
  const float angle = c.snapshot().pan;
  c.update(2, 2400);
  assert(c.snapshot().pan == angle && c.snapshot().pan_velocity == 0);
  c.reset();
  BBox invalid[3] = {face(160), BBox(10, 0, 5, 30, 1), face(150)};
  invalid[0].x1 = std::numeric_limits<float>::quiet_NaN();
  invalid[2].score = .1f;
  for (uint32_t t = 0; t <= 500; t += 100) c.observe(invalid, 3, 320, 240, t);
  assert(!c.snapshot().locked);
  c.observe(nullptr, 99, 0, 0, 600);
  assert(!c.snapshot().locked);
  c.reset(100, -100, 0);
  assert(c.snapshot().pan == 45 && c.snapshot().tilt == -20);
  const uint32_t base = UINT32_MAX - 150;
  c.reset(0, 0, base);
  acquire(c, &a, 1, base);
  c.update(.02f, base + 220);
  assert(c.snapshot().locked && c.snapshot().tracking && isfinite(c.snapshot().pan));
  c.observe(nullptr, 0, 320, 240, base + 230);
  c.update(.02f, base + 240);
  assert(c.snapshot().lost_ms == 40);
  // Delayed detector messages must not resurrect stale observations.
  c.observe(&a, 1, 320, 240, base + 225);
  assert(!c.snapshot().tracking);
  // Resolution changes require a fresh acquisition rather than reusing pixels.
  c.observe(&a, 1, 640, 480, base + 250);
  assert(!c.snapshot().locked);
}
int main() {
  testStableLockAndOrder();
  testOcclusionAndReacquisition();
  testAmbiguousCandidatesHold();
  testDeadZoneAndFreshness();
  testLimitsAndMotionEnvelope();
  testNegativeLimitsAndIrregularUpdates();
  testRealTimeIndependentOfRendering();
  testLongGapInvalidAndWrap();
  puts("PASS face tracker: stable multi-face lock, occlusion, ambiguity, dead zone, loss, real dt, limits, invalid inputs and timer wrap");
}
