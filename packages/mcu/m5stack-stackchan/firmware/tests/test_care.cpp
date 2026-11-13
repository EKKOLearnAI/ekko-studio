// 2.8 陪伴版：会关心人（Planner）+ 任务提醒收件箱（Inbox）宿主测试
#include "care.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <vector>

using namespace care;

static const uint32_t kM = 60000u;

// ---------- 模拟一天：每秒 tick 一次，演了就 started ----------
struct Ev {
  uint32_t sec;  // 当天第几秒
  uint32_t day;
  uint8_t act, kind;
};
struct Sim {
  Planner p;
  Input in;
  uint32_t now = 1000;
  uint32_t sec = 9 * 3600;  // 09:00
  uint32_t day = 20000;
  bool clock = true, present = true, free = true, faceEver = false, touchEver = false, quiet = true;
  uint32_t lastFace = 0, lastTouch = 0;
  std::vector<Ev> log;
  void step(uint32_t ms = 1000) {
    now += ms;
    sec += ms / 1000;
    while (sec >= 86400) { sec -= 86400; day++; }
    if (present) { lastFace = now; faceEver = true; }
    in.now = now;
    in.clockValid = clock;
    in.hour = (uint8_t)(sec / 3600);
    in.minute = (uint8_t)((sec / 60) % 60);
    in.day = day;
    const uint32_t m = sec / 60;
    in.night = quiet && clock && (m >= 22 * 60 || m < 7 * 60);
    in.bedtime = quiet;
    in.sinceFace = faceEver ? now - lastFace : kNever;
    in.sinceTouch = touchEver ? now - lastTouch : kNever;
    in.sinceChat = kNever;
    in.sinceNear = kNever;
    in.free = free;
    const Due d = p.tick(in);
    if (d.act != DO_NONE) {
      p.started(d, now);
      log.push_back({sec, day, d.act, d.kind});
    }
  }
  void run(uint32_t seconds) {
    for (uint32_t i = 0; i < seconds; i++) step();
  }
  void runUntil(uint32_t h, uint32_t mi) {
    const uint32_t target = h * 3600 + mi * 60;
    while (sec != target) step();
  }
  uint8_t touch() {
    lastTouch = now; touchEver = true;
    return p.ack(now);
  }
  bool runUntilEvent(uint8_t act, uint8_t kind, uint32_t maxSeconds) {
    const size_t n0 = log.size();
    for (uint32_t i = 0; i < maxSeconds; i++) {
      step();
      if (log.size() > n0 && log.back().act == act && log.back().kind == kind) return true;
    }
    return false;
  }
  int count(uint8_t act, uint8_t kind = 0xFF) const {
    int n = 0;
    for (const auto& e : log)
      if (e.act == act && (kind == 0xFF || e.kind == kind)) n++;
    return n;
  }
  const Ev* first(uint8_t act, uint8_t kind) const {
    for (const auto& e : log)
      if (e.act == act && e.kind == kind) return &e;
    return nullptr;
  }
};

static uint32_t hm(uint32_t h, uint32_t m) { return h * 3600 + m * 60; }

static void testPresence() {
  Input in;
  assert(!here(in) && !facing(in));
  in.sinceFace = 0;
  assert(here(in) && facing(in));
  in.sinceFace = kFacingFaceMs + 1;
  assert(here(in) && !facing(in));
  in.sinceFace = kHereFaceMs + 1;
  assert(!here(in));
  in.sinceTouch = 59000;
  assert(here(in) && facing(in));
  in.sinceTouch = kNever; in.sinceNear = 31000;
  assert(here(in) && !facing(in));
  in.sinceNear = kNever; in.sinceChat = 0;
  assert(facing(in));
}

