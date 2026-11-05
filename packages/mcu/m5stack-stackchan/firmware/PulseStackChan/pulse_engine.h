#pragma once
// 脉冲 Pulse · 表情引擎（原创代码，从网页原型移植到 M5Stack）
#include <M5Unified.h>
#include "pulse_events.h"

namespace pulse {

// 所有连续参数（会在状态之间平滑过渡）。名字和网页原型一致。
#define PULSE_PARAMS(X) \
  X(GLOW, 0.85f) X(GLOW_PULSE, 0) X(GLOW_SPEED, 0.6f) X(RIM_W, 3.2f) X(DIM, 0) X(TINT, 0.16f) \
  X(EYE_W, 1) X(EYE_H, 1) X(EYE_Y, 0) X(EYE_GAP, 0) X(LID_O, 0) X(LID_I, 0) X(LID_B, 0) X(BITE, 0) \
  X(ASYM, 0) X(EYE_BRIGHT, 1) X(BLUSH, 0) \
  X(GAZE_X, 0) X(GAZE_Y, 0) X(FOLLOW, 1) X(BLINK, 0.28f) X(SCAN, 0) X(SCAN_SPEED, 0.8f) X(DART, 0) X(EYE_HOT, 0) \
  X(A2, 0) X(S2, 0.3f) X(A3, 0.6f) X(S3, 0.35f) X(A5, 0) X(S5, 0.8f) X(A8, 0) X(S8, 1.2f) \
  X(A11, 0) X(S11, 1.6f) X(A18, 0) X(S18, 2.4f) \
  X(SPIKE, 0) X(JITTER, 0) X(VOICE, 0) X(ECG, 0) X(ECG_SPEED, 0.6f) \
  X(REACH, 0) X(REACH_A, -60) X(REACH_FOLLOW, 0) X(SAG, 0) X(BOXY, 0) X(SCALE, 1) X(SQUASH, 0) X(LEAN, 0) \
  X(BOB, 1.6f) X(BOB_SPEED, 0.45f) X(SWING, 0) X(SWING_SPEED, 0.5f) X(BREATHE, 0.012f) X(BREATHE_SPEED, 0.3f) \
  X(TILT, 0) X(TREMBLE, 0) \
  X(HOT, 0) X(HOT_SPEED, 0.5f) X(HOT_LEN, 0.12f) X(ECHO, 0) X(GLITCH, 0) X(DOTS, 0)

enum ParamId : uint8_t {
#define PULSE_X(n, d) P_##n,
  PULSE_PARAMS(PULSE_X)
#undef PULSE_X
  P_COUNT
};


struct KV { uint8_t k; float v; };

struct StateDef {
  const char* id;        // "00" … "41"
  const char* name;      // 中文名
  uint32_t color;        // 0xRRGGBB
  const KV* kv;
  uint8_t nkv;
  int8_t from;           // 进入前先跳到哪个状态的样子（-1 = 无）
  float ease;            // 过渡速度（0 = 默认）
  uint8_t enter[3];      // 进入时触发的动作
  uint8_t everyImp;      // 周期动作
  float everyPeriod;
  float ringRate;        // 每秒向外的光环数
  float inRate;          // 每秒向内的光环数
  uint8_t ecgN;          // 心电脉冲数量
  uint16_t holdMs;       // 自动轮播停留时间（0 = 默认）
};

int stateCount();
const StateDef& stateDef(int i);
int findState(const char* idOrName);

struct Pose { float pan, tilt; };  // 头部姿态（度，相对中位；tilt 正 = 低头）

class Engine {
 public:
  bool begin(LovyanGFX* display);
  void setState(int idx, bool instant = false);
  int state() const { return _state; }
  void pulse();
  void kick(uint8_t imp, float delay = 0) { fire(imp, delay); }  // 触发一次性动作（I_HOP、I_NOD……）
  void setPointer(bool active, float sx, float sy);
  // 让眼睛看向某个方向（-1…1，x 正 = 右，y 正 = 下）；头转向哪里时眼睛先看过去
  void setLook(bool active, float nx, float ny) { _lookOn = active; _lookX = nx; _lookY = ny; }
  // 飘出小图案：爱心、问号、感叹号、Z、音符、星星（n 个，依次出现）
  void emit(uint8_t fx, int n = 1);
  // 心情底色（只作用在「待机放空」02 上，而且很轻）：valence -1…1；arousal / energy / warmth 0…1
  // 困了眼皮往下耷拉、眨得慢；开心时眼睛带一点笑意；委屈时内眼角压低、往下看；越熟脸上越容易泛红
  void setMood(float valence, float arousal, float energy, float warmth);
  // 2.9 呼吸引导：amount 0–1 = 叠加多少（平滑由调用方做），level 0 = 呼完 / 1 = 吸满（身体跟着变大变亮）
  void setGuide(float amount, float level) { _guideA = amount; _guideL = level; }
  // 眨一下眼：dur 秒（0.17 = 平常；0.5 以上 = 慢慢地眨，像猫表示信任）
  void blink(float dur = .17f);
  void clearFx() { _nFx = 0; }
  void setLabel(const char* text, uint32_t ms);
  void setLabelsEnabled(bool enabled);
  bool labelsEnabled() const { return _labelsEnabled; }
  // Diagnostics only; all capture APIs share draw()'s main-loop owner.
  // The caller keeps this PSRAM buffer alive until take/cancel. Capacity is
  // measured in uint16_t pixels, not bytes. No allocation or ownership change.
  // Raw bytes are RGB565 big-endian (the same swapped words sent to the LCD).
  bool requestFrameCapture(uint16_t* pixels, size_t pixelCount);
  bool frameCaptureReady() const { return _captureState == 2; }
  bool takeFrameCapture(uint16_t*& pixels, size_t& pixelCount);
  void cancelFrameCapture();
  int captureWidth() const { return _sw; }
  int captureHeight() const { return _sh; }
  void update(float dt);
  void draw();
  void repaintOutside();  // 下一帧整屏重推（例如从设置界面回来）
  Pose pose() const { return _pose; }
  // 渲染分段耗时（累计微秒，printProfile 打印每帧平均值后清零）
  enum ProfStage : uint8_t { PR_PREP, PR_CLEAR, PR_GROUND, PR_BODY, PR_BODYEDGE, PR_ECHO, PR_RINGS, PR_GLITCH,
                             PR_GLOW, PR_RIM, PR_HOT, PR_BLUSH, PR_EYES, PR_DOTS, PR_FX, PR_LABEL, PR_PUSH, PR_COUNT };
#if defined(ARDUINO)
  void printProfile(Print& out);
  void benchmark(Print& out);
#endif
  float brightness() const { return _bright; }
  // 机身 RGB 灯用：和轮廓光同色、同步明暗（0–255）
  void glowRGB(uint8_t& r, uint8_t& g, uint8_t& b) const;
  // 音效用：上次调用以来发生过的周期性视觉事件（EV_* 位掩码，见 pulse_events.h）
  uint32_t takeEvents() { const uint32_t e = _ev; _ev = 0; return e; }
  float lastDrawMs() const { return _drawMs; }
  int bufferCount() const { return _nBuf; }

