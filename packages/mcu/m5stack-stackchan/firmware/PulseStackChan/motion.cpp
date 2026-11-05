// 脉冲 Pulse · 头部动作（原创代码，不依赖硬件）
#include "motion.h"
#include <math.h>
#include <string.h>

namespace motion {

namespace {

constexpr float kPi = 3.14159265f, kTau = 6.28318531f;
enum : uint8_t { E_SMOOTH = 0, E_SPLINE, E_LINEAR, E_OUT, E_IN };
enum : uint8_t { F_HOLD = 1, F_PROC = 2, F_LOOP = 4 };

// 关键帧：时间（毫秒）、左右、上下（度；上下负 = 抬头）、到这一帧用的缓动
struct Key { uint16_t ms; int8_t pan, tilt; uint8_t ease; };

// ---- 关键帧表（按官方 StackChan 机身设计：上下 -40…+12 度，社区版机身会自动缩小上下幅度）----
const Key kNod[] = {{0, 0, 0, 0}, {110, 0, -5, 0}, {260, 0, 9, 0}, {420, 0, -2, 0}, {580, 0, 0, 0}};
// 和 home_nod_x3 同步：三次低头分别在约 0.1 / 0.54 / 0.97 秒
const Key kNod3[] = {{0, 0, 0, 0}, {100, 0, 9, 3}, {300, 0, -5, 0}, {540, 0, 9, 3}, {740, 0, -5, 0}, {970, 0, 9, 3}, {1170, 0, -3, 0}, {1400, 0, 0, 0}};
const Key kNodSlow[] = {{0, 0, 0, 0}, {300, 0, -8, 0}, {760, 0, 11, 0}, {1300, 0, 0, 0}};
const Key kShake[] = {{0, 0, 0, 0}, {160, -18, 0, 1}, {360, 18, 0, 1}, {560, -14, 0, 1}, {760, 10, 0, 1}, {1000, 0, 0, 1}};
const Key kHm[] = {{0, 0, 0, 0}, {220, 18, -9, 3}, {1500, 15, -7, 0}, {2000, 0, 0, 0}};
const Key kLookAround[] = {{0, 0, 0, 0}, {450, -38, -6, 0}, {1000, -38, -8, 0}, {1600, 38, -8, 0}, {2150, 38, -6, 0}, {2700, 0, 0, 0}};
const Key kHey[] = {{0, 0, 0, 0}, {130, 0, -15, 3}, {320, 0, -10, 0}, {750, 0, -4, 0}, {1000, 0, 0, 0}};
const Key kHop[] = {{0, 0, 0, 0}, {90, 0, -12, 3}, {200, 0, 3, 4}, {300, 0, -9, 3}, {420, 0, 2, 4}, {650, 0, 0, 0}};
const Key kGiggle[] = {{0, 0, 0, 0}, {60, 9, -4, 1}, {170, -9, -3, 1}, {280, 9, -4, 1}, {390, -8, -3, 1}, {480, 6, -2, 1}, {600, -3, -1, 1}, {750, 0, 0, 1}};
const Key kSurprise[] = {{0, 0, 0, 0}, {80, 0, -20, 3}, {230, 0, -13, 0}, {400, 0, -17, 0}, {700, 0, -12, 0}, {1300, 0, 0, 0}};
const Key kJolt[] = {{0, 0, 0, 0}, {50, 6, -4, 2}, {100, -6, -5, 2}, {150, 5, -4, 2}, {200, -5, -3, 2}, {260, 3, -2, 2}, {420, 0, 0, 0}};
const Key kDroop[] = {{0, 0, 0, 0}, {700, 4, 5, 0}, {1800, 10, 12, 0}};
const Key kWake[] = {{0, 0, 0, 0}, {380, 0, -16, 3}, {540, -8, -13, 1}, {700, 8, -13, 1}, {860, -5, -11, 1}, {1050, 0, -9, 1}, {1500, 0, 0, 0}};
const Key kShy[] = {{0, 0, 0, 0}, {300, -24, 6, 3}, {800, -20, 8, 0}, {1200, -23, 6, 0}};
const Key kProud[] = {{0, 0, 0, 0}, {120, 0, -12, 3}, {380, 0, -8, 0}, {520, 0, -22, 3}, {850, 7, -22, 1}, {1150, -7, -22, 1}, {1450, 0, -20, 1}, {1900, 0, 0, 0}};
const Key kSigh[] = {{0, 0, 0, 0}, {150, 0, -4, 0}, {650, 0, 9, 0}, {1300, 0, 0, 0}};
const Key kListen[] = {{0, 0, 0, 0}, {450, 12, -11, 0}};
const Key kBroadcast[] = {{0, 0, 0, 0}, {350, -40, -7, 0}, {1500, 40, -7, 0}, {1900, 0, 0, 0}};
const Key kSend[] = {{0, 0, 0, 0}, {150, 0, -7, 0}, {320, 0, 8, 3}, {700, 0, 0, 0}};
const Key kThink[] = {{0, 0, 0, 0}, {500, 22, -17, 0}};    // 和 30「思考中」的视线一致：右上
const Key kRecall[] = {{0, 0, 0, 0}, {500, -22, -16, 0}};  // 和 37「复述回忆」的视线一致：左上
const Key kSearch[] = {{0, 0, 0, 0}, {300, -26, 4, 1}, {700, 26, 5, 1}, {1100, -26, 4, 1}, {1500, 26, 5, 1}, {1900, 0, 0, 1}};
// Deliberate shakes remain visible through the 35 deg/s face-tracking limit;
// 60 ms reversals were largely lost at the servo and at a slow display rate.
// A short dwell gives the slower physical head time to complete the left sweep.
const Key kAngry[] = {{0, 0, 0, 0}, {450, 14, 5, 0}, {1050, -14, 7, 0},
                      {1200, -14, 7, 0}, {1800, 10, 6, 0}, {2400, 0, 0, 0}};
const Key kStop[] = {{0, 0, 0, 0}, {140, 0, 5, 3}, {550, 0, 0, 0}};
const Key kStretch[] = {{0, 0, 0, 0}, {800, 0, -34, 0}, {1500, 3, -35, 0}, {2300, 0, 0, 0}};
const Key kPet[] = {{0, 0, 0, 0}, {300, 4, -18, 3}, {650, -4, -21, 1}, {1000, 3, -19, 1}, {1300, 0, -20, 1}};
const Key kTrack[] = {{0, 0, 0, 0}, {700, -30, -7, 0}, {1200, -30, -6, 0}, {2200, 28, -8, 0}, {2700, 28, -7, 0}, {3400, 0, -6, 0}, {3800, 0, 0, 0}};
const Key kDaze[] = {{0, 0, 0, 0}, {1200, -12, 6, 0}};
const Key kSad[] = {{0, 0, 0, 0}, {1200, 8, 10, 0}};
const Key kTired[] = {{0, 0, 0, 0}, {900, 0, 7, 0}, {1600, 0, 5, 0}, {2300, 0, 10, 0}, {2700, 0, 7, 0}};
const Key kFocus[] = {{0, 0, 0, 0}, {400, 0, -7, 0}};
const Key kMeh[] = {{0, 0, 0, 0}, {300, -10, 4, 1}, {750, 10, 5, 1}, {1200, -6, 4, 1}, {1600, 0, 3, 1}};
const Key kBoot[] = {{0, 0, 0, 0}, {500, 0, -10, 0}, {950, -16, -8, 0}, {1450, 16, -8, 0}, {1900, 0, -4, 0}, {2300, 0, 0, 0}};
const Key kError[] = {{0, 0, 0, 0}, {60, 0, -8, 3}, {200, -10, -4, 1}, {350, 10, -4, 1}, {500, -7, -2, 1}, {650, 0, 0, 1}};
const Key kLookUp[] = {{0, 0, 0, 0}, {250, 0, -22, 3}};
const Key kFlinch[] = {{0, 0, 0, 0}, {70, 9, -3, 3}, {380, 0, 0, 0}};
const Key kLookLeft[] = {{0, 0, 0, 0}, {700, -35, 0, 0}};
const Key kLookRight[] = {{0, 0, 0, 0}, {700, 35, 0, 0}};
const Key kLookDown[] = {{0, 0, 0, 0}, {500, 0, 12, 0}};

struct ActDef { const char* name; const Key* k; uint8_t n; uint8_t flags; uint16_t procMs; };
#define KEYS(a) a, (uint8_t)(sizeof(a) / sizeof(a[0]))
const ActDef kActs[A_COUNT] = {
  {"none", nullptr, 0, 0, 0},
  {"nod", KEYS(kNod), 0, 0},
  {"nod3", KEYS(kNod3), 0, 0},
  {"nod_slow", KEYS(kNodSlow), 0, 0},
  {"shake", KEYS(kShake), 0, 0},
  {"hm", KEYS(kHm), 0, 0},
  {"look_around", KEYS(kLookAround), 0, 0},
  {"hey", KEYS(kHey), 0, 0},
  {"hop", KEYS(kHop), 0, 0},
  {"giggle", KEYS(kGiggle), 0, 0},
  {"dance", nullptr, 0, F_PROC, 2800},
  {"dizzy", nullptr, 0, F_PROC, 1700},
  {"surprise", KEYS(kSurprise), 0, 0},
  {"jolt", KEYS(kJolt), 0, 0},
  {"droop", KEYS(kDroop), F_HOLD, 0},
  {"wake", KEYS(kWake), 0, 0},
  {"shy", KEYS(kShy), F_HOLD, 0},
  {"proud", KEYS(kProud), 0, 0},
  {"sigh", KEYS(kSigh), 0, 0},
  {"listen", KEYS(kListen), F_HOLD, 0},
  {"broadcast", KEYS(kBroadcast), 0, 0},
  {"send", KEYS(kSend), 0, 0},
  {"think", KEYS(kThink), F_HOLD, 0},
  {"recall", KEYS(kRecall), F_HOLD, 0},
  {"search", KEYS(kSearch), 0, 0},
  {"panic", nullptr, 0, F_PROC, 1600},
  {"angry", KEYS(kAngry), F_HOLD, 0},
  {"stop", KEYS(kStop), 0, 0},
  {"talk", nullptr, 0, F_PROC, 800},
  {"busy", nullptr, 0, F_PROC | F_LOOP, 1000},
  {"stretch", KEYS(kStretch), 0, 0},
  {"pet", KEYS(kPet), F_HOLD, 0},
  {"track", KEYS(kTrack), 0, 0},
  {"daze", KEYS(kDaze), F_HOLD, 0},
  {"sad", KEYS(kSad), F_HOLD, 0},
  {"tired", KEYS(kTired), F_HOLD, 0},
  {"focus", KEYS(kFocus), F_HOLD, 0},
  {"meh", KEYS(kMeh), F_HOLD, 0},
  {"boot", KEYS(kBoot), 0, 0},
  {"error", KEYS(kError), 0, 0},
  {"look_up", KEYS(kLookUp), F_HOLD, 0},
  {"flinch", KEYS(kFlinch), 0, 0},
  {"look_left", KEYS(kLookLeft), F_HOLD, 0},
  {"look_right", KEYS(kLookRight), F_HOLD, 0},
  {"look_down", KEYS(kLookDown), F_HOLD, 0},
};
#undef KEYS

inline float clampf(float v, float a, float b) { return v < a ? a : (v > b ? b : v); }
inline float smooth01(float u) {
  u = clampf(u, 0.f, 1.f);
  return u * u * (3.f - 2.f * u);
}
inline float easeK(uint8_t e, float u) {
  switch (e) {
    case E_LINEAR: return u;
    case E_OUT: { const float v = 1.f - u; return 1.f - v * v * v; }
    case E_IN: return u * u * u;
    default: return u * u * (3.f - 2.f * u);
  }
}
inline float catmull(float p0, float p1, float p2, float p3, float u) {
  const float u2 = u * u, u3 = u2 * u;
  return .5f * ((2.f * p1) + (-p0 + p2) * u + (2.f * p0 - 5.f * p1 + 4.f * p2 - p3) * u2 + (-p0 + 3.f * p1 - 3.f * p2 + p3) * u3);
}

void keyAt(const Key* k, int n, float ms, float& p, float& q) {
  if (ms <= k[0].ms) { p = k[0].pan; q = k[0].tilt; return; }
  if (ms >= k[n - 1].ms) { p = k[n - 1].pan; q = k[n - 1].tilt; return; }
  int i = 0;
  while (i < n - 2 && ms >= k[i + 1].ms) i++;
  const Key& a = k[i];
  const Key& b = k[i + 1];
  const float u = (ms - a.ms) / (float)(b.ms - a.ms);
  if (b.ease == E_SPLINE) {
    const Key& a0 = k[i > 0 ? i - 1 : i];
    const Key& b1 = k[i + 2 < n ? i + 2 : i + 1];
    p = catmull(a0.pan, a.pan, b.pan, b1.pan, u);
    q = catmull(a0.tilt, a.tilt, b.tilt, b1.tilt, u);
  } else {
    const float s = easeK(b.ease, u);
    p = a.pan + (b.pan - a.pan) * s;
    q = a.tilt + (b.tilt - a.tilt) * s;
  }
}

inline uint32_t hash32(uint32_t x) {
  x ^= x >> 16; x *= 0x7feb352du;
  x ^= x >> 15; x *= 0x846ca68bu;
  x ^= x >> 16;
  return x;
}
inline float hashf(uint32_t x) { return (hash32(x) & 0xFFFFFF) / 16777215.f; }

}  // namespace

Limits limitsFor(uint8_t servoType) {
  if (servoType == 3) return Limits{70.f, -40.f, 12.f, 1.f};  // 官方机身：上下有 50 多度的空间
  return Limits{45.f, -12.f, 10.f, .45f};                     // 社区版 Stack-chan：上下空间小
}

const char* actName(uint8_t a) { return a < A_COUNT ? kActs[a].name : "?"; }
bool isDirectionalAction(uint8_t a) {
  return a == A_LOOK_UP || a == A_LOOK_LEFT || a == A_LOOK_RIGHT || a == A_LOOK_DOWN;
}

int findAct(const char* name) {
  if (!name) return -1;
  for (int i = 0; i < A_COUNT; i++)
    if (!strcmp(kActs[i].name, name)) return i;
  return -1;
}

float actDuration(uint8_t a) {
  if (a == A_NONE || a >= A_COUNT) return 0.f;
  const ActDef& d = kActs[a];
  if (d.flags & F_PROC) return d.procMs * .001f;
  return d.k[d.n - 1].ms * .001f;
}

uint8_t actForState(int s) {
  switch (s) {
    case 0: return A_DROOP;
    case 1: return A_WAKE;
    case 3: return A_HM;
    case 4: return A_DAZE;
    case 5: return A_BOOT;
    case 6: return A_DROOP;
    case 7: return A_JOLT;
    case 10: return A_HOP;
    case 11: return A_HM;
    case 12: return A_SAD;
    case 13: return A_SURPRISE;
    case 14: return A_SHY;
    case 15: return A_TIRED;
    case 16: return A_FOCUS;
    case 17: return A_PANIC;
    case 18: return A_MEH;
    case 19: return A_NOD_SLOW;
    case 20: return A_DIZZY;
    case 21: return A_ANGRY;
    case 30: return A_THINK;
    case 31: return A_NOD;
    case 32: return A_BUSY;
    case 33: return A_PROUD;
    case 34: return A_ERROR;
    case 35: return A_LISTEN;
    case 36: return A_BROADCAST;
    case 37: return A_RECALL;
    case 38: return A_SHAKE;
    case 39: return A_TALK;
    case 40: return A_SEARCH;
    case 41: return A_STOP;
    default: return A_NONE;
  }
}

Planner::Planner() {}

float Planner::rnd() {
  _rng = _rng * 1664525u + 1013904223u;
  return ((_rng >> 8) & 0xFFFFFF) / 16777215.f;
}

void Planner::play(uint8_t act, float scale, float dir) {
  if (act >= A_COUNT) return;
  if (act == A_NONE) { release(); return; }
  if (_direction) handBackDirection(.25f);
  _fromP = _offP;
  _fromQ = _offQ;
  _fromDur = (act == A_SURPRISE || act == A_JOLT || act == A_FLINCH || act == A_HEY) ? .12f : .25f;
  _act = act;
  _at = 0;
  _scale = scale;
  _dir = dir < 0 ? -1.f : 1.f;
  _relT = -1;
  _seed = (uint32_t)(rnd() * 1e6f) + 1;
}

bool Planner::playDirection(uint8_t act, float scale) {
  if (!isDirectionalAction(act) || !isfinite(scale) || scale < 0.f || scale > 1.f) return false;
  const float pan = _pan, tilt = _tilt;
  play(act, scale);
  _direction = true; _dReleaseT = -1;
  _dFromP = _dGoalP = pan; _dFromQ = _dGoalQ = tilt;
  const Key& target = kActs[act].k[kActs[act].n - 1];
  if (target.pan) _dGoalP = clampf(target.pan * scale * _amp, -_lim.panMax, _lim.panMax);
  else _dGoalQ = clampf(target.tilt * scale * _amp * _lim.tiltScale, _lim.tiltUp, _lim.tiltDown);
  // Preserve the old spring target for ordinary callers, but no old velocity
  // or underlying composition is allowed to move this explicit physical pose.
  _vx = _vy = 0; _idleNew = false;
  return true;
}

void Planner::directionPose(float t, float& p, float& q) const {
  const auto& def = kActs[_act];
  const float u = easeK(def.k[def.n - 1].ease, clampf(t / actDuration(_act), 0.f, 1.f));
  p = _dFromP + (_dGoalP - _dFromP) * u;
  q = _dFromQ + (_dGoalQ - _dFromQ) * u;
}

void Planner::handBackDirection(float seconds) {
  _direction = false;
  // A directed look is a gaze owner, not an offset to consume into a second
  // gesture. Seed ordinary/face handback at the actual commanded pose once.
  _faceLook = false;
  _lx = _amp > 0.f ? _pan / _amp : 0.f;
  const float tiltGain = _amp * _lim.tiltScale;
  _ly = tiltGain > 0.f ? _tilt / tiltGain : 0.f;
  _tx = _lx; _ty = _ly; _vx = _vy = 0;
  _offP = _offQ = 0;
  _dReleaseP = _pan; _dReleaseQ = _tilt;
  _dReleaseT = 0; _dReleaseDur = seconds > .05f ? seconds : .05f;
}

void Planner::release(float sec) {
  if (_direction) {
    handBackDirection(sec); _act = A_NONE; _relT = -1; return;
  }
  _relP = _offP;
  _relQ = _offQ;
  _relT = 0;
  _relDur = sec > .05f ? sec : .05f;
  _act = A_NONE;
}

bool Planner::busy() const {
  if (_act == A_NONE) return _relT >= 0 || _dReleaseT >= 0;
  const ActDef& d = kActs[_act];
  if (d.flags & F_LOOP) return true;
  return _at < actDuration(_act);
}

void Planner::lookAt(float pan, float tilt, float speed) {
  _tx = pan;
  _ty = tilt;
  _ls = clampf(speed, .2f, 3.f);
}

float Planner::physicalLookPan() const {
  if (!(_amp > 0.f)) return 0.f;
  return clampf(_faceLook ? _lx : _lx * _amp, -_lim.panMax, _lim.panMax);
}

float Planner::physicalLookTilt() const {
  if (!(_amp > 0.f)) return 0.f;
  return clampf(_faceLook ? _ly : _ly * _amp * _lim.tiltScale,
                _lim.tiltUp, _lim.tiltDown);
}

void Planner::setFaceLook(bool enabled, float pan, float tilt) {
  if (enabled && (!isfinite(pan) || !isfinite(tilt))) return;
  if (enabled != _faceLook && _amp > 0.f && _lim.tiltScale > 0.f) {
    // Ordinary gaze uses pre-amplitude coordinates; tracked gaze uses physical
    // degrees. Convert the spring, not its stored ordinary target, so toggling
    // tracking at a nonzero angle cannot jump the composed head position.
    const float panGain = _amp, tiltGain = _amp * _lim.tiltScale;
    const float panFactor = enabled ? panGain : 1.f / panGain;
    const float tiltFactor = enabled ? tiltGain : 1.f / tiltGain;
    _lx *= panFactor; _vx *= panFactor;
    _ly *= tiltFactor; _vy *= tiltFactor;
  }
  _faceLook = enabled;
  if (!enabled) return;
  _facePan = clampf(pan, -_lim.panMax, _lim.panMax);
  _faceTilt = clampf(tilt, _lim.tiltUp, _lim.tiltDown);
  _idleNew = false;
}

void Planner::setIdle(bool on, float scale) {
  if (on && !_idle) _idleT = .8f + rnd() * 1.5f;
  _idle = on;
  _idleScale = scale;
}

bool Planner::takeIdleLook(float& pan, float& tilt) {
  if (!_idleNew) return false;
  _idleNew = false;
  pan = _tx;
  tilt = _ty;
  return true;
}

void Planner::setGroove(float amp, float phase, float beatsPerSec) {
  _gT = isfinite(amp) ? clampf(amp, 0.f, 1.f) : 0.f;
  if (isfinite(phase)) _gPh = phase - 2.f * floorf(phase * .5f);  // 两拍一个来回：只留 0–2
  _gRate = isfinite(beatsPerSec) ? clampf(beatsPerSec, 0.f, 4.f) : 0.f;
}

void Planner::setBreath(float amp, float period) {
  _brA = amp;
  _brP = period > .5f ? period : .5f;
}

void Planner::actOffset(float t, float& p, float& q) const {
  p = q = 0;
  const ActDef& d = kActs[_act];
  if (!(d.flags & F_PROC)) {
    if (d.k) keyAt(d.k, d.n, t * 1000.f, p, q);
    return;
  }
  const float T = d.procMs * .001f;
  switch (_act) {
    case A_DIZZY: {  // 画两圈多，越转越小
      const float u = clampf(t / T, 0.f, 1.f);
      const float r = powf(1.f - u, .8f) * smooth01(t / .15f);
      const float th = kTau * 2.2f * u;
      p = 16.f * r * sinf(th);
      q = -6.f * r - 7.f * r * cosf(th);
    } break;
    case A_DANCE: {  // 和 track_lalala 同拍：每 0.5 秒一个「啦」，每拍摆到一边、低一下头
      const float pb = (t - .05f) / .497f;
      const float env = smooth01(t / .25f) * smooth01((T - t) / .35f);
      const float c = cosf(kPi * pb);
      const float bob = cosf(kTau * pb);
      p = 16.f * env * c;
      q = env * (-3.f + 6.f * (bob > 0.f ? bob * bob : 0.f));
    } break;
    case A_TALK: {
      const float env = smooth01(t / .1f) * smooth01((T - t) / .15f);
      p = env * 3.f * sinf(kTau * .9f * t);
      q = env * (-2.f + 3.f * fabsf(sinf(kTau * 2.8f * t)));
    } break;
    case A_BUSY: {
      const float env = smooth01(t / .3f);
      p = env * 2.f * sinf(kTau * 1.f * t);
      q = env * 2.f * sinf(kTau * 2.f * t);
    } break;
    case A_PANIC: {  // 每 0.16 秒换一个方向乱看
      const float seg = .16f;
      const int k = (int)(t / seg);
      auto tgt = [&](int i, float& x, float& y) {
        if (i < 0) { x = y = 0; return; }
        x = (hashf(_seed * 31u + i * 2u) * 2.f - 1.f) * 24.f;
        y = -10.f + hashf(_seed * 31u + i * 2u + 1u) * 14.f;
      };
      float x0, y0, x1, y1;
      tgt(k - 1, x0, y0);
      tgt(k, x1, y1);
      const float u = clampf((t - k * seg) / (seg * .45f), 0.f, 1.f);
      const float s = 1.f - (1.f - u) * (1.f - u) * (1.f - u);
      const float env = smooth01((T - t) / .25f);
      p = (x0 + (x1 - x0) * s) * env;
      q = (y0 + (y1 - y0) * s) * env;
    } break;
    default: break;
  }
}

void Planner::lead(float sec, float& pan, float& tilt) const {
  if (_direction) { directionPose(_at + sec, pan, tilt); return; }
  float p = 0, q = 0;
  if (_act != A_NONE) {
    const ActDef& d = kActs[_act];
    const float t = _at + sec;
    if ((d.flags & (F_HOLD | F_LOOP)) || t < actDuration(_act)) {
      actOffset(t, p, q);
      p *= _scale * _dir;
      q *= _scale;
    }
  } else if (_relT >= 0) {
    const float s = smooth01((_relT + sec) / _relDur);
    p = _relP * (1.f - s);
    q = _relQ * (1.f - s);
  }
  pan = targetPan() + p;
  tilt = targetTilt() + q;
}

void Planner::update(float dt) {
  if (!isfinite(dt) || dt <= 0.f) return;
  // 普通慢帧按真实时间演进，弹簧和动作以小步积分，不能把 9 fps 当成 20 fps。
  // 设置等长时间阻塞应由 app 重置时钟；意外的大停顿也不追赶一整段动作。
  if (dt > 1.f) { _vx = _vy = 0.f; return; }
  float remaining = dt;
  while (remaining > 0.f) {
    const float step = remaining > .02f ? .02f : remaining;
    updateStep(step);
    remaining -= step;
  }
}

void Planner::updateStep(float dt) {
  // ---- 动作 ----
  float p = 0, q = 0;
  if (_act != A_NONE) {
    _at += dt;
    const ActDef& d = kActs[_act];
    const float T = actDuration(_act);
    float t = _at;
    if (d.flags & F_LOOP) t = _at;  // 循环型：一直算下去
    actOffset(t, p, q);
    p *= _scale * _dir;
    q *= _scale;
    if (_at < _fromDur) {
      const float s = smooth01(_at / _fromDur);
      p += _fromP * (1.f - s);
      q += _fromQ * (1.f - s);
    }
    if (!(d.flags & (F_HOLD | F_LOOP)) && _at >= T) {
      _act = A_NONE;
      p = q = 0;
    }
  } else if (_relT >= 0) {
    _relT += dt;
    const float s = smooth01(_relT / _relDur);
    p = _relP * (1.f - s);
    q = _relQ * (1.f - s);
    if (_relT >= _relDur) _relT = -1;
  }
  _offP = p;
  _offQ = q;

  // ---- 跟着音乐摇摆（2.9）：两拍左右摆一个来回，每一拍轻轻点一下头 ----
  _gA += (_gT - _gA) * clampf(dt / .35f, 0.f, 1.f);
  if (_gA > .002f) {
    _gPh += dt * _gRate;
    if (_gPh >= 2.f) _gPh -= 2.f;
    const float c = cosf(kTau * _gPh);
    const float bounce = c > 0.f ? c * c : 0.f;
    p += 16.f * _gA * cosf(kTau * .5f * _gPh);
    q += _gA * (-3.f + 6.f * bounce);
  } else {
    _gA = 0.f;
  }

  // ---- 自己东张西望（有动作的时候先停下） ----
  if (_idle && !_faceLook && !busy() && !_direction) {
    _idleT -= dt;
    if (_idleT <= 0) {
      const float r = rnd();
      float tx, ty;
      if (r < .3f) {  // 回到前方附近
        tx = (rnd() * 2.f - 1.f) * 6.f;
        ty = -3.f - rnd() * 6.f;
      } else {
        const float side = rnd() < .5f ? -1.f : 1.f;
        tx = side * (14.f + rnd() * 26.f) * _idleScale;
        ty = (-rnd() * 20.f + rnd() * 3.f) * _idleScale;
      }
      lookAt(tx, ty, .45f + rnd() * .35f);
      _idleNew = true;
      _idleT = 2.5f + rnd() * 4.f;
    }
  }

  // ---- 视线弹簧（临界阻尼：自然地加速、减速，不会过冲） ----
  const float w = 7.f * (_faceLook ? 1.f : _ls);
  const float tx = targetPan(), ty = targetTilt();
  float rem = dt;
  while (rem > 1e-5f) {
    const float h = rem > .01f ? .01f : rem;
    rem -= h;
    _vx += (w * w * (tx - _lx) - 2.f * w * _vx) * h;
    _vy += (w * w * (ty - _ly) - 2.f * w * _vy) * h;
    _vx = clampf(_vx, -280.f, 280.f);
    _vy = clampf(_vy, -200.f, 200.f);
    _lx += _vx * h;
    _ly += _vy * h;
  }

  // ---- 呼吸 ----
  _brT += dt;
  if (_brT > 1000.f) _brT -= 1000.f;
  const float br = _brA * sinf(kTau * _brT / _brP);

  // ---- 合成、限幅 ----
  float outP = 0, outQ = 0;
  if (_amp > 0.f) {
    if (_faceLook) {
      // Face controller angles are already physical degrees. Amplitude and the
      // small-body tilt scale apply only to the gesture layered on that gaze.
      outP = _lx + p * _amp + _bPan * .4f;
      outQ = _ly + q * _lim.tiltScale * _amp + br * _lim.tiltScale + _bTilt * .4f * _lim.tiltScale;
    } else {
      outP = (_lx + p) * _amp + _bPan * .4f;
      outQ = (_ly + q) * _lim.tiltScale * _amp + br * _lim.tiltScale + _bTilt * .4f * _lim.tiltScale;
    }
  }
  if (_direction && _amp > 0.f) {
    // This lane owns the final physical command. Even residual groove, breath,
    // a changing expression base or an old gesture cannot move the other axis.
    directionPose(_at, outP, outQ);
  } else if (_dReleaseT >= 0.f) {
    _dReleaseT += dt;
    const float blend = smooth01(_dReleaseT / _dReleaseDur);
    if (_amp > 0.f) {
      outP = _dReleaseP + (outP - _dReleaseP) * blend;
      outQ = _dReleaseQ + (outQ - _dReleaseQ) * blend;
    }
    if (_dReleaseT >= _dReleaseDur) _dReleaseT = -1;
  }
  outP = clampf(outP, -_lim.panMax, _lim.panMax);
  outQ = clampf(outQ, _lim.tiltUp, _lim.tiltDown);
  const float v = (fabsf(outP - _pan) + fabsf(outQ - _tilt)) / dt;
  _vig += (v - _vig) * clampf(dt / .15f, 0.f, 1.f);
  _pan = outP;
  _tilt = outQ;
}

}  // namespace motion
