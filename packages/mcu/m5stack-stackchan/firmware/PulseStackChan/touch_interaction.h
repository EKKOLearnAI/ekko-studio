#pragma once

#include <stdint.h>

// Main-loop-owned, allocation-free interaction policy. No Arduino, audio or
// presentation calls: the adapter decides how to render the returned feedback.
// now is monotonic uint32_t milliseconds (wrap supported); consecutive clock
// observations must be less than 2^31 ms apart. Older observations are ignored.
namespace touchinteraction {

enum class Source : uint8_t { Head, Screen };
enum class Gesture : uint8_t { Tap, Stroke, Hold };
enum class Visual : uint8_t { None, Happy, PlayfulBoundary };

struct Context {
  bool enabled = false;  // Disable for boot, settings, calibration and shows.
  bool recording = false, speaking = false;
  bool expressionOwned = false;  // Explicit remote expression/action/audio protection, not ordinary Listening.
  bool audioReady = false;  // True only after obtaining the real output lease.
  uint32_t generation = 0, epoch = 0;
};

struct Decision {
  Visual visual = Visual::None;
  bool visualOnly = true, happyMotion = false;
  // A pending ticket is an offer, not permission to play. First obtain the
  // output lease, then claimPhrase; a successfully claimed ticket never repeats.
  uint32_t phraseTicket = 0, phraseExpiresAt = 0;
  uint32_t generation = 0, epoch = 0;
};

class Controller {
 public:
  // Cancel contact/session/offers. Preserve this object's ticket serial and
  // cooldown so a UI/reset cannot replay a stale offer or bypass 30 seconds.
  void reset(uint32_t now = 0);
  // Feed real contact levels (repeated polling is harmless) and logical gesture
  // events, then immediately update with the context from the same iteration.
  // Hold/tap do not count as strokes. Never map a 40 ms sensor poll to Stroke.
  // One session spans both sources: 6000 ms contact or four strokes separated
  // by >=250 ms triggers one boundary. Both released for 1500 ms ends it.
  void contact(Source source, bool down, uint32_t now);
  void gesture(Source source, Gesture gesture, uint32_t now);
  Decision update(uint32_t now, const Context& context);
  // Offer TTL <=3000 ms, same generation/epoch, no recording/TTS/explicit
  // protection and actual audioReady required. Claim starts a fresh 30s cooldown.
  bool claimPhrase(uint32_t ticket, uint32_t now, const Context& context);

 private:
  bool down_[2] = {};
  bool clockStarted_ = false, active_ = false, quiet_ = false, inhibited_ = false;
  bool haveStroke_ = false, boundary_ = false, bound_ = false, voiceEligible_ = false;
  bool haveCooldown_ = false;
  uint8_t strokes_ = 0;
  uint32_t lastNow_ = 0, pettingMs_ = 0, quietSince_ = 0, lastStrokeAt_ = 0;
  uint32_t generation_ = 0, epoch_ = 0, serial_ = 0;
  uint32_t ticket_ = 0, expiresAt_ = 0, cooldownUntil_ = 0;
  Visual pendingVisual_ = Visual::None;

  bool advance(uint32_t now);
  bool anyDown() const;
  void beginSession(uint32_t now);
  void endSession();
  void observeContext(const Context& context);
};

}  // namespace touchinteraction
