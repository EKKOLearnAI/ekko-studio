// 2.9 活泼版：听节拍（beat::Tracker）宿主测试
// 合成音乐（底鼓 / 军鼓 / 踩镲 / 贝斯 / 和弦 + 底噪）、说话、白噪声、安静、随机敲击，看能不能分清、速度和拍点准不准
#include "beat.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vector>

using beat::Estimate;
using beat::Tracker;

static const float kPi = 3.14159265f;
static uint32_t s_seed = 12345;
static float frand() {  // 0–1
  s_seed = s_seed * 1664525u + 1013904223u;
  return (float)((s_seed >> 8) & 0xFFFFFF) / 16777216.f;
}
static float gauss() {
  float s = 0;
  for (int i = 0; i < 6; ++i) s += frand();
  return (s - 3.f) * 1.41f;
}

struct Clip {
  std::vector<float> x;
  explicit Clip(float sec) : x((size_t)(sec * beat::kRate), 0.f) {}
  size_t n() const { return x.size(); }
  void add(size_t at, float v) { if (at < x.size()) x[at] += v; }
};

static void kick(Clip& c, float t0, float amp) {
  const size_t s0 = (size_t)(t0 * beat::kRate);
  float ph = 0;
  for (int i = 0; i < 4000; ++i) {
    const float t = i / (float)beat::kRate;
    const float f = 50.f + 110.f * expf(-t / .02f);
    ph += 2 * kPi * f / beat::kRate;
    c.add(s0 + i, amp * sinf(ph) * expf(-t / .12f));
  }
}
static void snare(Clip& c, float t0, float amp) {
  const size_t s0 = (size_t)(t0 * beat::kRate);
  for (int i = 0; i < 2400; ++i) {
    const float t = i / (float)beat::kRate;
    c.add(s0 + i, amp * (gauss() * .6f * expf(-t / .06f) + .7f * sinf(2 * kPi * 185.f * t) * expf(-t / .05f)));
  }
}
static void hat(Clip& c, float t0, float amp) {
  const size_t s0 = (size_t)(t0 * beat::kRate);
  float prev = 0;
  for (int i = 0; i < 800; ++i) {
    const float t = i / (float)beat::kRate;
    const float w = gauss();
    c.add(s0 + i, amp * (w - prev) * .5f * expf(-t / .015f));
    prev = w;
  }
}
static void tone(Clip& c, float t0, float dur, float f, float amp, float attack = .01f) {
  const size_t s0 = (size_t)(t0 * beat::kRate);
  const int n = (int)(dur * beat::kRate);
  for (int i = 0; i < n; ++i) {
    const float t = i / (float)beat::kRate;
    float env = t < attack ? t / attack : 1.f;
    const float rel = dur - t;
    if (rel < .03f) env *= rel / .03f;
    c.add(s0 + i, amp * env * sinf(2 * kPi * f * t));
  }
}
static void noise(Clip& c, float rms) {
  for (size_t i = 0; i < c.n(); ++i) c.x[i] += rms * gauss();
}

// 房间回声（Schroeder 混响，RT60 ≈ rt 秒）
static void reverb(Clip& c, float rt, float wet) {
  const float delays[4] = {.0297f, .0371f, .0411f, .0437f};
  std::vector<float> out(c.n(), 0.f);
  for (float dsec : delays) {
    const size_t d = (size_t)(dsec * beat::kRate);
    const float g = powf(10.f, -3.f * dsec / rt);
    std::vector<float> y(c.n(), 0.f);
    for (size_t i = 0; i < c.n(); ++i) y[i] = c.x[i] + (i >= d ? g * y[i - d] : 0.f);
    for (size_t i = 0; i < c.n(); ++i) out[i] += y[i] * .25f;
  }
  for (size_t i = 0; i < c.n(); ++i) c.x[i] = (1.f - wet) * c.x[i] + wet * out[i];
}
// 手机小喇叭：没有低音（一阶高通 ≈ fc）
static void tinySpeaker(Clip& c, float fc) {
  const float a = expf(-2 * kPi * fc / beat::kRate);
  float px = 0, py = 0;
  for (size_t i = 0; i < c.n(); ++i) {
    const float y = a * (py + c.x[i] - px);
    px = c.x[i];
    py = y;
    c.x[i] = y;
  }
  for (size_t i = 0; i < c.n(); ++i) {  // 再来一次，更陡
    const float y = a * (py + c.x[i] - px);
    px = c.x[i];
    py = y;
    c.x[i] = y;
  }
}

