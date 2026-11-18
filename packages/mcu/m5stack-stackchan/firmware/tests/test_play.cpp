// 2.9 活泼版：一起玩（play.cpp）宿主测试
// 活跃度 / 主动邀请（学会多久邀请一次、连着没理就先不烦你、每天上限）/ 躲猫猫 / 摸头节奏模仿（判定 + 整局流程）/
// 连拍手势 / 每晚心情打卡（7 天记录、平均、趋势、持续低落、每周小结、NVS 校验）/ 什么时候问 / 新加的 5 个合成音
#include "play.h"
#include "companion.h"
#include "sfx_synth.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(c)                                                              \
  do {                                                                        \
    if (!(c)) {                                                               \
      fprintf(stderr, "CHECK failed %s:%d: %s\n", __FILE__, __LINE__, #c);    \
      abort();                                                                \
    }                                                                         \
  } while (0)

using namespace play;

static uint32_t g_rng = 12345;
static float rnd() {
  g_rng = g_rng * 1103515245u + 12345u;
  return (float)((g_rng >> 8) & 0xFFFF) / 65536.f;
}

static void testLevels() {
  CHECK(parseLevel("quiet") == LV_QUIET && parseLevel("0") == LV_QUIET && parseLevel("安静") == LV_QUIET);
  CHECK(parseLevel("normal") == LV_NORMAL && parseLevel("1") == LV_NORMAL && parseLevel("适中") == LV_NORMAL);
  CHECK(parseLevel("lively") == LV_LIVELY && parseLevel("2") == LV_LIVELY && parseLevel("活泼") == LV_LIVELY);
  CHECK(parseLevel("loud") == -1 && parseLevel(nullptr) == -1 && parseLevel("") == -1);
  CHECK(!strcmp(levelKey(LV_QUIET), "quiet") && !strcmp(levelKey(LV_NORMAL), "normal") && !strcmp(levelKey(LV_LIVELY), "lively"));
  CHECK(!strcmp(levelKey(99), "lively") && !strcmp(levelName(LV_QUIET), "安静"));
  CHECK(spontScale(LV_QUIET) == 1.f && spontScale(LV_NORMAL) < 1.f && spontScale(LV_LIVELY) < spontScale(LV_NORMAL));
  CHECK(microGap(LV_QUIET, .5f) == 0);
  for (int i = 0; i <= 10; i++) {
    const float r = i / 10.f;
    CHECK(microGap(LV_LIVELY, r) >= 8000 && microGap(LV_LIVELY, r) <= 20000);
    CHECK(microGap(LV_NORMAL, r) >= 20000 && microGap(LV_NORMAL, r) <= 40000);
  }
  CHECK(microGap(LV_LIVELY, -3.f) == 8000 && microGap(LV_LIVELY, 7.f) == 20000);
  for (uint8_t b = 0; b < BID_COUNT; b++) CHECK(bidKey(b) && bidName(b));
  CHECK(!strcmp(bidKey(BID_PLAY), "play") && !strcmp(bidKey(77), "none"));
}

static BidInput facingInput(uint32_t now, uint8_t level) {
  BidInput in;
  in.now = now;
  in.level = level;
  in.ready = true;
  in.camera = true;
  in.facing = true;
  in.facingMs = 8000;
  in.day = 500;
  in.playful = .6f;
  in.warmth = .3f;
  return in;
}

// 一直看着它，每秒 tick 一次，直到发出一个邀请（最多 maxMs）
static uint8_t waitBid(Bids& b, uint32_t& t, uint8_t level, uint32_t maxMs, bool gameOk = true) {
  for (uint32_t e = 0; e <= maxMs; e += 1000, t += 1000) {
    BidInput in = facingInput(t, level);
    in.gameOk = gameOk;
    const uint8_t k = b.tick(in, rnd(), rnd());
    if (k != BID_NONE) return k;
  }
  return BID_NONE;
}

static void testBids() {
  // 第一次：开机后 1–2 分钟（活泼），发出来以后等 8 秒回应
  {
    Bids b;
    b.reset(1000);
    uint32_t t = 1000;
    const uint8_t k = waitBid(b, t, LV_LIVELY, 200000);
    CHECK(k != BID_NONE && k < BID_COUNT);
    CHECK(t - 1000 >= 40000 && t - 1000 <= 120000);
    b.started(k, t);
    CHECK(b.waiting(t) && b.waitingKind() == k && b.today() == 1 && b.offered == 1);
    CHECK(b.tick(facingInput(t + 1000, LV_LIVELY), .5f, .5f) == BID_NONE);  // 等回应时不再发
    CHECK(b.respond(t + 3000) == k);
    CHECK(b.accepted == 1 && b.todayAccepted() == 1 && !b.waiting(t + 3000) && b.acceptance() > .55f);
    CHECK(b.respond(t + 3500) == BID_NONE);  // 只算一次
  }
  // 不在跟前 / 不方便 / 刚摸过 / 刚演过：不发
  {
    Bids b;
    b.reset(0);
    uint32_t t = 0;
    for (; t < 400000; t += 1000) {
      BidInput in = facingInput(t, LV_LIVELY);
      switch ((t / 1000) % 5) {
        case 0: in.facing = false; break;
        case 1: in.facingMs = 2000; break;
        case 2: in.ready = false; break;
        case 3: in.sinceTouch = 15000; break;
        default: in.sinceShow = 5000; break;
      }
      CHECK(b.tick(in, rnd(), rnd()) == BID_NONE);
    }
    // 没有相机：刚摸过 / 说过话 / 靠近过就算在
    BidInput in = facingInput(t, LV_LIVELY);
    in.camera = false;
    in.facing = false;
    in.sinceTouch = 60000;
    CHECK(b.tick(in, .5f, .5f) != BID_NONE);
    in.sinceTouch = 400000;
    in.sinceChat = kNever;
    in.sinceNear = kNever;
    Bids c;
    c.reset(0);
    for (uint32_t u = 0; u < 400000; u += 1000) {
      in.now = u;
      CHECK(c.tick(in, rnd(), rnd()) == BID_NONE);
    }
  }
  // 安静：从来不发；上限 0
  {
    Bids b;
    b.reset(0);
    uint32_t t = 0;
    CHECK(waitBid(b, t, LV_QUIET, 3600000) == BID_NONE);
    CHECK(Bids::dailyCap(LV_QUIET) == 0 && Bids::dailyCap(LV_NORMAL) == 16 && Bids::dailyCap(LV_LIVELY) == 40);
  }
  // 连着 3 次没理：先不烦你（活泼 20 分钟）；之后又会邀请
  {
    Bids b;
    b.reset(0);
    uint32_t t = 0;
    for (int i = 0; i < 3; i++) {
      const uint8_t k = waitBid(b, t, LV_LIVELY, 400000);
      CHECK(k != BID_NONE);
      b.started(k, t);
      t += Bids::kWindowMs + 1000;
      CHECK(!b.waiting(t));
      CHECK(b.tick(facingInput(t, LV_LIVELY), .5f, .5f) == BID_NONE);  // 这一下记成「没理」
      CHECK(b.ignored == (uint32_t)i + 1);
    }
    CHECK(b.snoozes == 1 && b.snoozed(t) && b.acceptance() < .3f);
    const uint32_t snoozeAt = t;
    const uint8_t k = waitBid(b, t, LV_LIVELY, 60u * 60000u);
    CHECK(k != BID_NONE);
    CHECK(t - snoozeAt >= 20u * 60000u);
    // 很少接的话间隔会拉长：比常接的时候长
  }
  // 你常接：间隔越来越短；每天最多 40 次；第二天重新数
  {
    Bids b;
    b.reset(0);
    uint32_t t = 0, prev = 0, firstGap = 0, lastGap = 0;
    int n = 0;
    for (;;) {
      const uint8_t k = waitBid(b, t, LV_LIVELY, 600000);
      if (k == BID_NONE) break;
      b.started(k, t);
      CHECK(b.respond(t + 1500) == k);
      if (n == 1) firstGap = t - prev;
      lastGap = t - prev;
      prev = t;
      n++;
      t += 25000;  // 回应以后：演一段 + 摸过（20 秒内不发）
      CHECK(n <= 40);
    }
    CHECK(n == 40 && b.today() == 40 && b.todayAccepted() == 40 && b.acceptance() > .95f);
    CHECK(lastGap < firstGap);
    printf("  bids: 40 accepted, first gap %.0f s, last gap %.0f s\n", firstGap / 1000.f, lastGap / 1000.f);
    // 第二天：重新数
    BidInput in = facingInput(t, LV_LIVELY);
    in.day = 501;
    uint8_t k = BID_NONE;
    for (uint32_t e = 0; e < 300000 && k == BID_NONE; e += 1000) {
      in.now = t + e;
      k = b.tick(in, rnd(), rnd());
    }
    CHECK(k != BID_NONE && b.today() == 0);
  }
  // 适中：间隔更长，每天最多 16 次
  {
    Bids b;
    b.reset(0);
    uint32_t t = 0;
    int n = 0;
    for (;;) {
      const uint8_t k = waitBid(b, t, LV_NORMAL, 900000);
      if (k == BID_NONE) break;
      b.started(k, t);
      b.respond(t + 1000);
      n++;
      t += 25000;
    }
    CHECK(n == 16);
  }
  // 刚玩过节奏游戏：不邀请「一起玩」；也不会连着两次一样（权重压低）
  {
    Bids b;
    b.reset(0);
    uint32_t t = 0;
    int counts[BID_COUNT] = {0}, same = 0;
    uint8_t last = BID_NONE;
    for (int i = 0; i < 300; i++) {
      const uint8_t k = waitBid(b, t, LV_LIVELY, 600000, false);
      CHECK(k != BID_NONE && k != BID_PLAY);
      counts[k]++;
      if (k == last) same++;
      last = k;
      b.started(k, t);
      b.respond(t + 1000);
      t += 25000;
      if (b.today() >= 39) t += 24u * 3600000u;  // 跳过上限：换一天
      if (b.today() >= 39) {
        BidInput in = facingInput(t, LV_LIVELY);
        in.day = 600 + (uint32_t)i;
        b.tick(in, .5f, .5f);
      }
    }
    for (uint8_t k = BID_PET; k < BID_COUNT; k++)
      if (k != BID_PLAY) CHECK(counts[k] > 20);
    CHECK(same < 60);
  }
  // 被别的事打断：不算没理
  {
    Bids b;
    b.reset(0);
    uint32_t t = 0;
    const uint8_t k = waitBid(b, t, LV_LIVELY, 300000);
    b.started(k, t);
    b.cancel();
    CHECK(!b.waiting(t) && b.ignored == 0 && b.ignoredRow() == 0);
  }
}

static void testPeekaboo() {
  // 看着它 5 秒，躲开：1.6 秒后开始找；回来 = 找到你啦
  {
    Peekaboo p;
    uint32_t t = 0;
    for (; t < 5000; t += 50) CHECK(p.update(t, true, true, true, LV_LIVELY) == Peekaboo::PK_NONE);
    uint8_t ev = 0;
    uint32_t lost = t;
    for (; t < lost + 3000 && ev == 0; t += 50) ev = p.update(t, false, true, true, LV_LIVELY);
    CHECK(ev == Peekaboo::PK_SEARCH && t - lost >= Peekaboo::kSearchMs && p.searching());
    for (int i = 0; i < 20; i++, t += 50) CHECK(p.update(t, false, true, true, LV_LIVELY) == Peekaboo::PK_NONE);
    CHECK(p.update(t, true, true, true, LV_LIVELY) == Peekaboo::PK_FOUND);
    CHECK(!p.searching() && p.found == 1 && p.streak() == 1);
    // 接着玩：找到以后 5–20 秒内再躲（看 1.5 秒就够）→ 连着第 2 次
    const uint32_t foundAt = t;
    for (t += 50; t < foundAt + 6000; t += 50) p.update(t, true, true, true, LV_LIVELY);
    ev = 0;
    for (; ev == 0 && t < foundAt + 12000; t += 50) ev = p.update(t, false, true, true, LV_LIVELY);
    CHECK(ev == Peekaboo::PK_SEARCH);
    CHECK(p.update(t, true, true, true, LV_LIVELY) == Peekaboo::PK_FOUND && p.streak() == 2);
    // 冷却中（不是接着玩）：不找
    t += 30000;
    for (uint32_t e = 0; e < 6000; e += 50, t += 50) p.update(t, true, true, true, LV_LIVELY);
    for (uint32_t e = 0; e < 10000; e += 50, t += 50) CHECK(p.update(t, false, true, true, LV_LIVELY) == Peekaboo::PK_NONE);
  }
  // 只看了 3 秒就走：不算在玩
  {
    Peekaboo p;
    uint32_t t = 0;
    for (; t < 3000; t += 50) p.update(t, true, true, true, LV_LIVELY);
    for (uint32_t e = 0; e < 12000; e += 50, t += 50) CHECK(p.update(t, false, true, true, LV_LIVELY) == Peekaboo::PK_NONE);
  }
  // 找不到：8 秒后算了
  {
    Peekaboo p;
    uint32_t t = 0;
    for (; t < 6000; t += 50) p.update(t, true, true, true, LV_NORMAL);
    const uint32_t lost = t;
    int search = 0, giveup = 0;
    for (; t < lost + 12000; t += 50) {
      const uint8_t ev = p.update(t, false, true, true, LV_NORMAL);
      if (ev == Peekaboo::PK_SEARCH) search++;
      if (ev == Peekaboo::PK_GIVEUP) {
        giveup++;
        CHECK(t - lost >= Peekaboo::kGiveUpMs);
      }
    }
    CHECK(search == 1 && giveup == 1 && !p.searching() && p.streak() == 0);
  }
  // 被打断（keep = false）：不找了，不算一轮
  {
    Peekaboo p;
    uint32_t t = 0;
    for (; t < 6000; t += 50) p.update(t, true, true, true, LV_LIVELY);
    while (!p.searching()) p.update(t += 50, false, true, true, LV_LIVELY);
    CHECK(p.update(t += 50, false, true, false, LV_LIVELY) == Peekaboo::PK_NONE && !p.searching());
    CHECK(p.update(t += 50, true, true, true, LV_LIVELY) == Peekaboo::PK_NONE && p.found == 0);
  }
  // 现在不方便（canStart = false）：不找；安静：不找
  {
    Peekaboo p, q;
    uint32_t t = 0;
    for (; t < 6000; t += 50) {
      p.update(t, true, true, true, LV_LIVELY);
      q.update(t, true, true, true, LV_QUIET);
    }
    for (uint32_t e = 0; e < 12000; e += 50, t += 50) {
      CHECK(p.update(t, false, false, true, LV_LIVELY) == Peekaboo::PK_NONE);
      CHECK(q.update(t, false, true, true, LV_QUIET) == Peekaboo::PK_NONE);
    }
  }
}

static uint8_t judgeAt(const uint16_t* g, int beats, float scale, const float* jitter = nullptr, float* err = nullptr) {
  uint32_t taps[Rhythm::kMaxBeats];
  float t = 1000.f;
  for (int i = 0; i < beats; i++) {
    taps[i] = (uint32_t)(t + .5f);
    if (i + 1 < beats) t += scale * g[i] * (1.f + (jitter ? jitter[i] : 0.f));
  }
  return Rhythm::judge(g, beats, taps, beats, err);
}

static void testJudge() {
  const uint16_t flat[4] = {520, 520, 520, 520};
  const uint16_t mix[4] = {320, 640, 320, 640};
  float err = 1.f;
  CHECK(judgeAt(flat, 3, 1.f, nullptr, &err) == Rhythm::RR_PERFECT && err < .01f);
  CHECK(judgeAt(flat, 4, 1.3f) == Rhythm::RR_PERFECT);     // 整体慢一点：没关系
  CHECK(judgeAt(flat, 4, .6f) == Rhythm::RR_PERFECT);      // 整体快一点：没关系
  CHECK(judgeAt(flat, 4, 3.f) == Rhythm::RR_MISS);         // 慢太多
  const float j1[4] = {.3f, -.3f, .2f, 0.f};
  CHECK(judgeAt(flat, 4, 1.f, j1) == Rhythm::RR_GOOD);     // 平的：有点不均匀 = 不错
  const float j2[4] = {.6f, -.5f, .4f, 0.f};
  CHECK(judgeAt(flat, 4, 1.f, j2) == Rhythm::RR_MISS);     // 太乱
  CHECK(judgeAt(mix, 5, 1.f) == Rhythm::RR_PERFECT);
  CHECK(judgeAt(mix, 5, 1.4f) == Rhythm::RR_PERFECT);
  const float j3[4] = {.3f, -.2f, .3f, -.2f};
  CHECK(judgeAt(mix, 5, 1.f, j3) == Rhythm::RR_GOOD);      // 快慢的样子对了就算过
  const uint16_t swapped[4] = {640, 320, 640, 320};
  uint32_t taps[5];
  uint32_t t = 0;
  for (int i = 0; i < 5; i++) {
    taps[i] = t;
    if (i < 4) t += swapped[i];
  }
  CHECK(Rhythm::judge(mix, 5, taps, 5) == Rhythm::RR_MISS);  // 快慢反了
  CHECK(Rhythm::judge(mix, 5, taps, 4) == Rhythm::RR_MISS);  // 少拍一下
  const uint32_t two[2] = {100, 9000};
  CHECK(Rhythm::judge(flat, 2, two, 2) == Rhythm::RR_PERFECT);  // 两下：拍对数就好
  const uint32_t back[3] = {100, 50, 600};
  CHECK(Rhythm::judge(flat, 3, back, 3) == Rhythm::RR_MISS);
  CHECK(Rhythm::judge(nullptr, 3, back, 3) == Rhythm::RR_MISS && Rhythm::judge(flat, 0, back, 0) == Rhythm::RR_MISS);
}

// 整局：mode 0 = 每轮照着拍，1 = 一直少拍一下，2 = 一直不拍
static void playGame(int mode, uint32_t seed, int* passed, uint32_t* lengthMs, int* rounds) {
  Rhythm r;
  uint32_t t = 5000;
  r.start(t, seed);
  CHECK(r.active());
  int beatsSeen = 0, results = 0, nRounds = 0;
  uint32_t plan[Rhythm::kMaxTaps];
  int nPlan = 0, next = 0;
  bool ended = false;
  for (uint32_t e = 0; e < 120000 && !ended; e += 10, t += 10) {
    if (next < nPlan && t >= plan[next]) {
      CHECK(r.tap(t));
      next++;
    }
    const Rhythm::Ev ev = r.update(t);
    switch (ev.type) {
      case Rhythm::RE_ROUND: nRounds++; beatsSeen = 0; break;
      case Rhythm::RE_BEAT:
        CHECK(ev.index == beatsSeen);
        beatsSeen++;
        CHECK(!r.tap(t));  // 它敲的时候拍不算
        break;
      case Rhythm::RE_TURN: {
        CHECK(beatsSeen == r.beats() && r.listening());
        nPlan = next = 0;
        if (mode == 2) break;
        const int n = mode == 1 ? r.beats() - 1 : r.beats();
        uint32_t at = t + 600;
        for (int i = 0; i < n; i++) {
          plan[nPlan++] = at;
          if (i + 1 < r.beats()) at += r.gaps()[i];
        }
        if (mode == 1 && n == 0) plan[nPlan++] = at;  // 至少拍一下
        break;
      }
      case Rhythm::RE_RESULT:
        results++;
        if (mode == 0) CHECK(ev.result == Rhythm::RR_PERFECT);
        if (mode == 1) CHECK(ev.result == Rhythm::RR_MISS);
        if (mode == 2) CHECK(ev.result == Rhythm::RR_TIMEOUT && ev.index == 0);
        break;
      case Rhythm::RE_END: ended = true; break;
      default: break;
    }
  }
  CHECK(ended && !r.active());
  *passed = r.passed();
  *lengthMs = t - 5000;
  *rounds = nRounds;
  (void)results;
}

static void testRhythmGame() {
  int passed = 0, rounds = 0;
  uint32_t len = 0;
  playGame(0, 7, &passed, &len, &rounds);
  CHECK(passed == Rhythm::kRounds && rounds == Rhythm::kRounds);
  CHECK(len > 20000 && len < 60000);
  printf("  rhythm: perfect game %u ms\n", len);
  playGame(1, 9, &passed, &len, &rounds);
  CHECK(passed == 0 && rounds == 2);  // 拍错了：同一段再来一次，还是错：结束
  playGame(2, 11, &passed, &len, &rounds);
  CHECK(passed == 0 && rounds == 1 && len < 15000);  // 不拍：不玩啦
  // 拍子的样子：前两关是平的，后面有快有慢；每次不一样
  Rhythm a, b;
  a.start(0, 1);
  b.start(0, 2);
  CHECK(a.beats() == 2 && a.gaps()[0] == 520);
  // 抖一下（120 毫秒内两次）只算一下
  Rhythm r;
  uint32_t t = 0;
  r.start(t, 3);
  while (!r.listening() && t < 20000) r.update(t += 10);
  CHECK(r.listening());
  CHECK(r.tap(t) && r.tap(t + 60) && r.taps() == 1);
  CHECK(r.tap(t + 500) && r.taps() == 2);
  r.stop();
  CHECK(!r.active() && !r.tap(t + 900));
}

static void testTapSeq() {
  TapSeq s;
  CHECK(s.update(0) == 0);
  s.tap(1000);
  s.tap(1400);
  CHECK(s.pending() == 2 && s.update(1900) == 0);
  CHECK(s.update(2200) == 2 && s.update(2300) == 0);
  s.tap(3000);
  s.tap(3500);
  s.tap(4100);
  CHECK(s.update(4800) == 0 && s.update(4900) == 3);
  s.tap(6000);
  s.tap(6800);  // 隔太久：重新数
  CHECK(s.update(7700) == 1);
  s.tap(0xFFFFFF00u);  // millis 回绕
  s.tap(0x00000100u);
  CHECK(s.update(0x00000500u) == 2);
}

static void testMood() {
  MoodLog m;
  CHECK(m.entries(100) == 0 && m.average(100) == 0.f && m.scoreOn(100) == -1 && !m.dirty());
  CHECK(!m.add(0, 3) && !m.add(100, 0) && !m.add(100, 6));
  CHECK(m.add(100, 4) && m.dirty() && m.scoreOn(100) == 4);
  CHECK(m.add(100, 5) && m.scoreOn(100) == 5 && m.entries(100) == 1);  // 同一天 = 改分数
  CHECK(m.data().total == 1);
  m.add(101, 3);
  m.add(103, 1);
  CHECK(m.entries(103) == 3 && fabsf(m.average(103) - 3.f) < 1e-4f);
  CHECK(m.entries(109) == 1 && m.entries(110) == 0);  // 只算最近 7 天
  CHECK(!m.summaryDue(103));
  m.add(104, 2);
  CHECK(m.summaryDue(104));
  m.summarized(104);
  CHECK(!m.summaryDue(105) && !m.summaryDue(110) && m.summaryDue(111) == (m.entries(111) >= 4));
  // 最近 3 次比之前：变差了
  CHECK(m.trend(104) == -1);
  CHECK(!m.persistentLow(104));  // 1、2 两次低：还不算
  m.add(105, 2);
  CHECK(!m.persistentLow(105));  // 3 次 ≤ 2 分，但 5、3、1、2、2 平均 2.6：还不算
  MoodLog low;
  low.add(200, 2);
  low.add(201, 1);
  low.add(202, 3);
  low.add(203, 2);
  CHECK(low.persistentLow(203) && low.average(203) < 2.5f);
  MoodLog up;
  up.add(300, 2);
  up.add(301, 2);
  up.add(302, 4);
  up.add(303, 5);
  up.add(304, 4);
  CHECK(up.trend(304) == 1 && !up.persistentLow(304));
  // 最多 7 条：旧的挤掉
  MoodLog w;
  for (uint32_t d = 1; d <= 10; d++) w.add(d, (uint8_t)(1 + d % 5));
  CHECK(w.data().count == kMoodDays && w.data().day[0] == 4 && w.data().day[6] == 10 && w.data().total == 10);
  CHECK(w.add(8, 5) && w.scoreOn(8) == 5 && w.data().count == kMoodDays);  // 同一天：改分数
  // 时钟往回调：丢掉「未来」的记录
  MoodLog back;
  back.add(10, 3);
  back.add(12, 4);
  back.add(14, 5);
  CHECK(back.add(13, 1) && back.data().count == 3 && back.data().day[2] == 13 && back.scoreOn(14) == -1);
  // 问过几次（按天）
  MoodLog q;
  q.asked(50);
  q.asked(50);
  CHECK(q.asksOn(50) == 2 && q.asksOn(51) == 0);
  q.asked(51);
  CHECK(q.asksOn(51) == 1 && q.asksOn(50) == 0);
  // NVS：保存 / 读回 / 校验
  MoodData d = m.save();
  CHECK(d.magic == kMoodMagic && d.version == kMoodVersion && d.size == sizeof(MoodData));
  MoodLog r;
  CHECK(r.load(&d, sizeof d) && !r.dirty() && r.scoreOn(104) == 2 && r.data().summaryDay == 104);
  MoodData bad = d;
  bad.score[0] = 9;
  CHECK(!r.load(&bad, sizeof bad));
  bad = d;
  bad.crc ^= 1;
  CHECK(!r.load(&bad, sizeof bad));
  CHECK(!r.load(&d, sizeof d - 1) && !r.load(nullptr, sizeof d));
  bad = d;
  bad.version = 2;
  bad.crc = companion::crc32(&bad, offsetof(MoodData, crc));
  CHECK(!r.load(&bad, sizeof bad));
  bad = d;
  bad.day[1] = bad.day[0];  // 日期必须从旧到新
  bad.crc = companion::crc32(&bad, offsetof(MoodData, crc));
  CHECK(!r.load(&bad, sizeof bad));
  CHECK(r.scoreOn(104) == 2);  // 读失败：内容不变
  r.clear();
  CHECK(r.entries(104) == 0 && r.dirty());
  r.clean();
  CHECK(!r.dirty());
}

static CheckInput evening(uint8_t h, uint8_t mi) {
  CheckInput in;
  in.now = 100000;
  in.clockValid = true;
  in.hour = h;
  in.minute = mi;
  in.day = 700;
  in.quietOn = true;
  in.careLevel = 2;
  in.ready = true;
  in.present = true;
  in.presentMs = 8000;
  return in;
}

static void testCheckIn() {
  MoodLog log;
  CheckIn c;
  CHECK(!c.due(evening(19, 29), log) && c.due(evening(19, 30), log) && c.due(evening(21, 59), log));
  CHECK(!c.due(evening(22, 0), log));
  CheckInput late = evening(22, 10);
  late.quietOn = false;
  CHECK(c.due(late, log));  // 夜间安静关掉：到 22:29
  CheckInput in = evening(20, 0);
  in.clockValid = false;
  CHECK(!c.due(in, log));
  in = evening(20, 0);
  in.careLevel = 0;
  CHECK(!c.due(in, log));
  in = evening(20, 0);
  in.ready = false;
  CHECK(!c.due(in, log));
  in = evening(20, 0);
  in.presentMs = 3000;
  CHECK(!c.due(in, log));
  // 问了没回答：20 分钟后再问一次（「开」）；「少一点」只问一次
  in = evening(20, 0);
  CHECK(c.due(in, log));
  log.asked(in.day);
  c.asked(in.now);
  in.now += 10u * 60000u;
  CHECK(!c.due(in, log));
  in.now += 11u * 60000u;
  CHECK(c.due(in, log));
  CheckInput less = in;
  less.careLevel = 1;
  CHECK(!c.due(less, log));
  log.asked(in.day);
  c.asked(in.now);
  in.now += 30u * 60000u;
  CHECK(!c.due(in, log));  // 一天最多两次
  // 今天打过卡：不问；第二天：问
  MoodLog l2;
  CheckIn c2;
  l2.add(700, 4);
  CHECK(!c2.due(evening(20, 0), l2));
  CheckInput tomorrow = evening(20, 0);
  tomorrow.day = 701;
  CHECK(c2.due(tomorrow, l2));
}

static void testSounds() {
  for (uint8_t id = sfx::S_BOP; id <= sfx::S_PLEASE; id++) {
    const char* nm = sfx::soundName(id);
    CHECK(nm && *nm && sfx::findSound(nm) == id);
    sfx::Synth s;
    s.play(id, true, 7);
    static int16_t buf[480];
    int n = 0, peak = 0;
    double energy = 0;
    while (s.busy() && n < sfx::kRate * 5) {
      s.render(buf, 480);
      for (int i = 0; i < 480; i++) {
        const int v = buf[i] < 0 ? -buf[i] : buf[i];
        if (v > peak) peak = v;
        energy += (double)buf[i] * buf[i];
      }
      n += 480;
    }
    const float sec = (float)n / sfx::kRate;
    printf("  sound %-7s %.2f s peak %d rms %.0f\n", nm, sec, peak, sqrt(energy / (n ? n : 1)));
    CHECK(!s.busy());
    CHECK(sec > .05f && sec < 4.5f);
    CHECK(peak > 1500 && peak < 32767);
  }
}

int main() {
  testLevels();
  testBids();
  testPeekaboo();
  testJudge();
  testRhythmGame();
  testTapSeq();
  testMood();
  testCheckIn();
  testSounds();
  printf("play: all ok\n");
  return 0;
}
