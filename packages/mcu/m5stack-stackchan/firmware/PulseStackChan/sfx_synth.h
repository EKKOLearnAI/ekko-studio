#pragma once
// 脉冲 Pulse · 音效合成器（原创代码）
// 纯 C++、不依赖硬件：固件里由 sfx.cpp 实时合成并送到喇叭；
// 电脑上的预览程序也直接用这份代码生成一模一样的声音。
#include <stdint.h>

namespace sfx {

constexpr int kRate = 48000;  // 采样率（Hz），和 M5Unified 喇叭的输出采样率一致，不用再重采样

enum Sound : uint8_t {
  S_NONE = 0,
  // 进入状态时
  S_SLEEP, S_WAKE, S_IDLE, S_CURIOUS, S_DAZE, S_BOOT, S_POWERDOWN, S_JOLT,
  S_HAPPY, S_PUZZLED, S_SAD, S_SURPRISE, S_SHY, S_TIRED, S_FOCUS, S_PANIC, S_MEH, S_CONTENT, S_CONFUSED, S_ANGRY,
  S_THINK, S_TASK, S_BUSY, S_DONE, S_ERROR, S_WAIT, S_LOAD, S_RECALL, S_DENY, S_TALK, S_SEARCH, S_STOP,
  // 状态里跟着灯效走的小声音 / 交互
  S_TAP, S_HOP, S_SIGH, S_NOPE, S_BUBBLE, S_TICK, S_INCOMING, S_SPARKLE, S_LOADTICK, S_SCANTICK,
  // 2.7 情绪价值版：陪伴相关（升级、爱心、早安、晚安、充电、哈欠、喷嚏、哼歌、想你、傲娇）
  S_LEVELUP, S_LOVE, S_MORNING, S_GOODNIGHT, S_CHARGE, S_YAWN, S_SNEEZE, S_HUM, S_MISS, S_POUT,
  // 2.8 陪伴版：叮咚（有消息）、夸夸、拍手、喝水、肚子饿、伸懒腰、任务完成、哎呀、知道啦、轻轻提醒
  S_DING, S_PRAISE, S_CLAP, S_WATER, S_TUMMY, S_STRETCH, S_CHEER, S_OOPS, S_ACK, S_NUDGE,
  // 2.9 活泼版：节奏「嘟」、轮到你啦、呼吸引导、舒服的咕噜噜、撒娇「嗯～？」
  S_BOP, S_TURN, S_BREATH, S_PURR, S_PLEASE,
  S_COUNT
};

// 进入状态时的声音（stateId = 状态编号，例如 "10"）
uint8_t enterSound(const char* stateId);
// 状态里的周期性视觉事件（pulse::EV_* 位掩码）对应的声音；没有就返回 S_NONE
uint8_t eventSound(const char* stateId, uint32_t events);
const char* soundName(uint8_t id);
// 按名字找合成音（例如 "love"）；找不到返回 -1（串口 play 命令用）
int findSound(const char* name);

class Synth {
 public:
  Synth();
  // replace = true：正在响的声音在 25 毫秒内淡出，再放新的（切换状态时用）
  // replace = false：叠加在上面（状态里的小事件、点击）
  void play(uint8_t id, bool replace, uint32_t seed = 0);
  void stop();                       // 全部淡出
  bool busy() const;                 // 还有没放完的音符
  void render(int16_t* out, int n);  // 生成 n 个单声道 16 位采样
  void setGain(float g) { _gain = g; }

 private:
  struct Voice {
    const void* note;    // 指向音符定义
    uint32_t start;      // 开始时刻（合成器时钟，单位：采样）
    int32_t len;         // 长度（采样）
    float ph, mph;       // 相位、FM 调制相位（单位：周）
    float lp, bp;        // 噪声带通滤波器的状态
    float rel, relStep;  // 淡出
    float pitch, gain;   // 整体音高、音量倍数（小事件每次略有变化）
    float lr;            // log2(终止频率 / 起始频率)
    uint32_t rng;
    uint32_t serial;
    bool on;
  };
  static constexpr int kVoices = 16;
  void release(bool all);
  Voice _v[kVoices];
  uint32_t _clock = 0, _serial = 0;
  float _gain = 3.f;  // 总增益：乐谱里的音量 × 3，典型峰值约 -8 dBFS
};

}  // namespace sfx
