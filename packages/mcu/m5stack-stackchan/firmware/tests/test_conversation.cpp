// clang++ -std=c++11 -O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer \
//   -I PulseStackChan tests/test_conversation.cpp PulseStackChan/conversation.cpp \
//   PulseStackChan/motion.cpp -o /tmp/pulse-test-conversation
#include "conversation.h"
#include "motion.h"
#include <assert.h>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>

namespace {
using namespace conversation;
motion::Planner planner;
bool canAcquire = true, lastSound = false, stopped = false;
unsigned states = 0, actions = 0, stops = 0, releases = 0;
uint8_t lastState = 255, lastAction = 0;
float lastIntensity = 0;
uint32_t nextGeneration = 0;
Hooks hooks{
  []() { return canAcquire; },
  [](bool stop) { ++releases; stopped = stop; },
  [](uint8_t state, bool sound) { ++states; lastState = state; lastSound = sound; },
  [](uint8_t action, float intensity) {
    ++actions; lastAction = action; lastIntensity = intensity;
    planner.play(action, intensity);
  },
  []() { planner.release(.1f); },
  []() { ++stops; }
};
void fresh(uint32_t now = 100) {
  assert(startTurn("test-turn", ++nextGeneration, now));
  assert(active() && phase() == Phase::Listening && lastState == 35);
}
Command command(const char* id, uint32_t now = 100) {
  Command c;
  c.commandId = id;
  c.turnId = "test-turn";
  c.generation = generation();
  c.expiresAtMs = now + 10000;
  return c;
}
void expectInvalid(Command c, uint32_t now = 100) {
  const unsigned before = states + actions + stops;
  Ack ack;
  assert(!apply(c, ack, now));
  assert(ack.status == AckStatus::Invalid);
  assert(before == states + actions + stops);
}
void testEmotionSurvivesPhaseEvents() {
  fresh();
  assert(setPhase(Phase::Thinking, nullptr, 100));
  Command mood = command("angry-mood");
  mood.emotionId = "21"; mood.intensity = .9f;
  mood.durationMs = 3000; mood.expiresAtMs = 5100;
  Ack ack;
  assert(apply(mood, ack, 100));
  assert(lastState == 21 && lastAction == motion::A_ANGRY);
  assert(visibleEmotionId() == 21 && actionId() == motion::A_ANGRY);
  const unsigned beforePhase = states + actions;
  assert(setPhase(Phase::Working, "tool.completed", 200));
  assert(phase() == Phase::Working && lastState == 21);
  assert(setPhase(Phase::Speaking, "real playback", 400));
  assert(phase() == Phase::Speaking && lastState == 21);
  assert(visibleEmotionId() == 21 && actionId() == motion::A_ANGRY);
  assert(setPhase(Phase::Speaking, "heartbeat", 450));
  assert(states + actions == beforePhase);
  Command nod = command("nod-over-angry", 500);
  nod.actionId = "nod"; nod.durationMs = 100;
  assert(apply(nod, ack, 500) && lastState == 21);
  assert(actionId() == motion::A_NOD);
  update(601);
  assert(lastState == 21 && lastAction == motion::A_ANGRY);
  assert(lastIntensity == .9f);
  Command smallAngry = command("small-angry-action", 650);
  smallAngry.actionId = "angry"; smallAngry.intensity = .1f;
  smallAngry.durationMs = 100;
  assert(apply(smallAngry, ack, 650) && lastIntensity == .1f);
  update(751); assert(lastAction == motion::A_ANGRY && lastIntensity == .9f);
  update(3099); assert(lastState == 21);
  // Neither phase events nor a newer gesture extends the original mood lease.
  assert(setPhase(Phase::Speaking, "heartbeat", 3100));
  assert(lastState == 39 && phase() == Phase::Speaking && !lastSound);
  assert(visibleEmotionId() == 39 && actionId() == motion::A_TALK);
  assert(apply(mood, ack, 3101) && ack.status == AckStatus::Duplicate);
  assert(visibleEmotionId() == 39); // A retry cannot resurrect or extend the mood.
}
void testIndependentDeadlinesAndCancellation() {
  Ack ack;
  fresh();
  Command mood = command("short-mood"); mood.emotionId = "21";
  mood.durationMs = 100;
  assert(apply(mood, ack, 100));
  Command nod = command("longer-nod", 150); nod.actionId = "nod"; nod.durationMs = 300;
  assert(apply(nod, ack, 150));
  assert(setPhase(Phase::Speaking, nullptr, 175));
  update(200);
  assert(visibleEmotionId() == 39 && actionId() == motion::A_NOD);
  update(451); assert(actionId() == motion::A_TALK);

  fresh();
  mood = command("deadline-before-duration"); mood.emotionId = "21";
  mood.durationMs = 3000; mood.expiresAtMs = 250;
  assert(apply(mood, ack, 100));
  assert(setPhase(Phase::Working, nullptr, 200));
  update(250); assert(visibleEmotionId() == 32); // Hard command expiry wins.

  fresh();
  mood = command("mood-through-done"); mood.emotionId = "21"; mood.durationMs = 3000;
  assert(apply(mood, ack, 100));
  assert(setPhase(Phase::Done, nullptr, 200));
  update(2001); assert(active() && phase() == Phase::Done && visibleEmotionId() == 21);
  update(3100); assert(!active() && phase() == Phase::Idle && visibleEmotionId() == 2);

  fresh();
  mood = command("cancel-mood"); mood.emotionId = "21"; mood.durationMs = 15000;
  mood.expiresAtMs = 20100;
  assert(apply(mood, ack, 100));
  assert(setPhase(Phase::Speaking, nullptr, 200));
  cancel(300);
  assert(!active() && visibleEmotionId() == 41 && actionId() == motion::A_NONE);
  assert(!setPhase(Phase::Speaking, nullptr, 301));
  fresh(400);
  assert(visibleEmotionId() == 35 && actionId() == motion::A_NONE);
  assert(!apply(mood, ack, 401) && ack.status == AckStatus::Stale);
  assert(visibleEmotionId() == 35);

  fresh();
  mood = command("replaced-mood"); mood.emotionId = "21"; mood.durationMs = 1000;
  assert(apply(mood, ack, 100));
  Command happy = command("replacement", 500); happy.emotionId = "10"; happy.durationMs = 1500;
  assert(apply(happy, ack, 500));
  assert(setPhase(Phase::Speaking, nullptr, 600));
  update(1101); assert(visibleEmotionId() == 10);
  update(2000); assert(visibleEmotionId() == 39);

  const uint32_t wrap = UINT32_MAX - 99;
  fresh(wrap);
  mood = command("wrapped-mood", wrap); mood.emotionId = "21"; mood.durationMs = 100;
  assert(apply(mood, ack, wrap));
  assert(setPhase(Phase::Speaking, nullptr, UINT32_MAX - 1));
  assert(visibleEmotionId() == 21);
  update(0); assert(visibleEmotionId() == 39);
}
void testPassiveResumeKeepsOnlyVisualLease() {
  fresh();
  Command mood = command("reply-mood"); mood.emotionId = "21";
  mood.intensity = .9f; mood.durationMs = 15000; mood.expiresAtMs = 20100;
  Ack ack;
  assert(apply(mood, ack, 100));
  assert(setPhase(Phase::Working, nullptr, 200));
  assert(setPhase(Phase::Speaking, nullptr, 6000));
  assert(phase() == Phase::Speaking && visibleEmotionId() == 21);
  assert(setPhase(Phase::Done, nullptr, 7000));
  const unsigned beforeResume = actions;
  assert(startTurn("test-turn", ++nextGeneration, 7700, true));
  assert(phase() == Phase::Listening && visibleEmotionId() == 21);
  assert(actionId() == motion::A_NONE && actions == beforeResume);
  assert(!apply(mood, ack, 7701) && ack.status == AckStatus::Stale);
  assert(setPhase(Phase::Listening, "heartbeat", 8000));
  assert(actionId() == motion::A_NONE && actions == beforeResume);
  Command listen = command("reply-mood", 8001); // New-turn ledger is empty.
  listen.actionId = "listen"; listen.durationMs = 100;
  assert(apply(listen, ack, 8001) && ack.status == AckStatus::Accepted);
  assert(visibleEmotionId() == 21 && actionId() == motion::A_LISTEN);
  update(8102);
  assert(visibleEmotionId() == 21 && actionId() == motion::A_NONE);
  update(15099); assert(visibleEmotionId() == 21);
  update(15100); assert(visibleEmotionId() == 35 && actionId() == motion::A_NONE);

  fresh();
  mood = command("noise-does-not-clear-mood"); mood.emotionId = "21";
  mood.durationMs = 15000; mood.expiresAtMs = 20100;
  assert(apply(mood, ack, 100));
  assert(startTurn("test-turn", ++nextGeneration, 500, true));
  assert(visibleEmotionId() == 21 && actionId() == motion::A_NONE);
  assert(setPhase(Phase::Recognizing, nullptr, 600));
  assert(phase() == Phase::Recognizing && visibleEmotionId() == 21);
  Command gesture = command("gesture-before-upload", 650);
  gesture.actionId = "nod"; gesture.durationMs = 5000;
  assert(apply(gesture, ack, 650));
  assert(setPhase(Phase::Listening, "recording", 700));
  assert(setPhase(Phase::Recognizing, "upload", 800));
  assert(visibleEmotionId() == 21 && actionId() == motion::A_NOD);
  // Audio capture is not proof of new semantic intent: noSpeech/retries may
  // cross several internal generations without renewing the original mood.
  const uint32_t noiseTurns[] = {1000, 4000, 8000, 12000, 15000};
  for (uint32_t at : noiseTurns) {
    assert(startTurn("test-turn", ++nextGeneration, at, true));
    assert(phase() == Phase::Listening && visibleEmotionId() == 21);
    assert(actionId() == motion::A_NONE); // No gesture crosses generations.
    assert(!apply(gesture, ack, at) && ack.status == AckStatus::Stale);
    assert(setPhase(Phase::Recognizing, "noSpeech candidate", at + 10));
    assert(phase() == Phase::Recognizing && visibleEmotionId() == 21);
    assert(setPhase(Phase::Listening, "retry", at + 20));
    assert(visibleEmotionId() == 21 && actionId() == motion::A_NONE);
  }
  update(15099); assert(visibleEmotionId() == 21);
  update(15100); assert(visibleEmotionId() == 35 && actionId() == motion::A_NONE);

  fresh();
  mood = command("stop-carried-mood"); mood.emotionId = "21"; mood.durationMs = 3000;
  assert(apply(mood, ack, 100));
  assert(startTurn("test-turn", ++nextGeneration, 500, true));
  cancel(600);
  assert(visibleEmotionId() == 41 && actionId() == motion::A_NONE && !active());
  assert(startTurn("test-turn", ++nextGeneration, 700, true));
  assert(visibleEmotionId() == 35 && actionId() == motion::A_NONE);

  mood = command("normal-start-clears", 700); mood.emotionId = "21";
  assert(apply(mood, ack, 700));
  assert(startTurn("test-turn", ++nextGeneration, 800));
  assert(visibleEmotionId() == 35 && actionId() == motion::A_NONE);

  fresh();
  mood = command("expired-before-resume"); mood.emotionId = "21"; mood.durationMs = 100;
  assert(apply(mood, ack, 100));
  assert(startTurn("test-turn", ++nextGeneration, 200, true));
  assert(visibleEmotionId() == 35 && actionId() == motion::A_NONE);

  const uint32_t wrap = UINT32_MAX - 99;
  fresh(wrap);
  mood = command("wrapped-resume", wrap); mood.emotionId = "21"; mood.durationMs = 100;
  assert(apply(mood, ack, wrap));
  assert(startTurn("test-turn", ++nextGeneration, UINT32_MAX - 50, true));
  assert(visibleEmotionId() == 21 && actionId() == motion::A_NONE);
  update(0); assert(visibleEmotionId() == 35);
}
}

