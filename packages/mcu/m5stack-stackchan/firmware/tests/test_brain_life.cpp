// HOST_FLAGS: -I tests/host_stubs
// 2.7「情绪价值版」/ 2.8「陪伴版」：brain.cpp 生活模式多日仿真（电脑上跑，不需要硬件）
// 2.8：会关心人（起来活动 / 喝水 / 吃饭 / 早点睡 / 夸你）+ 任务提醒（Ekko Studio → notify）
// 2.9：一起玩（小反应 / 主动邀请 / 躲猫猫 / 节奏游戏 / 连拍 / 听歌跳舞 / 深呼吸 / 心情打卡）。
//      2.8 的场景用「安静」跑（和 2.8 一样）；2.9 的场景单独测，另外把一周日常用「活泼」再跑一遍
// 真实模块：brain / companion / motion / conversation / touch_interaction / touch_dispatch
// 替身：表情引擎（只记录调用并检查参数范围）、音效（记录播放了什么、什么时候）、Arduino 时钟 / 随机数 / 串口
#include "../PulseStackChan/brain.cpp"
#include "touch_dispatch.h"
#include "touch_interaction.h"
#include <algorithm>
#include <sys/wait.h>
#include <unistd.h>
#include <map>
#include <string>
#include <vector>

// ============================== 替身 ==============================
static uint32_t g_ms = 0;
static uint64_t g_rng = 0x9E3779B97F4A7C15ull;
uint32_t millis() { return g_ms; }
uint32_t micros() { return g_ms * 1000u; }
long random(long hb) {
  if (hb <= 0) return 0;
  g_rng = g_rng * 6364136223846793005ull + 1442695040888963407ull;
  return (long)((g_rng >> 33) % (uint64_t)hb);
}
long random(long lo, long hi) { return hi <= lo ? lo : lo + random(hi - lo); }

HostSerial Serial;
static std::vector<std::pair<uint32_t, std::string>> g_log;  // 只留 [bond] / [life] / [care] / [notify] / [play] / [mood] / [music] 行
static uint32_t g_lines = 0;
static bool g_verbose = false;
namespace simu { std::string stamp(); }
static void logLine(const char* s) {
  g_lines++;
  if (g_verbose) printf("%s  %s", simu::stamp().c_str(), s);
  if (!strncmp(s, "[bond]", 6) || !strncmp(s, "[life]", 6) || !strncmp(s, "[care]", 6) || !strncmp(s, "[notify]", 8) ||
      !strncmp(s, "[play]", 6) || !strncmp(s, "[mood]", 6) || !strncmp(s, "[music]", 7))
    g_log.push_back({g_ms, s});
}
int HostSerial::printf(const char* fmt, ...) {
  char buf[512];
  va_list ap;
  va_start(ap, fmt);
  const int n = vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);
  logLine(buf);
  return n;
}
size_t HostSerial::println(const char* s) {
  std::string l = std::string(s) + "\n";
  logLine(l.c_str());
  return l.size();
}
size_t HostSerial::print(const char* s) {
  logLine(s);
  return strlen(s);
}

struct Snd { uint32_t ms; uint8_t kind, id; float gain; bool night; };  // kind 0 素材 1 合成 2 状态默认声
static std::vector<Snd> g_snd;
static bool g_worldNight = false;
namespace sfx {
void play(uint8_t clip, float gain, float rate, bool) {
  if (!(clip > 0 && clip < C_COUNT && isfinite(gain) && gain >= 0.f && gain <= 2.f && isfinite(rate) && rate > .2f && rate < 3.f)) {
    fprintf(stderr, "bad sfx::play %u %f %f\n", clip, gain, rate);
    abort();
  }
  g_snd.push_back({g_ms, 0, clip, gain, g_worldNight});
}
void synth(uint8_t s, bool) {
  if (!(s > 0 && s < S_COUNT)) { fprintf(stderr, "bad sfx::synth %u\n", s); abort(); }
  g_snd.push_back({g_ms, 1, s, 1.f, g_worldNight});
}
void onState(const char* id, bool withSound) {
  if (!id || strlen(id) != 2) abort();
  if (withSound) g_snd.push_back({g_ms, 2, (uint8_t)atoi(id), 1.f, g_worldNight});
}
void onTap() { g_snd.push_back({g_ms, 0, 0, 1.f, g_worldNight}); }
void stop() {}
void stopAmbient() {}
}  // namespace sfx

namespace pulse {
#include "pulse_states.h"
int stateCount() { return kStateCount; }
const StateDef& stateDef(int i) { return kStates[(i % kStateCount + kStateCount) % kStateCount]; }
int findState(const char* s) {
  for (int i = 0; i < kStateCount; i++)
    if (!strcmp(kStates[i].id, s) || !strcmp(kStates[i].name, s)) return i;
  return -1;
}
static uint32_t g_emits[FX_KINDS], g_blinks = 0, g_moods = 0, g_states = 0;
void Engine::setState(int idx, bool) {
  if (idx < 0 || idx >= kStateCount) abort();
  _state = idx;
  g_states++;
}
void Engine::pulse() {}
void Engine::emit(uint8_t fx, int n) {
  if (fx >= FX_KINDS || n < 1 || n > 8) { fprintf(stderr, "bad emit %u %d\n", fx, n); abort(); }
  g_emits[fx] += (uint32_t)n;
}
void Engine::setMood(float v, float a, float e, float w) {
  if (!(isfinite(v) && isfinite(a) && isfinite(e) && isfinite(w) && v >= -1.f && v <= 1.f && a >= 0.f && a <= 1.f && e >= 0.f &&
        e <= 1.f && w >= 0.f && w <= 1.f)) {
    fprintf(stderr, "bad setMood %f %f %f %f\n", v, a, e, w);
    abort();
  }
  g_moods++;
}
void Engine::blink(float d) {
  if (!(isfinite(d) && d > .05f && d < 2.5f)) { fprintf(stderr, "bad blink %f\n", d); abort(); }
  g_blinks++;
}
static std::string g_label;  // 最近一次真的显示出来的标题（标题默认关着，2.8 只在演任务提醒时短暂打开）
static uint32_t g_labels = 0, g_labelOffs = 0;
void Engine::setLabel(const char* t, uint32_t ms) {
  if (!t || ms > 20000) abort();
  if (strlen(t) >= 64) abort();
  if (!_labelsEnabled) return;
  g_label = t;
  g_labels++;
}
void Engine::setLabelsEnabled(bool e) {
  if (_labelsEnabled && !e) g_labelOffs++;
  _labelsEnabled = e;
  if (!e) g_label.clear();
}
void Engine::fire(uint8_t imp, float) { if (imp > I_INRING) abort(); }
}  // namespace pulse

