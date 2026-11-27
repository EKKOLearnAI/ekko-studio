// Pure C++ regression tests: no Arduino headers, mocks, or device access.
#include "motion.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <initializer_list>

static void require(bool condition, const char* message) {
  if (!condition) {
    std::fprintf(stderr, "FAIL: %s\n", message);
    std::exit(1);
  }
}

static void near(float actual, float expected, float tolerance, const char* message) {
  if (!std::isfinite(actual) || std::fabs(actual - expected) > tolerance) {
    std::fprintf(stderr, "FAIL: %s (actual %.6f, expected %.6f, tolerance %.6f)\n",
                 message, actual, expected, tolerance);
    std::exit(1);
  }
}

static motion::Planner planner() {
  motion::Planner p;
  p.setLimits({60.f, -30.f, 15.f, 1.f});
  return p;
}

static void advance(motion::Planner& p, double seconds, double hz) {
  double elapsed = 0;
  while (seconds - elapsed > 1e-8) {
    const double remaining = seconds - elapsed;
    const double dt = remaining < 1.0 / hz ? remaining : 1.0 / hz;
    p.update(static_cast<float>(dt));
    elapsed += dt;
  }
}

static void faceOwnsGazeAndRestoresOrdinaryLook() {
  auto p = planner();
  p.lookAt(-20.f, -8.f);
  p.setIdle(true);
  p.setFaceLook(true, 12.f, -4.f);
  advance(p, 12.0, 30.0);  // Several ordinary idle-look deadlines pass.
  near(p.lookPan(), 12.f, .01f, "idle must not move the face gaze");
  near(p.lookTilt(), -4.f, .01f, "face tilt remains stable");
  float idlePan = 0, idleTilt = 0;
  require(!p.takeIdleLook(idlePan, idleTilt), "face ownership suppresses idle-look events");

  p.setFaceLook(false);
  near(p.targetPan(), -20.f, .001f, "face release preserves the ordinary pan target");
  near(p.targetTilt(), -8.f, .001f, "face release preserves the ordinary tilt target");
  p.setIdle(false);
  advance(p, 1.5, 30.0);
  near(p.lookPan(), -20.f, .04f, "ordinary gaze resumes through the spring");
  near(p.lookTilt(), -8.f, .04f, "ordinary tilt resumes through the spring");
}

static void faceUpdatesKeepTheNod() {
  auto p = planner();
  p.setFaceLook(true, 12.f, -4.f);
  advance(p, 1.5, 30.0);
  const float restingTilt = p.tilt();
  p.play(motion::A_NOD);
  p.setFaceLook(true, 12.f, -4.f);  // Same per-frame update as the app's controller.
  p.update(.26f);
  require(p.current() == motion::A_NOD && p.busy(), "face updates must retain the active nod");
  require(p.tilt() > restingTilt + 6.f, "nod is visibly added to the face tilt");
  near(p.targetPan(), 12.f, .001f, "nod does not replace the face target");
  advance(p, .6, 30.0);
  require(!p.busy(), "nod finishes while face ownership remains enabled");
  near(p.tilt(), restingTilt, .03f, "completed nod returns to the tracked face");
}

static void realTimeAgreesAtNineAndThirtyHz(float amplitude = 1.f) {
  auto slow = planner(), fast = planner();
  slow.setAmp(amplitude);
  fast.setAmp(amplitude);
  slow.play(motion::A_HM);
  fast.play(motion::A_HM);
  for (int window = 0; window < 6; ++window) {
    const float pan = window % 2 ? -10.f : 16.f;
    slow.setFaceLook(true, pan, -5.f);
    fast.setFaceLook(true, pan, -5.f);
    advance(slow, 1.0 / 3.0, 9.0);
    advance(fast, 1.0 / 3.0, 30.0);
    near(slow.pan(), fast.pan(), .35f, "9 Hz pan follows the same real-time trajectory");
    near(slow.tilt(), fast.tilt(), .35f, "9 Hz tilt follows the same real-time trajectory");
  }
  advance(slow, 1.0 / 9.0, 9.0);
  advance(fast, 1.0 / 9.0, 30.0);
  // The two-second gesture must finish after 2.111 real seconds. The former
  // 100 ms dt cap leaves the 9 Hz planner at 1.9 seconds and fails this check.
  require(!slow.busy() && !fast.busy(), "a slow display must not stretch gesture duration");
}

