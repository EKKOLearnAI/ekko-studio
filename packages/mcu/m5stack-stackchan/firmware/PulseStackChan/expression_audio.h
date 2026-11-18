#pragma once
#include "conversation.h"

// Main-loop admission only. ListeningGap still requires the capture worker's
// cooperative quiet/drain handshake before any microphone or TX change.
namespace expression_audio {
enum class QuietMode : uint8_t { Unavailable, Unarmed, ListeningGap };
struct QuietContext {
  bool armed = false, turn_pending = false, listening = false, recording = false;
  bool tts_busy = false, speaker_busy = false, diagnostic = false, maintenance = false;
  conversation::Phase phase = conversation::Phase::Idle;
  uint32_t generation = 0;
};
inline QuietMode quietMode(const QuietContext& c) {
  if (c.recording || c.tts_busy || c.speaker_busy || c.diagnostic || c.maintenance)
    return QuietMode::Unavailable;
  if (c.armed)
    return !c.turn_pending && c.phase == conversation::Phase::Listening
        ? QuietMode::ListeningGap : QuietMode::Unavailable;
  return !c.listening ? QuietMode::Unarmed : QuietMode::Unavailable;
}
inline bool mayResumeListening(const QuietContext& c, uint32_t reserved_generation,
                               bool hardware_lease_released) {
  return hardware_lease_released && c.generation == reserved_generation &&
         quietMode(c) == QuietMode::ListeningGap;
}
}  // namespace expression_audio
