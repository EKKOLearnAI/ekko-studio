#include "voice_audio.h"
#include "voice_codec.h"

#include <M5Unified.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <esp_heap_caps.h>
#include <esp_rom_gpio.h>
#include <soc/gpio_sig_map.h>
#include <atomic>
#include <new>
#include <math.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include <freertos/task.h>

namespace voice_audio {
namespace {
constexpr size_t kBlock = 320;          // 20 ms at 16 kHz.
constexpr size_t kPreRoll = 4800;        // 300 ms, includes speech-start confirmation.
constexpr size_t kMaximumEncoded = 20 + 48000 * 30 / 2;
constexpr int kSpeechChannel = 1;
constexpr int kEventCount = 16, kPlaybackCount = 3;

std::atomic<bool> s_ready{false}, s_wantListening{false}, s_recording{false}, s_wantAmbient{false};
std::atomic<uint32_t> s_ambientEpoch{0};
beat::Tracker* s_beat = nullptr;  // 只在采集任务里用（约 8 KB，放 PSRAM）
AmbientStatus s_ambient;       // s_statusMux 保护
std::atomic<bool> s_blockCapture{false}, s_releaseOverflow{false};
std::atomic<uint32_t> s_generation{1}, s_captureSession{1}, s_cancelEpoch{1};
std::atomic<unsigned> s_pending{0};
std::atomic<bool> s_rxRouted{false};
std::atomic<uint32_t> s_rxReadyAt{0};
detail::OutputLease s_outputLease;
detail::QuietCuePause s_quietCue;
QueueHandle_t s_released = nullptr, s_utterances = nullptr;
QueueHandle_t s_requests = nullptr, s_events = nullptr;
StaticQueue_t s_releasedControl, s_utteranceControl, s_requestControl, s_eventControl;
uint8_t s_releasedStorage[8];
uint8_t* s_utteranceStorage = nullptr;
uint8_t* s_requestStorage = nullptr;
uint8_t* s_eventStorage = nullptr;
SemaphoreHandle_t s_playLock = nullptr, s_originLock = nullptr;
int16_t* s_buffers[3] = {};
int16_t* s_preRoll = nullptr;
char s_origin[256] = {};
portMUX_TYPE s_statusMux = portMUX_INITIALIZER_UNLOCKED;
Status s_status;

void copyText(char* out, size_t capacity, const char* text) {
  if (!capacity) return;
  if (!text) text = "";
  strncpy(out, text, capacity - 1); out[capacity - 1] = 0;
}
void setError(const char* text) {
  portENTER_CRITICAL(&s_statusMux);
  copyText(s_status.error, sizeof(s_status.error), text);
  portEXIT_CRITICAL(&s_statusMux);
}
void* psram(size_t size) { return heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT); }
void dispose(PlaybackRequest* p) {
  if (!p) return;
  volatile char* secret = p->bearer;
  for (size_t i = 0; i < sizeof(p->bearer); ++i) secret[i] = 0;
  heap_caps_free(p);
}
bool current(const PlaybackRequest& r, uint32_t epoch) {
  return r.generation == s_generation.load() && epoch == s_cancelEpoch.load();
}
void event(const PlaybackRequest& request, EventKind kind, const char* error = "") {
  Event e;
  e.kind = kind; e.generation = request.generation;
  copyText(e.interaction_id, sizeof(e.interaction_id), request.interaction_id);
  copyText(e.segment_id, sizeof(e.segment_id), request.segment_id);
  copyText(e.error, sizeof(e.error), error);
  if (!s_events || xQueueSend(s_events, &e, 0) != pdTRUE) {
    portENTER_CRITICAL(&s_statusMux); ++s_status.dropped_events;
    portEXIT_CRITICAL(&s_statusMux);
    setError("audio_event_queue_full");
  }
}
void released(void*, void* data, size_t count) {
  if (count != kBlock || !s_released) { s_releaseOverflow.store(true); return; }
  for (uint8_t i = 0; i < 3; ++i) {
    if (data == s_buffers[i]) {
      if (xQueueSend(s_released, &i, 0) != pdTRUE) s_releaseOverflow.store(true);
      return;
    }
  }
}

// Both controllers are initialized once. Only one master clock is connected
// to the shared physical BCK/WS pins at a time. This is half-duplex routing,
// not simultaneous microphone/speaker operation or an AEC reference path.
void routeClock(bool receive) {  // s_playLock held, or setup before tasks exist.
  if (s_rxRouted.load() == receive) return;
#if defined(CONFIG_IDF_TARGET_ESP32S3)
  esp_rom_gpio_connect_out_signal(34, receive ? I2S1I_BCK_OUT_IDX : I2S0O_BCK_OUT_IDX, false, false);
  esp_rom_gpio_connect_out_signal(33, receive ? I2S1I_WS_OUT_IDX : I2S0O_WS_OUT_IDX, false, false);
#endif
  s_rxReadyAt.store(millis() + 100);
  s_captureSession.fetch_add(1); // Drop every in-flight frame from the old clock domain.
  s_rxRouted.store(receive);
}
bool captureRequested() {
  return (s_wantListening.load() || s_wantAmbient.load()) && !s_blockCapture.load() &&
         !s_outputLease.blocksCapture() && !M5.Speaker.isPlaying();
}
bool captureAllowed() {
  return captureRequested() && s_rxRouted.load() &&
         (int32_t)(millis() - s_rxReadyAt.load()) >= 0;
}
// s_playLock held. Only the handshake may release an unclaimed grant; a cue
// already claimed by the app is outside this state and remains app-owned.
void cancelQuietCueLocked(bool restoreListening) {
  if (s_quietCue.cancel(s_outputLease) && restoreListening) s_wantListening.store(true);
}
bool quietCueMatches() {
  return s_quietCue.matches(s_generation.load(), s_cancelEpoch.load(), s_captureSession.load());
}
void serviceQuietCueLocked() {
  if (s_quietCue.takeCancellation() || (s_quietCue.active() && !quietCueMatches()))
    cancelQuietCueLocked(true);
}
void captureTask(void*) {
  bool inFlight[3] = {};
  uint32_t bufferSession[3] = {}, localSession = s_captureSession.load();
  uint32_t sequence = 0, utteranceGeneration = 0;
  uint32_t speakerQuietAt = millis();
  detail::EnergyGate gate;
  size_t preWrite = 0, preCount = 0, used = 0;
  int16_t* utterance = nullptr;
  auto reset = [&]() {
    if (utterance) heap_caps_free(utterance);
    utterance = nullptr; used = preWrite = preCount = 0;
    gate.reset(); s_recording.store(false);
    if (s_beat) s_beat->reset();  // 时钟 / 会话换了：节拍从头听（中间断过的声音不能接起来算）
    const uint32_t epoch = s_ambientEpoch.load();
    portENTER_CRITICAL(&s_statusMux); s_status.captured_samples = 0;
    s_ambient.est = beat::Estimate(); s_ambient.updatedMs = 0; s_ambient.samples = 0; s_ambient.epoch = epoch;
    portEXIT_CRITICAL(&s_statusMux);
  };
  // 2.9 环境声音：只算节拍。分析在 feed 里做（每 0.25 秒一次，约 1–2 毫秒）
  auto feedAmbient = [&](const int16_t* samples, size_t n) {
    if (!s_beat) return;
    const uint16_t before = s_beat->estimate().analyses;
    const uint32_t now = millis();
    s_beat->feed(samples, n, now);
    const bool fresh = s_beat->estimate().analyses != before;
    const uint32_t epoch = s_ambientEpoch.load();
    portENTER_CRITICAL(&s_statusMux);
    if (s_ambient.epoch != epoch) { s_ambient.est = beat::Estimate(); s_ambient.updatedMs = 0; s_ambient.samples = 0; s_ambient.epoch = epoch; }
    s_ambient.samples += (uint32_t)n;
    if (fresh) { s_ambient.est = s_beat->estimate(); s_ambient.updatedMs = now ? now : 1; }
    portEXIT_CRITICAL(&s_statusMux);
  };
  for (;;) {
    if (M5.Speaker.isPlaying()) speakerQuietAt = millis();
    xSemaphoreTake(s_playLock, portMAX_DELAY);
    serviceQuietCueLocked();
    const bool receive = captureRequested() && (uint32_t)(millis() - speakerQuietAt) >= 80;
    routeClock(receive);
    serviceQuietCueLocked();
    xSemaphoreGive(s_playLock);
    const uint32_t session = s_captureSession.load();
    if (session != localSession) { reset(); localSession = session; }
    uint8_t index;
    if (xQueueReceive(s_released, &index, pdMS_TO_TICKS(5)) == pdTRUE) {
      if (index < 3) {
        inFlight[index] = false;
        if (captureAllowed() && bufferSession[index] == localSession && !s_wantListening.load()) {
          // 不在听人说话：只是环境声音（算节拍），不进语音检测
          if (utterance || preCount) reset();
          if (s_wantAmbient.load()) feedAmbient(s_buffers[index], kBlock);
        } else if (captureAllowed() && bufferSession[index] == localSession) {
          const int16_t* samples = s_buffers[index];
          for (size_t i = 0; i < kBlock; ++i) {
            s_preRoll[preWrite] = samples[i];
            preWrite = (preWrite + 1) % kPreRoll;
            if (preCount < kPreRoll) ++preCount;
          }
          const detail::GateResult g = gate.consume(samples, kBlock);
          xSemaphoreTake(s_playLock, portMAX_DELAY);
          serviceQuietCueLocked();
          if (s_quietCue.active() && quietCueMatches() && localSession == s_captureSession.load()) {
            // Stricter than the onset threshold: a possible weak onset also
            // abandons draining before VAD has accumulated its four blocks.
            s_quietCue.observeEnergy(g.rms, g.noise_rms, g.recording || utterance != nullptr, kBlock);
          }
          xSemaphoreGive(s_playLock);
          portENTER_CRITICAL(&s_statusMux);
          s_status.rms = g.rms; s_status.noise_rms = g.noise_rms;
          portEXIT_CRITICAL(&s_statusMux);
          if (g.started) {
            utterance = static_cast<int16_t*>(psram(kMaximumUtteranceSamples * sizeof(int16_t)));
            if (!utterance) {
              setError("utterance_psram_allocation_failed"); s_wantListening.store(false); reset();
            } else {
              utteranceGeneration = s_generation.load(); used = preCount;
              const size_t first = (preWrite + kPreRoll - preCount) % kPreRoll;
              for (size_t i = 0; i < preCount; ++i) utterance[i] = s_preRoll[(first + i) % kPreRoll];
            }
          } else if (utterance) {
            const size_t space = kMaximumUtteranceSamples - used;
            const size_t add = space < kBlock ? space : kBlock;
            memcpy(utterance + used, samples, add * sizeof(int16_t)); used += add;
          }
          const bool limit = utterance && used >= kMaximumUtteranceSamples;
          if (utterance && (g.finished || limit)) {
            if (g.too_short) {
              heap_caps_free(utterance); utterance = nullptr; used = 0;
            } else if (utteranceGeneration != s_generation.load() || localSession != s_captureSession.load()) {
              reset();
            } else {
              // Retain 200 ms of the 800 ms endpoint silence, without clipping
              // a maximum-duration utterance's last speech samples.
              if (!limit && !g.limited && used > 9600) used -= 9600;
              Utterance output;
              output.samples = utterance; output.count = used;
              output.sequence = ++sequence; output.generation = utteranceGeneration;
              output.ended_by_limit = limit || g.limited;
              utterance = nullptr; used = 0;
              xSemaphoreTake(s_playLock, portMAX_DELAY);
              if (output.generation != s_generation.load() || localSession != s_captureSession.load()) {
                freeUtterance(output);
              } else if (xQueueSend(s_utterances, &output, 0) == pdTRUE) {
                s_wantListening.store(false);
                portENTER_CRITICAL(&s_statusMux); ++s_status.completed_utterances;
                portEXIT_CRITICAL(&s_statusMux);
              } else { freeUtterance(output); setError("utterance_queue_full"); s_wantListening.store(false); }
              xSemaphoreGive(s_playLock);
            }
            gate.next(); preCount = preWrite = 0;  // 保留底噪继续听
          }
          s_recording.store(utterance != nullptr);
          portENTER_CRITICAL(&s_statusMux); s_status.captured_samples = used;
          portEXIT_CRITICAL(&s_statusMux);
        } else if (utterance || preCount) reset();
      }
    }
    if (s_releaseOverflow.exchange(false)) {
      // 只在听环境声音时：节拍从头听就行，不算错误
      if (s_wantListening.load()) { setError("microphone_release_queue_overflow"); s_wantListening.store(false); }
      reset();
      // A slot being empty is acquire-ordered after its writes. Do not reuse
      // any unknown buffer until every already queued request has finished.
      while (M5.Mic.isRecording()) vTaskDelay(1);
      for (bool& flight : inFlight) flight = false;
      while (xQueueReceive(s_released, &index, 0) == pdTRUE) {}
    }
    unsigned occupied = 0;
    for (bool flight : inFlight) occupied += flight;
    xSemaphoreTake(s_playLock, portMAX_DELAY);
    serviceQuietCueLocked();
    if (s_quietCue.draining() && captureAllowed()) {
      // isRecording alone is insufficient: a released slot's callback can
      // still be in flight. Keep every slot owned until its callback is read.
      const bool drained = occupied == 0 && uxQueueMessagesWaiting(s_released) == 0 &&
                           !M5.Mic.isRecording() && !utterance && !s_recording.load();
      if (s_quietCue.grant(s_outputLease, drained, !M5.Speaker.isPlaying())) {
        s_wantListening.store(false);
        routeClock(false);
        s_quietCue.routedSession(s_captureSession.load());
      }
    }
    const bool pauseReplenishment = s_quietCue.draining();
    xSemaphoreGive(s_playLock);
    if (!captureAllowed()) {
      if (utterance || preCount) reset();
      continue;
    }
    if (pauseReplenishment) continue;
    for (uint8_t i = 0; i < 3 && occupied < 2; ++i) {
      if (inFlight[i]) continue;
      // Serialize record publication with cue/TTS ownership. An earlier
      // captureAllowed() result must not enqueue RX after a cue obtained TX.
      xSemaphoreTake(s_playLock, portMAX_DELAY);
      if (!captureAllowed() || localSession != s_captureSession.load() || s_quietCue.draining()) {
        xSemaphoreGive(s_playLock);
        break;
      }
      bufferSession[i] = localSession;
      const bool accepted = M5.Mic.record(s_buffers[i], kBlock);
      xSemaphoreGive(s_playLock);
      if (!accepted) {
        setError("microphone_record_request_failed"); s_wantListening.store(false); s_wantAmbient.store(false); reset(); break;
      }
      inFlight[i] = true; ++occupied;
    }
  }
}

String originOf(const char* raw) {
  if (!raw) return String();
  const String url(raw);
  if (url.indexOf('\r') >= 0 || url.indexOf('\n') >= 0 || url.indexOf('\\') >= 0 ||
      url.indexOf(' ') >= 0 || url.indexOf('\t') >= 0) return String();
  size_t start;
  if (url.startsWith("http://")) start = 7;
  else if (url.startsWith("https://")) start = 8;
  else return String();
  size_t end = start;
  while (end < url.length() && url[end] != '/' && url[end] != '?' && url[end] != '#') ++end;
  if (end == start) return String();
  String origin = url.substring(0, end);
  if (origin.indexOf('@') >= 0) return String();
  origin.toLowerCase(); return origin;
}

class DownloadSink : public Stream {
 public:
  DownloadSink(const PlaybackRequest& r, uint32_t epoch, size_t capacity)
      : _request(r), _epoch(epoch), _capacity(capacity), _deadline(millis() + 20000) {
    bytes = static_cast<uint8_t*>(psram(capacity));
  }
  ~DownloadSink() { if (bytes) heap_caps_free(bytes); }
  uint8_t* bytes = nullptr;
  size_t used = 0;
  bool overflow = false;
  size_t write(uint8_t value) override { return write(&value, 1); }
  size_t write(const uint8_t* data, size_t length) override {
    if (!bytes || !current(_request, _epoch) || (int32_t)(millis() - _deadline) >= 0) return 0;
    if (length > _capacity - used) { overflow = true; return 0; }
    memcpy(bytes + used, data, length); used += length; return length;
  }
  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  void flush() override {}
 private:
  const PlaybackRequest& _request;
  uint32_t _epoch;
  size_t _capacity;
  uint32_t _deadline;
};

void finishRequest(PlaybackRequest* request, bool lockHeld = false) {
  dispose(request);
  if (!lockHeld) xSemaphoreTake(s_playLock, portMAX_DELAY);
  if (s_pending.fetch_sub(1) == 1) s_blockCapture.store(false);
  if (!lockHeld) xSemaphoreGive(s_playLock);
}
void playbackTask(void*) {
  for (;;) {
    PlaybackRequest* request = nullptr;
    if (xQueueReceive(s_requests, &request, portMAX_DELAY) != pdTRUE || !request) continue;
    const uint32_t epoch = s_cancelEpoch.load();
    if (!current(*request, epoch)) {
      event(*request, EventKind::Cancelled, "stale_generation"); finishRequest(request); continue;
    }
    const char* error = nullptr;
    char allowed[sizeof(s_origin)];
    xSemaphoreTake(s_originLock, portMAX_DELAY); copyText(allowed, sizeof(allowed), s_origin);
    xSemaphoreGive(s_originLock);
    const String origin = originOf(request->url);
    if (!allowed[0] || origin != allowed) error = "playback_origin_rejected";
    // This LAN test build deliberately refuses HTTPS without a configured CA.
    // Never silently replace certificate verification with setInsecure().
    else if (!origin.startsWith("http://")) error = "https_ca_not_configured";
    else if (!WiFi.isConnected()) error = "wifi_disconnected";
    if (error) { event(*request, EventKind::Failed, error); setError(error); finishRequest(request); continue; }
    WiFiClient client;
    HTTPClient http;
    http.setTimeout(1000); http.setConnectTimeout(3000);
    http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
    const char* headerKeys[] = {"Content-Encoding"};
    http.collectHeaders(headerKeys, 1);
    if (!http.begin(client, request->url)) {
      event(*request, EventKind::Failed, "audio_http_begin_failed"); finishRequest(request); continue;
    }
    http.addHeader("Accept-Encoding", "identity");
    if (request->bearer[0]) {
      String authorization(request->bearer);
      if (!authorization.startsWith("Bearer ")) authorization = "Bearer " + authorization;
      http.addHeader("Authorization", authorization);
    }
    const int response = http.GET();
    const int size = http.getSize();
    if (!current(*request, epoch)) error = "cancelled";
    else if (response != 200) error = "audio_http_status_failed";
    else if (size == 0 || size > (int)kMaximumEncoded) error = "encoded_audio_too_large_or_empty";
    else if (http.header("Content-Encoding").length() && http.header("Content-Encoding") != "identity") error = "compressed_http_audio_unsupported";
    if (error) {
      http.end(); event(*request, current(*request, epoch) ? EventKind::Failed : EventKind::Cancelled, error);
      setError(error); finishRequest(request); continue;
    }
    DownloadSink sink(*request, epoch, size > 0 ? (size_t)size : kMaximumEncoded);
    const int written = sink.bytes ? http.writeToStream(&sink) : -1;
    http.end();
    if (!current(*request, epoch)) error = "cancelled";
    else if (!sink.bytes) error = "encoded_audio_psram_allocation_failed";
    else if (written < 0 || sink.overflow || (size > 0 && sink.used != (size_t)size)) error = "audio_download_incomplete";
    detail::HadpInfo info;
    if (!error && !detail::inspectHadp(sink.bytes, sink.used, info, error)) {}
    int16_t* pcm = nullptr;
    if (!error) {
      pcm = static_cast<int16_t*>(psram(info.sample_count * sizeof(int16_t)));
      if (!pcm) error = "playback_pcm_psram_allocation_failed";
      else if (!detail::decodeHadp(sink.bytes, sink.used, pcm, info.sample_count, info, error)) {}
    }
    if (error) {
      if (pcm) heap_caps_free(pcm);
      event(*request, current(*request, epoch) ? EventKind::Failed : EventKind::Cancelled, error);
      setError(error); finishRequest(request); continue;
    }
    // Serialize cancellation with publication, so a cancelled generation can
    // never publish a stale speaker request after cancel() has returned.
    bool started = false;
    for (;;) {
      xSemaphoreTake(s_playLock, portMAX_DELAY);
      const bool requestCurrent = current(*request, epoch);
      bool waitForCue = false;
      if (s_outputLease.tryBeginPlayback(requestCurrent)) {
        // Reservation, clock routing and publication are one critical section.
        routeClock(false);
        started = M5.Speaker.playRaw(pcm, info.sample_count, info.sample_rate, false,
                                    1, kSpeechChannel, false);
        if (started) event(*request, EventKind::Started);
        else s_outputLease.endPlayback();
      } else waitForCue = requestCurrent && s_outputLease.cueActive();
      xSemaphoreGive(s_playLock);
      if (!waitForCue) break;
      // Cancellation must remain responsive; no mutex is held while waiting.
      vTaskDelay(pdMS_TO_TICKS(5));
    }
    if (!started) {
      heap_caps_free(pcm);
      event(*request, current(*request, epoch) ? EventKind::Failed : EventKind::Cancelled,
            current(*request, epoch) ? "speaker_request_failed" : "cancelled");
      finishRequest(request); continue;
    }
    const uint32_t deadline = millis() + (uint32_t)(info.sample_count * 1000ULL / info.sample_rate) + 5000;
    while (M5.Speaker.isPlaying(kSpeechChannel) && current(*request, epoch) &&
           (int32_t)(millis() - deadline) < 0) vTaskDelay(pdMS_TO_TICKS(5));
    bool cancelled = !current(*request, epoch);
    bool timedOut = (int32_t)(millis() - deadline) >= 0;
    if (cancelled || timedOut) M5.Speaker.stop(kSpeechChannel);
    // stop() is a request; retain PCM until the speaker has actually released
    // all channel-1 references. No end()/begin() or I2C calls occur here.
    while (M5.Speaker.isPlaying(kSpeechChannel)) vTaskDelay(1);
    heap_caps_free(pcm);
    // Speaker slot release precedes the last I2S DMA samples. Drain a bounded
    // tail before declaring playback done or re-enabling microphone records.
    const uint32_t tail = millis() + 70;
    // Keep ownership through actual DMA drain even after cancel() returns.
    while ((int32_t)(millis() - tail) < 0) vTaskDelay(1);
    xSemaphoreTake(s_playLock, portMAX_DELAY);
    s_outputLease.endPlayback();
    xSemaphoreGive(s_playLock);
    cancelled = !current(*request, epoch);
    event(*request, cancelled ? EventKind::Cancelled : (timedOut ? EventKind::Failed : EventKind::Done),
          cancelled ? "cancelled" : (timedOut ? "speaker_timeout" : ""));
    finishRequest(request);
  }
}
void releaseInitialization() {
  for (int16_t*& buffer : s_buffers) { if (buffer) heap_caps_free(buffer); buffer = nullptr; }
  if (s_preRoll) heap_caps_free(s_preRoll); s_preRoll = nullptr;
  if (s_utteranceStorage) heap_caps_free(s_utteranceStorage); s_utteranceStorage = nullptr;
  if (s_requestStorage) heap_caps_free(s_requestStorage); s_requestStorage = nullptr;
  if (s_eventStorage) heap_caps_free(s_eventStorage); s_eventStorage = nullptr;
  s_released = s_utterances = s_requests = s_events = nullptr;
  if (s_playLock) vSemaphoreDelete(s_playLock); s_playLock = nullptr;
  if (s_originLock) vSemaphoreDelete(s_originLock); s_originLock = nullptr;
}
}  // namespace