// 一首「歌」：拍子从 t0 开始。pattern 0 = 每拍底鼓（舞曲），1 = 1/3 拍底鼓、2/4 拍军鼓（摇滚）
static Clip song(float bpm, float sec, float t0, int pattern = 0, float gain = 1.f, float swingHat = 0.f) {
  Clip c(sec);
  const float T = 60.f / bpm;
  const float roots[4] = {55.f, 65.4f, 73.4f, 49.f};
  for (int k = 0; t0 + k * T < sec; ++k) {
    const float t = t0 + k * T;
    if (pattern == 0 || k % 2 == 0) kick(c, t, 9000.f * gain);
    if (k % 2 == 1) snare(c, t, 3800.f * gain);
    hat(c, t, 1400.f * gain);
    hat(c, t + T * (.5f + swingHat), 1000.f * gain);
    tone(c, t, T * .9f, roots[(k / 8) % 4], 2200.f * gain, .015f);
  }
  // 和弦（一直在响，每两小节换）
  const float chords[4][3] = {{220.f, 277.f, 330.f}, {196.f, 247.f, 294.f}, {175.f, 220.f, 262.f}, {196.f, 247.f, 311.f}};
  for (int b = 0; b * 8 * T < sec; ++b)
    for (int j = 0; j < 3; ++j) tone(c, b * 8 * T, 8 * T, chords[b % 4][j], 700.f * gain, .2f);
  noise(c, 50.f);
  return c;
}

static Clip speech(float sec) {
  Clip c(sec);
  float t = .2f;
  int inPhrase = 0, phraseLen = 4 + (int)(frand() * 7);
  while (t < sec - .5f) {
    if (frand() < .5f) {  // 辅音
      const float d = .03f + .03f * frand(), a = 500.f + 2000.f * frand();
      const size_t s0 = (size_t)(t * beat::kRate);
      float prev = 0;
      for (int i = 0; i < (int)(d * beat::kRate); ++i) {
        const float w = gauss();
        c.add(s0 + i, a * (w - .5f * prev));
        prev = w;
      }
      t += d;
    }
    const float dur = .12f + .2f * frand(), f0 = 110.f + 120.f * frand(), amp = 1500.f + 4500.f * frand();
    const size_t s0 = (size_t)(t * beat::kRate);
    const int n = (int)(dur * beat::kRate);
    float ph = 0;
    for (int i = 0; i < n; ++i) {
      const float u = i / (float)n;
      const float f = f0 * (1.f + .15f * (u - .5f));
      ph += 2 * kPi * f / beat::kRate;
      float v = 0;
      for (int h = 1; h <= 12 && h * f < 7500.f; ++h) v += sinf(h * ph) / h;
      c.add(s0 + i, amp * powf(sinf(kPi * u), .7f) * v * .6f);
    }
    t += dur + .04f + .21f * frand();
    if (++inPhrase >= phraseLen) {
      inPhrase = 0;
      phraseLen = 4 + (int)(frand() * 7);
      t += .3f + .6f * frand();
    }
  }
  noise(c, 50.f);
  return c;
}

static Clip clicks(float sec) {
  Clip c(sec);
  float t = .1f;
  while (t < sec) {
    if (frand() < .5f) kick(c, t, 7000.f);
    else hat(c, t, 6000.f);
    t += -logf(1.f - frand() * .999f) * .35f + .05f;
  }
  noise(c, 50.f);
  return c;
}

// 按 20 毫秒一段喂进去（和机器上一样）；every 每次分析后回调
template <class F>
static void run(Tracker& tr, const Clip& c, uint32_t base, F every) {
  std::vector<int16_t> pcm(320);
  uint16_t seen = tr.estimate().analyses;
  for (size_t at = 0; at + 320 <= c.n(); at += 320) {
    for (int i = 0; i < 320; ++i) {
      float v = c.x[at + i];
      if (v > 32767.f) v = 32767.f;
      if (v < -32768.f) v = -32768.f;
      pcm[i] = (int16_t)lrintf(v);
    }
    const uint32_t now = base + (uint32_t)(((at + 319) * 1000u) / beat::kRate);
    tr.feed(pcm.data(), 320, now);
    if (tr.estimate().analyses != seen) {
      seen = tr.estimate().analyses;
      every(tr.estimate(), now);
    }
  }
}

