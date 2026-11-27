// HOST_FLAGS:
// Real conversation scheduler and Planner; only hardware-facing hooks record I/O.
#include "conversation.h"
#include "motion.h"
#include <cassert>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <initializer_list>

namespace {
motion::Planner planner;
struct Trace {
  unsigned plays = 0, releases = 0, ownerReleases = 0;
  uint8_t lastAction = motion::A_NONE, lastVisual = 0;
  bool stopped = false;
} trace;
uint32_t now = 0;
bool acquire() { return true; }
void releaseOwner(bool stopped) { ++trace.ownerReleases; trace.stopped = stopped; planner.release(.4f); }
void visual(uint8_t id, bool) { trace.lastVisual = id; }
void play(uint8_t action, float intensity) {
  ++trace.plays; trace.lastAction = action;
  if (motion::isDirectionalAction(action)) assert(conversation::directionalActionHeld(now));
  planner.play(action, intensity);
}
void releaseAction() { ++trace.releases; planner.release(.4f); }
void stopAudio() {}
void reset(uint32_t at = 0) {
  now = at;
  conversation::begin({acquire, releaseOwner, visual, play, releaseAction, stopAudio}, at);
  planner = motion::Planner(); planner.setLimits(motion::limitsFor(3));
  planner.setIdle(false); planner.setBreath(0, 4); trace = Trace();
}
void start(uint32_t at = 100, const char* id = "turn", uint32_t generation = 1) {
  now = at; assert(conversation::startTurn(id, generation, at));
}
conversation::Command command(const char* id, uint32_t at, const char* action,
                              const char* emotion = nullptr, uint32_t duration = 1000,
                              uint32_t ttl = 5000) {
  conversation::Command c;
  c.commandId = id; c.turnId = conversation::turnId(); c.generation = conversation::generation();
  c.expiresAtMs = at + ttl; c.actionId = action; c.emotionId = emotion;
  c.durationMs = duration; c.intensity = .8f; return c;
}
void apply(const conversation::Command& c, uint32_t at) {
  now = at; conversation::Ack ack;
  assert(conversation::apply(c, ack, at) && ack.status == conversation::AckStatus::Accepted);
}
void update(uint32_t at) { now = at; conversation::update(at); }
void phase(conversation::Phase phase, uint32_t at) { now = at; assert(conversation::setPhase(phase, nullptr, at)); }

void expressionAndPhaseKeepEveryDirectionUntilOriginalDeadline() {
  for (const char* action : {"look_left", "look_right", "look_up", "look_down"}) {
    reset(); start(); apply(command("direction", 110, action), 110);
    const uint8_t id = motion::findAct(action);
    assert(conversation::directionalActionHeld(110) && conversation::actionId() == id);
    planner.update(.2f); const unsigned plays = trace.plays, releases = trace.releases;
    apply(command("expression", 200, nullptr, "30", 5000, 6000), 200);
    assert(trace.lastVisual == 30 && trace.plays == plays && trace.releases == releases);
    assert(planner.current() == id && conversation::directionalActionHeld(200));
    phase(conversation::Phase::Thinking, 300);
    now = 310; conversation::setPlaybackActive(true, now);
    phase(conversation::Phase::Speaking, 310);
    now = 400; conversation::setPlaybackActive(false, now); conversation::speechEnded(now);
    phase(conversation::Phase::Done, 500);
    assert(trace.plays == plays && trace.releases == releases && planner.current() == id);
    // Querying a future deadline is pure: it cannot release the real Planner.
    assert(conversation::directionalActionHeld(1109) && !conversation::directionalActionHeld(1110));
    assert(planner.current() == id && trace.plays == plays);
    update(1110);
    assert(!conversation::directionalActionHeld(1110) && trace.plays == plays + 1);
    assert(planner.current() == motion::A_THINK); // Ordinary expression behavior resumes.
  }
}
void ttlAndDuplicatesCannotExtendTheDirection() {
  reset(); start(); auto c = command("direction", 110, "look_left", nullptr, 5000, 300);
  apply(c, 110); conversation::Ack ack; now = 200;
  assert(conversation::apply(c, ack, now) && ack.status == conversation::AckStatus::Duplicate);
  phase(conversation::Phase::Listening, 300);
  assert(conversation::directionalActionHeld(409) && !conversation::directionalActionHeld(410));
  update(410); assert(conversation::actionId() == motion::A_NONE && planner.current() == motion::A_NONE);
  assert(trace.plays == 1); planner.update(.6f); assert(!planner.busy());
}
void pendingSpeechDirectionSurvivesExpressionWithoutRenewal() {
  reset(); start(1000);
  auto c = command("direction", 1100, "look_right", nullptr, 1000);
  c.actionTiming = conversation::ActionTiming::SpeechStart; apply(c, 1100);
  assert(conversation::actionId() == motion::A_NONE && conversation::expressionCues().action_pending);
  assert(conversation::directionalActionHeld(1100) && trace.plays == 0);
  apply(command("expression", 1200, nullptr, "21", 5000, 6000), 1200);
  phase(conversation::Phase::Working, 1250);
  assert(conversation::expressionCues().action_pending && trace.plays == 0);
  now = 1500; conversation::setPlaybackActive(true, now);
  assert(!conversation::expressionCues().action_pending && planner.current() == motion::A_LOOK_RIGHT);
  const unsigned plays = trace.plays;
  phase(conversation::Phase::Speaking, 1510);
  now = 1600; conversation::setPlaybackActive(true, now); assert(trace.plays == plays);
  assert(conversation::directionalActionHeld(2099) && !conversation::directionalActionHeld(2100));
  update(2100); assert(planner.current() == motion::A_ANGRY && trace.plays == plays + 1);

  reset(); start(1000); c = command("direction", 1100, "look_up", nullptr, 1000, 200);
  c.actionTiming = conversation::ActionTiming::SpeechStart; apply(c, 1100);
  apply(command("expression", 1200, nullptr, "30", 5000, 6000), 1200);
  update(1300); assert(!conversation::directionalActionHeld(1300) && !conversation::expressionCues().action_pending);
  const unsigned afterExpiry = trace.plays;
  now = 1350; conversation::setPlaybackActive(true, now);
  assert(trace.plays == afterExpiry && planner.current() != motion::A_LOOK_UP);
}
void explicitReplacementStopAndNewGenerationRemainAuthoritative() {
  reset(); start(); apply(command("left", 110, "look_left"), 110);
  apply(command("right", 200, "look_right", nullptr, 200), 200);
  assert(planner.current() == motion::A_LOOK_RIGHT && conversation::directionalActionHeld(399));
  update(400); assert(planner.current() == motion::A_NONE && !conversation::directionalActionHeld(400));
  apply(command("down", 500, "look_down"), 500);
  apply(command("nod", 600, "nod"), 600);
  assert(planner.current() == motion::A_NOD && !conversation::directionalActionHeld(600));
  apply(command("up", 700, "look_up"), 700); planner.update(.2f);
  apply(command("stop", 800, nullptr, "41"), 800);
  assert(!conversation::active() && !conversation::directionalActionHeld(800) && trace.stopped);
  planner.update(.6f); assert(planner.current() == motion::A_NONE && !planner.busy());

  reset(); start(); apply(command("left", 110, "look_left"), 110);
  now = 200; assert(conversation::startTurn("next", 2, now, true));
  assert(!conversation::directionalActionHeld(200) && conversation::actionId() == motion::A_NONE);
  assert(planner.current() == motion::A_NONE);
  auto stale = command("stale", 210, "look_right"); stale.generation = 1; stale.turnId = "turn";
  conversation::Ack ack; now = 210; const unsigned plays = trace.plays;
  assert(!conversation::apply(stale, ack, now) && ack.status == conversation::AckStatus::Stale && trace.plays == plays);
  auto pending = command("pending", 220, "look_down");
  pending.actionTiming = conversation::ActionTiming::SpeechStart; apply(pending, 220);
  now = 230; assert(conversation::startTurn("third", 3, now));
  now = 240; conversation::setPlaybackActive(true, now);
  assert(!conversation::directionalActionHeld(now) && !conversation::expressionCues().action_pending && trace.plays == plays);
  apply(command("right", 250, "look_right"), 250);
  now = 260; conversation::cancel(now);
  assert(!conversation::directionalActionHeld(now) && planner.current() == motion::A_NONE);
}
void wrappedClockAndLegacyExpressionsRemainUnchanged() {
  const uint32_t base = UINT32_MAX - 500;
  reset(base); start(base); apply(command("direction", base + 10, "look_left"), base + 10);
  apply(command("expression", base + 100, nullptr, "30", 5000, 6000), base + 100);
  assert(conversation::directionalActionHeld(base + 1009)); update(base + 1010);
  // Listening intentionally suppresses default head gestures even when the
  // retained expression is Thinking; expiry must restore that original rule.
  assert(!conversation::directionalActionHeld(base + 1010) && planner.current() == motion::A_NONE);
  reset(); start(); apply(command("legacy", 110, "nod"), 110);
  apply(command("expression", 200, nullptr, "30"), 200);
  assert(planner.current() == motion::A_THINK && !conversation::directionalActionHeld(200));
}
} // namespace
int main() {
  expressionAndPhaseKeepEveryDirectionUntilOriginalDeadline();
  ttlAndDuplicatesCannotExtendTheDirection(); pendingSpeechDirectionSurvivesExpressionWithoutRenewal();
  explicitReplacementStopAndNewGenerationRemainAuthoritative(); wrappedClockAndLegacyExpressionsRemainUnchanged();
  std::puts("direction_conversation: four directions, immutable TTL, phases, expressions, speech-start, replacement, cancellation, generation and wrap passed");
}