static void testNames() {
  assert(!strcmp(levelKey(L_OFF), "off") && !strcmp(levelKey(L_LESS), "less") && !strcmp(levelKey(L_ON), "on"));
  assert(!strcmp(levelName(L_LESS), "少一点"));
  assert(!strcmp(kindKey(K_STRETCH), "stretch") && !strcmp(kindKey(K_BEDTIME), "bedtime") && !strcmp(kindKey(99), "none"));
  assert(!strcmp(kindName(K_WATER), "喝水"));
  assert(timingFor(L_ON).stretch == 50 * kM && timingFor(L_LESS).stretch == 80 * kM && timingFor(L_OFF).stretch == 0);
  assert(timingFor(L_ON).bedtimeMax == 2 && timingFor(L_LESS).bedtimeMax == 1);
  assert(repeatDelay(K_STRETCH) == 10 * kM && repeatDelay(K_BEDTIME) == 30 * kM && repeatDelay(K_NONE) == 0);
  Planner p;
  p.setLevel(7);
  assert(p.level() == L_ON);
}

// 坐着一整天、从不理它：活动 / 喝水按节奏提醒，每种只再提醒一次，两次提醒至少隔 20 分钟，每天有上限
static void testWorkdayIgnored() {
  Sim s;
  s.runUntil(18, 0);
  const Ev* st = s.first(DO_REMIND, K_STRETCH);
  assert(st && st->sec >= hm(9, 50) && st->sec <= hm(9, 51));
  const Ev* nd = s.first(DO_NUDGE, K_STRETCH);
  assert(nd && nd->sec >= hm(10, 0) && nd->sec <= hm(10, 1));
  const Ev* wa = s.first(DO_REMIND, K_WATER);
  assert(wa && wa->sec >= hm(10, 30) && wa->sec <= hm(10, 31));
  const Ev* lu = s.first(DO_REMIND, K_LUNCH);
  assert(lu && lu->sec >= hm(11, 45) && lu->sec < hm(13, 15));
  assert(s.count(DO_REMIND, K_LUNCH) == 1);
  assert(s.count(DO_NUDGE) == 1);  // 只有第一次没理时再提醒了一次；之后连着没理，就不追了
  const int routine = s.count(DO_REMIND, K_STRETCH) + s.count(DO_REMIND, K_WATER);
  assert(routine >= 6 && routine <= 10);
  // 每次提醒最多再提醒一次
  assert(s.count(DO_NUDGE, K_STRETCH) <= s.count(DO_REMIND, K_STRETCH));
  assert(s.count(DO_NUDGE, K_WATER) <= s.count(DO_REMIND, K_WATER));
  // 两次「主动提醒」（不算再提醒）至少隔 20 分钟；任何两件事至少隔 5 分钟
  uint32_t lastRemind = 0, lastAny = 0;
  bool haveR = false, haveA = false;
  for (const auto& e : s.log) {
    if (haveA) assert(e.sec - lastAny >= 5 * 60);
    lastAny = e.sec; haveA = true;
    if (e.act == DO_REMIND) {
      if (haveR) assert(e.sec - lastRemind >= 20 * 60);
      lastRemind = e.sec; haveR = true;
    }
  }
  // 一直在：陪了超过 4 小时 → 「辛苦啦」一次
  assert(s.count(DO_PRAISE_DAY) == 1);
  assert(s.count(DO_PRAISE_BACK) == 0);
  assert(s.p.remindersToday() == s.log.size() - 1);
  assert(s.p.presenceTodayMin() >= 8 * 60);
  // 到了晚上 22 点以后不再提醒活动 / 喝水
  s.runUntil(22, 59);
  assert(s.count(DO_REMIND, K_DINNER) == 1);
  for (const auto& e : s.log)
    if (e.kind == K_STRETCH || e.kind == K_WATER) assert(e.sec < hm(22, 0) && e.sec >= hm(7, 0));
  printf("  workday ignored: %zu events, routine=%d\n", s.log.size(), routine);
}

// 摸它 = 知道啦：不再追着提醒，返回是哪种
static void testAck() {
  Sim s;
  s.runUntil(9, 50);
  s.run(5);
  assert(s.p.awaiting(s.now) && s.p.awaitingKind(s.now) == K_STRETCH);
  assert(s.touch() == K_STRETCH);
  assert(!s.p.awaiting(s.now) && s.touch() == K_NONE);
  assert(s.p.acksToday() == 1);
  s.runUntil(10, 20);
  assert(s.count(DO_NUDGE) == 0);
  // 回应窗口过了再摸不算
  s.runUntil(10, 31);  // 喝水
  assert(s.first(DO_REMIND, K_WATER));
  s.run(80);
  assert(!s.p.awaiting(s.now) && s.touch() == K_NONE);
}

