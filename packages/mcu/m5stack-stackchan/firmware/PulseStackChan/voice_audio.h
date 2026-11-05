#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <atomic>
#include <cmath>
#include "beat.h"

// First-stage half-duplex speech I/O. Energy-based endpointing, not AEC,
// keyword spotting, linguistic VAD, or playback-time spoken interruption.
namespace voice_audio {

namespace detail {
// Portable ownership state used by the real audio path and host regressions.
// All mutations require the same caller-owned publication mutex, held through
// hardware start. Atomic readers let the capture task observe leases safely.
class OutputLease {
 public:
  bool tryBeginCue(bool captureIdle, bool speakerIdle) {
    if (!captureIdle || !speakerIdle || _cue.load() || _playback.load()) return false;
    _cue.store(true);
    return true;
  }
  bool tryBeginPlayback(bool requestCurrent) {
    if (!requestCurrent || _cue.load() || _playback.load()) return false;
    _playback.store(true);
    return true;
  }
  void endCue() { _cue.store(false); }
  void endPlayback() { _playback.store(false); }
  bool cueActive() const { return _cue.load(); }
  bool playbackActive() const { return _playback.load(); }
  bool blocksCapture() const { return cueActive() || playbackActive(); }
 private:
  std::atomic<bool> _cue{false}, _playback{false};
};

// Capture-worker/app handshake, always protected by the publication mutex.
// Evidence is accepted PCM sample duration, never wall time or status polling.
// An unclaimed grant belongs to this handshake; after claim the app alone owns
// the output lease and must drain actual SFX before ending it.
class QuietCuePause {
 public:
  enum class State : uint8_t { Idle, Waiting, Draining, Granted };
  // The only mutation allowed without the publication mutex. The worker or
  // app services it before any subsequent grant/claim/publication decision.
  void requestCancellation() { _cancelRequested.store(true); }
  bool takeCancellation() { return _cancelRequested.exchange(false); }
  void request(uint32_t generation, uint32_t epoch, uint32_t session) {
    if (_state != State::Idle || _cancelRequested.load()) return;
    _generation = generation; _epoch = epoch; _session = session;
    _quietSamples = 0; _state = State::Waiting;
  }
  bool matches(uint32_t generation, uint32_t epoch, uint32_t session) const {
    return active() && generation == _generation && epoch == _epoch && session == _session;
  }
  void observe(bool lowEnergy, bool recording, size_t samples) {
    if ((_state != State::Waiting && _state != State::Draining) || _cancelRequested.load()) return;
    if (recording) { clear(); return; }
    if (!lowEnergy) { _quietSamples = 0; _state = State::Waiting; return; }
    if (samples >= kQuietSamples - _quietSamples) _quietSamples = kQuietSamples;
    else _quietSamples += samples;
    if (_quietSamples == kQuietSamples) _state = State::Draining;
  }
  void observeEnergy(float rms, float noise, bool recording, size_t samples) {
    if (recording) { observe(false, true, samples); return; }
    if (samples == 0) return;
    // Reuse the endpoint gate's lower (remain) threshold, not its four-block
    // onset decision. Even an incomplete/weak onset abandons the pause.
    const float threshold = std::fmax(180.f, noise * 1.8f + 50.f);
    const bool quiet = samples <= 16000 && std::isfinite(rms) && std::isfinite(noise) && std::isfinite(threshold) &&
                       rms >= 0.f && noise >= 0.f && rms < threshold;
    observe(quiet, recording, samples);
  }
  bool grant(OutputLease& output, bool fullyDrained, bool speakerIdle) {
    if (_state != State::Draining || _cancelRequested.load() || !fullyDrained ||
        !output.tryBeginCue(true, speakerIdle)) return false;
    _state = State::Granted;
    return true;
  }
  void routedSession(uint32_t session) { if (_state == State::Granted) _session = session; }
  bool claim(uint32_t generation, uint32_t epoch, uint32_t session) {
    if (_state != State::Granted || _cancelRequested.load() || !matches(generation, epoch, session)) return false;
    clear();
    return true;
  }
  // True means an unclaimed, never-played output lease was released. The
  // caller may restore the previous listening intent if its epoch is current.
  bool cancel(OutputLease& output) {
    const bool unclaimed = _state == State::Granted;
    if (unclaimed) output.endCue();
    clear();
    _cancelRequested.store(false);
    return unclaimed;
  }
  bool active() const { return _state != State::Idle; }
  bool draining() const { return _state == State::Draining; }
  State state() const { return _state; }
  size_t quietSamples() const { return _quietSamples; }
 private:
  static const size_t kQuietSamples = 8000; // 500 ms of observed 16 kHz PCM.
  void clear() { _state = State::Idle; _quietSamples = 0; }
  State _state = State::Idle;
  std::atomic<bool> _cancelRequested{false};
  uint32_t _generation = 0, _epoch = 0, _session = 0;
  size_t _quietSamples = 0;
};
}  // namespace detail

static const uint32_t kSampleRate = 16000;
static const size_t kMaximumUtteranceSamples = kSampleRate * 20;

struct Utterance {
  int16_t* samples = nullptr;
  union { size_t count = 0; size_t sample_count; };
  uint32_t sample_rate = kSampleRate;
  uint32_t sequence = 0;
  uint32_t generation = 0;
  bool ended_by_limit = false;
};

struct PlaybackRequest {
  char url[512];
  char bearer[2048];
  union { char interaction_id[80]; char interactionId[80]; };
  union { char segment_id[80]; char segmentId[80]; };
  uint32_t generation;
  PlaybackRequest() { memset(this, 0, sizeof(*this)); }
};

enum class EventKind : uint8_t {
  Started, Done, Failed, Cancelled, Interrupted = Cancelled
};

struct Event {
  EventKind kind = EventKind::Failed;
  uint32_t generation = 0;
  char interaction_id[80] = {};
  char segment_id[80] = {};
  char error[96] = {};
};

struct Status {
  bool ready = false;
  bool listening = false;
  bool recording = false;
  bool playback_busy = false;
  bool external_cue_active = false;
  uint32_t generation = 0;
  float rms = 0;
  float noise_rms = 0;
  size_t captured_samples = 0;
  uint32_t completed_utterances = 0;
  uint32_t dropped_events = 0;
  char error[96] = {};
};

// 2.9 环境声音（听歌跳舞）：麦克风只在本机算节拍，不做语音检测、不存音频、不上传。
struct AmbientStatus {
  bool wanted = false;      // 要听（setAmbient(true)）
  bool active = false;      // 真的在收音（没被播放 / 提示音 / 语音占用）
  uint32_t epoch = 0;       // 第几次开始听（每次 setAmbient(true) +1；估计值属于这一次）
  uint32_t updatedMs = 0;   // 最近一次分析的时间（0 = 这次还没分析过）
  uint32_t samples = 0;     // 这次一共听了多少采样
  beat::Estimate est;
};

// Call once during setup, before starting the camera worker. Mic codec setup
// touches I2C only here. RX I2S1 and TX I2S0 share physical BCK/WS pins;
// experimental half-duplex GPIO routing selects exactly one clock domain.
// The first capture window waits for output drain plus 100 ms ADC settling.
bool begin();
bool ok();
// Scheme + host + optional port, e.g. http://192.168.0.10:8650. Playback URLs
// must match this exact origin. Redirects are disabled. Configure before use.
bool setAllowedOrigin(const char* origin);
void setListening(bool enabled);
bool listening();  // 只表示「在听人说话」，不包括环境声音
// 2.9：环境声音分析开关。关的时候同步把时钟切回喇叭（播放音效前调用即可）。
// 说话收音（setListening(true)）优先：两个都开时只做语音。播放、提示音、TTS 期间自动暂停，之后从头听
void setAmbient(bool enabled);
bool ambientWanted();
bool ambientOk();  // 能听节拍（节拍分析器在 PSRAM 里分配成功）
AmbientStatus ambientStatus();
bool recording();
bool busy();
// Sole app-owned SFX lease. First setListening(false), then retry this
// nonblocking call until microphone requests/utterance processing have drained.
// A successful call owns TX routing and excludes TTS publication and capture.
// TTS downloads may continue. busy() reports TTS work only, not this lease.
bool tryBeginExternalCue();
// Cooperative alternative for an already listening device. Do not call
// setListening(false) first. Poll without blocking: the capture worker requires
// >=500 ms low-energy PCM, pauses replenishment, and consumes every outstanding
// record/release block; any onset candidate resumes capture. True transfers one
// exclusive cue lease to the app and pauses listening. Generation/session
// changes or TTS revoke unclaimed work. No whole utterance is interrupted.
// This cannot inspect the driver's private hardware FIFO, and speech beginning
// after the handoff remains subject to the normal half-duplex audio gap.
bool tryBeginQuietListeningCue();
// Nonblocking withdrawal of only an unclaimed cooperative request. The capture
// worker restores its original listening intent at its next publication point
// if immediate zero-wait cleanup cannot acquire the mutex. After a true return
// above, use endExternalCue instead; this never releases an app-owned lease.
void cancelQuietListeningCueWait();
// Call exactly once per successful lease after the app has stopped/drained SFX
// channel 0 and its DMA/settling tail, including failure and cancellation paths.
// Idempotent for cleanup; never call this while a later cue owns the lease.
// cancel() cannot release this lease early: the app remains its sole owner.
void endExternalCue();
Status status();
uint32_t generation();

// takeUtterance transfers ownership to the caller. The caller/network worker
// must call freeUtterance after upload or on rejection. Capturing automatically
// pauses after one completed utterance until explicitly enabled again.
bool takeUtterance(Utterance& result);
void freeUtterance(Utterance& utterance);

bool enqueuePlayback(const PlaybackRequest& request);
bool takeEvent(Event& result);
// Cancels recording, queued utterances/downloads and channel-1 playback.
// Pass Studio's new generation to synchronize both modules; zero increments
// the current local generation. Older explicit generations are ignored.
// External SFX leases remain owned until endExternalCue after real SFX drain.
void cancel(uint32_t newGeneration = 0);

}  // namespace voice_audio