static float phaseErrMs(const Estimate& e, uint32_t base, float t0, float bpm) {
  const float T = 60000.f / bpm;
  float d = fmodf((float)(int32_t)(e.beatMs - base) - t0 * 1000.f, T);
  if (d < 0) d += T;
  return d < T - d ? d : T - d;
}

static int s_fail = 0;
#define CHECK(c, ...) do { if (!(c)) { printf("  FAIL %s:%d: %s · ", __FILE__, __LINE__, #c); printf(__VA_ARGS__); printf("\n"); ++s_fail; } } while (0)

static void testSong(float bpm, int pattern, const char* name, float swing = 0.f, int room = 0) {
  Tracker tr;
  const uint32_t base = 500000;
  const float t0 = .137f;
  Clip c = song(bpm, 9.f, t0, pattern, room ? .35f : 1.f, swing);
  if (room & 1) reverb(c, .6f, .5f);
  if (room & 2) tinySpeaker(c, 350.f);
  if (room) noise(c, 60.f);
  int firstMusic = -1;
  int lastOk = 0, total = 0;
  run(tr, c, base, [&](const Estimate& e, uint32_t now) {
    ++total;
    if (e.music && firstMusic < 0) firstMusic = (int)(now - base);
    if (e.music) ++lastOk;
  });
  const Estimate& e = tr.estimate();
  const float perr = phaseErrMs(e, base, t0, bpm);
  printf("  %-22s bpm %.1f (真 %.0f) conf %.2f ac %.2f stable %u level %.0f 相位误差 %.0f ms 首次判定 %d ms 判定次数 %d/%d\n", name, e.bpm, bpm,
         e.confidence, tr.lastAutocorr(), e.stable, e.level, perr, firstMusic, lastOk, total);
  CHECK(e.music, "%s 应该判定为音乐", name);
  CHECK(fabsf(e.bpm - bpm) <= .03f * bpm, "%s bpm %.1f", name, e.bpm);
  CHECK(perr <= 40.f, "%s 相位误差 %.0f", name, perr);
  CHECK(firstMusic > 0 && firstMusic <= 4000, "%s 判定太慢 %d", name, firstMusic);
  // 预测：nextBeat 落在真拍点附近
  const uint32_t now = base + 9000;
  const uint32_t nb = beat::nextBeat(e, now);
  CHECK(nb >= now && nb - now <= e.periodMs, "nextBeat");
  const float T = 60000.f / bpm;
  float d = fmodf((float)(nb - base) - t0 * 1000.f, T);
  if (d < 0) d += T;
  if (d > T / 2) d = T - d;
  CHECK(d <= 45.f, "%s 预测下一拍误差 %.0f", name, d);
}

template <class Gen>
static void testNotMusic(const char* name, Gen gen) {
  Tracker tr;
  const uint32_t base = 100;
  Clip c = gen();
  int hits = 0, total = 0;
  float maxConf = 0, maxAc = -1;
  run(tr, c, base, [&](const Estimate& e, uint32_t) {
    ++total;
    if (e.music) ++hits;
    if (e.frames >= beat::kMinFrames) {
      if (e.confidence > maxConf) maxConf = e.confidence;
      if (tr.lastAutocorr() > maxAc) maxAc = tr.lastAutocorr();
    }
  });
  printf("  %-22s 判定为音乐 %d/%d 次 · 最高 conf %.2f ac %.2f level %.0f\n", name, hits, total, maxConf, maxAc, tr.estimate().level);
  CHECK(hits == 0, "%s 不应该判定为音乐（%d 次）", name, hits);
}

