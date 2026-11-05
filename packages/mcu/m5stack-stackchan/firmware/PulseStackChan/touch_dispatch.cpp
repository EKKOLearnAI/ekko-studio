#include "touch_dispatch.h"
#include "conversation.h"

namespace touchdispatch {
namespace {
constexpr uint32_t kVisualMs = 1800;
bool newer(uint32_t value, uint32_t previous) {
  const uint32_t difference = value - previous;
  return difference != 0 && difference < 0x80000000u;
}
}

Dispatcher::Dispatcher(const Hooks& hooks, uint8_t phraseClip, float phraseGain)
    : hooks_(hooks), phraseClip_(phraseClip), phraseGain_(phraseGain) {}

void Dispatcher::reset(uint32_t now) {
  conversation::cancelLocalCue(now);
  bound_ = haveQueued_ = false;
  generation_ = epoch_ = lastQueuedTicket_ = 0;
}

Result Dispatcher::dispatch(const touchinteraction::Decision& decision, const Context& context,
                            uint32_t now) {
  Result result;
  const auto& input = context.interaction;
  if (!input.enabled) { reset(now); return result; }
  if (!bound_ || generation_ != input.generation || epoch_ != input.epoch) {
    if (bound_) conversation::cancelLocalCue(now);
    generation_ = input.generation; epoch_ = input.epoch;
    bound_ = true; haveQueued_ = false; lastQueuedTicket_ = 0;
  }
  const bool blocked = input.recording || input.speaking || input.expressionOwned;
  const bool listening = context.normalListening && conversation::active() &&
                         conversation::localFeedbackAvailable(now);
  const bool idle = context.idleVisualAllowed && !conversation::active();
  if (decision.visual != touchinteraction::Visual::None) {
    if (hooks_.fx) hooks_.fx(decision.visual);
    result.route = VisualRoute::FxOnly;
    const uint8_t semantic = decision.visual == touchinteraction::Visual::Happy ? 10 : 21;
    if (!blocked && !decision.visualOnly) {
      if (listening && conversation::tryLocalFeedback(semantic, kVisualMs, now))
        result.route = VisualRoute::Listening;
      else if (idle && hooks_.localIdleVisual &&
               hooks_.localIdleVisual(semantic, decision.happyMotion, kVisualMs, now))
        result.route = VisualRoute::Idle;
    }
  }
  if (!blocked && (listening || idle) && phraseClip_ && decision.phraseTicket &&
      decision.generation == input.generation && decision.epoch == input.epoch &&
      (!haveQueued_ || newer(decision.phraseTicket, lastQueuedTicket_)) &&
      conversation::tryQueueLocalCue(phraseClip_, phraseGain_, decision.phraseExpiresAt, now)) {
    haveQueued_ = true; lastQueuedTicket_ = decision.phraseTicket;
    result.phraseQueued = true; result.phraseTicket = decision.phraseTicket;
  }
  return result;
}
}  // namespace touchdispatch
