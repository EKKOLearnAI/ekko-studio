#include "touch_interaction.h"

namespace touchinteraction {
namespace {
constexpr uint32_t kPetMs = 6000, kQuietMs = 1500, kVoiceTtlMs = 3000, kCooldownMs = 30000;
constexpr uint32_t kStrokeDebounceMs = 250;
constexpr uint8_t kBoundaryStrokes = 4;
bool due(uint32_t now, uint32_t deadline) { return static_cast<int32_t>(now - deadline) >= 0; }
}

void Controller::reset(uint32_t now) {
  const uint32_t serial = serial_, cooldown = cooldownUntil_;
  const bool haveCooldown = haveCooldown_;
  *this = Controller();
  serial_ = serial; cooldownUntil_ = cooldown; haveCooldown_ = haveCooldown;
  clockStarted_ = true; lastNow_ = now;
}
bool Controller::anyDown() const { return down_[0] || down_[1]; }

void Controller::endSession() {
  active_ = quiet_ = haveStroke_ = boundary_ = bound_ = voiceEligible_ = false;
  strokes_ = 0; pettingMs_ = 0;
  ticket_ = expiresAt_ = generation_ = epoch_ = 0;
  pendingVisual_ = Visual::None;
}

void Controller::beginSession(uint32_t now) {
  endSession();
  active_ = true;
  quiet_ = !anyDown(); quietSince_ = now;
  pendingVisual_ = Visual::Happy;
}

bool Controller::advance(uint32_t now) {
  if (!clockStarted_) { clockStarted_ = true; lastNow_ = now; return true; }
  const uint32_t elapsed = now - lastNow_;
  if (static_cast<int32_t>(elapsed) < 0) return false;
  lastNow_ = now;
  // Retire passed deadlines while observing the clock; leaving an old signed
  // deadline alive could make its cooldown appear active again weeks later.
  if (haveCooldown_ && due(now, cooldownUntil_)) haveCooldown_ = false;
  if (active_ && anyDown()) {
    const uint32_t remaining = kPetMs - pettingMs_;
    pettingMs_ += elapsed < remaining ? elapsed : remaining;
  } else if (active_ && quiet_ && now - quietSince_ >= kQuietMs) endSession();
  return true;
}

void Controller::contact(Source source, bool down, uint32_t now) {
  const uint8_t index = static_cast<uint8_t>(source);
  if (index > 1 || !advance(now)) return;
  const bool wasAny = anyDown(), wasDown = down_[index];
  down_[index] = down;
  if (down && !wasDown && !active_ && !inhibited_) beginSession(now);
  if (active_ && anyDown()) quiet_ = false;
  else if (active_ && wasAny) { quiet_ = true; quietSince_ = now; }
}
void Controller::gesture(Source source, Gesture gesture, uint32_t now) {
  if (static_cast<uint8_t>(source) > 1 || static_cast<uint8_t>(gesture) > 2 ||
      !advance(now) || inhibited_) return;
  if (!active_) beginSession(now);
  if (!anyDown()) { quiet_ = true; quietSince_ = now; }
  if (gesture != Gesture::Stroke) return;
  if (!haveStroke_ || now - lastStrokeAt_ >= kStrokeDebounceMs) {
    haveStroke_ = true; lastStrokeAt_ = now;
    if (strokes_ < kBoundaryStrokes) ++strokes_;
  }
}

void Controller::observeContext(const Context& context) {
  if (!context.enabled) {
    endSession(); inhibited_ = anyDown();
    return;
  }
  if (inhibited_ && !anyDown()) inhibited_ = false;
  if (!active_ || inhibited_) return;
  if (!bound_) {
    bound_ = voiceEligible_ = true;
    generation_ = context.generation; epoch_ = context.epoch;
  } else if (generation_ != context.generation || epoch_ != context.epoch) {
    // An old held touch must not insert a phrase into a new conversation.
    voiceEligible_ = false; ticket_ = expiresAt_ = 0;
  }
}

Decision Controller::update(uint32_t now, const Context& context) {
  Decision decision;
  if (!advance(now)) return decision;
  observeContext(context);
  if (!context.enabled || inhibited_) return decision;
  if (ticket_ && due(now, expiresAt_)) ticket_ = expiresAt_ = 0;
  if (active_ && !boundary_ && (pettingMs_ >= kPetMs || strokes_ >= kBoundaryStrokes)) {
    boundary_ = true;
    pendingVisual_ = Visual::PlayfulBoundary;
    if (voiceEligible_ && (!haveCooldown_ || due(now, cooldownUntil_))) {
      if (++serial_ == 0) ++serial_;
      ticket_ = serial_; expiresAt_ = now + kVoiceTtlMs;
      haveCooldown_ = true; cooldownUntil_ = now + kCooldownMs;
    }
  }
  decision.visual = pendingVisual_; pendingVisual_ = Visual::None;
  if (decision.visual != Visual::None)
    decision.visualOnly = context.recording || context.speaking || context.expressionOwned;
  decision.happyMotion = decision.visual == Visual::Happy && !decision.visualOnly;
  if (ticket_) {
    decision.phraseTicket = ticket_; decision.phraseExpiresAt = expiresAt_;
    decision.generation = generation_; decision.epoch = epoch_;
  }
  return decision;
}
bool Controller::claimPhrase(uint32_t ticket, uint32_t now, const Context& context) {
  if (!advance(now)) return false;
  observeContext(context);
  if (ticket_ && due(now, expiresAt_)) ticket_ = expiresAt_ = 0;
  if (!ticket || ticket != ticket_ || !context.enabled || !voiceEligible_ ||
      context.recording || context.speaking || context.expressionOwned || !context.audioReady) return false;
  ticket_ = expiresAt_ = 0;
  haveCooldown_ = true; cooldownUntil_ = now + kCooldownMs;
  return true;
}
}  // namespace touchinteraction