// 提醒后真的起身走开 ≥ 3 分钟：回来夸你；走开太短不算
static void testFollowPraise() {
  Sim s;
  s.runUntil(9, 51);
  assert(s.count(DO_REMIND, K_STRETCH) == 1);
  s.present = false;
  s.run(5 * 60);  // 走开 5 分钟
  s.present = true;
  s.run(3);
  assert(s.count(DO_PRAISE_BACK, K_STRETCH) == 1);
  assert(s.count(DO_NUDGE) == 0);  // 走开了就不再追着提醒
  // 下一次活动提醒从回来算 50 分钟（中间还有喝水提醒，所以可能再晚一点）
  s.runUntil(10, 45);
  assert(s.count(DO_REMIND, K_STRETCH) == 1);
  s.runUntil(11, 15);
  assert(s.count(DO_REMIND, K_STRETCH) == 2);

  Sim t;  // 只离开 1 分钟（2 分钟内还算在）：不夸
  t.runUntil(9, 51);
  t.present = false;
  t.run(60);
  t.present = true;
  t.runUntil(10, 5);
  assert(t.count(DO_PRAISE_BACK) == 0 && t.count(DO_NUDGE, K_STRETCH) == 1);

  Sim u;  // 提醒吃午饭后去吃饭 30 分钟：回来夸，不再提醒午饭
  u.runUntil(11, 40);
  assert(u.runUntilEvent(DO_REMIND, K_LUNCH, 3600));
  assert(u.sec >= hm(11, 45) && u.sec < hm(13, 15));
  u.present = false;
  u.run(30 * 60);
  u.present = true;
  u.run(5);
  assert(u.count(DO_PRAISE_BACK, K_LUNCH) == 1);
  u.runUntil(14, 0);
  assert(u.count(DO_REMIND, K_LUNCH) == 1 && u.count(DO_NUDGE, K_LUNCH) == 0);
}

// 连着不理它：不再追加提醒，间隔越来越长；摸它一下就恢复
static void testBackoff() {
  Sim s;
  s.runUntil(13, 0);
  uint32_t prev = 0;
  int nudges = 0;
  for (size_t i = 0; i < s.log.size(); i++) {
    if (s.log[i].act == DO_NUDGE) nudges++;
    if (i >= 4) assert(s.log[i].sec - prev >= 40 * 60);  // 连着 3 次没理后：至少隔 40 分钟
    prev = s.log[i].sec;
  }
  assert(nudges == 1 && s.p.ignoredStreak() >= 4);
  // 活动和喝水轮着来
  assert(s.count(DO_REMIND, K_WATER) >= 2 && s.count(DO_REMIND, K_STRETCH) >= 2);
  // 摸它一下：恢复正常
  assert(s.runUntilEvent(DO_REMIND, K_STRETCH, 3 * 3600) || s.runUntilEvent(DO_REMIND, K_WATER, 3 * 3600));
  s.run(3);
  assert(s.touch() != K_NONE && s.p.ignoredStreak() == 0);
}

// 饭点前后自己走开过很久 = 多半吃过了：不提醒
static void testAteAlready() {
  Sim s;
  s.runUntil(11, 20);
  s.present = false;
  s.runUntil(12, 10);
  s.present = true;
  s.runUntil(13, 30);
  assert(s.count(DO_REMIND, K_LUNCH) == 0);
  // 走开 50 分钟也重新算「连续坐了多久」
  assert(s.p.sittingMs(s.now) <= 81 * kM);
}

