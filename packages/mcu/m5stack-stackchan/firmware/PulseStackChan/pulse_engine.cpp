// 脉冲 Pulse · 表情引擎（原创代码）
// 性能：Arduino 框架在 platformio.ini 的 -O2 之后又追加 -Os，实际生效的是 -Os，
// 导致 sqrtf/fminf/floorf 和一行的小函数都变成函数调用、浮点除法走软件 __divsf3。
// 这里只对渲染引擎恢复 -O2，并允许 sqrtf 直接用 FPU 指令（不设置 errno）、
// 除法用硬件倒数近似（误差在 1ulp 量级，对 8 位颜色/覆盖率无可见影响）。
#pragma GCC optimize("O2", "no-math-errno", "reciprocal-math", "no-trapping-math")
#include "pulse_engine.h"
#include "fx_shapes.h"
#include "config.h"
#include <math.h>
#include <string.h>
#include <esp_heap_caps.h>
#include <esp_system.h>
#include <esp_cpu.h>

// 工具链（xtensa GCC 8.4）即使在 -O2 下也不会把 sqrtf/fminf/fmaxf/floorf/ceilf 内联成 FPU 指令，
// 每像素都要走一次 newlib 软件实现。渲染只需要 8 位精度，这里换成内联版本：
//   sqrt：倒数平方根 + 两次牛顿迭代，相对误差约 5e-6；
//   min/max/floor/ceil：渲染里的坐标都远小于 2^31，且不会出现 NaN。
namespace {
inline float pe_sqrtf(float x) {
  if (!(x > 0.f)) return 0.f;
  union { float f; uint32_t i; } u{x};
  u.i = 0x5F375A86u - (u.i >> 1);
  float y = u.f;
  const float hx = .5f * x;
  y = y * (1.5f - hx * y * y);
  y = y * (1.5f - hx * y * y);
  return x * y;
}
inline float pe_fminf(float a, float b) { return a < b ? a : b; }
inline float pe_fmaxf(float a, float b) { return a > b ? a : b; }
inline float pe_floorf(float x) { const int i = (int)x; return (float)(x < (float)i ? i - 1 : i); }
inline float pe_ceilf(float x) { const int i = (int)x; return (float)(x > (float)i ? i + 1 : i); }
// 只给逐像素的腮红柔边用：2^x = 2^整数 × 多项式(小数)，相对误差约 2e-5；输入范围 [-20, 20]
inline float pe_expf(float x) {
  float t = x * 1.44269504f;
  if (t < -20.f) t = -20.f;
  if (t > 20.f) t = 20.f;
  const int i = (int)(t < 0.f ? t - 1.f : t);
  const float f = t - (float)i;
  const float p = 1.f + f * (.69314718f + f * (.24022651f + f * (.05550411f + f * (.00961813f + f * .00133336f))));
  union { float f; uint32_t u; } v{p};
  v.u += (uint32_t)i << 23;
  return v.f;
}
}  // namespace
inline long pe_lrintf(float v) { return (long)(v >= 0.f ? v + .5f : v - .5f); }
#define sqrtf(x) pe_sqrtf(x)
#define lrintf(x) pe_lrintf(x)
#define fminf(a, b) pe_fminf((a), (b))
#define fmaxf(a, b) pe_fmaxf((a), (b))
#define floorf(x) pe_floorf(x)
#define ceilf(x) pe_ceilf(x)