static void longPauseDoesNotCatchUp() {
  auto p = planner();
  p.setFaceLook(true, 25.f, -6.f);
  p.play(motion::A_HM);
  p.update(.2f);
  const float pan = p.pan(), tilt = p.tilt();
  p.update(2.f);
  near(p.pan(), pan, .00001f, "a long pause must not jump pan forward");
  near(p.tilt(), tilt, .00001f, "a long pause must not jump tilt forward");
  require(p.current() == motion::A_HM && p.busy(), "a long pause must not fast-forward the gesture");
}

static void faceBaseIgnoresAmplitude() {
  for (uint8_t body : {uint8_t(1), uint8_t(3)}) {
    motion::Planner p;
    p.setLimits(motion::limitsFor(body));
    p.setFaceLook(true, 12.f, -4.f);
    advance(p, 2.0, 9.0);
    for (float amplitude : {.55f, 1.3f, 1.f, .55f}) {
      p.setAmp(amplitude);
      p.update(.02f);
      near(p.pan(), 12.f, .01f, "amplitude changes must not scale tracked pan");
      near(p.tilt(), -4.f, .01f, "amplitude or body tilt scale must not scale tracked tilt");
      near(p.physicalLookPan(), 12.f, .01f, "controller seed reports physical tracked pan");
      near(p.physicalLookTilt(), -4.f, .01f, "controller seed reports physical tracked tilt");
    }
    p.setAmp(0.f);
    p.update(.02f);
    near(p.pan(), 0.f, .001f, "motion off suppresses tracked pan");
    near(p.tilt(), 0.f, .001f, "motion off suppresses tracked tilt");
    near(p.physicalLookPan(), 0.f, .001f, "motion-off controller seed pan is zero");
    near(p.physicalLookTilt(), 0.f, .001f, "motion-off controller seed tilt is zero");
    p.setAmp(1.3f);
    p.update(.02f);
    near(p.pan(), 12.f, .01f, "restoring motion retains the physical pan target");
    near(p.tilt(), -4.f, .01f, "restoring motion retains the physical tilt target");
  }
}

static void trackedGesturesRetainAmplitude() {
  for (uint8_t body : {uint8_t(1), uint8_t(3)}) {
    const auto limits = motion::limitsFor(body);
    for (float amplitude : {.55f, 1.f, 1.3f}) {
      for (auto action : {motion::A_NOD, motion::A_ANGRY}) {
        motion::Planner p;
        p.setLimits(limits);
        p.setAmp(amplitude);
        p.setFaceLook(true, 12.f, -4.f);
        advance(p, 2.0, 30.0);
        p.play(action, .9f);
        p.update(action == motion::A_NOD ? .26f : .45f);
        const float gesturePan = action == motion::A_NOD ? 0.f : 14.f;
        const float gestureTilt = action == motion::A_NOD ? 9.f : 5.f;
        near(p.pan(), 12.f + gesturePan * .9f * amplitude, .02f,
             "nod and angry scale their offsets around the physical face pan");
        near(p.tilt(), -4.f + gestureTilt * .9f * amplitude * limits.tiltScale, .02f,
             "nod and angry retain amplitude and body tilt scaling");
      }
    }
  }
}

