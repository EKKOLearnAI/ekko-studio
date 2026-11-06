// 脉冲 Pulse · 2.9：听节拍（见 beat.h）
#include "beat.h"
#include <math.h>
#include <string.h>

namespace beat {
namespace {
constexpr float kDcA = 0.00196f;    // ≈ 5 Hz 去直流
constexpr float kA1 = 0.05724f;     // 1 - exp(-2π·150/16000)：低频（鼓）
constexpr float kA2 = 0.79212f;     // 1 - exp(-2π·4000/16000)：中频 / 高频分界
constexpr float kFloor = 1e4f;      // 能量取对数前的底（≈ RMS 100）
constexpr int kLevelHops = 100;     // 音量看最近 1 秒
constexpr float kOdfDelayMs = 8.f;  // 起音曲线比真实起音晚一点点
constexpr float kMusicConf = .45f;
constexpr float kMaxLowRatio = .40f;  // 安静帧超过 40% 多半是说话 / 零星的敲击
float s_prior[kMaxLag + 1];
bool s_priorReady = false;

inline float clamp01(float v) { return v < 0.f ? 0.f : (v > 1.f ? 1.f : v); }
void initPrior() {
  if (s_priorReady) return;
  for (int L = 0; L <= kMaxLag; ++L) {
    if (L < kMinLag) { s_prior[L] = 0.f; continue; }
    const float o = log2f((float)L / 50.f) / .6f;  // 偏爱 120 BPM 左右，σ = 0.6 个八度
    s_prior[L] = expf(-.5f * o * o);
  }
  s_priorReady = true;
}
// 抛物线插值：峰值在 i 附近的小数位置偏移（-0.5–0.5）
float refine(const float* r, int i) {
  const float a = r[i - 1], b = r[i], c = r[i + 1];
  const float d = a - 2.f * b + c;
  if (d >= -1e-9f) return 0.f;
  float off = .5f * (a - c) / d;
  if (off > .5f) off = .5f;
  if (off < -.5f) off = -.5f;
  return off;
}
}  // namespace

uint32_t nextBeat(const Estimate& e, uint32_t now) {
  if (!e.periodMs) return now;
  if ((int32_t)(now - e.beatMs) <= 0) return e.beatMs;
  const uint32_t k = (now - e.beatMs + e.periodMs - 1) / e.periodMs;
  return e.beatMs + k * e.periodMs;
}
float beatPhase(const Estimate& e, uint32_t now) {
  if (!e.periodMs) return 0.f;
  return (float)(int32_t)(now - e.beatMs) / (float)e.periodMs;
}

void Tracker::reset() {
  _dc = _lp1 = _lp2 = _eL = _eM = _eH = _eT = _prevLowE = _pL = _pM = _pH = _lastP = _ac = _ac2 = _sal = _ler = 0.f;
  _n = _head = _count = _since = 0;
  _havePrev = false;
  _hops = _lastHopMs = 0;
  memset(_odf, 0, sizeof(_odf));
  memset(_ms, 0, sizeof(_ms));
  _est = Estimate();
}

float Tracker::odfAt(int ago) const {
  if (ago < 0 || ago >= _count) return 0.f;
  return _odf[(_head - 1 - ago + 2 * kFrames) % kFrames];
}

void Tracker::feed(const int16_t* pcm, size_t n, uint32_t nowMs) {
  if (!pcm) return;
  for (size_t i = 0; i < n; ++i) {
    float x = (float)pcm[i];
    _dc += kDcA * (x - _dc);
    x -= _dc;
    _lp1 += kA1 * (x - _lp1);
    _lp2 += kA2 * (x - _lp2);
    const float lo = _lp1, mid = _lp2 - _lp1, hi = x - _lp2;
    _eL += lo * lo;
    _eM += mid * mid;
    _eH += hi * hi;
    _eT += x * x;
    if (++_n >= kHop) hop(nowMs - (uint32_t)(((uint64_t)(n - 1 - i) * 1000u) / kRate));
  }
}

void Tracker::hop(uint32_t t) {
  const float inv = 1.f / (float)kHop;
  const float eL = _eL * inv, eM = _eM * inv, eH = _eH * inv, eT = _eT * inv;
  _eL = _eM = _eH = _eT = 0.f;
  _n = 0;
  // 低频用 20 毫秒窗（两帧平均），不然 50 Hz 的鼓在 10 毫秒里相位不同，能量会抖
  const float lowW = .5f * (eL + _prevLowE);
  _prevLowE = eL;
  const float L = logf(1.f + lowW / kFloor), M = logf(1.f + eM / kFloor), H = logf(1.f + eH / kFloor);
  float o = 0.f;
  if (_havePrev) o = fmaxf(0.f, L - _pL) + .6f * fmaxf(0.f, M - _pM) + .8f * fmaxf(0.f, H - _pH);
  _pL = L; _pM = M; _pH = H;
  _havePrev = true;
  _odf[_head] = o;
  _ms[_head] = eT;
  _head = (_head + 1) % kFrames;
  if (_count < kFrames) ++_count;
  ++_hops;
  _lastHopMs = t;
  if (++_since >= kAnalyzeEvery) {
    _since = 0;
    analyze();
  }
}

void Tracker::analyze() {
  initPrior();
  const int N = _count;
  Estimate& e = _est;
  e.frames = (uint16_t)N;
  if (e.analyses < 0xFFFF) ++e.analyses;
  const int m = N < kLevelHops ? N : kLevelHops;
  float ms = 0.f;
  for (int k = 1; k <= m; ++k) ms += _ms[(_head - k + kFrames) % kFrames];
  e.level = m ? sqrtf(ms / (float)m) : 0.f;
  if (N < kMinFrames) {
    e.music = false;
    e.confidence = 0.f;
    return;
  }
  const int start = (_head - N + kFrames) % kFrames;
  // 注意：ESP32 只有单精度浮点硬件，这里全部用 float
  float mean = 0.f;
  for (int i = 0; i < N; ++i) {
    _lin[i] = _odf[(start + i) % kFrames];
    mean += _lin[i];
  }
  mean /= (float)N;
  float energy = 0.f;
  for (int i = 0; i < N; ++i) {
    _lin[i] -= mean;
    energy += _lin[i] * _lin[i];
  }
  const float e0 = energy / (float)N;
  if (e0 <= 1e-9f) {
    e.music = false; e.confidence = 0.f; e.stable = 0; _lastP = 0.f; _ac = 0.f;
    return;
  }
  int maxL = kMaxAc + 2;
  if (maxL > N - 40) maxL = N - 40;
  for (int L = 0; L <= kMaxAc + 2; ++L) _r[L] = 0.f;
  for (int L = 1; L <= maxL; ++L) {
    float s = 0.f;
    const float* a = _lin;
    const float* b = _lin + L;
    for (int i = 0, n = N - L; i < n; ++i) s += a[i] * b[i];
    _r[L] = (s / (float)(N - L)) / e0;  // 无偏、按方差归一化
  }
  // 选一拍多长：本身是峰，再加上两拍处的峰（真正的拍子两拍处也很像）
  float best = -1e9f;
  int bL = 0;
  for (int L = kMinLag; L <= kMaxLag; ++L) {
    if (_r[L] < _r[L - 1] || _r[L] < _r[L + 1]) continue;
    const float r2 = 2 * L <= maxL ? _r[2 * L] : 0.f;
    const float sc = s_prior[L] * (_r[L] + .5f * (r2 > 0.f ? r2 : 0.f));
    if (sc > best) { best = sc; bL = L; }
  }
  if (!bL) {
    e.music = false; e.confidence = 0.f; e.stable = 0; _lastP = 0.f; _ac = 0.f;
    return;
  }
  float P = (float)bL + refine(_r, bL);
  // 两拍处的峰再定一次，精度翻倍
  const int c2 = 2 * bL;
  if (c2 + 2 < maxL) {
    int b2 = c2;
    for (int L = c2 - 2; L <= c2 + 2; ++L)
      if (_r[L] > _r[b2]) b2 = L;
    if (_r[b2] >= .5f * _r[bL] && b2 > c2 - 2 && b2 < c2 + 2) P = .5f * (P + .5f * ((float)b2 + refine(_r, b2)));
  }
  // 太快（> 162 BPM）而两拍处也很强：按半速跳（舵机跟不上那么快）。上一次怎么选的就接着怎么选，免得来回跳
  bool doubled = false;
  {
    const int d = (int)lroundf(2.f * P);
    if (d <= kMaxLag && d <= maxL && _r[d] >= .6f * _r[bL]) {
      if (_lastP > 0.f && fabsf(2.f * P - _lastP) <= .04f * _lastP) doubled = true;  // 上次就是半速
      else if (_lastP > 0.f && fabsf(P - _lastP) <= .04f * _lastP) {}
      else if (P < 37.f) doubled = true;
    }
    if (doubled) P *= 2.f;
  }
  _ac = _r[bL];
  _ac2 = 2 * bL <= maxL ? _r[2 * bL] : 0.f;
  e.confidence = clamp01((_r[bL] - .12f) / .45f);
  // 找拍点：在起音曲线上每隔一拍取样，越近的权重越大
  const int phases = (int)ceilf(P);
  float bestC = -1e9f;
  int bPhi = 0;
  for (int phi = 0; phi < phases; ++phi) {
    float c = 0.f, w = 1.f;
    for (float pos = (float)(N - 1 - phi); pos >= 1.f; pos -= P) {
      const int i = (int)lroundf(pos);
      if (i < 1 || i >= N) break;
      c += w * (_lin[i] + .5f * (_lin[i - 1] + (i + 1 < N ? _lin[i + 1] : 0.f)));
      w *= .92f;
    }
    _comb[phi] = c;
    if (c > bestC) { bestC = c; bPhi = phi; }
  }
  const bool sameTempo = _lastP > 0.f && fabsf(P - _lastP) <= .04f * _lastP && e.periodMs;
  auto beatAt = [&](int phi) { return _lastHopMs - (uint32_t)lroundf((float)phi * 1000.f * kHop / kRate + kOdfDelayMs); };
  auto gridDist = [&](uint32_t t) {
    int32_t d = (int32_t)(t - e.beatMs) % (int32_t)e.periodMs;
    if (d < 0) d += (int32_t)e.periodMs;
    return (uint32_t)(d < (int32_t)e.periodMs - d ? d : (int32_t)e.periodMs - d);
  };
  // 接着上一次的拍子：上一次预测的拍点附近只要也够强（≥ 最强的 70%），就用它，免得在两个差不多的拍点之间来回跳
  // （例如底鼓和军鼓一样响、按半速跳的时候）
  if (sameTempo) {
    int near = 0;
    uint32_t nd = 0xFFFFFFFFu;
    for (int phi = 0; phi < phases; ++phi) {
      const uint32_t d = gridDist(beatAt(phi));
      if (d < nd) { nd = d; near = phi; }
    }
    int bn = near;
    for (int k = -2; k <= 2; ++k) {
      const int phi = (near + k + phases) % phases;
      if (_comb[phi] > _comb[bn]) bn = phi;
    }
    if (bn != bPhi && _comb[bn] >= .7f * bestC) bPhi = bn;
  }
  // 拍点显著度：拍点上（±1 帧取最大）的起音强度，比所有位置的平均高多少（随机的声音≈1）
  {
    float all = 0.f, grid = 0.f;
    int ng = 0;
    for (int i = 1; i + 1 < N; ++i) {
      float v = _lin[i - 1] > _lin[i] ? _lin[i - 1] : _lin[i];
      if (_lin[i + 1] > v) v = _lin[i + 1];
      all += v + mean;
    }
    for (float pos = (float)(N - 1 - bPhi); pos >= 1.f; pos -= P) {
      const int i = (int)lroundf(pos);
      if (i < 1) break;
      if (i + 1 >= N) continue;
      float v = _lin[i - 1] > _lin[i] ? _lin[i - 1] : _lin[i];
      if (_lin[i + 1] > v) v = _lin[i + 1];
      grid += v + mean;
      ++ng;
    }
    all /= (float)(N - 2);
    _sal = (ng && all > 1e-9f) ? (grid / (float)ng) / all : 0.f;
  }
  // 安静帧比例：说话一句一句、敲击一下一下，中间很多帧很安静；歌一般一直有声音
  {
    float sum = 0.f;
    for (int i = 0; i < N; ++i) sum += sqrtf(_ms[(start + i) % kFrames]);
    const float half = .5f * sum / (float)N, half2 = half * half;
    int low = 0;
    for (int i = 0; i < N; ++i)
      if (_ms[(start + i) % kFrames] < half2) ++low;
    _ler = (float)low / N;
  }
  const uint32_t periodMs = (uint32_t)lroundf(P * 1000.f * kHop / kRate);
  const uint32_t beatMs = beatAt(bPhi);
  // 稳不稳：速度差不多（±4%），而且拍点落在上一次预测的拍子上（±40 毫秒）
  if (sameTempo && gridDist(beatMs) <= 40u) {
    if (e.stable < 255) ++e.stable;
  } else {
    e.stable = 0;
  }
  _lastP = P;
  e.periodMs = periodMs;
  e.bpm = 60.f * kRate / (kHop * P);
  e.beatMs = beatMs;
  e.music = e.confidence >= kMusicConf && e.stable >= 4 && e.level >= kMinRms && _ler <= kMaxLowRatio;  // 连续 1.25 秒速度、拍点一致
}

}  // namespace beat
