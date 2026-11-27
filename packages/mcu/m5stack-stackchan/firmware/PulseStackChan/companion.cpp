// 脉冲 Pulse · 陪伴系统（原创代码，不依赖硬件）
#include "companion.h"
#include <math.h>
#include <string.h>

namespace companion {

namespace {
inline float clampf(float v, float a, float b) { return v < a ? a : (v > b ? b : v); }
inline float approach(float v, float target, float dt, float tau) { return v + (target - v) * (1.f - expf(-dt / tau)); }

// 每种刺激对 开心 / 兴奋 / 精神 / 想人陪 的影响
struct Delta { float v, a, e, s; };
const Delta kStim[ST_COUNT] = {
  {+.08f, +.08f, +.01f, -.10f},  // ST_TOUCH
  {+.04f, +.02f, 0.f, -.05f},    // ST_STROKE
  {+.07f, -.06f, 0.f, -.08f},    // ST_HOLD：安心，反而平静下来
  {-.10f, +.15f, 0.f, 0.f},      // ST_OVERTOUCH
  {-.40f, +.35f, +.05f, 0.f},    // ST_SHAKE：晕，有点委屈
  {-.08f, +.25f, +.03f, 0.f},    // ST_JOLT
  {+.07f, +.06f, 0.f, -.15f},    // ST_FACE
  {+.02f, +.06f, 0.f, -.04f},    // ST_NEAR
  {+.09f, +.10f, +.01f, -.25f},  // ST_CHAT
  {+.08f, +.12f, 0.f, -.05f},    // ST_PLAY
  {0.f, +.15f, +.04f, 0.f},      // ST_WAKE
  {0.f, -.30f, 0.f, 0.f},        // ST_SLEEP
  {0.f, -.08f, 0.f, 0.f},        // ST_DARK
  {+.02f, +.08f, 0.f, 0.f},      // ST_LIGHT
  {+.06f, +.02f, +.05f, 0.f},    // ST_CHARGE
};

const uint32_t kLevelPts[kLevels] = {0, 20, 60, 130, 230, 380, 580, 850, 1200, 1700};
const char* const kLevelNames[kLevels] = {"初次见面", "有点眼熟", "小伙伴", "好朋友", "形影不离",
                                          "心有灵犀", "最佳拍档", "家人", "挚友", "一生挚友"};
const uint16_t kEventPts16[B_COUNT] = {
  16,  // B_TOUCH：一次触摸 1 点
  4,   // B_PET：摸一下 0.25 点（每次触摸最多算 6 下，由调用方限制）
  8,   // B_HOLD：0.5 点
  24,  // B_FACE：久别重逢 1.5 点
  32,  // B_CHAT：说一句话 2 点
  8,   // B_PLAY：0.5 点
  4,   // B_NEAR：0.25 点
  80,  // B_DAILY：今天第一次见面 5 点（不递减）
};
constexpr uint32_t kTier1 = 40 * kUnit, kTier2 = 80 * kUnit;  // 每天前 40 点全额，40–80 点一半，之后四分之一
constexpr float kMinHold = 6.f;  // 基调最短保持秒数（强烈的变化除外）

bool strongTone(uint8_t t) { return t == T_GRUMPY || t == T_EXCITED; }
}  // namespace

const uint16_t kMilestoneDays[kMilestones] = {7, 30, 100, 365, 520, 1000};

const char* toneName(uint8_t t) {
  static const char* const k[T_COUNT] = {"平静", "开心", "满足", "想玩", "想你了", "困了", "有点委屈", "兴奋"};
  return t < T_COUNT ? k[t] : "?";
}
const char* toneKey(uint8_t t) {
  static const char* const k[T_COUNT] = {"calm", "joyful", "content", "playful", "lonely", "sleepy", "grumpy", "excited"};
  return t < T_COUNT ? k[t] : "unknown";
}

void reset(Affect& a) {
  a.valence = .25f;
  a.arousal = .35f;
  a.energy = .85f;
  a.social = .3f;
  a.warmth = 0.f;
  a.tone = T_CALM;
  a.toneAge = 0.f;
  a.tone = classify(a);
}

uint8_t classify(const Affect& a) {
  if (a.energy < .22f) return T_SLEEPY;
  if (a.valence < -.12f) return T_GRUMPY;
  if (a.arousal > .72f && a.valence > .15f) return T_EXCITED;
  if (a.social > .65f && a.valence < .5f) return T_LONELY;
  if (a.valence > .5f && a.arousal > .45f) return T_JOYFUL;
  if (a.valence > .3f && a.arousal > .5f) return T_PLAYFUL;
  if (a.valence > .38f) return T_CONTENT;
  return T_CALM;
}

static void retone(Affect& a, bool force) {
  const uint8_t c = classify(a);
  if (c == a.tone) return;
  if (force || a.toneAge >= kMinHold || strongTone(c)) {
    a.tone = c;
    a.toneAge = 0.f;
  }
}

void update(Affect& a, float dt, const AffectContext& ctx) {
  if (!(dt > 0.f)) return;  // 也挡住 NaN
  if (dt > 600.f) dt = 600.f;
  a.warmth = clampf(ctx.warmth, 0.f, 1.f);
  const float baseV = .12f + .18f * a.warmth + (ctx.company ? .10f : 0.f);
  const float baseA = ctx.sleeping ? .05f : (ctx.night ? .18f : .32f) + (ctx.company ? .08f : 0.f);
  a.valence = clampf(approach(a.valence, baseV, dt, 240.f), -1.f, 1.f);
  a.arousal = clampf(approach(a.arousal, baseA, dt, 45.f), 0.f, 1.f);
  if (ctx.sleeping) a.energy += dt / (25.f * 60.f);                 // 睡 25 分钟回满
  else a.energy -= dt / (ctx.night ? 90.f * 60.f : 4.f * 3600.f);   // 白天 4 小时、夜里 1.5 小时耗完
  a.energy = clampf(a.energy, .03f, 1.f);
  if (ctx.company) a.social -= dt / 120.f;
  else a.social += dt / (ctx.sleeping ? 6.f * 3600.f : 15.f * 60.f);
  a.social = clampf(a.social, 0.f, 1.f);
  a.toneAge += dt;
  retone(a, false);
}

void stimulus(Affect& a, uint8_t stim, float scale) {
  if (stim >= ST_COUNT || !(scale > 0.f)) return;
  if (scale > 3.f) scale = 3.f;
  const Delta& d = kStim[stim];
  float dv = d.v * scale;
  if (dv < 0.f) dv *= 1.f - .4f * a.warmth;  // 越熟越不容易委屈
  a.valence = clampf(a.valence + dv, -1.f, 1.f);
  a.arousal = clampf(a.arousal + d.a * scale, 0.f, 1.f);
  a.energy = clampf(a.energy + d.e * scale, .03f, 1.f);
  a.social = clampf(a.social + d.s * scale, 0.f, 1.f);
  if (stim == ST_SLEEP) a.arousal = a.arousal < .08f ? a.arousal : .08f;
  retone(a, false);
}

// ---------------- 亲密度 ----------------
const char* levelName(uint8_t level) { return kLevelNames[level < kLevels ? level : kLevels - 1]; }
uint32_t levelPoints(uint8_t level) { return kLevelPts[level < kLevels ? level : kLevels - 1]; }
uint8_t levelFor(uint32_t points16) {
  uint8_t l = 0;
  while (l + 1 < kLevels && points16 >= kLevelPts[l + 1] * kUnit) l++;
  return l;
}

uint32_t crc32(const void* data, size_t n) {
  const uint8_t* p = static_cast<const uint8_t*>(data);
  uint32_t c = 0xFFFFFFFFu;
  for (size_t i = 0; i < n; i++) {
    c ^= p[i];
    for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xEDB88320u & (0u - (c & 1u)));
  }
  return ~c;
}

