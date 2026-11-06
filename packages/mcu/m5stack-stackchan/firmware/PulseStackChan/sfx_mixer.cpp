// 脉冲 Pulse · 混音器（原创代码，不依赖硬件）
#include "sfx_mixer.h"
#include <string.h>

namespace sfx {

namespace {
int16_t kUlaw[256];
bool kUlawReady = false;

void initUlaw() {
  if (kUlawReady) return;
  for (int i = 0; i < 256; i++) {  // G.711 μ-law 解码
    const int u = (~i) & 0xFF;
    const int sign = u & 0x80, exp = (u >> 4) & 7, man = u & 0x0F;
    int s = (((man << 3) + 0x84) << exp) - 0x84;
    kUlaw[i] = (int16_t)(sign ? -s : s);
  }
  kUlawReady = true;
}
}  // namespace

Mixer::Mixer() {
  initUlaw();
  memset(_v, 0, sizeof(_v));
}

void Mixer::fadeAll() {
  for (Voice& v : _v)
    if (v.on && (v.fade == 0 || v.fade > kFade)) v.fade = kFade;
}

void Mixer::playClip(uint8_t clip, float gain, float rate, bool cut) {
  if (cut) {
    fadeAll();
    _syn.stop();
  }
  if (clip == 0 || clip >= C_COUNT || !kClips[clip].data || kClips[clip].samples < 2 || gain <= 0.f) return;
  if (rate < .25f) rate = .25f;
  if (rate > 4.f) rate = 4.f;
  // 找空闲的声部；都在用就顶掉最早的那个
  Voice* slot = nullptr;
  for (Voice& v : _v)
    if (!v.on) { slot = &v; break; }
  if (!slot) {
    slot = &_v[0];
    for (Voice& v : _v)
      if (v.serial < slot->serial) slot = &v;
  }
  slot->data = kClips[clip].data;
  slot->len = kClips[clip].samples;
  slot->pos = 0;
  slot->frac = 0;
  slot->step = (uint32_t)(rate * (float)kClipRate / (float)kRate * 65536.f + .5f);
  slot->gain = (int32_t)(gain * 4096.f);
  slot->fade = 0;
  slot->serial = ++_serial;
  slot->on = true;
}

void Mixer::playSynth(uint8_t sound, bool replace, uint32_t seed) {
  if (replace) fadeAll();
  _syn.play(sound, replace, seed);
}

void Mixer::stopClips() { fadeAll(); }

void Mixer::stopAll() {
  fadeAll();
  _syn.stop();
}

bool Mixer::busy() const {
  for (const Voice& v : _v)
    if (v.on) return true;
  return _syn.busy();
}

int Mixer::activeClips() const {
  int n = 0;
  for (const Voice& v : _v)
    if (v.on && v.fade == 0) n++;
  return n;
}

void Mixer::render(int16_t* out, int n) {
  if (n > kMaxN) n = kMaxN;
  _syn.render(out, n);
  for (int i = 0; i < n; i++) _acc[i] = out[i];
  for (Voice& v : _v) {
    if (!v.on) continue;
    const uint8_t* d = v.data;
    const uint32_t len = v.len;
    for (int i = 0; i < n; i++) {
      const int32_t s0 = kUlaw[d[v.pos]];
      const int32_t s1 = v.pos + 1 < len ? kUlaw[d[v.pos + 1]] : 0;
      const int32_t s = s0 + (((s1 - s0) * (int32_t)(v.frac >> 1)) >> 15);
      int32_t g = v.gain;
      if (v.fade > 0) {
        g = (int32_t)((int64_t)g * v.fade / kFade);
        if (--v.fade == 0) { v.on = false; break; }
      }
      _acc[i] += (s * g) >> 12;
      v.frac += v.step;
      v.pos += v.frac >> 16;
      v.frac &= 0xFFFF;
      if (v.pos >= len) { v.on = false; break; }
    }
  }
  // 总音量 + 软限幅（几个声音叠在一起时不会刺耳地削波）
  for (int i = 0; i < n; i++) {
    int32_t x = (int32_t)(((int64_t)_acc[i] * _master) >> 12);
    const int32_t a = x < 0 ? -x : x;
    if (a > 20000) {
      int32_t y = 20000 + ((a - 20000) >> 1);
      if (y > 32000) y = 32000;
      x = x < 0 ? -y : y;
    }
    out[i] = (int16_t)x;
  }
}

}  // namespace sfx
