#pragma once
// Transport-independent conversation arbitration. Call only on the main loop.
// All timestamps use the device's uint32_t monotonic millisecond clock.
#include <stddef.h>
#include <stdint.h>

namespace conversation {

constexpr size_t kIdMax = 64;
constexpr size_t kStatusMax = 192;
constexpr uint32_t kMaxDurationMs = 30000;
constexpr uint32_t kTurnLeaseMs = 30000;

enum class Phase : uint8_t {
  Idle, Listening, Recognizing, Thinking, Working, Speaking,
  Done, Error, Rejected, Stopped
};
enum class CommandKind : uint8_t { Behavior, Phase, Stop };
enum class ActionTiming : uint8_t { Now, SpeechStart };
enum class SoundTiming : uint8_t { AfterSpeech, WhenQuiet };
enum class AckStatus : uint8_t {
  Accepted, Duplicate, Invalid, Stale, Expired, Busy, NoTurn
};

struct Command {
  const char* commandId = nullptr;       // Required, 1..64 bytes, opaque.
  const char* turnId = nullptr;          // Must match startTurn().
  uint32_t generation = 0;              // Monotonically increasing per boot.
  uint32_t expiresAtMs = 0;             // Required future device-clock deadline.
  CommandKind kind = CommandKind::Behavior;
  const char* emotionId = nullptr;       // Exact two-digit semantic ID, not index.
  const char* actionId = nullptr;        // Exact action whitelist name.
  float intensity = .7f;                // Head action scale, finite range 0..1.
  uint32_t durationMs = 2500;           // Hard hold limit 1..30000; never auto-extended.
  Phase phase = Phase::Thinking;
  const char* text = nullptr;            // Status only; never interpreted as code.
  bool sound = false;                   // Short SFX; state 39 is always silent.
  uint8_t soundClip = 0;                 // 0 none; exact compiled clip catalog.
  float soundGain = .3f;                // Finite 0..0.6; never a URL/file/tone.
  ActionTiming actionTiming = ActionTiming::Now;
  SoundTiming soundTiming = SoundTiming::AfterSpeech;
};

struct SoundCue {
  uint8_t clip = 0;
  float gain = .3f;
  uint32_t token = 0, generation = 0, expiresAtMs = 0;
  SoundTiming timing = SoundTiming::AfterSpeech;
  bool local = false;                   // Internal touch cue; never an external command field.
};
struct CueSummary {
  bool action_pending = false, sound_pending = false, sound_playing = false;
  uint8_t sound_clip = 0;
  ActionTiming action_timing = ActionTiming::Now;
  SoundTiming sound_timing = SoundTiming::AfterSpeech;
  const char* sound_state = "idle";
  bool local = false, local_feedback = false;
};

struct Ack {
  AckStatus status = AckStatus::Invalid;
  char commandId[kIdMax + 1] = {};
  uint32_t generation = 0;
  const char* reason = "invalid";        // Stable static string, no ownership.
};

// Hooks run synchronously on the main loop. acquire() rejects boot/maintenance.
// release(true) must cancel scripts/audio, request visual state 41, and prevent
// an automatic show restart; release(false) restores visual state 02.
struct Hooks {
  bool (*acquire)();
  void (*release)(bool stopped);
  void (*setState)(uint8_t semanticId, bool sound);
  void (*playAction)(uint8_t action, float intensity);
  void (*releaseAction)();
  void (*stopAudio)();
  void (*cancelCue)() = nullptr;  // Optional dedicated cue barrier, not ambient enable.
  bool (*acquireAudio)() = nullptr;  // Read-only readiness check; never changes presentation.
  Hooks(bool (*a)() = nullptr, void (*r)(bool) = nullptr,
        void (*s)(uint8_t, bool) = nullptr, void (*p)(uint8_t, float) = nullptr,
        void (*releaseAct)() = nullptr, void (*stopSfx)() = nullptr)
      : acquire(a), release(r), setState(s), playAction(p),
        releaseAction(releaseAct), stopAudio(stopSfx) {}
};

void begin(const Hooks& hooks, uint32_t now);
// Internal voice upload/resume generations may preserve a valid visual mood.
// Its original deadline remains unchanged; actions/history never cross turns.
// Explicit new conversations use the default false and clear the previous mood.
bool startTurn(const char* turnId, uint32_t generation, uint32_t now,
               bool preserveEmotion = false, bool preservePresentation = false);
// preservePresentation is only for a new idle audio-only turn. It requires
// acquireAudio, leaves the visual owner running, and reports visibleEmotionId
// as -1 until an explicit visual command successfully acquires normal ownership.
// Local trusted audio/network events. Speaking must correspond to actual playback.
// Phase is independent of leased emotions/actions. Heartbeats never renew them.
// Audio capture/ASR may be noise, so Recognizing does not clear a visual lease.
// Explicit startTurn(..., false), cancellation, replacement and expiry clear it.
bool setPhase(Phase phase, const char* text, uint32_t now);
// Trusted player state, independent of a presentation phase that may outlast a
// TTS segment. A true signal releases a speech-start gesture once; false never
// marks whole-turn speech completion or starts the after-speech cue window.
void setPlaybackActive(bool active, uint32_t now);
bool apply(const Command& command, Ack& ack, uint32_t now);
void update(uint32_t now);
void cancel(uint32_t now, const char* text = nullptr);
// Trusted actual whole-turn playback completion, never a model phase string.
void speechEnded(uint32_t now);
// Safety windows are supplied by the main loop after inspecting actual audio.
bool takeSoundCue(SoundCue& cue, uint32_t now, bool afterSpeechSafe, bool quietSafe);
void soundCueFinished(uint32_t token, uint32_t now, bool completed);
CueSummary expressionCues();
// Lower-priority main-loop touch feedback. The app must additionally exclude
// recording/diagnostics. These calls never renew remote leases/history or move
// the head, and a remote command or a phase change always takes precedence.
bool localFeedbackAvailable(uint32_t now);
bool tryLocalFeedback(uint8_t semanticId, uint32_t durationMs, uint32_t now);
bool localFeedbackActive(uint32_t now);
void clearLocalFeedback(uint32_t now);
// One bounded local slot, also usable while no conversation owns the visuals.
// The deadline is absolute (1..3000 ms remaining), never refreshed by retry.
// No turn/interrupt/generation is created, and remote cueUsed is unaffected.
bool tryQueueLocalCue(uint8_t clip, float gain, uint32_t expiresAtMs, uint32_t now);
void cancelLocalCue(uint32_t now);
bool active();
Phase phase();
// Presentation targets, not proof of physical display/motion completion.
// -1 before the first request; otherwise semantic state 0..41 (not array index).
int visibleEmotionId();
// motion::Act requested by this scheduler; 0 means no conversation gesture.
// An audio-only turn has no head ownership and does not issue a release.
// A finite gesture may physically finish before its priority lease is released.
uint8_t actionId();
// Pure ownership query for an explicit cardinal-direction lease. Includes a
// speech-start direction waiting for playback, and never renews its deadline.
bool directionalActionHeld(uint32_t now);
const char* statusText();
const char* turnId();
uint32_t generation();
const char* ackName(AckStatus status);
const char* phaseName(Phase phase);

}  // namespace conversation
