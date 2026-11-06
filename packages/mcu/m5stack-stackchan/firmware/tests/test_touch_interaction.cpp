#include "touch_interaction.h"
#include <assert.h>
#include <stdio.h>

using namespace touchinteraction;

static Decision fourStrokes(Controller& touch, uint32_t start, const Context& context) {
  touch.contact(Source::Head, true, start);
  touch.update(start, context);
  Decision last;
  for (unsigned i = 0; i < 4; ++i) {
    const uint32_t at = start + i * 250;
    touch.gesture(Source::Head, Gesture::Stroke, at);
    last = touch.update(at, context);
  }
  return last;
}

static void resetCannotBypassCooldown() {
  Context idle; idle.enabled = idle.audioReady = true;
  Controller touch;
  const Decision old = fourStrokes(touch, 0, idle);
  assert(old.phraseTicket && touch.claimPhrase(old.phraseTicket, 750, idle));
  touch.reset(10000);
  assert(!fourStrokes(touch, 10000, idle).phraseTicket);
  touch.reset(40000);
  const Decision next = fourStrokes(touch, 40000, idle);
  assert(next.phraseTicket && next.phraseTicket != old.phraseTicket);
  assert(!touch.claimPhrase(old.phraseTicket, 40750, idle));
  assert(touch.claimPhrase(next.phraseTicket, 40750, idle));
}

static void busyFeedbackCannotTakeAudioOrMotion() {
  Context busy; busy.enabled = busy.recording = true;
  busy.generation = 12; busy.epoch = 3;
  Controller touch;
  touch.contact(Source::Screen, true, 0);
  const Decision first = touch.update(0, busy);
  assert(first.visual == Visual::Happy && first.visualOnly && !first.happyMotion);
  for (uint32_t now = 40; now <= 800; now += 40) {
    touch.gesture(Source::Screen, Gesture::Hold, now);
    assert(!touch.update(now, busy).phraseTicket);  // Poll/hold is not a stroke.
  }
  const Decision boundary = touch.update(6000, busy);
  assert(boundary.visual == Visual::PlayfulBoundary && boundary.visualOnly && !boundary.happyMotion);
  assert(boundary.phraseTicket && boundary.generation == 12 && boundary.epoch == 3);
  busy.audioReady = true;
  assert(!touch.claimPhrase(boundary.phraseTicket, 6000, busy));
  busy.recording = false; busy.speaking = true;
  assert(!touch.claimPhrase(boundary.phraseTicket, 6001, busy));
  busy.speaking = false; busy.expressionOwned = true;
  assert(!touch.claimPhrase(boundary.phraseTicket, 6002, busy));
  busy.expressionOwned = false; busy.audioReady = false;
  assert(!touch.claimPhrase(boundary.phraseTicket, 6003, busy));
  busy.audioReady = true;
  assert(touch.claimPhrase(boundary.phraseTicket, 7000, busy));
}

static void pendingHasHardTtlAndCannotEnterNewTurn() {
  Context context; context.enabled = context.audioReady = true;
  context.generation = 7; context.epoch = 9;
  Controller expired;
  const Decision offer = fourStrokes(expired, 0, context);
  assert(offer.phraseExpiresAt == 3750);
  assert(!expired.claimPhrase(offer.phraseTicket, 3750, context));
  assert(!expired.update(3750, context).phraseTicket);
  assert(!expired.update(60000, context).phraseTicket);  // Holding past cooldown never replays.

  Controller lastMoment;
  const Decision timely = fourStrokes(lastMoment, 0, context);
  assert(lastMoment.claimPhrase(timely.phraseTicket, 3749, context));

  Controller generation;
  const Decision old = fourStrokes(generation, 0, context);
  ++context.generation;
  assert(!generation.update(751, context).phraseTicket);
  assert(!generation.claimPhrase(old.phraseTicket, 752, context));
  --context.generation;
  assert(!generation.claimPhrase(old.phraseTicket, 753, context));

  Controller epoch;
  const Decision cancelled = fourStrokes(epoch, 0, context);
  ++context.epoch;
  assert(!epoch.claimPhrase(cancelled.phraseTicket, 751, context));

  // Changing turn before the threshold also makes this held touch ineligible.
  Controller preThreshold;
  preThreshold.contact(Source::Head, true, 0);
  preThreshold.update(0, context);
  ++context.generation;
  preThreshold.update(5000, context);
  const Decision changed = preThreshold.update(6000, context);
  assert(changed.visual == Visual::PlayfulBoundary && !changed.phraseTicket);
}