void Bond::reset() {
  memset(&_d, 0, sizeof(_d));
  _d.magic = kBondMagic;
  _d.version = kBondVersion;
  _d.size = sizeof(BondData);
  _dirty = _urgent = false;
  _lastMilestone = -1;
}

bool Bond::load(const void* blob, size_t n) {
  if (!blob || n != sizeof(BondData)) return false;
  BondData d;
  memcpy(&d, blob, sizeof(d));
  if (d.magic != kBondMagic || d.version != kBondVersion || d.size != sizeof(BondData)) return false;
  if (crc32(&d, offsetof(BondData, crc)) != d.crc) return false;
  d.level = levelFor(d.points16);  // 以点数为准
  _d = d;
  _dirty = _urgent = false;
  _lastMilestone = -1;
  return true;
}

const BondData& Bond::save() {
  _d.magic = kBondMagic;
  _d.version = kBondVersion;
  _d.size = sizeof(BondData);
  _d.crc = crc32(&_d, offsetof(BondData, crc));
  return _d;
}

bool Bond::add(uint8_t ev, uint32_t day) {
  if (ev >= B_COUNT) return false;
  const uint32_t raw = kEventPts16[ev];
  uint32_t gain = raw;
  if (ev != B_DAILY) {
    if (_d.todayKey != day) { _d.todayKey = day; _d.today16 = 0; }
    // 分段：今天已得 today16，这次的 raw 落在哪几段就按哪几段的比例算（全是整数，单位 1/16 点）
    uint32_t t = _d.today16, left = raw, eff4 = 0;  // eff4：四倍的有效值，最后再除以 4
    while (left) {
      uint32_t room, mul;
      if (t < kTier1) { room = kTier1 - t; mul = 4; }
      else if (t < kTier2) { room = kTier2 - t; mul = 2; }
      else { room = left; mul = 1; }
      const uint32_t take = left < room ? left : room;
      eff4 += take * mul;
      t += take;
      left -= take;
    }
    _d.today16 = t;
    gain = (eff4 + 2) / 4;
    if (!gain) gain = 1;
  }
  if (ev == B_TOUCH) _d.touches++;
  else if (ev == B_CHAT) _d.chats++;
  else if (ev == B_FACE) _d.faces++;
  const uint32_t before = _d.points16;
  _d.points16 = before + gain < before ? 0xFFFFFFFFu : before + gain;
  _dirty = true;
  const uint8_t l = levelFor(_d.points16);
  if (l > _d.level) {
    _d.level = l;
    _urgent = true;
    return true;
  }
  return false;
}