int main() {
  printf("== 音乐：速度和拍点\n");
  testSong(120.f, 0, "舞曲 120");
  testSong(90.f, 0, "舞曲 90");
  testSong(150.f, 0, "舞曲 150");
  testSong(100.f, 1, "摇滚 100");
  testSong(76.f, 1, "慢歌 76");
  testSong(128.f, 1, "摇滚 128");
  testSong(110.f, 0, "带摇摆 110", .1f);
  testSong(120.f, 0, "房间回声 120", 0.f, 1);
  testSong(100.f, 1, "房间回声 100", 0.f, 1);
  testSong(120.f, 0, "手机外放 120", 0.f, 2);
  testSong(92.f, 1, "手机外放 + 回声 92", 0.f, 3);
  testSong(136.f, 0, "手机外放 + 回声 136", 0.f, 3);
  for (int s = 0; s < 6; ++s) {  // 不同随机底噪 / 起点
    s_seed = 777 + s * 31;
    char name[32];
    snprintf(name, sizeof name, "舞曲 %d（随机 %d）", 96 + s * 9, s);
    testSong(96.f + s * 9.f, s % 2, name);
  }

  printf("== 不是音乐\n");
  for (int k = 0; k < 8; ++k) {
    s_seed = 4242 + k * 977;
    char name[32];
    snprintf(name, sizeof name, "说话 %d", k + 1);
    testNotMusic(name, [] { return speech(12.f); });
  }
  testNotMusic("白噪声", [] { Clip c(8.f); noise(c, 2000.f); return c; });
  testNotMusic("很安静", [] { Clip c(8.f); noise(c, 5.f); return c; });
  testNotMusic("完全没声音", [] { return Clip(8.f); });
  for (int k = 0; k < 8; ++k) {
    s_seed = 5 + k * 131;
    char name[32];
    snprintf(name, sizeof name, "随机敲击 %d", k + 1);
    testNotMusic(name, [] { return clicks(12.f); });
  }
  testNotMusic("很小声的歌", [] { return song(120.f, 8.f, .1f, 0, .008f); });

  printf("== 歌停了\n");
  {
    Tracker tr;
    const uint32_t base = 1000;
    Clip c = song(120.f, 6.f, .05f);
    Clip quiet(4.f);
    noise(quiet, 5.f);
    c.x.insert(c.x.end(), quiet.x.begin(), quiet.x.end());
    int lastMusic = -1;
    run(tr, c, base, [&](const Estimate& e, uint32_t now) {
      if (e.music) lastMusic = (int)(now - base);
    });
    printf("  6 秒停 → 最后一次判定为音乐在 %d ms\n", lastMusic);
    CHECK(lastMusic >= 5000 && lastMusic <= 7500, "停了以后应该很快不算音乐（%d）", lastMusic);
    CHECK(!tr.estimate().music, "最后不算音乐");
  }

  printf("== 换歌（120 → 96）\n");
  {
    Tracker tr;
    const uint32_t base = 1000;
    Clip a = song(120.f, 8.f, .05f), b = song(96.f, 10.f, .21f);
    const size_t join = a.n();
    a.x.insert(a.x.end(), b.x.begin(), b.x.end());
    int lock = -1;
    run(tr, a, base, [&](const Estimate& e, uint32_t now) {
      const int t = (int)(now - base);
      if (t > 8000 && lock < 0 && e.music && fabsf(e.bpm - 96.f) <= 3.f) lock = t - 8000;
    });
    printf("  换歌后 %d ms 跟上新速度（最后 bpm %.1f）\n", lock, tr.estimate().bpm);
    CHECK(lock > 0 && lock <= 6500, "换歌后应该能跟上（%d）", lock);
    (void)join;
  }

  printf("== reset / 辅助函数\n");
  {
    Tracker tr;
    Clip c = song(120.f, 5.f, 0.f);
    run(tr, c, 0, [](const Estimate&, uint32_t) {});
    CHECK(tr.estimate().analyses > 0, "分析过");
    tr.reset();
    CHECK(tr.estimate().analyses == 0 && !tr.estimate().music && tr.hops() == 0, "reset 清空");
    Estimate e;
    e.periodMs = 500;
    e.beatMs = 10000;
    CHECK(beat::nextBeat(e, 10000) == 10000, "正好在拍上");
    CHECK(beat::nextBeat(e, 10001) == 10500, "下一拍");
    CHECK(beat::nextBeat(e, 9000) == 10000, "还没到");
    CHECK(fabsf(beat::beatPhase(e, 11250) - 2.5f) < 1e-4f, "相位");
    CHECK(fabsf(beat::beatPhase(e, 9750) + .5f) < 1e-4f, "负相位");
    Estimate z;
    CHECK(beat::nextBeat(z, 1234) == 1234 && beat::beatPhase(z, 1234) == 0.f, "没节拍");
    // 不是 320 的整数倍也行
    Tracker t2;
    std::vector<int16_t> odd(77, 1000);
    for (int i = 0; i < 400; ++i) t2.feed(odd.data(), odd.size(), (uint32_t)i * 5);
    CHECK(t2.hops() == 400u * 77u / 160u, "帧数 %u", t2.hops());
    t2.feed(nullptr, 10, 0);
  }

  if (s_fail) {
    printf("== test_beat: %d 处失败\n", s_fail);
    return 1;
  }
  printf("== test_beat: 全部通过\n");
  return 0;
}