bool begin() {
  if (s_ready.load()) return true;
  if (!psramFound()) { setError("voice_requires_psram"); return false; }
  s_playLock = xSemaphoreCreateMutex(); s_originLock = xSemaphoreCreateMutex();
  s_preRoll = static_cast<int16_t*>(psram(kPreRoll * sizeof(int16_t)));
  for (int16_t*& buffer : s_buffers) buffer = static_cast<int16_t*>(psram(kBlock * sizeof(int16_t)));
  s_utteranceStorage = static_cast<uint8_t*>(psram(sizeof(Utterance)));
  s_requestStorage = static_cast<uint8_t*>(psram(kPlaybackCount * sizeof(PlaybackRequest*)));
  s_eventStorage = static_cast<uint8_t*>(psram(kEventCount * sizeof(Event)));
  if (!s_playLock || !s_originLock || !s_preRoll || !s_buffers[0] || !s_buffers[1] || !s_buffers[2] ||
      !s_utteranceStorage || !s_requestStorage || !s_eventStorage) {
    setError("voice_psram_or_mutex_allocation_failed"); releaseInitialization(); return false;
  }
  s_released = xQueueCreateStatic(8, 1, s_releasedStorage, &s_releasedControl);
  s_utterances = xQueueCreateStatic(1, sizeof(Utterance), s_utteranceStorage, &s_utteranceControl);
  s_requests = xQueueCreateStatic(kPlaybackCount, sizeof(PlaybackRequest*), s_requestStorage, &s_requestControl);
  s_events = xQueueCreateStatic(kEventCount, sizeof(Event), s_eventStorage, &s_eventControl);
  if (!s_released || !s_utterances || !s_requests || !s_events) {
    setError("voice_queue_initialization_failed"); releaseInitialization(); return false;
  }
  if (M5.Mic.isRecording()) {
    setError("microphone_already_in_use"); releaseInitialization(); return false;
  }
  if (M5.Mic.isRunning()) M5.Mic.end();
  auto cfg = M5.Mic.config();
  auto speakerCfg = M5.Speaker.config();
  if (cfg.pin_bck != 34 || cfg.pin_ws != 33 || cfg.pin_data_in != 14 ||
      speakerCfg.pin_bck != 34 || speakerCfg.pin_ws != 33 || speakerCfg.pin_data_out != 13) {
    setError("voice_core_s3_pinmap_required"); releaseInitialization(); return false;
  }
  // CoreS3 defaults both classes to port 1. Separate their controllers before
  // starting either port, then route their shared physical clocks explicitly.
  if (M5.Speaker.isRunning()) M5.Speaker.end();
  speakerCfg.i2s_port = I2S_NUM_0;
  speakerCfg.use_dac = false; speakerCfg.buzzer = false;
  M5.Speaker.config(speakerCfg);
  if (!M5.Speaker.begin()) {
    setError("speaker_initialization_failed"); releaseInitialization(); return false;
  }
  cfg.sample_rate = kSampleRate; cfg.i2s_port = I2S_NUM_1;
  cfg.over_sampling = 1; cfg.dma_buf_len = 128; cfg.dma_buf_count = 4;
  cfg.task_pinned_core = 0; cfg.task_priority = 3;
  M5.Mic.config(cfg);
  M5.Mic.setBufferReleaseCallback(nullptr, released);
  if (!M5.Mic.begin()) {
    M5.Mic.setBufferReleaseCallback(nullptr, nullptr);
    setError("microphone_initialization_failed"); releaseInitialization(); return false;
  }
  if (!M5.Speaker.isRunning() && !M5.Speaker.begin()) {
    M5.Mic.end(); M5.Mic.setBufferReleaseCallback(nullptr, nullptr);
    setError("speaker_initialization_failed"); releaseInitialization(); return false;
  }
  M5.Speaker.setChannelVolume(kSpeechChannel, 255);
  // Mic.begin just routed RX. Return BCK/WS to TX for the existing idle SFX;
  // leave GPIO0 MCLK on I2S1 for the ADC's next receive window.
  s_rxRouted.store(true); routeClock(false);
  // 2.9 听节拍：分配不到 = 不能听歌跳舞（语音照常）
  if (!s_beat) if (void* m = psram(sizeof(beat::Tracker))) s_beat = new (m) beat::Tracker();
  TaskHandle_t playback = nullptr;
  if (xTaskCreatePinnedToCore(playbackTask, "voice_play", 6144, nullptr, 1, &playback, 0) != pdPASS) {
    M5.Mic.end(); M5.Mic.setBufferReleaseCallback(nullptr, nullptr);
    setError("voice_playback_task_allocation_failed"); releaseInitialization(); return false;
  }
  if (xTaskCreatePinnedToCore(captureTask, "voice_capture", 4096, nullptr, 1, nullptr, 0) != pdPASS) {
    vTaskDelete(playback); M5.Mic.end(); M5.Mic.setBufferReleaseCallback(nullptr, nullptr);
    setError("voice_capture_task_allocation_failed"); releaseInitialization(); return false;
  }
  s_ready.store(true); setError("");
  Serial.println("[voice] 16kHz mic ready; experimental half-duplex GPIO clock routing, no AEC/voice barge-in");
  return true;
}
bool ok() { return s_ready.load(); }
bool setAllowedOrigin(const char* origin) {
  if (!s_ready.load() || !origin) return false;
  String parsed = originOf(origin);
  if (parsed.length() == 0 || parsed.length() >= sizeof(s_origin) || !parsed.startsWith("http://")) return false;
  xSemaphoreTake(s_originLock, portMAX_DELAY); copyText(s_origin, sizeof(s_origin), parsed.c_str());
  xSemaphoreGive(s_originLock); return true;
}
void setListening(bool enabled) {
  if (!s_ready.load()) return;
  xSemaphoreTake(s_playLock, portMAX_DELAY);
  // An explicit listening decision supersedes an unclaimed quiet pause.
  // It must never release a cue already claimed by the app.
  cancelQuietCueLocked(false);
  if (s_wantListening.exchange(enabled) != enabled) s_captureSession.fetch_add(1);
  if (enabled) {
    if (!s_outputLease.cueActive()) M5.Speaker.stop(0);
  } else routeClock(false);
  xSemaphoreGive(s_playLock);
}
bool listening() { return s_ready.load() && s_wantListening.load() && captureAllowed(); }
void setAmbient(bool enabled) {
  if (!s_ready.load() || !s_playLock || (enabled && !s_beat)) return;
  if (!enabled && !s_wantAmbient.load()) return;  // 已经关着：播放音效前每次都会调用，要快
  xSemaphoreTake(s_playLock, portMAX_DELAY);
  if (s_wantAmbient.exchange(enabled) != enabled) {
    if (enabled) s_ambientEpoch.fetch_add(1);
    s_captureSession.fetch_add(1);
  }
  if (!enabled && !s_wantListening.load()) routeClock(false);  // 同步切回喇叭，紧接着的音效不会丢
  xSemaphoreGive(s_playLock);
}
bool ambientWanted() { return s_wantAmbient.load(); }
bool ambientOk() { return s_ready.load() && s_beat != nullptr; }
AmbientStatus ambientStatus() {
  portENTER_CRITICAL(&s_statusMux); AmbientStatus result = s_ambient; portEXIT_CRITICAL(&s_statusMux);
  result.wanted = s_wantAmbient.load();
  result.active = s_ready.load() && result.wanted && !s_wantListening.load() && captureAllowed();
  if (result.epoch != s_ambientEpoch.load()) {  // 采集任务还没换到这一次
    result.est = beat::Estimate(); result.updatedMs = 0; result.samples = 0; result.epoch = s_ambientEpoch.load();
  }
  return result;
}
bool recording() { return s_recording.load(); }
bool busy() { return s_blockCapture.load(); }
bool tryBeginExternalCue() {
  if (!s_ready.load() || !s_playLock || xSemaphoreTake(s_playLock, 0) != pdTRUE) return false;
  serviceQuietCueLocked();
  const bool captureIdle = !s_wantListening.load() && !s_wantAmbient.load() && !s_recording.load() && !M5.Mic.isRecording();
  const bool accepted = s_outputLease.tryBeginCue(captureIdle, !M5.Speaker.isPlaying());
  if (accepted) routeClock(false);
  xSemaphoreGive(s_playLock);
  return accepted;
}
bool tryBeginQuietListeningCue() {
  if (!s_ready.load() || !s_playLock || xSemaphoreTake(s_playLock, 0) != pdTRUE) return false;
  serviceQuietCueLocked();
  const bool claimed = s_quietCue.claim(s_generation.load(), s_cancelEpoch.load(), s_captureSession.load());
  if (!claimed) {
    const bool eligible = s_wantListening.load() && captureAllowed() && !s_recording.load() && !s_blockCapture.load() &&
                          !s_outputLease.blocksCapture() && !M5.Speaker.isPlaying();
    if (eligible) s_quietCue.request(s_generation.load(), s_cancelEpoch.load(), s_captureSession.load());
    else cancelQuietCueLocked(true);
  }
  xSemaphoreGive(s_playLock);
  return claimed;
}
void cancelQuietListeningCueWait() {
  if (!s_ready.load() || !s_playLock) return;
  s_quietCue.requestCancellation();
  if (xSemaphoreTake(s_playLock, 0) != pdTRUE) return;
  serviceQuietCueLocked();
  xSemaphoreGive(s_playLock);
}
void endExternalCue() {
  if (!s_ready.load() || !s_playLock) return;
  xSemaphoreTake(s_playLock, portMAX_DELAY);
  s_outputLease.endCue();
  xSemaphoreGive(s_playLock);
}
Status status() {
  portENTER_CRITICAL(&s_statusMux); Status result = s_status; portEXIT_CRITICAL(&s_statusMux);
  result.ready = ok(); result.listening = listening(); result.recording = recording();
  result.playback_busy = busy(); result.external_cue_active = s_outputLease.cueActive();
  result.generation = generation(); return result;
}
uint32_t generation() { return s_generation.load(); }
bool takeUtterance(Utterance& output) {
  if (!s_ready.load()) return false;
  while (xQueueReceive(s_utterances, &output, 0) == pdTRUE) {
    if (output.generation == s_generation.load()) return true;
    freeUtterance(output);
  }
  return false;
}
void freeUtterance(Utterance& utterance) {
  if (utterance.samples) heap_caps_free(utterance.samples);
  utterance = Utterance();
}
bool enqueuePlayback(const PlaybackRequest& request) {
  if (!s_ready.load() || request.generation != s_generation.load() ||
      strnlen(request.url, sizeof(request.url)) == sizeof(request.url) ||
      strnlen(request.bearer, sizeof(request.bearer)) == sizeof(request.bearer) ||
      strnlen(request.interaction_id, sizeof(request.interaction_id)) == sizeof(request.interaction_id) ||
      strnlen(request.segment_id, sizeof(request.segment_id)) == sizeof(request.segment_id) ||
      strchr(request.bearer, '\r') || strchr(request.bearer, '\n')) return false;
  PlaybackRequest* copy = static_cast<PlaybackRequest*>(psram(sizeof(PlaybackRequest)));
  if (!copy) { setError("playback_request_psram_allocation_failed"); return false; }
  new (copy) PlaybackRequest(request);
  xSemaphoreTake(s_playLock, portMAX_DELAY);
  bool accepted = request.generation == s_generation.load();
  if (accepted) {
    // Prioritize TTS without leaving an unclaimed output reservation or a
    // paused listening intent. Capture remains blocked by the pending count.
    cancelQuietCueLocked(true);
    s_pending.fetch_add(1); s_blockCapture.store(true);
    accepted = xQueueSend(s_requests, &copy, 0) == pdTRUE;
    if (!accepted && s_pending.fetch_sub(1) == 1) s_blockCapture.store(false);
  }
  xSemaphoreGive(s_playLock);
  if (!accepted) { dispose(copy); setError("playback_queue_full_or_cancelled"); }
  return accepted;
}
bool takeEvent(Event& output) {
  return s_ready.load() && xQueueReceive(s_events, &output, 0) == pdTRUE;
}
void cancel(uint32_t newGeneration) {
  if (s_playLock) xSemaphoreTake(s_playLock, portMAX_DELAY);
  const uint32_t old = s_generation.load();
  if (newGeneration != 0 && (int32_t)(newGeneration - old) < 0) {
    if (s_playLock) xSemaphoreGive(s_playLock); return;
  }
  cancelQuietCueLocked(false);
  s_generation.store(newGeneration ? newGeneration : old + 1);
  s_cancelEpoch.fetch_add(1); s_captureSession.fetch_add(1);
  s_wantListening.store(false); s_wantAmbient.store(false); s_blockCapture.store(false);
  if (s_ready.load()) {
    routeClock(false);
    M5.Speaker.stop(kSpeechChannel);
    PlaybackRequest* request;
    while (xQueueReceive(s_requests, &request, 0) == pdTRUE) {
      event(*request, EventKind::Cancelled, "cancelled_before_download");
      finishRequest(request, true);
    }
    Utterance u;
    while (xQueueReceive(s_utterances, &u, 0) == pdTRUE) freeUtterance(u);
  }
  if (s_playLock) xSemaphoreGive(s_playLock);
}
}  // namespace voice_audio
