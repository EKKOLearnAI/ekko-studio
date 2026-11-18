// HOST_FLAGS: -I tests/host_stubs
// Reuse the existing hardware boundary fixture; run the actual brain hooks.
#define main historical_brain_life_main
#include "test_brain_life.cpp"
#undef main
#include "face_tracker.h"
#include <cassert>
#include <cmath>
#include <cstring>
int main() {
  using namespace simu;
  plan=motion::Planner(); boot(2026,11,5,15,0); brain::setCareLevel(care::L_OFF);
  plan.setLimits(motion::limitsFor(3)); plan.setAmp(1.3f);
  const char* names[]={"look_left","look_right","look_up","look_down"};
  unsigned generation=1;
  for (const char* name:names) {
    const uint32_t started=g_ms;
    assert(conversation::startTurn("voice-direction",generation++,g_ms));
    plan.setFaceLook(true,12,-5); plan.update(.06f);
    const float enteredPan=plan.pan(),enteredTilt=plan.tilt();
    conversation::Command c; c.commandId=name;c.turnId=conversation::turnId();c.generation=conversation::generation();
    c.actionId=name;c.intensity=.9f;c.durationMs=3000;c.expiresAtMs=g_ms+5000;
    conversation::Ack ack; assert(conversation::apply(c,ack,g_ms));
    assert(plan.directionActive() && plan.current()==motion::findAct(name));
    run(500,146);
    auto emotion=c;emotion.commandId="mood-during-direction";emotion.actionId=nullptr;emotion.emotionId="21";
    emotion.durationMs=10000;emotion.expiresAtMs=g_ms+15000;
    assert(conversation::apply(emotion,ack,g_ms));
    assert(conversation::setPhase(conversation::Phase::Speaking,nullptr,g_ms));
    run(1500,146); assert(plan.directionActive() && plan.current()==motion::findAct(name));
    if (!std::strcmp(name,"look_left") || !std::strcmp(name,"look_right")) assert(std::fabs(plan.tilt()-enteredTilt)<.0001f);
    else assert(std::fabs(plan.pan()-enteredPan)<.0001f);
    while (g_ms-started<3000) frame(146);
    assert(!plan.directionActive()); // Emotion did not replace or renew the direction.
    conversation::cancel(g_ms); run(800,146); assert(!plan.directionActive() && !plan.busy());
  }
  // The original local head-touch action remains an ordinary layered gesture.
  brain::playAct(motion::A_LOOK_UP,.7f); assert(!plan.directionActive());
  assert(conversation::startTurn("short-direction",generation++,g_ms));
  const uint32_t acceptedAt = g_ms;
  conversation::Command tiny; tiny.commandId="one-ms"; tiny.turnId=conversation::turnId();
  tiny.generation=conversation::generation(); tiny.actionId="look_left";
  tiny.durationMs=1; tiny.expiresAtMs=acceptedAt+1;
  g_ms+=2; // Real clock may advance between scheduler entry and its synchronous hook.
  conversation::Ack tinyAck; assert(conversation::apply(tiny,tinyAck,acceptedAt));
  assert(!plan.directionActive() && plan.current()==motion::A_NONE);
  conversation::update(g_ms);
  std::puts("direction_brain: four real commands, TTL/short-TTL expiry, emotion priority and legacy local up passed");
}
