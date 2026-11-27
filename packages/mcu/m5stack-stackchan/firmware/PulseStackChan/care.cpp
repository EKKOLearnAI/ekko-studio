// 脉冲 Pulse · 2.8 陪伴版 · 会关心人 + 任务提醒收件箱（原创代码，纯逻辑，主机可测）
#include "care.h"

#include <string.h>

namespace care {

namespace {
constexpr uint32_t kMin = 60000u;
constexpr uint32_t kTickCapMs = 5000;            // 两次 tick 间隔再长也只算 5 秒（卡顿 / 睡眠回来不乱加）
constexpr uint32_t kStretchFollowWin = 15 * kMin; // 提醒活动后 15 分钟内走开
constexpr uint32_t kStretchAwayMin = 3 * kMin;    // 走开至少 3 分钟 = 真的起来活动了
constexpr uint32_t kMealFollowWin = 40 * kMin;    // 提醒吃饭后 40 分钟内走开
constexpr uint32_t kMealAwayMin = 10 * kMin;      // 走开至少 10 分钟 = 去吃饭了
constexpr uint32_t kFollowMaxAway = 3 * 3600000u; // 走开太久回来就不算了
constexpr uint32_t kLongBreakMs = 25 * kMin;      // 饭点前后走开这么久 = 多半吃过了
constexpr uint32_t kSettleMs = 3 * kMin;          // 刚来 / 走开 10 分钟以上回来：3 分钟内不提醒（先打招呼、先坐下）
constexpr uint32_t kMealBreakMaxMs = 150 * kMin;  // 走开太久（出门一整天）就不知道吃没吃了
constexpr int kMealOverlapMin = 20;               // 走开的这段时间和饭点至少重叠 20 分钟
constexpr uint32_t kBedFollowMs = 40 * kMin;
constexpr uint32_t kBedSpacingMs = 30 * kMin;
constexpr uint32_t kNudgeLateMs = 45 * kMin;      // 该再提醒时一直没看见你：45 分钟后就算了
constexpr uint32_t kDupWindowMs = 60000;          // 没带 id 的同样消息 60 秒内算重复

inline bool within(uint32_t since, uint32_t limit) { return since != kNever && since <= limit; }
inline bool due(uint32_t now, uint32_t at) { return (int32_t)(now - at) >= 0; }
inline uint32_t minOf(uint32_t a, uint32_t b) { return a < b ? a : b; }
inline uint16_t minuteOfDay(const Input& in) { return (uint16_t)(in.hour * 60u + in.minute); }
inline bool inRange(uint16_t m, uint16_t from, uint16_t to) { return m >= from && m < to; }
inline int overlapMin(int a0, int a1, int b0, int b1) {  // 两段（分钟）重叠多久
  const int lo = a0 > b0 ? a0 : b0, hi = a1 < b1 ? a1 : b1;
  return hi > lo ? hi - lo : 0;
}
}  // namespace

bool here(const Input& in) {
  return within(in.sinceFace, kHereFaceMs) || within(in.sinceTouch, kHereTouchMs) || within(in.sinceChat, kHereChatMs) ||
         within(in.sinceNear, kHereNearMs);
}

bool facing(const Input& in) {
  return within(in.sinceFace, kFacingFaceMs) || within(in.sinceTouch, kFacingTouchMs) ||
         within(in.sinceChat, kFacingChatMs) || within(in.sinceNear, kFacingNearMs);
}

const char* levelKey(uint8_t level) {
  switch (level) {
    case L_OFF: return "off";
    case L_LESS: return "less";
    default: return "on";
  }
}
const char* levelName(uint8_t level) {
  switch (level) {
    case L_OFF: return "关";
    case L_LESS: return "少一点";
    default: return "开";
  }
}
const char* kindKey(uint8_t kind) {
  switch (kind) {
    case K_STRETCH: return "stretch";
    case K_WATER: return "water";
    case K_LUNCH: return "lunch";
    case K_DINNER: return "dinner";
    case K_BEDTIME: return "bedtime";
    default: return "none";
  }
}
const char* kindName(uint8_t kind) {
  switch (kind) {
    case K_STRETCH: return "起来活动";
    case K_WATER: return "喝水";
    case K_LUNCH: return "吃午饭";
    case K_DINNER: return "吃晚饭";
    case K_BEDTIME: return "早点睡";
    default: return "无";
  }
}

Timing timingFor(uint8_t level) {
  Timing t;
  if (level == L_OFF) {
    t.stretch = 0; t.water = 0; t.gap = 0; t.dailyCap = 0; t.bedtimeMax = 0;
  } else if (level == L_LESS) {
    t.stretch = 80 * kMin; t.water = 150 * kMin; t.gap = 30 * kMin; t.dailyCap = 5; t.bedtimeMax = 1;
  } else {
    t.stretch = 50 * kMin; t.water = 90 * kMin; t.gap = 20 * kMin; t.dailyCap = 10; t.bedtimeMax = 2;
  }
  return t;
}

uint32_t repeatDelay(uint8_t kind) {
  switch (kind) {
    case K_STRETCH: return 10 * kMin;
    case K_WATER: return 15 * kMin;
    case K_LUNCH:
    case K_DINNER: return 15 * kMin;
    case K_BEDTIME: return kBedSpacingMs;
    default: return 0;
  }
}

// ======================= Planner =======================

void Planner::reset(uint32_t now) {
  _ticked = false; _here = false; _hereEver = false;
  _lastTick = now; _awaySince = now; _sitStart = now; _stretchMark = now;
  _waterAccum = 0; _presenceToday = 0;
  _dayKey = 0; _curDay = 0; _curNight = 0;
  _lunchDay = 0; _dinnerDay = 0; _bedNight = 0; _bedCount = 0;
  _lunchValid = false; _dinnerValid = false; _bedValid = false; _dayPraised = false; _dayValid = false;
  _remindersToday = 0; _acksToday = 0; _routineToday = 0; _ignored = 0; _lastRoutine = K_NONE;
  _ateLunchValid = false; _ateDinnerValid = false; _ateLunchDay = 0; _ateDinnerDay = 0;
  _settleValid = false; _settleUntil = now;
  _lastValid = false; _lastKind = K_NONE; _lastAt = 0; _lastBedAt = 0; _lastBedValid = false;
  _awaitKind = K_NONE; _repeatKind = K_NONE; _awaitUntil = 0; _repeatAt = 0;
  _followKind = K_NONE; _praiseBack = K_NONE; _followGone = false;
  _followFrom = 0; _followWindow = 0; _followAway = 0;
  _bedFollow = false; _bedFollowUntil = 0;
}

void Planner::setLevel(uint8_t level) {
  if (level >= L_COUNT) level = L_ON;
  _level = level;
  if (level == L_OFF) {  // 关掉：手上在等的都放下
    _awaitKind = K_NONE; _repeatKind = K_NONE;
    _followKind = K_NONE; _followGone = false; _praiseBack = K_NONE;
    _bedFollow = false;
  }
}

uint32_t Planner::dayKey(const Input& in) const {
  return in.clockValid ? in.day : 0x40000000u + in.now / 86400000u;
}

uint32_t Planner::nightKey(const Input& in) const {
  // 凌晨（中午以前）算前一天的那个晚上
  return in.clockValid ? (in.hour < 12 ? in.day - 1 : in.day) : 0;
}

void Planner::newDay(uint32_t key) {
  _dayKey = key; _dayValid = true;
  _remindersToday = 0; _acksToday = 0; _routineToday = 0; _ignored = 0;
  _presenceToday = 0; _dayPraised = false;
}

uint32_t Planner::sittingMs(uint32_t now) const { return _here ? now - _sitStart : 0; }

bool Planner::awaiting(uint32_t now) const { return _awaitKind != K_NONE && !due(now, _awaitUntil); }

uint8_t Planner::awaitingKind(uint32_t now) const { return awaiting(now) ? _awaitKind : (uint8_t)K_NONE; }

bool Planner::bedtimeFollow(uint32_t now) const { return _bedFollow && !due(now, _bedFollowUntil); }

void Planner::bedtimeDone() { _bedFollow = false; }

uint8_t Planner::ack(uint32_t now) {
  if (!awaiting(now)) return K_NONE;
  uint8_t k = _awaitKind;
  _awaitKind = K_NONE;
  if (_repeatKind == k) _repeatKind = K_NONE;
  if (k == K_STRETCH) _stretchMark = now;  // 说「知道啦」也算：下一次从现在重新算
  if (_acksToday < 0xFFFF) _acksToday++;
  _ignored = 0;
  return k;
}

Due Planner::tick(const Input& in) {
  Due none;
  const uint32_t now = in.now;
  uint32_t dt = _ticked ? now - _lastTick : 0;
  if (dt > kTickCapMs) dt = kTickCapMs;
  _lastTick = now;
  _ticked = true;

  const uint32_t dk = dayKey(in);
  if (!_dayValid || dk != _dayKey) newDay(dk);
  _curDay = dk;
  _curNight = nightKey(in);

  // ---- 你在不在 ----
  const bool h = here(in);
  if (h) {
    if (!_here) {  // 来了 / 回来了
      const uint32_t away = _hereEver ? now - _awaySince : kNever;
      if (!_hereEver || away >= kBreakMs) {
        _sitStart = now; _stretchMark = now;
        _settleValid = true; _settleUntil = now + kSettleMs;
      }
      if (_hereEver && away >= kLongBreakMs) _waterAccum = 0;  // 走开很久：多半喝过水了，重新算
      if (_hereEver && away >= kLongBreakMs && away <= kMealBreakMaxMs && in.clockValid) {
        const int back = minuteOfDay(in), left = back - (int)(away / kMin);
        if (left >= 0) {  // 跨过半夜的不管（饭点都在白天）
          if (overlapMin(left, back, 11 * 60, 14 * 60 + 30) >= kMealOverlapMin) { _ateLunchValid = true; _ateLunchDay = dk; }
          if (overlapMin(left, back, 17 * 60, 20 * 60 + 30) >= kMealOverlapMin) { _ateDinnerValid = true; _ateDinnerDay = dk; }
        }
      }
      if (_followKind != K_NONE && _followGone) {
        const uint32_t need = _followKind == K_STRETCH ? kStretchAwayMin : kMealAwayMin;
        if (away >= need && away <= kFollowMaxAway) {
          _praiseBack = _followKind;  // 真的去做了：回来夸你
          _ignored = 0;
          if (_followKind == K_STRETCH) _stretchMark = now;
          _followKind = K_NONE;
        } else if (away > kFollowMaxAway) {
          _followKind = K_NONE;
        }
        _followGone = false;
      }
      _here = true;
      _hereEver = true;
    }
    _presenceToday += dt;
    _waterAccum += dt;
  } else if (_here) {  // 走开了：从最后一次看到你算起
    uint32_t ago = minOf(minOf(in.sinceFace, in.sinceTouch), minOf(in.sinceChat, in.sinceNear));
    if (ago == kNever) ago = 0;
    _awaySince = now - ago;
    _here = false;
    if (_followKind != K_NONE && !_followGone) {
      uint32_t rel = _awaySince - _followFrom;
      if ((int32_t)rel < 0) rel = 0;
      if (rel <= _followWindow) { _followGone = true; _followAway = _awaySince; }
    }
    // 你都走开了，就不追着再提醒了
    _repeatKind = K_NONE;
    _awaitKind = K_NONE;
  }

  // ---- 过期 ----
  if (_followKind != K_NONE && !_followGone && now - _followFrom > _followWindow) _followKind = K_NONE;
  if (_awaitKind != K_NONE && !awaiting(now)) {  // 没理它
    _awaitKind = K_NONE;
    if (_ignored < 0xFF) _ignored++;
  }
  if (_bedFollow && !bedtimeFollow(now)) _bedFollow = false;
  const bool bedHours = in.bedtime && in.clockValid && (in.hour >= 23 || in.hour < 3);
  const uint8_t bedSoFar = (_bedValid && _bedNight == _curNight) ? _bedCount : 0;
  const Timing T = timingFor(_level);
  if (_repeatKind != K_NONE) {
    bool cancel = due(now, _repeatAt) && now - _repeatAt > kNudgeLateMs;
    if (in.night && (_repeatKind == K_STRETCH || _repeatKind == K_WATER)) cancel = true;
    if (_repeatKind == K_BEDTIME && (!bedHours || bedSoFar >= T.bedtimeMax)) cancel = true;
    if (_ignored >= 2 && !awaiting(now)) cancel = true;  // 连着没理：不追了
    if (cancel) _repeatKind = K_NONE;
  }

  if (_level == L_OFF || !in.free || !facing(in)) return none;

  // ① 回来夸你（是回应，不受间隔限制）
  if (_praiseBack != K_NONE) { none.act = DO_PRAISE_BACK; none.kind = _praiseBack; return none; }
  // 刚来 / 刚回来：先坐下（打招呼、重逢先演），3 分钟内不提醒
  if (_settleValid && !due(now, _settleUntil)) return none;
  _settleValid = false;
  // ② 没理它：再轻轻提醒一次
  if (_repeatKind != K_NONE && due(now, _repeatAt) && !awaiting(now)) {
    none.act = DO_NUDGE; none.kind = _repeatKind; return none;
  }
  // ③ 两次提醒之间至少隔一会儿；连着没理它就隔得更久（×2、×3）
  const uint32_t gap = T.gap * (1u + (_ignored >= 3 ? (_ignored >= 6 ? 2u : 1u) : 0u));
  if (_lastValid && now - _lastAt < gap) return none;
  if (awaiting(now)) return none;
  const uint16_t m = minuteOfDay(in);
  // ④ 早点睡（23:00–03:00，有时钟）
  if (bedHours && bedSoFar < T.bedtimeMax && (!_lastBedValid || now - _lastBedAt >= kBedSpacingMs)) {
    none.act = DO_REMIND; none.kind = K_BEDTIME; return none;
  }
  // ⑤ 今天陪了很久：辛苦啦（好事，排在日常提醒前面）
  if (in.clockValid && in.hour >= 10 && in.hour < 22 && !_dayPraised && _presenceToday >= kDayPraiseMs) {
    none.act = DO_PRAISE_DAY; none.kind = K_NONE; return none;
  }
  // ⑥ 吃饭（饭点前后走开很久过 = 多半吃过了）
  if (in.clockValid) {
    const bool ateLunch = _ateLunchValid && _ateLunchDay == dk;
    const bool ateDinner = _ateDinnerValid && _ateDinnerDay == dk;
    if (inRange(m, 11 * 60 + 45, 13 * 60 + 15) && !(_lunchValid && _lunchDay == dk) && !ateLunch) {
      none.act = DO_REMIND; none.kind = K_LUNCH; return none;
    }
    if (inRange(m, 17 * 60 + 45, 19 * 60 + 30) && !(_dinnerValid && _dinnerDay == dk) && !ateDinner) {
      none.act = DO_REMIND; none.kind = K_DINNER; return none;
    }
  }
  // ⑦ 起来活动 / 喝水（夜里不提醒；每天有上限；两样都该提醒时轮着来）
  if (!in.night && _routineToday < T.dailyCap) {
    const bool stretch = _here && T.stretch && now - _stretchMark >= T.stretch;
    const bool water = T.water && _waterAccum >= T.water;
    if (stretch || water) {
      none.act = DO_REMIND;
      none.kind = (stretch && water) ? (_lastRoutine == K_STRETCH ? K_WATER : K_STRETCH) : (stretch ? K_STRETCH : K_WATER);
      return none;
    }
  }
  return none;
}

void Planner::started(const Due& d, uint32_t now) {
  if (d.act == DO_NONE) return;
  _lastValid = true;
  _lastAt = now;
  if (d.act == DO_PRAISE_BACK) { _praiseBack = K_NONE; return; }
  if (d.act == DO_PRAISE_DAY) { _dayPraised = true; return; }
  // 提醒 / 再提醒
  const uint8_t k = d.kind;
  _lastKind = k;
  if (_remindersToday < 0xFFFF) _remindersToday++;
  _awaitKind = k;
  _awaitUntil = now + kAckWindowMs;
  if (d.act == DO_REMIND) {
    _repeatKind = k;
    _repeatAt = now + repeatDelay(k);
  } else {
    _repeatKind = K_NONE;  // 只再提醒一次
  }
  switch (k) {
    case K_STRETCH:
      if (d.act == DO_REMIND) _routineToday++;
      _lastRoutine = K_STRETCH;
      _stretchMark = now;
      _followKind = K_STRETCH; _followGone = false; _followFrom = now; _followWindow = kStretchFollowWin;
      break;
    case K_WATER:
      if (d.act == DO_REMIND) _routineToday++;
      _lastRoutine = K_WATER;
      _waterAccum = 0;
      break;
    case K_LUNCH:
    case K_DINNER:
      if (k == K_LUNCH) { _lunchDay = _curDay; _lunchValid = true; }
      else { _dinnerDay = _curDay; _dinnerValid = true; }
      _followKind = k; _followGone = false; _followFrom = now; _followWindow = kMealFollowWin;
      break;
    case K_BEDTIME:
      if (!_bedValid || _bedNight != _curNight) { _bedNight = _curNight; _bedCount = 0; _bedValid = true; }
      if (_bedCount < 0xFF) _bedCount++;
      _lastBedAt = now; _lastBedValid = true;
      _bedFollow = true; _bedFollowUntil = now + kBedFollowMs;
      break;
    default:
      break;
  }
}

// ======================= 任务提醒收件箱 =======================

const char* noticeKey(uint8_t kind) {
  switch (kind) {
    case N_DONE: return "task_done";
    case N_FAILED: return "task_failed";
    case N_REMIND: return "reminder";
    case N_PRAISE: return "praise";
    default: return "unknown";
  }
}
const char* noticeName(uint8_t kind) {
  switch (kind) {
    case N_DONE: return "任务完成";
    case N_FAILED: return "任务没成功";
    case N_REMIND: return "提醒";
    case N_PRAISE: return "夸夸";
    default: return "未知";
  }
}

int parseNoticeKind(const char* s) {
  if (!s) return -1;
  static const struct { const char* name; uint8_t kind; } kAlias[] = {
      {"task_done", N_DONE},   {"done", N_DONE},       {"success", N_DONE},     {"task_failed", N_FAILED},
      {"failed", N_FAILED},    {"fail", N_FAILED},     {"error", N_FAILED},     {"reminder", N_REMIND},
      {"remind", N_REMIND},    {"praise", N_PRAISE},
  };
  for (const auto& a : kAlias)
    if (strcmp(s, a.name) == 0) return a.kind;
  return -1;
}

const char* pushKey(uint8_t p) {
  switch (p) {
    case P_QUEUED: return "queued";
    case P_DUPLICATE: return "duplicate";
    case P_REPLACED: return "replaced";
    case P_RATE: return "rate_limited";
    default: return "invalid";
  }
}

bool copyText(char* dst, size_t cap, const char* src) {
  if (!dst || cap == 0) return false;
  dst[0] = 0;
  if (!src) return false;
  const unsigned char* p = (const unsigned char*)src;
  size_t o = 0;
  bool trunc = false;
  while (*p) {
    const unsigned char c = *p;
    int len;
    uint32_t cp;
    if (c < 0x80) { len = 1; cp = c; }
    else if ((c & 0xE0) == 0xC0) { len = 2; cp = c & 0x1F; }
    else if ((c & 0xF0) == 0xE0) { len = 3; cp = c & 0x0F; }
    else if ((c & 0xF8) == 0xF0) { len = 4; cp = c & 0x07; }
    else { p++; continue; }  // 坏字节
    bool ok = true;
    for (int i = 1; i < len; i++) {
      if ((p[i] & 0xC0) != 0x80) { ok = false; break; }
      cp = (cp << 6) | (p[i] & 0x3F);
    }
    if (!ok) { p++; continue; }
    p += len;
    if ((len == 2 && cp < 0x80) || (len == 3 && cp < 0x800) || (len == 4 && (cp < 0x10000 || cp > 0x10FFFF)) ||
        (cp >= 0xD800 && cp <= 0xDFFF))
      continue;  // 过长编码 / 代理项
    bool space = false;
    if (cp == '\t' || cp == '\n' || cp == '\r' || cp == ' ' || cp == 0x3000) space = true;
    else if (cp < 0x20 || cp == 0x7F || (cp >= 0x80 && cp < 0xA0)) continue;            // 控制字符
    else if ((cp >= 0x200B && cp <= 0x200F) || (cp >= 0x202A && cp <= 0x202E) || (cp >= 0x2066 && cp <= 0x2069) ||
             cp == 0xFEFF)
      continue;  // 零宽 / 双向控制
    if (space) {
      if (o == 0 || dst[o - 1] == ' ') continue;  // 去掉开头空格，连续空白合成一个
      if (o + 1 > cap - 1) { trunc = true; break; }
      dst[o++] = ' ';
      continue;
    }
    if (o + (size_t)len > cap - 1) { trunc = true; break; }
    memcpy(dst + o, p - len, (size_t)len);
    o += (size_t)len;
  }
  while (o > 0 && dst[o - 1] == ' ') o--;
  dst[o] = 0;
  return trunc;
}

void Inbox::reset() {
  for (auto& q : _q) q = Notice();
  _latest = -1;
  memset(_recent, 0, sizeof _recent);
  _recentNext = 0;
  memset(_rate, 0, sizeof _rate);
  _rateNext = 0;
  _rateCount = 0;
  received = delivered = acked = dropped = duplicates = expired = 0;
}

int Inbox::oldest(uint8_t state) const {
  int best = -1;
  for (int i = 0; i < kCap; i++) {
    if (_q[i].state != state) continue;
    if (best < 0 || (int32_t)(_q[i].at - _q[best].at) < 0) best = i;
  }
  return best;
}

int Inbox::newest(uint8_t state) const {
  int best = -1;
  for (int i = 0; i < kCap; i++) {
    if (_q[i].state != state) continue;
    if (best < 0 || (int32_t)(_q[i].at - _q[best].at) >= 0) best = i;
  }
  return best;
}

namespace {
constexpr uint32_t kCueWindowMs = 20 * kMin;  // 只在刚到的 20 分钟内叮咚（夜里到的，第二天早上不会突然叫）
bool cueReady(const Notice& q, uint32_t now) {
  if (q.cues >= 3) return false;
  if (now - q.at > kCueWindowMs) return false;
  if (q.cues == 0) return true;
  return now - q.lastCueAt >= (q.cues == 1 ? 3 * kMin : 7 * kMin);
}
}  // namespace

bool Inbox::cueDue(uint32_t now) const {
  const int n = newest(NS_NEW);
  return n >= 0 && cueReady(_q[n], now);
}

int Inbox::countNew(uint8_t kind) const {
  int c = 0;
  for (const auto& q : _q)
    if (q.state == NS_NEW && q.kind == kind) c++;
  return c;
}

uint8_t Inbox::push(uint8_t kind, const char* title, const char* source, const char* id, uint32_t now, bool* truncated) {
  if (truncated) *truncated = false;
  if (kind >= N_COUNT) return P_INVALID;
  char t[kTitleMax + 1], s[kSourceMax + 1], d[kIdMax + 1];
  const bool tTrunc = copyText(t, sizeof t, title);
  copyText(s, sizeof s, source);
  if (id && strlen(id) > kIdMax) return P_INVALID;
  copyText(d, sizeof d, id);
  // 重复：同一个 id（队列里或最近 16 个），或没带 id 时 60 秒内同样的内容
  if (d[0]) {
    for (const auto& q : _q)
      if (q.state != NS_FREE && strcmp(q.id, d) == 0) { duplicates++; return P_DUPLICATE; }
    for (const auto& r : _recent)
      if (r[0] && strcmp(r, d) == 0) { duplicates++; return P_DUPLICATE; }
  } else {
    for (const auto& q : _q)
      if (q.state != NS_FREE && !q.id[0] && q.kind == kind && now - q.at < kDupWindowMs && strcmp(q.title, t) == 0 &&
          strcmp(q.source, s) == 0) {
        duplicates++;
        return P_DUPLICATE;
      }
  }
  // 限速：每分钟最多 kRateMax 条
  if (_rateCount >= kRateMax && now - _rate[_rateNext] < 60000u) return P_RATE;
  int slot = -1;
  for (int i = 0; i < kCap; i++)
    if (_q[i].state == NS_FREE) { slot = i; break; }
  uint8_t res = P_QUEUED;
  if (slot < 0) {  // 满了：先挤掉已经演过的，再挤掉最旧的
    slot = oldest(NS_SHOWN);
    if (slot < 0) slot = oldest(NS_NEW);
    dropped++;
    res = P_REPLACED;
  }
  Notice& q = _q[slot];
  q = Notice();
  q.kind = kind;
  q.state = NS_NEW;
  q.at = now;
  memcpy(q.title, t, sizeof q.title);
  memcpy(q.source, s, sizeof q.source);
  memcpy(q.id, d, sizeof q.id);
  _latest = slot;
  if (d[0]) {
    memcpy(_recent[_recentNext], d, sizeof _recent[0]);
    _recentNext = (_recentNext + 1) % 16;
  }
  _rate[_rateNext] = now;
  _rateNext = (_rateNext + 1) % kRateMax;
  if (_rateCount < kRateMax) _rateCount++;
  received++;
  if (truncated) *truncated = tTrunc;
  return res;
}

NDue Inbox::tick(const Input& in, bool allowCue) {
  NDue r;
  const uint32_t now = in.now;
  for (auto& q : _q) {
    if (q.state == NS_NEW && now - q.at > kNoticeExpireMs) { q.state = NS_FREE; expired++; }
    else if (q.state == NS_SHOWN && now - q.shownAt > kShownKeepMs) q.state = NS_FREE;  // 演过了，算看过
  }
  if (!in.free) return r;
  const bool face = facing(in);
  const int n = oldest(NS_NEW);
  if (n >= 0) {
    if (face) { r.act = NA_SHOW; r.kind = _q[n].kind; r.slot = (int8_t)n; return r; }
    const int c = newest(NS_NEW);  // 叮咚跟着最新到的那条
    if (allowCue && cueReady(_q[c], now)) { r.act = NA_CUE; r.kind = _q[c].kind; r.slot = (int8_t)c; }
    return r;
  }
  if (!face) return r;
  // 演过还没摸它：最近演的那条决定什么时候再轻轻提醒（一次提醒 = 所有没收到的）
  int s = -1;
  for (int i = 0; i < kCap; i++)
    if (_q[i].state == NS_SHOWN && (s < 0 || (int32_t)(_q[i].lastCueAt - _q[s].lastCueAt) > 0)) s = i;
  if (s >= 0 && _q[s].nudges < 2) {
    const uint32_t wait = _q[s].nudges == 0 ? 3 * kMin : 7 * kMin;
    if (now - _q[s].lastCueAt >= wait) { r.act = NA_NUDGE; r.kind = _q[s].kind; r.slot = (int8_t)s; }
  }
  return r;
}

void Inbox::performed(const NDue& d, uint32_t now) {
  if (d.act == NA_NONE || d.slot < 0 || d.slot >= kCap) return;
  Notice& q = _q[d.slot];
  if (q.state == NS_FREE) return;
  switch (d.act) {
    case NA_CUE:
      if (q.cues < 0xFF) q.cues++;
      q.lastCueAt = now;
      break;
    case NA_SHOW: {
      const uint8_t kind = q.kind;
      for (auto& o : _q)  // 同一种的一起演
        if (o.state == NS_NEW && o.kind == kind) {
          delivered++;
          o.state = NS_SHOWN; o.shownAt = now; o.lastCueAt = now; o.nudges = 0;
        }
      if (q.state == NS_SHOWN) { q.shownAt = now; q.lastCueAt = now; }
      break;
    }
    case NA_NUDGE:
      for (auto& o : _q)
        if (o.state == NS_SHOWN) {
          if (o.nudges < 0xFF) o.nudges++;
          o.lastCueAt = now;
        }
      break;
    default:
      break;
  }
}

bool Inbox::awaiting() const {
  for (const auto& q : _q)
    if (q.state == NS_SHOWN) return true;
  return false;
}

bool Inbox::hasNew() const {
  for (const auto& q : _q)
    if (q.state == NS_NEW) return true;
  return false;
}

int Inbox::pending() const {
  int n = 0;
  for (const auto& q : _q)
    if (q.state != NS_FREE) n++;
  return n;
}

int Inbox::ack(uint32_t now) {
  (void)now;
  int best = -1;
  for (int i = 0; i < kCap; i++) {
    if (_q[i].state != NS_SHOWN) continue;
    if (best < 0 || (int32_t)(_q[i].shownAt - _q[best].shownAt) > 0) best = i;
  }
  if (best < 0) return hasNew() ? -2 : -1;
  const int kind = _q[best].kind;
  for (auto& q : _q)  // 摸一下 = 演过的都收到了
    if (q.state == NS_SHOWN) { q.state = NS_FREE; acked++; }
  return kind;
}

const Notice* Inbox::latest() const { return _latest >= 0 ? &_q[_latest] : nullptr; }

void Inbox::clear() {
  for (auto& q : _q) q.state = NS_FREE;
}

}  // namespace care
