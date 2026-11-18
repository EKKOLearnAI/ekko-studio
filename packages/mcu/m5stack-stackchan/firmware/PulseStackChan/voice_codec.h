#pragma once
#include <stddef.h>
#include <stdint.h>

namespace voice_audio { namespace detail {
struct HadpInfo { uint32_t sample_rate = 0; size_t sample_count = 0; };
bool inspectHadp(const uint8_t* bytes, size_t length, HadpInfo& info,
                 const char*& error);
bool decodeHadp(const uint8_t* bytes, size_t length, int16_t* output,
                size_t capacity, HadpInfo& info, const char*& error);

struct GateResult {
  bool started = false, finished = false, too_short = false, limited = false;
  bool noise_like = false;
  bool not_voiced = false;  // 能量够但几乎没有浊音（高过零率噪声），已并入 too_short 丢弃  // 录满上限、几乎无停顿的持续背景声（已并入 too_short 丢弃）
  bool recording = false;
  float rms = 0, noise_rms = 0;
};
// Endpointing for the explicitly half-duplex test build. This is an adaptive
// energy gate; it does not classify speech and does not cancel echo.
class EnergyGate {
 public:
  void reset();  // 开始监听：底噪回到初始值
  void next();   // 一段结束后接着听：保留底噪
  GateResult consume(const int16_t* samples, size_t count);
  float noise() const { return _noise; }
  static constexpr size_t kMinVoicedSamples = 4800;  // 300ms @16kHz
  static constexpr size_t kMinTonalSamples = 1600;   // 100ms 低过零率浊音
 private:
  float _noise = 100;
  double _rmsSum = 0;
  size_t _start = 0, _quiet = 0, _voiced = 0, _length = 0, _tonal = 0, _startTonal = 0;
  bool _recording = false;
};
} }