uint8_t Bond::visit(uint32_t realDay) {
  _lastMilestone = -1;
  if (!realDay) return 0;
  uint8_t flags = 0;
  if (!_d.firstDay || _d.firstDay > realDay) {
    if (!_d.firstDay) flags |= DF_FIRST_MEET;
    _d.firstDay = realDay;
  }
  if (_d.lastDay == realDay) return flags;
  if (_d.lastDay > realDay) {  // 时钟往回跳了（以前对错过时）：从今天重新算，不庆祝
    _d.lastDay = realDay;
    _d.streak = 1;
    _dirty = _urgent = true;
    return flags;
  }
  flags |= DF_NEW_DAY;
  if (_d.lastDay && realDay == _d.lastDay + 1) {
    if (_d.streak < 0xFFFF) _d.streak++;
    if (_d.streak >= 2) flags |= DF_STREAK;
  } else {
    _d.streak = 1;
  }
  if (_d.streak > _d.bestStreak) _d.bestStreak = _d.streak;
  if (_d.daysTogether < 0xFFFF) _d.daysTogether++;
  _d.lastDay = realDay;
  const uint32_t known = daysKnown(realDay);
  for (int i = 0; i < kMilestones; i++) {
    if (known >= kMilestoneDays[i] && !(_d.milestones & (1u << i))) {
      _d.milestones |= (uint16_t)(1u << i);
      // 一次补了好几个（很久没开机）：只庆祝最大的那个，其余静静记下
      _lastMilestone = (int8_t)i;
      flags |= DF_MILESTONE;
    }
  }
  _dirty = _urgent = true;
  return flags;
}

float Bond::progress() const {
  const uint8_t l = _d.level;
  if (l + 1 >= kLevels) return 1.f;
  const float a = (float)levelPoints(l) * kUnit, b = (float)levelPoints(l + 1) * kUnit;
  return clampf(((float)_d.points16 - a) / (b - a), 0.f, 1.f);
}

uint32_t Bond::daysKnown(uint32_t realDay) const {
  if (!realDay || !_d.firstDay || realDay < _d.firstDay) return 0;
  return realDay - _d.firstDay + 1;
}

float Bond::warmth() const { return clampf(((float)_d.level + progress()) / (float)(kLevels - 1), 0.f, 1.f); }

// ---------------- 时间 ----------------
uint8_t period(uint8_t h) {
  if (h >= 5 && h < 10) return PD_MORNING;
  if (h >= 10 && h < 17) return PD_DAY;
  if (h >= 17 && h < 22) return PD_EVENING;
  return PD_NIGHT;
}

bool quietHours(uint8_t h, uint8_t s, uint8_t e) {
  if (s == e) return false;
  return s > e ? (h >= s || h < e) : (h >= s && h < e);
}

Clock clockFromEpoch(int64_t utc, int32_t tz) {
  Clock c;
  if (utc < kMinValidEpoch || tz < -14 * 3600 || tz > 14 * 3600) return c;
  const int64_t local = utc + tz;
  const int64_t day = local / 86400;
  const int64_t sec = local - day * 86400;
  c.valid = true;
  c.day = (uint32_t)day;
  c.hour = (uint8_t)(sec / 3600);
  c.minute = (uint8_t)((sec % 3600) / 60);
  c.wday = (uint8_t)((day + 4) % 7);  // 1970-01-01 是星期四
  return c;
}

int pickWeighted(const float* w, int n, float r) {
  if (!w || n <= 0) return -1;
  float sum = 0.f;
  for (int i = 0; i < n; i++)
    if (w[i] > 0.f) sum += w[i];
  if (!(sum > 0.f)) return -1;
  float x = clampf(r, 0.f, 1.f) * sum;
  int last = -1;
  for (int i = 0; i < n; i++) {
    if (!(w[i] > 0.f)) continue;
    last = i;
    if (x < w[i]) return i;
    x -= w[i];
  }
  return last;
}

}  // namespace companion