static void gazeModeChangesRemainContinuous() {
  for (uint8_t body : {uint8_t(1), uint8_t(3)}) {
    const auto limits = motion::limitsFor(body);
    for (float amplitude : {.55f, 1.3f}) {
      motion::Planner p;
      p.setLimits(limits);
      p.setAmp(amplitude);
      p.lookAt(-20.f, -8.f);
      advance(p, 2.0, 30.0);
      const float ordinaryPan = -20.f * amplitude;
      const float ordinaryTilt = -8.f * amplitude * limits.tiltScale;
      near(p.pan(), ordinaryPan, .01f, "ordinary gaze keeps its original global amplitude");
      near(p.tilt(), ordinaryTilt, .01f, "ordinary gaze keeps its original body scaling");
      near(p.physicalLookPan(), ordinaryPan, .01f, "controller seed includes ordinary pan gain");
      near(p.physicalLookTilt(), ordinaryTilt, .01f, "controller seed includes ordinary tilt gain");
      p.setFaceLook(true, 12.f, -4.f);
      near(p.physicalLookPan(), ordinaryPan, .01f, "acquiring face preserves the seed pan");
      near(p.physicalLookTilt(), ordinaryTilt, .01f, "acquiring face preserves the seed tilt");
      p.update(.0001f);
      near(p.pan(), ordinaryPan, .01f, "acquiring a face must not jump the current pan");
      near(p.tilt(), ordinaryTilt, .01f, "acquiring a face must not jump the current tilt");
      advance(p, 2.0, 30.0);
      near(p.pan(), 12.f, .01f, "acquired face converges to physical pan");
      near(p.tilt(), -4.f, .01f, "acquired face converges to physical tilt");
      p.play(motion::A_ANGRY, .9f);
      p.update(.45f);
      near(p.physicalLookPan(), 12.f, .01f, "controller seed excludes the angry pan offset");
      near(p.physicalLookTilt(), -4.f, .01f, "controller seed excludes the angry tilt offset");
      const float pan = p.pan(), tilt = p.tilt();
      p.setFaceLook(false);  // Also exercise explicit disable before return-to-center.
      near(p.physicalLookPan(), 12.f, .01f, "releasing face preserves the seed pan");
      near(p.physicalLookTilt(), -4.f, .01f, "releasing face preserves the seed tilt");
      p.update(.0001f);
      near(p.pan(), pan, .02f, "releasing face gaze during a gesture preserves pan continuity");
      near(p.tilt(), tilt, .02f, "releasing face gaze during a gesture preserves tilt continuity");
      near(p.targetPan(), -20.f, .001f, "face release retains the ordinary pan target");
      near(p.targetTilt(), -8.f, .001f, "face release retains the ordinary tilt target");
      advance(p, 3.0, 30.0);
      near(p.pan(), ordinaryPan, .02f, "ordinary pan resumes after the angry gesture");
      near(p.tilt(), ordinaryTilt, .02f, "ordinary tilt resumes after the angry gesture");

      p.setFaceLook(true, 0.f, 0.f);
      advance(p, 2.0, 9.0);
      near(p.pan(), 0.f, .01f, "face controller can return pan to center");
      near(p.tilt(), 0.f, .01f, "face controller can return tilt to center");
      p.setFaceLook(false);
      p.update(.0001f);
      near(p.pan(), 0.f, .01f, "normal centered release is continuous in pan");
      near(p.tilt(), 0.f, .01f, "normal centered release is continuous in tilt");
    }
  }
}

static void physicalGazeSeedHonorsPlannerLimits() {
  motion::Planner p;
  p.setLimits(motion::limitsFor(3));
  p.setAmp(1.3f);
  p.lookAt(100.f, -100.f);
  advance(p, 3.0, 9.0);
  near(p.physicalLookPan(), 70.f, .001f, "controller seed is clipped to the planner pan limit");
  near(p.physicalLookTilt(), -40.f, .001f, "controller seed is clipped to the planner tilt limit");
  p.setAmp(0.f);
  near(p.physicalLookPan(), 0.f, .001f, "disabled ordinary pan seed is zero");
  near(p.physicalLookTilt(), 0.f, .001f, "disabled ordinary tilt seed is zero");
}

static float boundedStep(float delta, float maximum) {
  return delta < -maximum ? -maximum : (delta > maximum ? maximum : delta);
}

