#pragma once
// 脉冲 Pulse · 2.9 活泼版：听节拍（原创代码，纯软件，可以在电脑上测试）
// 只在本机分析麦克风声音的「能量起伏」：低 / 中 / 高三个频段的能量突然变大 → 起音曲线 →
// 自相关找一拍多长 → 梳状滤波找拍点在哪。不录音、不上传、不识别说的是什么。
#include <stddef.h>
#include <stdint.h>

namespace beat {

constexpr uint32_t kRate = 16000;
constexpr int kHop = 160;              // 10 毫秒一帧
constexpr int kFrames = 512;           // 分析最近 5.12 秒
constexpr int kMinLag = 33, kMaxLag = 86;  // 一拍 0.33–0.86 秒（182–70 BPM）
constexpr int kMaxAc = 2 * kMaxLag;    // 自相关算到两拍
constexpr int kMinFrames = 250;        // 至少听 2.5 秒才下结论
constexpr int kAnalyzeEvery = 25;      // 每 0.25 秒分析一次
constexpr float kMinRms = 70.f;        // 最近 1 秒太安静 = 没在放歌

struct Estimate {
  bool music = false;       // 有稳定的节拍，可以跟着跳
  float bpm = 0.f;
  float confidence = 0.f;   // 0–1
  float level = 0.f;        // 最近 1 秒的音量（RMS，16 位采样单位）
  uint32_t periodMs = 0;    // 一拍多长
  uint32_t beatMs = 0;      // 最近一拍的时间（和 feed 给的时间同一个时钟）
  uint16_t frames = 0;      // 窗口里有多少帧（10 毫秒一帧）
  uint16_t analyses = 0;    // 分析过几次
  uint8_t stable = 0;       // 连续几次分析得到差不多的速度
};

// 下一拍在什么时候（≥ now）。没有节拍时返回 now
uint32_t nextBeat(const Estimate& e, uint32_t now);
// 现在是第几拍（带小数，从 beatMs 那一拍算起；now 早于 beatMs 时为负）
float beatPhase(const Estimate& e, uint32_t now);

class Tracker {
 public:
  Tracker() { reset(); }
  void reset();
  // 16 kHz 单声道；nowMs = 这一段最后一个采样的时间
  void feed(const int16_t* pcm, size_t n, uint32_t nowMs);
  const Estimate& estimate() const { return _est; }
  float odfAt(int ago) const;          // 测试用：ago 帧以前的起音强度
  uint32_t hops() const { return _hops; }
  float lastAutocorr() const { return _ac; }  // 测试用：选中速度的自相关
  float lastAutocorr2() const { return _ac2; }  // 测试用：两拍处的自相关
  float lastSalience() const { return _sal; }   // 测试用：拍点上的起音强度 / 平均起音强度
  float lowEnergyRatio() const { return _ler; }  // 测试用：窗口里安静帧的比例
 private:
  void hop(uint32_t t);
  void analyze();
  float _dc, _lp1, _lp2, _eL, _eM, _eH, _eT, _prevLowE, _pL, _pM, _pH, _lastP, _ac, _ac2, _sal, _ler;
  int _n, _head, _count, _since;
  bool _havePrev;
  uint32_t _hops, _lastHopMs;
  float _odf[kFrames];
  float _ms[kFrames];
  Estimate _est;
  // 分析用的临时缓冲（固件里整个 Tracker 放在 PSRAM，不占内部内存和任务栈）
  float _lin[kFrames];
  float _r[kMaxAc + 3];
  float _comb[2 * kMaxLag + 2];
};

}  // namespace beat
