// 陪伴系统（心情 / 亲密度 / 时间）宿主测试
#include "companion.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

using namespace companion;

static void testLevels() {
  assert(levelFor(0) == 0);
  assert(levelFor(20 * kUnit - 1) == 0 && levelFor(20 * kUnit) == 1);
  assert(levelFor(1700 * kUnit) == 9 && levelFor(0xFFFFFFFFu) == 9);
  for (int l = 1; l < kLevels; l++) assert(levelPoints(l) > levelPoints(l - 1));
  assert(!strcmp(levelName(0), "初次见面") && !strcmp(levelName(9), "一生挚友") && !strcmp(levelName(200), "一生挚友"));
}

static void testDiminishing() {
  Bond b;
  // 第 1 天：狂戳 1000 下，不会暴涨
  bool up = false;
  for (int i = 0; i < 1000; i++) up |= b.add(B_TOUCH, 100);
  // 前 40 次全额 40 点，第 41–80 次一半 20 点，之后四分之一：40 + 20 + (1000 - 80) / 4 = 290
  assert(b.points() == 290);
  assert(up && b.level() == 4);  // 230 ≤ 290 < 380
  assert(b.data().touches == 1000);
  // 换一天重新全额
  const uint32_t before = b.points();
  b.add(B_CHAT, 101);
  assert(b.points() == before + 2);
  // 每日奖励不递减
  for (int i = 0; i < 50; i++) b.add(B_TOUCH, 101);
  const uint32_t p = b.data().points16;
  b.add(B_DAILY, 101);
  assert(b.data().points16 == p + 80);
  // 等级不会下降、不会溢出
  Bond c;
  for (int d = 0; d < 400; d++)
    for (int i = 0; i < 200; i++) c.add(B_CHAT, 1000 + d);
  assert(c.level() == 9 && c.progress() == 1.f);
}

static void testVisitStreakMilestone() {
  Bond b;
  assert(b.visit(0) == 0);
  uint8_t f = b.visit(20000);
  assert((f & DF_FIRST_MEET) && (f & DF_NEW_DAY) && !(f & DF_STREAK));
  assert(b.data().streak == 1 && b.data().daysTogether == 1 && b.daysKnown(20000) == 1);
  assert(b.visit(20000) == 0);  // 同一天
  f = b.visit(20001);
  assert((f & DF_NEW_DAY) && (f & DF_STREAK) && b.data().streak == 2);
  f = b.visit(20003);  // 断了一天
  assert((f & DF_NEW_DAY) && !(f & DF_STREAK) && b.data().streak == 1 && b.data().bestStreak == 2);
  f = b.visit(20006);  // 认识第 7 天
  assert((f & DF_MILESTONE) && b.lastMilestone() == 0);
  f = b.visit(20007);
  assert(!(f & DF_MILESTONE) && b.lastMilestone() == -1);
  // 很久没见：一次补齐，只报最大的那个
  f = b.visit(20000 + 399);
  assert((f & DF_MILESTONE) && b.lastMilestone() == 3 && (b.data().milestones & 0x0F) == 0x0F);
  // 时钟往回跳：不庆祝，从今天重新算
  f = b.visit(20010);
  assert(!(f & DF_NEW_DAY) && b.data().lastDay == 20010 && b.data().streak == 1);
  assert(b.urgent() && b.dirty());
  b.clean();
  assert(!b.urgent() && !b.dirty());
}

static void testPersistence() {
  Bond b;
  for (int i = 0; i < 77; i++) b.add(B_TOUCH, 5);
  b.visit(20500);
  b.tickMinute();
  BondData blob = b.save();
  Bond c;
  assert(c.load(&blob, sizeof(blob)));
  assert(!memcmp(&c.data(), &b.data(), sizeof(BondData) - sizeof(uint32_t)));
  assert(c.level() == b.level() && c.points() == b.points());
  BondData bad = blob;
  bad.points16 += 1;  // 校验不对
  Bond d;
  assert(!d.load(&bad, sizeof(bad)) && d.points() == 0);
  assert(!d.load(&blob, sizeof(blob) - 1) && !d.load(nullptr, sizeof(blob)));
  bad = blob;
  bad.version = 99;
  bad.crc = crc32(&bad, offsetof(BondData, crc));
  assert(!d.load(&bad, sizeof(bad)));
  assert(crc32("123456789", 9) == 0xCBF43926u);
}

