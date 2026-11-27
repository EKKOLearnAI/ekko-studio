#include "touch_dispatch.h"
#include "conversation.h"
#include "sfx_bank.h"
#include "voice_audio.h"
#include <stdio.h>
#include <initializer_list>

namespace {
unsigned fxCount = 0, actionCount = 0, idleVisualCount = 0;
uint8_t display = 0;
touchdispatch::Hooks dispatchHooks;

void setup(bool active = true, uint32_t now = 100) {
  conversation::Hooks hooks{
    []() { return true; }, [](bool) {},
    [](uint8_t state, bool) { display = state; },
    [](uint8_t, float) { ++actionCount; }, []() {}, []() {}
  };
  hooks.acquireAudio = []() { return true; };
  conversation::begin(hooks, now);
  if (active) conversation::startTurn("touch-test", 7, now);
  else display = 2;
  fxCount = actionCount = idleVisualCount = 0;
  dispatchHooks.fx = [](touchinteraction::Visual) { ++fxCount; };
  dispatchHooks.localIdleVisual = [](uint8_t state, bool, uint32_t, uint32_t) {
    ++idleVisualCount; display = state; return true;
  };
}

touchdispatch::Context listeningContext() {
  touchdispatch::Context context;
  context.interaction.enabled = true;
  context.interaction.generation = 7;
  context.interaction.epoch = 3;
  context.normalListening = true;
  return context;
}

bool listeningContactShowsHappy() {
  setup();
  auto context = listeningContext();
  touchinteraction::Controller controller;
  controller.reset(100);
  touchdispatch::Dispatcher dispatcher(dispatchHooks, sfx::C_TOUCH_DIRTY_HANDS);
  controller.contact(touchinteraction::Source::Head, true, 100);
  const auto decision = controller.update(100, context.interaction);
  const auto result = dispatcher.dispatch(decision, context, 100);
  return result.route == touchdispatch::VisualRoute::Listening && display == 10 &&
         conversation::visibleEmotionId() == 10 && fxCount == 1 && actionCount == 0 && idleVisualCount == 0;
}

#define REQUIRE(condition) do { if (!(condition)) return false; } while (0)

touchinteraction::Decision holdBoundary(touchinteraction::Controller& controller,
                                        touchdispatch::Dispatcher& dispatcher,
                                        const touchdispatch::Context& context,
                                        touchinteraction::Source source, uint32_t start = 100) {
  controller.reset(start);
  controller.contact(source, true, start);
  dispatcher.dispatch(controller.update(start, context.interaction), context, start);
  return controller.update(start + 6000, context.interaction);
}

bool bothSourcesShowHappyAndNeverPostHeadMotion() {
  for (auto source : {touchinteraction::Source::Head, touchinteraction::Source::Screen}) {
    setup();
    auto context = listeningContext();
    touchinteraction::Controller controller;
    touchdispatch::Dispatcher dispatcher(dispatchHooks, sfx::C_TOUCH_DIRTY_HANDS);
    controller.reset(100); controller.contact(source, true, 100);
    const auto result = dispatcher.dispatch(controller.update(100, context.interaction), context, 100);
    REQUIRE(result.route == touchdispatch::VisualRoute::Listening && display == 10 && !result.phraseQueued);
    REQUIRE(actionCount == 0 && fxCount == 1 && idleVisualCount == 0);
    REQUIRE(conversation::generation() == 7 && conversation::phase() == conversation::Phase::Listening);
  }
  return true;
}

bool busyAndExplicitContextsOnlyUseFx() {
  for (unsigned block = 0; block < 3; ++block) {
    setup();
    auto context = listeningContext();
    context.interaction.recording = block == 0;
    context.interaction.speaking = block == 1;
    context.interaction.expressionOwned = block == 2;
    touchinteraction::Controller controller;
    touchdispatch::Dispatcher dispatcher(dispatchHooks, sfx::C_TOUCH_DIRTY_HANDS);
    const auto boundary = holdBoundary(controller, dispatcher, context, touchinteraction::Source::Screen);
    const auto result = dispatcher.dispatch(boundary, context, 6100);
    REQUIRE(result.route == touchdispatch::VisualRoute::FxOnly && !result.phraseQueued);
    REQUIRE(display == 35 && actionCount == 0 && idleVisualCount == 0 && fxCount == 2);
    REQUIRE(!conversation::expressionCues().sound_pending);
  }
  return true;
}

bool RealConversationOwnershipOverridesStaleCallerContext() {
  for (unsigned kind = 0; kind < 3; ++kind) {
    setup();
    if (kind < 2) {
      conversation::Command command;
      command.commandId = "remote"; command.turnId = conversation::turnId();
      command.generation = 7; command.expiresAtMs = 20100; command.durationMs = 15000;
      if (kind == 0) command.emotionId = "16";
      else command.actionId = "nod_slow";
      conversation::Ack ack; REQUIRE(conversation::apply(command, ack, 100));
    } else conversation::setPlaybackActive(true, 100);
    const unsigned oldActions = actionCount;
    const uint8_t oldDisplay = display;
    auto context = listeningContext(); // Caller fields deliberately lag actual ownership.
    touchinteraction::Controller controller;
    touchdispatch::Dispatcher dispatcher(dispatchHooks, sfx::C_TOUCH_DIRTY_HANDS);
    const auto boundary = holdBoundary(controller, dispatcher, context, touchinteraction::Source::Head);
    const auto result = dispatcher.dispatch(boundary, context, 6100);
    REQUIRE(result.route == touchdispatch::VisualRoute::FxOnly && !result.phraseQueued);
    REQUIRE(display == oldDisplay && actionCount == oldActions && idleVisualCount == 0);
  }
  return true;
}

bool quietBoundaryQueuesCompiledPhraseOnceWithoutRenewingDeadline() {
  setup(); auto context = listeningContext();
  touchinteraction::Controller controller;
  touchdispatch::Dispatcher dispatcher(dispatchHooks, sfx::C_TOUCH_DIRTY_HANDS);
  const auto boundary = holdBoundary(controller, dispatcher, context, touchinteraction::Source::Head);
  const auto first = dispatcher.dispatch(boundary, context, 6100);
  REQUIRE(first.route == touchdispatch::VisualRoute::Listening && display == 21 && first.phraseQueued);
  REQUIRE(first.phraseTicket == boundary.phraseTicket && actionCount == 0);
  const auto pending = controller.update(6500, context.interaction);
  REQUIRE(pending.visual == touchinteraction::Visual::None && pending.phraseTicket == boundary.phraseTicket);
  REQUIRE(!dispatcher.dispatch(pending, context, 6500).phraseQueued);
  voice_audio::detail::OutputLease output;
  REQUIRE(output.tryBeginCue(true, true));
  conversation::SoundCue cue;
  REQUIRE(conversation::takeSoundCue(cue, 6600, false, true));
  REQUIRE(cue.clip == sfx::C_TOUCH_DIRTY_HANDS && cue.local && cue.expiresAtMs == 9100);
  REQUIRE(!controller.claimPhrase(boundary.phraseTicket, 6600, context.interaction)); // Lease not yet represented to policy.
  context.interaction.audioReady = true;
  REQUIRE(controller.claimPhrase(boundary.phraseTicket, 6600, context.interaction));
  REQUIRE(!controller.claimPhrase(boundary.phraseTicket, 6600, context.interaction));
  conversation::soundCueFinished(cue.token, 7900, true); output.endCue();
  auto replay = pending; replay.phraseExpiresAt = 10500; // A replay cannot buy a fresh TTL.
  REQUIRE(!dispatcher.dispatch(replay, context, 8000).phraseQueued);
  REQUIRE(!conversation::expressionCues().sound_pending && conversation::generation() == 7);
  return true;
}

bool BusyOfferCanRetryOnlyWithinItsOriginalWindow() {
  setup(); auto context = listeningContext(); context.interaction.recording = true;
  touchinteraction::Controller controller;
  touchdispatch::Dispatcher dispatcher(dispatchHooks, sfx::C_TOUCH_DIRTY_HANDS);
  const auto boundary = holdBoundary(controller, dispatcher, context, touchinteraction::Source::Head);
  REQUIRE(!dispatcher.dispatch(boundary, context, 6100).phraseQueued);
  context.interaction.recording = false;
  const auto pending = controller.update(6500, context.interaction);
  REQUIRE(dispatcher.dispatch(pending, context, 6500).phraseQueued);
  conversation::SoundCue cue;
  REQUIRE(conversation::takeSoundCue(cue, 6501, false, true) && cue.expiresAtMs == 9100);
  conversation::soundCueFinished(cue.token, 8000, true);
  const auto expired = controller.update(9100, context.interaction);
  REQUIRE(!expired.phraseTicket && !dispatcher.dispatch(expired, context, 9100).phraseQueued);
  return true;
}

bool GenerationAndEpochChangeCancelOnlyLocalAudio() {
  for (unsigned key = 0; key < 2; ++key) {
    setup(); auto context = listeningContext();
    touchinteraction::Controller controller;
    touchdispatch::Dispatcher dispatcher(dispatchHooks, sfx::C_TOUCH_DIRTY_HANDS);
    const auto boundary = holdBoundary(controller, dispatcher, context, touchinteraction::Source::Screen);
    REQUIRE(dispatcher.dispatch(boundary, context, 6100).phraseQueued);
    const uint8_t oldDisplay = display;
    if (key == 0) ++context.interaction.generation;
    else ++context.interaction.epoch;
    const auto result = dispatcher.dispatch(boundary, context, 6200);
    REQUIRE(!result.phraseQueued && !conversation::expressionCues().sound_pending);
    REQUIRE(display == oldDisplay && actionCount == 0 && conversation::generation() == 7);
  }
  return true;
}

bool OfflineContactAndPhraseDoNotCreateATurnOrMoveTheHead() {
  setup(false);
  auto context = listeningContext(); context.normalListening = false; context.idleVisualAllowed = true;
  context.interaction.generation = 31;
  const uint32_t generation = conversation::generation();
  touchinteraction::Controller controller;
  touchdispatch::Dispatcher dispatcher(dispatchHooks, sfx::C_TOUCH_DIRTY_HANDS);
  const auto boundary = holdBoundary(controller, dispatcher, context, touchinteraction::Source::Screen);
  REQUIRE(display == 10 && idleVisualCount == 1);
  const auto result = dispatcher.dispatch(boundary, context, 6100);
  REQUIRE(result.route == touchdispatch::VisualRoute::Idle && display == 21 && idleVisualCount == 2);
  REQUIRE(result.phraseQueued && !conversation::active() && conversation::generation() == generation);
  REQUIRE(actionCount == 0);
  conversation::SoundCue cue;
  REQUIRE(conversation::takeSoundCue(cue, 6200, false, true) && cue.local && cue.clip == sfx::C_TOUCH_DIRTY_HANDS);
  REQUIRE(!conversation::active() && conversation::generation() == generation);
  return true;
}

bool DisabledMaintenanceAndNonListeningCannotAcquireVisualsOrAudio() {
  for (unsigned mode = 0; mode < 3; ++mode) {
    setup(mode != 2);
    auto context = listeningContext();
    if (mode == 0) context.interaction.enabled = false;
    if (mode == 1) conversation::setPhase(conversation::Phase::Thinking, nullptr, 100);
    if (mode == 2) { context.normalListening = false; context.idleVisualAllowed = false; }
    const uint8_t oldDisplay = display;
    const unsigned oldActions = actionCount;
    touchinteraction::Controller controller;
    touchdispatch::Dispatcher dispatcher(dispatchHooks, sfx::C_TOUCH_DIRTY_HANDS);
    const auto boundary = holdBoundary(controller, dispatcher, context, touchinteraction::Source::Head);
    const auto result = dispatcher.dispatch(boundary, context, 6100);
    REQUIRE(!result.phraseQueued && display == oldDisplay && actionCount == oldActions && idleVisualCount == 0);
    REQUIRE(!conversation::expressionCues().sound_pending);
    if (mode == 0) REQUIRE(fxCount == 0 && result.route == touchdispatch::VisualRoute::None);
  }
  return true;
}

bool LocalExpiryAndResetDoNotCancelRemoteExplicitExpression() {
  setup(); auto context = listeningContext();
  touchinteraction::Controller controller;
  touchdispatch::Dispatcher dispatcher(dispatchHooks, sfx::C_TOUCH_DIRTY_HANDS);
  controller.reset(100); controller.contact(touchinteraction::Source::Head, true, 100);
  dispatcher.dispatch(controller.update(100, context.interaction), context, 100);
  REQUIRE(display == 10);
  conversation::update(1900); REQUIRE(display == 35 && actionCount == 0);
  conversation::Command command;
  command.commandId = "remote-after-touch"; command.turnId = conversation::turnId();
  command.generation = 7; command.emotionId = "16"; command.durationMs = 10000; command.expiresAtMs = 22000;
  conversation::Ack ack; REQUIRE(conversation::apply(command, ack, 2000));
  const unsigned oldActions = actionCount;
  dispatcher.reset(2100);
  REQUIRE(display == 16 && conversation::active() && actionCount == oldActions);
  return true;
}
}

