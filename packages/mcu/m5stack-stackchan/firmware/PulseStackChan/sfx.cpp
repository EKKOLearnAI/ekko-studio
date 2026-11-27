// 脉冲 Pulse · 音效：单独的任务里实时混音，用 M5Unified 的 Speaker 流式播放（原创代码）
// 每块 20 毫秒，最多排队两块，所以声音和画面的延迟不超过 40 毫秒。
#include <M5Unified.h>
#include <stdlib.h>
#include <atomic>
#include <math.h>
#include "sfx.h"
#include "sfx_mixer.h"
#include "config.h"

namespace sfx {

namespace {

enum : uint8_t { K_CLIP, K_SYNTH, K_STOP, K_CUE };
struct Cmd { uint8_t kind, id, flags, pad; float gain, rate; uint32_t seed; uint32_t epoch; uint32_t token; };
constexpr int kBlock = 960;  // 20 毫秒（48 kHz）
constexpr int kChannel = 0;
const uint8_t kVolume[4] = {0, PULSE_SFX_VOL_LOW, PULSE_SFX_VOL_MID, PULSE_SFX_VOL_HIGH};

Mixer* mixer = nullptr;
QueueHandle_t queue = nullptr;
SemaphoreHandle_t commandLock = nullptr;
TaskHandle_t task = nullptr;
int16_t blocks[3][kBlock];
std::atomic<uint8_t> lvl{0};
std::atomic<bool> ready{false};
std::atomic<bool> suspended{false};
std::atomic<bool> workBusy{false}, cueReserved{false};
std::atomic<uint32_t> cueToken{0};
std::atomic<uint8_t> chanVol{255};
std::atomic<uint8_t> cueClip{0}, cueState{(uint8_t)CueState::Idle};
std::atomic<uint32_t> audioEpoch{1}, seedCounter{1};
uint32_t enterMs = 0;

void apply(const Cmd& c) {
  switch (c.kind) {
    case K_CLIP: case K_CUE: mixer->playClip(c.id, c.gain, c.rate, c.flags != 0); break;
    case K_SYNTH: mixer->playSynth(c.id, c.flags != 0, c.seed); break;
    default: mixer->stopAll(); break;
  }
}

void audioTask(void*) {
  int bi = 0;
  uint32_t seenEpoch = audioEpoch.load();
  uint32_t activeCue = 0, tailAt = 0;
  Cmd c;
  auto synchronize = [&]() {
    const uint32_t current = audioEpoch.load();
    if (current != seenEpoch) {
      mixer->stopAll();
      // Drop only this task's already buffered PCM, never another TTS channel.
      M5.Speaker.stop(kChannel);
      // Complete the 10/25-ms fades into a discarded buffer. A rapid suspend /
      // resume must never replay the old tail, and this never touches I2S.
      while (mixer->busy()) mixer->render(blocks[bi], kBlock);
      activeCue = 0; tailAt = 0;
      seenEpoch = current;
    }
  };
  for (;;) {
    synchronize();
    while (xQueueReceive(queue, &c, 0) == pdTRUE) {
      synchronize();
      xSemaphoreTake(commandLock, portMAX_DELAY);
      if (c.epoch == seenEpoch && audioEpoch.load() == seenEpoch) {
        apply(c);
        if (c.kind == K_CUE && c.token == cueToken.load()) {
          activeCue = c.token;
          cueState.store((uint8_t)CueState::Playing);
        }
      }
      xSemaphoreGive(commandLock);
    }
    if (audioEpoch.load() != seenEpoch) continue;
    if (!mixer->busy()) {
      if (M5.Speaker.isPlaying(kChannel)) { tailAt = 0; vTaskDelay(1); continue; }
      if (workBusy.load()) {
        if (!tailAt) tailAt = millis() + 70;
        if ((int32_t)(millis() - tailAt) < 0) { vTaskDelay(1); continue; }
      }
      xSemaphoreTake(commandLock, portMAX_DELAY);
      if (audioEpoch.load() != seenEpoch || uxQueueMessagesWaiting(queue)) {
        xSemaphoreGive(commandLock); continue;
      }
      workBusy.store(false); tailAt = 0;
      if (activeCue && activeCue == cueToken.load()) {
        cueState.store((uint8_t)CueState::Done);
        cueReserved.store(false); activeCue = 0;
      }
      xSemaphoreGive(commandLock);
      // stop() can always wake this task; it never needs a free queue slot.
      ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
      continue;
    }
    if (M5.Speaker.isPlaying(kChannel) >= 2) {  // 正在放一块、还排着一块：等一下
      vTaskDelay(1);
      continue;
    }
    int16_t* b = blocks[bi];
    mixer->render(b, kBlock);
    xSemaphoreTake(commandLock, portMAX_DELAY);
    if (audioEpoch.load() == seenEpoch) {
      if (!M5.Speaker.playRaw(b, kBlock, kRate, false, 1, kChannel, false) && activeCue) {
        cueState.store((uint8_t)CueState::Failed); cueReserved.store(false);
        mixer->stopAll(); activeCue = 0;
      }
    }
    xSemaphoreGive(commandLock);
    bi = (bi + 1) % 3;
  }
}

void (*prePlayHook)() = nullptr;

void post(Cmd c) {
  if (!ready.load()) return;
  if (prePlayHook && lvl.load() != 0 && !suspended.load() && !cueReserved.load()) prePlayHook();
  xSemaphoreTake(commandLock, portMAX_DELAY);
  if (!detail::ordinaryPostAllowed(lvl.load() != 0, suspended.load(), cueReserved.load())) {
    xSemaphoreGive(commandLock); return;
  }
  c.epoch = audioEpoch.load();
  const bool sent = xQueueSend(queue, &c, 0) == pdTRUE;
  if (sent) workBusy.store(true);
  xSemaphoreGive(commandLock);
  if (sent) xTaskNotifyGive(task);
}

void stopImpl(bool dedicatedCancellation) {
  if (!ready.load()) return;
  xSemaphoreTake(commandLock, portMAX_DELAY);
  if (!detail::stopAllowed(dedicatedCancellation, cueReserved.load())) {
    xSemaphoreGive(commandLock); return;
  }
  audioEpoch.fetch_add(1);
  xQueueReset(queue);
  if (cueReserved.exchange(false)) cueState.store((uint8_t)CueState::Cancelled);
  M5.Speaker.stop(kChannel);  // Same lock as PCM publication: no stale block after stop.
  xSemaphoreGive(commandLock);
  xTaskNotifyGive(task);
}

int stateNum(const char* id) { return id ? atoi(id) : -1; }

}  // namespace

void begin(uint8_t level) {
  lvl = level > 3 ? 2 : level;
  if (!M5.Speaker.begin()) {
    Serial.println("[sfx] 这块板子没有可用的喇叭");
    return;
  }
  M5.Speaker.setVolume(kVolume[lvl]);
  M5.Speaker.setChannelVolume(kChannel, chanVol.load());
  mixer = new Mixer();
  queue = xQueueCreate(16, sizeof(Cmd));
  commandLock = xSemaphoreCreateMutex();
  if (!mixer || !queue || !commandLock) {
    delete mixer; mixer = nullptr;
    if (queue) { vQueueDelete(queue); queue = nullptr; }
    if (commandLock) { vSemaphoreDelete(commandLock); commandLock = nullptr; }
    return;
  }
  mixer->setMasterGain(PULSE_SFX_GAIN);
  // 优先级比 M5Unified 的喇叭任务低，放在核心 0（画脸在核心 1）
  if (xTaskCreatePinnedToCore(audioTask, "pulse_sfx", 4096, nullptr, 1, &task, 0) != pdPASS) {
    delete mixer; mixer = nullptr;
    vQueueDelete(queue); queue = nullptr;
    vSemaphoreDelete(commandLock); commandLock = nullptr;
    return;
  }
  ready = true;
  Serial.printf("[sfx] 音效：%s（%d 个素材音效）\n", levelName(lvl), (int)C_COUNT - 1);
}

bool ok() { return ready; }

void setLevel(uint8_t level) {
  lvl = level > 3 ? 3 : level;
  if (ready) M5.Speaker.setVolume(kVolume[lvl]);
  if (lvl == 0) stopImpl(true);
}

uint8_t level() { return lvl; }

void setNightScale(float scale) {
  if (!(scale >= .1f)) scale = .1f;  // 也挡住 NaN
  if (scale > 1.f) scale = 1.f;
  const uint8_t v = (uint8_t)(255.f * scale + .5f);
  if (chanVol.exchange(v) == v) return;
  if (ready) M5.Speaker.setChannelVolume(kChannel, v);
}

float nightScale() { return chanVol.load() / 255.f; }

const char* levelName(uint8_t level) {
  static const char* const k[4] = {"关", "小", "中", "大"};
  return k[level > 3 ? 3 : level];
}

void play(uint8_t clip, float gain, float rate, bool cut) {
  if (clip == C_NONE && !cut) return;
  post(Cmd{K_CLIP, clip, (uint8_t)(cut ? 1 : 0), 0, gain, rate, 0, 0, 0});
}

void synth(uint8_t sound, bool replace) {
  if (sound == S_NONE && !replace) return;
  post(Cmd{K_SYNTH, sound, (uint8_t)(replace ? 1 : 0), 0, 1.f, 1.f, seedCounter++, 0, 0});
}

void stop() {
  // Serialize producers so reset removes exactly the old epoch. New commands
  // published after this lock is released remain queued and playable.
  stopImpl(true);
}
void stopAmbient() { stopImpl(false); }
void setPrePlayHook(void (*hook)()) { prePlayHook = hook; }

void setSuspended(bool value) {
  if (!ready.load()) { suspended.store(value); return; }
  xSemaphoreTake(commandLock, portMAX_DELAY);
  if (suspended.load() == value) { xSemaphoreGive(commandLock); return; }
  suspended.store(value);
  audioEpoch.fetch_add(1);
  xQueueReset(queue);
  if (cueReserved.exchange(false)) cueState.store((uint8_t)CueState::Cancelled);
  M5.Speaker.stop(kChannel);
  xSemaphoreGive(commandLock);
  xTaskNotifyGive(task);
}

bool playCue(uint8_t clip, float gain, uint32_t token) {
  if (!ready.load() || !token || !clip || clip >= C_COUNT || !isfinite(gain) || gain < 0 || gain > .6f)
    return false;
  if (xSemaphoreTake(commandLock, 0) != pdTRUE) return false;
  if (!lvl.load() || workBusy.load() || cueReserved.load() || M5.Speaker.isPlaying()) {
    xSemaphoreGive(commandLock); return false;
  }
  const uint32_t epoch = audioEpoch.fetch_add(1) + 1;
  xQueueReset(queue);
  cueToken.store(token); cueClip.store(clip); cueState.store((uint8_t)CueState::Queued);
  cueReserved.store(true); workBusy.store(true);
  const Cmd c{K_CUE, clip, 1, 0, gain, 1.f, 0, epoch, token};
  const bool sent = xQueueSend(queue, &c, 0) == pdTRUE;
  if (!sent) { cueReserved.store(false); workBusy.store(false); cueState.store((uint8_t)CueState::Failed); }
  xSemaphoreGive(commandLock);
  if (sent) xTaskNotifyGive(task);
  return sent;
}
void cancelCue() { if (cueReserved.load()) stopImpl(true); }
bool busy() { return workBusy.load(); }
CueStatus cueStatus() {
  CueStatus result;
  result.token = cueToken.load(); result.clip = cueClip.load();
  result.state = (CueState)cueState.load(); result.busy = workBusy.load();
  return result;
}

// 每个状态的默认声音：尽量用音效包里的声音，素材里没有的情绪才用合成音
uint8_t stateClip(const char* stateId) {
  switch (stateNum(stateId)) {
    case 0: return C_HOME_SLEEP_Z;      // 睡眠：睡觉冒 z
    case 1: return C_HOME_WAKE;         // 唤醒
    case 2: return C_EKKO_EYES_OPEN;    // 待机放空：睁眼
    case 3: return C_HOME_HM;           // 好奇「嗯？」
    case 5: return C_EKKO_BOOT;         // 加载苏醒：开机提示音
    case 7: return C_TRACK_SURPRISE;    // 抖动唤醒：弹簧声 +「！」
    case 10: return C_HOME_JOY;         // 开心：耶～
    case 11: return C_TRACK_HM;         // 疑惑：嗯？
    case 13: return C_HOME_SURPRISE;    // 惊讶：！
    case 14: return C_TRACK_GIGGLE;     // 害羞：嘿嘿
    case 15: return C_HOME_SIGH;        // 疲惫：叹气
    case 18: return C_HOME_SIGH;        // 无奈：叹气
    case 19: return C_HOME_FINAL_NOD;   // 满意：点头 + 爱心
    case 20: return C_TRACK_DIZZY;      // 困惑：晕～
    case 30: return C_TRACK_HM;         // 思考中
    case 31: return C_EKKO_ACK;         // 接收任务：收到
    case 33: return C_HOME_TADA;        // 任务完成：哒哒～
    case 35: return C_TRACK_LISTEN;     // 等待输入：开始聆听
    case 36: return C_HOME_BROADCAST;   // 联网加载：广播
    case 37: return C_EKKO_TALK;        // 复述回忆：叽里咕噜
    case 39: return C_EKKO_TALK;        // 输出回复：叽里咕噜
    case 40: return C_TRACK_RECOGNIZED; // 检索资料：识别成功
    default: return C_NONE;             // 04 06 12 16 17 21 32 34 38 41：合成音
  }
}

void onState(const char* stateId, bool withSound) {
  enterMs = millis();
  if (!withSound) return;
  const uint8_t c = stateClip(stateId);
  if (c != C_NONE) play(c, 1.f, 1.f, true);
  else synth(enterSound(stateId), true);
}

void onEvents(uint32_t events, const char* stateId) {
  if (!events || millis() - enterMs > PULSE_SFX_AMBIENT_MS) return;
  const uint8_t s = eventSound(stateId, events);
  if (s != S_NONE) synth(s, false);
}

void onTap() { play(C_HOME_POP, 1.f, .94f + (esp_random() % 13) * .01f); }

void preview() { play(C_EKKO_HAPPY, 1.f, 1.f, true); }

}  // namespace sfx
