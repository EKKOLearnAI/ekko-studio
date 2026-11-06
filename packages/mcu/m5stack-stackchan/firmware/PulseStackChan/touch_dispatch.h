#pragma once

#include "touch_interaction.h"

// Main-loop-only routing of local touch decisions. This layer does not access
// a screen, servo, microphone or speaker, and it never creates a conversation.
namespace touchdispatch {

struct Context {
  touchinteraction::Context interaction;
  bool normalListening = false;
  bool idleVisualAllowed = false;
};

struct Hooks {
  void (*fx)(touchinteraction::Visual);
  bool (*localIdleVisual)(uint8_t semanticId, bool happyMotion,
                          uint32_t durationMs, uint32_t now);
  Hooks(void (*f)(touchinteraction::Visual) = nullptr,
        bool (*idle)(uint8_t, bool, uint32_t, uint32_t) = nullptr)
      : fx(f), localIdleVisual(idle) {}
};

enum class VisualRoute : uint8_t { None, FxOnly, Listening, Idle };
struct Result {
  VisualRoute route = VisualRoute::None;
  bool phraseQueued = false;
  uint32_t phraseTicket = 0;
};

class Dispatcher {
 public:
  // Pass the actual compiled touch clip ID (0 disables its audio offer).
  Dispatcher(const Hooks& hooks, uint8_t phraseClip, float phraseGain = .3f);
  Result dispatch(const touchinteraction::Decision& decision, const Context& context,
                  uint32_t now);
  // Reset together with the Controller on stop/maintenance. This only cancels
  // a pending/playing local cue; it never releases remote expression ownership.
  void reset(uint32_t now);
 private:
  Hooks hooks_;
  uint8_t phraseClip_;
  float phraseGain_;
  bool bound_ = false, haveQueued_ = false;
  uint32_t generation_ = 0, epoch_ = 0, lastQueuedTicket_ = 0;
};

}  // namespace touchdispatch