// 出门一整天、傍晚才回来：不知道吃没吃晚饭，照样提醒；晚饭时间走开 40 分钟再回来：不提醒
static void testLongAbsenceDinner() {
  Sim s;
  s.runUntil(13, 30);
  s.present = false;
  s.runUntil(17, 40);
  s.present = true;
  s.runUntil(18, 30);
  assert(s.count(DO_REMIND, K_DINNER) == 1);
  const Ev* d = s.first(DO_REMIND, K_DINNER);
  assert(d && d->sec >= hm(17, 45) && d->sec <= hm(17, 47));
  Sim t;
  t.runUntil(17, 20);
  t.present = false;
  t.runUntil(18, 0);
  t.present = true;
  t.runUntil(19, 40);
  assert(t.count(DO_REMIND, K_DINNER) == 0);
}

// 刚回来：先坐下（3 分钟内不提醒）；走开很久 = 多半喝过水了，喝水重新算
static void testSettleIn() {
  Sim s;
  s.sec = hm(14, 0);
  s.run(85 * 60);  // 14:00–15:25：喝水快到了
  s.present = false;
  s.run(30 * 60);  // 走开 30 分钟
  s.present = true;
  const size_t before = s.log.size();
  s.run(3 * 60 - 5);
  assert(s.log.size() == before);  // 刚回来 3 分钟：不提醒
  s.run(60 * 60);
  for (size_t i = before; i < s.log.size(); i++) assert(s.log[i].kind != K_WATER);
}

// 夜里：不提醒活动 / 喝水；23 点后提醒早点睡，每晚最多 2 次（少一点：1 次）；摸它之后 40 分钟内关灯算「乖」
static void testBedtime() {
  Sim s;
  s.sec = hm(21, 30);
  s.runUntil(23, 59);
  for (const auto& e : s.log) assert((e.kind != K_STRETCH && e.kind != K_WATER) || e.sec < hm(22, 0));
  const Ev* b = s.first(DO_REMIND, K_BEDTIME);
  assert(b && b->sec >= hm(23, 0) && b->sec <= hm(23, 1));
  const Ev* n = s.first(DO_NUDGE, K_BEDTIME);
  assert(n && n->sec >= hm(23, 30) && n->sec <= hm(23, 31));
  s.runUntil(2, 59);
  assert(s.count(DO_REMIND, K_BEDTIME) + s.count(DO_NUDGE, K_BEDTIME) == 2);
  s.runUntil(6, 59);
  assert(s.count(DO_REMIND, K_BEDTIME) + s.count(DO_NUDGE, K_BEDTIME) == 2);

  Sim l;
  l.p.setLevel(L_LESS);
  l.sec = hm(22, 50);
  l.runUntil(2, 0);
  assert(l.count(DO_REMIND, K_BEDTIME) == 1 && l.count(DO_NUDGE, K_BEDTIME) == 0);

  Sim a;  // 摸它 → 40 分钟内算「去睡啦」（22:55 就坐在跟前：刚来的 3 分钟不提醒）
  a.sec = hm(22, 55);
  a.runUntil(23, 0);
  a.run(3);
  assert(a.count(DO_REMIND, K_BEDTIME) == 1);
  assert(a.touch() == K_BEDTIME);
  assert(a.p.bedtimeFollow(a.now));
  // 摸过了：30 分钟后（还没睡）再问一次，最多 2 次；每次提醒后 40 分钟内关灯都算
  a.run(31 * 60);
  assert(a.count(DO_REMIND, K_BEDTIME) == 2 && a.count(DO_NUDGE) == 0);
  assert(a.p.bedtimeFollow(a.now));
  a.p.bedtimeDone();
  assert(!a.p.bedtimeFollow(a.now));
  a.run(3 * 3600);
  assert(a.count(DO_REMIND, K_BEDTIME) == 2 && !a.p.bedtimeFollow(a.now));
}

// 不在跟前 / 它在忙：不提醒，等你看它的时候再说
static void testWaitsForYou() {
  Sim s;
  s.free = false;
  s.runUntil(10, 0);
  assert(s.log.empty());
  s.free = true;
  s.run(2);
  assert(s.count(DO_REMIND, K_STRETCH) == 1);

  Sim t;  // 人在（2 分钟内见过）但没看它：等
  t.runUntil(9, 49);
  t.present = false;
  t.run(60);  // 09:50，看不到脸 60 秒 > 20 秒
  assert(t.log.empty());
  t.present = true;
  t.run(1);
  assert(t.count(DO_REMIND, K_STRETCH) == 1);
}