// ============================== 仿真 ==============================
namespace simu {
using brain::Step;
int64_t epoch0 = 0;
uint32_t ms0 = 0;
int32_t tz = 28800;
bool clockValid = true, nightAuto = true, alsOk = true, battOk = true, charging = false, soundOn = true;
float lux = 300.f, batt = 80.f;
bool dark = false, face = false, headDown = false, screenDown = false;
uint32_t lastWorld = 0;
// 2.9：活跃度（2.8 的场景默认「安静」= 和 2.8 一样）/ 有没有麦克风 / 正在放的歌（0 = 没放）
uint8_t level = play::LV_QUIET;
bool musicAvail = false;
float musicBpm = 0.f;
uint32_t musicT0 = 0;           // 歌的第一拍
uint32_t listenSince = 0, lastBeatFeed = 0, beatFeeds = 0, listenMs = 0;
bool listening = false;
uint8_t lastMode = 0;
uint32_t modeSince = 0;
pulse::Engine* eng = nullptr;
motion::Planner plan;
touchinteraction::Controller touch;
uint32_t poutCalls = 0, boundaryVisuals = 0, phraseQueued = 0;

std::map<const Step*, std::string> names;
std::vector<std::pair<uint32_t, std::string>> scripts;  // 每段脚本开始的时间和名字
const Step* lastScr = nullptr;
uint32_t lastSt0 = 0, scrSince = 0;

static void fxHook(touchinteraction::Visual) {}
static bool idleHook(uint8_t semanticId, bool, uint32_t durationMs, uint32_t now) {
  return brain::localTouchVisual(semanticId == 21, now, durationMs);
}
touchdispatch::Dispatcher disp(touchdispatch::Hooks(fxHook, idleHook), sfx::C_TOUCH_DIRTY_HANDS, .48f);

int64_t epochNow() { return epoch0 + (int64_t)((uint32_t)(g_ms - ms0) / 1000u); }
companion::Clock clockNow() { return companion::clockFromEpoch(epochNow(), tz); }
std::string stamp() {
  char b[64];
  const companion::Clock c = clockNow();
  snprintf(b, sizeof(b), "day%u %02u:%02u:%02u", (unsigned)(c.day % 1000), c.hour, c.minute,
           (unsigned)(((uint64_t)(epochNow() + tz)) % 60));
  return b;
}
std::map<const Step*, std::string>& scriptNames();
std::string current() {
  if (!brain::s_scr) return "-";
  auto it = scriptNames().find(brain::s_scr);
  return it == scriptNames().end() ? "?" : it->second;
}
#define CHECK(c)                                                                                                  \
  do {                                                                                                            \
    if (!(c)) {                                                                                                   \
      fflush(stdout);                                                                                             \
      fprintf(stderr, "CHECK failed %s:%d: %s  (%s, script %s, phase %d)\n", __FILE__, __LINE__, #c, simu::stamp().c_str(), \
              simu::current().c_str(), (int)brain::s_phase);                                                     \
      abort();                                                                                                    \
    }                                                                                                             \
  } while (0)

int64_t civil(int y, int mo, int d, int h, int mi) {  // 本地时间 → UTC 秒
  y -= mo <= 2;
  const int era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = (unsigned)(y - era * 400);
  const unsigned doy = (153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  const int64_t days = (int64_t)era * 146097 + (int64_t)doe - 719468;
  return days * 86400 + h * 3600 + mi * 60 - tz;
}

void pushWorld() {
  companion::World w;
  if (clockValid) w.clock = clockNow();
  w.alsOk = alsOk;
  w.lux = alsOk ? lux : -1.f;
  w.dark = alsOk && dark;
  w.battOk = battOk;
  w.battery = battOk ? (int8_t)(batt + .5f) : -1;
  w.charging = battOk && charging;
  w.night = nightAuto && w.clock.valid && companion::quietHours(w.clock.hour, 22, 7);
  w.quietOn = nightAuto;
  w.soundOn = soundOn;
  g_worldNight = w.night;
  brain::setWorld(w);
}

bool localMode() { return true; }  // 2.8：只有生活模式（对话中也走本地触摸路径）

void invariants() {
  const auto& a = brain::affect();
  CHECK(isfinite(a.valence) && a.valence >= -1.f && a.valence <= 1.f);
  CHECK(isfinite(a.arousal) && a.arousal >= 0.f && a.arousal <= 1.f);
  CHECK(isfinite(a.energy) && a.energy >= 0.f && a.energy <= 1.f);
  CHECK(isfinite(a.social) && a.social >= 0.f && a.social <= 1.f);
  CHECK(a.tone < companion::T_COUNT);
  CHECK(brain::s_phase <= brain::PH_SLEEP);
  const uint8_t le = brain::ledEffect(g_ms);
  CHECK(le <= brain::LE_BREATH);
  const float ll = brain::ledLevel(g_ms);
  CHECK(isfinite(ll) && ll >= 0.f && ll <= 1.f);
  if (le != brain::LE_BEAT && le != brain::LE_BREATH) CHECK(ll == 1.f || brain::s_mode != brain::PM_NONE);
  // 2.9：一起玩不会卡住（深呼吸最长 3 分钟、跳舞最长 3 分钟、节奏游戏 5 关）
  if (brain::s_mode != lastMode) {
    lastMode = brain::s_mode;
    modeSince = g_ms;
  }
  if (brain::s_mode != brain::PM_NONE && g_ms - modeSince > 240000) {
    fprintf(stderr, "play mode stuck: %s\n", brain::playKey());
    CHECK(false);
  }
  CHECK(!(brain::touchCaptured() && brain::s_conversationOwned));
  if (brain::s_scr) {
    if (brain::s_scr != lastScr || brain::s_st0 != lastSt0) {
      lastScr = brain::s_scr;
      lastSt0 = brain::s_st0;
      scrSince = g_ms;
      auto it = names.find(brain::s_scr);
      scripts.push_back({g_ms, it == names.end() ? std::string("?") : it->second});
    }
    const uint32_t lim = 20000;
    if (g_ms - scrSince > lim) {
      fprintf(stderr, "script stuck: %s\n", scripts.empty() ? "?" : scripts.back().second.c_str());
      CHECK(false);
    }
  } else {
    lastScr = nullptr;
  }
  if (!brain::s_conversationOwned && !brain::s_scr && brain::s_settleAt)
    CHECK((int32_t)(g_ms - brain::s_settleAt) < 3000);  // 「过一会儿回正」不能卡住
  if (brain::s_avertUntil) CHECK((int32_t)(brain::s_avertUntil - g_ms) < 5000);
  if (brain::s_rainbowUntil) CHECK((int32_t)(brain::s_rainbowUntil - g_ms) < 10000);
}

// 2.9：和 app 的 updateMusic 一样：brain 想听的时候打开「麦克风」，每 0.25 秒给一次节拍分析结果
// （这里不真的分析声音：放着歌 = 听 3 秒以后认出节拍；没放 = 只有很小的底噪）
void feedBeat(uint32_t now) {
  const bool want = musicAvail && brain::musicListenWanted() && !conversation::active();
  if (want && !listening) {
    listening = true;
    listenSince = now;
    lastBeatFeed = now;
  }
  if (!want) {
    if (listening) listenMs += now - listenSince;
    listening = false;
    return;
  }
  if (now - listenSince < 2500 || now - lastBeatFeed < 250) return;
  lastBeatFeed = now;
  beatFeeds++;
  beat::Estimate e;
  e.frames = (uint16_t)std::min<uint32_t>(512, (now - listenSince) / 10);
  e.analyses = (uint16_t)std::min<uint32_t>(60000, beatFeeds);
  if (musicBpm > 0.f) {
    e.periodMs = (uint32_t)(60000.f / musicBpm + .5f);
    e.bpm = 60000.f / (float)e.periodMs;
    e.level = 2400.f;
    e.confidence = .8f;
    e.stable = (uint8_t)std::min<uint32_t>(9, (now - listenSince - 2500) / 250 + 1);
    e.music = now - listenSince >= 3000;
    const uint32_t k = (now - musicT0) / e.periodMs;
    e.beatMs = musicT0 + k * e.periodMs;
  } else {
    e.level = 25.f;
  }
  brain::setBeat(e, now);
}

void frame(uint32_t step) {
  g_ms += step;
  const uint32_t now = g_ms;
  if (now - lastWorld >= 1000) {
    lastWorld = now;
    pushWorld();
  }
  // 和 app.cpp updateTouchInteraction 一样
  touch.contact(touchinteraction::Source::Head, headDown, now);
  touch.contact(touchinteraction::Source::Screen, screenDown, now);
  brain::touchContact(localMode() && !conversation::active() && (headDown || screenDown), now);
  brain::headContact(localMode() && !conversation::active() && headDown, now);  // 2.9
  touchinteraction::Context ctx;
  ctx.enabled = brain::faceTrackingAllowed() && !brain::touchCaptured();  // 2.9：玩游戏 / 打卡 / 深呼吸时触摸归它们
  ctx.generation = conversation::generation();
  ctx.epoch = 1;
  const auto decision = touch.update(now, ctx);
  touchdispatch::Context dctx;
  dctx.interaction = ctx;
  dctx.idleVisualAllowed = !conversation::active() && ctx.enabled;
  const auto result = disp.dispatch(decision, dctx, now);
  if (decision.visual == touchinteraction::Visual::PlayfulBoundary) boundaryVisuals++;
  if (result.phraseQueued) phraseQueued++;
  if (decision.visual == touchinteraction::Visual::PlayfulBoundary && result.route == touchdispatch::VisualRoute::Idle && !result.phraseQueued) {
    poutCalls++;
    brain::touchPout(now);
  }
  brain::setFacePresence(face, face ? .05f * sinf(now * .001f) : 0.f, 0.f);
  conversation::update(now);
  feedBeat(now);
  brain::update(step * .001f, now);
  plan.update(step * .001f);
  invariants();
}

void run(uint32_t ms, uint32_t step = 50) {
  for (uint32_t t = 0; t < ms; t += step) frame(step);
}

void gesture(touchinteraction::Source src, touchinteraction::Gesture g) {
  if (!localMode()) return;
  touch.gesture(src, g, g_ms);
  if (!conversation::active())
    brain::noteTouch(g == touchinteraction::Gesture::Tap ? 0 : (g == touchinteraction::Gesture::Stroke ? 1 : 2), g_ms,
                     src == touchinteraction::Source::Head);
}

// 摸头：手放上去，每 gap 毫秒滑一下，一共 n 下，然后松手
void strokeSession(int n, uint32_t gap = 450, bool head = true) {
  bool& d = head ? headDown : screenDown;
  d = true;
  run(200);
  for (int i = 0; i < n; i++) {
    gesture(head ? touchinteraction::Source::Head : touchinteraction::Source::Screen, touchinteraction::Gesture::Stroke);
    run(gap);
  }
  d = false;
  run(2500);
}
void holdSession(uint32_t ms) {
  screenDown = true;
  run(800);
  gesture(touchinteraction::Source::Screen, touchinteraction::Gesture::Hold);
  run(ms > 800 ? ms - 800 : 0);
  screenDown = false;
  run(2500);
}
void taps(int n, uint32_t gap = 300) {
  for (int i = 0; i < n; i++) {
    screenDown = true;
    run(100);
    screenDown = false;
    gesture(touchinteraction::Source::Screen, touchinteraction::Gesture::Tap);
    run(gap);
  }
  run(2500);
}

void boot(int y, int mo, int d, int h, int mi, uint32_t startMs = 1000) {
  g_ms = startMs;
  ms0 = startMs;
  epoch0 = civil(y, mo, d, h, mi);
  lastWorld = g_ms - 1000;
  static pulse::Engine engine;
  eng = &engine;
  brain::begin(eng, &plan);
  conversation::begin(brain::conversationHooks(), g_ms);
  touch.reset(g_ms);
  disp.reset(g_ms);
  eng->setLabelsEnabled(false);  // 和 app 一样：平时脸上不显示文字
  pushWorld();
  brain::setCareLevel(care::L_ON);
  brain::setNotifyEnabled(true);
  brain::setLively(level);  // 2.9
  brain::setMusicEnabled(true);
  brain::setMusicAvailable(musicAvail);
  brain::boot();
  run(6000);
}

// 跑到本地时间 hh:mm（今天或之后）
void until(int hh, int mm, uint32_t step = 100) {
  for (;;) {
    const companion::Clock c = clockNow();
    if (c.hour == hh && c.minute == mm) return;
    frame(step);
  }
}

int countLog(const char* needle, uint32_t from = 0, uint32_t to = 0xFFFFFFFFu) {
  int n = 0;
  for (auto& l : g_log)
    if (l.first >= from && l.first <= to && l.second.find(needle) != std::string::npos) n++;
  return n;
}
int countScript(const char* name, uint32_t from = 0, uint32_t to = 0xFFFFFFFFu) {
  int n = 0;
  for (auto& s : scripts)
    if (s.first >= from && s.first <= to && s.second == name) n++;
  return n;
}
int countSynth(uint8_t id, uint32_t from = 0, uint32_t to = 0xFFFFFFFFu) {
  int n = 0;
  for (auto& s : g_snd)
    if (s.kind == 1 && s.id == id && s.ms >= from && s.ms <= to) n++;
  return n;
}
int countSounds(uint32_t from, uint32_t to) {
  int n = 0;
  for (auto& s : g_snd)
    if (s.ms >= from && s.ms <= to) n++;
  return n;
}

std::map<const Step*, std::string>& scriptNames() { return names; }
void nameScripts() {
#define N(x) names[brain::x] = #x
  N(kBoot); N(kWake); N(kWakeNear); N(kWakeJolt); N(kAngry); N(kDizzy); N(kGreet);
  N(kTouchHappy); N(kTouchShy); N(kTouchLove); N(kTouchComfort); N(kTouchSleepy); N(kWakePet); N(kPerkUp); N(kBoundary);
  N(kGreetMorning); N(kGreetDay); N(kGreetEvening); N(kGreetNight); N(kWelcomeShy); N(kWelcome); N(kWelcomeMiss); N(kWelcomeNight);
  N(kLevelUp); N(kMilestone); N(kLightsOff); N(kLightsOffNight); N(kLightsOn); N(kWakeMorning); N(kCharge); N(kLowBatt); N(kFull);
  N(kInvite); N(kSpLook); N(kSpHum); N(kSpThink); N(kSpGiggle); N(kSpStretch); N(kSpDaze); N(kSpHappy); N(kSpYawn); N(kSpDoze);
  N(kSpMiss); N(kSpPeek); N(kSpSneeze); N(kSpStar); N(kSpHumSoft);
  // 2.8
  N(kCareStretch); N(kCareWater); N(kCareMeal); N(kCareBedtime); N(kCareNudge); N(kAckStretch); N(kAckWater); N(kAckMeal);
  N(kAckBedtime); N(kPraiseStretch); N(kPraiseMeal); N(kPraiseDay); N(kGreetEarly); N(kGoodSleep); N(kNoticeCue); N(kNoticeCueSoft);
  N(kTaskDone); N(kTaskFailed); N(kNoticeRemind); N(kNoticePraise); N(kNoticeNudge); N(kNoticeAckDone); N(kNoticeAckFailed);
  // 2.9
  N(kMicroTilt); N(kMicroSmile); N(kMicroWiggle); N(kMicroNod); N(kMicroSpark); N(kMicroNote); N(kMicroLove); N(kMicroPeek);
  N(kBidPet); N(kBidHeart); N(kBidNuzzle); N(kBidPlay); N(kBidShow); N(kBidPetYes); N(kBidHeartYes); N(kBidNuzzleYes); N(kBidShowYes);
  N(kPeekSearch); N(kPeekFound); N(kPeekFoundMore); N(kPeekGiveUp);
  N(kGameIntro); N(kGamePerfect); N(kGameGood); N(kGameMiss); N(kGameTimeout); N(kGameWin); N(kGameEnd); N(kGameEndSoft);
  N(kDanceSolo); N(kDanceEnd); N(kDanceTired); N(kBreathIntro); N(kBreathDone);
  N(kMoodAsk); N(kMood5); N(kMood4); N(kMood3); N(kMood2); N(kMood1); N(kMoodWeek); N(kMoodCare);
#undef N
}

}  // namespace simu
using namespace simu;

// ============================== 场景 ==============================
int countPrefix(const char* p, uint32_t from, uint32_t to);
// ① 一周的日常：早上开灯、看见你、摸摸、中午戳戳、晚上聊天和抱抱、充电、关灯睡觉；第 4 天没人理
static void scenarioWeek() {
  boot(2025, 5, 19, 6, 0);
  batt = 100.f;
  const uint32_t t0 = g_ms;
  struct Day { uint32_t start, nightFrom, nightTo, sleepBy; };
  std::vector<Day> days;
  for (int d = 0; d < 8; d++) {
    const bool skip = d == 3;
    Day rec{};
    rec.start = g_ms;
    // 06:00 → 07:00：还在睡（第一天开机后是醒的，会自己犯困睡着）
    until(7, 0);
    dark = false;
    lux = 300.f;
    brain::onSensors(sensors::SE_LIGHT);
    run(5000);
    if (d > 0) CHECK(brain::s_phase == brain::PH_AWAKE);  // 天亮开灯：醒了
    if (!skip) {
      until(7, 30);
      face = true;
      run(180000);
      face = false;
      run(30000);
      strokeSession(3);  // 摸 3 下：舒服，不到「放开我」
      until(12, 0);
      face = true;
      run(120000);
      face = false;
      run(5000);
      taps(7);           // 连着戳：越来越有意见
      run(10000);
      strokeSession(6);  // 摸太多：放开你的脏手！（配语音）
      run(3000);
      strokeSession(5);  // 30 秒内又来：没有语音，自己「哼」
    }
    // 白天放着不管，电量慢慢掉；20 点前后低电量提醒
    for (;;) {
      const companion::Clock c = clockNow();
      if (c.hour == 19 && c.minute == 0) break;
      frame(100);
      if (!charging && (g_ms % 60000) < 100) batt = batt > 1.f ? batt - .1f : batt;
    }
    if (d == 1) {
      batt = 14.f;  // 第二天晚上：快没电了
      run(20000);
    }
    if (!skip) {
      face = true;
      run(300000);
      conversation::startTurn("turn", (uint32_t)(d + 1) * 10, g_ms);
      run(5000);
      brain::noteChat();
      run(20000);
      brain::noteChat();
      run(20000);
      brain::noteChat();
      run(10000);
      conversation::cancel(g_ms);
      run(5000);
      holdSession(4000);
      run(600000);
      face = false;
    }
    until(20, 55);
    if (!skip) face = true;  // 晚上又过来陪它
    bool faceOn = face;
    until(21, 0);
    charging = true;  // 插上电
    for (;;) {
      const companion::Clock c = clockNow();
      if (c.hour == 23 && c.minute == 0) break;
      frame(100);
      if ((g_ms % 60000) < 100 && batt < 100.f) batt = batt + 1.5f > 100.f ? 100.f : batt + 1.5f;
      if (faceOn && c.hour == 22 && c.minute == 5) face = faceOn = false;
      if (!skip && c.hour == 22 && c.minute == 50 && !face) face = true;
      if (face && c.hour == 22 && c.minute == 59) face = false;
    }
    dark = true;  // 关灯睡觉
    lux = .5f;
    brain::onSensors(sensors::SE_DARK);
    run(120000);
    rec.sleepBy = g_ms;
    CHECK(brain::s_phase == brain::PH_SLEEP);  // 夜里关灯：很快就睡了
    until(23, 30);
    rec.nightFrom = g_ms;
    until(2, 0);
    brain::onSensors(sensors::SE_NEAR);  // 半夜有人走过：不醒
    run(3000);
    CHECK(brain::s_phase == brain::PH_SLEEP);
    until(6, 30);
    rec.nightTo = g_ms;
    charging = false;
    batt = 100.f;
    until(6, 59);
    days.push_back(rec);
  }
  // 每天（有人陪的日子）只打一次招呼
  for (size_t d = 0; d < days.size(); d++) {
    const uint32_t from = days[d].start, to = d + 1 < days.size() ? days[d + 1].start : g_ms;
    const int greets = countLog("[bond] 打招呼", from, to);
    int dayScripts = 0;
    for (auto& sc : scripts)
      if (sc.first >= from && sc.first <= to) dayScripts++;
    printf("  day %zu: greet %d, scripts %d, sounds %d, night sounds %d\n", d, greets, dayScripts,
           countSounds(from, to), countSounds(days[d].nightFrom, days[d].nightTo));
    CHECK(greets == (d == 3 ? 0 : 1));
    CHECK(countSounds(days[d].nightFrom, days[d].nightTo) == 0);  // 23:30–06:30 安安静静
  }
  const auto& b = brain::bond();
  const auto& bd = b.data();
  printf("  bond Lv%u %u pts, streak %u (best %u), days %u, touches %u chats %u faces %u minutes %u\n", (unsigned)b.level() + 1,
         (unsigned)b.points(), (unsigned)bd.streak, (unsigned)bd.bestStreak, (unsigned)bd.daysTogether, (unsigned)bd.touches,
         (unsigned)bd.chats, (unsigned)bd.faces, (unsigned)bd.minutes);
  {
    std::map<std::string, int> cnt;
    for (auto& sc : scripts) cnt[sc.second]++;
    printf("  scripts:");
    for (auto& kv : cnt) printf(" %s=%d", kv.first.c_str(), kv.second);
    printf("\n");
  }
  CHECK(bd.daysTogether == 7);
  CHECK(bd.bestStreak == 4);      // 第 1–3 天连着，第 4 天断，第 5–8 天连着 4 天
  CHECK(bd.streak == 4);           // 第 4 天断了，第 5–8 天又连上
  CHECK(bd.chats == 21);
  const uint32_t elapsedMin = (g_ms - t0) / 60000u;
  CHECK(bd.minutes + 2 >= elapsedMin && bd.minutes <= elapsedMin + 1);  // 每分钟记一次陪伴时长
  CHECK(b.level() >= 2 && b.level() <= 6);  // 一周：慢慢变熟，但不会暴涨
  CHECK(countScript("kMilestone") == 1);    // 认识第 7 天
  CHECK(countLog("[bond] 纪念日") == 1);
  CHECK(countScript("kLevelUp") + countScript("kMilestone") >= 1);
  CHECK(countScript("kLowBatt") == 1);      // 低电量只提醒一次
  CHECK(countScript("kCharge") == 7);       // 醒着时插上电：开心一下（第 4 天没人、睡着了：不吵醒它）
  CHECK(countScript("kFull") == 7);         // 充满了
  CHECK(countScript("kGreetMorning") == 7);
  CHECK(countScript("kWakeMorning") == 8);  // 早上开灯：伸懒腰醒来
  // 2.8：22:59 关灯（世界时钟每秒更新一次）= 23 点前就睡：夸「乖」代替平常的关灯哈欠
  CHECK(countScript("kLightsOffNight") + countScript("kGoodSleep") == 7);
  CHECK(countScript("kGoodSleep") == 7);
  CHECK(countScript("kCareBedtime") == 0);  // 23 点后不在跟前：不提醒睡觉
  for (auto& sn : g_snd)
    if (g_verbose && sn.kind == 1 && sn.id == sfx::S_GOODNIGHT) {
      const int64_t e = epoch0 + (int64_t)((uint32_t)(sn.ms - ms0) / 1000u) + tz;
      printf("  goodnight at day%d %02d:%02d:%02d\n", (int)(e / 86400 % 1000), (int)((e / 3600) % 24), (int)((e / 60) % 60), (int)(e % 60));
    }
  // 2.9：「安静」= 和 2.8 一样（不做小反应、不邀请、不躲猫猫）；「活泼」：看着你时常有小反应，也会邀请你
  printf("  2.9 (%s): micro %d, bids %u (accepted %u), peek %d, mood asks %d, listened %.0f s\n", play::levelKey(level),
         countPrefix("kMicro", 0, 0xFFFFFFFFu), (unsigned)brain::bids().offered, (unsigned)brain::bids().accepted,
         countPrefix("kPeek", 0, 0xFFFFFFFFu), countScript("kMoodAsk"), listenMs / 1000.f);
  if (level == play::LV_QUIET) {
    CHECK(countPrefix("kMicro", 0, 0xFFFFFFFFu) == 0 && countPrefix("kBid", 0, 0xFFFFFFFFu) == 0 && countPrefix("kPeek", 0, 0xFFFFFFFFu) == 0);
  } else {
    CHECK(countPrefix("kMicro", 0, 0xFFFFFFFFu) > 100 && brain::bids().offered > 5);
  }
  CHECK(countScript("kMoodAsk") == 14);  // 每晚 20:55 看见你时问一次心情，没回答 20 分钟后再问一次（第 4 天没人）
  CHECK(countSynth(sfx::S_GOODNIGHT) == 7);  // 每晚睡着时唱一次晚安（第 4 天它早就睡了；第 1 天清晨 06:02 睡回笼觉：不唱）
  CHECK(countSynth(sfx::S_CHARGE) == 7);
  CHECK(countSynth(sfx::S_POUT) >= 7);       // 「哼」：戳太多 + 冷却中的摸太多
  CHECK(phraseQueued >= 7);                  // 摸太多的语音：交给导演层
  CHECK(pulse::g_moods > 1000);
  printf("  scripts total %zu, sounds %zu, emits heart %u, blinks %u, pout calls %u, boundary visuals %u\n", scripts.size(), g_snd.size(),
         pulse::g_emits[pulse::FX_HEART], pulse::g_blinks, poutCalls, boundaryVisuals);
  if (getenv("BRAIN_SIM_DUMP")) {
    for (auto& sc : scripts) {
      if (sc.first < days[1].start || sc.first > days[2].start) continue;
      const int64_t e = epoch0 + (int64_t)((uint32_t)(sc.first - ms0) / 1000u) + tz;
      printf("    %02d:%02d:%02d %s\n", (int)((e / 3600) % 24), (int)((e / 60) % 60), (int)(e % 60), sc.second.c_str());
    }
  }
}

// ② 不理它：会犯困、睡着；摸一下醒来；夜里靠近不会吵醒
static void scenarioSleepWake() {
  boot(2025, 6, 1, 14, 0);
  uint32_t tiredAt = 0, sleepAt = 0;
  const uint32_t start = g_ms;
  while (g_ms - start < 600000 && !sleepAt) {
    frame(50);
    if (!tiredAt && brain::s_phase == brain::PH_TIRED) tiredAt = g_ms - start;
    if (!sleepAt && brain::s_phase == brain::PH_SLEEP) sleepAt = g_ms - start;
  }
  printf("  tired after %.0f s, asleep after %.0f s\n", tiredAt / 1000.f, sleepAt / 1000.f);
  CHECK(tiredAt > 40000 && tiredAt < 200000);
  CHECK(sleepAt > tiredAt && sleepAt < 330000);
  run(60000);
  const uint32_t snoreFrom = g_ms;
  run(120000);
  CHECK(countSounds(snoreFrom, g_ms) <= 8);  // 呼噜打一会儿就安静
  strokeSession(1);
  CHECK(brain::s_phase == brain::PH_AWAKE);
  CHECK(countScript("kWakePet") == 1);
  // 犯困时摸一下：精神一下
  while (brain::s_phase != brain::PH_TIRED) frame(100);
  strokeSession(1);
  CHECK(brain::s_phase == brain::PH_AWAKE);
  CHECK(countScript("kPerkUp") == 1);
}

// ③ 聊天中：陪伴系统不抢戏；聊完再补打招呼
static void scenarioConversation() {
  boot(2025, 6, 2, 9, 0);
  run(5000);
  CHECK(conversation::startTurn("t1", 1, g_ms));
  CHECK(brain::s_conversationOwned);
  const size_t before = scripts.size();
  face = true;  // 聊着聊着看见了脸 + 摸了一下：今天第一次见面
  run(3000);
  brain::noteChat();
  headDown = true;
  run(500);
  gesture(touchinteraction::Source::Head, touchinteraction::Gesture::Stroke);  // 对话中：不记本地触摸
  headDown = false;
  run(20000);
  CHECK(scripts.size() == before);  // 对话中不演自己的
  CHECK(brain::bond().data().chats == 1);
  conversation::cancel(g_ms);
  CHECK(!brain::s_conversationOwned);
  run(20000);
  // 今天第一次见面就是聊天：聊天本身就是打招呼，不再另外演一段
  CHECK(countScript("kGreetMorning") == 0 && countLog("[bond] 打招呼") == 0);
  CHECK(brain::bond().data().daysTogether == 1);
  face = false;
  run(25u * 60000u);  // 走开 25 分钟再回来：久别重逢
  face = true;
  run(20000);
  CHECK(countScript("kWelcomeShy") + countScript("kWelcome") == 1);
  CHECK(countScript("kGreetMorning") == 0);
  face = false;
  run(5000);
}

// ④ 没对过时：不记日期、不打招呼，但亲密度照样慢慢涨；夜间安静靠 app 判断
static void scenarioNoClock() {
  clockValid = false;
  boot(2025, 6, 3, 10, 0);
  for (int i = 0; i < 40; i++) {
    face = true;
    run(30000);
    face = false;
    strokeSession(2);
    run(600000);
  }
  CHECK(brain::bondToday() == 0);
  CHECK(countLog("[bond] 打招呼") == 0);
  CHECK(countScript("kMoodAsk") == 0 && !brain::moodSet(3));  // 2.9：不知道今天是哪天：不打卡
  CHECK(brain::bond().data().daysTogether == 0);
  CHECK(brain::bond().points() > 10);
  printf("  no clock: Lv%u %u pts after %u min\n", (unsigned)brain::bond().level() + 1, (unsigned)brain::bond().points(),
         (unsigned)brain::bond().data().minutes);
}

// ⑤ millis() 回绕（开机 49.7 天）：一样正常
static void scenarioWrap() {
  boot(2025, 6, 4, 15, 0, 0xFFFFFFFFu - 20u * 60000u);
  for (int i = 0; i < 6; i++) {
    face = true;
    run(60000);
    face = false;
    strokeSession(3);
    taps(3);
    run(300000);
  }
  CHECK(g_ms < 0x80000000u);  // 确实回绕过
  CHECK(brain::s_phase == brain::PH_SLEEP || brain::s_phase == brain::PH_TIRED || brain::s_phase == brain::PH_AWAKE);
  CHECK(countScript("kGreetDay") == 1);
}

// ⑥ 所有预览都能演完，不会卡住（列表来自 brain::previewNames()，和串口 help 一致）
static void scenarioPreviews() {
  boot(2025, 6, 5, 20, 0);
  CHECK(brain::moodSet(3));  // 2.9：今天已经打过卡（20 点会问心情，别插进预览里）
  std::vector<std::string> list;
  {
    const std::string all = brain::previewNames();
    std::string cur;
    for (char c : all) {
      if (c == ' ') {
        if (!cur.empty()) list.push_back(cur);
        cur.clear();
      } else {
        cur += c;
      }
    }
    if (!cur.empty()) list.push_back(cur);
  }
  CHECK(list.size() >= 95);
  const uint32_t labels0 = pulse::g_labels;
  for (const std::string& nm : list) {
    const char* n = nm.c_str();
    brain::s_nextSpont = g_ms + 3600000u;  // 别让「自己玩」插进来
    const bool ok = brain::preview(n);
    if (!ok) { fprintf(stderr, "preview %s failed\n", n); CHECK(false); }
    const brain::Step* started = brain::s_scr;
    const uint32_t st0 = brain::s_st0;
    if (strcmp(n, "goodnight")) CHECK(started != nullptr);
    run(12000);
    if (strcmp(n, "goodnight")) CHECK(!(brain::s_scr == started && brain::s_st0 == st0));  // 演完了
    if (!strcmp(n, "goodnight")) {
      CHECK(brain::s_phase == brain::PH_SLEEP);
      strokeSession(1);
    }
    CHECK(!eng->labelsEnabled());  // 标题演完就关掉
  }
  CHECK(pulse::g_labels > labels0);  // 任务提醒的预览会短暂显示标题
  CHECK(!brain::preview("nope"));
  run(10000);
  CHECK(brain::ledEffect(g_ms) == brain::LE_NONE);
  printf("  previews: %zu\n", list.size());
}

uint32_t scriptAt(const char* name, int nth = 0) {
  for (auto& sc : scripts)
    if (sc.second == name && nth-- == 0) return sc.first;
  return 0;
}
void printCareLog(uint32_t from = 0) {
  if (!g_verbose) return;
  for (auto& l : g_log)
    if (l.first >= from && (!strncmp(l.second.c_str(), "[care]", 6) || !strncmp(l.second.c_str(), "[notify]", 8))) {
      const int64_t e = epoch0 + (int64_t)((uint32_t)(l.first - ms0) / 1000u) + tz;
      printf("    %02d:%02d:%02d %s", (int)((e / 3600) % 24), (int)((e / 60) % 60), (int)(e % 60), l.second.c_str());
    }
}

// ⑦ 2.8 关心提醒：坐太久 → 提醒起来活动（绿灯）；摸一下 = 知道啦；真的走开活动了，回来被夸；
//    不理它：只再轻轻提醒一次；你不在时不提醒
static void scenarioCareStretch() {
  boot(2025, 6, 6, 14, 0);  // 下午，不在饭点
  face = true;
  run(48u * 60000u);
  CHECK(countScript("kCareStretch") == 0);
  run(4u * 60000u);
  CHECK(countScript("kCareStretch") == 1);
  const uint32_t t1 = scriptAt("kCareStretch");
  CHECK(t1 - ms0 >= 49u * 60000u && t1 - ms0 <= 51u * 60000u);  // 连续坐了 50 分钟
  CHECK(countLog("[care] 提醒：起来活动") == 1);
  CHECK(countSynth(sfx::S_STRETCH) == 1);
  CHECK(pulse::g_emits[pulse::FX_PERSON] >= 2);
  // 2 分钟后提醒已经过了等回应的时间：先把时间退回到提醒刚演完的时候不现实，所以下一轮再看灯
  // 第二轮：提醒刚演完、还在等回应 → 灯是绿色
  face = false;
  run(12u * 60000u);  // 走开 12 分钟（没说知道啦，但确实起来了）
  face = true;
  run(60000);
  CHECK(countScript("kPraiseStretch") == 1);  // 回来夸你
  CHECK(countScript("kWelcome") + countScript("kWelcomeShy") == 0);
  // 再坐 50 分钟：提醒；这次摸一下说知道啦
  const uint32_t from2 = g_ms;
  uint32_t t2 = 0;
  while (!t2 && g_ms - from2 < 80u * 60000u) {
    frame(50);
    if (brain::s_scr == brain::kCareStretch || brain::s_scr == brain::kCareWater) t2 = g_ms;
  }
  CHECK(t2);
  const bool stretch2 = brain::s_scr == brain::kCareStretch;
  run(1000);
  CHECK(brain::ledEffect(g_ms) == brain::LE_CARE);
  CHECK(brain::ledColor() == (stretch2 ? 0x40E070u : 0x30A8FFu));
  run(8000);
  CHECK(brain::ledEffect(g_ms) == brain::LE_CARE);  // 演完了，还在等你回应
  CHECK(brain::carePlanner().awaiting(g_ms));
  strokeSession(1);
  CHECK(countScript(stretch2 ? "kAckStretch" : "kAckWater") == 1);
  CHECK(countLog("[care] 知道啦") == 1);
  CHECK(!brain::carePlanner().awaiting(g_ms));
  CHECK(brain::ledEffect(g_ms) == brain::LE_NONE);
  // 一直坐着、不理它：每种只再轻轻提醒一次，连着没理就不追了
  const uint32_t from3 = g_ms;
  run(150u * 60000u);
  const int reminds = countScript("kCareStretch", from3) + countScript("kCareWater", from3);
  const int nudges = countScript("kCareNudge", from3);
  printf("  sitting 150 min, ignored: reminds %d, nudges %d\n", reminds, nudges);
  CHECK(reminds >= 2 && reminds <= 6);
  CHECK(nudges >= 1 && nudges <= 2);
  // 你不在：不提醒
  face = false;
  const uint32_t from4 = g_ms;
  run(180u * 60000u);
  CHECK(countScript("kCareStretch", from4) + countScript("kCareWater", from4) + countScript("kCareNudge", from4) == 0);
  printCareLog();
}

// ⑧ 吃饭：到饭点提醒；按键 = 知道啦；真的去吃了（走开 30 分钟），回来夸你（不另外演重逢），今天不再提醒午饭；
//    出门一下午、傍晚回来：照样提醒晚饭；说话也算「知道啦」
static void scenarioCareMeal() {
  boot(2025, 6, 9, 11, 30);
  face = true;
  until(11, 45);
  for (int i = 0; i < 400 && !countScript("kCareMeal"); i++) frame(50);
  CHECK(countScript("kCareMeal") == 1);
  run(6000);
  CHECK(countSynth(sfx::S_TUMMY) == 1);
  CHECK(pulse::g_emits[pulse::FX_BOWL] >= 1);
  brain::onButton(0);
  run(3000);
  CHECK(countScript("kAckMeal") == 1);
  face = false;
  run(30u * 60000u);
  face = true;
  run(60000);
  CHECK(countScript("kPraiseMeal") == 1);
  CHECK(countScript("kWelcome") + countScript("kWelcomeShy") + countScript("kWelcomeMiss") == 0);
  until(13, 30);
  CHECK(countScript("kCareMeal") == 1);  // 吃过了：不再提醒
  face = false;
  until(17, 40);  // 出门一下午
  face = true;
  until(17, 43);
  CHECK(countScript("kCareMeal") == 1);  // 刚回来：先演重逢，3 分钟内不提醒
  until(17, 45);
  for (int i = 0; i < 400 && countScript("kCareMeal") < 2; i++) frame(50);
  CHECK(countScript("kCareMeal") == 2);
  CHECK(countScript("kCareWater") == 0);  // 走开很久：喝水重新算
  run(8000);
  conversation::startTurn("meal", 7, g_ms);
  run(3000);
  brain::noteChat();  // 「好，我去吃」
  run(5000);
  conversation::cancel(g_ms);
  CHECK(!brain::carePlanner().awaiting(g_ms));
  CHECK(countLog("[care] 知道啦") == 2);
  CHECK(countScript("kAckMeal") == 1);  // 说话时不另外演
  printCareLog();
}

// ⑨ 早点睡：23 点后还在跟前 → 提醒（夜里只有这个会小小声打哈欠）；提醒后关灯 → 夸「乖」，很快睡着；
//    21:30–23:00 自己早早关灯也会被夸（每晚一次）；「夜间安静」关掉 = 不提醒睡觉
static void scenarioCareBedtime() {
  boot(2025, 6, 10, 22, 40);
  face = true;
  until(23, 2);
  CHECK(countScript("kCareBedtime") == 1);
  CHECK(countSynth(sfx::S_YAWN) >= 1);
  CHECK(pulse::g_emits[pulse::FX_MOON] >= 1);
  face = false;
  run(5000);
  dark = true;
  lux = .5f;
  brain::onSensors(sensors::SE_DARK);
  run(1000);
  CHECK(countScript("kGoodSleep") == 1);
  CHECK(countScript("kLightsOffNight") == 0);
  run(60000);
  CHECK(brain::s_phase == brain::PH_SLEEP);
  const uint32_t quietFrom = g_ms;
  until(6, 30);
  CHECK(countSounds(quietFrom, g_ms) == 0);
  // 第二天 21:40 自己关灯：也夸
  dark = false;
  lux = 300.f;
  brain::onSensors(sensors::SE_LIGHT);
  until(21, 0);
  face = true;
  until(21, 40);
  face = false;
  run(5000);
  dark = true;
  lux = .5f;
  brain::onSensors(sensors::SE_DARK);
  run(1000);
  CHECK(countScript("kGoodSleep") == 2);
  run(60000);
  // 「夜间安静」关掉：不提醒睡觉
  dark = false;
  lux = 300.f;
  brain::onSensors(sensors::SE_LIGHT);
  until(22, 50);
  nightAuto = false;
  face = true;
  until(23, 40);
  CHECK(countScript("kCareBedtime") == 1);
  face = false;
  printCareLog();
}

// ⑩ 关心提醒「关」：一下午坐着也不提醒
static void scenarioCareOff() {
  boot(2025, 6, 11, 11, 0);
  brain::setCareLevel(care::L_OFF);
  face = true;
  until(15, 0);
  CHECK(countScript("kCareStretch") + countScript("kCareWater") + countScript("kCareMeal") + countScript("kCareNudge") +
            countScript("kPraiseDay") == 0);
  brain::setCareLevel(care::L_LESS);
  until(17, 0);
  const int n = countScript("kCareStretch") + countScript("kCareWater");
  CHECK(n >= 1 && n <= 2);  // 少一点：80 分钟一次
}

// ⑪ 任务提醒：你不在 → 叮咚叫你（最多 3 次，越来越小声）；睡着了白天会醒来叫你；
//    回来 → 庆祝 + 夸你（顶部显示标题）；摸一下 = 收到；几条一起到 = 一起庆祝；没成功 = 安慰；
//    夜里只亮灯不出声；关掉 = 不收；同一个 id 不重复
static void scenarioNotify() {
  boot(2025, 6, 12, 10, 0);
  run(5u * 60000u);  // 没人：犯困 / 睡着
  CHECK(brain::s_phase != brain::PH_AWAKE);
  bool tr = false;
  CHECK(brain::notify(care::N_DONE, "导出视频", "Ekko Studio", "job-1", &tr) == care::P_QUEUED && !tr);
  CHECK(brain::notify(care::N_DONE, "导出视频", "Ekko Studio", "job-1") == care::P_DUPLICATE);
  run(5000);
  CHECK(brain::s_phase == brain::PH_AWAKE);  // 白天：醒过来叫你
  CHECK(countScript("kNoticeCue") == 1);
  CHECK(countSynth(sfx::S_DING) == 1);
  run(15000);
  CHECK(brain::ledEffect(g_ms) == brain::LE_NOTICE);  // 琥珀色呼吸：有消息没看
  CHECK(brain::ledColor() == 0xFFA020u);
  run(30u * 60000u);
  CHECK(countScript("kNoticeCue") == 1 && countScript("kNoticeCueSoft") == 2);  // 最多 3 次
  CHECK(pulse::g_emits[pulse::FX_BELL] >= 3);
  // 回来了
  const uint32_t back = g_ms;
  face = true;
  run(8000);
  CHECK(countScript("kTaskDone") == 1);
  CHECK(pulse::g_labels >= 1);
  CHECK(countLog("[notify] 演给你看：任务完成「导出视频」") == 1);
  CHECK(pulse::g_emits[pulse::FX_CHECK] >= 1 && pulse::g_emits[pulse::FX_FLOWER] >= 1);
  CHECK(countSynth(sfx::S_CHEER, back) == 1 && countSynth(sfx::S_CLAP, back) == 1);
  CHECK(brain::noticeInbox().awaiting());
  run(5000);
  CHECK(!eng->labelsEnabled());  // 标题 6 秒后关掉
  strokeSession(1);
  CHECK(countScript("kNoticeAckDone") == 1);
  CHECK(brain::noticeInbox().pending() == 0);
  CHECK(countLog("[notify] 收到啦") == 1);
  // 走开时到了三个完成 + 一个没成功：回来先一起庆祝（「3 个任务完成啦」），再安慰
  face = false;
  run(3u * 60000u);
  CHECK(brain::notify(care::N_DONE, "渲染 A", "Ekko Studio", "a") == care::P_QUEUED);
  CHECK(brain::notify(care::N_DONE, "渲染 B", "Ekko Studio", "b") == care::P_QUEUED);
  CHECK(brain::notify(care::N_FAILED, "上传失败：网络断了", "Ekko Studio", "c") == care::P_QUEUED);
  CHECK(brain::notify(care::N_DONE, "渲染 C", "Ekko Studio", "d") == care::P_QUEUED);
  run(20000);
  face = true;
  run(20000);
  CHECK(countScript("kTaskDone") == 2);
  CHECK(countLog("[notify] 演给你看：任务完成「渲染 A」等 3 条") == 1);
  CHECK(countScript("kTaskFailed") == 1);
  CHECK(scriptAt("kTaskFailed") > scriptAt("kTaskDone", 1));
  run(4000);
  strokeSession(1);
  CHECK(countScript("kNoticeAckFailed") == 1);  // 最近演的是「没成功」：抱抱你
  CHECK(brain::noticeInbox().pending() == 0);
  // 在跟前时来了消息：马上演（不叮咚）
  run(30000);
  const uint32_t cues = countScript("kNoticeCue") + countScript("kNoticeCueSoft");
  CHECK(brain::notify(care::N_PRAISE, "今天提交了 12 次，辛苦啦", "Ekko Studio", nullptr) == care::P_QUEUED);
  run(6000);
  CHECK(countScript("kNoticePraise") == 1);
  CHECK((uint32_t)(countScript("kNoticeCue") + countScript("kNoticeCueSoft")) == cues);
  // 演完了不摸它：3 分钟后轻轻提醒，最多两次
  run(15u * 60000u);
  CHECK(countScript("kNoticeNudge") == 2);
  brain::onButton(2);  // 按键也算收到
  run(3000);
  CHECK(brain::noticeInbox().pending() == 0);
  // 刚摸完又来一条：摸它 = 马上演给你看
  CHECK(brain::notify(care::N_REMIND, "记得备份工程文件", "Ekko Studio", "r1") == care::P_QUEUED);
  run(500);
  taps(1);
  CHECK(countScript("kNoticeRemind") == 1);
  run(10000);
  strokeSession(1);
  CHECK(brain::noticeInbox().pending() == 0);
  face = false;
  // 聊天中：先不演，聊完再演
  run(60000);
  face = true;
  run(10000);
  conversation::startTurn("n", 9, g_ms);
  run(2000);
  CHECK(brain::notify(care::N_DONE, "转码完成", "Ekko Studio", "t1") == care::P_QUEUED);
  run(20000);
  CHECK(countScript("kTaskDone") == 2);
  conversation::cancel(g_ms);
  run(25000);
  CHECK(countScript("kTaskDone") == 3);
  run(8000);
  strokeSession(1);
  // 夜里：不出声，只亮灯（不叫醒它）
  face = false;
  until(23, 30);
  run(5u * 60000u);
  CHECK(brain::s_phase == brain::PH_SLEEP);
  const uint32_t nightFrom = g_ms;
  CHECK(brain::notify(care::N_DONE, "夜里跑完的任务", "Ekko Studio", "n1") == care::P_QUEUED);
  until(6, 0);
  CHECK(countSounds(nightFrom, g_ms) == 0);
  CHECK(brain::s_phase == brain::PH_SLEEP);
  CHECK(brain::ledEffect(g_ms) == brain::LE_NOTICE);
  // 早上：不会自己叮咚（夜里到的消息只等你来看）；看见你：醒来、庆祝
  const uint32_t morningFrom = g_ms;
  until(7, 39);
  CHECK(countSounds(morningFrom, g_ms) == 0);
  CHECK(countScript("kNoticeCue", morningFrom) + countScript("kNoticeCueSoft", morningFrom) == 0);
  until(7, 40);
  face = true;
  run(10000);
  CHECK(countScript("kTaskDone") == 4);
  run(5000);
  strokeSession(1);
  // 关掉：不收
  brain::setNotifyEnabled(false);
  CHECK(!brain::notifyEnabled());
  CHECK(brain::notify(care::N_DONE, "x", nullptr, nullptr) == care::P_INVALID);
  run(10000);
  CHECK(countScript("kTaskDone") == 4);
  brain::setNotifyEnabled(true);
  // 标题太长：截断 + 不会半个字
  tr = false;
  CHECK(brain::notify(care::N_DONE, "这是一个非常非常非常非常非常非常非常非常非常非常长的任务标题啊啊啊啊", "Ekko Studio", "long", &tr) ==
        care::P_QUEUED);
  CHECK(tr);
  run(8000);
  CHECK(countScript("kTaskDone") == 5);
  CHECK(strlen(brain::s_label) < 64);
  CHECK(std::string(brain::s_label).find("\xE2\x80\xA6") != std::string::npos);
  printCareLog();
}

// ⑫ 坏输入：不认识的种类、空标题、超长 id、刷屏
static void scenarioNotifyLimits() {
  boot(2025, 6, 13, 15, 0);
  CHECK(brain::notify(9, "x", nullptr, nullptr) == care::P_INVALID);
  char id[64];
  memset(id, 'a', sizeof id);
  id[63] = 0;
  CHECK(brain::notify(care::N_DONE, "x", nullptr, id) == care::P_INVALID);
  CHECK(brain::notify(care::N_DONE, nullptr, nullptr, nullptr) == care::P_QUEUED);  // 没标题：用默认的「任务完成」
  int rate = 0;
  for (int i = 0; i < 40; i++) {
    char k[16];
    snprintf(k, sizeof k, "spam-%d", i);
    if (brain::notify(care::N_REMIND, k, "x", k) == care::P_RATE) rate++;
  }
  CHECK(rate >= 19);
  CHECK(brain::noticeInbox().pending() <= care::Inbox::kCap);
  run(60000);
}

// ⑬ 亲密度存档：存 → 读回一样；坏数据不覆盖
static void scenarioPersistence() {
  boot(2025, 6, 7, 10, 0);
  face = true;
  run(60000);
  face = false;
  strokeSession(3);
  companion::BondData d = brain::bondSave();
  CHECK(d.magic == companion::kBondMagic);
  const uint32_t pts = brain::bond().points();
  brain::bondClean();
  CHECK(!brain::bondDirty());
  companion::BondData bad = d;
  bad.points16 += 1000;  // 校验值不对
  CHECK(!brain::bondLoad(&bad, sizeof(bad)));
  CHECK(brain::bond().points() == pts);
  CHECK(!brain::bondLoad(&d, sizeof(d) - 1));
  CHECK(brain::bondLoad(&d, sizeof(d)));
  CHECK(brain::bond().points() == pts);
}

// ⑭ 熟了以后：摸摸会慢慢眨眼、冒爱心；看着你时会慢慢眨眼
static void scenarioCloseFriend() {
  boot(2025, 6, 8, 16, 0);
  companion::Bond b;
  for (int i = 0; i < 4000; i++) b.add(companion::B_DAILY, 1);
  companion::BondData d = b.save();
  CHECK(brain::bondLoad(&d, sizeof(d)));
  CHECK(brain::bond().level() >= 5);
  const uint32_t blinks0 = pulse::g_blinks, hearts0 = pulse::g_emits[pulse::FX_HEART];
  face = true;
  run(120000);
  CHECK(pulse::g_blinks > blinks0 + 5);  // 看着你：慢慢眨眼
  face = false;
  run(3000);
  strokeSession(3);
  CHECK(pulse::g_emits[pulse::FX_HEART] > hearts0);
  printf("  close friend: blinks +%u hearts +%u\n", pulse::g_blinks - blinks0, pulse::g_emits[pulse::FX_HEART] - hearts0);
}

// ============================== 2.9 活泼版 ==============================
int countPrefix(const char* p, uint32_t from = 0, uint32_t to = 0xFFFFFFFFu);
int countPrefix(const char* p, uint32_t from, uint32_t to) {
  int n = 0;
  const size_t k = strlen(p);
  for (auto& s : scripts)
    if (s.first >= from && s.first <= to && s.second.compare(0, k, p) == 0) n++;
  return n;
}
template <class F>
bool waitFor(F f, uint32_t maxMs, uint32_t step = 50) {
  for (uint32_t t = 0; t < maxMs; t += step) {
    if (f()) return true;
    frame(step);
  }
  return f();
}
// 很快地点一下（手放上去 80 毫秒）
void tapOnce(bool head = false) {
  bool& d = head ? headDown : screenDown;
  d = true;
  run(80, 10);
  d = false;
  gesture(head ? touchinteraction::Source::Head : touchinteraction::Source::Screen, touchinteraction::Gesture::Tap);
}
// 手放在头顶不动
void holdHead(uint32_t ms) {
  headDown = true;
  run(ms);
  headDown = false;
  run(500);
}
bool idleNow() { return !brain::s_scr && !brain::s_settleAt && !brain::bids().waiting(g_ms) && brain::s_mode == brain::PM_NONE; }

// 照着它敲的节奏拍一轮。miss = 故意少拍一下；head = 拍头顶
void playRound(bool miss = false, bool head = false) {
  CHECK(waitFor([] { return brain::rhythm().listening(); }, 20000, 10));
  run(500, 10);
  const int beats = brain::rhythm().beats() - (miss ? 1 : 0);
  const uint16_t* g = brain::rhythm().gaps();
  for (int i = 0; i < beats; i++) {
    tapOnce(head);
    if (i + 1 < beats) run(g[i] - 80, 10);
  }
  CHECK(waitFor([] { return !brain::rhythm().listening(); }, 3000, 10));  // 判完这一关
}

// ⑮ 活泼：看着你时时不时一个小反应；会主动邀请；连着 3 次没理就先不烦你（安静 = 和 2.8 一样，见一周日常）
static void scenarioLivelyFace() {
  level = play::LV_LIVELY;
  boot(2025, 6, 10, 10, 0);
  brain::setCareLevel(care::L_OFF);  // 只看玩的
  face = true;
  const uint32_t t0 = g_ms;
  run(600000);
  const int micro = countPrefix("kMicro", t0);
  const auto& bd = brain::bids();
  printf("  lively 10 min facing: micro %d, bids offered %u ignored %u snoozes %u, sounds %d\n", micro, (unsigned)bd.offered,
         (unsigned)bd.ignored, (unsigned)bd.snoozes, countSounds(t0, g_ms));
  CHECK(micro >= 15 && micro <= 75);
  CHECK(bd.offered == 3 && bd.accepted == 0 && bd.ignored == 3 && bd.snoozes == 1 && bd.snoozed(g_ms));
  CHECK(countPrefix("kBid", t0) == 3);
  CHECK(brain::playStats().micro == (uint32_t)micro);
  // 小反应不连着重复同一个
  int repeats = 0;
  std::string last;
  for (auto& s : scripts)
    if (s.first >= t0 && !s.second.compare(0, 6, "kMicro")) {
      if (s.second == last) repeats++;
      last = s.second;
    }
  CHECK(repeats <= micro / 4);
  // 不理它：20 分钟内不再邀请；小反应照常
  run(600000);
  CHECK(bd.offered == 3);
  CHECK(countPrefix("kMicro", t0) > micro + 15);
  // 不看它的时候：没有小反应
  face = false;
  run(5000);
  const int m1 = countPrefix("kMicro");
  run(120000);
  CHECK(countPrefix("kMicro") == m1);
  // 换成「安静」：不再有小反应、不邀请
  brain::setLively(play::LV_QUIET);
  face = true;
  const uint32_t q0 = g_ms;
  run(1800000);
  CHECK(countPrefix("kMicro", q0) == 0 && countPrefix("kBid", q0) == 0 && bd.offered == 3);
}

// ⑯ 主动邀请：你每次都接 → 越来越常邀请（每天最多 40 次）；接了「一起玩」= 节奏游戏；说话也算接
static void scenarioBids() {
  level = play::LV_LIVELY;
  boot(2025, 6, 11, 9, 0);
  brain::setCareLevel(care::L_OFF);
  face = true;
  run(30000);
  std::vector<uint32_t> at;
  int games = 0, yes = 0;
  const uint32_t t0 = g_ms;
  while (g_ms - t0 < 80u * 60000u) {
    frame(50);
    if (!brain::bids().waiting(g_ms)) continue;
    at.push_back(g_ms);
    const uint8_t kind = brain::bids().waitingKind();
    run(1500);
    const uint32_t acc0 = brain::bids().accepted;
    const int yes0 = countScript("kBidPetYes") + countScript("kBidHeartYes") + countScript("kBidNuzzleYes") + countScript("kBidShowYes");
    tapOnce();
    run(300);
    CHECK(brain::bids().accepted == acc0 + 1);
    if (kind == play::BID_PLAY) {
      CHECK(brain::s_mode == brain::PM_RHYTHM);
      for (int r = 0; r < play::Rhythm::kRounds; r++) playRound();
      CHECK(waitFor([] { return brain::s_mode == brain::PM_NONE; }, 10000));
      games++;
    } else {
      const int yes1 = countScript("kBidPetYes") + countScript("kBidHeartYes") + countScript("kBidNuzzleYes") + countScript("kBidShowYes");
      CHECK(yes1 == yes0 + 1);
      yes++;
    }
    run(2500);
  }
  const auto& bd = brain::bids();
  double g1 = 0, g2 = 0;
  for (int i = 1; i <= 3; i++) g1 += (at[i] - at[i - 1]) / 3000.0;
  for (size_t i = at.size() - 5; i < at.size(); i++) g2 += (at[i] - at[i - 1]) / 5000.0;
  printf("  bids accepted %u/%u (games %d, yes %d), first gaps %.0f s, last gaps %.0f s, acceptance %.2f\n", (unsigned)bd.accepted,
         (unsigned)bd.offered, games, yes, g1, g2, bd.acceptance());
  CHECK(bd.offered == 40 && bd.accepted == 40 && bd.todayAccepted() == 40 && bd.acceptance() > .95f);
  CHECK(g2 < g1);
  CHECK(games >= 1 && brain::playStats().gameWins == (uint32_t)games);
  CHECK(at.back() - t0 < 60u * 60000u);  // 40 次以后今天就不再邀请了
}

// ⑰ 躲猫猫：看着它，然后躲开 → 它东找西找；一直不回来 → 算了；回来 →「找到你啦」；接着玩 → 笑出声
static void scenarioPeekaboo() {
  level = play::LV_LIVELY;
  boot(2025, 6, 12, 15, 0);
  brain::setCareLevel(care::L_OFF);
  face = true;
  run(30000);
  CHECK(waitFor(idleNow, 120000));
  face = false;
  CHECK(waitFor([] { return brain::peekaboo().searching(); }, 4000));
  CHECK(countScript("kPeekSearch") == 1);
  run(9000);
  CHECK(!brain::peekaboo().searching() && countScript("kPeekGiveUp") == 1);
  face = true;
  run(60000);  // 冷却
  for (int i = 0; i < 3; i++) {
    CHECK(waitFor(idleNow, 120000));
    face = false;
    CHECK(waitFor([] { return brain::peekaboo().searching(); }, 4000));
    run(1500);
    face = true;
    CHECK(waitFor([] { return !brain::peekaboo().searching(); }, 1000));
    run(i < 2 ? 6000 : 3000);
  }
  printf("  peekaboo: found %u, streak %u, searches %d\n", (unsigned)brain::peekaboo().found, (unsigned)brain::peekaboo().streak(),
         countScript("kPeekSearch"));
  CHECK(countScript("kPeekFound") == 2 && countScript("kPeekFoundMore") == 1);
  CHECK(brain::peekaboo().found == 3 && brain::peekaboo().streak() == 3);
  // 夜里不玩
  until(22, 30);
  face = true;
  run(30000);
  const int s0 = countScript("kPeekSearch");
  face = false;
  run(10000);
  CHECK(countScript("kPeekSearch") == s0);
}

// ⑱ 节奏游戏：连拍三下开始；照着拍 = 过关（拍头也行）；拍错有一次重来；不拍 = 不玩啦。玩的时候触摸归游戏
static void scenarioRhythm() {
  level = play::LV_NORMAL;
  boot(2025, 6, 13, 16, 0);
  brain::setCareLevel(care::L_OFF);
  run(20000);
  const uint32_t pts0 = brain::bond().points();
  taps(3);
  CHECK(brain::s_mode == brain::PM_RHYTHM && brain::touchCaptured());
  CHECK(countScript("kGameIntro") == 1);
  const int touch0 = countPrefix("kTouch"), boundary0 = (int)boundaryVisuals;
  for (int r = 0; r < play::Rhythm::kRounds; r++) playRound(false, r == 2);  // 第 3 关拍头顶
  CHECK(waitFor([] { return brain::s_mode == brain::PM_NONE; }, 8000));
  CHECK(brain::rhythm().passed() == 5 && brain::rhythm().perfects() >= 4);
  CHECK(countScript("kGameWin") == 1 && brain::playStats().gameWins == 1 && brain::playStats().games == 1);
  CHECK(countPrefix("kTouch") == touch0 && (int)boundaryVisuals == boundary0);  // 拍了二十多下：不当成「摸太多」
  CHECK(brain::bond().points() > pts0);
  CHECK(countSynth(sfx::S_BOP) >= 19 && countSynth(sfx::S_TURN) == 5);
  run(10000);
  // 拍错：同一段再来一次；又错：结束（过了 0 关）
  CHECK(brain::rhythmStart());
  playRound(true);
  CHECK(waitFor([] { return brain::rhythm().round() == 0 && brain::rhythm().listening(); }, 8000));
  playRound(true);
  CHECK(waitFor([] { return brain::s_mode == brain::PM_NONE; }, 8000));
  CHECK(brain::rhythm().passed() == 0 && countScript("kGameMiss") == 2 && countScript("kGameEndSoft") == 1);
  run(5000);
  // 不拍：不玩啦
  CHECK(brain::rhythmStart());
  CHECK(waitFor([] { return brain::s_mode == brain::PM_NONE; }, 20000));
  CHECK(countScript("kGameTimeout") == 1 && countScript("kGameEndSoft") == 2);
  // 玩的时候被摇：不玩了
  CHECK(brain::rhythmStart());
  CHECK(waitFor([] { return brain::rhythm().listening() && !plan.busy() && (int32_t)(g_ms - brain::s_sensQuiet) >= 0; }, 10000));
  brain::onSensors(sensors::SE_SHAKE);
  run(100);
  CHECK(brain::s_mode == brain::PM_NONE && countScript("kDizzy") == 1);
  run(5000);
  CHECK(brain::playStats().games == 4);
  CHECK(!eng->labelsEnabled());
}

// ⑲ 跳舞：连拍两下。没有麦克风 / 没放歌 = 自己啦啦啦；放着歌 = 跟着节拍跳、灯跟着闪、跳 16 拍听一听、
//     跳满 3 分钟歇一会儿（一直放：歇得越来越久）；歌停了鞠个躬；摸它 / 来消息 = 不跳了
static void scenarioDance() {
  level = play::LV_NORMAL;
  boot(2025, 6, 14, 15, 0);
  brain::setCareLevel(care::L_OFF);
  run(20000);
  taps(2);
  CHECK(countScript("kDanceSolo") == 1 && brain::playStats().dances == 1 && brain::playStats().musicDances == 0);
  run(10000);
  CHECK(brain::s_mode == brain::PM_NONE);
  // 有麦克风、没放歌
  musicAvail = true;
  brain::setMusicAvailable(true);
  taps(2);
  CHECK(brain::s_mode == brain::PM_DANCE && brain::s_groove == brain::G_LISTEN && brain::musicListenWanted());
  run(5000);
  CHECK(countScript("kDanceSolo") == 2 && brain::s_groove == brain::G_IDLE && brain::s_mode == brain::PM_NONE);
  run(10000);
  // 放着歌（120 BPM），你在旁边（没人的时候歇着歇着就睡着了）
  face = true;
  run(20000);
  CHECK(waitFor(idleNow, 120000));
  musicBpm = 120.f;
  musicT0 = g_ms - 363;  // 歌已经放了一会儿
  taps(2);
  CHECK(waitFor([] { return brain::s_groove == brain::G_DANCE; }, 6000));
  CHECK(brain::ledEffect(g_ms) == brain::LE_BEAT && plan.grooveAmp() > 0.f && brain::playStats().musicDances == 1);
  float hi = 0.f, lo = 1.f;
  for (int i = 0; i < 40; i++) {
    frame(25);
    if (brain::ledEffect(g_ms) != brain::LE_BEAT) continue;
    hi = std::max(hi, brain::ledLevel(g_ms));
    lo = std::min(lo, brain::ledLevel(g_ms));
  }
  CHECK(hi > .8f && lo < .4f);
  // 拍点：灯最亮的时候就是歌的拍点（±60 毫秒）
  CHECK(waitFor([] { return brain::s_groove == brain::G_DANCE; }, 10000));
  {
    uint32_t best = 0;
    float bl = 0.f;
    for (int i = 0; i < 50; i++) {
      frame(10);
      if (brain::s_groove != brain::G_DANCE) continue;
      const float l = brain::ledLevel(g_ms);
      if (l > bl) {
        bl = l;
        best = g_ms;
      }
    }
    const uint32_t ph = (best - musicT0) % 500u;
    if (!(ph < 60 || ph > 440))
      printf("  beat phase %u: best %u t0 %u est.beatMs %u period %u bl %.2f\n", (unsigned)ph, (unsigned)best, (unsigned)musicT0,
             (unsigned)brain::s_est.beatMs, (unsigned)brain::s_est.periodMs, bl);
    CHECK(ph < 60 || ph > 440);
  }
  // 自己在晃：不当成被摇
  CHECK(waitFor([] { return brain::s_groove == brain::G_DANCE; }, 10000));
  brain::onSensors(sensors::SE_SHAKE);
  run(100);
  CHECK(brain::s_mode == brain::PM_DANCE && countScript("kDizzy") == 0);
  const uint32_t d0 = brain::s_danceFrom;
  int pauses = 0;
  uint8_t was = brain::s_groove;
  while (brain::s_mode == brain::PM_DANCE && g_ms - d0 < 240000) {
    frame(50);
    if (brain::s_groove == brain::G_PAUSE && was != brain::G_PAUSE) pauses++;
    was = brain::s_groove;
  }
  printf("  dance: %.0f s, %d pauses, listened %.0f s\n", (g_ms - d0) / 1000.f, pauses, listenMs / 1000.f);
  CHECK(countScript("kDanceTired") == 1 && g_ms - d0 >= 175000 && g_ms - d0 < 200000);
  CHECK(pauses >= 10);
  run(3000);  // 慢慢停下来
  CHECK(brain::s_groove == brain::G_REST && !brain::musicListenWanted() && plan.grooveAmp() == 0.f);
  // 歇 3 分钟以后：歌还在放 → 自己又跳起来；这次跳累了歇 6 分钟
  CHECK(waitFor([] { return brain::s_groove == brain::G_DANCE; }, 260000));
  CHECK(brain::playStats().musicDances == 2);
  CHECK(waitFor([] { return brain::s_groove == brain::G_REST; }, 240000));
  CHECK(brain::s_grooveUntil - g_ms > 5u * 60000u);
  CHECK(countLog("歇 6 分钟") == 1);
  // 歌停了：跳完这一段鞠个躬
  run(370000);
  CHECK(waitFor([] { return brain::s_groove == brain::G_DANCE; }, 120000));
  musicBpm = 0.f;
  CHECK(waitFor([] { return brain::s_mode == brain::PM_NONE; }, 30000));
  CHECK(countScript("kDanceEnd") == 1 && countLog("歌停了") == 1);
  run(10000);
  // 摸它：不跳了，正常地回应
  musicBpm = 100.f;
  musicT0 = g_ms;
  taps(2);
  CHECK(waitFor([] { return brain::s_groove == brain::G_DANCE; }, 8000));
  const int touch0 = countPrefix("kTouch");
  strokeSession(1);
  CHECK(brain::s_mode == brain::PM_NONE && brain::s_groove != brain::G_DANCE && plan.grooveAmp() == 0.f);
  CHECK(countPrefix("kTouch") == touch0 + 1);
  run(30000);
  // 来消息：先停下来
  CHECK(waitFor([] { return brain::s_groove == brain::G_DANCE; }, 120000));
  CHECK(brain::notify(care::N_DONE, "构建完成", "Ekko Studio", "d1") == care::P_QUEUED);
  run(3000);
  CHECK(brain::s_mode == brain::PM_NONE);
  CHECK(waitFor([] { return countScript("kNoticeCue") + countScript("kNoticeCueSoft") + countScript("kTaskDone") >= 1; }, 30000));
  run(60000);
  // 关掉「听歌跳舞」：不再听；连拍两下 = 自己跳
  brain::setMusicEnabled(false);
  CHECK(!brain::musicListenWanted());
  const uint32_t listen0 = listenMs + (listening ? g_ms - listenSince : 0);
  brain::acknowledge();  // 刚才的消息：知道啦
  run(5000);
  CHECK(waitFor(idleNow, 120000));
  taps(2);
  CHECK(countScript("kDanceSolo") >= 3);
  run(300000);
  CHECK(listenMs + (listening ? g_ms - listenSince : 0) == listen0);
  CHECK(!eng->labelsEnabled());
}

// ⑳ 背景听歌：醒着、空着的时候偶尔听一下有没有在放歌（每次几秒），在放就自己跳起来；夜里不听
static void scenarioMusicBackground() {
  level = play::LV_NORMAL;
  musicAvail = true;
  boot(2025, 6, 15, 10, 0);
  brain::setCareLevel(care::L_OFF);
  face = true;
  const uint32_t t0 = g_ms;
  run(20u * 60000u);
  const uint32_t heard = listenMs + (listening ? g_ms - listenSince : 0);
  printf("  background: listened %.0f s of %.0f s, feeds %u\n", heard / 1000.f, (g_ms - t0) / 1000.f, (unsigned)beatFeeds);
  CHECK(heard > 10000 && heard < (g_ms - t0) / 10);
  CHECK(brain::s_mode == brain::PM_NONE && brain::playStats().musicDances == 0);
  musicBpm = 96.f;
  musicT0 = g_ms;
  const uint32_t m0 = g_ms;
  CHECK(waitFor([] { return brain::s_groove == brain::G_DANCE; }, 200000));
  printf("  background: started dancing %.0f s after the music started\n", (g_ms - m0) / 1000.f);
  CHECK(brain::playStats().musicDances == 1 && brain::lastBeat().music && fabsf(brain::lastBeat().bpm - 96.f) < 1.f);
  CHECK(brain::musicAgo(g_ms) < 2000);
  musicBpm = 0.f;
  CHECK(waitFor([] { return brain::s_mode == brain::PM_NONE; }, 30000));
  // 夜里：不听
  until(22, 10);
  face = true;
  musicBpm = 120.f;
  const uint32_t n0 = listenMs + (listening ? g_ms - listenSince : 0);
  run(20u * 60000u);
  CHECK(listenMs + (listening ? g_ms - listenSince : 0) == n0 && brain::s_groove != brain::G_DANCE);
  // 聊天时：不听
  CHECK(!brain::musicListenWanted() || !conversation::active());
}

// ㉑ 一起深呼吸：手放在头顶不动 3.5 秒（摸来摸去不算）；6 次，吸 4 秒呼 6 秒；灯和脸跟着呼吸；点一下 = 不做了
static void scenarioBreathe() {
  level = play::LV_NORMAL;
  boot(2025, 6, 16, 14, 0);
  brain::setCareLevel(care::L_OFF);
  run(20000);
  strokeSession(10, 450);
  CHECK(brain::s_mode == brain::PM_NONE);
  run(5000);
  const int breath0 = countSynth(sfx::S_BREATH);
  headDown = true;
  const uint32_t h0 = g_ms;
  CHECK(waitFor([] { return brain::s_mode == brain::PM_BREATH; }, 4500));
  CHECK(g_ms - h0 >= 3500 && countScript("kBreathIntro") == 1 && brain::touchCaptured());
  run(2000);
  headDown = false;
  const uint32_t b0 = g_ms;
  float lo = 1.f, hi = 0.f, guide = 0.f;
  bool inhale = false, exhale = false;
  while (brain::s_mode == brain::PM_BREATH && g_ms - b0 < 90000) {
    frame(50);
    if (brain::ledEffect(g_ms) == brain::LE_BREATH) {
      lo = std::min(lo, brain::ledLevel(g_ms));
      hi = std::max(hi, brain::ledLevel(g_ms));
    }
    guide = std::max(guide, brain::s_guideA);
    if (pulse::g_label == "吸气…") inhale = true;
    if (pulse::g_label == "呼气…") exhale = true;
  }
  printf("  breathe: %.0f s, led %.2f–%.2f, guide %.2f\n", (g_ms - b0) / 1000.f, lo, hi, guide);
  CHECK(countScript("kBreathDone") == 1 && brain::playStats().breaths == 6);
  CHECK(countSynth(sfx::S_BREATH) - breath0 == 6);
  CHECK(hi > .95f && lo < .2f && guide > .9f && inhale && exhale);
  CHECK(g_ms - b0 > 55000 && g_ms - b0 < 65000);
  run(5000);
  CHECK(brain::s_guideA < .05f && brain::ledEffect(g_ms) == brain::LE_NONE);
  // 串口：一起深呼吸 1 分钟；点一下 = 不做了（只做了一次：不夸）
  CHECK(brain::breathe(1));
  run(15000);
  taps(1);
  CHECK(brain::s_mode == brain::PM_NONE && countScript("kBreathDone") == 1 && brain::playStats().breaths == 7);
  run(5000);
  CHECK(!eng->labelsEnabled());
  // 夜里：不出声
  until(23, 0);
  holdHead(5000);
  const int bn = countSynth(sfx::S_BREATH);
  CHECK(waitFor([] { return brain::s_mode == brain::PM_NONE; }, 90000));
  CHECK(countSynth(sfx::S_BREATH) == bn);
}

// ㉒ 每晚心情打卡：19:30 以后看见你时问一次，拍几下就是几分；没回答 20 分钟后再问一次；
//     打了 4 天以后每周小结一次；连着几天心情都不好：提醒找信任的人聊聊；记录存进 NVS
static void scenarioMood() {
  level = play::LV_QUIET;
  boot(2025, 6, 16, 19, 0);
  const int scores[6] = {4, 2, 1, 2, 0, 5};
  uint32_t day5 = 0;
  for (int d = 0; d < 6; d++) {
    until(19, 29);
    face = true;
    CHECK(waitFor([] { return brain::s_mode == brain::PM_MOOD; }, 300000));
    CHECK(pulse::g_label == "今天心情几分？拍我 1-5 下");
    const uint32_t today = brain::bondToday();
    if (scores[d] == 0) {  // 不回答
      day5 = today;
      CHECK(waitFor([] { return brain::s_mode == brain::PM_NONE; }, 40000));
      CHECK(waitFor([] { return brain::s_mode == brain::PM_MOOD; }, 25u * 60000u));
      CHECK(waitFor([] { return brain::s_mode == brain::PM_NONE; }, 40000));
      run(40u * 60000u);
      CHECK(brain::moodLog().asksOn(today) == 2 && brain::moodLog().scoreOn(today) == -1);
    } else if (d == 5) {   // 串口回答
      run(2000);
      CHECK(brain::moodSet((uint8_t)scores[d]));
      CHECK(waitFor([] { return brain::s_mode == brain::PM_NONE; }, 20000));
    } else {
      run(1500);
      taps(scores[d]);
      CHECK(waitFor([] { return brain::s_mode == brain::PM_NONE; }, 20000));
    }
    if (scores[d]) CHECK(brain::moodLog().scoreOn(today) == scores[d]);
    face = false;
    run(60000);
    if (d == 3) CHECK(countScript("kMoodWeek") == 1 && countScript("kMoodCare") == 1);
  }
  printf("  mood: asks %u, entries %d, avg %.1f\n", (unsigned)brain::playStats().moodAsks, brain::moodLog().entries(brain::bondToday()),
         brain::moodLog().average(brain::bondToday()));
  CHECK(countScript("kMood4") == 1 && countScript("kMood2") == 2 && countScript("kMood1") == 1 && countScript("kMood5") == 1);
  CHECK(countScript("kMoodAsk") == 7 && brain::playStats().moodAsks == 7);
  CHECK(countScript("kMoodWeek") == 1);  // 一周只小结一次
  CHECK(countLog("[mood] 每周小结：这周平均 2.2 分，最近辛苦了") == 1);
  CHECK(brain::moodLog().entries(brain::bondToday()) == 5 && brain::moodLog().scoreOn(day5) == -1);
  CHECK(brain::moodDirty());
  // NVS：保存 / 读回 / 校验失败 = 保持不变
  play::MoodData d = brain::moodSave();
  CHECK(d.magic == play::kMoodMagic && d.count == 5);
  brain::moodClean();
  CHECK(!brain::moodDirty());
  play::MoodData bad = d;
  bad.score[0] = (uint8_t)(d.score[0] == 3 ? 4 : 3);
  CHECK(!brain::moodLoad(&bad, sizeof bad) && !brain::moodLoad(&d, sizeof d - 1));
  CHECK(brain::moodLoad(&d, sizeof d) && brain::moodLog().entries(brain::bondToday()) == 5);
  // 打过卡的那天不再问；关掉关心提醒 = 不问
  until(19, 29);
  brain::setCareLevel(care::L_OFF);
  face = true;
  run(40u * 60000u);
  CHECK(countScript("kMoodAsk") == 7);
  brain::moodClear();
  CHECK(brain::moodLog().entries(brain::bondToday()) == 0);
}

// ㉓ 一起玩的时候开始聊天：先不玩了（聊完不会接着玩）；聊天时不会开始玩
static void scenarioPlayChat() {
  level = play::LV_LIVELY;
  boot(2025, 6, 17, 11, 0);
  brain::setCareLevel(care::L_OFF);
  run(20000);
  CHECK(brain::rhythmStart());
  CHECK(waitFor([] { return brain::rhythm().listening(); }, 10000));
  CHECK(conversation::startTurn("p1", 1, g_ms));
  CHECK(brain::s_mode == brain::PM_NONE && !brain::touchCaptured());
  CHECK(!brain::rhythmStart() && !brain::breathe(1) && !brain::dance());  // 聊天时：不开始
  headDown = true;
  run(6000);  // 聊天时按住头顶：不深呼吸
  headDown = false;
  CHECK(brain::s_mode == brain::PM_NONE);
  conversation::cancel(g_ms);
  run(10000);
  CHECK(brain::s_mode == brain::PM_NONE && !brain::rhythm().active());
  CHECK(brain::breathe(0));
  run(5000);
  CHECK(conversation::startTurn("p2", 2, g_ms));
  CHECK(brain::s_mode == brain::PM_NONE);
  run(3000);
  conversation::cancel(g_ms);
  run(5000);
  CHECK(brain::s_guideA < .05f);
  CHECK(brain::stopPlaying() == false);
  CHECK(brain::rhythmStart() && brain::stopPlaying() && brain::s_mode == brain::PM_NONE);
  run(5000);
  CHECK(!eng->labelsEnabled());
  // 它在邀请你的时候和它说话 = 接受了
  face = true;
  CHECK(waitFor([] { return brain::bids().waiting(g_ms); }, 600000));
  const uint32_t acc = brain::bids().accepted;
  CHECK(conversation::startTurn("bid", 3, g_ms));
  CHECK(brain::bids().accepted == acc + 1 && !brain::bids().waiting(g_ms));
  run(3000);
  conversation::cancel(g_ms);
  run(5000);
}

// ㉔ 没有相机：摸过它 / 说过话就算你在（主动邀请照样有）；没有小反应和躲猫猫
static void scenarioNoCamera() {
  level = play::LV_LIVELY;
  boot(2025, 6, 18, 10, 0);
  brain::setCareLevel(care::L_OFF);
  for (int i = 0; i < 12; i++) {
    strokeSession(2);
    run(100000);
  }
  printf("  no camera: bids offered %u\n", (unsigned)brain::bids().offered);
  CHECK(brain::bids().offered >= 2);
  CHECK(countPrefix("kMicro") == 0 && countPrefix("kPeek") == 0);
}

// ① 换成「活泼」再过一周（有麦克风、不放歌）：一样安安稳稳
static void scenarioWeekLively() {
  level = play::LV_LIVELY;
  musicAvail = true;
  scenarioWeek();
}

typedef void (*Scenario)();
int main(int argc, char** argv) {
  setvbuf(stdout, nullptr, _IONBF, 0);
  g_verbose = argc > 1 && !strcmp(argv[1], "-v");
  const char* only = argc > 2 ? argv[2] : (argc > 1 && strcmp(argv[1], "-v") ? argv[1] : nullptr);
  nameScripts();
  struct { const char* name; Scenario fn; } list[] = {
    {"week", scenarioWeek}, {"sleep_wake", scenarioSleepWake}, {"conversation", scenarioConversation},
    {"no_clock", scenarioNoClock}, {"millis_wrap", scenarioWrap}, {"previews", scenarioPreviews},
    {"care_stretch", scenarioCareStretch}, {"care_meal", scenarioCareMeal}, {"care_bedtime", scenarioCareBedtime},
    {"care_off", scenarioCareOff}, {"notify", scenarioNotify}, {"notify_limits", scenarioNotifyLimits},
    {"persistence", scenarioPersistence}, {"close_friend", scenarioCloseFriend},
    // 2.9
    {"lively_face", scenarioLivelyFace}, {"bids", scenarioBids}, {"peekaboo", scenarioPeekaboo}, {"rhythm", scenarioRhythm},
    {"dance", scenarioDance}, {"music_background", scenarioMusicBackground}, {"breathe", scenarioBreathe}, {"mood", scenarioMood},
    {"play_chat", scenarioPlayChat}, {"no_camera", scenarioNoCamera}, {"week_lively", scenarioWeekLively},
  };
  int failed = 0;
  for (auto& s : list) {
    if (only && strcmp(only, s.name)) continue;
    fflush(stdout);
    const pid_t pid = fork();
    if (pid == 0) {
      s.fn();
      printf("  ok %s (%u log lines)\n", s.name, g_lines);
      fflush(stdout);
      _exit(0);
    }
    int st = 0;
    waitpid(pid, &st, 0);
    if (!WIFEXITED(st) || WEXITSTATUS(st) != 0) {
      printf("FAIL scenario %s\n", s.name);
      failed++;
    }
  }
  printf("brain life simulation: %d failed\n", failed);
  return failed ? 1 : 0;
}
