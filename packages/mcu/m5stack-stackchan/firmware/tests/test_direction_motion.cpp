// HOST_FLAGS:
#include "motion.h"
#include <cassert>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <initializer_list>
#include <limits>
static void near(float a, float b, float tolerance = .0001f) { assert(std::isfinite(a) && std::fabs(a-b) <= tolerance); }
static void advance(motion::Planner& p, float seconds, float frame = .02f) {
  for (float at = 0; at < seconds; at += frame) p.update(frame);
}
static bool panAction(uint8_t a) { return a == motion::A_LOOK_LEFT || a == motion::A_LOOK_RIGHT; }
int main() {
  const char* old[] = {"none","nod","nod3","nod_slow","shake","hm","look_around","hey","hop","giggle","dance","dizzy","surprise","jolt","droop","wake","shy","proud","sigh","listen","broadcast","send","think","recall","search","panic","angry","stop","talk","busy","stretch","pet","track","daze","sad","tired","focus","meh","boot","error","look_up","flinch"};
  for (unsigned i = 0; i < sizeof(old)/sizeof(old[0]); ++i) {
    assert(!std::strcmp(motion::actName(i), old[i]) && motion::findAct(old[i]) == int(i));
  }
  static_assert(motion::A_LOOK_UP==40 && motion::A_FLINCH==41 && motion::A_LOOK_LEFT==42 && motion::A_LOOK_RIGHT==43 && motion::A_LOOK_DOWN==44,"stable IDs");
  const uint8_t actions[] = {motion::A_LOOK_LEFT,motion::A_LOOK_RIGHT,motion::A_LOOK_UP,motion::A_LOOK_DOWN};
  unsigned cases = 0;
  for (uint8_t body : {uint8_t(1),uint8_t(3)}) for (float amp : {.55f,1.f,1.3f})
    for (float frame : {.02f,.146f}) for (uint8_t action : actions) {
      motion::Planner p; p.setLimits(motion::limitsFor(body)); p.setAmp(amp);
      p.setFaceLook(true, 11, -4); advance(p, 2);
      p.setBase(3, -2); p.setBreath(2, 4); p.setGroove(1, .3f, 2);
      p.play(motion::A_NOD); p.update(.2f);
      const float startPan = p.pan(), startTilt = p.tilt();
      assert(p.playDirection(action,.9f)); near(p.pan(),startPan); near(p.tilt(),startTilt);
      const float rawGoal = action==motion::A_LOOK_LEFT ? -35 : action==motion::A_LOOK_RIGHT ? 35 : action==motion::A_LOOK_UP ? -22 : 12;
      const auto limits = p.limits();
      const float gain = amp * .9f * (panAction(action) ? 1 : limits.tiltScale);
      const float low = panAction(action) ? -limits.panMax : limits.tiltUp;
      const float high = panAction(action) ? limits.panMax : limits.tiltDown;
      const float expected = std::fmax(low,std::fmin(high,rawGoal*gain));
      for (unsigned n=0;n<60;++n) {
        // Exercise the actual competing lanes, not a duplicate trajectory.
        p.setBase(float(n%11)-5, float(n%7)-3); p.setFaceLook(true, -30+float(n%17), 6);
        p.lookAt(30,-10); p.setIdle(true); p.setGroove(1, float(n)*.13f, 2.1f);
        p.update(frame);
        near(panAction(action) ? p.tilt() : p.pan(), panAction(action) ? startTilt : startPan);
        assert(p.pan()>=-limits.panMax && p.pan()<=limits.panMax && p.tilt()>=limits.tiltUp && p.tilt()<=limits.tiltDown);
      }
      near(panAction(action) ? p.pan() : p.tilt(),expected);
      assert(p.directionActive() && !p.busy());
      float idlePan=0,idleTilt=0; assert(!p.takeIdleLook(idlePan,idleTilt));
      const float heldP=p.pan(),heldQ=p.tilt(); p.release(.4f);
      assert(!p.directionActive()); near(p.pan(),heldP); near(p.tilt(),heldQ);
      p.setIdle(false); p.setGroove(0,0,0); p.setBreath(0,4); p.setBase(0,0);
      advance(p,1,frame); assert(!p.busy() && p.current()==motion::A_NONE);
      p.setAmp(0); p.update(frame); near(p.pan(),0); near(p.tilt(),0); ++cases;
    }
  motion::Planner p; p.setLimits(motion::limitsFor(3)); p.setAmp(1.3f); p.setIdle(false);
  assert(p.playDirection(motion::A_LOOK_LEFT,.9f)); advance(p,1); const float left=p.pan();
  assert(p.playDirection(motion::A_LOOK_LEFT,.9f)); advance(p,1); near(p.pan(),left);
  assert(p.playDirection(motion::A_LOOK_RIGHT,.9f)); advance(p,.25f); const float halfway=p.pan(), other=p.tilt();
  assert(p.playDirection(motion::A_LOOK_DOWN,.9f)); near(p.pan(),halfway); advance(p,1); near(p.pan(),halfway);
  assert(p.tilt()>other && !p.playDirection(motion::A_NOD) && !p.playDirection(motion::A_LOOK_LEFT,std::numeric_limits<float>::quiet_NaN()));
  p.play(motion::A_NOD); assert(!p.directionActive()); advance(p,1); assert(!p.busy());
  p.playDirection(motion::A_LOOK_UP); advance(p,1); p.release(.4f); p.setAmp(0); p.update(.02f); near(p.pan(),0); near(p.tilt(),0);
  motion::Planner legacy; legacy.setLimits(motion::limitsFor(3)); legacy.play(motion::A_LOOK_UP); advance(legacy,.3f);
  assert(!legacy.directionActive()); near(legacy.pan(),0); near(legacy.tilt(),-22);
  std::printf("direction_motion: %u body/amplitude/cadence/axis cases; legacy IDs/up, single-axis composition, replacement, repeat and release passed\n",cases);
}
