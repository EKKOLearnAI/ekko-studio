#pragma once
// 脉冲 Pulse · 2.8 陪伴版（原创代码，不依赖硬件，可以在电脑上测试）
// ① 会关心人 Planner：起来活动、喝水、吃饭、早点睡。只在你确实就在跟前、它也空着的时候提醒；
//    摸摸它 = 「知道啦」，会被夸；不理它只会再轻轻提醒一次，然后就算了。你真的起身走开 / 去吃饭了，回来会被夸。
// ② 任务提醒收件箱 Inbox：Ekko Studio（或任何本机脚本）通过 /api/notify 送来「任务完成 / 失败 / 提醒 / 夸夸」。
//    没看见你时先「叮咚」叫你（夜里不出声，只亮灯），看见你再庆祝或安慰；摸摸它 = 收到。
// 所有时间都是 millis() 毫秒，按差值比较（开机 49.7 天回绕也没关系）。
#include <stddef.h>
#include <stdint.h>

namespace care {

constexpr uint32_t kNever = 0xFFFFFFFFu;

// ---------------- 输入（brain 每秒左右给一次）----------------
struct Input {
  uint32_t now = 0;
  bool clockValid = false;       // 不知道几点：吃饭 / 睡觉提醒不做，起来活动 / 喝水照常
  uint8_t hour = 0, minute = 0;
  uint32_t day = 0;              // 本地日期序号（clockValid 时有效）
  bool night = false;            // 夜间安静（设置开启且 22:00–07:00；没对时 = 持续暗 5 分钟）：不提醒活动 / 喝水
  bool bedtime = true;           // 可以提醒「早点睡」（设置里「夜间安静」开着才提醒）
  uint32_t sinceFace = kNever;   // 多久没看见你的脸（毫秒；kNever = 从没看见过）
  uint32_t sinceTouch = kNever;  // 多久没摸它
  uint32_t sinceChat = kNever;   // 多久没和它说话（正在聊天 = 0）
  uint32_t sinceNear = kNever;   // 多久没有东西靠近（接近传感器）
  bool free = false;             // 它现在空着：醒着、没在演别的、没在聊天、手不在身上
};

// 「你在不在」
constexpr uint32_t kHereFaceMs = 120000, kHereTouchMs = 300000, kHereChatMs = 300000, kHereNearMs = 120000;
constexpr uint32_t kFacingFaceMs = 20000, kFacingTouchMs = 60000, kFacingChatMs = 60000, kFacingNearMs = 30000;
bool here(const Input& in);    // 最近几分钟有你的迹象（脸 2 分钟 / 摸 5 分钟 / 说话 5 分钟 / 靠近 2 分钟）
bool facing(const Input& in);  // 你就在跟前、看得到它（脸 20 秒 / 摸或说话 1 分钟 / 靠近 30 秒）

// ---------------- ① 关心提醒 ----------------
enum Level : uint8_t { L_OFF = 0, L_LESS = 1, L_ON = 2, L_COUNT };
enum Kind : uint8_t { K_NONE = 0, K_STRETCH, K_WATER, K_LUNCH, K_DINNER, K_BEDTIME, K_COUNT };
const char* levelKey(uint8_t level);   // off / less / on
const char* levelName(uint8_t level);  // 关 / 少一点 / 开
const char* kindKey(uint8_t kind);     // stretch / water / lunch / dinner / bedtime
const char* kindName(uint8_t kind);    // 起来活动 / 喝水 / 吃午饭 / 吃晚饭 / 早点睡

enum Act : uint8_t {
  DO_NONE = 0,
  DO_REMIND,      // 提醒（第一次）
  DO_NUDGE,       // 没理它：再轻轻提醒一次（只一次）
  DO_PRAISE_BACK, // 提醒后你真的走开活动 / 去吃饭了：回来夸你
  DO_PRAISE_DAY,  // 今天陪了它很久（≥ 4 小时）：「辛苦啦」（每天一次）
};
struct Due {
  uint8_t act = DO_NONE, kind = K_NONE;
};

struct Timing {
  uint32_t stretch;   // 连续坐多久提醒起来活动
  uint32_t water;     // 有你在的时间累计多久提醒喝水（0 = 不提醒）
  uint32_t gap;       // 两次提醒至少隔多久
  uint8_t dailyCap;   // 每天最多几次活动 / 喝水提醒
  uint8_t bedtimeMax; // 每晚最多提醒几次睡觉
};
Timing timingFor(uint8_t level);
constexpr uint32_t kAckWindowMs = 75000;       // 提醒后多久内摸它算「知道啦」
constexpr uint32_t kBreakMs = 600000;          // 走开 10 分钟 = 休息过了（重新算连续坐了多久）
constexpr uint32_t kDayPraiseMs = 4u * 3600000u;
uint32_t repeatDelay(uint8_t kind);            // 没理它，多久后再轻轻提醒一次

class Planner {
 public:
  Planner() { reset(0); }
  void reset(uint32_t now);
  void setLevel(uint8_t level);
  uint8_t level() const { return _level; }
  // 每秒左右调用：更新「你在不在」和今天的统计，返回现在最该做的一件事（brain 没演就下次再返回）
  Due tick(const Input& in);
  void started(const Due& d, uint32_t now);  // brain 真的演了
  bool awaiting(uint32_t now) const;         // 刚提醒过，等你回应
  uint8_t awaitingKind(uint32_t now) const;
  uint8_t ack(uint32_t now);                 // 你回应了（摸它 / 按键 / 说话）：返回是哪种提醒，没有在等 = K_NONE
  bool bedtimeFollow(uint32_t now) const;    // 提醒睡觉后 40 分钟内关灯：乖
  void bedtimeDone();
  // 状态
  uint8_t lastKind() const { return _lastValid ? _lastKind : (uint8_t)K_NONE; }
  uint32_t sinceLast(uint32_t now) const { return _lastValid ? now - _lastAt : kNever; }
  uint16_t remindersToday() const { return _remindersToday; }
  uint16_t acksToday() const { return _acksToday; }
  uint32_t presenceTodayMin() const { return _presenceToday / 60000u; }
  uint32_t sittingMs(uint32_t now) const;    // 这次连续坐了多久（不在 = 0）
  bool hereNow() const { return _here; }
  uint8_t pendingPraise() const { return _praiseBack; }
  uint8_t ignoredStreak() const { return _ignored; }