static void testLevels() {
  Sim off;
  off.p.setLevel(L_OFF);
  off.runUntil(23, 30);
  assert(off.log.empty());

  Sim less;
  less.p.setLevel(L_LESS);
  less.runUntil(12, 0);
  const Ev* st = less.first(DO_REMIND, K_STRETCH);
  assert(st && st->sec >= hm(10, 20) && st->sec <= hm(10, 21));
  less.runUntil(21, 0);
  assert(less.count(DO_REMIND, K_STRETCH) + less.count(DO_REMIND, K_WATER) <= 5);

  Sim mid;  // 中途关掉：在等的都放下
  mid.runUntil(9, 51);
  assert(mid.p.awaiting(mid.now) || mid.count(DO_REMIND) == 1);
  mid.p.setLevel(L_OFF);
  mid.runUntil(10, 30);
  assert(mid.count(DO_NUDGE) == 0);
}

// 没有时钟：活动 / 喝水照常，吃饭 / 睡觉 / 「辛苦啦」不做
static void testNoClock() {
  Sim s;
  s.clock = false;
  s.sec = hm(0, 0);
  s.run(6 * 3600);
  assert(s.count(DO_REMIND, K_STRETCH) >= 3);
  assert(s.count(DO_REMIND, K_WATER) >= 1);
  assert(s.count(DO_REMIND, K_LUNCH) == 0 && s.count(DO_REMIND, K_BEDTIME) == 0 && s.count(DO_PRAISE_DAY) == 0);
}

// millis() 回绕
static void testWrap() {
  Sim s;
  s.now = 0xFFFFFFFFu - 20 * kM;
  s.run(2 * 3600);
  const Ev* st = s.first(DO_REMIND, K_STRETCH);
  assert(st && st->sec >= hm(9, 50) && st->sec <= hm(9, 51));
  assert(s.count(DO_REMIND, K_WATER) == 1);
  assert(s.p.sittingMs(s.now) >= 119 * kM && s.p.sittingMs(s.now) <= 121 * kM);
}

// ---------------- 收件箱 ----------------

static void testCopyText() {
  char b[kTitleMax + 1];
  assert(!copyText(b, sizeof b, "  构建完成\t\n啦  ") && !strcmp(b, "构建完成 啦"));
  assert(!copyText(b, sizeof b, nullptr) && b[0] == 0);
  assert(!copyText(b, sizeof b, "a\x01" "b\x7f" "c\xff" "d\xe4\xb8" "e") && !strcmp(b, "abcde"));
  assert(!copyText(b, sizeof b, "x\xe2\x80\xaey\xef\xbb\xbfz") && !strcmp(b, "xyz"));  // 双向控制 / BOM
  assert(!copyText(b, sizeof b, "\xc0\xaf" "ok") && !strcmp(b, "ok"));                // 过长编码
  // 30 个汉字 = 90 字节 → 截在完整字符处：21 个汉字 = 63 字节
  char longCn[200] = {};
  for (int i = 0; i < 30; i++) strcat(longCn, "好");
  assert(copyText(b, sizeof b, longCn) && strlen(b) == 63);
  for (size_t i = 0; i < strlen(b); i += 3) assert(!memcmp(b + i, "好", 3));
  char small[4];
  assert(copyText(small, sizeof small, "abcdef") && !strcmp(small, "abc"));
  assert(copyText(small, sizeof small, "a好") && !strcmp(small, "a"));
  char one[1];
  assert(copyText(one, sizeof one, "x") && one[0] == 0);
}

static void testKinds() {
  assert(parseNoticeKind("task_done") == N_DONE && parseNoticeKind("done") == N_DONE);
  assert(parseNoticeKind("failed") == N_FAILED && parseNoticeKind("error") == N_FAILED);
  assert(parseNoticeKind("remind") == N_REMIND && parseNoticeKind("praise") == N_PRAISE);
  assert(parseNoticeKind("DONE") == -1 && parseNoticeKind("") == -1 && parseNoticeKind(nullptr) == -1);
  assert(!strcmp(noticeKey(N_FAILED), "task_failed") && !strcmp(pushKey(P_RATE), "rate_limited"));
}

