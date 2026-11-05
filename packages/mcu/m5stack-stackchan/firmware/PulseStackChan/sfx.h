#pragma once
// 脉冲 Pulse · 音效（用机器自带的喇叭：CoreS3 / Core2 / Basic 都有）
// 声音来源：① 原 36 个素材及本地互动语音（sfx_bank）② 少量合成音（例如生气、出错）
#include <stdint.h>
#include "sfx_bank.h"
#include "sfx_synth.h"

namespace sfx {

namespace detail {
// Used under the command-publication mutex. Dedicated cues and their drain
// tail must discard ordinary/ambient posts, never queue them for a later burst.
inline bool ordinaryPostAllowed(bool enabled, bool suspended, bool cueReserved) {
  return enabled && !suspended && !cueReserved;
}
inline bool stopAllowed(bool dedicatedCancellation, bool cueReserved) {
  return dedicatedCancellation || !cueReserved;
}
}

void begin(uint8_t level);              // level：0 = 关，1 = 小，2 = 中，3 = 大
bool ok();                              // 喇叭可用
void setLevel(uint8_t level);
uint8_t level();
// 2.7：夜间安静——只调音效通道（0 号，含本地互动语音）的音量，1 = 正常，0.45 = 夜里小声；TTS 用的是另一个通道，不受影响
void setNightScale(float scale);
float nightScale();
const char* levelName(uint8_t level);   // 「关 / 小 / 中 / 大」

// 播放素材音效（Clip，见 sfx_bank.h）。gain 音量倍数，rate 播放速度（音调跟着变），cut = 先淡出正在响的声音
void play(uint8_t clip, float gain = 1.f, float rate = 1.f, bool cut = false);
void synth(uint8_t sound, bool replace = false);  // 播放合成音（Sound，见 sfx_synth.h）
// Cancellation barrier: discard queued old SFX and wake the audio task even
// when its command queue is full. Later play() calls belong to the new epoch.
// Owns Speaker channel 0 only; streamed TTS must use a separate channel.
void stop();
// Ordinary life/phase cleanup only. It cannot cut a dedicated reserved cue;
// explicit stop, sound-off and TTS cancellation continue to use stop/cancelCue.
void stopAmbient();
// Reserve the audio hardware for voice. Suspended SFX are discarded, not queued
// for later; resuming only permits subsequent new play/synth commands.
void setSuspended(bool suspended);
enum class CueState : uint8_t { Idle, Queued, Playing, Done, Cancelled, Failed };
struct CueStatus {
  CueState state = CueState::Idle;
  uint32_t token = 0;
  uint8_t clip = 0;
  bool busy = false;
};
// Only the bounded director cue bypasses ordinary SFX suspension. The caller
// must first own the voice module's exclusive external-cue hardware lease.
bool playCue(uint8_t clip, float gain, uint32_t token);
void cancelCue();
bool busy();  // Includes queued PCM, speaker channel 0, and a 70ms DMA drain.
CueStatus cueStatus();

uint8_t stateClip(const char* stateId);           // 状态默认用哪个素材音效（没有 = 0，用合成音）
void onState(const char* stateId, bool withSound = true);  // 切换状态时调用（withSound = 播默认声音）
void onEvents(uint32_t events, const char* stateId);  // 每帧调用：表情引擎的周期事件（跳动、光环、心电……）
void onTap();                                     // 点了一下脸
// 2.9：每次要放声音之前先调用（例如：先关掉环境声音收音，把时钟切回喇叭）。在调用 play/synth 的任务里同步执行
void setPrePlayHook(void (*hook)());
void preview();                                   // 设置里改音量时试听

}  // namespace sfx