static void unionContactTimeAndQuietReset() {
  Context idle; idle.enabled = true;
  Controller touch;
  touch.contact(Source::Head, true, 0);
  assert(touch.update(0, idle).visual == Visual::Happy);
  touch.contact(Source::Screen, true, 1000);
  assert(touch.update(1000, idle).visual == Visual::None);
  touch.contact(Source::Head, false, 2000);
  touch.contact(Source::Screen, false, 3000);
  assert(touch.update(3000, idle).visual == Visual::None);  // Overlap is not double time.
  touch.contact(Source::Head, true, 4499);  // Only 1499 ms quiet: same session.
  assert(touch.update(4499, idle).visual == Visual::None);
  assert(touch.update(7498, idle).visual == Visual::None);  // 5999 ms actual contact total.
  assert(touch.update(7499, idle).visual == Visual::PlayfulBoundary);
  touch.contact(Source::Head, false, 7500);
  touch.update(9000, idle);  // 1500 ms fully released: new session is possible.
  touch.contact(Source::Screen, true, 9000);
  assert(touch.update(9000, idle).visual == Visual::Happy);
}

static void cooldownNeedsReleaseAndThirtySeconds() {
  Context idle; idle.enabled = idle.audioReady = true;
  Controller touch;
  const Decision first = fourStrokes(touch, 0, idle);
  assert(touch.claimPhrase(first.phraseTicket, 750, idle));
  touch.contact(Source::Head, false, 751);
  touch.update(2251, idle);
  const Decision cooling = fourStrokes(touch, 2251, idle);
  assert(cooling.visual == Visual::PlayfulBoundary && !cooling.phraseTicket);
  assert(!touch.update(50000, idle).phraseTicket);  // No release, no 30-second replay.
  touch.contact(Source::Head, false, 50001);
  touch.update(51501, idle);
  const Decision again = fourStrokes(touch, 51501, idle);
  assert(again.phraseTicket && again.phraseTicket != first.phraseTicket);

  // Delayed admission still gets at least thirty seconds after that admission.
  Controller delayed;
  const Decision pending = fourStrokes(delayed, 0, idle);
  assert(delayed.claimPhrase(pending.phraseTicket, 3749, idle));
  delayed.contact(Source::Head, false, 3750);
  delayed.update(5250, idle);
  assert(!fourStrokes(delayed, 32000, idle).phraseTicket); // 29001 ms since claim.
}

static void disableRearmClockWrapAndInvalidInput() {
  Context idle; idle.enabled = idle.audioReady = true;
  Controller touch;
  const Decision before = fourStrokes(touch, 0, idle);
  idle.enabled = false;
  assert(!touch.update(751, idle).phraseTicket);
  assert(!touch.claimPhrase(before.phraseTicket, 752, idle));
  idle.enabled = true;
  touch.contact(Source::Head, true, 753);
  assert(touch.update(753, idle).visual == Visual::None); // Still physically held.
  assert(!touch.update(40000, idle).phraseTicket);
  touch.contact(Source::Head, false, 40001);
  touch.update(40001, idle);
  touch.contact(Source::Head, true, 40002);
  assert(touch.update(40002, idle).visual == Visual::Happy);

  Controller wrap;
  const uint32_t start = UINT32_MAX - 8999;
  wrap.contact(Source::Screen, true, start);
  assert(wrap.update(start, idle).visual == Visual::Happy);
  assert(!wrap.update(start + 5999, idle).phraseTicket);
  const Decision wrapped = wrap.update(start + 6000, idle);
  assert(wrapped.phraseTicket && wrapped.phraseExpiresAt == 0); // Zero is a valid wrapping deadline.
  assert(wrap.claimPhrase(wrapped.phraseTicket, UINT32_MAX, idle));

  Controller invalid;
  invalid.contact(static_cast<Source>(99), true, 1000);
  invalid.gesture(Source::Head, static_cast<Gesture>(99), 1000);
  assert(invalid.update(1000, idle).visual == Visual::None);
  invalid.contact(Source::Head, true, 1000);
  assert(invalid.update(1000, idle).visual == Visual::Happy);
  invalid.gesture(Source::Head, Gesture::Stroke, 999); // Out-of-order timestamps are ignored.
  assert(invalid.update(999, idle).visual == Visual::None);
  assert(!invalid.update(6999, idle).phraseTicket);
}