  static constexpr int N = 208;   // 轮廓采样点数（26 的倍数，尖刺能对齐）
  static constexpr int HIST = 14; // 回声延迟帧数

 private:
  struct RGB { float r, g, b; };
  struct Acc { float by, bx, rot, sx, sy, sc, flash, eye, draw, dim, gx, gy; };
  struct ImpRun { uint8_t type; float t0, dur; };
  struct Ring { float t0, dur; bool inward; };
  struct Contour { const float* x; const float* y; int n; };
  struct Frame;  // 每帧预先算好的量（定义在 .cpp 里）
  struct EyePrep { int x0, y0, bw, bh; bool on; };
  static constexpr int XCAP = 40;     // 每行最多记录多少个交点
  static constexpr int EYE_BUF = 96;  // 眼睛柔光用的小缓冲区边长（像素）
  static constexpr int GLOW_CAP = 96;  // 光晕单次扫描：每行最多记录的交点数（12 条轮廓）
  // 分条渲染：每条 24 行（两条缓冲交替，DMA 推屏和计算并行）。
  // 原来 48 行两块缓冲占 60KB 内部 RAM；减半后省出约 30KB，覆盖率缓冲和热点轮廓得以放进内部 RAM。
  static constexpr int BAND_H = 24;

  void applyDef(const StateDef& d, float* out);
  void fire(uint8_t type, float delay = 0);
  void addRing(bool inward, float delay = 0);
  void buildPoly(const float* radii, float off, float scl, float* xs, float* ys);
  template <typename F> void scanContours(const Contour* cs, int nc, F&& span);
  void stroke(const float* xs, const float* ys, int n, bool closed, float hw, const RGB& col, float alpha, float soft = 1.f);
  int extractRange(const float* xs, const float* ys, const float* cum, float total, float s0, float len, float* ox, float* oy, int maxOut);
  void clearBand();
  inline void touch(int x0, int y0, int x1, int y1) {
    if (x0 < _fx0) _fx0 = x0;
    if (y0 < _fy0) _fy0 = y0;
    if (x1 > _fx1) _fx1 = x1;
    if (y1 > _fy1) _fy1 = y1;
  }
  inline void markRow(int y, int x0, int x1) {
    if (x0 < _rmin[y]) _rmin[y] = (int16_t)x0;
    if (x1 > _rmax[y]) _rmax[y] = (int16_t)x1;
    if (y < _cy0) _cy0 = y;
    if (y > _cy1) _cy1 = y;
  }
  inline uint16_t* rowPtr(int y) { return _buf + (y - _by0) * _cw; }
  inline uint8_t* covRow(int y) { return _cov + (y - _by0) * _cw; }
  inline bool bandHit(float y0, float y1) const { return y1 >= _by0 && y0 <= _by1 + 1; }
  void blendCov(const RGB& col, float alpha);
  bool canvasBox(float lx0, float ly0, float lx1, float ly1, int& x0, int& y0, int& x1, int& y1);
  void prepareEyes();
  void drawBand(const Frame& f);
  void drawBody();
  void drawGround();
  void drawGlow(const Frame& f);
  void drawGlowLegacy(const Frame& f);
  void prepareGlow();
  const uint16_t* glowLut(int a8, int cr, int cg, int cb);
  void drawEyes();
  void drawBlush();
  void drawDots();
  void drawLabel();
  void prepareFx();
  void drawFx();
  void blendPx(uint16_t* p, const RGB& c, float a);