int main() {
  struct Case { const char* name; bool (*run)(); };
  const Case cases[] = {
    {"normal_listening_contact_shows_happy", listeningContactShowsHappy},
    {"both_contact_sources_no_head_motion", bothSourcesShowHappyAndNeverPostHeadMotion},
    {"busy_or_explicit_context_fx_only", busyAndExplicitContextsOnlyUseFx},
    {"actual_owner_overrides_stale_context", RealConversationOwnershipOverridesStaleCallerContext},
    {"phrase_once_original_ttl_and_real_claim", quietBoundaryQueuesCompiledPhraseOnceWithoutRenewingDeadline},
    {"busy_retry_preserves_original_window", BusyOfferCanRetryOnlyWithinItsOriginalWindow},
    {"generation_and_epoch_cancel_local_only", GenerationAndEpochChangeCancelOnlyLocalAudio},
    {"offline_no_new_turn_or_motion", OfflineContactAndPhraseDoNotCreateATurnOrMoveTheHead},
    {"maintenance_phase_and_idle_guards", DisabledMaintenanceAndNonListeningCannotAcquireVisualsOrAudio},
    {"local_expiry_and_reset_preserve_remote", LocalExpiryAndResetDoNotCancelRemoteExplicitExpression},
  };
  unsigned failures = 0;
  printf("{\"scope\":\"production_adapter_with_real_controller_and_conversation\","
         "\"hardware_tested\":false,\"results\":{");
  for (unsigned i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
    const bool passed = cases[i].run(); if (!passed) ++failures;
    printf("%s\"%s\":%s", i ? "," : "", cases[i].name, passed ? "true" : "false");
  }
  printf("},\"cases\":%zu,\"failures\":%u}\n", sizeof(cases) / sizeof(cases[0]), failures);
  return failures ? 1 : 0;
}
