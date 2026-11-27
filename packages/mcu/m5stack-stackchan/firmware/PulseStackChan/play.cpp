// 脉冲 Pulse · 2.9 活泼版：一起玩（原创代码，不依赖硬件）
#include "play.h"
#include <math.h>
#include <stddef.h>
#include <string.h>
#include "companion.h"

namespace play {
namespace {
inline bool due(uint32_t now, uint32_t t) { return (int32_t)(now - t) >= 0; }
inline float clamp01(float v) { return v < 0.f ? 0.f : (v > 1.f ? 1.f : v); }
}  // namespace

// ---------------- 活跃度 ----------------
const char* levelName(uint8_t l) {
  static const char* const k[LV_COUNT] = {"安静", "适中", "活泼"};
  return k[l < LV_COUNT ? l : (uint8_t)LV_LIVELY];
}
const char* levelKey(uint8_t l) {
  static const char* const k[LV_COUNT] = {"quiet", "normal", "lively"};
  return k[l < LV_COUNT ? l : (uint8_t)LV_LIVELY];
}
int parseLevel(const char* s) {
  if (!s) return -1;
  if (!strcmp(s, "quiet") || !strcmp(s, "0") || !strcmp(s, "安静") || !strcmp(s, "low")) return LV_QUIET;
  if (!strcmp(s, "normal") || !strcmp(s, "1") || !strcmp(s, "适中") || !strcmp(s, "mid")) return LV_NORMAL;
  if (!strcmp(s, "lively") || !strcmp(s, "2") || !strcmp(s, "活泼") || !strcmp(s, "high")) return LV_LIVELY;
  return -1;
}
float spontScale(uint8_t l) { return l == LV_LIVELY ? .55f : (l == LV_NORMAL ? .75f : 1.f); }
uint32_t microGap(uint8_t l, float r01) {
  r01 = clamp01(r01);
  if (l == LV_LIVELY) return 8000u + (uint32_t)(12000.f * r01);
  if (l == LV_NORMAL) return 20000u + (uint32_t)(20000.f * r01);
  return 0;
}

// ---------------- 主动邀请 ----------------
const char* bidName(uint8_t b) {
  static const char* const k[BID_COUNT] = {"", "求摸摸", "比心", "蹭蹭", "一起玩", "表演"};
  return b < BID_COUNT ? k[b] : "";
}
const char* bidKey(uint8_t b) {
  static const char* const k[BID_COUNT] = {"none", "pet", "heart", "nuzzle", "play", "show"};
  return b < BID_COUNT ? k[b] : "none";
}

void Bids::reset(uint32_t now) {
  *this = Bids();
  _next = now;
}

uint16_t Bids::dailyCap(uint8_t level) { return level == LV_LIVELY ? 40 : (level == LV_NORMAL ? 16 : 0); }

void Bids::schedule(uint32_t now, uint8_t level, float r01) {
  const float base = level == LV_LIVELY ? 70000.f : 150000.f;
  const float k = 1.8f - 1.2f * clamp01(_ema);  // 你常接：间隔短到 0.6 倍；常不理：拉长到 1.8 倍
  const float j = .7f + .6f * clamp01(r01);     // ±30% 随机
  _next = now + (uint32_t)(base * k * j);
  _scheduled = true;
}

uint8_t Bids::pick(const BidInput& in, float r) const {
  float w[BID_COUNT] = {0.f};
  const float p = clamp01(in.playful), warm = clamp01(in.warmth);
  w[BID_PET] = 1.f + .5f * (1.f - p);
  w[BID_HEART] = .5f + .8f * warm;
  w[BID_NUZZLE] = .6f + .4f * warm;
  w[BID_PLAY] = in.gameOk ? .4f + 1.2f * p : 0.f;
  w[BID_SHOW] = .5f + .6f * p;
  if (_last > BID_NONE && _last < BID_COUNT) w[_last] *= .25f;  // 别连着两次一样
  float sum = 0.f;
  for (int i = 1; i < BID_COUNT; i++) sum += w[i];
  float x = clamp01(r) * sum;
  for (int i = 1; i < BID_COUNT; i++) {
    if (x < w[i]) return (uint8_t)i;
    x -= w[i];
  }
  return BID_PET;
}

uint8_t Bids::tick(const BidInput& in, float r01, float r2) {
  const uint32_t now = in.now;
  if (in.day != _day) {  // 新的一天：重新数
    _day = in.day;
    _today = _todayOk = 0;
  }
  if (_wait != BID_NONE) {
    if (!due(now, _waitUntil)) return BID_NONE;
    _wait = BID_NONE;  // 没理它
    _ema *= .8f;
    ignored++;
    if (++_ignRow >= 3) {  // 连着 3 次没理：先不烦你（活泼 20 分钟 / 适中 40 分钟）
      _ignRow = 0;
      _snooze = true;
      _snoozeUntil = now + (in.level == LV_LIVELY ? 20u : 40u) * 60000u;
      snoozes++;
    }
    schedule(now, in.level, r01);
    return BID_NONE;
  }
  if (_snooze && due(now, _snoozeUntil)) _snooze = false;
  if (in.level != _level) {
    _level = in.level;
    _scheduled = false;
  }
  if (in.level == LV_QUIET || in.level >= LV_COUNT) {
    _scheduled = false;
    return BID_NONE;
  }
  if (!_scheduled) schedule(now, in.level, r01);
  if (_snooze || !in.ready || _today >= dailyCap(in.level) || !due(now, _next)) return BID_NONE;
  if (in.sinceShow < 10000 || in.sinceTouch < 20000) return BID_NONE;  // 刚演完 / 刚摸过：等一会儿
  bool here;
  if (in.camera) here = in.facing && in.facingMs >= 3000;  // 有相机：看着它才邀请
  else here = in.sinceTouch <= 180000 || in.sinceChat <= 180000 || in.sinceNear <= 120000;  // 没相机：刚摸过 / 说过话 / 靠近过
  if (!here) return BID_NONE;
  return pick(in, r2);
}

void Bids::started(uint8_t kind, uint32_t now) {
  if (kind == BID_NONE || kind >= BID_COUNT) return;
  _wait = kind;
  _waitUntil = now + kWindowMs;
  _last = kind;
  if (_today < 0xFFFF) _today++;
  offered++;
  _scheduled = false;
}

uint8_t Bids::respond(uint32_t now) {
  if (_wait == BID_NONE || due(now, _waitUntil)) return BID_NONE;
  const uint8_t k = _wait;
  _wait = BID_NONE;
  _ema = .8f * _ema + .2f;
  _ignRow = 0;
  accepted++;
  if (_todayOk < 0xFFFF) _todayOk++;
  schedule(now, _level, .5f);
  return k;
}

void Bids::cancel() {
  _wait = BID_NONE;
  _scheduled = false;
}

bool Bids::waiting(uint32_t now) const { return _wait != BID_NONE && !due(now, _waitUntil); }
bool Bids::snoozed(uint32_t now) const { return _snooze && !due(now, _snoozeUntil); }
uint32_t Bids::nextIn(uint32_t now) const {
  if (snoozed(now)) return _snoozeUntil - now;
  if (!_scheduled || due(now, _next)) return 0;
  return _next - now;
}

// ---------------- 躲猫猫 ----------------
void Peekaboo::reset() { *this = Peekaboo(); }
uint32_t Peekaboo::cooldown(uint8_t level) { return level == LV_LIVELY ? 45000u : 120000u; }

uint8_t Peekaboo::update(uint32_t now, bool face, bool canStart, bool keep, uint8_t level) {
  const bool was = _face;
  _face = face;
  if (face && !was) _faceSince = now;
  if (_search) {
    if (!keep || level == LV_QUIET) {  // 被别的事打断：不找了（不算一轮）
      _search = _cand = false;
      _streak = 0;
      _started = true;
      _nextOk = now + cooldown(level);
      return PK_NONE;
    }
    if (face) {  // 找到你啦
      _search = _cand = false;
      found++;
      _streak = (_lastFound && now - _lastFound <= kStreakMs + kGiveUpMs) ? (uint8_t)(_streak < 99 ? _streak + 1 : 99) : 1;
      _lastFound = now;
      if (!_lastFound) _lastFound = 1;
      _started = true;
      _nextOk = now + cooldown(level);
      return PK_FOUND;
    }
    if (now - _lostAt >= kGiveUpMs) {  // 找不到：算了
      _search = _cand = false;
      _streak = 0;
      _started = true;
      _nextOk = now + cooldown(level);
      return PK_GIVEUP;
    }
    return PK_NONE;
  }
  if (!face && was) {  // 刚刚不见了
    _lostAt = now;
    const bool quick = _lastFound && now - _lastFound <= kStreakMs && now - _lastFound >= 5000;  // 找到以后接着躲
    const bool engaged = now - _faceSince >= (quick ? 1500u : kEngageMs);
    _cand = engaged && level != LV_QUIET && level < LV_COUNT && (quick || !_started || due(now, _nextOk));
    return PK_NONE;
  }
  if (face) {
    _cand = false;
    return PK_NONE;
  }
  if (_cand && now - _lostAt >= kGiveUpMs) _cand = false;
  if (_cand && canStart && now - _lostAt >= kSearchMs) {
    _cand = false;
    _search = true;
    rounds++;
    return PK_SEARCH;
  }
  return PK_NONE;
}

// ---------------- 摸头节奏模仿 ----------------
uint32_t Rhythm::rnd() {
  _rng = _rng * 1664525u + 1013904223u;
  return _rng >> 8;
}

void Rhythm::start(uint32_t now, uint32_t seed) {
  *this = Rhythm();
  _rng = seed ? seed : 1u;
  _round = 0;
  setupRound(now);
}

void Rhythm::stop() { _phase = RP_IDLE; }

void Rhythm::setupRound(uint32_t now) {
  static const uint8_t kBeats[kRounds] = {2, 3, 4, 5, 5};
  _beats = kBeats[_round < kRounds ? _round : kRounds - 1];
  for (int i = 0; i < kMaxBeats; i++) _gap[i] = 0;
  if (_round < 2) {  // 前两轮：平平的「嗒、嗒、嗒」
    for (int i = 0; i + 1 < _beats; i++) _gap[i] = 520;
  } else {           // 之后：有快有慢（短 0.32 秒 / 长 0.64 秒），至少各一个
    bool s = false, l = false;
    for (int i = 0; i + 1 < _beats; i++) {
      const bool lg = (rnd() & 1u) != 0;
      _gap[i] = lg ? 640 : 320;
      s = s || !lg;
      l = l || lg;
    }
    if (!s) _gap[rnd() % (uint32_t)(_beats - 1)] = 320;
    else if (!l) _gap[rnd() % (uint32_t)(_beats - 1)] = 640;
  }
  _t0 = now;
  _next = 0;
  _nTaps = 0;
  _result = RR_NONE;
  _err = 0.f;
  _phase = RP_INTRO;
}

void Rhythm::retryRound(uint32_t now) {
  _t0 = now;
  _next = 0;
  _nTaps = 0;
  _result = RR_NONE;
  _err = 0.f;
  _phase = RP_INTRO;
}

Rhythm::Ev Rhythm::update(uint32_t now) {
  Ev e;
  e.round = _round;
  switch (_phase) {
    case RP_INTRO:
      _phase = RP_DEMO;
      _next = 0;
      e.type = RE_ROUND;
      return e;
    case RP_DEMO: {
      uint32_t at = _t0 + kLeadMs;
      for (int i = 0; i < _next && i + 1 < _beats; i++) at += _gap[i];
      if (_next < _beats) {
        if (due(now, at)) {
          e.type = RE_BEAT;
          e.index = _next++;
        }
        return e;
      }
      if (due(now, at + kTurnMs)) {  // at = 最后一拍
        _phase = RP_INPUT;
        _turnAt = now;
        _nTaps = 0;
        e.type = RE_TURN;
      }
      return e;
    }
    case RP_INPUT: {
      bool done = false;
      if (_nTaps == 0) {
        if (now - _turnAt >= kFirstTapMs) {
          _result = RR_TIMEOUT;
          done = true;
        }
      } else {
        const uint32_t since = now - _tap[_nTaps - 1];
        done = (_nTaps >= _beats && since >= 650) || since >= 1500 || _nTaps >= kMaxTaps;
      }
      if (!done) return e;
      if (_result != RR_TIMEOUT) _result = judge(_gap, _beats, _tap, _nTaps, &_err);
      const bool ok = _result == RR_PERFECT || _result == RR_GOOD;
      if (ok) {
        _passed++;
        if (_result == RR_PERFECT) _perfect++;
      }
      _phase = RP_JUDGED;
      _judgedAt = now;
      e.type = RE_RESULT;
      e.result = _result;
      // 接下来还玩不玩：拍错了有一次重来的机会；没拍 = 不玩了
      _again = ok ? (_round + 1 < kRounds) : (_result == RR_MISS && !_retried);
      e.index = _again ? 1 : 0;
      return e;
    }
    case RP_JUDGED:
      if (now - _judgedAt < kResultMs) return e;
      if (!_again) {
        _phase = RP_IDLE;
        e.type = RE_END;
        e.result = _result;
        return e;
      }
      if (_result == RR_MISS) {  // 同一段再来一次
        _retried = true;
        retryRound(now);
      } else {
        _round++;
        setupRound(now);
      }
      e.round = _round;
      return e;
    default:
      return e;
  }
}

bool Rhythm::tap(uint32_t now) {
  if (_phase != RP_INPUT) return false;
  if (_nTaps > 0 && now - _tap[_nTaps - 1] < 120) return true;  // 抖了一下
  if (_nTaps < kMaxTaps) _tap[_nTaps++] = now;
  return true;
}

uint8_t Rhythm::judge(const uint16_t* gaps, int beats, const uint32_t* taps, int n, float* err) {
  if (err) *err = 1.f;
  if (!gaps || !taps || beats < 1 || beats > kMaxBeats || n != beats) return RR_MISS;
  if (beats <= 2) {  // 两下：拍对了就好
    if (err) *err = 0.f;
    return RR_PERFECT;
  }
  float su = 0.f, se = 0.f;
  uint16_t lo = 0xFFFF, hi = 0;
  for (int i = 0; i + 1 < beats; i++) {
    if ((int32_t)(taps[i + 1] - taps[i]) <= 0) return RR_MISS;
    su += (float)(taps[i + 1] - taps[i]);
    se += (float)gaps[i];
    if (gaps[i] < lo) lo = gaps[i];
    if (gaps[i] > hi) hi = gaps[i];
  }
  if (se <= 0.f || lo == 0) return RR_MISS;
  const float scale = su / se;  // 整体快一点慢一点没关系
  if (scale < .45f || scale > 2.2f) return RR_MISS;
  const bool mixed = hi > lo;
  const float thr = scale * sqrtf((float)lo * (float)hi);
  float worst = 0.f;
  for (int i = 0; i + 1 < beats; i++) {
    const float u = (float)(taps[i + 1] - taps[i]);
    if (mixed && ((u > thr) != (gaps[i] > lo))) return RR_MISS;  // 快慢的样子不对
    const float e = fabsf(u / (scale * (float)gaps[i]) - 1.f);
    if (e > worst) worst = e;
  }
  if (err) *err = worst;
  if (worst <= .25f) return RR_PERFECT;
  if (mixed || worst <= .45f) return RR_GOOD;  // 有快有慢的：样子对了就算过
  return RR_MISS;
}

// ---------------- 连拍手势 ----------------
void TapSeq::tap(uint32_t now) {
  if (_n && now - _last > kGapMs) _n = 0;
  if (_n < 50) _n++;
  _last = now;
}
uint8_t TapSeq::update(uint32_t now) {
  if (!_n || now - _last < kSettleMs) return 0;
  const uint8_t n = _n;
  _n = 0;
  return n;
}

// ---------------- 每晚心情打卡 ----------------
void MoodLog::reset() {
  memset(&_d, 0, sizeof _d);
  _d.magic = kMoodMagic;
  _d.version = kMoodVersion;
  _d.size = (uint16_t)sizeof(MoodData);
  _dirty = false;
}

bool MoodLog::load(const void* blob, size_t n) {
  if (!blob || n != sizeof(MoodData)) return false;
  MoodData d;
  memcpy(&d, blob, sizeof d);
  if (d.magic != kMoodMagic || d.version != kMoodVersion || d.size != sizeof(MoodData)) return false;
  if (companion::crc32(&d, offsetof(MoodData, crc)) != d.crc) return false;
  if (d.count > kMoodDays) return false;
  for (int i = 0; i < d.count; i++) {
    if (d.day[i] == 0 || d.score[i] < 1 || d.score[i] > 5) return false;
    if (i > 0 && d.day[i] <= d.day[i - 1]) return false;
  }
  _d = d;
  _dirty = false;
  return true;
}

const MoodData& MoodLog::save() {
  _d.magic = kMoodMagic;
  _d.version = kMoodVersion;
  _d.size = (uint16_t)sizeof(MoodData);
  _d.crc = companion::crc32(&_d, offsetof(MoodData, crc));
  return _d;
}

bool MoodLog::add(uint32_t day, uint8_t score) {
  if (!day || score < 1 || score > 5) return false;
  for (int i = 0; i < _d.count; i++)
    if (_d.day[i] == day) {
      _d.score[i] = score;
      _dirty = true;
      return true;
    }
  while (_d.count && _d.day[_d.count - 1] > day) _d.count--;  // 时钟往回调过：丢掉「未来」的记录
  if (_d.count == kMoodDays) {
    memmove(_d.day, _d.day + 1, sizeof(_d.day[0]) * (kMoodDays - 1));
    memmove(_d.score, _d.score + 1, sizeof(_d.score[0]) * (kMoodDays - 1));
    _d.count--;
  }
  _d.day[_d.count] = day;
  _d.score[_d.count] = score;
  _d.count++;
  _d.total++;
  _dirty = true;
  return true;
}

int MoodLog::scoreOn(uint32_t day) const {
  for (int i = 0; i < _d.count; i++)
    if (_d.day[i] == day) return _d.score[i];
  return -1;
}

int MoodLog::entries(uint32_t today) const {
  int n = 0;
  for (int i = 0; i < _d.count; i++)
    if (_d.day[i] <= today && today - _d.day[i] < (uint32_t)kMoodDays) n++;
  return n;
}

float MoodLog::average(uint32_t today) const {
  int n = 0, s = 0;
  for (int i = 0; i < _d.count; i++)
    if (_d.day[i] <= today && today - _d.day[i] < (uint32_t)kMoodDays) {
      n++;
      s += _d.score[i];
    }
  return n ? (float)s / (float)n : 0.f;
}

int MoodLog::trend(uint32_t today) const {
  int v[kMoodDays], n = 0;
  for (int i = 0; i < _d.count; i++)
    if (_d.day[i] <= today && today - _d.day[i] < (uint32_t)kMoodDays) v[n++] = _d.score[i];
  if (n < 4) return 0;
  float a = 0.f, b = 0.f;
  for (int i = 0; i < n - 3; i++) a += (float)v[i];
  for (int i = n - 3; i < n; i++) b += (float)v[i];
  a /= (float)(n - 3);
  b /= 3.f;
  if (b - a >= .7f) return 1;
  if (a - b >= .7f) return -1;
  return 0;
}

bool MoodLog::persistentLow(uint32_t today) const {
  int lows = 0;
  for (int i = 0; i < _d.count; i++)
    if (_d.day[i] <= today && today - _d.day[i] < (uint32_t)kMoodDays && _d.score[i] <= 2) lows++;
  return lows >= 3 && average(today) < 2.5f;
}

bool MoodLog::summaryDue(uint32_t today) const {
  if (entries(today) < 4) return false;
  if (!_d.summaryDay) return true;
  return today >= _d.summaryDay && today - _d.summaryDay >= 7;
}

void MoodLog::summarized(uint32_t today) {
  _d.summaryDay = today;
  _dirty = true;
}

void MoodLog::asked(uint32_t day) {
  if (_d.askDay != day) {
    _d.askDay = day;
    _d.asks = 0;
  }
  if (_d.asks < 250) _d.asks++;
  _dirty = true;
}

void MoodLog::clear() {
  reset();
  _dirty = true;
}

bool CheckIn::inWindow(const CheckInput& in) {
  if (!in.clockValid) return false;
  const int m = in.hour * 60 + in.minute;
  return m >= 19 * 60 + 30 && m < (in.quietOn ? 22 * 60 : 22 * 60 + 30);
}

bool CheckIn::due(const CheckInput& in, const MoodLog& log) const {
  if (in.careLevel == 0 || !inWindow(in) || !in.ready || !in.present || in.presentMs < 5000) return false;
  if (!in.day || log.scoreOn(in.day) >= 0) return false;  // 今天打过了
  const uint8_t maxAsks = in.careLevel >= 2 ? 2 : 1;      // 「开」：没回答的话 20 分钟后再问一次
  if (log.asksOn(in.day) >= maxAsks) return false;
  if (_haveAsk && in.now - _lastAsk < kReaskMs) return false;
  return true;
}

}  // namespace play
