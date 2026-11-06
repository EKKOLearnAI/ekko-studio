#include "conversation.h"
#include "motion.h"
#include "sfx_bank.h"
#include <math.h>
#include <string.h>

namespace conversation {
namespace {
constexpr size_t kHistory = 64;
Hooks output;
bool owned = false, haveGeneration = false, emotionHeld = false, actionHeld = false;
bool audioOnlyOwnership = false;
uint32_t currentGeneration = 0, leaseUntil = 0, emotionUntil = 0, actionUntil = 0;
uint32_t terminalUntil = 0, talkAt = 0;
Phase currentPhase = Phase::Idle;
int visibleState = -1;
uint8_t emotionState = 2, requestedAction = motion::A_NONE;
float emotionIntensity = .7f;
float requestedIntensity = 0.f;
char currentTurn[kIdMax + 1] = {}, status[kStatusMax + 1] = {};
// Never evict within a turn: replaying an old command cannot execute it twice.
// The extra slot is reserved for cancellation even if normal history is full.
char history[kHistory + 1][kIdMax + 1] = {};
size_t historyCount = 0;
bool actionPending = false, soundPending = false, soundPlaying = false;
bool seenSpeech = false, speechEndedSeen = false, cueUsed = false, haveCueCooldown = false;
bool actualPlaybackActive = false;
bool localFeedbackHeld = false, haveLocalOffer = false;
uint8_t localFeedbackState = 10;
uint32_t localFeedbackUntil = 0, lastLocalOfferUntil = 0;
uint8_t deferredAction = 0;
float deferredIntensity = 0;
uint32_t deferredUntil = 0, speechEndedAt = 0, cueSerial = 0, cueCooldownUntil = 0;
SoundCue soundCue;
ActionTiming activeActionTiming = ActionTiming::Now;
const char* soundState = "idle";

void clearSoundCue(const char* reason) {
  if (soundPlaying && output.cancelCue) output.cancelCue();
  soundPending = soundPlaying = false;
  soundCue = SoundCue();
  soundState = reason;
}
void stopAmbientAudio() {
  // The dedicated cue owns its own lease and cancellation hook. A phase
  // change or unrelated visual expiry only discards legacy/ambient SFX.
  if (!soundPlaying && output.stopAudio) output.stopAudio();
}
void clearDeferredAction() {
  actionPending = false;
  deferredAction = 0;
  activeActionTiming = ActionTiming::Now;
}
bool clearLocalFeedbackState() {
  const bool wasHeld = localFeedbackHeld;
  localFeedbackHeld = false;
  return wasHeld;
}

bool due(uint32_t now, uint32_t deadline) {
  return static_cast<int32_t>(now - deadline) >= 0;
}
size_t boundedLength(const char* value, size_t limit) {
  if (!value) return 0;
  size_t n = 0;
  while (n <= limit && value[n]) ++n;
  return n;
}
bool validId(const char* value) {
  const size_t n = boundedLength(value, kIdMax);
  return n > 0 && n <= kIdMax;
}
void copyStatus(const char* value) {
  if (!value) return;
  size_t n = boundedLength(value, kStatusMax);
  if (n > kStatusMax) {
    n = kStatusMax;
    while (n && (static_cast<unsigned char>(value[n]) & 0xc0) == 0x80) --n;
  }
  memmove(status, value, n);
  status[n] = 0;
}
bool validPhase(Phase p) { return static_cast<uint8_t>(p) <= static_cast<uint8_t>(Phase::Stopped); }
int semanticState(const char* value) {
  if (!value || value[0] < '0' || value[0] > '9' || !value[1] ||
      value[1] < '0' || value[1] > '9' || value[2]) return -1;
  const int n = (value[0] - '0') * 10 + value[1] - '0';
  return (n <= 7 || (n >= 10 && n <= 21) || (n >= 30 && n <= 41)) ? n : -1;
}
uint8_t phaseState(Phase p) {
  switch (p) {
    case Phase::Listening: return 35;
    case Phase::Recognizing: return 31;
    case Phase::Thinking: return 30;
    case Phase::Working: return 32;
    case Phase::Speaking: return 39;
    case Phase::Done: return 33;
    case Phase::Error: return 34;
    case Phase::Rejected: return 38;
    case Phase::Stopped: return 41;
    default: return 2;
  }
}
void showVisual(uint8_t state, bool sound = false, bool force = false) {
  if (!force && visibleState == state) return;
  visibleState = state;
  if (output.setState) output.setState(state, sound && state != 39);
}
void requestAction(uint8_t action, float intensity, uint32_t now, bool force = false) {
  if (!force && requestedAction == action && (action == motion::A_NONE || requestedIntensity == intensity)) return;
  requestedAction = action;
  requestedIntensity = intensity;
  if (action && output.playAction) output.playAction(action, intensity);
  else if (output.releaseAction) output.releaseAction();
  talkAt = now + 800;
}
uint8_t expireOverrides(uint32_t now) {
  uint8_t expired = 0;
  if (emotionHeld && due(now, emotionUntil)) { emotionHeld = false; expired |= 1; }
  if (actionHeld && due(now, actionUntil)) { actionHeld = false; expired |= 2; }
  if (actionPending && due(now, deferredUntil)) clearDeferredAction();
  if (localFeedbackHeld && due(now, localFeedbackUntil)) { clearLocalFeedbackState(); expired |= 4; }
  if ((soundPending || soundPlaying) && due(now, soundCue.expiresAtMs)) clearSoundCue("expired");
  if (soundPending && soundCue.timing == SoundTiming::AfterSpeech && speechEndedSeen &&
      due(now, speechEndedAt + 1500)) clearSoundCue("speech_window_expired");
  return expired;
}
void showTargets(uint32_t now) {
  if (audioOnlyOwnership) return; // Living visuals/gaze remain with their existing owner.
  const uint8_t state = emotionHeld ? emotionState : localFeedbackHeld ? localFeedbackState : phaseState(currentPhase);
  showVisual(state);
  if (localFeedbackHeld) return; // Silent visual feedback never posts a default head action.
  if (actionHeld || actionPending) return;  // Explicit gesture owns its priority lease.
  // Starting a listening gesture beside the microphone can trigger the energy
  // gate with the robot's own servo noise. Keep the expression and face gaze;
  // an explicitly requested "listen" behavior still uses the normal action path.
  const uint8_t action = currentPhase == Phase::Listening
                         ? motion::A_NONE : motion::actForState(state);
  requestAction(action, emotionHeld ? emotionIntensity : .55f, now);
}
void finish(bool stopped, uint32_t now) {
  const bool preservePresentation = audioOnlyOwnership && !stopped;
  clearLocalFeedbackState();
  clearDeferredAction();
  if (!preservePresentation || soundPending || soundPlaying)
    clearSoundCue(stopped ? "cancelled" : "idle");
  stopAmbientAudio();
  if (!preservePresentation && output.releaseAction) output.releaseAction();
  if (!preservePresentation && (owned || stopped) && output.release) output.release(stopped);
  owned = emotionHeld = actionHeld = actualPlaybackActive = false;
  audioOnlyOwnership = false;
  requestedAction = motion::A_NONE;
  requestedIntensity = 0.f;
  visibleState = stopped ? 41 : preservePresentation ? -1 : 2;
  terminalUntil = 0;
  currentPhase = stopped ? Phase::Stopped : Phase::Idle;
  leaseUntil = now;
}
void expireTurn(uint32_t now) {
  if (audioOnlyOwnership) { clearSoundCue("expired"); finish(false, now); }
  else cancel(now, "对话超时");
}
bool reject(Ack& ack, AckStatus value, const char* reason) {
  ack.status = value;
  ack.reason = reason;
  return false;
}
}  // namespace

void begin(const Hooks& hooks, uint32_t now) {
  if (owned) finish(true, now);
  else if (soundPending || soundPlaying) clearSoundCue("cancelled");
  output = hooks;
  owned = haveGeneration = emotionHeld = actionHeld = audioOnlyOwnership = false;
  visibleState = -1;
  requestedAction = motion::A_NONE;
  requestedIntensity = 0.f;
  currentGeneration = 0;
  leaseUntil = now;
  terminalUntil = 0;
  currentPhase = Phase::Idle;
  currentTurn[0] = status[0] = 0;
  historyCount = 0;
  clearDeferredAction(); clearSoundCue("idle");
  clearLocalFeedbackState(); haveLocalOffer = false;
  seenSpeech = speechEndedSeen = cueUsed = haveCueCooldown = actualPlaybackActive = false;
  cueCooldownUntil = 0;
}

bool startTurn(const char* id, uint32_t nextGeneration, uint32_t now, bool preserveEmotion,
               bool preservePresentation) {
  if (!validId(id)) return false;
  if (owned && due(now, leaseUntil)) expireTurn(now);
  if (haveGeneration && nextGeneration <= currentGeneration)
    return owned && nextGeneration == currentGeneration && !strcmp(id, currentTurn);
  const bool keepEmotion = preserveEmotion && emotionHeld && !due(now, emotionUntil);
  if (preservePresentation) {
    if (owned || !output.acquireAudio || !output.acquireAudio()) return false;
  } else if (!output.acquire || !output.acquire()) return false;
  stopAmbientAudio();
  clearLocalFeedbackState();
  clearDeferredAction(); clearSoundCue("new_turn");
  seenSpeech = speechEndedSeen = cueUsed = actualPlaybackActive = false;
  if (!preservePresentation && output.releaseAction) output.releaseAction();
  memmove(currentTurn, id, strlen(id) + 1);
  currentGeneration = nextGeneration;
  haveGeneration = owned = true;
  audioOnlyOwnership = preservePresentation;
  emotionHeld = keepEmotion;
  actionHeld = false;
  requestedAction = motion::A_NONE;
  requestedIntensity = 0.f;
  historyCount = 0;
  terminalUntil = 0;
  leaseUntil = now + kTurnLeaseMs;
  currentPhase = Phase::Idle;
  if (preservePresentation) {
    visibleState = -1;
    copyStatus("音效已排队");
    return true;
  }
  return setPhase(Phase::Listening, nullptr, now);
}

bool setPhase(Phase next, const char* text, uint32_t now) {
  if (!owned || !validPhase(next)) return false;
  if (due(now, leaseUntil)) { expireTurn(now); return false; }
  uint8_t expired = expireOverrides(now);
  if (next != Phase::Listening) {
    if (clearLocalFeedbackState()) expired |= 4;
    if (soundCue.local && (soundPending || soundPlaying)) clearSoundCue("cancelled");
  }
  leaseUntil = now + kTurnLeaseMs;
  if (text) copyStatus(text);
  if (next == currentPhase && !expired) return true;
  const bool changed = next != currentPhase;
  currentPhase = next;
  if (!text) copyStatus(phaseName(next));
  if (next == Phase::Stopped) { cancel(now, text); return true; }
  if (next == Phase::Idle) { finish(false, now); return true; }
  if (changed || (expired & 1)) stopAmbientAudio();
  // Actual playback/work phases stay truthful, but their presentation is a
  // fallback beneath a still-valid emotion/gesture lease. No lease is renewed.
  showTargets(now);
  if (changed)
    terminalUntil = next == Phase::Done || next == Phase::Error || next == Phase::Rejected
                    ? now + 1800 : 0;
  return true;
}

void setPlaybackActive(bool active, uint32_t now) {
  if (!active) { actualPlaybackActive = false; return; }
  if (!owned) return;
  if (due(now, leaseUntil)) { expireTurn(now); return; }
  actualPlaybackActive = seenSpeech = true;
  clearLocalFeedback(now);
  if (soundCue.local && (soundPending || soundPlaying)) clearSoundCue("cancelled");
  if (actionPending && !due(now, deferredUntil)) {
    actionPending = false;
    requestAction(deferredAction, deferredIntensity, now, true);
  }
}

bool apply(const Command& command, Ack& ack, uint32_t now) {
  ack = Ack{};
  ack.generation = currentGeneration;
  if (!validId(command.commandId) || !validId(command.turnId))
    return reject(ack, AckStatus::Invalid, "invalid commandId/turnId");
  memcpy(ack.commandId, command.commandId, strlen(command.commandId) + 1);
  if (!haveGeneration || command.generation != currentGeneration || strcmp(command.turnId, currentTurn))
    return reject(ack, AckStatus::Stale, "turn/generation mismatch");
  for (size_t i = 0; i < historyCount; ++i) {
    if (!strcmp(history[i], command.commandId)) {
      ack.status = AckStatus::Duplicate;
      ack.reason = "already applied";
      return true;
    }
  }
  if (!owned) return reject(ack, AckStatus::NoTurn, "turn is closed");
  if (due(now, leaseUntil)) {
    expireTurn(now);
    return reject(ack, AckStatus::Expired, "turn lease expired");
  }
  const int32_t remaining = static_cast<int32_t>(command.expiresAtMs - now);
  if (remaining <= 0) return reject(ack, AckStatus::Expired, "command expired");
  if (remaining > static_cast<int32_t>(kMaxDurationMs))
    return reject(ack, AckStatus::Invalid, "expiry exceeds 30 seconds");
  if (static_cast<uint8_t>(command.kind) > static_cast<uint8_t>(CommandKind::Stop))
    return reject(ack, AckStatus::Invalid, "unknown command kind");
  const bool expression = command.emotionId != nullptr;
  const bool gesture = command.actionId != nullptr;
  const bool clip = command.soundClip != 0;
  int state = -1, action = -1;
  if (command.kind == CommandKind::Behavior) {
    if (!expression && !gesture && !clip) return reject(ack, AckStatus::Invalid, "empty behavior");
    if (expression && (state = semanticState(command.emotionId)) < 0)
      return reject(ack, AckStatus::Invalid, "unknown emotionId");
    if (gesture && (boundedLength(command.actionId, kIdMax) > kIdMax ||
                   (action = motion::findAct(command.actionId)) <= motion::A_NONE))
      return reject(ack, AckStatus::Invalid, "unknown actionId");
    if (!isfinite(command.intensity) || command.intensity < 0.f || command.intensity > 1.f ||
        !command.durationMs || command.durationMs > kMaxDurationMs)
      return reject(ack, AckStatus::Invalid, "intensity/duration outside bounds");
    if (command.soundClip >= sfx::C_COUNT || (clip && command.sound) ||
        !isfinite(command.soundGain) || command.soundGain < 0.f || command.soundGain > .6f ||
        static_cast<uint8_t>(command.actionTiming) > static_cast<uint8_t>(ActionTiming::SpeechStart) ||
        static_cast<uint8_t>(command.soundTiming) > static_cast<uint8_t>(SoundTiming::WhenQuiet) ||
        (clip && state == 39)) return reject(ack, AckStatus::Invalid, "invalid expression cue");
    if (clip && cueUsed && state != 41) return reject(ack, AckStatus::Busy, "one sound cue per turn");
  } else if (command.kind == CommandKind::Phase) {
    if (!validPhase(command.phase) || command.phase == Phase::Speaking)
      return reject(ack, AckStatus::Invalid, "speaking requires actual playback event");
  }
  if (boundedLength(command.text, kStatusMax) > kStatusMax)
    return reject(ack, AckStatus::Invalid, "status text too long");
  const bool stopping = command.kind == CommandKind::Stop || state == 41 ||
                        (command.kind == CommandKind::Phase && command.phase == Phase::Stopped);
  if (historyCount >= kHistory && !stopping)
    return reject(ack, AckStatus::Busy, "command history full; start a new turn");
  if (audioOnlyOwnership && !stopping &&
      (expression || gesture || command.kind == CommandKind::Phase)) {
    if (!output.acquire || !output.acquire())
      return reject(ack, AckStatus::Busy, "presentation owner unavailable");
    audioOnlyOwnership = false;
  }
  memcpy(history[historyCount++], command.commandId, strlen(command.commandId) + 1);
  leaseUntil = now + kTurnLeaseMs;
  const bool clearedLocal = clearLocalFeedbackState();
  if (soundCue.local && (soundPending || soundPlaying)) clearSoundCue("replaced");
  if (command.text) copyStatus(command.text);
  if (stopping) cancel(now, command.text);
  else if (command.kind == CommandKind::Phase) {
    setPhase(command.phase, command.text, now);
    if (clearedLocal && owned) showTargets(now);
  }
  else {
    const uint8_t expired = expireOverrides(now);
    if (expired & 1) stopAmbientAudio();
    // An expression update may change the face while an explicit direction
    // still owns the head. Preserve both running and speech-start-pending
    // directions, including their original absolute deadline.
    const bool preserveDirection = expression && !gesture && directionalActionHeld(now);
    const uint32_t duration = command.durationMs < static_cast<uint32_t>(remaining)
                              ? command.durationMs : static_cast<uint32_t>(remaining);
    if (expression || gesture) {
      if (!preserveDirection) clearDeferredAction();
      clearSoundCue("replaced");
    }
    else if (clip) clearSoundCue("replaced");
    if (expression) {
      emotionHeld = true;
      emotionState = static_cast<uint8_t>(state);
      emotionIntensity = command.intensity;
      emotionUntil = now + duration;
      // Reply audio belongs to the actual TTS player, never the canned SFX bank.
      showVisual(emotionState, command.sound, true);
      if (!gesture && !preserveDirection) action = motion::actForState(state);
    }
    if (gesture || (expression && !preserveDirection)) {
      actionHeld = gesture || command.actionTiming == ActionTiming::SpeechStart;
      if (actionHeld) actionUntil = now + duration;
      activeActionTiming = command.actionTiming;
      if (action > motion::A_NONE && command.actionTiming == ActionTiming::SpeechStart && !actualPlaybackActive) {
        actionPending = true; deferredAction = static_cast<uint8_t>(action);
        deferredIntensity = command.intensity; deferredUntil = now + duration;
        requestAction(motion::A_NONE, 0.f, now, true);
      } else requestAction(static_cast<uint8_t>(action), command.intensity, now, true);
      if (!expression) showTargets(now);
    }
    if (clip) {
      if (++cueSerial == 0) ++cueSerial;
      soundCue.clip = command.soundClip; soundCue.gain = command.soundGain;
      soundCue.token = cueSerial; soundCue.generation = currentGeneration;
      const uint32_t hold = command.soundTiming == SoundTiming::WhenQuiet && duration > 8000 ? 8000 : duration;
      soundCue.expiresAtMs = now + hold; soundCue.timing = command.soundTiming;
      soundCue.local = false;
      soundPending = true; soundState = "queued";
    }
    if (!expression && !gesture && (expired || clearedLocal)) showTargets(now);
  }
  ack.status = AckStatus::Accepted;
  ack.reason = stopping ? "cancelled" : "applied";
  return true;
}

void update(uint32_t now) {
  if (!owned) {
    if (soundCue.local && (soundPending || soundPlaying) && due(now, soundCue.expiresAtMs))
      clearSoundCue("expired");
    return;
  }
  if (due(now, leaseUntil)) { expireTurn(now); return; }
  const uint8_t expired = expireOverrides(now);
  if (audioOnlyOwnership && !soundPending && !soundPlaying) { finish(false, now); return; }
  const bool terminal = currentPhase == Phase::Done || currentPhase == Phase::Error ||
                        currentPhase == Phase::Rejected;
  if (terminal && due(now, terminalUntil) && !emotionHeld && !actionHeld && !soundPending && !soundPlaying) {
    finish(false, now); return;
  }
  if (expired) {
    if (expired & 1) stopAmbientAudio();
    showTargets(now);
  }
  if (!actionHeld && currentPhase == Phase::Speaking && requestedAction == motion::A_TALK && due(now, talkAt))
    requestAction(motion::A_TALK, .45f, now, true);
}

void cancel(uint32_t now, const char* text) {
  if (text) copyStatus(text);
  else copyStatus("已停止");
  finish(true, now);
}
void speechEnded(uint32_t now) {
  if (owned && seenSpeech && !actualPlaybackActive && !speechEndedSeen) { speechEndedSeen = true; speechEndedAt = now; }
}
bool takeSoundCue(SoundCue& cue, uint32_t now, bool afterSpeechSafe, bool quietSafe) {
  if (!owned && !(soundPending && soundCue.local)) return false;
  const uint8_t expired = expireOverrides(now);
  if (expired && owned) {
    if (expired & 1) stopAmbientAudio();
    showTargets(now);
  }
  if (!soundPending || (cueUsed && !soundCue.local) || actualPlaybackActive || soundCue.generation != currentGeneration ||
      (haveCueCooldown && !due(now, cueCooldownUntil))) return false;
  const bool safe = soundCue.timing == SoundTiming::AfterSpeech
                    ? seenSpeech && speechEndedSeen && afterSpeechSafe : quietSafe;
  if (!safe) return false;
  soundPending = false; soundPlaying = true; soundState = "playing";
  if (!soundCue.local) cueUsed = true;
  cueCooldownUntil = now + 4000; haveCueCooldown = true;
  cue = soundCue;
  return true;
}
void soundCueFinished(uint32_t token, uint32_t now, bool completed) {
  (void)now;
  if (!soundPlaying || token != soundCue.token) return;
  if (completed) soundPlaying = false;
  clearSoundCue(completed ? "done" : "cancelled");
  if (audioOnlyOwnership) finish(false, now);
}
CueSummary expressionCues() {
  CueSummary result;
  result.action_pending = actionPending; result.sound_pending = soundPending;
  result.sound_playing = soundPlaying; result.sound_clip = soundCue.clip;
  result.action_timing = activeActionTiming; result.sound_timing = soundCue.timing;
  result.sound_state = soundState;
  result.local = soundCue.local; result.local_feedback = localFeedbackHeld;
  return result;
}
bool localFeedbackAvailable(uint32_t now) {
  return owned && !audioOnlyOwnership && currentPhase == Phase::Listening && !due(now, leaseUntil) &&
         !actualPlaybackActive && !emotionHeld && !actionHeld && !actionPending &&
         !((soundPending || soundPlaying) && !soundCue.local);
}
bool tryLocalFeedback(uint8_t semanticId, uint32_t durationMs, uint32_t now) {
  if (!durationMs || durationMs > 3000 || semanticId > 41 || semanticId == 39 || semanticId == 41 ||
      !localFeedbackAvailable(now)) return false;
  const char id[] = {static_cast<char>('0' + semanticId / 10), static_cast<char>('0' + semanticId % 10), 0};
  if (semanticState(id) < 0) return false;
  localFeedbackState = semanticId; localFeedbackUntil = now + durationMs; localFeedbackHeld = true;
  showVisual(semanticId);
  return true;
}
bool localFeedbackActive(uint32_t now) { return localFeedbackHeld && !due(now, localFeedbackUntil); }
void clearLocalFeedback(uint32_t now) {
  if (clearLocalFeedbackState() && owned) showTargets(now);
}
bool tryQueueLocalCue(uint8_t clip, float gain, uint32_t expiresAtMs, uint32_t now) {
  const int32_t remaining = static_cast<int32_t>(expiresAtMs - now);
  if (!clip || clip >= sfx::C_COUNT || !isfinite(gain) || gain < 0.f || gain > .6f ||
      remaining <= 0 || remaining > 3000 || actualPlaybackActive || soundPending || soundPlaying ||
      (owned && !localFeedbackAvailable(now)) ||
      (haveCueCooldown && !due(now, cueCooldownUntil)) ||
      (haveLocalOffer && expiresAtMs == lastLocalOfferUntil && !due(now, lastLocalOfferUntil))) return false;
  if (++cueSerial == 0) ++cueSerial;
  soundCue = SoundCue(); soundCue.clip = clip; soundCue.gain = gain;
  soundCue.token = cueSerial; soundCue.generation = currentGeneration;
  soundCue.expiresAtMs = expiresAtMs; soundCue.timing = SoundTiming::WhenQuiet; soundCue.local = true;
  soundPending = true; soundState = "queued";
  haveLocalOffer = true; lastLocalOfferUntil = expiresAtMs;
  return true;
}
void cancelLocalCue(uint32_t now) {
  (void)now;
  if (soundCue.local && (soundPending || soundPlaying)) clearSoundCue("cancelled");
}
bool active() { return owned; }
Phase phase() { return currentPhase; }
int visibleEmotionId() { return visibleState; }
uint8_t actionId() { return requestedAction; }
bool directionalActionHeld(uint32_t now) {
  if (!owned || audioOnlyOwnership || !actionHeld || due(now, leaseUntil) || due(now, actionUntil)) return false;
  return actionPending ? !due(now, deferredUntil) && motion::isDirectionalAction(deferredAction)
                       : motion::isDirectionalAction(requestedAction);
}
const char* statusText() { return status; }
const char* turnId() { return currentTurn; }
uint32_t generation() { return currentGeneration; }
const char* ackName(AckStatus value) {
  static const char* const names[] = {"accepted", "duplicate", "invalid", "stale", "expired", "busy", "no_turn"};
  const size_t n = static_cast<size_t>(value);
  return n < sizeof(names) / sizeof(names[0]) ? names[n] : "invalid";
}
const char* phaseName(Phase value) {
  static const char* const names[] = {"待机", "正在听", "识别中", "思考中", "执行中", "正在回复", "已完成", "出错", "受限", "已停止"};
  return validPhase(value) ? names[static_cast<size_t>(value)] : "未知";
}

}  // namespace conversation