  static RGB rgbHex(uint32_t c);
  static RGB mixc(const RGB& a, const RGB& b, float t);
  static uint16_t to565sw(const RGB& c);
  static RGB from565sw(uint16_t v);

  LovyanGFX* _disp = nullptr;
  M5Canvas _cvb[2];
  M5Canvas* _cvCur = nullptr;
  int _nBuf = 0;                // 条带缓冲个数（2 = 可以边算边推）
  uint16_t* _buf = nullptr;     // 当前条带缓冲（第 0 行 = 画布第 _by0 行）
  int _by0 = 0, _by1 = -1, _bh = BAND_H;
  int16_t* _bodyCache = nullptr;  // 身体渐变的行缓存：[列戳 | R×2 | G×4 | B×2]
  int32_t* _glowKey = nullptr;  // 每行的交点（整帧算一次，已排序）：(x×16 << 3) | 层号
  uint8_t* _glowCnt = nullptr;
  float _glowY0 = 0, _glowY1 = -1;
  bool _glowReady = false;
  static constexpr int GLOW_LUTS = 32;
  uint16_t _glowLut[GLOW_LUTS * 128];   // 8KB：每个 a8 一张 32+64+32 的通道表（在 Engine 对象里，PSRAM）
  uint32_t _glowLutKey[GLOW_LUTS] = {0};
  int16_t _eyeA8[256];
  float _eyeLutOp = -1.f;
  int _eyeCR = 255, _eyeCG = 255, _eyeCB = 255;
  uint8_t* _cov = nullptr;      // 覆盖率缓冲（条带大小）
  RGB* _bg = nullptr;
  uint16_t* _bgsw = nullptr;    // 每行 4 像素的抖动背景色
  int16_t* _xc = nullptr;       // 扫描线交点（1/16 像素）
  uint8_t* _xn = nullptr;
  uint8_t* _eyeA[2] = {nullptr, nullptr};  // 眼睛覆盖率
  uint8_t* _eyeT[2] = {nullptr, nullptr};  // 横向模糊结果
  EyePrep _eye[2] = {{0, 0, 0, 0, false}, {0, 0, 0, 0, false}};
  int _eK[25];
  int _eR = 1;
  RGB _eyeCol{255, 255, 255};
  float _eyeOp = 1;
  bool _lblOn = false;
  bool _labelsEnabled = true;
  uint8_t _captureState = 0;    // 0 idle, 1 next draw requested, 2 completed.
  uint16_t* _capturePixels = nullptr;
  size_t _capturePixelCount = 0;
  RGB _lblCol{0, 0, 0};
  int16_t* _rmin = nullptr;     // 覆盖缓冲区每行被写过的范围
  uint32_t _prof[PR_COUNT] = {0};
  uint32_t _profFrames = 0;
  uint32_t _profPx = 0;  // 推屏像素数
  int16_t* _rmax = nullptr;
  int _cy0 = 1 << 20, _cy1 = -1;
  int _fx0 = 0, _fy0 = 0, _fx1 = -1, _fy1 = -1;      // 当前条带画过的区域
  int _pbx0 = 0, _pby0 = 0, _pbx1 = -1, _pby1 = -1;  // 上一帧画过的区域
  int _sw = 0, _sh = 0, _cw = 0, _ch = 0, _ox = 0, _oy = 0;
  float _unit = 1, _scx = 0, _scy = 0;
  float _drawMs = 0;