static void testAffect() {
  Affect a;
  reset(a);
  assert(a.tone == T_CALM || a.tone == T_CONTENT);
  AffectContext ctx;
  // 被摇晃：委屈 + 兴奋，立刻变基调
  stimulus(a, ST_SHAKE, 1.5f);
  assert(a.valence < 0.f && a.arousal > .7f);
  assert(a.tone == T_GRUMPY);
  // 慢慢平复（几分钟后不再委屈）
  for (int i = 0; i < 600; i++) update(a, 1.f, ctx);
  assert(a.valence > -.05f && a.tone != T_GRUMPY);
  // 被摸、聊天：开心
  for (int i = 0; i < 6; i++) { stimulus(a, ST_TOUCH); update(a, 2.f, ctx); }
  stimulus(a, ST_CHAT);
  update(a, 7.f, ctx);
  assert(a.valence > .5f && (a.tone == T_JOYFUL || a.tone == T_EXCITED || a.tone == T_PLAYFUL));
  // 迟滞：基调至少保持几秒
  Affect b;
  reset(b);
  b.valence = .6f; b.arousal = .5f; b.tone = T_JOYFUL; b.toneAge = 0.f;
  b.valence = .2f;  // 变成 CALM 的条件
  update(b, .5f, ctx);
  assert(b.tone == T_JOYFUL);
  for (int i = 0; i < 20; i++) update(b, .5f, ctx);
  assert(b.tone != T_JOYFUL);
  // 不睡觉精神会掉，夜里掉得更快；睡觉恢复
  Affect day, night;
  reset(day); reset(night);
  AffectContext n; n.night = true;
  for (int i = 0; i < 60; i++) { update(day, 60.f, ctx); update(night, 60.f, n); }
  assert(night.energy < day.energy && day.energy < .85f);
  assert(night.tone == T_SLEEPY);
  AffectContext s; s.sleeping = true;
  for (int i = 0; i < 30; i++) update(night, 60.f, s);
  assert(night.energy > .9f);
  // 一个人久了会想人；有人陪就好了
  Affect l;
  reset(l);
  for (int i = 0; i < 15; i++) update(l, 60.f, ctx);
  assert(l.social > .9f && l.tone == T_LONELY);
  AffectContext comp; comp.company = true;
  for (int i = 0; i < 4; i++) update(l, 60.f, comp);
  assert(l.social < .1f && l.tone != T_LONELY);
  // 亲密度高：同样的委屈更轻
  Affect cold, warm;
  reset(cold); reset(warm);
  AffectContext w; w.warmth = 1.f;
  update(warm, .01f, w);
  update(cold, .01f, ctx);
  stimulus(cold, ST_SHAKE); stimulus(warm, ST_SHAKE);
  assert(warm.valence > cold.valence);
  // 非法输入
  Affect z;
  reset(z);
  const Affect z0 = z;
  update(z, NAN, ctx); update(z, -1.f, ctx); stimulus(z, ST_COUNT); stimulus(z, ST_TOUCH, NAN);
  assert(!memcmp(&z, &z0, sizeof(z)));
  update(z, 1e9f, ctx);  // 很久：按 600 秒算，不会出 NaN
  assert(isfinite(z.valence) && isfinite(z.energy) && z.energy >= .03f);
  for (int t = 0; t < T_COUNT; t++) assert(toneName(t)[0] && toneKey(t)[0]);
}

static void testClock() {
  // 2025-06-01 00:30:00 UTC = 北京时间 08:30，星期日
  const int64_t t = 1748737800;
  Clock c = clockFromEpoch(t, 8 * 3600);
  assert(c.valid && c.hour == 8 && c.minute == 30 && c.wday == 0);
  assert(c.day == (uint32_t)((t + 8 * 3600) / 86400));
  Clock u = clockFromEpoch(t, 0);
  assert(u.hour == 0 && u.day + 0 <= c.day);
  assert(!clockFromEpoch(1600000000, 8 * 3600).valid);  // 2020 年：当作没对时
  assert(!clockFromEpoch(t, 20 * 3600).valid);
  // 跨午夜：北京时间 23:59 → 00:00 日期加一
  Clock a = clockFromEpoch(1748793540, 8 * 3600), b = clockFromEpoch(1748793600, 8 * 3600);
  assert(a.hour == 23 && a.minute == 59 && b.hour == 0 && b.minute == 0 && b.day == a.day + 1);
  assert(quietHours(22) && quietHours(3) && quietHours(6) && !quietHours(7) && !quietHours(21));
  assert(quietHours(13, 12, 14) && !quietHours(14, 12, 14) && !quietHours(5, 5, 5));
  assert(period(6) == PD_MORNING && period(12) == PD_DAY && period(19) == PD_EVENING && period(23) == PD_NIGHT && period(2) == PD_NIGHT);
}

static void testPick() {
  const float w[4] = {0.f, 1.f, 0.f, 3.f};
  assert(pickWeighted(w, 4, 0.f) == 1);
  assert(pickWeighted(w, 4, .24f) == 1);
  assert(pickWeighted(w, 4, .26f) == 3);
  assert(pickWeighted(w, 4, 1.f) == 3);
  const float z[3] = {0.f, -1.f, 0.f};
  assert(pickWeighted(z, 3, .5f) == -1 && pickWeighted(nullptr, 3, .5f) == -1);
  int hist[4] = {0};
  for (int i = 0; i < 4000; i++) hist[pickWeighted(w, 4, (i + .5f) / 4000.f)]++;
  assert(hist[0] == 0 && hist[2] == 0 && hist[1] == 1000 && hist[3] == 3000);
}

int main() {
  testLevels();
  testDiminishing();
  testVisitStreakMilestone();
  testPersistence();
  testAffect();
  testClock();
  testPick();
  printf("test_companion: all passed\n");
  return 0;
}