 private:
  uint32_t dayKey(const Input& in) const;
  uint32_t nightKey(const Input& in) const;
  void newDay(uint32_t key);
  uint8_t _level = L_ON;
  bool _ticked = false, _here = false, _hereEver = false;
  uint32_t _lastTick = 0, _awaySince = 0, _sitStart = 0, _stretchMark = 0;
  uint32_t _settleUntil = 0;  // 刚来 / 刚回来：先让你坐下（这段时间只夸，不提醒）
  bool _settleValid = false;
  uint32_t _waterAccum = 0, _presenceToday = 0;
  uint32_t _dayKey = 0, _curDay = 0, _curNight = 0;
  uint32_t _lunchDay = 0, _dinnerDay = 0, _bedNight = 0;
  uint8_t _bedCount = 0;
  bool _lunchValid = false, _dinnerValid = false, _bedValid = false, _dayPraised = false, _dayValid = false;
  uint16_t _remindersToday = 0, _acksToday = 0, _routineToday = 0;  // _routineToday：活动 / 喝水（每天上限）
  uint8_t _ignored = 0, _lastRoutine = K_NONE;  // 连着几次没理它：≥ 2 不再追加提醒，≥ 3 间隔拉长（你在忙，就少打扰）
  // 饭点前后自己走开过一阵（25 分钟–2.5 小时，和饭点重叠 ≥ 20 分钟）= 多半吃过了，今天不再提醒这一顿
  //（出门一整天、傍晚才回来不算：不知道吃没吃）
  bool _ateLunchValid = false, _ateDinnerValid = false;
  uint32_t _ateLunchDay = 0, _ateDinnerDay = 0;
  // 最近一次提醒
  bool _lastValid = false;
  uint8_t _lastKind = K_NONE;
  uint32_t _lastAt = 0, _lastBedAt = 0;
  bool _lastBedValid = false;
  // 等回应 / 再提醒一次
  uint8_t _awaitKind = K_NONE, _repeatKind = K_NONE;
  uint32_t _awaitUntil = 0, _repeatAt = 0;
  // 提醒后你真的去做了
  uint8_t _followKind = K_NONE, _praiseBack = K_NONE;
  bool _followGone = false;
  uint32_t _followFrom = 0, _followWindow = 0, _followAway = 0;
  bool _bedFollow = false;
  uint32_t _bedFollowUntil = 0;
};

// ---------------- ② 任务提醒收件箱 ----------------
enum NKind : uint8_t { N_DONE = 0, N_FAILED, N_REMIND, N_PRAISE, N_COUNT };
const char* noticeKey(uint8_t kind);   // task_done / task_failed / reminder / praise
const char* noticeName(uint8_t kind);  // 任务完成 / 任务没成功 / 提醒 / 夸夸
int parseNoticeKind(const char* s);    // 也认 done / failed / fail / error / remind / reminder / praise；不认识 = -1

enum NState : uint8_t { NS_FREE = 0, NS_NEW, NS_SHOWN };
constexpr size_t kTitleMax = 64, kSourceMax = 24, kIdMax = 40;  // 字节（UTF-8，不会截断半个字）
struct Notice {
  uint8_t kind = N_DONE, state = NS_FREE, cues = 0, nudges = 0;
  uint32_t at = 0, lastCueAt = 0, shownAt = 0;
  char title[kTitleMax + 1] = {};
  char source[kSourceMax + 1] = {};
  char id[kIdMax + 1] = {};
};
enum Push : uint8_t { P_QUEUED = 0, P_DUPLICATE, P_REPLACED, P_INVALID, P_RATE };
const char* pushKey(uint8_t p);        // queued / duplicate / replaced / invalid / rate_limited
enum NAct : uint8_t { NA_NONE = 0, NA_CUE, NA_SHOW, NA_NUDGE };
struct NDue {
  uint8_t act = NA_NONE, kind = N_DONE;
  int8_t slot = -1;
};
constexpr uint32_t kNoticeExpireMs = 12u * 3600000u;  // 一直没见到你：12 小时后作废
constexpr uint32_t kShownKeepMs = 30u * 60000u;       // 演给你看了但没摸它：30 分钟后算看过了
constexpr int kRateMax = 20;                          // 每分钟最多收 20 条

// 安全复制一段 UTF-8 文本：去掉控制字符和坏字节，超长时在完整字符处截断，去掉首尾空格。返回是否截断过
bool copyText(char* dst, size_t cap, const char* src);

class Inbox {
 public:
  static constexpr int kCap = 6;
  Inbox() { reset(); }
  void reset();
  uint8_t push(uint8_t kind, const char* title, const char* source, const char* id, uint32_t now, bool* truncated = nullptr);
  // allowCue：可以出声叫你（不是夜里、声音没关）。返回现在该做的一件事
  // 叮咚：跟着最新到的那条走（来了新消息马上叫一次，之后 3 分钟、7 分钟各一次；只在刚到的 20 分钟内叫）；
  // 演出来：从最早的开始，同一种的一起演（三个任务完成 = 庆祝一次）
  NDue tick(const Input& in, bool allowCue);
  void performed(const NDue& d, uint32_t now);
  bool cueDue(uint32_t now) const;  // 该叮咚叫你了（它睡着时用来叫醒它）
  int countNew(uint8_t kind) const; // 还没演过的、这一种的有几条
  bool awaiting() const;           // 已经演给你看了、还没摸它
  int ack(uint32_t now);           // 摸它 = 收到：返回那条的种类；没有演过的新消息 = -2（brain 马上演给你看）；都没有 = -1
  int pending() const;             // 还没收到的（新的 + 演过还没摸的）
  bool hasNew() const;
  const Notice* latest() const;    // 最近收到的一条（可能已经处理完）
  const Notice& slot(int i) const { return _q[i < 0 ? 0 : (i >= kCap ? kCap - 1 : i)]; }
  void clear();
  uint32_t received = 0, delivered = 0, acked = 0, dropped = 0, duplicates = 0, expired = 0;

 private:
  int oldest(uint8_t state) const;
  int newest(uint8_t state) const;
  Notice _q[kCap];
  int _latest = -1;
  char _recent[16][kIdMax + 1] = {};
  int _recentNext = 0;
  uint32_t _rate[kRateMax] = {};
  int _rateNext = 0;
  uint8_t _rateCount = 0;
};

}  // namespace care