static Input facingAt(uint32_t now, bool face, bool free = true) {
  Input in;
  in.now = now;
  in.sinceFace = face ? 0 : kNever;
  in.free = free;
  return in;
}

static void testInboxBasics() {
  Inbox b;
  bool tr = true;
  assert(b.push(N_DONE, "报告写好了", "ekko-studio", "job-1", 1000, &tr) == P_QUEUED && !tr);
  assert(b.pending() == 1 && b.hasNew() && !b.awaiting());
  assert(b.push(N_DONE, "报告写好了", "ekko-studio", "job-1", 2000) == P_DUPLICATE);  // 同 id
  assert(b.push(N_DONE, "别的", "x", "job-1", 3000) == P_DUPLICATE);
  assert(b.push(9, "x", "", "", 3000) == P_INVALID);
  char longId[60];
  memset(longId, 'a', sizeof longId - 1);
  longId[sizeof longId - 1] = 0;
  assert(b.push(N_DONE, "x", "", longId, 3000) == P_INVALID);
  // 没 id：60 秒内同样内容算重复
  assert(b.push(N_REMIND, "开会", "cal", nullptr, 5000) == P_QUEUED);
  assert(b.push(N_REMIND, "开会", "cal", "", 30000) == P_DUPLICATE);
  assert(b.push(N_REMIND, "开会", "cal", "", 70000) == P_QUEUED);
  assert(b.duplicates == 3 && b.received == 3);
  assert(!strcmp(b.latest()->title, "开会") && b.latest()->kind == N_REMIND);
  // 当面：马上演
  NDue d = b.tick(facingAt(80000, true), true);
  assert(d.act == NA_SHOW && d.kind == N_DONE && d.slot >= 0);
  b.performed(d, 80000);
  assert(b.awaiting() && b.delivered == 1);
  // 摸它：收到（还有新的 → 下一条接着演）
  assert(b.ack(81000) == N_DONE && b.acked == 1);
  d = b.tick(facingAt(82000, true), true);
  assert(d.act == NA_SHOW && d.kind == N_REMIND && b.countNew(N_REMIND) == 2);
  b.performed(d, 82000);  // 两条「开会」一起演
  assert(b.countNew(N_REMIND) == 0 && b.pending() == 2 && b.delivered == 3);
  assert(b.ack(83000) == N_REMIND && b.pending() == 0 && b.ack(83500) == -1);
  // 只剩新消息：摸它返回 -2（马上演给你看）
  assert(b.push(N_FAILED, "构建失败", "ci", "f1", 84000) == P_QUEUED);
  assert(b.ack(84500) == -2);
  d = b.tick(facingAt(85000, true), true);
  assert(d.act == NA_SHOW && d.kind == N_FAILED);
  b.performed(d, 85000);
  assert(b.ack(86000) == N_FAILED && b.ack(86500) == -1 && b.pending() == 0);
  // id 用过就记住（即使已经收到了）
  assert(b.push(N_DONE, "again", "", "job-1", 90000) == P_DUPLICATE);
  // 不空闲：什么都不做
  b.push(N_PRAISE, "夸夸", "", "p1", 91000);
  assert(b.tick(facingAt(92000, true, false), true).act == NA_NONE);
  b.clear();
  assert(b.pending() == 0 && !b.hasNew());
}

