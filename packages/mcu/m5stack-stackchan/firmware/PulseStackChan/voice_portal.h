#pragma once
#include <stddef.h>
#include <stdint.h>

namespace voiceportal {
struct TouchInfo {
  bool headDown = false, screenDown = false;
  uint32_t happy = 0, boundary = 0, phraseQueued = 0, phraseStarted = 0;
  uint32_t phraseDone = 0, phraseCancelled = 0;
  uint32_t faceApplied = 0, fxOnly = 0;
};
struct FaceTrackingInfo {
  bool enabled = false, camera = false, worker = false;
  bool locked = false, tracking = false, ambiguous = false;
  int faces = 0;
  uint32_t frameId = 0, targetId = 0, capturedMs = 0, ageMs = 0, lostMs = 0;
  float errorX = 0.f, errorY = 0.f, pan = 0.f, tilt = 0.f;
};
// 2.7 情绪价值版：心情 + 亲密度 + 环境（/api/status 里的 "companion"）
struct CompanionInfo {
  const char* tone = "";       // calm / joyful / content / playful / lonely / sleepy / grumpy / excited
  const char* toneName = "";   // 中文
  const char* phase = "";      // awake / tired / asleep
  float valence = 0.f, arousal = 0.f, energy = 0.f, social = 0.f;
  uint8_t level = 1;           // 亲密度等级（1–10）
  const char* levelName = "";
  uint32_t points = 0;
  float progress = 0.f;        // 到下一级的进度 0–1
  uint16_t streak = 0, daysTogether = 0;
  uint32_t daysKnown = 0;      // 认识的第几天（0 = 还不知道日期）
  bool night = false, clockValid = false;
  char localTime[6] = {};      // "HH:MM"（不知道时间 = 空）
  float lux = -1.f;            // -1 = 没有环境光传感器
  int8_t battery = -1;         // -1 = 读不到
  bool charging = false;
  // 2.8 陪伴版：关心提醒 + 任务提醒（字符串都指向固件里常驻的内存；只在主循环里读）
  const char* careLevel = "on";        // off / less / on
  bool careHere = false;               // 觉得你就在附近
  uint32_t sittingMin = 0, presenceTodayMin = 0;
  uint16_t remindersToday = 0, acksToday = 0;
  const char* careLast = "none";       // 最近一次关心提醒：stretch / water / lunch / dinner / bedtime / none
  int32_t careLastAgoS = -1;           // 多少秒前（-1 = 没有）
  const char* careAwaiting = "";       // 刚提醒过、在等你回应的那种（没有 = 空）
  bool notifyEnabled = true;
  uint8_t noticeNew = 0, noticePending = 0;
  uint32_t noticeReceived = 0, noticeAcked = 0, noticeDropped = 0, noticeExpired = 0, noticeDuplicates = 0;
  const char* noticeKind = "";         // 最近一条：task_done / task_failed / reminder / praise（没有 = 空）
  const char* noticeState = "";        // new / shown / done
  const char* noticeTitle = "";
  const char* noticeSource = "";
  int32_t noticeAgoS = -1;
  // 2.9 活泼版：一起玩（字符串都指向固件里常驻的内存）
  const char* lively = "lively";       // quiet / normal / lively
  const char* playing = "none";        // none / rhythm / dance / breath / mood
  const char* groove = "idle";         // idle / listen / dance / pause / rest（听歌跳舞）
  bool musicEnabled = true, musicAvailable = false, musicNow = false, listening = false;
  float bpm = 0.f, beatConfidence = 0.f;
  int32_t musicAgoS = -1;              // 多少秒前听到过在放歌（-1 = 没有）
  uint32_t games = 0, gameWins = 0, dances = 0, musicDances = 0, breaths = 0, micro = 0;
  uint32_t bidsOffered = 0, bidsAccepted = 0, bidsIgnored = 0;
  uint16_t bidsToday = 0;
  float bidAcceptance = .5f;
  uint32_t peekRounds = 0, peekFound = 0;
  int8_t moodToday = -1;               // 今天的心情打卡 1–5（没打 / 不知道日期 = -1）
  uint8_t moodEntries = 0;             // 最近 7 天打了几次
  float moodAverage = 0.f;             // 最近 7 天平均（没有 = 0）
  int8_t moodTrend = 0;                // +1 变好 / -1 变差 / 0 差不多
  uint32_t moodTotal = 0;
  bool talkAuto = true;                // 对话自动结束
};
struct Hooks {
  bool (*wake)() = nullptr;
  void (*stop)() = nullptr;
  bool (*armed)() = nullptr;
  const char* (*renderedEmotion)() = nullptr;
  bool (*speakerActive)() = nullptr;
  TouchInfo (*touchInfo)() = nullptr;
  bool (*newChatPending)() = nullptr;
  const char* (*voiceNotice)() = nullptr;
  FaceTrackingInfo (*faceTracking)() = nullptr;
  CompanionInfo (*companionInfo)() = nullptr;
  // 2.8：POST /api/notify（主循环里调用）。kind = care::N_*，返回 care::P_*；truncated = 标题太长被截断了
  uint8_t (*notify)(uint8_t kind, const char* title, const char* source, const char* id, bool* truncated) = nullptr;
  bool (*notifyEnabled)() = nullptr;
};
bool begin(const Hooks& hooks);
void update();
// Main-loop stop/maintenance hook: close an image response and erase its copy.
void cancelCameraFrames();
void openSetup();
bool setupOpen();
const char* apName();
const char* apPassword();
const char* setupPin();
// Explicit USB-only provisioning. Never echo submitted credentials.
bool handleSerialJson(const char* json);
}