static void expiredCooldownDoesNotReturnAfterWeeks() {
  Context idle; idle.enabled = idle.audioReady = true;
  Controller touch;
  const Decision first = fourStrokes(touch, 0, idle);
  assert(touch.claimPhrase(first.phraseTicket, 750, idle));
  touch.contact(Source::Head, false, 751);
  touch.update(2251, idle);
  touch.update(30750, idle); // Cooldown has definitely ended.
  // Forward clock observations stay within the signed half-range contract.
  touch.update(1000000000u, idle);
  touch.update(2000000000u, idle);
  touch.update(3000000000u, idle);
  assert(fourStrokes(touch, 3000000000u, idle).phraseTicket);
}

int main() {
  Context idle; idle.enabled = true;
  Controller touch;
  touch.reset(100);
  touch.contact(Source::Head, true, 100);
  const Decision first = touch.update(100, idle);
  assert(first.visual == Visual::Happy);
  assert(!first.visualOnly && first.happyMotion && !first.phraseTicket);
  for (uint32_t now = 140; now < 6100; now += 40) {
    touch.contact(Source::Head, true, now);
    const Decision poll = touch.update(now, idle);
    assert(poll.visual == Visual::None && !poll.phraseTicket);
  }
  const Decision boundary = touch.update(6100, idle);
  assert(boundary.visual == Visual::PlayfulBoundary && !boundary.happyMotion);
  assert(boundary.phraseTicket && boundary.phraseExpiresAt == 9100);
  idle.audioReady = true;
  assert(touch.claimPhrase(boundary.phraseTicket, 6100, idle));
  assert(!touch.claimPhrase(boundary.phraseTicket, 6100, idle));
  Controller mixed;
  mixed.contact(Source::Head, true, 0);
  assert(mixed.update(0, idle).visual == Visual::Happy);
  mixed.gesture(Source::Head, Gesture::Stroke, 0);
  assert(mixed.update(0, idle).visual == Visual::None);
  mixed.contact(Source::Screen, true, 40);
  mixed.gesture(Source::Screen, Gesture::Stroke, 40);  // Same movement window.
  assert(mixed.update(40, idle).visual == Visual::None);
  const uint32_t nextStrokes[] = {250u, 500u};
  for (uint32_t now : nextStrokes) {
    mixed.gesture(Source::Head, Gesture::Stroke, now);
    assert(mixed.update(now, idle).visual == Visual::None);
  }
  mixed.gesture(Source::Screen, Gesture::Stroke, 750);
  const Decision strokes = mixed.update(750, idle);
  assert(strokes.visual == Visual::PlayfulBoundary && strokes.phraseTicket);
  resetCannotBypassCooldown();
  busyFeedbackCannotTakeAudioOrMotion();
  pendingHasHardTtlAndCannotEnterNewTurn();
  unionContactTimeAndQuietReset();
  cooldownNeedsReleaseAndThirtySeconds();
  disableRearmClockWrapAndInvalidInput();
  expiredCooldownDoesNotReturnAfterWeeks();
  puts("touch_interaction: public happy/boundary, unified hold/strokes, quiet reset/cooldown, busy FX-only, lease/TTL/turn/epoch/one-use, disable/reset/wrap passed");
}