  float _c[P_COUNT], _g[P_COUNT];
  RGB _col{139, 243, 255}, _tcol{139, 243, 255};
  float _ease = 6.5f;
  int _state = 2;
  float _ph[6] = {0};
  float _t = 0, _hotPos = 0, _ecgPh = -1.5708f, _ra = -1.0472f;
  uint8_t _ecgN = 1;
  int _ecgCnt = 0;              // 心电脉冲经过顶部的计数（用来产生 EV_ECG）
  uint32_t _ev = 0;             // 还没取走的事件
  ImpRun _imps[8];
  int _nImps = 0;
  Ring _rings[4];
  int _nRings = 0;
  float _gaze[2] = {0, 0}, _dartT = 0, _dartV[2] = {0, 0}, _idleT = 0, _idleV[2] = {0, 0};
  float _nextBlink = 1.5f, _blinkT = -1, _blinkMul = 1;
  float _blinkDur = .17f, _blinkDepth = .9f, _blinkE[2] = {1, 1};  // 每只眼睛各自的开合（右眼慢一点点）
  float _mood[4] = {.25f, .35f, .85f, 0.f};  // valence arousal energy warmth
  float _moodW = 0;                          // 心情底色的权重（只在 02 时为 1）
  float _guideA = 0, _guideL = 0;            // 2.9 呼吸引导
  float _msT = 0, _msV[2] = {0, 0};          // 注视时眼球的细微跳动
  float _lookPX = 0, _lookPY = 0;            // 上一帧的视线目标（大幅转头时顺便眨眼）
  void startBlink(float dur, float depth);
  float _everyT = 0, _ringT = 0, _inT = 0;
  float _glT = 0, _glV[3] = {0, 0, 1}, _jumpT = 0, _jumpUntil = 0, _jumpX = 0;
  bool _ptrOn = false;
  float _ptrX = 0, _ptrY = 0;
  bool _lookOn = false;
  float _lookX = 0, _lookY = 0;
  // 小图案
  struct FxP { uint8_t kind; float t0, life, x, y, vx, vy, size, ph; uint32_t col; };
  struct FxD { int x0, y0, x1, y1; float ox, oy, sz, alpha; RGB col; uint8_t kind; };
  static constexpr int FXN = 14, FXM = 32;
  FxP _fx[FXN];
  FxD _fxd[FXN];
  int _nFx = 0, _nFxd = 0;
  uint8_t* _fxMask = nullptr;  // _fxKinds 张 32×32 的抗锯齿遮罩 + 同样多张光晕
  uint8_t _fxKinds = 0;        // 2.8：FX_KINDS，内存紧时 FX_LEGACY_KINDS
  Pose _pose{0, 0};
  float _bright = 1;
  char _label[64] = {0};
  uint32_t _labelStart = 0, _labelMs = 0;

  float _th[N], _sqf[N];
  float* _cs = nullptr;  // cos/sin/轮廓半径：buildPoly 每次都读，放内部 RAM
  float* _sn = nullptr;
  float* _rr = nullptr;
  float* _rb = nullptr;
  float _lastEx = -1;
  float _hist[HIST][N];
  int _histHead = 0, _histCount = 0;

  // 每帧的派生量
  Acc _acc{};
  float _A[6], _Ai[6];
  float _ppu = 1, _bx = 0, _by = 0, _sc = 1, _lift = 0, _flash = 0, _dimV = 0, _dimF = 1, _gp = 0, _venv = 0;
  // 每帧/每条带都要反复读的轮廓放内部 RAM（PSRAM 的 32KB 数据缓存被相机帧冲刷，命中率很差）
  float* _px = nullptr;
  float* _py = nullptr;
  float _cum[N + 1];                                // 外圈轮廓（画布坐标）
  float* _bodyX = nullptr;                          // 玻璃身体
  float* _bodyY = nullptr;
  float _dX[N + 2], _dY[N + 2], _hX[N + 2], _hY[N + 2];  // 描边动画 / 高亮光段
  int _dN = 0, _hN = 0;
  float* _qx = nullptr;  // 临时
  float* _qy = nullptr;
  float* _ux = nullptr;
  float* _uy = nullptr;
  float* _geo = nullptr;  // 上面 8 组轮廓 + 下面 4 张查表的一整块内部 RAM
};

}  // namespace pulse