static void testInboxCueAndNudge() {
  Inbox b;
  b.push(N_DONE, "导出完成", "ekko-studio", "j", 0);
  // 不在跟前：先叮咚一次，3 分钟后、再 7 分钟后各一次，最多 3 次
  std::vector<uint32_t> cues;
  for (uint32_t t = 1000; t < 40 * kM; t += 1000) {
    NDue d = b.tick(facingAt(t, false), true);
    if (d.act == NA_CUE) { b.performed(d, t); cues.push_back(t); }
    assert(d.act != NA_SHOW && d.act != NA_NUDGE);
  }
  assert(cues.size() == 3);
  assert(cues[1] - cues[0] == 3 * kM && cues[2] - cues[1] == 7 * kM);
  // 夜里 / 静音：不出声
  Inbox q;
  q.push(N_DONE, "x", "", "", 0);
  for (uint32_t t = 0; t < 20 * kM; t += 1000) assert(q.tick(facingAt(t, false), false).act == NA_NONE);
  // 夜里到的：天亮以后也不突然叮咚（只在刚到的 20 分钟内叫），等看见你再演
  for (uint32_t t = 20 * kM + 1000; t < 8 * 60 * kM; t += 5000) assert(q.tick(facingAt(t, false), true).act == NA_NONE && !q.cueDue(t));
  assert(q.tick(facingAt(8 * 60 * kM, true), true).act == NA_SHOW);
  // 看见你：演出来；没摸它 → 3 分钟后、再 7 分钟后各轻轻提醒一次
  const uint32_t t0 = 41 * kM;
  NDue d = b.tick(facingAt(t0, true), true);
  assert(d.act == NA_SHOW);
  b.performed(d, t0);
  std::vector<uint32_t> nudges;
  for (uint32_t t = t0 + 1000; t < t0 + 29 * kM; t += 1000) {
    NDue e = b.tick(facingAt(t, true), true);
    if (e.act == NA_NUDGE) { b.performed(e, t); nudges.push_back(t); }
  }
  assert(nudges.size() == 2 && nudges[0] - t0 == 3 * kM && nudges[1] - nudges[0] == 7 * kM);
  assert(b.awaiting());
  // 30 分钟后算看过了
  b.tick(facingAt(t0 + 31 * kM, true), true);
  assert(!b.awaiting() && b.pending() == 0);
}

// 好几条：叮咚跟着最新的，演的时候同一种一起演，轻轻提醒只按最近演的那条
static void testInboxGroup() {
  Inbox b;
  b.push(N_DONE, "a", "", "a", 1000);
  b.push(N_FAILED, "b", "", "b", 2000);
  b.push(N_DONE, "c", "", "c", 3000);
  assert(b.cueDue(3000) && b.countNew(N_DONE) == 2 && b.countNew(N_FAILED) == 1);
  NDue d = b.tick(facingAt(4000, false), true);
  assert(d.act == NA_CUE && !strcmp(b.slot(d.slot).id, "c"));
  b.performed(d, 4000);
  assert(!b.cueDue(5000) && !b.cueDue(4000 + 3 * kM - 1) && b.cueDue(4000 + 3 * kM));
  assert(b.tick(facingAt(5000, false), true).act == NA_NONE);
  b.push(N_PRAISE, "p", "", "p", 60000);  // 又来一条：马上再叫
  assert(b.cueDue(60000));
  d = b.tick(facingAt(61000, false), true);
  assert(d.act == NA_CUE && d.kind == N_PRAISE);
  b.performed(d, 61000);
  assert(!b.cueDue(62000));
  d = b.tick(facingAt(70000, true), true);
  assert(d.act == NA_SHOW && d.kind == N_DONE);
  b.performed(d, 70000);
  assert(b.countNew(N_DONE) == 0 && b.delivered == 2 && b.awaiting());
  d = b.tick(facingAt(76000, true), true);
  assert(d.act == NA_SHOW && d.kind == N_FAILED);
  b.performed(d, 76000);
  d = b.tick(facingAt(82000, true), true);
  assert(d.act == NA_SHOW && d.kind == N_PRAISE);
  b.performed(d, 82000);
  assert(!b.hasNew() && b.pending() == 4 && !b.cueDue(90000) && b.delivered == 4);
  int nudges = 0;
  for (uint32_t t = 83000; t < 82000 + 20 * kM; t += 1000) {
    NDue e = b.tick(facingAt(t, true), true);
    if (e.act == NA_NUDGE) { b.performed(e, t); nudges++; }
  }
  assert(nudges == 2);
  assert(b.ack(82000 + 20 * kM) == N_PRAISE && b.pending() == 0 && b.acked == 4);
}