int main() {
  using namespace conversation;
  begin(hooks, 0);
  assert(visibleEmotionId() == -1 && actionId() == motion::A_NONE);
  canAcquire = false;
  assert(!startTurn("blocked", 1, 0));
  canAcquire = true;
  const unsigned beforeListening = actions;
  fresh();
  assert(actions == beforeListening && !lastSound);
  // Returning to Listening and its heartbeats must not start microphone noise.
  assert(setPhase(Phase::Thinking, nullptr, 110));
  assert(lastAction == motion::A_THINK && actions == beforeListening + 1);
  const unsigned beforeReturnToListening = actions;
  assert(setPhase(Phase::Listening, "请说话", 120));
  assert(lastState == 35 && !lastSound && actions == beforeReturnToListening);
  assert(!startTurn("different-turn", generation(), 100));
  const unsigned beforeHeartbeat = states + actions + stops;
  assert(setPhase(Phase::Listening, "心跳", 5000));
  assert(beforeHeartbeat == states + actions + stops);
  assert(!strcmp(statusText(), "心跳"));
  testEmotionSurvivesPhaseEvents();
  testIndependentDeadlinesAndCancellation();
  testPassiveResumeKeepsOnlyVisualLease();

  const char* ids[] = {"00","01","02","03","04","05","06","07",
    "10","11","12","13","14","15","16","17","18","19","20","21",
    "30","31","32","33","34","35","36","37","38","39","40","41"};
  for (const char* id : ids) {
    fresh();
    Command c = command("state"); c.emotionId = id; c.sound = true;
    Ack ack;
    assert(apply(c, ack, 100) && ack.status == AckStatus::Accepted);
    const uint8_t expected = (id[0] - '0') * 10 + id[1] - '0';
    if (expected == 41) {
      assert(!active() && phase() == Phase::Stopped && stopped);
      assert(visibleEmotionId() == 41 && actionId() == motion::A_NONE);
    }
    else {
      assert(lastState == expected);
      if (expected == 39) assert(!lastSound);
      const uint8_t action = motion::actForState(expected);
      if (action) assert(lastAction == action);
      const unsigned beforeTransitions = states + actions;
      assert(setPhase(Phase::Working, nullptr, 200));
      assert(setPhase(Phase::Speaking, nullptr, 300));
      assert(setPhase(Phase::Speaking, "heartbeat", 400));
      assert(visibleEmotionId() == expected && lastState == expected);
      assert(states + actions == beforeTransitions);
      update(2600);
      assert(visibleEmotionId() == 39 && phase() == Phase::Speaking);
    }
  }
  for (uint8_t action = 1; action < motion::A_COUNT; ++action) {
    fresh();
    Command c = command("action"); c.actionId = motion::actName(action);
    c.intensity = 1.f; c.durationMs = 100;
    Ack ack;
    assert(apply(c, ack, 100));
    assert(lastAction == action && lastIntensity == 1.f);
    const unsigned beforeExpiry = actions;
    update(201);
    assert(lastState == 35); // Every finite, held, and looped override expires.
    assert(actions == beforeExpiry && !lastSound); // No automatic listen restart.
  }
  fresh();
  Command c = command("bad"); c.emotionId = "08"; expectInvalid(c);
  c.emotionId = "2"; expectInvalid(c);
  c.emotionId = "42"; expectInvalid(c);
  c.emotionId = "10extra"; expectInvalid(c);
  c.emotionId = "10"; c.intensity = -0.1f; expectInvalid(c);
  c.intensity = 1.01f; expectInvalid(c);
  c.intensity = std::numeric_limits<float>::quiet_NaN(); expectInvalid(c);
  c.intensity = 0; c.durationMs = 30001; expectInvalid(c);
  c.durationMs = 0; expectInvalid(c);
  c.durationMs = 100; c.actionId = "none"; expectInvalid(c);
  c.actionId = "invalid"; expectInvalid(c);
  c.actionId = nullptr;
  char longId[kIdMax + 2]; memset(longId, 'x', sizeof(longId) - 1); longId[sizeof(longId)-1] = 0;
  c.commandId = longId; expectInvalid(c);
  c.commandId = "once"; c.intensity = .5f;
  Ack ack;
  assert(apply(c, ack, 100));
  const unsigned beforeDuplicate = states + actions + stops;
  assert(apply(c, ack, 101) && ack.status == AckStatus::Duplicate);
  assert(beforeDuplicate == states + actions + stops);
  c.commandId = "expired"; c.expiresAtMs = 100;
  assert(!apply(c, ack, 100) && ack.status == AckStatus::Expired);
  c.expiresAtMs = 30101; expectInvalid(c);
  c.expiresAtMs = 10000; --c.generation;
  assert(!apply(c, ack, 100) && ack.status == AckStatus::Stale);

  fresh();
  c = command("forged-speaking"); c.kind = CommandKind::Phase; c.phase = Phase::Speaking;
  expectInvalid(c);
  assert(setPhase(Phase::Speaking, "真正播放开始", 100));
  assert(lastState == 39 && !lastSound);
  const unsigned talkCount = actions;
  update(901); assert(actions == talkCount + 1 && lastAction == motion::A_TALK);
  assert(setPhase(Phase::Thinking, "播放停止", 1000));
  const unsigned afterPlayback = actions;
  update(1900); assert(actions == afterPlayback);
  const uint32_t cancelledGeneration = generation();
  cancel(2000);
  assert(!active() && stopped);
  assert(!startTurn("test-turn", cancelledGeneration, 2001));
  c = command("late", 2000); c.actionId = "nod";
  assert(!apply(c, ack, 2001) && ack.status == AckStatus::NoTurn);
  fresh(2100);
  c.generation = cancelledGeneration;
  assert(!apply(c, ack, 2101) && ack.status == AckStatus::Stale);

  // A full replay ledger never evicts old IDs; cancellation still has a slot.
  fresh();
  for (int i = 0; i < 64; ++i) {
    char id[16]; snprintf(id, sizeof(id), "command-%d", i);
    c = command(id); c.actionId = "nod";
    assert(apply(c, ack, 100));
  }
  c = command("overflow"); c.actionId = "nod";
  assert(!apply(c, ack, 100) && ack.status == AckStatus::Busy);
  c.commandId = "command-0";
  assert(apply(c, ack, 100) && ack.status == AckStatus::Duplicate);
  c.commandId = "stop"; c.kind = CommandKind::Stop;
  assert(apply(c, ack, 100) && !active());
  assert(apply(c, ack, 101) && ack.status == AckStatus::Duplicate);

  // No heartbeat, command, or repeated start can revive an expired generation.
  fresh();
  assert(!setPhase(Phase::Listening, nullptr, 30100) && !active());
  assert(!startTurn("test-turn", generation(), 30101));
  fresh();
  c = command("expired-turn", 30101); c.actionId = "nod";
  assert(!apply(c, ack, 30101) && ack.status == AckStatus::Expired && !active());

  // Deadlines remain correct across the uint32 millisecond wrap.
  const uint32_t wrap = UINT32_MAX - 50;
  fresh(wrap);
  c = command("wrap", wrap); c.actionId = "busy"; c.durationMs = 100;
  assert(apply(c, ack, wrap));
  update(60); assert(lastState == 35 && active());
  // A terminal deadline of exactly zero is valid, not a disabled timer.
  fresh(UINT32_MAX - 1799);
  assert(setPhase(Phase::Done, nullptr, UINT32_MAX - 1799));
  update(0); assert(!active());
  const unsigned beforeIdleStop = releases;
  cancel(1); assert(releases == beforeIdleStop + 1 && stopped);

  // Real Planner proves gestures remain layered on a tracked face gaze.
  planner = motion::Planner();
  planner.setLimits(motion::limitsFor(3));
  planner.setAmp(1.f);
  planner.setFaceLook(true, 12.f, -5.f);
  for (int i = 0; i < 100; ++i) planner.update(.02f);
  const unsigned beforeFaceListening = actions;
  fresh();
  for (int i = 0; i < 30; ++i) planner.update(.02f);
  assert(actions == beforeFaceListening && lastState == 35 && !lastSound);
  assert(std::fabs(planner.pan() - 12.f) < .1f);
  assert(std::fabs(planner.tilt() + 5.f) < .1f);
  // Suppression applies to automatic phase gestures, not an explicit action.
  c = command("face-listen"); c.actionId = "listen";
  c.intensity = .55f; c.durationMs = 600;
  assert(apply(c, ack, 100));
  assert(actions == beforeFaceListening + 1 && lastAction == motion::A_LISTEN);
  for (int i = 0; i < 25; ++i) planner.update(.02f);
  assert(planner.pan() > 13.f && planner.tilt() < -6.f);
  assert(std::fabs(planner.lookPan() - 12.f) < .1f);
  update(701);
  for (int i = 0; i < 30; ++i) planner.update(.02f);
  assert(actions == beforeFaceListening + 1 && lastState == 35);
  assert(std::fabs(planner.pan() - 12.f) < .1f);
  assert(std::fabs(planner.tilt() + 5.f) < .1f);
  fresh();
  c = command("face-nod"); c.actionId = "nod"; c.durationMs = 100;
  assert(apply(c, ack, 100));
  for (int i = 0; i < 10; ++i) planner.update(.02f);
  assert(std::fabs(planner.lookPan() - 12.f) < .1f);
  cancel(200);
  for (int i = 0; i < 50; ++i) planner.update(.02f);
  assert(std::fabs(planner.pan() - 12.f) < .1f);
  puts("conversation: phase-independent moods/actions, quiet Listening, face gaze, 32 states, 41 actions, hard expiry/new-turn/cancel passed");
}
