#pragma once
// 脉冲 Pulse · 混音器（原创代码，不依赖硬件）
// 素材音效（μ-law 24 kHz，见 sfx_bank.h）+ 合成音（sfx_synth.h）→ 48 kHz 单声道 16 位
// 固件里由 sfx.cpp 的音频任务调用；电脑上的测试程序也直接用它生成一模一样的声音。
#include <stdint.h>
#include "sfx_bank.h"
#include "sfx_synth.h"

namespace sfx {

class Mixer {
 public:
  Mixer();
  // 播放素材音效。gain：音量倍数；rate：播放速度（1 = 原样，1.06 = 快 6%、音调也高一点）；
  // cut = true：正在响的素材音效和合成音在 10 毫秒内淡出（切换场景时用），否则叠加播放
  void playClip(uint8_t clip, float gain, float rate, bool cut);
  void playSynth(uint8_t sound, bool replace, uint32_t seed);
  void stopClips();   // 素材音效全部淡出
  void stopAll();     // 全部淡出
  bool busy() const;  // 还有声音没放完
  int activeClips() const;
  void render(int16_t* out, int n);  // 生成 n 个采样（n ≤ 1024）
  void setMasterGain(float g) { _master = (int32_t)(g * 4096.f); }

 private:
  struct Voice {
    const uint8_t* data;
    uint32_t len;     // 采样数
    uint32_t pos;     // 当前位置（整数部分）
    uint32_t frac;    // 小数部分（Q16）
    uint32_t step;    // 每个输出采样前进多少（Q16）
    int32_t gain;     // Q12
    int32_t fade;     // > 0：正在淡出，剩余采样数
    uint32_t serial;
    bool on;
  };
  static constexpr int kVoices = 6;
  static constexpr int kFade = 480;  // 10 毫秒（48 kHz）
  static constexpr int kMaxN = 1024;
  void fadeAll();
  Voice _v[kVoices];
  Synth _syn;
  uint32_t _serial = 0;
  int32_t _master = 4096;
  int32_t _acc[kMaxN];
};

}  // namespace sfx
