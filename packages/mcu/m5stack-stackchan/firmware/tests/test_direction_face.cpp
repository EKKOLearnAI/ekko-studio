// HOST_FLAGS:
#include "motion.h"
#include "face_tracker.h"
#include <cassert>
#include <cmath>
#include <cstdio>
#include <initializer_list>
int main() {
  unsigned cases=0;
  for (float frame : {.02f,.146f}) for (uint8_t action : {motion::A_LOOK_LEFT,motion::A_LOOK_RIGHT,motion::A_LOOK_UP,motion::A_LOOK_DOWN}) {
    facetrack::Controller face; face.reset(0,0,0);
    const facetrack::BBox box(205,55,275,145,.95f);
    motion::Planner p; p.setLimits(motion::limitsFor(3)); p.setAmp(1.3f); p.setIdle(false);
    uint32_t now=0;
    for (unsigned n=0;n<20;++n) {
      now+=100; face.observe(&box,1,320,240,now); face.update(.1f,now);
      const auto s=face.snapshot(); p.setFaceLook(s.locked||s.returning,s.pan,s.tilt); p.update(.1f);
    }
    assert(face.snapshot().locked); const uint32_t id=face.snapshot().lock_id;
    assert(p.playDirection(action,.9f)); const float fixed=action==motion::A_LOOK_LEFT||action==motion::A_LOOK_RIGHT ? p.tilt() : p.pan();
    for (unsigned n=0;n<30;++n) {
      now+=uint32_t(frame*1000+.5f); face.observe(&box,1,320,240,now);
      face.setActuationEnabled(false,p.pan(),p.tilt(),now); face.update(frame,now);
      const auto s=face.snapshot();
      assert(s.locked && s.lock_id==id && !s.pan_velocity && !s.tilt_velocity);
      p.setFaceLook(false,s.pan,s.tilt); p.setBase(float(n%5),-float(n%7)); p.update(frame);
      const float held=action==motion::A_LOOK_LEFT||action==motion::A_LOOK_RIGHT ? p.tilt() : p.pan();
      assert(std::fabs(held-fixed)<.0001f);
    }
    const float beforePan=p.pan(),beforeTilt=p.tilt(); p.release(.4f);
    now+=20; face.observe(&box,1,320,240,now);
    face.setActuationEnabled(true,p.physicalLookPan(),p.physicalLookTilt(),now); face.update(.02f,now);
    const auto resumed=face.snapshot(); assert(resumed.locked && resumed.lock_id==id && !resumed.pan_velocity);
    p.setFaceLook(resumed.locked||resumed.returning,resumed.pan,resumed.tilt); p.update(.02f);
    assert(std::fabs(p.pan()-beforePan)<1 && std::fabs(p.tilt()-beforeTilt)<1);
    for (unsigned n=0;n<80;++n) {
      now+=20; face.observe(&box,1,320,240,now);
      face.setActuationEnabled(true,p.physicalLookPan(),p.physicalLookTilt(),now); face.update(.02f,now);
      const auto s=face.snapshot(); p.setFaceLook(s.locked||s.returning,s.pan,s.tilt); p.update(.02f);
    }
    assert(!p.directionActive() && !p.busy() && face.snapshot().locked);
    ++cases;
  }
  std::printf("direction_face: %u actual Controller/Planner cadence+direction handoffs passed\n",cases);
}