namespace pulse {

static constexpr float TAU_F = 6.28318530718f;
static constexpr float PI_F = 3.14159265359f;
static constexpr float CX = 120.f, CY = 120.f, RB = 72.f, GAP = 9.f, EX0 = 4.2f;
static constexpr int K_SPIKES = 26;

static const float kDefaults[P_COUNT] = {
#define PULSE_X(n, d) (float)(d),
  PULSE_PARAMS(PULSE_X)
#undef PULSE_X
};

#include "pulse_states.h"

int stateCount() { return kStateCount; }
const StateDef& stateDef(int i) { return kStates[(i % kStateCount + kStateCount) % kStateCount]; }
int findState(const char* s) {
  if (!s || !*s) return -1;
  char id[3] = {0};
  if (s[0] >= '0' && s[0] <= '9') {
    if (s[1] == 0) { id[0] = '0'; id[1] = s[0]; }
    else if (s[1] >= '0' && s[1] <= '9' && s[2] == 0) { id[0] = s[0]; id[1] = s[1]; }
  }
  for (int i = 0; i < kStateCount; i++) {
    if (id[0] && strcmp(kStates[i].id, id) == 0) return i;
    if (strcmp(kStates[i].name, s) == 0) return i;
  }
  return -1;
}

static inline float clampf(float v, float a, float b) { return v < a ? a : (v > b ? b : v); }
static inline float clamp01(float v) { return clampf(v, 0.f, 1.f); }
static inline float gaussf(float x, float s) { return expf(-(x * x) / (2.f * s * s)); }
static inline float angDist(float a, float b) {
  float d = fmodf(a - b, TAU_F);
  if (d > PI_F) d -= TAU_F; else if (d < -PI_F) d += TAU_F;
  return d;
}
static inline float bumpf(float u, float a, float b) { return (u >= a && u <= b) ? sinf(PI_F * (u - a) / (b - a)) : 0.f; }
static inline float easeIO(float u) { return u < .5f ? 2.f * u * u : 1.f - (-2.f * u + 2.f) * (-2.f * u + 2.f) / 2.f; }
static inline float ecgShape(float d) {
  return .18f * gaussf(d - .3f, .06f) - .3f * gaussf(d - .075f, .028f) + gaussf(d, .03f) - .45f * gaussf(d + .065f, .03f) + .25f * gaussf(d + .3f, .08f);
}
static inline float frand() { return (float)(esp_random() & 0xFFFFFF) / 16777215.f; }
static inline float wrap01(float v) { v = fmodf(v, 1.f); return v < 0 ? v + 1.f : v; }

Engine::RGB Engine::rgbHex(uint32_t c) { return {float((c >> 16) & 255), float((c >> 8) & 255), float(c & 255)}; }
Engine::RGB Engine::mixc(const RGB& a, const RGB& b, float t) { return {a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t}; }
uint16_t Engine::to565sw(const RGB& c) {
  int r = (int)clampf(c.r, 0, 255), g = (int)clampf(c.g, 0, 255), b = (int)clampf(c.b, 0, 255);
  uint16_t v = (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
  return (uint16_t)((v >> 8) | (v << 8));  // 精灵缓冲区里是字节交换过的 RGB565
}
Engine::RGB Engine::from565sw(uint16_t s) {
  uint16_t v = (uint16_t)((s >> 8) | (s << 8));
  return {float(((v >> 11) & 31) * 255 / 31), float(((v >> 5) & 63) * 255 / 63), float((v & 31) * 255 / 31)};
}

static const uint32_t kBgTop = 0x15171C, kBgBottom = 0x08090B;

static const uint8_t kBayer4[16] = {0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5};
static inline uint16_t pack565sw(int r, int g, int b) {
  r = r < 0 ? 0 : (r > 255 ? 255 : r);
  g = g < 0 ? 0 : (g > 255 ? 255 : g);
  b = b < 0 ? 0 : (b > 255 ? 255 : b);
  const uint16_t v = (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
  return (uint16_t)((v >> 8) | (v << 8));
}
// 带有序抖动的打包，避免深色渐变出现色带
static inline uint16_t pack565swD(float r, float g, float b, int x, int y) {
  const int t = kBayer4[((y & 3) << 2) | (x & 3)];
  return pack565sw((int)(r + t * .5f), (int)(g + t * .25f), (int)(b + t * .5f));
}

static void* allocPref(size_t n, bool psramFirst) {
  void* p = nullptr;
  if (psramFirst && psramFound()) p = heap_caps_malloc(n, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!p) p = heap_caps_malloc(n, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  if (!p && psramFound()) p = heap_caps_malloc(n, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  return p;
}

// ---- 小图案（爱心 / ? / ! / Z / 音符 / 星星）：开机时生成 32×32 抗锯齿遮罩 + 一张模糊过的光晕遮罩 ----
static constexpr float FX_PAD = 1.3f;  // 遮罩方框 = 图案大小 × 1.3（留出光晕的位置）
// 形状本身在 fx_shapes.h（主机测试会把它们画出来检查）
static void buildFxMasks(uint8_t* core, uint8_t* glow, int M, int kinds) {
  for (int k = 0; k < kinds; k++) {
    uint8_t* C = core + k * M * M;
    for (int y = 0; y < M; y++)
      for (int x = 0; x < M; x++) {
        int n = 0;
        for (int sy = 0; sy < 4; sy++)
          for (int sx = 0; sx < 4; sx++) {
            const float u = ((x + (sx + .5f) * .25f) / M * 2.f - 1.f) * FX_PAD, v = ((y + (sy + .5f) * .25f) / M * 2.f - 1.f) * FX_PAD;
            n += fxshape::inside(k, u, v) ? 1 : 0;
          }
        C[y * M + x] = (uint8_t)(n * 255 / 16);
      }
    // 光晕 = 遮罩做两遍半径 2 的方框模糊（≈ 高斯）
    uint8_t* G = glow + k * M * M;
    uint16_t* tmp = (uint16_t*)malloc(sizeof(uint16_t) * M * M);
    if (!tmp) { memset(G, 0, M * M); continue; }
    memcpy(G, C, M * M);
    for (int pass = 0; pass < 2; pass++) {
      for (int y = 0; y < M; y++)
        for (int x = 0; x < M; x++) {
          int s = 0;
          for (int d = -2; d <= 2; d++) { const int xx = x + d; if (xx >= 0 && xx < M) s += G[y * M + xx]; }
          tmp[y * M + x] = (uint16_t)s;
        }
      for (int y = 0; y < M; y++)
        for (int x = 0; x < M; x++) {
          int s = 0;
          for (int d = -2; d <= 2; d++) { const int yy = y + d; if (yy >= 0 && yy < M) s += tmp[yy * M + x]; }
          G[y * M + x] = (uint8_t)(s / 25);
        }
    }
    free(tmp);
  }
}

bool Engine::begin(LovyanGFX* display) {
  cancelFrameCapture();
  _disp = display;
  _sw = display->width();
  _sh = display->height();
  _cw = _sw; _ch = _sh; _ox = 0; _oy = 0;
  _unit = (float)(_sw < _sh ? _sw : _sh) / 218.f;  // 每个设计单位多少像素
  _scx = _sw * .5f;
  _scy = _sh * .5f + 2.f;
  _bh = BAND_H < _ch ? BAND_H : _ch;

  // 两条条带缓冲放内部 RAM（可 DMA）：推屏的同时算下一条。不够就退回一条 / PSRAM
  _nBuf = 0;
  for (int k = 0; k < 2; k++) {
    _cvb[k].setColorDepth(16);
    _cvb[k].setPsram(false);
    if (_cvb[k].createSprite(_cw, _bh)) { _nBuf = k + 1; continue; }
    if (k == 0) {
      _cvb[0].setPsram(true);
      if (_cvb[0].createSprite(_cw, _bh)) _nBuf = 1;
    }
    break;
  }
  if (!_nBuf) return false;
  // These are CPU render scratch buffers, not DMA sources. Voice/networking
  // needs internal RAM for stacks, Wi-Fi and DMA; keep only scanline sprites
  // in internal RAM and put the larger scratch/history data in PSRAM.
  const bool externalScratch = PULSE_STUDIO_VOICE && psramFound();
  _cov = (uint8_t*)allocPref((size_t)_cw * _bh, false);  // 条带小了，覆盖率缓冲放内部 RAM（约 7.7KB）
  if (!_geo) {
    const size_t stride = N + 2;
    _geo = (float*)allocPref(sizeof(float) * stride * 12, false);
    if (!_geo) return false;
    float* g = _geo;
    _px = g; g += stride; _py = g; g += stride;
    _bodyX = g; g += stride; _bodyY = g; g += stride;
    _qx = g; g += stride; _qy = g; g += stride; _ux = g; g += stride; _uy = g; g += stride;
    _cs = g; g += stride; _sn = g; g += stride; _rr = g; g += stride; _rb = g;
    memset(_geo, 0, sizeof(float) * stride * 12);
  }
  // 扫描线交点只需当前条带的行（按条带内行号索引），约 2KB，和每行范围、背景抖动表一起放内部 RAM：
  // 这些在每个条带里被大量随机读写，放 PSRAM 时会被相机帧冲掉缓存。
  _xc = (int16_t*)allocPref(sizeof(int16_t) * _bh * XCAP, false);
  _xn = (uint8_t*)allocPref(_bh, false);
  _rmin = (int16_t*)allocPref(sizeof(int16_t) * _ch, false);
  _rmax = (int16_t*)allocPref(sizeof(int16_t) * _ch, false);
  _bg = (RGB*)allocPref(sizeof(RGB) * _ch, externalScratch);
  _bgsw = (uint16_t*)allocPref(sizeof(uint16_t) * _ch * 4, false);
  for (int i = 0; i < 2; i++) {
    _eyeA[i] = (uint8_t*)allocPref(EYE_BUF * EYE_BUF, externalScratch);
    _eyeT[i] = (uint8_t*)allocPref(EYE_BUF * EYE_BUF, externalScratch);
    if (!_eyeA[i] || !_eyeT[i]) return false;
  }
  if (!_cov || !_xc || !_xn || !_rmin || !_rmax || !_bg || !_bgsw) return false;
  // 光晕单次扫描用的缓冲；分配失败就走原来的逐层实现
  if (!_glowKey) _glowKey = (int32_t*)allocPref(sizeof(int32_t) * _ch * GLOW_CAP, true);
  if (!_glowCnt) _glowCnt = (uint8_t*)allocPref(_ch, false);
  if (!_glowCnt) _glowKey = nullptr;
  if (!_bodyCache) {
    _bodyCache = (int16_t*)allocPref(sizeof(int16_t) * _cw * 4, false);  // 列戳 + R2/G4/B2，约 2.5KB
    if (_bodyCache) for (int x = 0; x < _cw; x++) _bodyCache[x] = -32768;
  }
  memset(_cov, 0, (size_t)_cw * _bh);
  memset(_xn, 0, _bh);
  for (int y = 0; y < _ch; y++) { _rmin[y] = 32767; _rmax[y] = -1; }
  _cy0 = _ch; _cy1 = -1;
  const RGB top = rgbHex(kBgTop), bot = rgbHex(kBgBottom);
  for (int y = 0; y < _ch; y++) {
    _bg[y] = mixc(top, bot, (float)y / (float)(_ch - 1));
    for (int k = 0; k < 4; k++) _bgsw[y * 4 + k] = pack565swD(_bg[y].r, _bg[y].g, _bg[y].b, k, y);
  }
  for (int j = 0; j < N; j++) {
    float a = (float)j / N * TAU_F;
    _th[j] = a; _cs[j] = cosf(a); _sn[j] = sinf(a);
  }
  memcpy(_c, kDefaults, sizeof(_c));
  memcpy(_g, kDefaults, sizeof(_g));
  if (!_fxMask) {  // 2.8：13 种图案约 26 KB；内存不够先退回 6 种（新图案换成相近的旧图案），再不够就不画小图案
    _fxKinds = FX_KINDS;
    _fxMask = (uint8_t*)allocPref((size_t)FX_KINDS * FXM * FXM * 2, externalScratch);
    if (!_fxMask) {
      _fxKinds = FX_LEGACY_KINDS;
      _fxMask = (uint8_t*)allocPref((size_t)FX_LEGACY_KINDS * FXM * FXM * 2, externalScratch);
    }
    if (_fxMask) buildFxMasks(_fxMask, _fxMask + _fxKinds * FXM * FXM, FXM, _fxKinds);
    else _fxKinds = 0;
  }
  _nFx = 0;
  repaintOutside();
  setState(2, true);
  return true;
}

// 下一帧把整屏都重画并推送一次
void Engine::repaintOutside() {
  _pbx0 = 0; _pby0 = 0; _pbx1 = _cw - 1; _pby1 = _ch - 1;
}

void Engine::applyDef(const StateDef& d, float* out) {
  memcpy(out, kDefaults, sizeof(float) * P_COUNT);
  for (int i = 0; i < d.nkv; i++) out[d.kv[i].k] = d.kv[i].v;
}

void Engine::setState(int idx, bool instant) {
  if (idx < 0 || idx >= kStateCount) return;
  const StateDef& d = kStates[idx];
  int prev = _state;
  _state = idx;
  applyDef(d, _g);
  _tcol = rgbHex(d.color);
  _ease = d.ease > 0 ? d.ease : 6.5f;
  if (instant) {
    memcpy(_c, _g, sizeof(_c));
    _col = _tcol;
  } else if (d.from >= 0 && prev != idx) {
    applyDef(kStates[d.from], _c);
    _col = rgbHex(kStates[d.from].color);
  }
  _nImps = 0;
  _ecgN = d.ecgN ? d.ecgN : 1;
  _ecgCnt = (int)floorf((_ecgPh + 1.5708f) * _ecgN / TAU_F) % (64 * _ecgN);
  _everyT = _t + (d.everyImp ? d.everyPeriod * .7f : 0.f);
  _ringT = _t + .35f;
  _inT = _t + .1f;
  if (!instant)
    for (int i = 0; i < 3; i++)
      if (d.enter[i]) fire(d.enter[i]);
}

static float impDur(uint8_t t) {
  switch (t) {
    case I_HOP: return .62f;
    case I_SHAKE: return .9f;
    case I_NOD: return .95f;
    case I_STRETCH: return 1.5f;
    case I_SIGH: return 1.6f;
    case I_FLASH: return .7f;
    case I_BURST: return .9f;
    case I_JOLT: return 1.f;
    case I_DRAW: return 1.9f;
    case I_STOP: return .6f;
    default: return .8f;
  }
}

void Engine::fire(uint8_t type, float delay) {
  if (type == I_RING || type == I_RING2) {
    addRing(false, delay);
    if (type == I_RING2) addRing(false, delay + .18f);
    return;
  }
  if (type == I_INRING) { addRing(true, delay); return; }
  if (_nImps >= 8) { memmove(_imps, _imps + 1, sizeof(ImpRun) * 7); _nImps = 7; }
  _imps[_nImps++] = {type, _t + delay, impDur(type)};
}

void Engine::addRing(bool inward, float delay) {
  if (_nRings >= 4) { memmove(_rings, _rings + 1, sizeof(Ring) * 3); _nRings = 3; }
  _rings[_nRings++] = {_t + delay, inward ? 1.1f : 1.25f, inward};
}

void Engine::pulse() {
  addRing(false);
  addRing(false, .17f);
  fire(I_FLASH);
  fire(I_HOP);
}

void Engine::setPointer(bool active, float sx, float sy) { _ptrOn = active; _ptrX = sx; _ptrY = sy; }

void Engine::setLabel(const char* text, uint32_t ms) {
  if (!_labelsEnabled) return;
  strncpy(_label, text ? text : "", sizeof(_label) - 1);
  _label[sizeof(_label) - 1] = 0;
  _labelStart = millis();
  _labelMs = ms;
}

void Engine::setLabelsEnabled(bool enabled) {
  if (_labelsEnabled == enabled && (enabled || !_label[0])) return;
  _labelsEnabled = enabled;
  if (!enabled) {
    _label[0] = 0;
    _labelStart = _labelMs = 0;
    _lblOn = false;
    repaintOutside(); // Also erase label pixels already present on the panel.
  }
}

bool Engine::requestFrameCapture(uint16_t* pixels, size_t pixelCount) {
  if (!_nBuf || !pixels || _captureState || _sw <= 0 || _sh <= 0 ||
      _cw != _sw || _ch != _sh || _ox || _oy ||
      (reinterpret_cast<uintptr_t>(pixels) & (alignof(uint16_t) - 1))) return false;
  const size_t required = static_cast<size_t>(_sw) * static_cast<size_t>(_sh);
  if (pixelCount < required) return false;
  _capturePixels = pixels;
  _capturePixelCount = required;
  _captureState = 1;
  return true;
}

bool Engine::takeFrameCapture(uint16_t*& pixels, size_t& pixelCount) {
  if (!frameCaptureReady()) return false;
  pixels = _capturePixels;
  pixelCount = _capturePixelCount;
  cancelFrameCapture();
  return true;
}

void Engine::cancelFrameCapture() {
  _captureState = 0;
  _capturePixels = nullptr;
  _capturePixelCount = 0;
}

void Engine::emit(uint8_t fx, int n) {
  if (!_fxMask || fx >= FX_KINDS) return;
  if (fx >= _fxKinds) {  // 内存紧：新图案换成相近的旧图案
    static const uint8_t kFallback[FX_KINDS - FX_LEGACY_KINDS] = {FX_SPARK, FX_HEART, FX_Z, FX_NOTE, FX_SPARK, FX_HEART, FX_EXCLAIM};
    fx = kFallback[fx - FX_LEGACY_KINDS];
    if (fx >= _fxKinds) return;
  }
  if (n < 1) n = 1;
  if (n > 8) n = 8;
  const float side0 = frand() < .5f ? -1.f : 1.f;
  for (int k = 0; k < n; k++) {
    if (_nFx >= FXN) { memmove(_fx, _fx + 1, sizeof(FxP) * (FXN - 1)); _nFx = FXN - 1; }
    FxP p{};
    p.kind = fx;
    p.t0 = _t + k * .18f;
    p.ph = frand() * TAU_F;
    const float side = (k & 1) ? -side0 : side0;
    switch (fx) {
      case FX_HEART:  // 两侧往上飘
        p.x = CX + side * (100.f + frand() * 18.f); p.y = CY + 18.f + frand() * 22.f;
        p.vx = side * (2.f + frand() * 4.f); p.vy = -(46.f + frand() * 14.f);
        p.size = 24.f + frand() * 7.f; p.life = 1.75f; p.col = frand() < .5f ? 0xFF5C8A : 0xFF86BE;
        break;
      case FX_QUESTION:  // 右上角冒出来
        p.x = CX + 94.f + k * 24.f; p.y = CY - 60.f - k * 20.f; p.vy = -5.f;
        p.size = 38.f - k * 9.f; p.life = 1.9f; p.col = 0xCDBDFF; p.t0 = _t + k * .26f;
        break;
      case FX_EXCLAIM:
        p.x = (k & 1) ? CX - 94.f : CX + 94.f; p.y = CY - 62.f; p.vy = -6.f;
        p.size = 40.f; p.life = 1.35f; p.col = 0xFFE45C; p.t0 = _t + k * .1f;
        break;
      case FX_Z:  // 睡觉：往右上越飘越大
        p.x = CX + 84.f + frand() * 6.f; p.y = CY - 34.f; p.vx = 13.f; p.vy = -28.f;
        p.size = 17.f; p.life = 2.4f; p.col = 0xAFC0FF; p.t0 = _t + k * .6f;
        break;
      case FX_NOTE:
        p.x = CX + side * (100.f + frand() * 18.f); p.y = CY + 8.f + frand() * 20.f;
        p.vx = side * (5.f + frand() * 6.f); p.vy = -(38.f + frand() * 10.f);
        p.size = 26.f + frand() * 6.f; p.life = 1.8f;
        p.col = (k % 3 == 0) ? 0xFFD45C : (k % 3 == 1 ? 0x8BF3FF : 0xFF8EC6);
        break;
      // ---- 2.8 陪伴版 ----
      case FX_DROP:  // 水滴：从两边慢慢滴下来
        p.x = CX + side * (98.f + frand() * 12.f); p.y = CY - 52.f + frand() * 10.f;
        p.vx = side * 1.5f; p.vy = 30.f + frand() * 8.f;
        p.size = 26.f + frand() * 4.f; p.life = 1.6f; p.col = frand() < .5f ? 0x5CC8FF : 0x8FE0FF; p.t0 = _t + k * .35f;
        break;
      case FX_BOWL:  // 一碗饭：在旁边「噔」地冒出来
        p.x = CX + side * 94.f; p.y = CY + 30.f; p.vy = -10.f;
        p.size = 36.f; p.life = 2.2f; p.col = 0xFFB45C; p.t0 = _t + k * .5f;
        break;
      case FX_MOON:  // 月亮：右上角慢慢亮起来
        p.x = CX + 90.f; p.y = CY - 66.f; p.vx = 3.f; p.vy = -4.f;
        p.size = 36.f; p.life = 2.8f; p.col = 0xFFE89A; p.t0 = _t + k * .7f;
        break;
      case FX_BELL:  // 铃铛：长在头顶一侧，晃一晃
        p.x = (k & 1) ? CX - 92.f : CX + 92.f; p.y = CY - 64.f; p.vy = -3.f;
        p.size = 38.f; p.life = 1.9f; p.col = 0xFFD45C; p.t0 = _t + k * .25f;
        break;
      case FX_CHECK:  // 对勾：「啪」地打上去
        p.x = (k & 1) ? CX - 94.f : CX + 94.f; p.y = CY - 58.f; p.vy = -4.f;
        p.size = 40.f; p.life = 2.f; p.col = 0x6CF0A0; p.t0 = _t + k * .3f;
        break;
      case FX_FLOWER:  // 小红花：从两边开出来，往上飘
        p.x = CX + side * (96.f + frand() * 10.f); p.y = CY - 24.f + frand() * 20.f;
        p.vx = side * 2.f; p.vy = -(16.f + frand() * 6.f);
        p.size = 32.f + frand() * 4.f; p.life = 2.3f; p.col = frand() < .7f ? 0xFF4F6A : 0xFF7A8C; p.t0 = _t + k * .3f;
        break;
      case FX_PERSON:  // 伸懒腰的小人：在旁边蹦一蹦
        p.x = CX + side * 96.f; p.y = CY + 6.f; p.vy = -4.f;
        p.size = 38.f; p.life = 2.3f; p.col = 0x7CF0C0; p.t0 = _t + k * .4f;
        break;
      default: {  // FX_SPARK：光环外一圈闪
        const float a = frand() * TAU_F;
        p.kind = FX_SPARK;
        p.x = CX + cosf(a) * (104.f + frand() * 16.f); p.y = CY + sinf(a) * (86.f + frand() * 10.f);
        p.vx = cosf(a) * 12.f; p.vy = sinf(a) * 12.f;
        p.size = 20.f + frand() * 10.f; p.life = .8f; p.col = frand() < .6f ? 0xFFFFFF : 0xFFE9A8; p.t0 = _t + k * .09f;
      } break;
    }
    _fx[_nFx++] = p;
  }
}

void Engine::setMood(float valence, float arousal, float energy, float warmth) {
  if (!isfinite(valence) || !isfinite(arousal) || !isfinite(energy) || !isfinite(warmth)) return;
  _mood[0] = clampf(valence, -1.f, 1.f);
  _mood[1] = clamp01(arousal);
  _mood[2] = clamp01(energy);
  _mood[3] = clamp01(warmth);
}

void Engine::startBlink(float dur, float depth) {
  _blinkT = _t;
  _blinkDur = clampf(dur, .1f, 1.6f);
  _blinkDepth = clampf(depth, .3f, .97f);
}

void Engine::blink(float dur) {
  if (!isfinite(dur)) return;
  startBlink(dur, dur > .35f ? .95f : .9f);
  _nextBlink = _t + _blinkDur + 1.2f + frand();
}

// 一次眨眼的开合：闭得快（35%）、睁得慢（65%），u = 0…1
static inline float blinkShape(float u, float depth) {
  if (u <= 0.f || u >= 1.f) return 1.f;
  const float s = u < .35f ? sinf(PI_F * .5f * u / .35f) : cosf(PI_F * .5f * (u - .35f) / .65f);
  return 1.f - depth * s;
}

static int idleStateIndex() {
  static int idx = -2;
  if (idx == -2) idx = findState("02");
  return idx;
}

static void applyImp(uint8_t type, float u, float& by, float& bx, float& rot, float& sx, float& sy, float& sc,
                     float& flash, float& eye, float& draw, float& dim, float& gx, float& gy) {
  switch (type) {
    case I_HOP: {
      float f = clamp01((u - .14f) / .72f), s = sinf(PI_F * f);
      by -= 13.f * s;
      sy *= 1.f + .05f * s - .09f * bumpf(u, 0, .18f) - .07f * bumpf(u, .82f, 1);
      sx *= 1.f - .035f * s + .07f * bumpf(u, 0, .18f) + .05f * bumpf(u, .82f, 1);
    } break;
    case I_SHAKE: { float e = 1.f - u, w = sinf(u * TAU_F * 3.f); bx += 7.f * w * e; rot += 3.f * w * e; gx += 3.f * w * e; } break;
    case I_NOD: { float s = sinf(u * TAU_F); s = s * s * (u < .5f ? 1.f : .65f); by += 6.f * s; gy += 2.5f * s; } break;
    case I_STRETCH: { float s = sinf(PI_F * u); sy *= 1.f + .1f * s; sx *= 1.f - .06f * s; eye *= 1.f - .75f * s; by -= 3.f * s; } break;
    case I_SIGH: { float s = sinf(PI_F * u); by += 4.f * s; sy *= 1.f - .05f * s; sx *= 1.f + .035f * s; dim += .25f * s; eye *= 1.f - .3f * s; } break;
    case I_FLASH: flash += (1.f - u) * (1.f - u); break;
    case I_BURST: { float s = u < .12f ? u / .12f : expf(-6.f * (u - .12f)) * cosf((u - .12f) * 16.f); sc += .13f * s; by -= 4.f * s; } break;
    case I_JOLT: { float e = powf(1.f - u, 1.5f); bx += 6.f * sinf(u * 55.f) * e; rot += 4.f * sinf(u * 43.f) * e; flash += .6f * e * e; } break;
    case I_DRAW: draw = easeIO(u); break;
    case I_STOP: { float s = sinf(PI_F * u) * (1.f - u); sy *= 1.f - .07f * s; sx *= 1.f + .05f * s; flash += .4f * (1.f - u) * (1.f - u); } break;
    default: break;
  }
}

void Engine::update(float dt) {
  float* c = _c;
  _t += dt;
  const float t = _t;
  const float k = 1.f - expf(-dt * _ease);
  for (int i = 0; i < P_COUNT; i++) c[i] += (_g[i] - c[i]) * k;
  _col = mixc(_col, _tcol, k);
  // ---- 心情底色：只在待机放空（02）时往目标上加一点点（稳态 = 目标 + 权重 × 偏移）----
  _moodW += ((_state == idleStateIndex() ? 1.f : 0.f) - _moodW) * (1.f - expf(-dt * 1.2f));
  const float sleepy = clamp01((.45f - _mood[2]) / .35f) * _moodW;
  if (_moodW > .002f) {
    const float joy = clamp01((_mood[0] - .3f) / .5f), gloom = clamp01((-_mood[0] - .05f) / .45f);
    const float ex = clampf(_mood[1] - .4f, -.4f, .6f), warm = _mood[3], sl = clamp01((.45f - _mood[2]) / .35f);
    const float w = _moodW * k;
    c[P_EYE_H] += w * (-.16f * sl - .06f * gloom + .06f * fmaxf(ex, 0.f));
    c[P_LID_O] += w * (.20f * sl + .05f * gloom);
    c[P_LID_I] += w * (.12f * sl + .14f * gloom);
    c[P_BITE] += w * fminf(.28f, .22f * joy * (1.f - sl) + .08f * warm);
    c[P_BLUSH] += w * .32f * warm * (1.f - gloom);
    c[P_GLOW] += w * (.12f * joy + .10f * ex - .15f * sl - .10f * gloom);
    c[P_GAZE_Y] += w * (1.5f * gloom + 1.0f * sl);
    c[P_BOB_SPEED] += w * (.12f * ex - .12f * sl);
    c[P_BLINK] += w * (-.08f * sl);
  }
  // ---- 2.9 呼吸引导：吸气时身体慢慢变大、变亮，呼气时变小、眼睛放松 ----
  if (_guideA > .002f) {
    const float w = clamp01(_guideA) * k, l = clamp01(_guideL);
    c[P_SCALE] += w * (.16f * l - .06f);
    c[P_GLOW] += w * (.45f * l - .05f);
    c[P_LID_O] += w * .18f * (1.f - l);
    c[P_BLUSH] += w * .12f;
  }

  static const uint8_t kSpd[6] = {P_S2, P_S3, P_S5, P_S8, P_S11, P_S18};
  for (int i = 0; i < 6; i++) _ph[i] = fmodf(_ph[i] + dt * TAU_F * c[kSpd[i]], TAU_F * 64.f);
  const float hot0 = _hotPos;
  _hotPos = wrap01(_hotPos + dt * c[P_HOT_SPEED]);
  if (_hotPos < hot0 && c[P_HOT] > .3f) _ev |= EV_HOT;
  _ecgPh = fmodf(_ecgPh + dt * TAU_F * c[P_ECG_SPEED], TAU_F * 64.f);
  {  // 心电脉冲（_ecgN 个，均匀分布）每经过一次顶部 → EV_ECG
    const int cnt = (int)floorf((_ecgPh + 1.5708f) * _ecgN / TAU_F) % (64 * _ecgN);
    if (cnt != _ecgCnt) {
      _ecgCnt = cnt;
      if (c[P_ECG] > 2.f) _ev |= EV_ECG;
    }
  }

  const StateDef& d = kStates[_state];
  if (d.everyImp && t >= _everyT) { fire(d.everyImp); _everyT = t + d.everyPeriod; _ev |= EV_PERIODIC | (1u << d.everyImp); }
  if (d.ringRate > 0 && t >= _ringT) { addRing(false); _ringT = t + 1.f / d.ringRate; _ev |= EV_RING_OUT; }
  if (d.inRate > 0 && t >= _inT) { addRing(true); _inT = t + 1.f / d.inRate; _ev |= EV_RING_IN; }

  Acc I = {0, 0, 0, 1, 1, 0, 0, 1, -1, 0, 0, 0};
  int w = 0;
  for (int i = 0; i < _nImps; i++) {
    float u = (t - _imps[i].t0) / _imps[i].dur;
    if (u >= 1.f) continue;
    if (u >= 0.f) applyImp(_imps[i].type, u, I.by, I.bx, I.rot, I.sx, I.sy, I.sc, I.flash, I.eye, I.draw, I.dim, I.gx, I.gy);
    _imps[w++] = _imps[i];
  }
  _nImps = w;
  w = 0;
  for (int i = 0; i < _nRings; i++)
    if (t - _rings[i].t0 < _rings[i].dur) _rings[w++] = _rings[i];
  _nRings = w;
  w = 0;
  for (int i = 0; i < _nFx; i++)
    if (t - _fx[i].t0 < _fx[i].life) _fx[w++] = _fx[i];
  _nFx = w;
  _acc = I;

  // ---- 视线 ----
  float tx = c[P_GAZE_X], ty = c[P_GAZE_Y];
  if (_ptrOn) {
    float px = clampf((_ptrX - _scx) / (140.f * _unit), -1, 1), py = clampf((_ptrY - _scy) / (110.f * _unit), -1, 1);
    tx += c[P_FOLLOW] * px * 7.f;
    ty += c[P_FOLLOW] * py * 5.f;
  } else if (_lookOn) {  // 头要转去哪里，眼睛先看过去
    const float fa = fabsf(c[P_FOLLOW]), f = fa > .05f ? fmaxf(fa, .5f) : 0.f;
    tx += f * clampf(_lookX, -1.2f, 1.2f) * 7.f;
    ty += f * clampf(_lookY, -1.2f, 1.2f) * 5.f;
    // 注视时眼球不会一动不动：每隔半秒到一秒半轻轻跳一下（很小），看起来是「活的」
    if (t > _msT) {
      if (frand() < .3f) { _msV[0] = 0; _msV[1] = 0; }
      else { _msV[0] = (frand() * 2.f - 1.f) * 1.1f; _msV[1] = (frand() * 2.f - 1.f) * .7f; }
      _msT = t + .45f + frand() * 1.1f;
    }
    if (c[P_FOLLOW] > .3f && c[P_DART] < .05f) { tx += _msV[0]; ty += _msV[1]; }
    // 视线一下子跳很远（马上要大幅转头）：人会顺便眨一下眼
    const float jx = _lookX - _lookPX, jy = _lookY - _lookPY;
    if (jx * jx + jy * jy > .2f && _blinkT < 0 && c[P_BLINK] > .03f && frand() < .45f) startBlink(.16f, .9f);
    _lookPX = _lookX; _lookPY = _lookY;
  } else if (c[P_FOLLOW] > .3f) {
    if (t > _idleT) {
      if (frand() < .35f) { _idleV[0] = 0; _idleV[1] = 0; }
      else {
        _idleV[0] = (frand() * 2.f - 1.f) * 5.f; _idleV[1] = (frand() * 2.f - 1.f) * 2.6f;
        if (_blinkT < 0 && c[P_BLINK] > .03f && frand() < .25f) startBlink(.16f, .9f);
      }
      _idleT = t + 1.1f + frand() * 2.2f;
    }
    float f = c[P_FOLLOW] < 1.f ? c[P_FOLLOW] : 1.f;
    tx += _idleV[0] * f;
    ty += _idleV[1] * f;
  }
  if (c[P_DART] > .05f) {
    if (t > _dartT) { _dartV[0] = (frand() * 2.f - 1.f) * 7.f; _dartV[1] = (frand() * 2.f - 1.f) * 4.f; _dartT = t + .18f + frand() * .4f; }
    tx += _dartV[0] * c[P_DART];
    ty += _dartV[1] * c[P_DART];
  }
  tx += c[P_SCAN] * 8.f * sinf(t * TAU_F * c[P_SCAN_SPEED]);
  if (I.draw >= 0) _hotPos = wrap01(I.draw - c[P_HOT_LEN]);
  if (c[P_EYE_HOT] > .01f) {
    float a = (_hotPos + c[P_HOT_LEN] * .5f) * TAU_F;
    tx += c[P_EYE_HOT] * cosf(a) * 7.f;
    ty += c[P_EYE_HOT] * sinf(a) * 5.f;
  }
  tx += I.gx;
  ty += I.gy;
  const float gk = 1.f - expf(-dt * (c[P_DART] > .3f ? 24.f : 11.f));
  _gaze[0] += (clampf(tx, -9, 9) - _gaze[0]) * gk;
  _gaze[1] += (clampf(ty, -7, 7) - _gaze[1]) * gk;
  const float gx = _gaze[0], gy = _gaze[1];

  float raT = c[P_REACH_A] * PI_F / 180.f;
  if (c[P_REACH_FOLLOW] > .5f && hypotf(gx, gy) > 1.5f) raT = atan2f(gy, gx);
  _ra += angDist(raT, _ra) * (1.f - expf(-dt * 5.f));

  // ---- 眨眼：闭得快、睁得慢；右眼比左眼慢一点点；困的时候眨得又慢又沉 ----
  float bl0 = 1.f, bl1 = 1.f;
  if (_blinkT >= 0) {
    const float u = (t - _blinkT) / _blinkDur;
    if (u >= 1.1f) _blinkT = -1;
    else { bl0 = blinkShape(u, _blinkDepth); bl1 = blinkShape(u - .1f, _blinkDepth); }
  }
  if (_blinkT < 0 && c[P_BLINK] > .03f && t > _nextBlink) {
    startBlink(.17f * (1.f + .8f * sleepy), .9f);
    _nextBlink = t + (.6f + frand()) / c[P_BLINK];
    if (frand() < .2f) _nextBlink = t + .3f;
  }
  _blinkE[0] = bl0;
  _blinkE[1] = bl1;
  _blinkMul = fminf(bl0, bl1);

  // ---- 轮廓几何（极坐标半径） ----
  const float ex = EX0 + c[P_BOXY] * 3.2f;
  if (fabsf(ex - _lastEx) > .003f) {
    for (int j = 0; j < N; j++) {
      float a = fabsf(_cs[j]), b = fabsf(_sn[j]);
      _sqf[j] = powf(powf(a, ex) + powf(b, ex), -1.f / ex);
    }
    _lastEx = ex;
  }
  _venv = .3f + .7f * fabsf(sinf(t * 6.1f) * sinf(t * 2.3f + 1.1f));
  const float rimR = RB + GAP, sag = c[P_SAG], top = -PI_F / 2.f;
  const bool useSp = c[P_SPIKE] > .05f, useJ = c[P_JITTER] > .02f, useV = c[P_VOICE] > .05f, useE = c[P_ECG] > .05f,
             useR = c[P_REACH] > .05f, useS = sag > .01f;
  const float amp[6] = {c[P_A2], c[P_A3], c[P_A5], c[P_A8], c[P_A11], c[P_A18]};
  static const float kWave[6] = {2, 3, 5, 8, 11, 18};
  const float spOff = ((N / K_SPIKES) % 2 == 0) ? 0.f : .5f;
  for (int j = 0; j < N; j++) {
    const float th = _th[j], si = _sn[j], q = _sqf[j];
    float off = 0;
    for (int i = 0; i < 6; i++)
      if (fabsf(amp[i]) > .01f) off += amp[i] * sinf(kWave[i] * th + _ph[i]);
    if (useSp) {
      float p = (float)j * K_SPIKES / N + spOff, f = p - floorf(p), tri = 1.f - fabsf(2.f * f - 1.f);
      int idx = (int)floorf(p);
      off += c[P_SPIKE] * (.62f + .38f * sinf(t * 10.f + idx * 2.39996f)) * tri * tri * tri;
    }
    if (useJ) off += c[P_JITTER] * (.6f * sinf(13.f * th + t * 23.f) + .4f * sinf(7.f * th - t * 17.f + 1.3f) + .3f * sinf(21.f * th + t * 31.f));
    if (useV && si > 0) off += c[P_VOICE] * si * si * _venv * sinf(14.f * th - t * 9.f);
    if (useE)
      for (int e = 0; e < _ecgN; e++) {
        float dd = angDist(th, _ecgPh + e * TAU_F / _ecgN);
        if (dd > -.7f && dd < .7f) off += c[P_ECG] * ecgShape(dd);
      }
    if (useR) off += c[P_REACH] * gaussf(angDist(th, _ra), .42f);
    float rb = RB * q;
    if (useS) { float dent = sag * gaussf(angDist(th, top), .5f); off -= 6.f * dent; rb -= 5.f * dent; }
    _rr[j] = rimR * q + off;
    _rb[j] = rb;
  }
  memcpy(_hist[_histHead], _rr, sizeof(_rr));
  _histHead = (_histHead + 1) % HIST;
  if (_histCount < HIST) _histCount++;

  // ---- 身体运动 → 仿射变换 ----
  const float bob = c[P_BOB] * sinf(t * TAU_F * c[P_BOB_SPEED]);
  const float swg = c[P_SWING] * sinf(t * TAU_F * c[P_SWING_SPEED]);
  const float br = 1.f + c[P_BREATHE] * sinf(t * TAU_F * c[P_BREATHE_SPEED]);
  const float tr = c[P_TREMBLE] > .02f ? c[P_TREMBLE] * (.8f * sinf(t * 47.f) + .6f * sinf(t * 31.f + 1.f)) : 0.f;
  float gj = 0;
  if (c[P_GLITCH] > .05f) {
    if (t > _jumpT) { _jumpX = (frand() < .5f ? -1.f : 1.f) * (2.f + frand() * 4.f); _jumpUntil = t + .07f; _jumpT = t + .45f + frand() * .7f; }
    if (t < _jumpUntil) gj = _jumpX * c[P_GLITCH];
    if (t > _glT) { _glV[0] = 1.5f + frand() * 4.f; _glV[1] = (frand() * 2.f - 1.f) * 1.5f; _glV[2] = frand(); _glT = t + .06f + frand() * .1f; }
  }
  const float sc = c[P_SCALE] * br * (1.f + I.sc);
  const float syRel = I.sy * (1.f - c[P_SQUASH]), sxRel = I.sx * (1.f + c[P_SQUASH] * .6f);
  const float bx = I.bx + tr * .8f + gj + c[P_LEAN] * gx / 7.f;
  const float by = bob + I.by + c[P_LEAN] * gy / 10.f + rimR * (1.f - syRel) * sc * .9f;
  const float rot = (c[P_TILT] + swg + I.rot + tr * .5f) * PI_F / 180.f;
  const float cr = cosf(rot), sr = sinf(rot), ssx = sc * sxRel, ssy = sc * syRel;
  _A[0] = _unit * cr * ssx; _A[1] = -_unit * sr * ssy;
  _A[3] = _unit * sr * ssx; _A[4] = _unit * cr * ssy;
  _A[2] = (_scx - _ox + _unit * bx) - (_A[0] * CX + _A[1] * CY);
  _A[5] = (_scy - _oy + _unit * by) - (_A[3] * CX + _A[4] * CY);
  const float det = _A[0] * _A[4] - _A[1] * _A[3];
  _Ai[0] = _A[4] / det; _Ai[1] = -_A[1] / det;
  _Ai[3] = -_A[3] / det; _Ai[4] = _A[0] / det;
  _Ai[2] = -(_Ai[0] * _A[2] + _Ai[1] * _A[5]);
  _Ai[5] = -(_Ai[3] * _A[2] + _Ai[4] * _A[5]);
  _ppu = _unit * sqrtf(fabsf(ssx * ssy));
  _bx = bx; _by = by; _sc = sc;
  _lift = fmaxf(0.f, -(bob + I.by));
  _flash = fminf(1.5f, I.flash);
  _dimV = clamp01(c[P_DIM] + I.dim);
  _dimF = 1.f - _dimV * .62f;
  _gp = c[P_GLOW_PULSE] * (.5f - .5f * sinf(t * TAU_F * c[P_GLOW_SPEED]));

  // ---- 头部姿态（给舵机） ----
  _pose.pan = gx * 2.2f + I.bx * 1.6f + swg * .8f + c[P_TILT] * .6f + tr * .4f;
  _pose.tilt = gy * 1.4f + I.by * .9f + c[P_SAG] * 8.f + c[P_DOTS] * 10.f + c[P_DIM] * 4.f - c[P_REACH] * .4f;
  _bright = 1.f - _dimV * .45f;
}

// ============================== 绘制 ==============================
// 整个屏幕按 48 行一条分条渲染：每条先填背景、画所有图层、再推到屏幕。
// 有两条缓冲时，推这一条（DMA）的同时就在算下一条。

struct Engine::Frame {
  RGB base, rimCol;
  float wpx, go, rimA, coreA, total;
  bool drawing;
  float cx, cy;                  // 身体中心（画布坐标）
  float rx0, ry0, rx1, ry1;      // 外圈轮廓的包围盒
};

static inline uint16_t blend565(uint16_t s, int cr, int cg, int cb, int a8) {
  // s：字节交换过的 RGB565；a8：0..256
  uint16_t v = (uint16_t)((s >> 8) | (s << 8));
  int r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31;
  r = (r << 3) | (r >> 2);
  g = (g << 2) | (g >> 4);
  b = (b << 3) | (b >> 2);
  r += ((cr - r) * a8) >> 8;
  g += ((cg - g) * a8) >> 8;
  b += ((cb - b) * a8) >> 8;
  v = (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
  return (uint16_t)((v >> 8) | (v << 8));
}
static inline int ceil16(int a) { return -((-a) >> 4); }

void Engine::blendPx(uint16_t* p, const RGB& c, float a) {
  if (a <= 0.f) return;
  const int a8 = a >= 1.f ? 256 : (int)(a * 256.f);
  if (a8) *p = blend565(*p, (int)c.r, (int)c.g, (int)c.b, a8);
}

void Engine::clearBand() {
  for (int y = _by0; y <= _by1; y++) {
    uint32_t* row = (uint32_t*)rowPtr(y);
    const uint16_t* pat = _bgsw + y * 4;
    const uint32_t p01 = (uint32_t)pat[0] | ((uint32_t)pat[1] << 16), p23 = (uint32_t)pat[2] | ((uint32_t)pat[3] << 16);
    const int n = _cw >> 2;
    for (int i = 0; i < n; i++) { row[2 * i] = p01; row[2 * i + 1] = p23; }
    if (_cw & 3) {
      uint16_t* r16 = rowPtr(y);
      for (int x = n * 4; x < _cw; x++) r16[x] = pat[x & 3];
    }
  }
}

// 局部坐标的轮廓 → 画布坐标（带下垂变形、缩放、身体仿射）
void Engine::buildPoly(const float* radii, float off, float scl, float* xs, float* ys) {
  const float sag = _c[P_SAG];
  const bool useS = sag > .01f;
  for (int j = 0; j < N; j++) {
    float r = radii[j] + off;
    if (r < 0) r = 0;
    float x = r * _cs[j], y = r * _sn[j];
    if (useS) {
      x *= 1.f + sag * .11f * (y / RB + .15f);
      y = y * (1.f - .07f * sag) + 5.f * sag;
    }
    x = CX + x * scl;
    y = CY + y * scl;
    xs[j] = _A[0] * x + _A[1] * y + _A[2];
    ys[j] = _A[3] * x + _A[4] * y + _A[5];
  }
}

// 扫描线填充（奇偶规则，可以同时传多个轮廓 → 环形），只处理当前条带的行
template <typename F>
void Engine::scanContours(const Contour* cs, int nc, F&& span) {
  float ymin = 1e9f, ymax = -1e9f;
  for (int k = 0; k < nc; k++)
    for (int j = 0; j < cs[k].n; j++) {
      const float y = cs[k].y[j];
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
    }
  int r0 = (int)ceilf(ymin - .5f), r1 = (int)ceilf(ymax - .5f) - 1;
  if (r0 < _by0) r0 = _by0;
  if (r1 > _by1) r1 = _by1;
  if (r0 > r1) return;
  for (int k = 0; k < nc; k++) {
    const float* X = cs[k].x;
    const float* Y = cs[k].y;
    const int n = cs[k].n;
    for (int j = 0; j < n; j++) {
      const int j2 = j + 1 < n ? j + 1 : 0;
      float x0 = X[j], y0 = Y[j], x1 = X[j2], y1 = Y[j2];
      if (y0 == y1) continue;
      if (y0 > y1) { float tx = x0; x0 = x1; x1 = tx; float ty = y0; y0 = y1; y1 = ty; }
      int a = (int)ceilf(y0 - .5f), b = (int)ceilf(y1 - .5f) - 1;
      if (a < r0) a = r0;
      if (b > r1) b = r1;
      if (a > b) continue;
      const float slope = (x1 - x0) / (y1 - y0);
      float x = x0 + (a + .5f - y0) * slope;
      for (int r = a; r <= b; r++, x += slope) {
        uint8_t& cnt = _xn[r - _by0];
        if (cnt < XCAP) {
          const float xc = clampf(x, -2000.f, 2000.f);
          _xc[(r - _by0) * XCAP + cnt] = (int16_t)lrintf(xc * 16.f);
          cnt++;
        }
      }
    }
  }
  for (int r = r0; r <= r1; r++) {
    const int cnt = _xn[r - _by0];
    _xn[r - _by0] = 0;
    if (cnt < 2) continue;
    int16_t* v = _xc + (r - _by0) * XCAP;
    for (int i = 1; i < cnt; i++) {
      const int16_t key = v[i];
      int j = i - 1;
      while (j >= 0 && v[j] > key) { v[j + 1] = v[j]; j--; }
      v[j + 1] = key;
    }
    for (int i = 0; i + 1 < cnt; i += 2) {
      int xa = ceil16(v[i] - 8), xb = ceil16(v[i + 1] - 8) - 1;  // 像素中心落在 [xa, xb)
      if (xa < 0) xa = 0;
      if (xb > _cw - 1) xb = _cw - 1;
      if (xa <= xb) span(r, xa, xb);
    }
  }
}

// 把覆盖缓冲区按 alpha 混合到画布，然后清零
void Engine::blendCov(const RGB& col, float alpha) {
  if (_cy0 > _cy1) return;
  const int a8f = (int)(clamp01(alpha) * 256.f);
  const int cr = (int)clampf(col.r, 0, 255), cg = (int)clampf(col.g, 0, 255), cb = (int)clampf(col.b, 0, 255);
  for (int y = _cy0; y <= _cy1; y++) {
    const int x0 = _rmin[y], x1 = _rmax[y];
    if (x0 > x1) continue;
    uint8_t* row = covRow(y);
    uint16_t* px = rowPtr(y);
    bool any = false;
    for (int x = x0; x <= x1; x++) {
      // 描边是一圈环，中间大片覆盖率为 0：按 4 字节对齐整块跳过
      if (!(x & 3)) {
        while (x + 3 <= x1 && *(const uint32_t*)(row + x) == 0) x += 4;
        if (x > x1) break;
      }
      const uint8_t v = row[x];
      if (!v) continue;
      row[x] = 0;
      const int a8 = (a8f * (v + (v >> 7))) >> 8;
      if (a8) { px[x] = blend565(px[x], cr, cg, cb, a8); any = true; }
    }
    if (any) touch(x0, y, x1, y);
    _rmin[y] = 32767;
    _rmax[y] = -1;
  }
  _cy0 = _ch;
  _cy1 = -1;
}

// 抗锯齿描边（距离场 → 覆盖率，取最大值，最后统一混合，所以自交处不会叠亮）
void Engine::stroke(const float* xs, const float* ys, int n, bool closed, float hw, const RGB& col, float alpha, float soft) {
  if (n < 2 || alpha <= .004f) return;
  if (hw < .35f) { alpha *= hw / .35f; hw = .35f; }
  if (alpha <= .004f) return;
  if (soft < 1.f) soft = 1.f;
  const float r = hw + soft * .5f, r2 = r * r, invSoft = 1.f / soft;
  const float rin = hw - soft * .5f, rin2 = rin > 0.f ? rin * rin : -1.f;  // 这个半径以内覆盖率 = 1，不用开方
  const int segs = closed ? n : n - 1;
  const float by0 = _by0 - r, by1 = _by1 + 1 + r;
  for (int s = 0; s < segs; s++) {
    const int s2 = s + 1 < n ? s + 1 : 0;
    const float ax = xs[s], ay = ys[s], bx = xs[s2], by = ys[s2];
    if ((ay < by0 && by < by0) || (ay > by1 && by > by1)) continue;  // 不在这一条里
    int x0 = (int)floorf(fminf(ax, bx) - r), x1 = (int)ceilf(fmaxf(ax, bx) + r);
    int y0 = (int)floorf(fminf(ay, by) - r), y1 = (int)ceilf(fmaxf(ay, by) + r);
    if (x1 < 0 || y1 < _by0 || x0 >= _cw || y0 > _by1) continue;
    if (x0 < 0) x0 = 0;
    if (y0 < _by0) y0 = _by0;
    if (x1 > _cw - 1) x1 = _cw - 1;
    if (y1 > _by1) y1 = _by1;
    const float dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, inv = L2 > 1e-6f ? 1.f / L2 : 0.f;
    for (int y = y0; y <= y1; y++) {
      uint8_t* row = covRow(y);
      const float py = y + .5f - ay;
      for (int x = x0; x <= x1; x++) {
        const float px = x + .5f - ax;
        float tt = (px * dx + py * dy) * inv;
        tt = tt < 0.f ? 0.f : (tt > 1.f ? 1.f : tt);
        const float ex = px - tt * dx, ey = py - tt * dy, d2 = ex * ex + ey * ey;
        if (d2 >= r2) continue;
        if (d2 <= rin2) { row[x] = 255; continue; }
        const float cv = (r - sqrtf(d2)) * invSoft;
        const uint8_t v = cv >= 1.f ? 255 : (uint8_t)(cv * 255.f);
        if (v > row[x]) row[x] = v;
      }
      markRow(y, x0, x1);
    }
  }
  blendCov(col, alpha);
}

// 取闭合折线上 [s0, s0+len) 这一段（按弧长，可跨越起点）
int Engine::extractRange(const float* xs, const float* ys, const float* cum, float total, float s0, float len, float* ox, float* oy, int maxOut) {
  if (len <= .01f || total <= 0.f || maxOut < 2) return 0;
  if (len > total) len = total;
  s0 = fmodf(s0, total);
  if (s0 < 0) s0 += total;
  const float e = s0 + len;
  auto P = [&](int k) { return cum[k % N] + total * (float)(k / N); };
  int j = 0;
  while (j < N - 1 && cum[j + 1] <= s0) j++;
  int n = 0;
  {
    const float sa = cum[j], sb = cum[j + 1];
    const float f = sb > sa ? (s0 - sa) / (sb - sa) : 0.f;
    const int b = (j + 1) % N;
    ox[n] = xs[j] + (xs[b] - xs[j]) * f;
    oy[n] = ys[j] + (ys[b] - ys[j]) * f;
    n++;
  }
  int k = j + 1;
  while (n < maxOut - 1 && P(k) < e) {
    ox[n] = xs[k % N];
    oy[n] = ys[k % N];
    n++;
    k++;
  }
  {
    const float sa = P(k - 1), sb = P(k);
    const float f = sb > sa ? clamp01((e - sa) / (sb - sa)) : 0.f;
    const int a = (k - 1) % N, b = k % N;
    ox[n] = xs[a] + (xs[b] - xs[a]) * f;
    oy[n] = ys[a] + (ys[b] - ys[a]) * f;
    n++;
  }
  return n;
}

// 局部坐标的矩形 → 画布上的包围盒（不裁剪到条带）
bool Engine::canvasBox(float lx0, float ly0, float lx1, float ly1, int& x0, int& y0, int& x1, int& y1) {
  float mnx = 1e9f, mny = 1e9f, mxx = -1e9f, mxy = -1e9f;
  const float cx[4] = {lx0, lx1, lx0, lx1}, cy[4] = {ly0, ly0, ly1, ly1};
  for (int i = 0; i < 4; i++) {
    const float X = _A[0] * cx[i] + _A[1] * cy[i] + _A[2], Y = _A[3] * cx[i] + _A[4] * cy[i] + _A[5];
    mnx = fminf(mnx, X); mxx = fmaxf(mxx, X);
    mny = fminf(mny, Y); mxy = fmaxf(mxy, Y);
  }
  x0 = (int)floorf(mnx); y0 = (int)floorf(mny);
  x1 = (int)ceilf(mxx); y1 = (int)ceilf(mxy);
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > _cw - 1) x1 = _cw - 1;
  if (y1 > _ch - 1) y1 = _ch - 1;
  return x0 <= x1 && y0 <= y1;
}

void Engine::drawGround() {
  const float a0 = .34f * _c[P_GLOW] * _dimF * (1.f - _lift / 30.f);
  if (a0 <= .005f) return;
  const float cx = _scx + _unit * _bx, cy = _scy + 98.f * _unit;
  const float rx = 64.f * _c[P_SCALE] * (1.f - _lift / 40.f) * _unit, ry = 9.f * _unit;
  if (rx < 1.f) return;
  int x0 = (int)floorf(cx - rx), x1 = (int)ceilf(cx + rx), y0 = (int)floorf(cy - ry), y1 = (int)ceilf(cy + ry);
  if (x0 < 0) x0 = 0;
  if (y0 < _by0) y0 = _by0;
  if (x1 > _cw - 1) x1 = _cw - 1;
  if (y1 > _by1) y1 = _by1;
  if (x0 > x1 || y0 > y1) return;
  const float irx = 1.f / rx, iry = 1.f / ry;
  for (int y = y0; y <= y1; y++) {
    uint16_t* row = rowPtr(y);
    const float ey = (y + .5f - cy) * iry, ey2 = ey * ey;
    if (ey2 >= 1.f) continue;
    for (int x = x0; x <= x1; x++) {
      const float ex = (x + .5f - cx) * irx, e2 = ex * ex + ey2;
      if (e2 >= 1.f) continue;
      blendPx(row + x, _col, a0 * (1.f - sqrtf(e2)));
    }
  }
  touch(x0, y0, x1, y1);
}

// 烟熏玻璃身体：线性渐变 + 底部颜色透光 + 左上高光
void Engine::drawBody() {
  const float tintOp = clamp01(_c[P_TINT] * (1.f - _dimV * .5f) * (1.f + _flash * .8f));
  const RGB g1 = rgbHex(0x2A2F3A), g2 = rgbHex(0x0B0D11), base = _col;
  const float* Ai = _Ai;
  const bool tint = tintOp > .005f;
  const Contour cs[1] = {{_bodyX, _bodyY, N}};
  // 着色 [xs, xe]：按原实现每 2 个像素算一次颜色；cache 非空时把颜色记到行缓存里
  auto shade = [&](uint16_t* row, const uint8_t* bay, int y, int xs, int xe, int16_t* cache) {
    const float fx = xs + .5f, fy = y + .5f;
    float lx = Ai[0] * fx + Ai[1] * fy + Ai[2];
    float ly = Ai[3] * fx + Ai[4] * fy + Ai[5];
    const float dlx = Ai[0] * 2.f, dly = Ai[3] * 2.f;
    for (int x = xs; x <= xe; x += 2) {
      const float u = (lx - 48.f) * (1.f / 144.f), v = (ly - 48.f) * (1.f / 144.f);
      RGB col = mixc(g1, g2, clamp01((.35f * u + v) * (1.f / 1.1225f)));
      if (tint) {
        const float dx = lx - 120.f, dy = ly - 145.9f, d2 = dx * dx + dy * dy;
        if (d2 < 89.3f * 89.3f) col = mixc(col, base, tintOp * (1.f - sqrtf(d2) * (1.f / 89.3f)));
      }
      const float ex = (lx - 98.f) * (1.f / 50.f), ey = (ly - 74.f) * (1.f / 24.f), e2 = ex * ex + ey * ey;
      if (e2 < 1.f) {
        const float a = .11f * (1.f - sqrtf(e2));
        col.r += (255.f - col.r) * a; col.g += (255.f - col.g) * a; col.b += (255.f - col.b) * a;
      }
      // 与 pack565swD 等价：(int)(r + t*.5) == (floor(2r) + t) >> 1（r ≥ 0），绿色同理用 4 倍；每对像素只转换一次
      const int R2 = (int)(col.r * 2.f), G4 = (int)(col.g * 4.f), B2 = (int)(col.b * 2.f);
      const int xe2 = x + 1 <= xe ? x + 1 : x;
      for (int q = x; q <= xe2; q++) {
        const int t = bay[q & 3];
        row[q] = pack565sw((R2 + t) >> 1, (G4 + t) >> 2, (B2 + t) >> 1);
        if (cache) {
          cache[q] = (int16_t)y;
          cache[_cw + q] = (int16_t)R2; cache[2 * _cw + q] = (int16_t)G4; cache[3 * _cw + q] = (int16_t)B2;
        }
      }
      lx += dlx;
      ly += dly;
    }
  };
  scanContours(cs, 1, [&](int y, int x0, int x1) {
    uint16_t* row = rowPtr(y);
    const uint8_t* bay = kBayer4 + ((y & 3) << 2);
    if (!_bodyCache) { shade(row, bay, y, x0, x1, nullptr); touch(x0, y, x1, y); return; }
    if (!(y & 1)) { shade(row, bay, y, x0, x1, _bodyCache); touch(x0, y, x1, y); return; }
    // 身体是平缓渐变（144 个设计单位才变化约 30 个色阶），相邻两行颜色差 < 0.5 个色阶：
    // 奇数行复用上一偶数行同一列的颜色（只重新抖动），上一行没覆盖到的两端才重新计算。
    const int16_t want = (int16_t)(y - 1);
    const int16_t* st = _bodyCache;
    const int16_t* cR = _bodyCache + _cw;
    const int16_t* cG = cR + _cw;
    const int16_t* cB = cG + _cw;
    int ca = x0;
    while (ca <= x1 && st[ca] != want) ca++;
    int cb = ca;
    while (cb + 1 <= x1 && st[cb + 1] == want) cb++;
    if (ca > x1) { shade(row, bay, y, x0, x1, nullptr); touch(x0, y, x1, y); return; }
    if (ca > x0) shade(row, bay, y, x0, ca - 1, nullptr);
    for (int x = ca; x <= cb; x++) {
      const int t = bay[x & 3];
      row[x] = pack565sw((cR[x] + t) >> 1, (cG[x] + t) >> 2, (cB[x] + t) >> 1);
    }
    if (cb < x1) shade(row, bay, y, cb + 1, x1, nullptr);
    touch(x0, y, x1, y);
  });
}

// 外圈光晕：围绕描边的若干层环形带叠加（近似网页版的高斯模糊）
static const float kGlowH[6] = {19.f, 15.5f, 12.f, 9.f, 6.f, 3.f};
static const float kGlowB[6] = {.043f, .077f, .14f, .175f, .175f, .105f};

// 每帧一次：6 层光晕的 12 条轮廓（外扩 +h / 内缩 -h）只算一次，各条带共用
void Engine::prepareGlow() {
  _glowReady = false;
  if (!_glowKey || !_glowCnt) return;
  const float hs = .75f + .25f * (_c[P_RIM_W] * 2.6f + 5.f) / 13.32f;
  memset(_glowCnt, 0, _ch);
  float gy0 = 1e9f, gy1 = -1e9f;
  // 12 条轮廓逐条生成到内部 RAM 的临时数组里，马上扫描出每行交点（不再经 PSRAM 中转）
  for (int k = 0; k < 12; k++) {
    const float h = kGlowH[k >> 1] * hs;
    buildPoly(_rr, (k & 1) ? -h : h, 1, _qx, _qy);
    const float* X = _qx;
    const float* Y = _qy;
    float ymin = 1e9f, ymax = -1e9f;
    for (int j = 0; j < N; j++) {
      if (Y[j] < ymin) ymin = Y[j];
      if (Y[j] > ymax) ymax = Y[j];
    }
    if (ymin < gy0) gy0 = ymin;
    if (ymax > gy1) gy1 = ymax;
    int r0 = (int)ceilf(ymin - .5f), r1 = (int)ceilf(ymax - .5f) - 1;
    if (r0 < 0) r0 = 0;
    if (r1 > _ch - 1) r1 = _ch - 1;
    if (r0 > r1) continue;
    const int32_t tag = k >> 1;
    for (int j = 0; j < N; j++) {
      const int j2 = j + 1 < N ? j + 1 : 0;
      float x0 = X[j], ey0 = Y[j], x1 = X[j2], ey1 = Y[j2];
      if (ey0 == ey1) continue;
      if (ey0 > ey1) { float tx = x0; x0 = x1; x1 = tx; float ty = ey0; ey0 = ey1; ey1 = ty; }
      int a = (int)ceilf(ey0 - .5f), b = (int)ceilf(ey1 - .5f) - 1;
      if (a < r0) a = r0;
      if (b > r1) b = r1;
      if (a > b) continue;
      const float slope = (x1 - x0) / (ey1 - ey0);
      float x = x0 + (a + .5f - ey0) * slope;
      for (int r = a; r <= b; r++, x += slope) {
        uint8_t& c = _glowCnt[r];
        if (c < GLOW_CAP) {
          const float xc = clampf(x, -2000.f, 2000.f);
          _glowKey[r * GLOW_CAP + c] = ((int32_t)lrintf(xc * 16.f) << 3) | tag;
          c++;
        }
      }
    }
  }
  _glowY0 = gy0;
  _glowY1 = gy1;
  int r0 = (int)ceilf(gy0 - .5f), r1 = (int)ceilf(gy1 - .5f) - 1;
  if (r0 < 0) r0 = 0;
  if (r1 > _ch - 1) r1 = _ch - 1;
  for (int r = r0; r <= r1; r++) {
    const int n = _glowCnt[r];
    int32_t* v = _glowKey + r * GLOW_CAP;
    for (int i = 1; i < n; i++) {
      const int32_t key = v[i];
      int j = i - 1;
      while (j >= 0 && v[j] > key) { v[j + 1] = v[j]; j--; }
      v[j + 1] = key;
    }
  }
  _glowReady = true;
}

// 外圈光晕（单次扫描版）：12 条轮廓的交点一起排序，从左到右扫过去，按每层的奇偶状态
// 累加覆盖率，直接按常数 alpha 混合到画布。与逐层累加到覆盖缓冲再 blendCov 的结果逐像素一致，
// 但每个像素只处理一次，也不再读写 PSRAM 里的覆盖缓冲。
void Engine::drawGlow(const Frame& f) {
  if (!_glowReady) { drawGlowLegacy(f); return; }
  int r0 = (int)ceilf(_glowY0 - .5f), r1 = (int)ceilf(_glowY1 - .5f) - 1;
  if (r0 < _by0) r0 = _by0;
  if (r1 > _by1) r1 = _by1;
  if (r0 > r1) return;
  int add[6];
  for (int b = 0; b < 6; b++) add[b] = (int)(kGlowB[b] * 255.f + .5f);
  const int a8f = (int)(clamp01(f.go) * 256.f);
  const int cr = (int)clampf(_col.r, 0, 255), cg = (int)clampf(_col.g, 0, 255), cb = (int)clampf(_col.b, 0, 255);
  for (int r = r0; r <= r1; r++) {
    const int n = _glowCnt[r];
    if (n < 2) continue;
    const int32_t* v = _glowKey + r * GLOW_CAP;
    uint16_t* px = rowPtr(r);
    unsigned par = 0;
    int sum = 0, tx0 = _cw, tx1 = -1;
    for (int i = 0; i + 1 < n; i++) {
      const int tag = v[i] & 7;
      par ^= 1u << tag;
      sum += (par >> tag) & 1u ? add[tag] : -add[tag];
      if (sum <= 0) continue;
      const int cv = sum > 255 ? 255 : sum;
      const int a8 = (a8f * (cv + (cv >> 7))) >> 8;
      if (!a8) continue;
      int xa = ceil16((v[i] >> 3) - 8), xb = ceil16((v[i + 1] >> 3) - 8) - 1;
      if (xa < 0) xa = 0;
      if (xb > _cw - 1) xb = _cw - 1;
      if (xa > xb) continue;
      if (xb - xa < 12) {
        for (int x = xa; x <= xb; x++) px[x] = blend565(px[x], cr, cg, cb, a8);
      } else {
        const uint16_t* lut = glowLut(a8, cr, cg, cb);
        const uint16_t* lr = lut;
        const uint16_t* lg = lut + 32;
        const uint16_t* lb = lut + 96;
        for (int x = xa; x <= xb; x++) {
          const uint16_t sv = px[x], v = (uint16_t)((sv >> 8) | (sv << 8));
          px[x] = (uint16_t)(lr[v >> 11] | lg[(v >> 5) & 63] | lb[v & 31]);
        }
      }
      if (xa < tx0) tx0 = xa;
      if (xb > tx1) tx1 = xb;
    }
    if (tx1 >= tx0) touch(tx0, r, tx1, r);
  }
}

// 常数 alpha/颜色的混合查表：按 blend565 的同一公式逐通道预算（结果逐位相同），输出已是字节交换格式。
// 每帧颜色固定，不同的累计覆盖率只有十几种，按 a8 缓存。
const uint16_t* Engine::glowLut(int a8, int cr, int cg, int cb) {
  const uint32_t key = ((uint32_t)a8 << 24) ^ ((uint32_t)cr << 16) ^ ((uint32_t)cg << 8) ^ (uint32_t)cb;
  const int slot = a8 & (GLOW_LUTS - 1);
  uint16_t* t = _glowLut + slot * 128;
  if (_glowLutKey[slot] == key + 1) return t;
  for (int r = 0; r < 32; r++) {
    int e = (r << 3) | (r >> 2);
    e += ((cr - e) * a8) >> 8;
    const uint16_t v = (uint16_t)((e & 0xF8) << 8);
    t[r] = (uint16_t)((v >> 8) | (v << 8));
  }
  for (int g = 0; g < 64; g++) {
    int e = (g << 2) | (g >> 4);
    e += ((cg - e) * a8) >> 8;
    const uint16_t v = (uint16_t)((e & 0xFC) << 3);
    t[32 + g] = (uint16_t)((v >> 8) | (v << 8));
  }
  for (int b = 0; b < 32; b++) {
    int e = (b << 3) | (b >> 2);
    e += ((cb - e) * a8) >> 8;
    const uint16_t v = (uint16_t)(e >> 3);
    t[96 + b] = (uint16_t)((v >> 8) | (v << 8));
  }
  _glowLutKey[slot] = key + 1;
  return t;
}

void Engine::drawGlowLegacy(const Frame& f) {
  const float* kH = kGlowH;
  const float* kB = kGlowB;
  const float hs = .75f + .25f * (_c[P_RIM_W] * 2.6f + 5.f) / 13.32f;
  const float mg = (kH[0] * hs + 2.f) * _ppu;
  if (!bandHit(f.ry0 - mg, f.ry1 + mg)) return;
  for (int b = 0; b < 6; b++) {
    const float h = kH[b] * hs;
    buildPoly(_rr, h, 1, _qx, _qy);
    buildPoly(_rr, -h, 1, _ux, _uy);
    const Contour cs[2] = {{_qx, _qy, N}, {_ux, _uy, N}};
    const int add = (int)(kB[b] * 255.f + .5f);
    scanContours(cs, 2, [&](int y, int x0, int x1) {
      uint8_t* row = covRow(y);
      for (int x = x0; x <= x1; x++) {
        const int v = row[x] + add;
        row[x] = (uint8_t)(v > 255 ? 255 : v);
      }
      markRow(y, x0, x1);
    });
  }
  blendCov(_col, f.go);
}

void Engine::drawBlush() {
  const float bl = _c[P_BLUSH];
  if (bl <= .02f) return;
  const float a0 = bl * .5f;
  const RGB bc = rgbHex(0xFF7DB8);
  const float gx = _gaze[0], gy = _gaze[1];
  for (int i = 0; i < 2; i++) {
    const float side = i ? 1.f : -1.f;
    const float bx = CX + side * (37.f + _c[P_EYE_GAP]) + gx * .6f, by = 141.f + _c[P_EYE_Y] + gy * .5f;
    int x0, y0, x1, y1;
    if (!canvasBox(bx - 17.f, by - 12.f, bx + 17.f, by + 12.f, x0, y0, x1, y1)) continue;
    if (y0 < _by0) y0 = _by0;
    if (y1 > _by1) y1 = _by1;
    if (y0 > y1) continue;
    for (int y = y0; y <= y1; y++) {
      uint16_t* row = rowPtr(y);
      for (int x = x0; x <= x1; x++) {
        const float fx = x + .5f, fy = y + .5f;
        const float lx = _Ai[0] * fx + _Ai[1] * fy + _Ai[2] - bx, ly = _Ai[3] * fx + _Ai[4] * fy + _Ai[5] - by;
        const float ex = lx * (1.f / 9.f), ey = ly * (1.f / 4.5f);
        const float d = (sqrtf(ex * ex + ey * ey) - 1.f) * 5.5f;
        if (d > 9.f) continue;
        blendPx(row + x, bc, a0 / (1.f + pe_expf(d * (1.f / 1.43f))));
      }
    }
    touch(x0, y0, x1, y1);
  }
}

// 眼睛：圆角竖条（药丸形），距离场 + 上眼睑/下眼睑/咬合遮罩。
// 柔光 = 遮罩后的形状做一次高斯模糊垫在下面（和网页版的 SVG 滤镜一样）。
// 这里每帧只算一次（覆盖率 + 横向模糊），各条带里再做纵向模糊和合成。
void Engine::prepareEyes() {
  const float* c = _c;
  const Acc& I = _acc;
  _eye[0].on = _eye[1].on = false;
  _eyeOp = clamp01(c[P_EYE_BRIGHT] * (1.f - _dimV * .3f));
  if (_eyeOp < .01f) return;
  const float open = I.draw >= 0.f ? clamp01((I.draw - .72f) / .28f) : 1.f;
  const RGB white{255, 255, 255};
  _eyeCol = mixc(mixc(white, _col, .14f), white, fminf(1.f, _flash));
  const float gx = _gaze[0], gy = _gaze[1];
  const float ppu = _ppu;
  const bool lid = c[P_LID_O] > .004f || c[P_LID_I] > .004f, lidB = c[P_LID_B] > .004f, bite = c[P_BITE] > .01f;

  const float sigPx = 3.2f * ppu;  // 高斯核（σ = 3.2 个设计单位）
  int R = (int)ceilf(2.5f * sigPx);
  if (R > 12) R = 12;
  if (R < 1) R = 1;
  _eR = R;
  {
    float w[25], sum = 0;
    for (int k = -R; k <= R; k++) { w[k + R] = expf(-(float)(k * k) / (2.f * sigPx * sigPx)); sum += w[k + R]; }
    for (int k = 0; k <= 2 * R; k++) _eK[k] = (int)(w[k] / sum * 65536.f + .5f);
  }

  for (int i = 0; i < 2; i++) {
    const float side = i ? 1.f : -1.f;
    const float ew = 16.f * c[P_EYE_W];
    const float eh = fmaxf(1.4f, 34.f * c[P_EYE_H] * _blinkE[i] * I.eye * open * (1.f - c[P_ASYM] * side));
    const float ecx = CX + side * (24.f + c[P_EYE_GAP]) + gx, ecy = 116.f + c[P_EYE_Y] + gy, etop = ecy - eh * .5f;
    const float hw = ew * .5f, hh = eh * .5f, rr = fminf(hw, hh);
    // 上眼睑：一条斜线，线上方被遮住
    const float xo = ecx + side * ew, xi = ecx - side * ew;
    const float yo = etop + eh * (c[P_LID_O] - (c[P_LID_I] - c[P_LID_O]) * .5f);
    const float yi = etop + eh * (c[P_LID_O] + (c[P_LID_I] - c[P_LID_O]) * 1.5f);
    float nx = -(yi - yo), ny = xi - xo;
    {
      const float l = sqrtf(nx * nx + ny * ny);
      if (l < 1e-4f) { nx = 0.f; ny = 1.f; }
      else { nx /= l; ny /= l; }
      if (ny < 0) { nx = -nx; ny = -ny; }
    }
    const float yb = ecy + hh - c[P_LID_B] * eh;
    const float rbt = ew * .6f, bcy = ecy + hh + rbt - c[P_BITE] * eh * .78f;
    const float m = (R + 1.5f) / ppu;
    int x0, y0, x1, y1;
    if (!canvasBox(ecx - hw - m, etop - m, ecx + hw + m, etop + eh + m, x0, y0, x1, y1)) continue;
    if (x1 - x0 + 1 > EYE_BUF) { const int cxp = (x0 + x1) / 2; x0 = cxp - EYE_BUF / 2; x1 = x0 + EYE_BUF - 1; }
    if (y1 - y0 + 1 > EYE_BUF) { const int cyp = (y0 + y1) / 2; y0 = cyp - EYE_BUF / 2; y1 = y0 + EYE_BUF - 1; }
    const int bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    uint8_t* A = _eyeA[i];
    uint8_t* T = _eyeT[i];
    // 1) 形状覆盖率
    for (int y = 0; y < bh; y++) {
      const float fy = y0 + y + .5f;
      uint8_t* ar = A + y * bw;
      for (int x = 0; x < bw; x++) {
        const float fx = x0 + x + .5f;
        const float lx = _Ai[0] * fx + _Ai[1] * fy + _Ai[2], ly = _Ai[3] * fx + _Ai[4] * fy + _Ai[5];
        const float qx = fabsf(lx - ecx) - (hw - rr), qy = fabsf(ly - ecy) - (hh - rr);
        const float mx = fmaxf(qx, 0.f), my = fmaxf(qy, 0.f);
        float d = sqrtf(mx * mx + my * my) + fminf(fmaxf(qx, qy), 0.f) - rr;
        if (lid) d = fmaxf(d, -((lx - xo) * nx + (ly - yo) * ny));
        if (lidB) d = fmaxf(d, ly - yb);
        if (bite) {
          const float bx = lx - ecx, by = ly - bcy;
          d = fmaxf(d, rbt - sqrtf(bx * bx + by * by));
        }
        const float cov = .5f - d * ppu;
        ar[x] = cov <= 0.f ? 0 : (cov >= 1.f ? 255 : (uint8_t)(cov * 255.f));
      }
    }
    // 2) 横向模糊
    // 逐抽头整行累加（与逐像素求和的整数结果完全相同，但内层循环连续访存、没有边界判断）
    int32_t acc[EYE_BUF];
    for (int y = 0; y < bh; y++) {
      const uint8_t* ar = A + y * bw;
      uint8_t* tr = T + y * bw;
      memset(acc, 0, sizeof(int32_t) * bw);
      for (int k = 0; k <= 2 * R; k++) {
        const int w = _eK[k], d = k - R;  // acc[x] += w * ar[x + d]，只取图内像素
        const int xa = d < 0 ? -d : 0, xb = d > 0 ? bw - d : bw;
        for (int x = xa; x < xb; x++) acc[x] += w * ar[x + d];
      }
      for (int x = 0; x < bw; x++) tr[x] = (uint8_t)(acc[x] >> 16);
    }
    _eye[i] = {x0, y0, bw, bh, true};
  }
}

void Engine::drawEyes() {
  const int glowMul = 230;  // 光晕强度（/256）
  const int R = _eR;
  if (_eyeLutOp != _eyeOp) {  // 与 blendPx(a/255*op) 完全相同的取整，每帧最多算一次 256 项
    for (int a = 0; a < 256; a++) {
      const float v = a * (1.f / 255.f) * _eyeOp;
      _eyeA8[a] = v <= 0.f ? 0 : (v >= 1.f ? 256 : (int16_t)(v * 256.f));
    }
    _eyeLutOp = _eyeOp;
  }
  _eyeCR = (int)_eyeCol.r; _eyeCG = (int)_eyeCol.g; _eyeCB = (int)_eyeCol.b;
  for (int i = 0; i < 2; i++) {
    const EyePrep& e = _eye[i];
    if (!e.on) continue;
    int ya = e.y0 > _by0 ? e.y0 : _by0, yz = e.y0 + e.bh - 1 < _by1 ? e.y0 + e.bh - 1 : _by1;
    if (ya > yz) continue;
    const uint8_t* A = _eyeA[i];
    const uint8_t* T = _eyeT[i];
    const int bw = e.bw, bh = e.bh;
    int32_t acc[EYE_BUF];
    for (int yy = ya; yy <= yz; yy++) {
      const int y = yy - e.y0;
      uint16_t* row = rowPtr(yy) + e.x0;
      const uint8_t* ar = A + y * bw;
      const int k0 = y - R < 0 ? R - y : 0, k1 = y + R >= bh ? R + (bh - 1 - y) : 2 * R;
      memset(acc, 0, sizeof(int32_t) * bw);
      for (int k = k0; k <= k1; k++) {
        const int w = _eK[k];
        const uint8_t* tr = T + (y + k - R) * bw;
        for (int x = 0; x < bw; x++) acc[x] += w * tr[x];
      }
      for (int x = 0; x < bw; x++) {
        const int g = ((acc[x] >> 16) * glowMul) >> 8;
        const int a = ar[x] + (((255 - ar[x]) * g) >> 8);
        if (a > 1) {
          const int a8 = _eyeA8[a];
          if (a8) row[x] = blend565(row[x], _eyeCR, _eyeCG, _eyeCB, a8);
        }
      }
    }
    touch(e.x0, ya, e.x0 + bw - 1, yz);
  }
}

// 睡觉时往右上飘的小气泡
void Engine::drawDots() {
  const float dv = _c[P_DOTS];
  if (dv <= .02f) return;
  for (int i = 0; i < 3; i++) {
    const float u = wrap01(_t * .32f + i / 3.f);
    const float lx = 160.f + 26.f * u + 3.f * sinf(u * TAU_F), ly = 44.f - 34.f * u, r = 2.2f + 3.6f * u;
    const float a = dv * sinf(PI_F * u) * .9f;
    if (a < .01f) continue;
    const float cx = _A[0] * lx + _A[1] * ly + _A[2], cy = _A[3] * lx + _A[4] * ly + _A[5], rp = r * _ppu;
    int x0 = (int)floorf(cx - rp - 1), x1 = (int)ceilf(cx + rp + 1), y0 = (int)floorf(cy - rp - 1), y1 = (int)ceilf(cy + rp + 1);
    if (x0 < 0) x0 = 0;
    if (y0 < _by0) y0 = _by0;
    if (x1 > _cw - 1) x1 = _cw - 1;
    if (y1 > _by1) y1 = _by1;
    if (x0 > x1 || y0 > y1) continue;
    for (int y = y0; y <= y1; y++) {
      uint16_t* row = rowPtr(y);
      for (int x = x0; x <= x1; x++) {
        const float dx = x + .5f - cx, dy = y + .5f - cy;
        const float cov = clamp01(rp + .5f - sqrtf(dx * dx + dy * dy));
        if (cov > 0.f) blendPx(row + x, _col, a * cov);
      }
    }
    touch(x0, y0, x1, y1);
  }
}

// ---- 小图案 ----
static inline float backOut(float x) {  // 0→1，带一点回弹
  if (x >= 1.f) return 1.f;
  if (x <= 0.f) return 0.f;
  const float c1 = 2.2f, c3 = c1 + 1.f, y = x - 1.f;
  return 1.f + c3 * y * y * y + c1 * y * y;
}

void Engine::prepareFx() {
  _nFxd = 0;
  if (!_fxMask) return;
  for (int i = 0; i < _nFx && _nFxd < FXN; i++) {
    const FxP& p = _fx[i];
    const float age = _t - p.t0;
    if (age < 0.f || age >= p.life) continue;
    const float u = age / p.life;
    float s = 1.f, a = 1.f, wx = 0.f, wy = 0.f;
    bool anchored = false;  // 跟着身体动（? 和 ! 像是长在头上）
    switch (p.kind) {
      case FX_HEART:
        s = backOut(age / .25f) * (1.f + .07f * sinf(age * 15.f));
        a = u < .62f ? 1.f : (1.f - u) / .38f;
        wx = 5.f * sinf(p.ph + age * 5.f);
        break;
      case FX_QUESTION:
        s = backOut(age / .3f);
        a = u < .75f ? 1.f : (1.f - u) / .25f;
        wx = 2.5f * sinf(age * 3.2f);
        anchored = true;
        break;
      case FX_EXCLAIM:
        s = backOut(age / .2f) * (1.f + .1f * expf(-age * 5.f) * sinf(age * 30.f));
        a = u < .75f ? 1.f : (1.f - u) / .25f;
        wx = 2.f * sinf(age * 38.f) * expf(-age * 6.f);
        anchored = true;
        break;
      case FX_Z:
        s = .55f + .65f * u;
        a = u < .15f ? u / .15f : (u < .62f ? 1.f : (1.f - u) / .38f);
        wx = 5.f * sinf(p.ph + age * 3.f);
        break;
      case FX_NOTE:
        s = backOut(age / .22f);
        a = u < .6f ? 1.f : (1.f - u) / .4f;
        wx = 7.f * sinf(p.ph + age * 4.2f);
        wy = 2.f * sinf(p.ph * 1.7f + age * 8.f);
        break;
      case FX_DROP:  // 先鼓起来，再滴下去
        s = backOut(age / .25f);
        a = u < .65f ? 1.f : (1.f - u) / .35f;
        wy = age < .3f ? -6.f * (1.f - age / .3f) : 0.f;
        break;
      case FX_BOWL:
      case FX_CHECK:
        s = backOut(age / .22f) * (1.f + .08f * expf(-age * 4.f) * sinf(age * 24.f));
        a = u < .78f ? 1.f : (1.f - u) / .22f;
        wy = -3.f * expf(-age * 3.f) * fabsf(sinf(age * 9.f));
        anchored = true;
        break;
      case FX_MOON:
        s = .7f + .3f * backOut(age / .6f);
        a = u < .2f ? u / .2f : (u < .7f ? 1.f : (1.f - u) / .3f);
        wy = 2.5f * sinf(age * 2.2f);
        break;
      case FX_BELL:  // 叮叮：左右摇晃，慢慢停下
        s = backOut(age / .2f);
        a = u < .78f ? 1.f : (1.f - u) / .22f;
        wx = 5.f * sinf(age * 21.f) * expf(-age * 2.2f);
        anchored = true;
        break;
      case FX_FLOWER:
        s = backOut(age / .35f) * (1.f + .05f * sinf(age * 6.f));
        a = u < .7f ? 1.f : (1.f - u) / .3f;
        wx = 4.f * sinf(p.ph + age * 3.5f);
        break;
      case FX_PERSON:  // 一蹦一蹦
        s = backOut(age / .25f);
        a = u < .78f ? 1.f : (1.f - u) / .22f;
        wy = -7.f * fabsf(sinf(age * 6.5f));
        break;
      default:
        s = sinf(PI_F * u);
        a = 1.f;
        break;
    }
    const float lx = p.x + p.vx * age + wx, ly = p.y + p.vy * age + wy;
    float cx, cy;
    if (anchored) { cx = _A[0] * lx + _A[1] * ly + _A[2]; cy = _A[3] * lx + _A[4] * ly + _A[5]; }
    else { cx = _scx - _ox + _unit * (lx - CX); cy = _scy - _oy + _unit * (ly - CY); }
    const float sz = p.size * FX_PAD * s * _unit;
    a *= .65f + .35f * _dimF;
    if (sz < 3.f || a < .02f) continue;
    FxD& d = _fxd[_nFxd];
    d.x0 = (int)floorf(cx - sz * .5f); d.x1 = (int)ceilf(cx + sz * .5f);
    d.y0 = (int)floorf(cy - sz * .5f); d.y1 = (int)ceilf(cy + sz * .5f);
    if (d.x0 < 0) d.x0 = 0;
    if (d.y0 < 0) d.y0 = 0;
    if (d.x1 > _cw - 1) d.x1 = _cw - 1;
    if (d.y1 > _ch - 1) d.y1 = _ch - 1;
    if (d.x0 > d.x1 || d.y0 > d.y1) continue;
    d.ox = cx; d.oy = cy; d.sz = sz; d.alpha = clamp01(a); d.col = rgbHex(p.col); d.kind = p.kind;
    _nFxd++;
  }
}

void Engine::drawFx() {
  const int M = FXM;
  for (int i = 0; i < _nFxd; i++) {
    const FxD& d = _fxd[i];
    const int y0 = d.y0 > _by0 ? d.y0 : _by0, y1 = d.y1 < _by1 ? d.y1 : _by1;
    if (y0 > y1) continue;
    const uint8_t* C = _fxMask + d.kind * M * M;
    const uint8_t* G = _fxMask + (_fxKinds + d.kind) * M * M;
    const float inv = M / d.sz, off = M * .5f - .5f;
    const int a8 = (int)(d.alpha * 256.f);
    const int cr = (int)d.col.r, cg = (int)d.col.g, cb = (int)d.col.b;
    for (int y = y0; y <= y1; y++) {
      uint16_t* row = rowPtr(y);
      const float my = (y + .5f - d.oy) * inv + off;
      const int iy = (int)floorf(my);
      if (iy < -1 || iy >= M) continue;
      const int fy = (int)((my - iy) * 256.f);
      const bool r0 = iy >= 0, r1 = iy + 1 < M;
      for (int x = d.x0; x <= d.x1; x++) {
        const float mx = (x + .5f - d.ox) * inv + off;
        const int ix = (int)floorf(mx);
        if (ix < -1 || ix >= M) continue;
        const int fx = (int)((mx - ix) * 256.f);
        const bool c0 = ix >= 0, c1 = ix + 1 < M;
        int vc[2] = {0, 0};
        for (int L = 0; L < 2; L++) {
          const uint8_t* S = L ? G : C;
          const int p00 = (r0 && c0) ? S[iy * M + ix] : 0, p01 = (r0 && c1) ? S[iy * M + ix + 1] : 0;
          const int p10 = (r1 && c0) ? S[(iy + 1) * M + ix] : 0, p11 = (r1 && c1) ? S[(iy + 1) * M + ix + 1] : 0;
          const int top = p00 * 256 + (p01 - p00) * fx, bot = p10 * 256 + (p11 - p10) * fx;
          vc[L] = (top * 256 + (bot - top) * fy) >> 16;  // 0..255
        }
        const int core = vc[0], glow = (vc[1] * 150) >> 8;
        const int v = core + (((255 - core) * glow) >> 8);
        if (v < 2) continue;
        const int aa = (v * a8) >> 8;
        if (aa) row[x] = blend565(row[x], cr, cg, cb, aa);
      }
    }
    touch(d.x0, y0, d.x1, y1);
  }
}

static constexpr int kLabelY = 6, kLabelH = 18;

void Engine::drawLabel() {
  if (!_labelsEnabled || !_lblOn) return;
  if (kLabelY + kLabelH < _by0 || kLabelY > _by1) return;
  M5Canvas& cv = *_cvCur;
  cv.setFont(&fonts::efontCN_16);
  cv.setTextDatum(textdatum_t::top_center);
  cv.setTextColor(lgfx::color888((uint8_t)_lblCol.r, (uint8_t)_lblCol.g, (uint8_t)_lblCol.b));
  const int x = _cw / 2;
  cv.drawString(_label, x, kLabelY - _by0);
  const int tw = cv.textWidth(_label);
  int y0 = kLabelY - 1, y1 = kLabelY + kLabelH;
  if (y0 < _by0) y0 = _by0;
  if (y1 > _by1) y1 = _by1;
  touch(x - tw / 2 - 2, y0, x + tw / 2 + 2, y1);
}

#define PROF_BEGIN() uint32_t _pt = micros()
#define PROF_MARK(st) do { const uint32_t _pn = micros(); _prof[st] += _pn - _pt; _pt = _pn; } while (0)

// 串口 "rbench"：测 CPU 每像素混合的真实周期数（内部 RAM / PSRAM / 浮点），用来判断瓶颈
void Engine::benchmark(Print& out) {
  const int n = 320 * 8;
  uint16_t* in = (uint16_t*)heap_caps_malloc(n * 2, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  uint16_t* ps = (uint16_t*)heap_caps_malloc(n * 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!in || !ps) { out.println("[rbench] alloc failed"); free(in); free(ps); return; }
  memset(in, 0x55, n * 2); memset(ps, 0x55, n * 2);
  uint32_t c0 = esp_cpu_get_ccount();
  for (int i = 0; i < n; i++) in[i] = blend565(in[i], 120, 200, 255, 77);
  uint32_t c1 = esp_cpu_get_ccount();
  for (int i = 0; i < n; i++) ps[i] = blend565(ps[i], 120, 200, 255, 77);
  uint32_t c2 = esp_cpu_get_ccount();
  float acc = 0.f, xv = 1.f;
  for (int i = 0; i < n; i++) { acc += xv * 1.0001f + .5f; xv += .25f; }
  uint32_t c3 = esp_cpu_get_ccount();
  float sq = 0.f;
  for (int i = 0; i < n; i++) sq += sqrtf((float)i);
  uint32_t c4 = esp_cpu_get_ccount();
  volatile int sink = 0;
  for (int i = 0; i < n; i++) sink += i;
  uint32_t c5 = esp_cpu_get_ccount();
  out.printf("[rbench] cpu=%uMHz cycles/px: blend_iram=%.1f blend_psram=%.1f fmadd=%.1f sqrt=%.1f int_loop=%.1f (acc=%d)\n",
             (unsigned)getCpuFrequencyMhz(), (c1 - c0) / (float)n, (c2 - c1) / (float)n, (c3 - c2) / (float)n,
             (c4 - c3) / (float)n, (c5 - c4) / (float)n, (int)(acc + sq) & 1);
  free(in); free(ps);
}

void Engine::printProfile(Print& out) {
  if (!_profFrames) return;
  static const char* const kN[PR_COUNT] = {"prep", "clear", "ground", "body", "bodyEdge", "echo", "rings", "glitch",
                                           "glow", "rim", "hot", "blush", "eyes", "dots", "fx", "label", "push"};
  out.printf("[render] frames=%u avg_us:", (unsigned)_profFrames);
  for (int i = 0; i < PR_COUNT; i++) {
    out.printf(" %s=%u", kN[i], (unsigned)(_prof[i] / _profFrames));
    _prof[i] = 0;
  }
  out.printf(" push_px=%u\n", (unsigned)(_profPx / _profFrames));
  _profPx = 0;
  _profFrames = 0;
}

void Engine::drawBand(const Frame& f) {
  PROF_BEGIN();
  const float* c = _c;
  const RGB white{255, 255, 255};
  const float mg = 3.f * _ppu + f.wpx;
  const bool nearRim = bandHit(f.ry0 - mg, f.ry1 + mg);

  drawGround();
  PROF_MARK(PR_GROUND);
  if (nearRim) {
    drawBody();
    PROF_MARK(PR_BODY);
    stroke(_bodyX, _bodyY, N, true, .75f * _ppu, white, .09f);  // 玻璃内边
    PROF_MARK(PR_BODYEDGE);
  }
  // 回声
  if (c[P_ECHO] > .01f && _histCount > 0 && bandHit(f.cy + (f.ry0 - f.cy) * 1.2f - mg, f.cy + (f.ry1 - f.cy) * 1.2f + mg)) {
    const int oldest = _histCount < HIST ? 0 : _histHead;
    buildPoly(_hist[oldest], 0, 1.13f, _qx, _qy);
    stroke(_qx, _qy, N, true, f.wpx * .75f * 1.13f * .5f, f.base, c[P_ECHO] * .4f * _dimF);
  }
  PROF_MARK(PR_ECHO);
  // 光环
  for (int i = 0; i < _nRings; i++) {
    const float u = (_t - _rings[i].t0) / _rings[i].dur;
    if (u < 0.f || u >= 1.f) continue;
    float s, o;
    if (_rings[i].inward) { s = 1.5f - .5f * u * u; o = .65f * sinf(PI_F * u); }
    else { const float v = 1.f - u; s = 1.f + .55f * (1.f - v * v * v); o = .7f * powf(v, 1.6f); }
    if (!bandHit(f.cy + (f.ry0 - f.cy) * s - mg, f.cy + (f.ry1 - f.cy) * s + mg)) continue;
    buildPoly(_rr, 0, s, _qx, _qy);
    stroke(_qx, _qy, N, true, (_rings[i].inward ? .9f : 1.f - u * .5f) * f.wpx * .5f, f.base, o * fmaxf(_dimF, .6f));
  }
  PROF_MARK(PR_RINGS);
  // 故障风：红/青错位
  if (c[P_GLITCH] > .03f && nearRim) {
    const float fl = _glV[2] > .25f ? 1.f : .25f, gA = c[P_GLITCH];
    static const uint32_t kGc[2] = {0xFF2E63, 0x2EE6FF};
    for (int i = 0; i < 2; i++) {
      const float sgn = i ? 1.f : -1.f, dx = sgn * _glV[0] * gA, dy = -sgn * _glV[1];
      const float cdx = _A[0] * dx + _A[1] * dy, cdy = _A[3] * dx + _A[4] * dy;
      for (int j = 0; j < N; j++) { _qx[j] = _px[j] + cdx; _qy[j] = _py[j] + cdy; }
      stroke(_qx, _qy, N, true, f.wpx * .9f * .5f, rgbHex(kGc[i]), .75f * gA * fl);
    }
  }
  PROF_MARK(PR_GLITCH);
  // 光晕 + 主描边 + 白色芯
  if (!f.drawing) {
    if (f.go > .01f) drawGlow(f);
    PROF_MARK(PR_GLOW);
    if (nearRim) {
      stroke(_px, _py, N, true, f.wpx * .5f, f.rimCol, f.rimA);
      stroke(_px, _py, N, true, f.wpx * .36f * .5f, white, f.coreA);
    }
  } else if (_dN >= 2) {
    if (f.go > .01f) stroke(_dX, _dY, _dN, false, (c[P_RIM_W] * 2.6f + 5.f) * .5f * _ppu * .8f, f.base, f.go * .6f, 6.f * _ppu * 1.6f);
    stroke(_dX, _dY, _dN, false, f.wpx * .5f, f.rimCol, f.rimA);
    stroke(_dX, _dY, _dN, false, f.wpx * .36f * .5f, white, f.coreA);
  }
  PROF_MARK(PR_RIM);
  // 高亮光段（扫描 / 加载 / 专注）
  if (_hN >= 2) {
    stroke(_hX, _hY, _hN, false, f.wpx * 3.2f * .5f, f.base, clamp01(c[P_HOT] * .85f) * .8f, 2.6f * 1.6f * _ppu);
    stroke(_hX, _hY, _hN, false, f.wpx * 1.25f * .5f, white, clamp01(c[P_HOT]));
  }
  PROF_MARK(PR_HOT);
  drawBlush();
  PROF_MARK(PR_BLUSH);
  drawEyes();
  PROF_MARK(PR_EYES);
  drawDots();
  PROF_MARK(PR_DOTS);
  drawFx();
  PROF_MARK(PR_FX);
  drawLabel();
  PROF_MARK(PR_LABEL);
}

void Engine::draw() {
  if (!_nBuf) return;
  uint16_t* const capture = _captureState == 1 ? _capturePixels : nullptr;
  const uint32_t t0 = micros();
  const float* c = _c;
  const Acc& I = _acc;
  const RGB white{255, 255, 255};
  Frame f;
  f.base = _col;
  f.wpx = c[P_RIM_W] * (1.f + _flash * .25f) * _ppu;  // 描边宽度（像素）
  f.drawing = I.draw >= 0.f;
  f.go = clamp01(.55f * c[P_GLOW] * _dimF * (1.f + _flash * .8f) * (1.f - .8f * _gp));
  f.rimCol = mixc(f.base, white, clamp01(_flash * .45f));
  f.rimA = _dimF * (1.f - .45f * _gp);
  f.coreA = clamp01((.5f + _flash * .4f) * _dimF * (1.f - _gp));
  f.cx = _A[0] * CX + _A[1] * CY + _A[2];
  f.cy = _A[3] * CX + _A[4] * CY + _A[5];

  // 每帧只算一次的几何
  buildPoly(_rb, 0, 1, _bodyX, _bodyY);
  buildPoly(_rr, 0, 1, _px, _py);
  f.rx0 = f.ry0 = 1e9f;
  f.rx1 = f.ry1 = -1e9f;
  _cum[0] = 0;
  for (int j = 0; j < N; j++) {
    const int j2 = j + 1 < N ? j + 1 : 0;
    const float ddx = _px[j2] - _px[j], ddy = _py[j2] - _py[j];
    _cum[j + 1] = _cum[j] + sqrtf(ddx * ddx + ddy * ddy);
    f.rx0 = fminf(f.rx0, _px[j]); f.rx1 = fmaxf(f.rx1, _px[j]);
    f.ry0 = fminf(f.ry0, _py[j]); f.ry1 = fmaxf(f.ry1, _py[j]);
  }
  f.total = _cum[N];
  _dN = f.drawing ? extractRange(_px, _py, _cum, f.total, 0.f, I.draw * f.total, _dX, _dY, N + 2) : 0;
  _hN = c[P_HOT] > .02f ? extractRange(_px, _py, _cum, f.total, _hotPos * f.total, c[P_HOT_LEN] * f.total, _hX, _hY, N + 2) : 0;
  prepareEyes();
  prepareFx();
  _glowReady = false;
  if (!f.drawing && f.go > .01f) prepareGlow();
  _prof[PR_PREP] += micros() - t0;
  _lblOn = false;
  if (_labelsEnabled && _label[0] && _labelMs) {
    const uint32_t el = millis() - _labelStart;
    if (el >= _labelMs) _label[0] = 0;
    else {
      float a = 1.f;
      if (el < 150) a = el / 150.f;
      else if (el + 450 > _labelMs) a = (float)(_labelMs - el) / 450.f;
      _lblCol = mixc(_bg[kLabelY + kLabelH / 2], rgbHex(0xD5DAE3), clamp01(a) * .92f);
      _lblOn = true;
    }
  }

  const bool overlap = _nBuf == 2;
  if (overlap) _disp->startWrite();  // 持有总线：推屏走 DMA，不等它完成就去算下一条
  int fx0 = _cw, fy0 = _ch, fx1 = -1, fy1 = -1;
  int k = 0;
  for (int b = 0; b < _ch; b += _bh) {
    _cvCur = &_cvb[k];
    _buf = (uint16_t*)_cvCur->getBuffer();
    _by0 = b;
    _by1 = (b + _bh < _ch ? b + _bh : _ch) - 1;
    _fx0 = _cw; _fy0 = _ch; _fx1 = -1; _fy1 = -1;
    uint32_t tc = micros();
    clearBand();
    _prof[PR_CLEAR] += micros() - tc;
    drawBand(f);
    tc = micros();
    // 这一条要推送的区域 = 本条画过的 ∪（上一帧画过的 ∩ 本条）
    int x0 = _fx0, y0 = _fy0, x1 = _fx1, y1 = _fy1;
    if (_pbx1 >= _pbx0 && _pby1 >= _by0 && _pby0 <= _by1) {
      const int py0 = _pby0 > _by0 ? _pby0 : _by0, py1 = _pby1 < _by1 ? _pby1 : _by1;
      if (x1 < x0) { x0 = _pbx0; x1 = _pbx1; y0 = py0; y1 = py1; }
      else {
        if (_pbx0 < x0) x0 = _pbx0;
        if (_pbx1 > x1) x1 = _pbx1;
        if (py0 < y0) y0 = py0;
        if (py1 > y1) y1 = py1;
      }
    }
    // A diagnostic frame is also a complete LCD repaint. Copy the exact
    // rendered source before pushSprite starts DMA or the double buffer is
    // reused. The final short band's unused sprite rows are never copied.
    if (capture) {
      x0 = 0; x1 = _cw - 1; y0 = _by0; y1 = _by1;
      memcpy(capture + static_cast<size_t>(_by0) * _sw, _buf,
             static_cast<size_t>(_by1 - _by0 + 1) * _cw * sizeof(uint16_t));
    }
    x0 &= ~1;  // 每行起点和长度都按 4 字节对齐，DMA 更稳妥
    x1 |= 1;
    if (x0 < 0) x0 = 0;
    if (x1 > _cw - 1) x1 = _cw - 1;
    if (y0 < _by0) y0 = _by0;
    if (y1 > _by1) y1 = _by1;
    bool pushed = false;
    if (x0 <= x1 && y0 <= y1) {
      _disp->setClipRect(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
      _cvCur->pushSprite(_disp, 0, _by0);
      _disp->clearClipRect();
      pushed = true;
      _profPx += (uint32_t)(x1 - x0 + 1) * (uint32_t)(y1 - y0 + 1);
    }
    _prof[PR_PUSH] += micros() - tc;
    if (_fx1 >= _fx0) {
      if (_fx0 < fx0) fx0 = _fx0;
      if (_fy0 < fy0) fy0 = _fy0;
      if (_fx1 > fx1) fx1 = _fx1;
      if (_fy1 > fy1) fy1 = _fy1;
    }
    // 只有推送过的缓冲才需要等 DMA，所以推了才换另一块
    if (overlap && pushed) k ^= 1;
  }
  if (overlap) {
    const uint32_t tc = micros();
    _disp->endWrite();
    _prof[PR_PUSH] += micros() - tc;
  }
  _profFrames++;
  if (capture) {
    _disp->waitDMA(); // Ready means every captured band has finished its push.
    _captureState = 2;
  }
  _pbx0 = fx0; _pby0 = fy0; _pbx1 = fx1; _pby1 = fy1;
  _drawMs = (micros() - t0) * .001f;
}

void Engine::glowRGB(uint8_t& r, uint8_t& g, uint8_t& b) const {
  const float k = clamp01((.35f + .65f * fminf(1.f, _c[P_GLOW])) * _dimF * (1.f - .55f * _gp) * (1.f + .5f * _flash));
  const RGB c = mixc(_col, RGB{255, 255, 255}, clamp01(_flash * .45f));
  r = (uint8_t)clampf(c.r * k, 0.f, 255.f);
  g = (uint8_t)clampf(c.g * k, 0.f, 255.f);
  b = (uint8_t)clampf(c.b * k, 0.f, 255.f);
}

}  // namespace pulse