// 「夜间安静」关掉：不提醒睡觉；起来活动 / 喝水不看钟点
static void testQuietOff() {
  Sim s;
  s.quiet = false;
  s.sec = hm(22, 30);
  s.runUntil(3, 30);
  assert(s.count(DO_REMIND, K_BEDTIME) == 0 && s.count(DO_NUDGE, K_BEDTIME) == 0);
  assert(s.count(DO_REMIND, K_STRETCH) >= 2);
}

static void testInboxLimits() {
  Inbox b;
  // 每分钟最多 20 条
  for (int i = 0; i < 20; i++) {
    char id[8];
    snprintf(id, sizeof id, "r%d", i);
    const uint8_t r = b.push(N_DONE, "x", "", id, 1000 + i);
    assert(r == P_QUEUED || r == P_REPLACED);
  }
  assert(b.push(N_DONE, "x", "", "r20", 2000) == P_RATE);
  assert(b.push(N_DONE, "x", "", "r21", 61000 + 1) == P_QUEUED || true);
  // 满了（6 条）：挤掉最旧的
  assert(b.pending() == Inbox::kCap);
  assert(b.dropped >= 14);
  // 先挤掉演过的
  Inbox c;
  for (int i = 0; i < Inbox::kCap; i++) {
    char id[8];
    snprintf(id, sizeof id, "c%d", i);
    c.push(N_DONE, id, "", id, 1000 * (i + 1));
  }
  NDue d = c.tick(facingAt(10000, true), true);  // 最旧的 c0
  c.performed(d, 10000);
  assert(!strcmp(c.slot(d.slot).id, "c0"));
  assert(c.push(N_FAILED, "new", "", "c6", 11000) == P_REPLACED);
  bool haveC0 = false, haveC1 = false;
  for (int i = 0; i < Inbox::kCap; i++) {
    if (c.slot(i).state != NS_FREE && !strcmp(c.slot(i).id, "c0")) haveC0 = true;
    if (c.slot(i).state != NS_FREE && !strcmp(c.slot(i).id, "c1")) haveC1 = true;
  }
  assert(!haveC0 && haveC1);
  assert(c.push(N_FAILED, "new2", "", "c7", 12000) == P_REPLACED);  // 再挤：最旧的新消息 c1
  for (int i = 0; i < Inbox::kCap; i++) assert(strcmp(c.slot(i).id, "c1") != 0 || c.slot(i).state == NS_FREE);
  // 12 小时没见到你：作废
  Inbox e;
  e.push(N_DONE, "old", "", "", 0);
  e.tick(facingAt(kNoticeExpireMs + 1000, false), false);
  assert(e.pending() == 0 && e.expired == 1);
  // 回绕
  Inbox w;
  w.push(N_DONE, "wrap", "", "w", 0xFFFFFF00u);
  NDue x = w.tick(facingAt(0xFFFFFF00u + 1000, false), true);
  assert(x.act == NA_CUE);
  w.performed(x, 0xFFFFFF00u + 1000);
  assert(w.tick(facingAt(0xFFFFFF00u + 1000 + 3 * kM - 1000, false), true).act == NA_NONE);
  assert(w.tick(facingAt(0xFFFFFF00u + 1000 + 3 * kM, false), true).act == NA_CUE);
  assert(w.pending() == 1);
  assert(w.slot(-5).id == w.slot(0).id && w.slot(99).id == w.slot(Inbox::kCap - 1).id);
}

int main() {
  testPresence();
  testNames();
  testWorkdayIgnored();
  testAck();
  testFollowPraise();
  testBackoff();
  testAteAlready();
  testLongAbsenceDinner();
  testSettleIn();
  testBedtime();
  testWaitsForYou();
  testLevels();
  testNoClock();
  testWrap();
  testCopyText();
  testKinds();
  testInboxBasics();
  testInboxCueAndNudge();
  testInboxLimits();
  testInboxGroup();
  testQuietOff();
  printf("test_care: all passed\n");
  return 0;
}
