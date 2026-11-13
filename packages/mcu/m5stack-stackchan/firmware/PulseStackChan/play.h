#pragma once
// 脉冲 Pulse · 2.9 活泼版：一起玩（原创代码，不依赖硬件，可以在电脑上测试）
// ① 活跃度：安静 / 适中 / 活泼（看着你时的小反应、自己玩的频率、会不会主动找你玩）
// ② 主动邀请：求摸摸 / 比心 / 蹭蹭 / 一起玩 / 表演。看你接不接，慢慢学会多久邀请一次；连着没理就先不烦你
// ③ 躲猫猫：你躲开（脸不见了）→ 它东找西找 → 你回来 →「找到你啦！」
// ④ 摸头节奏模仿：它先敲一段节奏，你照着拍（拍头或点屏幕都行）
// ⑤ 连拍手势：很快地连拍 2 下 = 跳舞，3 下 = 节奏游戏
// ⑥ 每晚心情打卡：拍 1–5 下打分，记最近 7 天，每周小结一次
#include <stddef.h>
#include <stdint.h>

namespace play {

constexpr uint32_t kNever = 0xFFFFFFFFu;

// ---------------- 活跃度 ----------------
enum Level : uint8_t { LV_QUIET, LV_NORMAL, LV_LIVELY, LV_COUNT };
const char* levelName(uint8_t l);  // 安静 / 适中 / 活泼
const char* levelKey(uint8_t l);   // quiet / normal / lively
int parseLevel(const char* s);     // quiet|normal|lively|0|1|2；不认识 = -1
float spontScale(uint8_t l);       // 没人理时「自己玩」的间隔倍数：安静 1（和 2.8 一样）/ 适中 .75 / 活泼 .55
uint32_t microGap(uint8_t l, float r01);  // 看着你时小反应的间隔（毫秒）：活泼 8–20 秒，适中 20–40 秒，安静 0 = 不做

// ---------------- 主动邀请 ----------------
enum Bid : uint8_t { BID_NONE, BID_PET, BID_HEART, BID_NUZZLE, BID_PLAY, BID_SHOW, BID_COUNT };
const char* bidName(uint8_t b);  // 求摸摸 / 比心 / 蹭蹭 / 一起玩 / 表演
const char* bidKey(uint8_t b);   // pet / heart / nuzzle / play / show

struct BidInput {
  uint32_t now = 0;
  uint8_t level = LV_LIVELY;
  bool ready = false;            // 醒着、空着、不是夜里、没在聊天 / 提醒 / 玩别的
  bool camera = false;           // 有相机（开机以来见过脸）：要看着你才邀请
  bool facing = false;
  uint32_t facingMs = 0;         // 这次已经看了你多久
  uint32_t sinceTouch = kNever, sinceChat = kNever, sinceNear = kNever, sinceShow = kNever;  // 毫秒
  uint32_t day = 0;              // 今天（日期序号；没对时由调用方给一个伪日期）
  float playful = .5f;           // 0–1：现在多想玩（心情）
  float warmth = 0.f;            // 0–1：有多熟
  bool gameOk = true;            // 可以邀请玩节奏游戏
};

class Bids {
 public:
  static constexpr uint32_t kWindowMs = 8000;  // 演完以后等你回应多久
  void reset(uint32_t now);
  // 每秒左右调用一次：返回现在要发出的邀请（BID_NONE = 不发）。r01 / r2：0–1 随机数
  uint8_t tick(const BidInput& in, float r01, float r2);
  void started(uint8_t kind, uint32_t now);  // 真的演了：开始等回应
  uint8_t respond(uint32_t now);             // 有回应了（摸 / 点 / 说话 / 按键）：返回接受了哪一种（没在等 = BID_NONE）
  void cancel();                             // 被别的事打断（不算没理）
  bool waiting(uint32_t now) const;
  uint8_t waitingKind() const { return _wait; }
  float acceptance() const { return _ema; }  // 0–1：最近你接受邀请的比例（指数平均）
  uint8_t ignoredRow() const { return _ignRow; }
  bool snoozed(uint32_t now) const;
  uint16_t today() const { return _today; }
  uint16_t todayAccepted() const { return _todayOk; }
  static uint16_t dailyCap(uint8_t level);
  uint32_t nextIn(uint32_t now) const;       // 多久以后可以下一次（毫秒；0 = 现在就可以）
  uint32_t offered = 0, accepted = 0, ignored = 0, snoozes = 0;  // 开机以来
 private:
  void schedule(uint32_t now, uint8_t level, float r01);
  uint8_t pick(const BidInput& in, float r) const;
  float _ema = .5f;
  uint8_t _wait = BID_NONE, _last = BID_NONE, _ignRow = 0, _level = LV_LIVELY;
  bool _scheduled = false, _snooze = false;
  uint32_t _waitUntil = 0, _next = 0, _snoozeUntil = 0, _day = 0xFFFFFFFFu;
  uint16_t _today = 0, _todayOk = 0;
};

// ---------------- 躲猫猫 ----------------
class Peekaboo {
 public:
  enum Ev : uint8_t { PK_NONE, PK_SEARCH, PK_FOUND, PK_GIVEUP };
  static constexpr uint32_t kEngageMs = 4000;   // 先看着它这么久，再躲开才算在玩
  static constexpr uint32_t kSearchMs = 1600;   // 不见了这么久开始找
  static constexpr uint32_t kGiveUpMs = 8000;   // 不见了这么久就不找了
  static constexpr uint32_t kStreakMs = 20000;  // 找到以后这么久内再躲 = 接着玩
  void reset();
  // 每帧调用。face：现在看不看得见你。canStart：现在能开始找（醒着、空着、活跃度够、不是夜里）；
  // keep：找的过程中还能继续（没被提醒 / 聊天 / 触摸打断）
  uint8_t update(uint32_t now, bool face, bool canStart, bool keep, uint8_t level);
  bool searching() const { return _search; }
  uint8_t streak() const { return _streak; }
  uint32_t rounds = 0, found = 0;
 private:
  static uint32_t cooldown(uint8_t level);
  bool _face = false, _search = false, _cand = false, _started = false;
  uint32_t _faceSince = 0, _lostAt = 0, _lastFound = 0, _nextOk = 0;
  uint8_t _streak = 0;
};

// ---------------- 摸头节奏模仿 ----------------
class Rhythm {
 public:
  enum Phase : uint8_t { RP_IDLE, RP_INTRO, RP_DEMO, RP_INPUT, RP_JUDGED };
  enum Result : uint8_t { RR_NONE, RR_PERFECT, RR_GOOD, RR_MISS, RR_TIMEOUT };
  enum EvType : uint8_t { RE_NONE, RE_ROUND, RE_BEAT, RE_TURN, RE_RESULT, RE_END };
  struct Ev {
    uint8_t type = RE_NONE, round = 0;
    uint8_t index = 0;   // RE_BEAT：第几拍；RE_RESULT：1 = 接着玩（下一轮 / 再来一次），0 = 这局结束
    uint8_t result = RR_NONE;
  };
  static constexpr int kRounds = 5, kMaxBeats = 5, kMaxTaps = 12;
  static constexpr uint32_t kLeadMs = 900;      // 每轮开头：竖起耳朵
  static constexpr uint32_t kTurnMs = 750;      // 最后一拍之后多久「轮到你」
  static constexpr uint32_t kFirstTapMs = 4500;  // 轮到你以后多久内要开始拍
  static constexpr uint32_t kResultMs = 2300;   // 看结果的时间
  void start(uint32_t now, uint32_t seed);
  void stop();
  bool active() const { return _phase != RP_IDLE; }
  uint8_t phase() const { return _phase; }
  Ev update(uint32_t now);   // 每帧调用；一次最多返回一件事
  bool tap(uint32_t now);    // 轮到你拍的时候返回 true（算进去了）
  bool listening() const { return _phase == RP_INPUT; }
  uint8_t round() const { return _round; }     // 0 起
  uint8_t beats() const { return _beats; }
  const uint16_t* gaps() const { return _gap; }  // 每两拍之间（毫秒），beats-1 个
  uint8_t taps() const { return _nTaps; }
  uint8_t passed() const { return _passed; }
  uint8_t perfects() const { return _perfect; }
  uint8_t lastResult() const { return _result; }
  float lastError() const { return _err; }
  // 判定（纯函数，测试用）：拍数要对；3 拍以上再比较快慢的样子（整体快一点慢一点没关系）
  static uint8_t judge(const uint16_t* gaps, int beats, const uint32_t* taps, int n, float* err = nullptr);
 private:
  void setupRound(uint32_t now);
  void retryRound(uint32_t now);
  uint32_t rnd();
  uint8_t _phase = RP_IDLE, _round = 0, _beats = 0, _next = 0, _nTaps = 0, _passed = 0, _perfect = 0, _result = RR_NONE;
  bool _again = false, _retried = false;
  uint16_t _gap[kMaxBeats] = {};
  uint32_t _t0 = 0, _turnAt = 0, _judgedAt = 0, _rng = 1;
  uint32_t _tap[kMaxTaps] = {};
  float _err = 0.f;
};

// ---------------- 连拍手势 ----------------
// 很快地连拍（两下之间 ≤ 0.7 秒），最后一下之后 0.8 秒没再拍 = 一组。返回这一组拍了几下
class TapSeq {
 public:
  static constexpr uint32_t kGapMs = 700, kSettleMs = 800;
  void reset() { _n = 0; }
  void tap(uint32_t now);
  uint8_t update(uint32_t now);  // 一组结束时返回下数（其余时候 0）
  uint8_t pending() const { return _n; }
 private:
  uint8_t _n = 0;
  uint32_t _last = 0;
};

// ---------------- 每晚心情打卡 ----------------
constexpr int kMoodDays = 7;
constexpr uint32_t kMoodMagic = 0x314D4B45u;  // "EKM1"
constexpr uint16_t kMoodVersion = 1;
struct MoodData {
  uint32_t magic;
  uint16_t version, size;
  uint32_t day[kMoodDays];   // 日期序号，从旧到新（0 = 空）
  uint8_t score[kMoodDays];  // 1–5
  uint8_t count;             // 有几条
  uint8_t asks;              // askDay 那天问过几次
  uint8_t pad[3];
  uint32_t askDay;           // 最近一次问是哪天
  uint32_t summaryDay;       // 最近一次每周小结是哪天
  uint32_t total;            // 一共打过几次卡
  uint32_t crc;
};

class MoodLog {
 public:
  MoodLog() { reset(); }
  void reset();
  bool load(const void* blob, size_t n);   // 校验失败返回 false，内容保持不变
  const MoodData& save();                  // 算好校验值后返回（写 NVS 用）
  const MoodData& data() const { return _d; }
  bool add(uint32_t day, uint8_t score);   // 同一天再打 = 改成新的分数
  int scoreOn(uint32_t day) const;         // 那天的分数（没有 = -1）
  int entries(uint32_t today) const;       // 最近 7 天（含今天）打了几次
  float average(uint32_t today) const;     // 最近 7 天平均（没有 = 0）
  int trend(uint32_t today) const;         // 最近 3 次比之前：+1 变好 / -1 变差 / 0 差不多
  bool persistentLow(uint32_t today) const;  // 最近 7 天里 3 次以上 ≤ 2 分，而且平均 < 2.5
  bool summaryDue(uint32_t today) const;   // 最近 7 天打了 ≥ 4 次，且距离上次小结 ≥ 7 天
  void summarized(uint32_t today);
  void asked(uint32_t day);
  uint8_t asksOn(uint32_t day) const { return _d.askDay == day ? _d.asks : 0; }
  void clear();
  bool dirty() const { return _dirty; }
  void clean() { _dirty = false; }
 private:
  MoodData _d;
  bool _dirty = false;
};

// 什么时候问「今天心情几分？」
struct CheckInput {
  uint32_t now = 0;
  bool clockValid = false;
  uint8_t hour = 0, minute = 0;
  uint32_t day = 0;
  bool quietOn = true;     // 夜间安静开着：22 点以后不问
  uint8_t careLevel = 2;   // 0 关 / 1 少一点 / 2 开（和关心提醒同一个开关）
  bool ready = false;      // 醒着、空着、没在聊天 / 提醒 / 玩别的
  bool present = false;    // 看着你（或者没有相机时：刚摸过它）
  uint32_t presentMs = 0;
};
class CheckIn {
 public:
  static constexpr uint32_t kReaskMs = 20u * 60000u;
  static constexpr uint32_t kAnswerMs = 25000;
  void reset() { _lastAsk = 0; _haveAsk = false; }
  bool due(const CheckInput& in, const MoodLog& log) const;
  static bool inWindow(const CheckInput& in);  // 19:30–21:59（夜间安静关掉时到 22:29）
  void asked(uint32_t now) { _lastAsk = now; _haveAsk = true; }
 private:
  uint32_t _lastAsk = 0;
  bool _haveAsk = false;
};

}  // namespace play