static void angryRemainsVisibleAtTrackingSpeeds(double displayHz) {
  motion::Planner p;
  p.setLimits(motion::limitsFor(3));
  p.setAmp(1.3f);  // The existing motion-high setting.
  p.setFaceLook(true, 12.f, -4.f);
  advance(p, 2.0, displayHz);
  const float gazePan = p.pan(), gazeTilt = p.tilt();
  float headPan = gazePan, headTilt = gazeTilt;
  float minimum = 0.f, maximum = 0.f, maximumLean = 0.f;
  p.play(motion::A_ANGRY, .9f);
  const double frame = 1.0 / displayHz;
  double nextFrame = frame;
  // Exercise the new trajectory through a separate actuator envelope: commands
  // arrive at the display rate, while the existing head driver filters at 50 Hz
  // and caps face-owned motion at 35/20 deg/s. This verifies command visibility,
  // not the physical servo's torque, position feedback, or acoustic behavior.
  for (int tick = 1; tick <= 200; ++tick) {
    const double time = tick * .02;
    while (nextFrame <= time + 1e-8) {
      p.update(static_cast<float>(frame));
      nextFrame += frame;
    }
    require(p.pan() >= -70.f && p.pan() <= 70.f, "angry preserves the K151 planner pan bound");
    require(p.tilt() >= -40.f && p.tilt() <= 12.f, "angry preserves the K151 planner tilt bounds");
    headPan += boundedStep((p.pan() - headPan) * .6f, 35.f * .02f);
    headTilt += boundedStep((p.tilt() - headTilt) * .6f, 20.f * .02f);
    const float offset = headPan - gazePan;
    minimum = offset < minimum ? offset : minimum;
    maximum = offset > maximum ? offset : maximum;
    const float lean = headTilt - gazeTilt;
    maximumLean = lean > maximumLean ? lean : maximumLean;
  }
  std::printf("angry %.1f Hz: head offsets %.2f..%.2f deg, lean %.2f deg\n",
              displayHz, minimum, maximum, maximumLean);
  require(minimum < -8.f && maximum > 10.f, "rate-limited angry visibly moves in both directions");
  require(maximum - minimum > 20.f, "rate-limited angry has a clear side-to-side sweep");
  require(maximumLean > 5.f && maximumLean < 9.f, "angry has a modest forward lean");
  near(headPan, gazePan, .05f, "angry returns to the tracked pan");
  near(headTilt, gazeTilt, .05f, "angry returns to the tracked tilt");
  near(p.targetPan(), 12.f, .001f, "angry does not replace the face gaze");
  require(!p.busy(), "angry finishes within its finite keyframe duration");
}

static void angryHonorsLimitsAndMotionOff() {
  require(motion::actForState(21) == motion::A_ANGRY, "state 21 retains its angry action");
  require(motion::actDuration(motion::A_ANGRY) >= 2.f &&
          motion::actDuration(motion::A_ANGRY) <= 3.f, "angry stays within two to three seconds");
  for (int side = -1; side <= 1; side += 2) {
    motion::Planner p;
    const auto limits = motion::limitsFor(3);
    p.setLimits(limits);
    p.setAmp(1.3f);
    p.setFaceLook(true, side * 68.f, side * 30.f);
    advance(p, 2.0, 9.0);
    p.play(motion::A_ANGRY, 1.f);
    for (int i = 0; i < 40; ++i) {
      p.update(1.f / 9.f);
      require(p.pan() >= -limits.panMax && p.pan() <= limits.panMax,
              "edge gaze plus angry cannot expand the pan limit");
      require(p.tilt() >= limits.tiltUp && p.tilt() <= limits.tiltDown,
              "edge gaze plus angry cannot expand the tilt limits");
    }
    p.setAmp(0.f);
    p.play(motion::A_ANGRY, 1.f);
    advance(p, 1.0, 9.0);
    near(p.pan(), 0.f, .001f, "angry respects motion off for pan");
    near(p.tilt(), 0.f, .001f, "angry respects motion off for tilt");
  }
}

int main() {
  faceOwnsGazeAndRestoresOrdinaryLook();
  faceUpdatesKeepTheNod();
  realTimeAgreesAtNineAndThirtyHz();
  realTimeAgreesAtNineAndThirtyHz(.55f);
  realTimeAgreesAtNineAndThirtyHz(1.3f);
  longPauseDoesNotCatchUp();
  faceBaseIgnoresAmplitude();
  trackedGesturesRetainAmplitude();
  gazeModeChangesRemainContinuous();
  physicalGazeSeedHonorsPlannerLimits();
  angryRemainsVisibleAtTrackingSpeeds(7.5);
  angryRemainsVisibleAtTrackingSpeeds(9.0);
  angryRemainsVisibleAtTrackingSpeeds(30.0);
  angryHonorsLimitsAndMotionOff();
  std::puts("PASS: physical face gaze, gesture-only gain, continuous ownership, visible angry, limits, real-time stepping, pause guard");
}
