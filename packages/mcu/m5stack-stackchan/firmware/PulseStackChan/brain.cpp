// 脉冲 Pulse · 性格（原创代码）· 2.8 陪伴版：只保留生活模式——会主动、会关心人、任务完成会提醒、会夸人
// 2.9 活泼版：小反应、主动邀请、躲猫猫、节奏游戏、连拍手势、听歌跳舞、一起深呼吸、每晚心情打卡
#include "brain.h"
#include <Arduino.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "config.h"
#include "head_touch.h"
#include "sensors.h"
#include "sfx.h"

namespace brain {

using namespace motion;

namespace {

pulse::Engine* E = nullptr;
Planner* P = nullptr;
bool s_booted = false;
bool s_conversationOwned = false, s_conversationDispatch = false;
uint32_t s_now = 0;
int8_t s_idx[42];   // 状态编号 → 表情引擎里的序号
int s_stateNum = 2;
bool s_facePresent = false;
float s_faceErrorX = 0.f, s_faceErrorY = 0.f;

inline float clampf(float v, float a, float b) { return v < a ? a : (v > b ? b : v); }
inline bool due(uint32_t t) { return (int32_t)(s_now - t) >= 0; }

// ============================== 脚本 ==============================
// 一段表演 / 反应 = 按时间排好的一串步骤（毫秒）。每帧把到时间的步骤执行掉。
enum Op : uint8_t { O_STATE, O_CLIP, O_ACT, O_LOOK, O_FREE, O_FX, O_KICK, O_SYN, O_LABEL, O_BREATH, O_IDLE,
                   O_BLINK, O_RAINBOW, O_AVERT, O_HEARTS, O_LED, O_CFX, O_NFX, O_TEXT, O_END };
struct Step { uint16_t t; uint8_t op; int16_t a, b, c; };
enum : uint8_t { SK_NONE = 0, SK_REACT, SK_BOOT, SK_CARE };  // SK_CARE：关心提醒 / 任务提醒 / 回应（摸它不会打断）
enum : int16_t { F_SND = 1, F_MOT = 2 };

#define ST_(t, n) {t, O_STATE, n, 0, 0}                  // 切换表情（不带默认声音和动作）
#define STF_(t, n, f) {t, O_STATE, n, f, 0}              // 切换表情（F_SND = 默认声音，F_MOT = 默认动作）
#define CL_(t, c) {t, O_CLIP, sfx::C_##c, 0, 0}         // 播放音效包里的声音
#define CLG_(t, c, g) {t, O_CLIP, sfx::C_##c, g, 0}     // 带音量（%）
#define CLR_(t, c, g, r) {t, O_CLIP, sfx::C_##c, g, r}  // 带音量（%）和速度（%）
#define AC_(t, a) {t, O_ACT, A_##a, 0, 0}                // 头部动作
#define ACS_(t, a, s) {t, O_ACT, A_##a, s, 0}            // 带幅度（%）
#define ACD_(t, a, s, d) {t, O_ACT, A_##a, s, d}         // 带幅度（%）和方向（-1 = 镜像）
#define LK_(t, p, q, s) {t, O_LOOK, p, q, s}             // 转头看（度）、速度（%）
#define FR_(t, ms) {t, O_FREE, ms, 0, 0}                 // 结束保持型动作，慢慢回正
#define FX_(t, k, n) {t, O_FX, pulse::FX_##k, n, 0}      // 飘出小图案
#define KI_(t, i) {t, O_KICK, pulse::I_##i, 0, 0}        // 表情的一次性动作（闪光、光环……）
#define SY_(t, s) {t, O_SYN, sfx::S_##s, 0, 0}           // 合成音
#define LB_(t, ms) {t, O_LABEL, 0, ms, 0}                // 2.8：顶部显示这条消息的标题（毫秒）
#define BR_(t, a10, per) {t, O_BREATH, a10, per, 0}      // 呼吸：幅度（0.1 度）、周期（毫秒）
#define ID_(t, on) {t, O_IDLE, on, 0, 0}                 // 自己东张西望：开 / 关
#define BL_(t, ms) {t, O_BLINK, ms, 0, 0}                // 2.7：眨一下眼（毫秒；500 以上 = 慢慢地眨，表示信任）
#define RB_(t, ms) {t, O_RAINBOW, ms, 0, 0}              // 2.7：机身彩虹灯（毫秒）
#define AV_(t, x, y, ms) {t, O_AVERT, x, y, ms}          // 2.7：眼神躲开（幅度 %，随机左右；y 正 = 往下）
#define HE_(t) {t, O_HEARTS, 0, 0, 0}                    // 2.7：冒爱心，个数 = 连续见面天数（1–5）
#define LD_(t, ms) {t, O_LED, ms, 0, 0}                  // 2.8：机身灯亮成这次提醒的颜色（毫秒）
#define CF_(t, n) {t, O_CFX, n, 0, 0}                    // 2.8：飘出这次关心提醒的小图案（小人 / 水滴 / 一碗饭 / 月亮）
#define NF_(t, n) {t, O_NFX, n, 0, 0}                    // 2.8：飘出这条消息的小图案（对勾 / ! / 铃铛 / 小红花）
#define TX_(t, id, ms) {t, O_TEXT, id, ms, 0}            // 2.9：顶部短暂显示一句提示（kTexts 里的第几句，毫秒）
#define EN_(t) {t, O_END, 0, 0, 0}


// ---- 开机 ----
const Step kBoot[] = {
  ST_(0, 5), CL_(0, EKKO_BOOT), ID_(0, 0), LK_(0, 0, -2, 50),
  CL_(1450, EKKO_EYES_OPEN),
  AC_(1700, BOOT),
  ST_(3300, 2),
  EN_(4000),
};

// ---- 醒来 ----
const Step kWake[] = {
  BR_(0, 0, 4200), FR_(0, 300), ST_(0, 1), CL_(0, HOME_WAKE), LK_(0, 0, -3, 70), AC_(100, WAKE),
  ST_(1500, 2),
  EN_(1800),
};
const Step kWakeNear[] = {  // 睡着时有人靠近：感应到 → 醒来 → 是你呀！
  CL_(0, HOME_DETECT), KI_(0, FLASH), LK_(0, 0, -4, 60),
  BR_(400, 0, 4200), FR_(400, 300), ST_(400, 1), CL_(400, HOME_WAKE), AC_(500, WAKE),
  ST_(1900, 10), CL_(1900, TRACK_ITS_YOU), AC_(1900, HEY),
  EN_(3300),
};
const Step kWakeJolt[] = {  // 睡着时被摇 / 被撞：吓醒
  BR_(0, 0, 4200), FR_(0, 200), ST_(0, 7), CL_(0, TRACK_SURPRISE), AC_(0, JOLT), FX_(0, EXCLAIM, 1),
  ST_(1600, 18), CL_(1600, HOME_SIGH), AC_(1600, MEH),
  EN_(3500),
};

// ---- 反应 ----
const Step kAngry[] = {  // 连着戳太多下
  ST_(0, 21), SY_(0, ANGRY), AC_(0, ANGRY), KI_(0, SHAKE),
  FR_(1700, 400), ST_(1800, 18), CL_(1800, HOME_SIGH), AC_(1800, MEH),
  EN_(3800),
};
const Step kDizzy[] = {  // 被摇晃
  ST_(0, 20), CL_(0, TRACK_DIZZY), AC_(0, DIZZY),
  ST_(2200, 18), CL_(2200, HOME_SIGH), AC_(2200, MEH),
  EN_(4200),
};
const Step kGreet[] = {  // 醒着时有人靠近
  CL_(0, HOME_DETECT), ST_(0, 3), AC_(0, HEY),
  ST_(800, 10), CL_(800, TRACK_ITS_YOU), AC_(800, HOP),
  EN_(2500),
};

// ============================== 2.7 情绪价值版 ==============================
// ---- 生活模式里被摸（本地触摸）：只换表情、眨眼、眼神，不动头（手还在头上 / 屏幕上）；
//      声音只在最开头、都短于 0.35 秒，不会挡住随后「摸太多」的语音 ----
const Step kTouchHappy[] = {ST_(0, 10), CLG_(0, EKKO_HAPPY, 70), ST_(1200, 19), EN_(2200)};
const Step kTouchShy[] = {  // 还不太熟：害羞，眼睛躲一下
  ST_(0, 14), CLG_(0, HOME_POP, 60), AV_(120, 75, 30, 900), ST_(1300, 19), EN_(2200)};
const Step kTouchLove[] = {  // 很熟了：眯起眼睛慢慢眨（猫咪式的「我信任你」）
  ST_(0, 19), CLG_(0, HOME_JOY, 60), BL_(250, 650), FX_(500, HEART, 1), EN_(2400)};
const Step kTouchComfort[] = {  // 正委屈 / 正想你：被摸一下就安心了
  ST_(0, 19), CLG_(0, HOME_SIGH, 80), BL_(300, 800), EN_(2400)};
const Step kTouchSleepy[] = {ST_(0, 15), BL_(100, 1000), ST_(1300, 19), EN_(2400)};
const Step kWakePet[] = {  // 睡着时被摸醒：慢慢睁眼、蹭一蹭（头只是慢慢抬起来）
  BR_(0, 0, 4200), FR_(0, 1400), ST_(0, 1), CLG_(0, EKKO_EYES_OPEN, 70), BL_(600, 700),
  ST_(1500, 19), FX_(1600, HEART, 1), EN_(2600)};
const Step kPerkUp[] = {  // 犯困时被摸：精神一下
  ST_(0, 2), CLG_(0, EKKO_EYES_OPEN, 70), BL_(150, 300), ST_(400, 10), EN_(1700)};
const Step kBoundary[] = {  // 摸太多：先「哼」地瞪一下（语音由导演层播），再傲娇地把眼睛别开
  ST_(0, 21), KI_(0, SHAKE), ST_(1100, 14), AV_(1100, 85, 20, 1500), ST_(2700, 18), EN_(3400)};

// ---- 打招呼（今天第一次见面）----
const Step kGreetMorning[] = {
  ST_(0, 1), SY_(0, MORNING), ACS_(0, STRETCH, 60), FX_(300, SPARK, 3),
  ST_(1300, 10), HE_(1300), AC_(1300, HEY), ST_(2800, 19), EN_(3600)};
const Step kGreetDay[] = {
  KI_(0, FLASH), ST_(0, 10), CL_(0, TRACK_ITS_YOU), AC_(0, HOP), HE_(200),
  ST_(1900, 19), BL_(2200, 600), EN_(3000)};
const Step kGreetEvening[] = {
  ST_(0, 19), CLG_(0, HOME_JOY, 80), ACS_(0, NOD_SLOW, 70), HE_(300), BL_(1600, 700), EN_(2800)};
const Step kGreetNight[] = {  // 夜里：小小声
  ST_(0, 14), SY_(0, LOVE), HE_(200), BL_(900, 800), EN_(2400)};

// ---- 久别重逢（看见你的脸）----
const Step kWelcomeShy[] = {  // 还不太熟：好奇地看看，害羞地躲一下，再开心
  ST_(0, 3), CLG_(0, HOME_HM, 70), ST_(600, 14), AV_(600, 80, 25, 900), ACS_(600, SHY, 50),
  FR_(1800, 600), ST_(1900, 10), CLG_(1900, EKKO_HAPPY, 70), EN_(3000)};
const Step kWelcome[] = {
  KI_(0, FLASH), ST_(0, 13), CLG_(0, HOME_DETECT, 80), ST_(500, 10), CL_(500, TRACK_ITS_YOU), AC_(500, HOP),
  FX_(600, HEART, 2), ST_(2300, 19), BL_(2500, 600), EN_(3400)};
const Step kWelcomeMiss[] = {  // 很熟、又很久没见：惊喜 → 扑过来 → 爱心 + 彩虹
  KI_(0, FLASH), ST_(0, 13), CL_(0, HOME_SURPRISE), AC_(0, SURPRISE),
  ST_(900, 10), SY_(900, LOVE), AC_(900, HOP), HE_(1000), RB_(900, 3000),
  ST_(2600, 19), ACS_(2600, NOD_SLOW, 70), BL_(3000, 700), EN_(4000)};
const Step kWelcomeNight[] = {ST_(0, 19), BL_(200, 800), FX_(400, HEART, 1), EN_(2200)};  // 夜里：不出声

// ---- 庆祝（等它空下来再演）----
const Step kLevelUp[] = {
  ST_(0, 33), SY_(0, LEVELUP), KI_(0, RING2), RB_(0, 3500), FX_(300, SPARK, 6),
  ST_(1400, 10), AC_(1400, HOP), FX_(1500, HEART, 3),
  ST_(3000, 19), ACS_(3000, NOD_SLOW, 70), EN_(4200)};
const Step kMilestone[] = {  // 认识 7 / 30 / 100 / 365 / 520 / 1000 天
  ST_(0, 13), KI_(0, FLASH),
  ST_(600, 33), SY_(600, LEVELUP), KI_(600, RING2), RB_(600, 5000), FX_(700, SPARK, 8),
  ST_(2000, 10), AC_(2000, PROUD), FX_(2100, HEART, 5),
  ST_(3600, 19), SY_(3600, LOVE), ACS_(3600, NOD_SLOW, 80), BL_(4200, 800), EN_(5200)};

// ---- 光线 / 电量 ----
const Step kLightsOff[] = {  // 咦，关灯了？
  ST_(0, 3), CLG_(0, HOME_HM, 60), LK_(0, 0, -8, 50), FX_(300, QUESTION, 1), ST_(1600, 2), EN_(2400)};
const Step kLightsOffNight[] = {  // 夜里关灯：打个哈欠，准备睡了
  ST_(0, 15), SY_(0, YAWN), ACS_(0, STRETCH, 40), BL_(1500, 900), EN_(2600)};
const Step kLightsOn[] = {
  KI_(0, FLASH), ST_(0, 13), CLG_(0, HOME_DETECT, 70), ST_(700, 10), CLG_(700, HOME_POP, 80), AC_(700, HEY), EN_(2400)};
const Step kWakeMorning[] = {  // 天亮了 / 早上开灯：伸个懒腰醒来
  BR_(0, 0, 4200), FR_(0, 300), ST_(0, 1), SY_(0, MORNING), AC_(100, WAKE),
  ST_(1600, 10), FX_(1600, SPARK, 3), ST_(2800, 2), EN_(3200)};
const Step kCharge[] = {ST_(0, 19), SY_(0, CHARGE), KI_(0, INRING), FX_(300, SPARK, 3), BL_(1200, 600), EN_(2400)};
const Step kLowBatt[] = {ST_(0, 15), CLG_(0, HOME_SIGH, 80), ACS_(0, SIGH, 60), EN_(2600)};
const Step kFull[] = {ST_(0, 10), SY_(0, DONE), FX_(100, SPARK, 4), AC_(0, NOD), EN_(2000)};

// ---- 看着你的时候偶尔：邀请你一起玩 ----
const Step kInvite[] = {ST_(0, 10), KI_(0, HOP), CLG_(0, HOME_HEY, 60), ACS_(0, GIGGLE, 50), FX_(150, NOTE, 1), ST_(1500, 2), EN_(2000)};

// ---- 没人理它的时候自己玩 ----
const Step kSpLook[] = {LK_(0, 0, -4, 80), ST_(0, 3), CLG_(0, HOME_HM, 70), AC_(150, LOOK_AROUND), EN_(3100)};
const Step kSpHum[] = {LK_(0, 0, -3, 80), ST_(0, 10), CLG_(0, TRACK_LALALA, 75), ACS_(0, DANCE, 80), FX_(100, NOTE, 3), FX_(1400, NOTE, 3), EN_(3100)};
const Step kSpThink[] = {LK_(0, 0, -3, 70), ST_(0, 30), CLG_(0, TRACK_HM, 70), AC_(0, THINK), FX_(700, QUESTION, 1), FR_(2800, 600), EN_(3400)};
const Step kSpGiggle[] = {LK_(0, 0, -4, 90), ST_(0, 14), CLG_(0, HOME_GIGGLE, 70), AC_(0, GIGGLE), EN_(1800)};
const Step kSpStretch[] = {LK_(0, 0, 0, 70), KI_(0, STRETCH), AC_(0, STRETCH), CLG_(1500, HOME_SIGH, 80), EN_(2500)};
const Step kSpDaze[] = {LK_(0, 0, -2, 50), STF_(0, 4, F_SND), AC_(0, DAZE), FR_(5500, 1000), EN_(6500)};
const Step kSpHappy[] = {LK_(0, 0, -4, 90), ST_(0, 10), CLG_(0, HOME_JOY, 70), AC_(0, HOP), EN_(1800)};
// 2.7：更多「自己的小生活」
const Step kSpYawn[] = {LK_(0, 0, -2, 60), ST_(0, 15), SY_(0, YAWN), ACS_(100, STRETCH, 50), BL_(1400, 600), EN_(2600)};
const Step kSpDoze[] = {  // 打瞌睡 → 头一点 → 惊醒
  LK_(0, 0, -2, 50), ST_(0, 15), ACS_(0, DROOP, 60), FX_(900, Z, 1),
  FR_(2600, 200), ST_(2600, 7), SY_(2600, JOLT), AC_(2650, JOLT), ST_(3600, 18), CLG_(3700, HOME_SIGH, 70), EN_(4800)};
const Step kSpMiss[] = {  // 想你了：左右找一找，没找到，有点失落
  ST_(0, 3), AC_(0, LOOK_AROUND), SY_(400, MISS), ST_(2200, 12), ACS_(2200, SAD, 50), FR_(3800, 800), EN_(4600)};
const Step kSpPeek[] = {ST_(0, 3), LK_(0, 26, -4, 60), LK_(1400, -22, -6, 70), LK_(2600, 0, -4, 60), EN_(3200)};  // 安安静静地偷看
const Step kSpSneeze[] = {
  ST_(0, 15), SY_(0, SNEEZE), ACS_(0, LOOK_UP, 35), FR_(700, 150),
  ST_(780, 13), KI_(780, JOLT), ACS_(780, NOD, 120), ST_(1600, 14), EN_(2800)};
const Step kSpStar[] = {ST_(0, 19), LK_(0, 0, -8, 40), FX_(200, SPARK, 4), SY_(200, SPARKLE), BL_(1500, 600), EN_(3000)};  // 看星星
const Step kSpHumSoft[] = {ST_(0, 19), SY_(0, HUM), FX_(200, NOTE, 2), ACS_(0, DANCE, 40), EN_(2400)};  // 小声哼歌
enum SpontKind : uint8_t {
  SP_LOOK, SP_HUM, SP_THINK, SP_GIGGLE, SP_STRETCH, SP_DAZE, SP_HAPPY,
  SP_YAWN, SP_DOZE, SP_MISS, SP_PEEK, SP_SNEEZE, SP_STAR, SP_HUMSOFT, SP_COUNT
};
const Step* const kSpont[SP_COUNT] = {kSpLook, kSpHum, kSpThink, kSpGiggle, kSpStretch, kSpDaze, kSpHappy,
                                      kSpYawn, kSpDoze, kSpMiss, kSpPeek, kSpSneeze, kSpStar, kSpHumSoft};
constexpr int kSpontN = SP_COUNT;
// 每种心情基调下，各种「自己玩」的权重（顺序同上）
const float kSpW[companion::T_COUNT][SP_COUNT] = {
  //  look  hum   think giggle stretch daze happy yawn  doze  miss  peek  sneeze star  humsoft
  {1.0f, .3f, 1.0f, .4f, .6f, 1.0f, .3f, .3f, .2f, .2f, 1.0f, .25f, .5f, .6f},   // 平静
  {.7f, 1.5f, .3f, 1.5f, .5f, .2f, 2.0f, .1f, .0f, .0f, .6f, .3f, 1.0f, 1.0f},   // 开心
  {.6f, .4f, .5f, .4f, .8f, 1.0f, .3f, .3f, .1f, .0f, .5f, .2f, 1.2f, 2.0f},     // 满足
  {1.0f, 1.5f, .3f, 2.0f, .5f, .1f, 1.5f, .1f, .0f, .0f, 1.5f, .4f, .6f, .6f},   // 想玩
  {2.0f, .1f, .5f, .1f, .3f, 1.0f, .0f, .3f, .2f, 3.0f, 1.5f, .1f, .4f, .3f},    // 想你了
  {.4f, .0f, .3f, .0f, 1.0f, 1.5f, .0f, 3.0f, 2.0f, .2f, .2f, .1f, .3f, .3f},    // 困了
  {.6f, .0f, .6f, .0f, .3f, 1.0f, .0f, .3f, .1f, .5f, .4f, .2f, .2f, .1f},       // 有点委屈
  {.8f, 2.0f, .3f, 1.5f, .4f, .0f, 2.0f, .0f, .0f, .0f, .8f, .3f, 1.5f, .8f},    // 兴奋
};
// 夜里会吵到人的那几个大幅降低（夜里自己玩本来就不出声）
const float kSpNight[SP_COUNT] = {1.f, .15f, 1.f, .15f, 1.f, 1.f, .15f, 1.f, 1.f, .6f, 1.f, .15f, 1.f, .6f};

// ============================== 2.8 陪伴版：会关心人 ==============================
// 提醒：先「嗯？」地看着你，飘出小图案，机身灯亮成这次提醒的颜色；摸摸它 = 「知道啦」
const Step kCareStretch[] = {  // 坐太久了：起来活动一下吧（举起双手伸懒腰）
  ST_(0, 3), SY_(0, STRETCH), LD_(0, 6000), CF_(150, 1), LK_(0, 0, -6, 90),
  KI_(600, STRETCH), ACS_(600, STRETCH, 90),
  ST_(2300, 10), CF_(2400, 1), ACS_(2400, HOP, 80),
  ST_(3800, 19), EN_(4800)};
const Step kCareWater[] = {  // 喝口水吧（水滴滴下来，仰头「咕嘟」）
  ST_(0, 3), SY_(0, WATER), LD_(0, 6000), CF_(100, 2), LK_(0, 0, -6, 90),
  ACS_(900, LOOK_UP, 50), ST_(1900, 10), ACS_(2000, NOD, 80), CF_(2100, 1),
  ST_(3400, 19), EN_(4400)};
const Step kCareMeal[] = {  // 该吃饭啦（肚子咕噜噜，冒出一碗饭）
  ST_(0, 13), SY_(0, TUMMY), LD_(0, 6000), ACS_(0, HM, 80), CF_(400, 1),
  ST_(1700, 10), ACS_(1800, HOP, 90), FX_(2000, HEART, 1),
  ST_(3300, 19), EN_(4400)};
const Step kCareBedtime[] = {  // 很晚啦，早点睡（打哈欠、月亮、慢慢眨眼）
  ST_(0, 15), SY_(0, YAWN), LD_(0, 8000), CF_(300, 1), ACS_(200, STRETCH, 40),
  BL_(1700, 900), FX_(2200, Z, 2), ST_(2800, 19), EN_(4200)};
const Step kCareNudge[] = {  // 没理它：轻轻地再提醒一次（只一次）
  ST_(0, 3), SY_(0, NUDGE), LD_(0, 5000), CF_(150, 1), ACS_(100, HM, 70), ST_(1600, 19), EN_(2600)};
// 摸摸它 = 知道啦：开心地点头
const Step kAckStretch[] = {ST_(0, 10), SY_(0, ACK), ACS_(0, NOD, 90), CF_(200, 1), FX_(600, HEART, 1), ST_(1600, 19), EN_(2600)};
const Step kAckWater[] = {ST_(0, 10), SY_(0, ACK), ACS_(0, LOOK_UP, 40), CF_(300, 1), ST_(1400, 19), FX_(1500, HEART, 1), EN_(2600)};
const Step kAckMeal[] = {ST_(0, 10), SY_(0, ACK), ACS_(0, HOP, 80), CF_(300, 1), FX_(700, HEART, 1), ST_(1600, 19), EN_(2600)};
const Step kAckBedtime[] = {  // 嗯嗯，晚安（你不看它了 / 关了灯，它就先睡）
  ST_(0, 19), SY_(0, ACK), CF_(200, 1), BL_(700, 900), FX_(1400, Z, 1), ST_(1800, 15), EN_(2800)};
// 提醒之后你真的去做了：回来夸你（小红花 + 彩虹）
const Step kPraiseStretch[] = {
  KI_(0, FLASH), ST_(0, 10), SY_(0, PRAISE), FX_(200, FLOWER, 2), RB_(0, 3000), AC_(300, HOP),
  ST_(1700, 19), CF_(1800, 1), ACS_(1800, NOD_SLOW, 70), BL_(2600, 700), EN_(3600)};
const Step kPraiseMeal[] = {
  KI_(0, FLASH), ST_(0, 10), SY_(0, PRAISE), FX_(200, FLOWER, 1), CF_(400, 1), RB_(0, 3000), AC_(300, HOP),
  ST_(1700, 19), FX_(1900, HEART, 2), BL_(2600, 700), EN_(3600)};
const Step kPraiseDay[] = {  // 今天陪了它很久：「辛苦啦」（每天一次）
  ST_(0, 19), SY_(0, LOVE), FX_(200, FLOWER, 1), ACS_(200, NOD_SLOW, 80), HE_(900), BL_(1800, 900),
  ST_(2600, 10), SY_(2600, PRAISE), RB_(2600, 2500), EN_(4400)};
const Step kGreetEarly[] = {  // 早起（07:30 以前第一次见面）：伸懒腰 + 小红花
  ST_(0, 1), SY_(0, MORNING), ACS_(0, STRETCH, 60), FX_(300, SPARK, 3),
  ST_(1300, 10), AC_(1300, HEY), FX_(1400, FLOWER, 1), HE_(1800), ST_(3000, 19), EN_(3800)};
const Step kGoodSleep[] = {  // 早早关灯睡觉（21:30–23:00，或提醒睡觉后 40 分钟内）：乖，月亮 + 小红花
  ST_(0, 19), SY_(0, LOVE), FX_(200, MOON, 1), FX_(700, FLOWER, 1), ACS_(300, NOD_SLOW, 60),
  BL_(1600, 1000), ST_(2600, 15), EN_(3400)};

// ============================== 2.8 陪伴版：任务提醒（Ekko Studio）==============================
const Step kNoticeCue[] = {  // 有消息、没看见你：叮咚，左右找你
  ST_(0, 3), SY_(0, DING), FX_(100, BELL, 1), LD_(0, 5000), KI_(0, RING), AC_(500, LOOK_AROUND), ST_(2600, 2), EN_(3200)};
const Step kNoticeCueSoft[] = {  // 第二、三次：小声一点
  ST_(0, 3), SY_(0, NUDGE), FX_(100, BELL, 1), LD_(0, 4000), ACS_(200, HM, 70), ST_(1600, 2), EN_(2400)};
const Step kTaskDone[] = {  // 任务完成：庆祝 + 夸你（对勾、彩虹、拍手、小红花）
  ST_(0, 33), SY_(0, CHEER), NF_(100, 1), KI_(0, RING2), RB_(0, 4000), LB_(300, 6000),
  ST_(1500, 10), AC_(1500, HOP), SY_(1800, CLAP), FX_(2000, FLOWER, 1),
  ST_(3000, 19), ACS_(3000, PROUD, 80), HE_(3300), EN_(5200)};
const Step kTaskFailed[] = {  // 没成功：不慌，抱抱你
  ST_(0, 12), SY_(0, OOPS), NF_(100, 1), LD_(0, 5000), LB_(300, 6000), ACS_(200, SIGH, 70),
  ST_(2000, 19), SY_(2200, LOVE), ACS_(2200, NOD_SLOW, 70), FX_(2600, HEART, 2), BL_(3300, 800), EN_(4800)};
const Step kNoticeRemind[] = {  // 提醒
  ST_(0, 13), SY_(0, DING), NF_(0, 1), LD_(0, 5000), LB_(200, 6000), AC_(300, HEY),
  ST_(1600, 3), SY_(1900, NUDGE), ACS_(1900, NOD, 80), EN_(3800)};
const Step kNoticePraise[] = {  // 夸夸你
  ST_(0, 10), SY_(0, PRAISE), NF_(100, 1), LB_(200, 6000), RB_(0, 3000), AC_(300, HOP),
  ST_(1800, 19), HE_(2000), BL_(2700, 700), EN_(3800)};
const Step kNoticeNudge[] = {  // 演过了还没摸它：轻轻提醒（最多两次）
  ST_(0, 3), SY_(0, NUDGE), NF_(100, 1), LB_(200, 4000), ACS_(100, HM, 70), ST_(1500, 2), EN_(2500)};
const Step kNoticeAckDone[] = {ST_(0, 10), SY_(0, ACK), ACS_(0, NOD, 90), FX_(300, HEART, 1), ST_(1300, 19), EN_(2300)};
const Step kNoticeAckFailed[] = {ST_(0, 19), SY_(0, LOVE), BL_(200, 800), FX_(400, HEART, 2), EN_(2500)};

// ============================== 2.9 活泼版：一起玩 ==============================
// 顶部提示（只在玩的时候短暂显示；efontCN_16 一行最宽 240 像素 = 15 个汉字）
enum : uint8_t { XT_PLAY, XT_FOUND, XT_GAME, XT_LISTEN, XT_BREATHE, XT_BREATH_DONE, XT_TIRED, XT_COUNT };
const char* const kTexts[XT_COUNT] = {"一起玩吗？拍拍我", "找到你啦！", "节奏游戏：我先拍，你跟着拍", "听听有没有在放歌…",
                                      "一起深呼吸～", "做得很好", "跳累啦，歇一会儿"};

// ---- 看着你的时候：时不时一个小反应（很短、几乎不出声；活跃度「安静」时不做，夜里不做）----
const Step kMicroTilt[] = {ST_(0, 3), ACS_(0, HM, 55), EN_(1700)};                        // 歪头看你
const Step kMicroSmile[] = {ST_(0, 10), KI_(0, HOP), CLG_(0, HOME_POP, 35), EN_(1400)};  // 笑一下
const Step kMicroWiggle[] = {ST_(0, 19), ACS_(0, GIGGLE, 40), EN_(1500)};                 // 扭一扭
const Step kMicroNod[] = {ST_(0, 19), ACS_(0, NOD, 60), BL_(500, 400), EN_(1500)};        // 点点头
const Step kMicroSpark[] = {ST_(0, 10), FX_(0, SPARK, 2), BL_(600, 300), EN_(1600)};      // 眼睛亮一下
const Step kMicroNote[] = {ST_(0, 19), FX_(0, NOTE, 1), ACS_(0, GIGGLE, 30), EN_(1400)};  // 心里哼了一句
const Step kMicroLove[] = {ST_(0, 19), BL_(100, 600), FX_(400, HEART, 1), EN_(1700)};     // 冒个小爱心
const Step kMicroPeek[] = {ST_(0, 14), AV_(0, 70, 20, 500), BL_(700, 300), EN_(1500)};    // 害羞地躲一下眼神
enum MicroKind : uint8_t { MI_TILT, MI_SMILE, MI_WIGGLE, MI_NOD, MI_SPARK, MI_NOTE, MI_LOVE, MI_PEEK, MI_COUNT };
const Step* const kMicro[MI_COUNT] = {kMicroTilt, kMicroSmile, kMicroWiggle, kMicroNod, kMicroSpark, kMicroNote, kMicroLove, kMicroPeek};
const float kMiW[companion::T_COUNT][MI_COUNT] = {
  // tilt smile wiggle nod  spark note  love  peek
  {1.2f, .6f, .4f, 1.0f, .8f, .4f, .5f, .5f},   // 平静
  {.6f, 1.5f, 1.0f, .8f, 1.0f, 1.0f, .8f, .2f}, // 开心
  {.6f, .8f, .4f, 1.2f, .6f, .6f, 1.2f, .3f},   // 满足
  {.8f, 1.2f, 1.5f, .5f, 1.0f, 1.5f, .4f, .4f}, // 想玩
  {.8f, .5f, .2f, .6f, .3f, .2f, 1.5f, .6f},    // 想你了
  {.3f, .1f, .0f, .6f, .1f, .0f, .6f, .2f},     // 困了
  {.5f, .1f, .0f, .3f, .1f, .0f, .4f, 1.2f},    // 有点委屈
  {.6f, 1.5f, 1.5f, .6f, 1.5f, 1.5f, .6f, .2f}, // 兴奋
};

// ---- 主动邀请：演完以后等你回应 8 秒（摸 / 点 / 按键 / 说话都算）----
const Step kBidPet[] = {  // 求摸摸：歪着头把头顶凑过来，「嗯～？」
  ST_(0, 14), SY_(0, PLEASE), ACS_(0, LOOK_UP, 55), FX_(400, HEART, 1), BL_(1500, 500), FR_(3000, 700), EN_(4000)};
const Step kBidHeart[] = {  // 比心：冒一串爱心，眯着眼看你
  ST_(0, 19), SY_(0, LOVE), FX_(150, HEART, 3), ACS_(0, NOD_SLOW, 60), BL_(1400, 600), FX_(2600, HEART, 1), EN_(3800)};
const Step kBidNuzzle[] = {  // 蹭蹭：左右轻轻蹭（想蹭你的手）
  ST_(0, 14), CLG_(0, HOME_GIGGLE, 50), ACS_(100, PET, 60), FR_(2600, 600), FX_(2700, HEART, 1), EN_(3800)};
const Step kBidPlay[] = {  // 一起玩：蹦一蹦、冒音符（拍拍它 = 一起玩节奏游戏）
  ST_(0, 10), SY_(0, PLEASE), KI_(0, HOP), ACS_(0, HOP, 80), FX_(200, NOTE, 2), TX_(300, XT_PLAY, 5000),
  ST_(1600, 3), FX_(2200, NOTE, 1), EN_(3600)};
const Step kBidShow[] = {  // 表演：「嘿！」→ 啦啦啦跳一段 → 得意地等你鼓掌
  ST_(0, 10), CLG_(0, HOME_HEY, 60), AC_(0, HEY), CLG_(800, TRACK_LALALA, 70), ACS_(800, DANCE, 90), FX_(900, NOTE, 3),
  FX_(2200, NOTE, 2), ST_(3600, 19), ACS_(3600, PROUD, 70), FX_(3700, SPARK, 3), EN_(5200)};
// 你回应了（手可能还在它身上：只换表情、不动头）
const Step kBidPetYes[] = {ST_(0, 19), SY_(0, PURR), BL_(200, 900), FX_(500, HEART, 2), EN_(3000)};
const Step kBidHeartYes[] = {ST_(0, 19), SY_(0, LOVE), FX_(0, HEART, 4), RB_(0, 2000), BL_(900, 700), EN_(2600)};
const Step kBidNuzzleYes[] = {ST_(0, 19), SY_(0, PURR), BL_(300, 900), FX_(500, HEART, 2), EN_(3000)};
const Step kBidShowYes[] = {
  KI_(0, FLASH), ST_(0, 10), CLG_(0, HOME_TADA, 70), FX_(200, FLOWER, 1), FX_(500, SPARK, 3), BL_(1300, 500), ST_(1800, 19), EN_(2600)};

// ---- 躲猫猫：你躲开 → 东找西找 → 你回来 → 找到你啦！----
const Step kPeekSearch[] = {
  ST_(0, 3), CLG_(0, HOME_HM, 55), LK_(0, 26, -4, 80), FX_(500, QUESTION, 1), LK_(1500, -26, -4, 80),
  LK_(2700, 14, -10, 70), LK_(3900, -14, 0, 70), LK_(5100, 0, -4, 60), EN_(6300)};
const Step kPeekFound[] = {
  KI_(0, FLASH), ST_(0, 13), CL_(0, TRACK_FACE_FOUND), TX_(200, XT_FOUND, 2000), ST_(500, 10), AC_(500, HOP),
  FX_(600, SPARK, 3), FX_(900, HEART, 1), ST_(2000, 19), EN_(2600)};
const Step kPeekFoundMore[] = {  // 接着玩（连着第 3 次以上）：笑出声 + 彩虹
  KI_(0, FLASH), ST_(0, 10), CLG_(0, TRACK_GIGGLE, 80), AC_(0, GIGGLE), RB_(0, 2500), TX_(200, XT_FOUND, 2000),
  FX_(300, HEART, 2), FX_(600, SPARK, 3), ST_(2100, 19), EN_(2700)};
const Step kPeekGiveUp[] = {ST_(0, 12), ACS_(0, SAD, 40), FR_(1600, 600), ST_(2000, 18), EN_(2600)};  // 找不到：有点失落（不出声）

// ---- 节奏游戏：它先敲一段（「嘟」+ 点头 + 音符），你照着拍（拍头或点屏幕）----
const Step kGameIntro[] = {ST_(0, 16), CLG_(0, HOME_HEY, 60), FX_(100, NOTE, 2), TX_(0, XT_GAME, 2400), EN_(1300)};
const Step kGamePerfect[] = {KI_(0, FLASH), ST_(0, 10), SY_(0, SPARKLE), FX_(0, SPARK, 4), FX_(300, NOTE, 2), ST_(1400, 19), EN_(2000)};
const Step kGameGood[] = {ST_(0, 10), SY_(0, ACK), ACS_(0, NOD, 70), FX_(300, NOTE, 1), ST_(1300, 19), EN_(1900)};
const Step kGameMiss[] = {ST_(0, 11), SY_(0, OOPS), ACS_(0, HM, 60), FX_(300, QUESTION, 1), EN_(1900)};
const Step kGameTimeout[] = {ST_(0, 11), CLG_(0, HOME_HM, 60), ACS_(0, HM, 50), EN_(1700)};
const Step kGameWin[] = {  // 五关全过
  KI_(0, FLASH), ST_(0, 33), SY_(0, LEVELUP), KI_(0, RING2), RB_(0, 3500), FX_(200, SPARK, 6),
  ST_(1400, 10), AC_(1400, HOP), FX_(1500, HEART, 3), ST_(3000, 19), EN_(3800)};
const Step kGameEnd[] = {ST_(0, 10), SY_(0, PRAISE), FX_(200, FLOWER, 1), ACS_(300, NOD_SLOW, 70), ST_(1800, 19), EN_(2800)};
const Step kGameEndSoft[] = {ST_(0, 19), SY_(0, LOVE), BL_(400, 700), FX_(600, HEART, 1), EN_(2400)};

// ---- 跳舞 ----
const Step kDanceSolo[] = {  // 没在放歌：自己「啦啦啦」跳一段
  ST_(0, 10), CL_(0, TRACK_LALALA), ACS_(0, DANCE, 100), FX_(100, NOTE, 3), FX_(1300, NOTE, 2),
  CLG_(2800, TRACK_LALALA, 90), ACD_(2800, DANCE, 100, -1), FX_(2900, NOTE, 3), FX_(4100, NOTE, 2),
  ST_(5600, 19), ACS_(5600, PROUD, 80), FX_(5700, SPARK, 4), EN_(7000)};
const Step kDanceEnd[] = {ST_(0, 19), ACS_(0, NOD_SLOW, 70), FX_(200, SPARK, 2), BL_(900, 600), EN_(2000)};  // 歌停了：鞠个躬
const Step kDanceTired[] = {  // 跳了 3 分钟：歇一会儿（这 3 分钟不听歌）
  ST_(0, 15), ACS_(0, SIGH, 50), TX_(200, XT_TIRED, 2600), FX_(600, HEART, 1), ST_(1800, 19), EN_(2800)};

// ---- 一起深呼吸（吸 4 秒、呼 6 秒；身体跟着变大变亮，机身灯青色）----
const Step kBreathIntro[] = {ST_(0, 19), BL_(200, 900), TX_(0, XT_BREATHE, 1600), EN_(1500)};
const Step kBreathDone[] = {
  ST_(0, 19), SY_(0, LOVE), FX_(300, FLOWER, 1), FX_(700, HEART, 1), BL_(1000, 900), TX_(0, XT_BREATH_DONE, 2600), EN_(3000)};

// ---- 每晚心情打卡（回答之后不动头：手可能还在头上）----
const Step kMoodAsk[] = {ST_(0, 3), SY_(0, NUDGE), ACS_(0, HM, 60), FX_(300, QUESTION, 1), BL_(1200, 400), EN_(2000)};
const Step kMood5[] = {KI_(0, FLASH), ST_(0, 10), SY_(0, CHEER), FX_(100, SPARK, 4), RB_(0, 2500), FX_(500, HEART, 2), ST_(2000, 19), EN_(3200)};
const Step kMood4[] = {ST_(0, 10), SY_(0, PRAISE), FX_(200, HEART, 2), BL_(1200, 500), ST_(1800, 19), EN_(2800)};
const Step kMood3[] = {ST_(0, 19), CLG_(0, HOME_JOY, 60), FX_(400, HEART, 1), BL_(1000, 600), EN_(2600)};
const Step kMood2[] = {ST_(0, 12), SY_(0, LOVE), BL_(600, 900), ST_(1300, 19), FX_(1400, HEART, 2), EN_(3200)};
const Step kMood1[] = {ST_(0, 12), SY_(0, LOVE), BL_(900, 1000), ST_(1700, 19), FX_(1800, HEART, 3), EN_(3800)};
const Step kMoodWeek[] = {ST_(0, 19), FX_(0, SPARK, 2), BL_(1500, 600), EN_(3800)};  // 每周小结（文字由代码显示）
const Step kMoodCare[] = {ST_(0, 19), BL_(300, 1000), FX_(800, HEART, 1), EN_(4600)};  // 连着几天心情都不好

const Step* s_scr = nullptr;
int s_si = 0;
uint32_t s_st0 = 0;
uint8_t s_kind = SK_NONE;

// ============================== 状态 ==============================
enum Phase : uint8_t { PH_AWAKE, PH_TIRED, PH_SLEEP };
enum Wake : uint8_t { W_TOUCH, W_NEAR, W_JOLT };
Phase s_phase = PH_AWAKE;
uint32_t s_lastActive = 0, s_lastUser = 0, s_nextSpont = 0, s_settleAt = 0, s_nextSnore = 0;
uint32_t s_lastTap = 0, s_lastStroke = 0, s_lastGreet = 0, s_sensQuiet = 0;
int s_tapCount = 0, s_snores = 0, s_petCount = 0, s_lastSpont = -1;

// ============================== 2.7 陪伴 ==============================
companion::Affect s_aff;
companion::Bond s_bond;
companion::World s_world;
bool s_affStarted = false;
uint32_t s_affAt = 0, s_minuteAt = 0;
bool s_scriptMuted = false;        // 这段脚本不出声（夜里）
// 生活模式本地触摸
bool s_touchDown = false;
uint32_t s_touchLast = 0, s_touchSessionAt = 0, s_touchMarkAt = 0, s_lastTapAt = 0;
uint8_t s_touchStrokes = 0, s_touchTaps = 0, s_touchPets = 0;
bool s_touchSession = false, s_touchBoundary = false;
// 眼神躲开
uint32_t s_avertUntil = 0;
float s_avertX = 0.f, s_avertY = 0.f;
// 看见脸
uint32_t s_faceSince = 0, s_faceLastSeen = 0, s_faceAbsentFrom = 0, s_lastWelcome = 0;
uint32_t s_nextGaze = 0, s_nextFaceHeart = 0, s_nextInvite = 0;
bool s_faceArrival = false, s_faceEverSeen = false;
// 等空下来再演（庆祝 / 打招呼 / 重逢 / 电量）
bool s_pendLevel = false, s_pendGreet = false, s_pendWelcome = false;
bool s_pendCharge = false, s_pendFull = false, s_pendLow = false;
int8_t s_pendMilestone = -1;
uint32_t s_pendWelcomeAbsence = 0, s_pendAt = 0;
// 机身灯
uint32_t s_rainbowUntil = 0;
// 电量 / 夜里
bool s_worldInit = false, s_chargeWas = false, s_lowArmed = true, s_fullArmed = true;
bool s_sleepSoon = false;
uint32_t s_goodnightKey = 0;       // 哪一夜已经唱过晚安曲

// ============================== 2.8 陪伴版 ==============================
care::Planner s_care;              // 会关心人：起来活动 / 喝水 / 吃饭 / 早点睡 / 夸你
care::Inbox s_inbox;               // 任务提醒收件箱（Ekko Studio → /api/notify）
bool s_notifyOn = true;
bool s_careTicked = false;
uint32_t s_careAt = 0;
// 「你在不在」的迹象（脸和触摸在上面）
bool s_touchEver = false, s_chatEver = false, s_nearEver = false;
uint32_t s_chatLast = 0, s_nearLast = 0;
bool s_noticeValid = false;        // 刚演过任务提醒：2 分钟内不插关心提醒
uint32_t s_noticeAt = 0;
uint8_t s_careKind = care::K_NONE; // 正在演的关心提醒（小图案 / 灯的颜色）
uint8_t s_noteKind = care::N_DONE; // 正在演的消息
uint32_t s_ledColor = 0, s_ledUntil = 0, s_ledShow = 0;
uint32_t s_nextBell = 0;
uint32_t s_goodSleepKey = 0;       // 哪一夜已经夸过「早早睡觉」
char s_label[64] = {0};            // 顶部标题（LB_）
uint32_t s_labelOff = 0;
bool s_careShow = false;           // 正在演的是任务完成 / 没成功 / 提醒 / 夸夸本身（摸它不打断）

// ============================== 2.9 活泼版 ==============================
enum PlayMode : uint8_t { PM_NONE, PM_RHYTHM, PM_DANCE, PM_BREATH, PM_MOOD };
enum Groove : uint8_t { G_IDLE, G_LISTEN, G_DANCE, G_PAUSE, G_REST };
enum DanceEnd : uint8_t { DE_STOPPED, DE_TIRED, DE_ABORT };
uint8_t s_level = play::LV_LIVELY;
uint8_t s_mode = PM_NONE;          // 正在玩的（玩的时候不自己玩、不插关心提醒）
play::Bids s_bids;
play::Peekaboo s_peek;
play::Rhythm s_rhythm;
play::TapSeq s_tapSeq;
bool s_tapBad = false;             // 这一组连拍里有叫醒它的那一下：整组不算
play::MoodLog s_mood;
play::CheckIn s_checkIn;
bool s_bidTicked = false;
uint32_t s_bidAt = 0, s_nextMicro = 0;
uint32_t s_faceSession = 0;        // 这一次你在跟前从什么时候开始（离开不到 1 分钟不算走）：在跟前久了小反应慢慢变少
int s_lastMicro = -1;
bool s_showEver = false;           // 最近一次「演给你看 / 一起玩」（主动邀请之间要隔开）
uint32_t s_showLast = 0;
// 按住头顶 → 深呼吸
bool s_headDown = false, s_headMoved = false, s_headUsed = false;
uint32_t s_headSince = 0;
// 节奏游戏
bool s_gameArmed = false, s_gameEver = false;
uint32_t s_gameAt = 0, s_gameEnd = 0;
// 深呼吸
uint8_t s_breathN = 0;
int s_breathCur = -1;
bool s_breathInhale = false;
uint32_t s_breathT0 = 0;
float s_breathLevel = 0.f, s_guideA = 0.f;
// 心情打卡
enum MoodStep : uint8_t { MS_ASK, MS_REPLY, MS_WEEK, MS_LOW, MS_DONE };
uint8_t s_moodStep = MS_DONE, s_moodTaps = 0;
uint32_t s_moodUntil = 0, s_moodTapAt = 0, s_moodHintAt = 0;
// 听歌跳舞
bool s_musicOn = true, s_musicAvail = false, s_listenUser = false, s_musicSeen = false;
uint8_t s_groove = G_IDLE;
uint32_t s_grooveUntil = 0, s_nextListen = 0, s_danceFrom = 0, s_musicAt = 0;
beat::Estimate s_est, s_musicEst;   // 正在跟着跳的节拍 / 最近一次「有音乐」的结果
beat::Estimate s_lastEst;           // 最近一次收到的分析结果（状态接口用）
int32_t s_beatIdx = 0;
uint16_t s_segBeats = 0;
uint8_t s_tiredN = 0;              // 连着跳累了几次（一直放歌：歇 3 → 6 → 12 分钟，别跳个没完）
uint32_t s_tiredAt = 0;
PlayStats s_stats;
char s_text[64] = {0};

inline uint8_t bondLevel() { return s_bond.level(); }
inline uint8_t tone() { return s_aff.tone; }
inline bool nightNow() { return s_world.night; }
void stim(uint8_t st, float k = 1.f) { companion::stimulus(s_aff, st, k); }

// 亲密度「每天递减」用的日期：有真实日期用真实日期；没对过时，按陪伴时长每 16 小时算一天
uint32_t bondDay() {
  if (s_world.clock.valid) return s_world.clock.day;
  return 0x40000000u + s_bond.data().minutes / (16u * 60u);
}

void bondEvent(uint8_t ev) {
  if (!s_bond.add(ev, bondDay())) return;
  s_pendLevel = true;
  Serial.printf("[bond] 亲密度升级！Lv%d「%s」（%u 点）\n", s_bond.level() + 1, companion::levelName(s_bond.level()),
                (unsigned)s_bond.points());
}

// 今天第一次互动：记一天、连续天数、纪念日。perform = 等空下来演一段打招呼
void visitToday(bool perform) {
  if (!s_world.clock.valid) return;
  const uint8_t f = s_bond.visit(s_world.clock.day);
  if (!(f & companion::DF_NEW_DAY)) return;
  bondEvent(companion::B_DAILY);
  const uint16_t streak = s_bond.data().streak;
  if ((f & companion::DF_STREAK) && streak % 7 == 0) bondEvent(companion::B_DAILY);  // 连续一整周：额外奖励
  if (f & companion::DF_MILESTONE) s_pendMilestone = s_bond.lastMilestone();
  if (perform) s_pendGreet = true;
  Serial.printf("[bond] 新的一天：认识第 %u 天，连续 %u 天%s\n", (unsigned)s_bond.daysKnown(s_world.clock.day), (unsigned)streak,
                (f & companion::DF_MILESTONE) ? "（纪念日！）" : "");
}

int heartsForStreak() {
  const int st = s_bond.data().streak;
  return st < 1 ? 1 : (st > 5 ? 5 : st);
}

void avert(float mag, float y, uint32_t ms) {
  s_avertX = (random(2) ? 1.f : -1.f) * clampf(mag, 0.f, 1.2f);
  s_avertY = clampf(y, -1.f, 1.f);
  s_avertUntil = s_now + ms;
  if (!s_avertUntil) s_avertUntil = 1;
}

void scriptDone(uint8_t kind);
// 2.9（定义在后面）
void stopPlay(const char* why);
void danceEnd(uint8_t why);

inline float rnd01() { return (float)random(10000) / 10000.f; }

// 2.9：顶部短暂显示一句提示（游戏 / 深呼吸 / 心情打卡）。平时脸上不显示文字，演完就关掉
void showText(const char* t, uint32_t ms) {
#if PULSE_PLAY_TEXT
  if (!E || !t || !*t) return;
  E->setLabelsEnabled(true);
  E->setLabel(t, ms);
  s_labelOff = s_now + ms + 200;
  if (!s_labelOff) s_labelOff = 1;
#else
  (void)t;
  (void)ms;
#endif
}
void hideText() {
  if (!s_labelOff) return;
  s_labelOff = 0;
  if (E) E->setLabelsEnabled(false);
}

// 2.8：每种提醒的小图案和机身灯颜色
uint8_t careIcon(uint8_t k) {
  switch (k) {
    case care::K_STRETCH: return pulse::FX_PERSON;
    case care::K_WATER: return pulse::FX_DROP;
    case care::K_LUNCH:
    case care::K_DINNER: return pulse::FX_BOWL;
    case care::K_BEDTIME: return pulse::FX_MOON;
    default: return pulse::FX_HEART;
  }
}
uint8_t noticeIcon(uint8_t k) {
  switch (k) {
    case care::N_DONE: return pulse::FX_CHECK;
    case care::N_FAILED: return pulse::FX_EXCLAIM;
    case care::N_REMIND: return pulse::FX_BELL;
    default: return pulse::FX_FLOWER;
  }
}
uint32_t careColor(uint8_t k) {
  switch (k) {
    case care::K_STRETCH: return 0x40E070;  // 绿：动一动
    case care::K_WATER: return 0x30A8FF;    // 蓝：喝水
    case care::K_LUNCH:
    case care::K_DINNER: return 0xFF9A30;   // 橙：吃饭
    case care::K_BEDTIME: return 0x7A5CFF;  // 紫：睡觉
    default: return 0xFF70B0;               // 粉：夸你
  }
}
uint32_t noticeColor(uint8_t k) {
  switch (k) {
    case care::N_DONE: return 0x50F090;
    case care::N_FAILED: return 0xFF6A50;
    case care::N_REMIND: return 0xFFB020;
    default: return 0xFF60B0;
  }
}
constexpr uint32_t kNoticeAmber = 0xFFA020;  // 有新消息还没看：琥珀色慢慢呼吸

void playAct(uint8_t a, float scale = 1.f, float dir = 1.f) {
  if (a == A_NONE) return;
  P->play(a, scale, dir);
  // 自己动得猛的时候，机身里的姿态传感器也会感觉到：这段时间不把它当成「被摇晃」
  s_sensQuiet = s_now + (uint32_t)(actDuration(a) * 1000.f) + 700;
}

void exec(const Step& st) {
  switch (st.op) {
    case O_STATE: goState(st.a, (st.b & F_SND) != 0 && !s_scriptMuted, (st.b & F_MOT) != 0, false); break;
    case O_CLIP:
      if (!s_scriptMuted) sfx::play((uint8_t)st.a, st.b ? st.b * .01f : 1.f, st.c ? st.c * .01f : 1.f, false);
      break;
    case O_ACT: playAct((uint8_t)st.a, st.b ? st.b * .01f : 1.f, st.c < 0 ? -1.f : 1.f); break;
    case O_LOOK: P->lookAt(st.a, st.b, st.c ? st.c * .01f : 1.f); break;
    case O_FREE: P->release(st.a ? st.a * .001f : .6f); break;
    case O_FX: E->emit((uint8_t)st.a, st.b ? st.b : 1); break;
    case O_KICK: E->kick((uint8_t)st.a); break;
    case O_SYN: if (!s_scriptMuted) sfx::synth((uint8_t)st.a, false); break;
    case O_LABEL:  // 2.8：这条消息的标题（平时表情上不显示文字，只在这里短暂打开）
#if PULSE_NOTICE_TITLE
      if (s_label[0]) {
        E->setLabelsEnabled(true);
        E->setLabel(s_label, (uint32_t)st.b);
        s_labelOff = s_now + (uint32_t)st.b + 200;
        if (!s_labelOff) s_labelOff = 1;
      }
#endif
      break;
    case O_BREATH: P->setBreath(st.a * .1f, st.b * .001f); break;
    case O_IDLE: P->setIdle(st.a != 0, 1.f); break;
    case O_BLINK: E->blink(st.a * .001f); break;
    case O_RAINBOW: s_rainbowUntil = s_now + (uint32_t)st.a; if (!s_rainbowUntil) s_rainbowUntil = 1; break;
    case O_AVERT: avert(st.a * .01f, st.b * .01f, (uint32_t)st.c); break;
    case O_HEARTS: E->emit(pulse::FX_HEART, heartsForStreak()); break;
    case O_LED: s_ledUntil = s_now + (uint32_t)st.a; if (!s_ledUntil) s_ledUntil = 1; break;
    case O_CFX: E->emit(careIcon(s_careKind), st.a ? st.a : 1); break;
    case O_NFX: E->emit(noticeIcon(s_noteKind), st.a ? st.a : 1); break;
    case O_TEXT: if (st.a >= 0 && st.a < XT_COUNT) showText(kTexts[st.a], (uint32_t)st.b); break;
    default: break;
  }
}

void tickScript() {
  while (s_scr) {
    const Step& st = s_scr[s_si];
    if ((int32_t)(s_now - s_st0) < (int32_t)st.t) break;
    s_si++;
    if (st.op == O_END) {
      const uint8_t k = s_kind;
      s_scr = nullptr;
      s_kind = SK_NONE;
      scriptDone(k);
      break;
    }
    exec(st);
  }
}

// 有反应的时候：先不东张西望，转过来看着你
void engage(float speed = 1.2f) {
  P->setIdle(false);
  P->lookAt(0, -4, speed);
}

void runScript(const Step* s, uint8_t kind, bool muted = false) {
  if (kind == SK_BOOT) {
    s_facePresent = false;
    P->setFaceLook(false);
  }
  s_scr = s;
  s_si = 0;
  s_st0 = s_now;
  s_kind = kind;
  s_settleAt = 0;
  s_scriptMuted = muted;
  s_careShow = false;
  P->setIdle(false);
  if (kind == SK_REACT || kind == SK_CARE) P->lookAt(0, -4, 1.2f);  // 脚本里有 LK_ 的会马上改掉
  tickScript();
}

void abortScript() {
  s_scr = nullptr;
  s_kind = SK_NONE;
  s_careShow = false;
}

// 回到平常的样子（待机放空 + 自己东张西望）
void settle() {
  s_settleAt = 0;
  if (s_stateNum != 2) goState(2, false, false);
  P->release(.8f);
  P->setBreath(0, 4);
  if (!s_facePresent) P->lookAt(0, -3, .6f);
  P->setIdle(!s_facePresent, 1.f);
}

void scriptDone(uint8_t kind) {
  if (kind == SK_BOOT) {
    s_lastActive = s_now;
    s_nextSpont = s_now + 20000 + random(20000);
    settle();
    if (bondLevel() >= 2) {  // 2.7：已经是小伙伴了：一睁眼先冒个爱心、慢慢眨一下
      E->emit(pulse::FX_HEART, bondLevel() >= 6 ? 2 : 1);
      E->blink(.6f);
    }
    return;
  }
  if (kind == SK_CARE) s_lastActive = s_now;  // 刚提醒完 / 刚庆祝完：不会马上犯困
  if (s_mode != PM_NONE) return;  // 2.9：游戏 / 打卡 / 深呼吸中间的小反应：接下来由它们安排，先别回到待机
  settle();
}

// ---- 生活模式：犯困、睡觉、自己玩 ----
void getTired() {
  s_phase = PH_TIRED;
  goState(15, !nightNow(), true);  // 疲惫 + 叹气 + 一点一点往下栽（夜里不出声）
  P->setIdle(true, .4f);
  Serial.println("[life] 没人理，有点困了");
}

// 这一夜的编号：22 点到第二天中午算同一夜（没对时：按开机时间每 12 小时一段）
uint32_t nightKey() {
  if (s_world.clock.valid) return s_world.clock.hour < 12 ? s_world.clock.day - 1 : s_world.clock.day;
  return 0x40000000u + s_now / (12u * 3600000u);
}

void fallAsleep(bool forceLullaby = false) {
  stopPlay("睡着了");
  abortScript();
  s_settleAt = 0;
  s_phase = PH_SLEEP;
  s_sleepSoon = false;
  stim(companion::ST_SLEEP);
  // 2.7：每晚第一次睡着时，小声唱一段晚安曲（只在前半夜 18:00–03:00；天快亮时睡回笼觉就安安静静的）
  const uint32_t key = nightKey();
  const bool evening = !s_world.clock.valid || s_world.clock.hour >= 18 || s_world.clock.hour < 3;
  const bool lullaby = forceLullaby || (nightNow() && evening && key != s_goodnightKey);
  if (lullaby) s_goodnightKey = key;
  goState(0, !lullaby, true);   // 睡眠 + 冒 z + 慢慢低头
  if (lullaby) sfx::synth(sfx::S_GOODNIGHT);
  P->setIdle(false);
  P->lookAt(0, 0, .4f);
  P->setBreath(1.5f, 4.2f);
  E->emit(pulse::FX_Z, 3);
  s_snores = 0;
  s_nextSnore = s_now + 9000;
  Serial.println("[life] 睡着了（摸一下 / 靠近 / 摇一摇就会醒）");
}

void snore() {
  E->emit(pulse::FX_Z, 3);
  // 打呼打一会儿就安静下来；夜里更少、更轻
  const int maxSnores = nightNow() ? 3 : 8;
  if (s_snores < maxSnores) sfx::play(s_snores & 1 ? sfx::C_TRACK_SNORE : sfx::C_HOME_SLEEP_Z, nightNow() ? .5f : .8f);
  s_snores++;
}

// 2.7：按心情挑「自己玩」什么（开心时爱哼歌、想你时到处找你、困了打哈欠……）；夜里不出声
void spontaneous() {
  float w[SP_COUNT];
  const uint8_t t = tone() < companion::T_COUNT ? tone() : 0;
  for (int i = 0; i < SP_COUNT; i++) w[i] = kSpW[t][i] * (nightNow() ? kSpNight[i] : 1.f);
  const float tired = 1.f - s_aff.energy;
  w[SP_YAWN] += tired * 1.5f;
  w[SP_DOZE] += tired * 1.0f;
  if (s_aff.social > .6f) w[SP_MISS] += (s_aff.social - .6f) * 4.f;
  if (s_lastSpont >= 0 && s_lastSpont < SP_COUNT) w[s_lastSpont] *= .1f;  // 别连着两次一样
  int k = companion::pickWeighted(w, SP_COUNT, (float)random(10000) / 10000.f);
  if (k < 0 || k >= kSpontN) k = SP_LOOK;
  s_lastSpont = k;
  runScript(kSpont[k], SK_REACT, nightNow());
}

uint32_t spontGap() {
  // 2.9：活跃度越高，没人理时自己玩得越勤（安静 = 和 2.8 一样）
  const float k = (1.3f - .6f * s_aff.arousal) * (nightNow() ? 1.7f : 1.f) * play::spontScale(s_level);
  return (uint32_t)((25000.f + (float)random(35000)) * k);
}

// 睡着 / 犯困时先醒过来（这一下触摸就只用来叫醒它）
bool wakeIfNeeded(uint8_t cause) {
  s_lastActive = s_now;
  s_nextSpont = s_now + 25000 + random(30000);
  if (s_phase == PH_AWAKE) return false;
  const bool wasSleep = s_phase == PH_SLEEP;
  s_phase = PH_AWAKE;
  s_sleepSoon = false;
  stim(companion::ST_WAKE);
  P->setBreath(0, 4);
  abortScript();
  if (!wasSleep) {  // 只是犯困：精神一下
    engage();
    goState(2, false, false);
    sfx::play(sfx::C_EKKO_EYES_OPEN);
    playAct(A_HEY, .8f);
    s_settleAt = s_now + 1200;
    return true;
  }
  runScript(cause == W_JOLT ? kWakeJolt : (cause == W_NEAR ? kWakeNear : kWake), SK_REACT);
  Serial.println("[life] 醒了");
  return true;
}

void tapReact(float side) {  // side：+1 = 点在右半边
  abortScript();
  engage();
  if (s_now - s_lastTap > 1600) s_tapCount = 0;
  s_lastTap = s_now;
  s_tapCount++;
  switch (s_tapCount) {
    case 1:  // 戳一下：光环 +「啵」+ 往另一边躲一下
      E->pulse();
      sfx::onTap();
      playAct(A_FLINCH, 1.f, -side);
      s_settleAt = s_now + 1200;
      break;
    case 2:  // 开心
      goState(10, false, false);
      sfx::play(sfx::C_EKKO_HAPPY);
      playAct(A_HOP);
      s_settleAt = s_now + 1800;
      break;
    case 3:  // 害羞地笑
      goState(14, false, false);
      sfx::play(sfx::C_TRACK_GIGGLE);
      playAct(A_GIGGLE);
      s_settleAt = s_now + 2000;
      break;
    case 4:  // 嗯？
      goState(11, false, false);
      sfx::play(sfx::C_TRACK_HM);
      playAct(A_HM, 1.f, side);
      E->emit(pulse::FX_QUESTION);
      s_settleAt = s_now + 2300;
      break;
    case 5:  // ！
      goState(13, false, false);
      sfx::play(sfx::C_HOME_SURPRISE);
      playAct(A_SURPRISE);
      E->emit(pulse::FX_EXCLAIM);
      s_settleAt = s_now + 2000;
      break;
    default:  // 生气了，然后无奈
      s_tapCount = 0;
      runScript(kAngry, SK_REACT);
      break;
  }
}

void petReact(float dir) {
  s_petCount++;
  abortScript();
  engage();
  s_settleAt = 0;
  goState(s_petCount & 1 ? 14 : 19, false, false);
  if (P->current() != A_PET) playAct(A_PET, 1.f, dir);
  sfx::play(s_petCount & 1 ? sfx::C_EKKO_HAPPY : sfx::C_HOME_GIGGLE, .9f);
  if ((s_petCount & 1) == 0) E->emit(pulse::FX_HEART, 2);
}

void lifeUpdate() {
  if (s_mode != PM_NONE) {  // 2.9：正在一起玩：不犯困、不自己玩
    s_lastActive = s_now;
    return;
  }
  if (s_scr) return;
  if (s_settleAt) {
    if (!due(s_settleAt)) return;
    settle();
  }
  if (s_touchDown) { s_lastActive = s_now; return; }  // 2.7：生活模式里手还在头上 / 屏幕上
  if (s_facePresent) return;  // 看着人时不自行张望、犯困或启动随机表演
  const uint32_t idle = s_now - s_lastActive;
  // 2.7：精神越差越早犯困；夜里、快没电时更早
  const bool lowBatt = s_world.battOk && !s_world.charging && s_world.battery >= 0 && s_world.battery <= 5;
  const float k = (.75f + .75f * s_aff.energy) * (nightNow() ? .6f : 1.f) * (lowBatt ? .5f : 1.f);
  const uint32_t tiredMs = (uint32_t)(PULSE_TIRED_MS * k), sleepMs = (uint32_t)(PULSE_SLEEP_MS * k);
  switch (s_phase) {
    case PH_AWAKE:
      if (s_sleepSoon && idle > 8000) { fallAsleep(); break; }  // 夜里关了灯 / 说好了去睡
      if (s_care.awaiting(s_now)) break;  // 2.8：刚提醒过，等你回应（不犯困、不自己玩）
      if (idle > tiredMs) { getTired(); break; }
      if (due(s_nextSpont)) {
        if (s_groove == G_LISTEN) break;  // 2.9：正在听有没有在放歌：先安静一会儿
        s_nextSpont = s_now + spontGap();
        spontaneous();
      }
      break;
    case PH_TIRED:
      if (idle > sleepMs || (s_sleepSoon && idle > 8000)) fallAsleep();
      break;
    case PH_SLEEP:
      if (due(s_nextSnore)) {
        snore();
        s_nextSnore = s_now + 8000 + random(4000);
      }
      break;
  }
}

// 眼睛先看向头马上要转去的地方
void eyes() {
  if (s_avertUntil) {  // 2.7：害羞 / 傲娇时眼睛别开一下
    if (!due(s_avertUntil)) {
      E->setLook(true, s_avertX, s_avertY);
      return;
    }
    s_avertUntil = 0;
  }
  if (s_facePresent && faceTrackingAllowed()) {
    // 相机随头一起转，已把脸转到画面中央时眼睛也应回中，不能使用绝对头部角度。
    E->setLook(true, s_faceErrorX, s_faceErrorY);
    return;
  }
  float lp, lt;
  P->lead(.15f, lp, lt);
  E->setLook(true, clampf(lp / 40.f, -1.2f, 1.2f), clampf(lt / 24.f, -1.2f, 1.2f));
}

// ============================== 2.7 陪伴：每帧 ==============================
// 心情随时间变化，并把它轻轻地画在待机的脸上；每分钟记一次陪伴时长
void companionTick() {
  if (!s_affStarted) {
    s_affStarted = true;
    s_affAt = s_minuteAt = s_now;
    return;
  }
  const uint32_t ms = s_now - s_affAt;
  if (ms >= 100) {
    s_affAt = s_now;
    companion::AffectContext c;
    c.sleeping = s_phase == PH_SLEEP && !s_conversationOwned;
    c.night = nightNow();
    c.company = s_facePresent || s_touchDown || s_conversationOwned || (s_touchLast && (int32_t)(s_now - s_touchLast) < 10000);
    c.warmth = s_bond.warmth();
    companion::update(s_aff, ms * .001f, c);
    if (E) E->setMood(s_aff.valence, s_aff.arousal, s_aff.energy, s_aff.warmth);
  }
  if (s_now - s_minuteAt >= 60000) {
    s_minuteAt += 60000;
    s_bond.tickMinute();
  }
}

// 现在能不能演一段（庆祝 / 打招呼 / 重逢）：醒着、没在演别的、手不在身上、没在聊天
// 2.9：正在一起玩（游戏 / 跳舞 / 深呼吸 / 打卡）时也不演，等玩完
bool canPerform() {
  return s_booted && !s_conversationOwned && s_kind == SK_NONE && !s_scr && !s_settleAt && s_phase == PH_AWAKE &&
         !s_touchDown && (!s_touchEver || (int32_t)(s_now - s_touchLast) > 1600) && s_mode == PM_NONE;
}

const Step* greetScript() {
  if (!s_world.clock.valid) return kGreetDay;
  const uint16_t m = (uint16_t)(s_world.clock.hour * 60u + s_world.clock.minute);
  if (m >= 5 * 60 && m < 7 * 60 + 30) return kGreetEarly;  // 2.8：早起的小红花
  switch (companion::period(s_world.clock.hour)) {
    case companion::PD_MORNING: return kGreetMorning;
    case companion::PD_DAY: return kGreetDay;
    case companion::PD_EVENING: return kGreetEvening;
    default: return kGreetNight;
  }
}

const Step* welcomeScript(uint32_t absence) {
  if (nightNow()) return kWelcomeNight;
  if (bondLevel() <= 1) return kWelcomeShy;
  if (bondLevel() >= 4 && absence >= 4u * 3600000u) return kWelcomeMiss;
  return kWelcome;
}

void companionPerform() {
  // 过期的就算了（插上电 20 秒内没空演，就不演了）
  if ((s_pendCharge || s_pendFull || s_pendLow) && s_now - s_pendAt > 60000) s_pendCharge = s_pendFull = s_pendLow = false;
  if (s_pendWelcome && (int32_t)(s_now - s_faceSince) > 60000) s_pendWelcome = false;
  if (s_pendWelcome && s_care.pendingPraise() != care::K_NONE) s_pendWelcome = false;  // 2.8：回来会被夸，就不另外演重逢了
  if (!canPerform()) return;
  const bool quiet = nightNow();
  if (s_pendGreet) {  // 今天第一次见面（同时也算重逢）
    s_pendGreet = s_pendWelcome = false;
    s_lastWelcome = s_now;
    runScript(greetScript(), SK_REACT);  // 夜里那一版本来就很轻
    Serial.printf("[bond] 打招呼（连续 %u 天）\n", (unsigned)s_bond.data().streak);
    return;
  }
  if (s_pendMilestone >= 0) {
    const int i = s_pendMilestone;
    s_pendMilestone = -1;
    s_pendLevel = false;  // 一起庆祝
    runScript(kMilestone, SK_REACT, quiet);
    Serial.printf("[bond] 纪念日：认识 %u 天啦\n", (unsigned)companion::kMilestoneDays[i < companion::kMilestones ? i : 0]);
    return;
  }
  if (s_pendLevel) {
    s_pendLevel = false;
    runScript(kLevelUp, SK_REACT, quiet);
    return;
  }
  if (s_pendWelcome) {
    s_pendWelcome = false;
    s_lastWelcome = s_now;
    runScript(welcomeScript(s_pendWelcomeAbsence), SK_REACT);
    Serial.printf("[bond] 久别重逢（%u 分钟没见）\n", (unsigned)(s_pendWelcomeAbsence / 60000));
    return;
  }
  if (s_pendCharge) { s_pendCharge = false; runScript(kCharge, SK_REACT, quiet); return; }
  if (s_pendFull) { s_pendFull = false; runScript(kFull, SK_REACT, quiet); return; }
  if (s_pendLow) { s_pendLow = false; runScript(kLowBatt, SK_REACT, quiet); return; }
}

// 看见你的脸：稳定 1 秒算「来了」。很久没见 → 重逢；今天第一次 → 打招呼
void companionFace() {
  if (!s_faceArrival || !s_facePresent || (int32_t)(s_now - s_faceSince) < 1000) return;
  if (!s_careTicked || (int32_t)(s_careAt - s_faceSince) < 0) return;  // 2.8：等关心提醒先看到「你来了」（回来会被夸的话就不另外演重逢）
  s_faceArrival = false;
  const int32_t sinceUser = (int32_t)(s_now - s_lastUser);
  uint32_t absence = sinceUser > 0 ? (uint32_t)sinceUser : 0;
  if (s_faceAbsentFrom) {
    const int32_t since = (int32_t)(s_now - s_faceAbsentFrom);
    const uint32_t sinceSeen = since > 0 ? (uint32_t)since : 0;
    if (sinceSeen < absence) absence = sinceSeen;
  }
  if (absence < 30000) return;  // 只是一下没认出来
  stim(companion::ST_FACE, absence >= 20u * 60000u ? 1.f : .3f);
  visitToday(true);
  if (absence >= 20u * 60000u && (!s_lastWelcome || s_now - s_lastWelcome >= 10u * 60000u)) {
    bondEvent(companion::B_FACE);
    s_pendWelcome = true;
    s_pendWelcomeAbsence = absence;
  }
}

// 看着你的时候：熟了会慢慢眨眼（「我信任你」），还不熟会害羞地躲开眼神；很熟偶尔悄悄冒个爱心
void companionGaze() {
  if (!s_facePresent || s_phase != PH_AWAKE || s_scr || s_settleAt || s_touchDown || s_stateNum != 2 ||
      (int32_t)(s_now - s_faceSince) < 2500 || !due(s_nextGaze))
    return;
  s_nextGaze = s_now + 4000 + random(5000);
  const uint8_t lv = bondLevel();
  const int r = (int)random(100);
  if (lv >= 2 && r < 25 + 6 * lv) E->blink(.5f + .04f * lv);
  else if (lv <= 1 && r < 40) avert(.75f, .3f, 600 + random(500));
  if (lv >= 5 && due(s_nextFaceHeart) && random(100) < 50) {
    E->emit(pulse::FX_HEART, 1);
    s_nextFaceHeart = s_now + 45000 + random(45000);
  }
  // 2.9：「适中 / 活泼」由主动邀请（play::Bids）负责；「安静」保持 2.8 的偶尔邀请
  if (s_level == play::LV_QUIET && tone() == companion::T_PLAYFUL && !nightNow() && due(s_nextInvite) && random(100) < 25) {
    s_nextInvite = s_now + 120000 + random(60000);
    runScript(kInvite, SK_REACT);
  }
}

// 一次触摸开始（或继续）：记亲密度、心情、今天第一次见面
void touchMark(uint32_t now) {
  s_lastUser = s_lastActive = now;
  s_nextSpont = now + 25000 + random(30000);
  s_sleepSoon = false;
  if (!s_touchSession || now - s_touchMarkAt > 5000) {
    s_touchSession = true;
    s_touchSessionAt = now;
    s_touchStrokes = s_touchTaps = s_touchPets = 0;
    s_touchBoundary = false;
    stim(companion::ST_TOUCH);
    bondEvent(companion::B_TOUCH);
    visitToday(true);
  }
  s_touchMarkAt = s_touchLast = now;
  s_touchEver = true;
}

bool touchScriptBusy() {  // 刚开始的那段触摸反应 / 醒来 / 提醒和回应还没演完：别打断
  return s_scr && (s_kind == SK_CARE || (s_kind == SK_REACT && (s_scr == kWakePet || s_scr == kPerkUp || s_now - s_st0 < 1200)));
}

// ============================== 2.8 陪伴版：关心提醒 + 任务提醒 ==============================
// 多久以前（毫秒）；时间戳比现在还新时算 0
uint32_t agoMs(uint32_t t) {
  const int32_t d = (int32_t)(s_now - t);
  return d > 0 ? (uint32_t)d : 0u;
}

// 「你在不在」的迹象：脸、触摸、说话、靠近
care::Input careInput() {
  care::Input in;
  in.now = s_now;
  in.clockValid = s_world.clock.valid;
  in.hour = s_world.clock.hour;
  in.minute = s_world.clock.minute;
  in.day = s_world.clock.day;
  in.night = nightNow();
  in.bedtime = s_world.quietOn;
  in.sinceFace = s_facePresent ? 0u : (s_faceEverSeen ? agoMs(s_faceLastSeen) : care::kNever);
  in.sinceTouch = s_touchDown ? 0u : (s_touchEver ? agoMs(s_touchLast) : care::kNever);
  in.sinceChat = s_conversationOwned ? 0u : (s_chatEver ? agoMs(s_chatLast) : care::kNever);
  in.sinceNear = s_nearEver ? agoMs(s_nearLast) : care::kNever;
  in.free = false;
  return in;
}

// 有消息要叫你：从睡着 / 犯困里安安静静地醒过来（接下来的「叮咚」就是醒来的样子）
void wakeQuiet(const char* why) {
  abortScript();
  s_phase = PH_AWAKE;
  s_sleepSoon = false;
  s_nextSnore = 0;
  s_snores = 0;
  s_settleAt = 0;
  s_lastActive = s_now;
  s_nextSpont = s_now + 25000 + random(30000);
  stim(companion::ST_WAKE);
  P->setBreath(0, 4);
  P->release(.4f);
  E->clearFx();
  goState(2, false, false);
  Serial.printf("[life] %s，醒了\n", why);
}

// 「知道啦 / 收到」的回应之前：先醒着（睡着时被摸 / 按键）
void wakeForAck() {
  if (s_phase == PH_AWAKE) return;
  if (s_phase == PH_SLEEP) E->clearFx();
  s_phase = PH_AWAKE;
  s_sleepSoon = false;
  s_nextSnore = 0;
  s_snores = 0;
  stim(companion::ST_WAKE);
  P->setBreath(0, 4);
  P->release(.4f);
}

const char* careActName(uint8_t a) {
  switch (a) {
    case care::DO_REMIND: return "提醒";
    case care::DO_NUDGE: return "再轻轻提醒一次";
    case care::DO_PRAISE_BACK: return "回来夸你";
    case care::DO_PRAISE_DAY: return "今天辛苦啦";
    default: return "";
  }
}

void performCare(const care::Due& d) {
  const Step* sc = nullptr;
  uint8_t kind = d.kind;
  switch (d.act) {
    case care::DO_REMIND:
      if (kind == care::K_STRETCH) sc = kCareStretch;
      else if (kind == care::K_WATER) sc = kCareWater;
      else if (kind == care::K_LUNCH || kind == care::K_DINNER) sc = kCareMeal;
      else if (kind == care::K_BEDTIME) sc = kCareBedtime;
      break;
    case care::DO_NUDGE: sc = kCareNudge; break;
    case care::DO_PRAISE_BACK: sc = kind == care::K_STRETCH ? kPraiseStretch : kPraiseMeal; break;
    case care::DO_PRAISE_DAY: sc = kPraiseDay; kind = care::K_NONE; break;
    default: break;
  }
  if (!sc) return;
  if (d.act == care::DO_PRAISE_BACK) {  // 回来被夸 = 这次的「欢迎回来」，不另外演重逢
    s_pendWelcome = false;
    s_lastWelcome = s_now;
  }
  s_careKind = kind;
  s_ledColor = careColor(kind);
  s_bids.cancel();  // 2.9：正在等你回应邀请：被提醒打断（不算没理）
  abortScript();
  runScript(sc, SK_CARE, nightNow() && kind != care::K_BEDTIME);  // 夜里只有「早点睡」会小小声打个哈欠
  s_care.started(d, s_now);
  s_lastActive = s_now;
  if (kind != care::K_NONE) Serial.printf("[care] %s：%s\n", careActName(d.act), care::kindName(kind));
  else Serial.printf("[care] %s\n", careActName(d.act));
}

// 顶部标题：一条 = 它的标题（放不下就截短加「…」）；同一种好几条 = 「3 个任务完成啦」
// efontCN_16：ASCII 8 像素宽，其他字 16 像素宽；最宽 240 像素
void setNoticeLabel(const care::Notice& q, int n) {
  const uint8_t kind = q.kind < care::N_COUNT ? q.kind : (uint8_t)care::N_DONE;
  if (n > 1) {
    static const char* const kMany[care::N_COUNT] = {"%d 个任务完成啦", "%d 个任务没成功", "%d 条提醒", "收到 %d 句夸夸"};
    snprintf(s_label, sizeof s_label, kMany[kind], n);
    return;
  }
  const char* t = q.title[0] ? q.title : care::noticeName(kind);
  constexpr int kMaxW = 240, kDotsW = 16;
  const size_t len = strlen(t);
  size_t i = 0, cut = 0;
  int w = 0;
  bool fit = true;
  while (i < len) {
    const uint8_t c = (uint8_t)t[i];
    size_t step = c < 0x80 ? 1 : (c >= 0xF0 ? 4 : (c >= 0xE0 ? 3 : 2));
    if (i + step > len) step = len - i;
    const int cw = c < 0x80 ? 8 : 16;
    if (w + cw > kMaxW) { fit = false; break; }
    if (w + cw <= kMaxW - kDotsW) cut = i + step;
    w += cw;
    i += step;
  }
  size_t keep = fit ? len : cut;
  const size_t room = sizeof(s_label) - (fit ? 1 : 4);
  if (keep > room) {  // 不会发生（240 像素最多 15 个 4 字节的字），以防万一：退到完整的字
    keep = room;
    while (keep > 0 && ((uint8_t)t[keep] & 0xC0) == 0x80) keep--;
  }
  memcpy(s_label, t, keep);
  if (!fit) {
    memcpy(s_label + keep, "\xE2\x80\xA6", 3);  // …
    keep += 3;
  }
  s_label[keep] = 0;
}

const char* noticeActName(uint8_t a) {
  switch (a) {
    case care::NA_CUE: return "叮咚，叫你来看";
    case care::NA_SHOW: return "演给你看";
    case care::NA_NUDGE: return "轻轻提醒";
    default: return "";
  }
}

void performNotice(const care::NDue& nd) {
  if (nd.act == care::NA_NONE || nd.slot < 0 || nd.slot >= care::Inbox::kCap) return;
  const care::Notice& q = s_inbox.slot(nd.slot);
  const uint8_t kind = q.kind < care::N_COUNT ? q.kind : (uint8_t)care::N_DONE;
  const Step* sc = nullptr;
  bool show = false;
  int group = 0;
  s_noteKind = kind;
  switch (nd.act) {
    case care::NA_CUE:
      sc = q.cues == 0 ? kNoticeCue : kNoticeCueSoft;
      s_ledColor = kNoticeAmber;
      break;
    case care::NA_SHOW:
      group = s_inbox.countNew(kind);  // 先数：performed() 会把同一种的都标成演过了
      setNoticeLabel(q, group);
      s_ledColor = noticeColor(kind);
      show = true;
      switch (kind) {
        case care::N_DONE: sc = kTaskDone; stim(companion::ST_PLAY); break;
        case care::N_FAILED: sc = kTaskFailed; break;
        case care::N_REMIND: sc = kNoticeRemind; break;
        default: sc = kNoticePraise; stim(companion::ST_PLAY, .5f); break;
      }
      break;
    case care::NA_NUDGE: {
      int shown = 0;
      for (int i = 0; i < care::Inbox::kCap; i++)
        if (s_inbox.slot(i).state == care::NS_SHOWN) shown++;
      if (shown > 1) snprintf(s_label, sizeof s_label, "%d 条消息，摸我一下就算收到", shown);
      else setNoticeLabel(q, 1);
      s_ledColor = noticeColor(kind);
      sc = kNoticeNudge;
      break;
    }
    default: return;
  }
  s_inbox.performed(nd, s_now);
  s_bids.cancel();
  abortScript();
  runScript(sc, SK_CARE, nightNow());  // 夜里：不出声，只有表情、小图案和灯
  s_careShow = show;
  s_noticeAt = s_now;
  s_noticeValid = true;
  s_lastActive = s_now;
  if (group > 1)
    Serial.printf("[notify] %s：%s「%s」等 %d 条\n", noticeActName(nd.act), care::noticeName(kind), q.title, group);
  else
    Serial.printf("[notify] %s：%s「%s」\n", noticeActName(nd.act), care::noticeName(kind), q.title);
}

// 摸它 / 按键时还有没演过的消息：你就在跟前，马上演给你看
bool showNewNow() {
  if (!s_notifyOn) return false;
  care::Input in = careInput();
  in.free = true;
  in.sinceTouch = 0;
  const care::NDue nd = s_inbox.tick(in, false);
  if (nd.act != care::NA_SHOW) return false;
  performNotice(nd);
  return true;
}

// 摸它 / 按键 / 说话 = 「知道啦 / 收到」。perform：演一段回应（说话时不演，那边正在聊）
bool tryAck(bool perform) {
  if (!s_booted || s_kind == SK_BOOT || !E || !P) return false;
  const bool showing = s_scr && s_kind == SK_CARE && s_careShow;
  if (showing && perform && (int32_t)(s_now - s_st0) < 2000) return true;  // 刚开始演（多半就是这一下摸出来的）：先看完
  const int n = s_inbox.ack(s_now);
  if (n >= 0) {
    Serial.printf("[notify] 收到啦（%s）\n", care::noticeName((uint8_t)n));
    if (!perform) return true;
    if (showing) {  // 正在庆祝 / 安慰：不打断，冒个爱心就好
      E->emit(pulse::FX_HEART, 1);
      return true;
    }
    wakeForAck();
    s_noteKind = (uint8_t)n;
    abortScript();
    runScript(n == care::N_FAILED ? kNoticeAckFailed : kNoticeAckDone, SK_CARE, nightNow());
    s_lastActive = s_now;
    return true;
  }
  if (n == -2 && perform && s_notifyOn) {
    if (showing) return true;
    wakeForAck();
    if (showNewNow()) return true;
  }
  const uint8_t k = s_care.ack(s_now);
  if (k == care::K_NONE) return false;
  Serial.printf("[care] 知道啦（%s）\n", care::kindName(k));
  if (k == care::K_BEDTIME) s_sleepSoon = true;  // 说好了去睡：你不看它了 / 关了灯，它就先睡
  if (!perform) return true;
  wakeForAck();
  s_careKind = k;
  s_ledColor = careColor(k);
  const Step* sc = kAckStretch;
  if (k == care::K_WATER) sc = kAckWater;
  else if (k == care::K_LUNCH || k == care::K_DINNER) sc = kAckMeal;
  else if (k == care::K_BEDTIME) sc = kAckBedtime;
  abortScript();
  runScript(sc, SK_CARE, nightNow() && k != care::K_BEDTIME);
  s_lastActive = s_now;
  return true;
}

// 每秒一次：先看任务提醒，再看关心提醒
void careTick() {
  if (!s_booted || s_kind == SK_BOOT || !E || !P) return;
  if (s_careTicked && s_now - s_careAt < 1000) return;
  s_careTicked = true;
  s_careAt = s_now;
  // 2.9：跟着音乐跳舞时来了任务提醒：先停下来（消息比跳舞要紧）
  if (s_mode == PM_DANCE && s_notifyOn && s_inbox.hasNew()) danceEnd(DE_ABORT);
  care::Input in = careInput();
  bool acted = false;
  // ② 任务提醒（Ekko Studio）：没看见你 = 叮咚叫你（夜里 / 声音关了只亮灯）；看见你 = 演给你看
  if (s_notifyOn) {
    const bool allowCue = !nightNow() && s_world.soundOn;
    in.free = canPerform() && in.sinceChat >= 15000 && in.sinceTouch >= 4000;
    const care::NDue nd = s_inbox.tick(in, allowCue);
    if (nd.act != care::NA_NONE) {
      performNotice(nd);
      acted = true;
    } else if (s_inbox.hasNew() && !s_conversationOwned && !s_scr) {
      if (s_phase != PH_AWAKE) {
        if (allowCue && s_inbox.cueDue(s_now)) wakeQuiet("有消息");  // 白天：醒过来叫你（下一秒叮咚）
      } else if (!care::facing(in) && due(s_nextBell)) {
        s_nextBell = s_now + 20000;
        E->emit(pulse::FX_BELL, 1);  // 等你回来：安安静静地冒个小铃铛
      }
    }
  }
  // ① 关心提醒：刚演过任务提醒 2 分钟内不插；刚说完话 / 刚摸完先等一会儿
  if (s_noticeValid && s_now - s_noticeAt >= 120000) s_noticeValid = false;
  in.free = !acted && !s_noticeValid && canPerform() && in.sinceChat >= 45000 && in.sinceTouch >= 10000;
  const care::Due d = s_care.tick(in);
  if (d.act != care::DO_NONE) performCare(d);
}

// 早早关灯睡觉（21:30–23:00，或提醒睡觉后 40 分钟内）：夸一下，每晚一次
bool goodSleepNow() {
  if (s_care.level() == care::L_OFF || !s_world.quietOn || nightKey() == s_goodSleepKey) return false;
  if (s_care.bedtimeFollow(s_now)) return true;
  if (!s_world.clock.valid) return false;
  const uint16_t m = (uint16_t)(s_world.clock.hour * 60u + s_world.clock.minute);
  return m >= 21 * 60 + 30 && m < 23 * 60;
}

// ============================== 2.9 活泼版：一起玩 ==============================
// 现在能不能主动找你玩（邀请 / 躲猫猫 / 小反应 / 心情打卡）：醒着、空着、不是夜里、没有提醒和消息在等你
bool playReady() {
  return canPerform() && s_groove != G_LISTEN && !nightNow() && !s_care.awaiting(s_now) &&
         !(s_notifyOn && (s_inbox.hasNew() || s_inbox.awaiting())) && !s_bids.waiting(s_now) && !s_peek.searching() &&
         s_stateNum == 2;
}

// 你让它玩（连拍 / 接受邀请 / 串口）：醒着、没在聊天、没在演提醒
bool playStartOk() {
  return s_booted && E && P && s_kind != SK_BOOT && !s_conversationOwned && s_phase == PH_AWAKE && !(s_scr && s_kind == SK_CARE);
}

void endMode() {
  s_mode = PM_NONE;
  s_showLast = s_now;
  s_showEver = true;
}

// 现在多想玩（0–1）
float playfulness() {
  float p = .3f + .4f * s_aff.arousal + .2f * s_aff.valence;
  if (tone() == companion::T_PLAYFUL || tone() == companion::T_EXCITED) p += .2f;
  return clampf(p, 0.f, 1.f);
}

// 串口命令：睡着时先安安静静地醒过来
void serialWake() {
  if (s_phase != PH_AWAKE && !s_conversationOwned && s_booted && s_kind != SK_BOOT) wakeQuiet("串口叫醒");
}

// ---------------- 节奏游戏 ----------------
bool gameStart(const char* why) {
  if (!playStartOk() || (s_mode != PM_NONE && s_mode != PM_DANCE)) return false;
  if (s_mode == PM_DANCE) danceEnd(DE_ABORT);
  abortScript();
  s_settleAt = 0;
  s_mode = PM_RHYTHM;
  s_rhythm.stop();
  s_gameArmed = true;
  s_gameAt = s_now + 1300;  // 开场动画演完再开始
  s_stats.games++;
  runScript(kGameIntro, SK_REACT, nightNow());
  Serial.printf("[play] 节奏游戏开始（%s）：我先拍，你跟着拍\n", why);
  return true;
}

void gameEnd() {
  const uint8_t passed = s_rhythm.passed();
  s_rhythm.stop();
  endMode();
  s_gameEver = true;
  s_gameEnd = s_now;
  const Step* sc = kGameEndSoft;
  if (passed >= play::Rhythm::kRounds) {
    sc = kGameWin;
    s_stats.gameWins++;
    snprintf(s_text, sizeof s_text, "%s", "全部过关！你太厉害啦");
  } else if (passed >= 2) {
    sc = kGameEnd;
    snprintf(s_text, sizeof s_text, "过了 %u 关！", (unsigned)passed);
  } else {
    snprintf(s_text, sizeof s_text, "%s", passed ? "过了 1 关，下次再玩" : "下次再玩～");
  }
  if (passed) {
    stim(companion::ST_PLAY);
    bondEvent(companion::B_PLAY);
  }
  runScript(sc, SK_REACT, nightNow());
  showText(s_text, 2600);
  Serial.printf("[play] 节奏游戏结束：过了 %u 关（完美 %u 次）\n", (unsigned)passed, (unsigned)s_rhythm.perfects());
}

void gameTap() {
  if (!s_rhythm.tap(s_now)) return;
  E->pulse();
  E->emit(pulse::FX_NOTE, 1);
  if (!nightNow()) sfx::onTap();
}

void gameTick() {
  if (s_gameArmed) {
    if (!due(s_gameAt)) return;
    s_gameArmed = false;
    s_rhythm.start(s_now, (uint32_t)random(0x7FFFFFFF) | 1u);
  }
  const play::Rhythm::Ev e = s_rhythm.update(s_now);
  const bool quiet = nightNow();
  switch (e.type) {
    case play::Rhythm::RE_ROUND:  // 每关开头：竖起耳朵
      goState(16, false, false);
      snprintf(s_text, sizeof s_text, "第 %u 关：听好啦", (unsigned)e.round + 1);
      showText(s_text, 1500);
      break;
    case play::Rhythm::RE_BEAT:  // 它敲一下：「嘟」+ 光环 + 音符 + 点头（手在头上时不点头）
      if (!quiet) sfx::synth(sfx::S_BOP, true);
      E->pulse();
      E->emit(pulse::FX_NOTE, 1);
      if (!s_touchDown) playAct(A_NOD, .45f);
      break;
    case play::Rhythm::RE_TURN:
      if (!quiet) sfx::synth(sfx::S_TURN, true);
      goState(35, false, false);
      snprintf(s_text, sizeof s_text, "轮到你：拍我 %u 下", (unsigned)s_rhythm.beats());
      showText(s_text, 4000);
      break;
    case play::Rhythm::RE_RESULT: {
      const Step* sc = kGameMiss;
      const char* t = e.index ? "差一点，再来一次" : "差一点～";
      if (e.result == play::Rhythm::RR_PERFECT) {
        sc = kGamePerfect;
        t = "完美！";
      } else if (e.result == play::Rhythm::RR_GOOD) {
        sc = kGameGood;
        t = "不错！";
      } else if (e.result == play::Rhythm::RR_TIMEOUT) {
        sc = kGameTimeout;
        t = "不玩啦？";
      }
      runScript(sc, SK_REACT, quiet);
      showText(t, 1800);
      static const char* const kR[5] = {"", "完美", "不错", "没对上", "没拍"};
      Serial.printf("[play] 第 %u 关（%u 拍）：%s\n", (unsigned)e.round + 1, (unsigned)s_rhythm.beats(), kR[e.result < 5 ? e.result : 0]);
      break;
    }
    case play::Rhythm::RE_END: gameEnd(); break;
    default: break;
  }
}

// ---------------- 听歌跳舞 ----------------
bool musicOk() { return s_musicOn && s_musicAvail; }

// 多久以后再听一次有没有在放歌
uint32_t listenGap() {
  if (s_musicSeen && agoMs(s_musicAt) < 180000u) return 20000u;  // 刚刚在放歌：常听听
  const float r = rnd01();
  if (s_level == play::LV_LIVELY) return 40000u + (uint32_t)(30000.f * r);
  if (s_level == play::LV_NORMAL) return 90000u + (uint32_t)(60000.f * r);
  return 180000u + (uint32_t)(120000.f * r);
}

// 背景听歌：醒着、空着、安安静静（不在演、手不在身上、没在聊天、不是夜里）
bool listenOk() {
  return musicOk() && s_booted && s_kind != SK_BOOT && !s_conversationOwned && s_phase == PH_AWAKE && !nightNow() &&
         s_mode == PM_NONE && !s_scr && !s_settleAt && !s_touchDown;
}

void listenStart(bool user) {
  s_groove = G_LISTEN;
  s_listenUser = user;
  s_grooveUntil = s_now + (user ? 4500u : 5000u);
  if (!user) return;
  s_mode = PM_DANCE;  // 你让它跳：先竖起耳朵听一听
  abortScript();
  s_settleAt = 0;
  goState(3, false, false);
  P->setIdle(false);
  P->lookAt(0, -8, .6f);
  E->emit(pulse::FX_NOTE, 1);
  showText(kTexts[XT_LISTEN], 4500);
  Serial.println("[music] 听听有没有在放歌…");
}

void danceBegin(const beat::Estimate& e) {
  const bool resume = s_mode == PM_DANCE && s_groove == G_PAUSE;
  s_est = e;
  s_groove = G_DANCE;
  s_listenUser = false;
  s_segBeats = 0;
  s_beatIdx = (int32_t)floorf(beat::beatPhase(e, s_now));
  if (!resume) {
    s_mode = PM_DANCE;
    s_danceFrom = s_now;
    s_stats.dances++;
    s_stats.musicDances++;
    abortScript();
    s_settleAt = 0;
    hideText();
    E->kick(pulse::I_FLASH);
    E->emit(pulse::FX_NOTE, 2);
    stim(companion::ST_PLAY, .5f);
    Serial.printf("[music] 在放歌（%.0f BPM），跟着跳！\n", e.bpm);
  }
  goState(10, false, false);
  P->setIdle(false);
}

void soloDance() {
  abortScript();
  s_settleAt = 0;
  runScript(kDanceSolo, SK_REACT, nightNow());
  s_showLast = s_now;
  s_showEver = true;
  s_stats.dances++;
  stim(companion::ST_PLAY, .5f);
  Serial.println("[play] 自己啦啦啦跳一段");
}

void danceEnd(uint8_t why) {
  const bool was = s_mode == PM_DANCE;
  const bool danced = was && s_groove != G_LISTEN;
  if (P) P->setGroove(0.f, 0.f, 0.f);
  s_listenUser = false;
  uint32_t restMs = 0;
  if (why == DE_TIRED) {
    s_tiredN = (s_tiredN && s_now - s_tiredAt < 20u * 60000u) ? (uint8_t)(s_tiredN < 3 ? s_tiredN + 1 : 3) : 1;
    s_tiredAt = s_now;
    restMs = 180000u << (s_tiredN - 1);
    s_groove = G_REST;
    s_grooveUntil = s_now + restMs;
  } else {
    s_groove = G_IDLE;
    s_nextListen = s_now + (why == DE_ABORT ? 30000u : 20000u);
  }
  if (!was) return;
  endMode();
  hideText();
  if (why != DE_ABORT && danced) {
    bondEvent(companion::B_PLAY);
    runScript(why == DE_TIRED ? kDanceTired : kDanceEnd, SK_REACT, true);  // 不出声：歌可能还在放
  } else if (!s_scr) {
    settle();
  }
  if (why == DE_TIRED) Serial.printf("[music] 不跳了（跳累了，歇 %u 分钟）\n", (unsigned)(restMs / 60000u));
  else Serial.printf("[music] 不跳了（%s）\n", why == DE_STOPPED ? "歌停了" : "被打断");
}

void danceFrame() {
  if (!s_est.periodMs) {
    danceEnd(DE_STOPPED);
    return;
  }
  const bool half = s_est.bpm > 130.f;  // 太快：两拍摆一下
  const float bps = 1000.f / (float)s_est.periodMs;
  const float ph = beat::beatPhase(s_est, s_now + 60);  // 提前 60 毫秒（舵机跟上要一点时间）
  P->setGroove(1.f, half ? ph * .5f : ph, half ? bps * .5f : bps);
  s_sensQuiet = s_now + 800;  // 自己在晃：别当成被摇晃
  const int32_t idx = (int32_t)floorf(beat::beatPhase(s_est, s_now));
  if (idx == s_beatIdx) return;
  s_beatIdx = idx;
  s_segBeats++;
  if ((s_segBeats & 1) == 0) E->emit(pulse::FX_NOTE, 1);
  if ((s_segBeats & 3) == 0) {
    goState(s_stateNum == 10 ? 19 : 10, false, false);
    E->kick(pulse::I_HOP);
  }
  if (s_segBeats < 16) return;
  if (s_now - s_danceFrom >= 180000u) {
    danceEnd(DE_TIRED);
    return;
  }
  // 跳了 16 拍：停下来听一听还在不在放（自己晃的时候不听：舵机声会干扰）
  s_groove = G_PAUSE;
  s_grooveUntil = s_now + 4500;
  P->setGroove(0.f, ph, bps);
  goState(3, false, false);
}

void danceNow() {
  if (!playStartOk() || s_mode != PM_NONE) return;
  if (s_musicSeen && s_musicEst.music && agoMs(s_musicAt) < 8000u && musicOk() && !nightNow()) {
    danceBegin(s_musicEst);
    return;
  }
  if (musicOk() && !nightNow()) {
    listenStart(true);
    return;
  }
  soloDance();
}

void musicOff() {
  if (s_mode == PM_DANCE) {
    danceEnd(DE_ABORT);
    return;
  }
  if (s_groove == G_LISTEN || s_groove == G_PAUSE || s_groove == G_DANCE) {
    if (P) P->setGroove(0.f, 0.f, 0.f);
    s_groove = G_IDLE;
    s_listenUser = false;
  }
}

void grooveTick() {
  switch (s_groove) {
    case G_IDLE:
      if (!musicOk()) break;
      if (!s_nextListen) {
        s_nextListen = s_now + listenGap();
        break;
      }
      if (!due(s_nextListen)) break;
      if (listenOk()) listenStart(false);
      else s_nextListen = s_now + 5000;  // 现在不方便：过一会儿再看
      break;
    case G_LISTEN:
      if (s_listenUser) {
        if (s_mode != PM_DANCE) {
          s_groove = G_IDLE;
          s_listenUser = false;
          s_nextListen = s_now + 20000;
          break;
        }
        if (!due(s_grooveUntil)) break;
        s_groove = G_IDLE;  // 没听到歌：自己跳一段
        s_listenUser = false;
        s_nextListen = s_now + 9000;
        endMode();
        hideText();
        soloDance();
        break;
      }
      if (!listenOk()) {
        s_groove = G_IDLE;
        s_nextListen = s_now + 20000;
        break;
      }
      if (due(s_grooveUntil)) {
        s_groove = G_IDLE;
        s_nextListen = s_now + listenGap();
      }
      break;
    case G_DANCE:
      if (s_mode != PM_DANCE || !musicOk() || nightNow()) {
        danceEnd(DE_ABORT);
        break;
      }
      danceFrame();
      break;
    case G_PAUSE:
      if (s_mode != PM_DANCE || !musicOk()) {
        danceEnd(DE_ABORT);
        break;
      }
      if (due(s_grooveUntil)) danceEnd(DE_STOPPED);
      break;
    case G_REST:
      if (due(s_grooveUntil)) {
        s_groove = G_IDLE;
        s_nextListen = s_now + 20000;
      }
      break;
    default:
      s_groove = G_IDLE;
      break;
  }
}

// ---------------- 一起深呼吸 ----------------
inline float smooth01(float x) {
  x = clampf(x, 0.f, 1.f);
  return x * x * (3.f - 2.f * x);
}

bool breathStart(uint8_t n, const char* why) {
  if (!n || !playStartOk() || (s_mode != PM_NONE && s_mode != PM_DANCE)) return false;
  if (s_mode == PM_DANCE) danceEnd(DE_ABORT);
  abortScript();
  s_settleAt = 0;
  s_mode = PM_BREATH;
  s_breathN = n;
  s_breathCur = -1;
  s_breathInhale = false;
  s_breathT0 = s_now + 1600;
  runScript(kBreathIntro, SK_REACT, true);
  Serial.printf("[play] 一起深呼吸（%u 次，%s）\n", (unsigned)n, why);
  return true;
}

void breathEnd(bool early) {
  const int done = early ? (s_breathCur < 0 ? 0 : s_breathCur) : (int)s_breathN;
  endMode();
  s_stats.breaths += (uint32_t)done;
  if (done >= 2) {
    stim(companion::ST_HOLD);
    bondEvent(companion::B_HOLD);
    runScript(kBreathDone, SK_REACT, nightNow());
  } else {
    hideText();
    abortScript();
    settle();
  }
  Serial.printf("[play] 深呼吸结束（%d 次%s）\n", done, early ? "，提前停了" : "");
}

void breathTick() {
  if (!due(s_breathT0)) return;
  const uint32_t t = s_now - s_breathT0;
  const uint32_t i = t / 10000u, u = t % 10000u;
  if (i >= s_breathN) {
    breathEnd(false);
    return;
  }
  const bool inhale = u < 4000u;
  if ((int)i != s_breathCur || inhale != s_breathInhale) {
    s_breathCur = (int)i;
    s_breathInhale = inhale;
    if (inhale) {
      if (!nightNow()) sfx::synth(sfx::S_BREATH, true);
      goState(19, false, false);
      showText("吸气…", 3900);
    } else {
      showText("呼气…", 5900);
    }
  }
  s_breathLevel = inhale ? smooth01((float)u / 4000.f) : 1.f - smooth01((float)(u - 4000u) / 6000.f);
}

// 呼吸引导叠加在脸上：开始时慢慢加上、结束后慢慢退掉
void guideTick(float dt) {
  const bool on = s_mode == PM_BREATH && due(s_breathT0);
  if (!on) s_breathLevel += (0.f - s_breathLevel) * clampf(dt / .5f, 0.f, 1.f);
  if (!on && s_guideA <= 0.f) return;
  s_guideA += ((on ? 1.f : 0.f) - s_guideA) * clampf(dt / .8f, 0.f, 1.f);
  if (!on && s_guideA < .01f) s_guideA = 0.f;
  if (E) E->setGuide(s_guideA, s_breathLevel);
}

// ---------------- 每晚心情打卡 ----------------
uint32_t moodDay() { return s_world.clock.valid ? s_world.clock.day : 0u; }

bool moodAskNow(const char* why) {
  const uint32_t day = moodDay();
  if (!day || !playStartOk() || s_mode != PM_NONE) return false;
  abortScript();
  s_settleAt = 0;
  s_mode = PM_MOOD;
  s_moodStep = MS_ASK;
  s_moodTaps = 0;
  s_moodTapAt = 0;
  s_moodUntil = s_now + play::CheckIn::kAnswerMs;
  s_moodHintAt = s_now + 12000;
  s_mood.asked(day);
  s_checkIn.asked(s_now);
  s_stats.moodAsks++;
  runScript(kMoodAsk, SK_REACT, nightNow());
  showText("今天心情几分？拍我 1-5 下", 8000);
  Serial.printf("[mood] 今天心情几分？拍 1–5 下（%s）\n", why);
  return true;
}

void moodTap() {
  if (s_moodStep != MS_ASK) return;
  if (s_moodTaps < 5) s_moodTaps++;
  s_moodTapAt = s_now;
  s_moodHintAt = 0;
  if (s_scr) abortScript();
  goState(16, false, false);
  E->pulse();
  if (!nightNow()) sfx::onTap();
  snprintf(s_text, sizeof s_text, "%u 分", (unsigned)s_moodTaps);
  showText(s_text, 2400);
}

void moodReply() {
  const uint8_t sc = s_moodTaps < 1 ? 1 : (s_moodTaps > 5 ? 5 : s_moodTaps);
  const uint32_t day = moodDay();
  if (day) s_mood.add(day, sc);
  static const Step* const kS[5] = {kMood1, kMood2, kMood3, kMood4, kMood5};
  static const char* const kT[5] = {"抱抱你，我陪着你", "辛苦啦，抱抱你", "平平稳稳也很好", "不错的一天～", "太好啦！今天真棒"};
  s_moodStep = MS_REPLY;
  if (sc >= 4) stim(companion::ST_PLAY, .5f);
  runScript(kS[sc - 1], SK_REACT, nightNow());
  showText(kT[sc - 1], 3200);
  Serial.printf("[mood] 今天 %u 分（最近 7 天打了 %d 次，平均 %.1f）\n", (unsigned)sc, s_mood.entries(day), s_mood.average(day));
}

void moodNext() {
  const uint32_t day = moodDay();
  if (s_moodStep == MS_REPLY && day && s_mood.summaryDue(day)) {  // 每周小结
    s_moodStep = MS_WEEK;
    s_mood.summarized(day);
    const float avg = s_mood.average(day);
    const int tr = s_mood.trend(day);
    const char* tail = tr > 0 ? "越来越好啦" : (tr < 0 ? "最近辛苦了" : (avg >= 3.5f ? "状态不错哦" : (avg < 2.5f ? "我陪着你" : "很稳定哦")));
    snprintf(s_text, sizeof s_text, "这周平均 %.1f 分，%s", avg, tail);
    runScript(kMoodWeek, SK_REACT, true);
    showText(s_text, 3600);
    Serial.printf("[mood] 每周小结：%s\n", s_text);
    return;
  }
  if ((s_moodStep == MS_REPLY || s_moodStep == MS_WEEK) && day && s_mood.persistentLow(day)) {
    s_moodStep = MS_LOW;
    runScript(kMoodCare, SK_REACT, true);
    showText("很难受时，找信任的人聊聊", 4400);
    Serial.println("[mood] 最近几天心情都不太好：很难受时，找信任的人聊聊");
    return;
  }
  s_moodStep = MS_DONE;
  endMode();
  settle();
}

void moodTick() {
  switch (s_moodStep) {
    case MS_ASK:
      if (s_moodTaps) {
        if (s_now - s_moodTapAt >= 1600) moodReply();
        return;
      }
      if (due(s_moodUntil)) {
        s_moodStep = MS_DONE;
        endMode();
        hideText();
        if (!s_scr) settle();
        Serial.println("[mood] 没回答，那就下次吧");
        return;
      }
      if (s_moodHintAt && due(s_moodHintAt)) {
        s_moodHintAt = 0;
        showText("拍几下就是几分（1-5）", 6000);
      }
      return;
    case MS_REPLY:
    case MS_WEEK:
    case MS_LOW:
      if (!s_scr) moodNext();
      return;
    default:
      endMode();
      return;
  }
}

void checkInTick() {
  if (s_mode != PM_NONE) return;
  play::CheckInput ci;
  ci.now = s_now;
  ci.clockValid = s_world.clock.valid;
  ci.hour = s_world.clock.hour;
  ci.minute = s_world.clock.minute;
  ci.day = moodDay();
  ci.quietOn = s_world.quietOn;
  ci.careLevel = s_care.level();
  ci.ready = playReady();
  if (s_faceEverSeen) {
    ci.present = s_facePresent;
    ci.presentMs = s_facePresent ? s_now - s_faceSince : 0u;
  } else {  // 没有相机：刚摸过 / 刚说过话
    ci.present = (s_touchEver && agoMs(s_touchLast) < 60000u) || (s_chatEver && agoMs(s_chatLast) < 60000u);
    ci.presentMs = ci.present ? 5000u : 0u;
  }
  if (s_checkIn.due(ci, s_mood)) moodAskNow("每晚问一次");
}

// ---------------- 主动邀请 ----------------
void performBid(uint8_t k) {
  const Step* sc = nullptr;
  switch (k) {
    case play::BID_PET: sc = kBidPet; break;
    case play::BID_HEART: sc = kBidHeart; break;
    case play::BID_NUZZLE: sc = kBidNuzzle; break;
    case play::BID_PLAY: sc = kBidPlay; break;
    case play::BID_SHOW: sc = kBidShow; break;
    default: return;
  }
  runScript(sc, SK_REACT);
  s_bids.started(k, s_now);
  s_showLast = s_now;
  s_showEver = true;
  Serial.printf("[play] 主动邀请：%s\n", play::bidName(k));
}

// 正在等你回应邀请时：摸 / 点 / 按键 / 说话 = 接受。perform：演一段开心的回应（说话时不演）
bool bidAccept(bool perform) {
  if (!s_bids.waiting(s_now)) return false;
  const uint8_t k = s_bids.respond(s_now);
  if (k == play::BID_NONE) return false;
  stim(companion::ST_PLAY, .7f);
  bondEvent(companion::B_PLAY);
  Serial.printf("[play] 你回应了「%s」\n", play::bidName(k));
  if (!perform) return true;
  if (k == play::BID_PLAY && gameStart("接受邀请")) return true;
  const Step* sc = kBidPetYes;
  if (k == play::BID_HEART) sc = kBidHeartYes;
  else if (k == play::BID_NUZZLE) sc = kBidNuzzleYes;
  else if (k == play::BID_SHOW) sc = kBidShowYes;
  abortScript();
  runScript(sc, SK_REACT, nightNow());
  s_showLast = s_now;
  s_showEver = true;
  return true;
}

void bidTick() {
  if (s_bidTicked && s_now - s_bidAt < 1000) return;
  s_bidTicked = true;
  s_bidAt = s_now;
  checkInTick();
  if (s_level == play::LV_QUIET) return;  // 安静：不主动邀请
  play::BidInput in;
  in.now = s_now;
  in.level = s_level;
  in.ready = playReady() && tone() != companion::T_SLEEPY && tone() != companion::T_GRUMPY;
  in.camera = s_faceEverSeen;
  in.facing = s_facePresent;
  in.facingMs = s_facePresent ? s_now - s_faceSince : 0u;
  in.sinceTouch = s_touchDown ? 0u : (s_touchEver ? agoMs(s_touchLast) : play::kNever);
  in.sinceChat = s_chatEver ? agoMs(s_chatLast) : play::kNever;
  in.sinceNear = s_nearEver ? agoMs(s_nearLast) : play::kNever;
  in.sinceShow = s_showEver ? agoMs(s_showLast) : play::kNever;
  in.day = s_world.clock.valid ? s_world.clock.day : bondDay();
  in.playful = playfulness();
  in.warmth = s_bond.warmth();
  in.gameOk = !s_gameEver || agoMs(s_gameEnd) > 600000u;
  const float r1 = rnd01(), r2 = rnd01();
  const uint8_t k = s_bids.tick(in, r1, r2);
  if (k != play::BID_NONE) performBid(k);
}

// ---------------- 躲猫猫 ----------------
void peekTick() {
  const bool canStart = playReady();
  const bool keep = !s_touchDown && !s_conversationOwned && s_mode == PM_NONE && !s_settleAt && (!s_scr || s_scr == kPeekSearch);
  const uint8_t ev = s_peek.update(s_now, s_facePresent, canStart, keep, s_level);
  if (ev == play::Peekaboo::PK_SEARCH) {
    runScript(kPeekSearch, SK_REACT, nightNow());
    Serial.println("[play] 躲猫猫：你去哪儿啦？");
  } else if (ev == play::Peekaboo::PK_FOUND) {
    abortScript();
    runScript(s_peek.streak() >= 3 ? kPeekFoundMore : kPeekFound, SK_REACT, nightNow());
    stim(companion::ST_PLAY, .6f);
    if (s_peek.streak() == 1) bondEvent(companion::B_PLAY);
    s_showLast = s_now;
    s_showEver = true;
    Serial.printf("[play] 躲猫猫：找到你啦（连着第 %u 次）\n", (unsigned)s_peek.streak());
  } else if (ev == play::Peekaboo::PK_GIVEUP) {
    runScript(kPeekGiveUp, SK_REACT, true);
    s_showLast = s_now;
    s_showEver = true;
    Serial.println("[play] 躲猫猫：找不到，算了");
  }
}

// ---------------- 看着你时的小反应 ----------------
void microTick() {
  if (!s_facePresent || !play::microGap(s_level, .5f)) {
    s_nextMicro = 0;
    return;
  }
  if (!playReady() || (int32_t)(s_now - s_faceSince) < 2500) return;
  if (!s_nextMicro) {
    s_nextMicro = s_now + play::microGap(s_level, rnd01());
    if (!s_nextMicro) s_nextMicro = 1;
    return;
  }
  if (!due(s_nextMicro)) return;
  // 你在跟前久了（一直在忙）：慢慢安静下来——15 分钟后间隔变成 2 倍，30 分钟后 3 倍
  const float calm = 1.f + clampf((float)(s_now - s_faceSession) / 900000.f, 0.f, 2.f);
  s_nextMicro = s_now + (uint32_t)((float)play::microGap(s_level, rnd01()) * calm);
  if (!s_nextMicro) s_nextMicro = 1;
  float w[MI_COUNT];
  const uint8_t t = tone() < companion::T_COUNT ? tone() : 0;
  const uint8_t lv = bondLevel();
  for (int i = 0; i < MI_COUNT; i++) w[i] = kMiW[t][i];
  w[MI_LOVE] *= lv >= 3 ? 1.f : .3f;
  w[MI_PEEK] *= lv <= 1 ? 2.f : .6f;
  if (s_lastMicro >= 0 && s_lastMicro < MI_COUNT) w[s_lastMicro] *= .15f;
  int k = companion::pickWeighted(w, MI_COUNT, rnd01());
  if (k < 0 || k >= MI_COUNT) k = MI_TILT;
  s_lastMicro = k;
  s_stats.micro++;
  runScript(kMicro[k], SK_REACT);
}

// ---------------- 触摸 / 连拍 / 按住头顶 ----------------
// 玩的时候的触摸：返回 true = 归它们了（别的反应先不做）
bool playTouch(uint8_t g, bool head) {
  switch (s_mode) {
    case PM_RHYTHM:  // 轮到你的时候：拍头 / 点屏幕都算（头顶触摸条上拍得快时可能识别成「滑一下」，也算）
      if (s_rhythm.listening() && (g == 0 || (g == 1 && head))) gameTap();
      return true;
    case PM_MOOD:
      if (g == 0) moodTap();
      return true;
    case PM_BREATH:  // 点一下 = 不做了
      if (g == 0) breathEnd(true);
      return true;
    case PM_DANCE:  // 摸它 = 不跳了，正常地回应你
      danceEnd(DE_ABORT);
      return false;
    default:
      return false;
  }
}

void tapGesture(uint8_t n) {
  if (s_mode != PM_NONE || s_phase != PH_AWAKE || s_touchBoundary || (s_scr && s_kind == SK_CARE)) return;
  if (n == 2) {
    Serial.println("[play] 连拍两下：跳舞");
    danceNow();
  } else {
    gameStart("连拍三下");
  }
}

// 结束正在玩的（不演结尾）：聊天开始 / 睡着 / 被摇 / 串口预览……调用方负责接下来的样子
void stopPlay(const char* why) {
  if (s_bids.waiting(s_now)) s_bids.cancel();
  if (s_groove == G_LISTEN || s_groove == G_DANCE || s_groove == G_PAUSE) {
    if (P) P->setGroove(0.f, 0.f, 0.f);
    s_groove = G_IDLE;
    s_listenUser = false;
    s_nextListen = s_now + 30000u;
  }
  const uint8_t m = s_mode;
  if (m == PM_NONE) return;
  if (m == PM_RHYTHM) {
    s_rhythm.stop();
    s_gameArmed = false;
  }
  if (m == PM_MOOD) s_moodStep = MS_DONE;
  endMode();
  hideText();
  Serial.printf("[play] 先不玩了（%s）\n", why);
}

void playTick(float dt) {
  if (s_booted && s_kind != SK_BOOT && !s_conversationOwned) {
    // 按住头顶不动 3.5 秒：一起深呼吸
    if (s_headDown && !s_headMoved && !s_headUsed && s_now - s_headSince >= 3500u) {
      s_headUsed = true;
      if (s_mode == PM_NONE || s_mode == PM_DANCE) breathStart(6, "按住头顶");
    }
    const uint8_t n = s_tapSeq.update(s_now);
    if (n) {
      if (!s_tapBad && (n == 2 || n == 3)) tapGesture(n);
      s_tapBad = false;
    }
    switch (s_mode) {
      case PM_RHYTHM: gameTick(); break;
      case PM_BREATH: breathTick(); break;
      case PM_MOOD: moodTick(); break;
      default: break;
    }
    grooveTick();
  }
  guideTick(dt);
}

void livelyTick() {
  peekTick();
  bidTick();
  microTick();
}

uint32_t beatColor() {
  static const uint32_t k[6] = {0xFF5FA0, 0xFFB040, 0xFFE860, 0x60F090, 0x50C8FF, 0xA070FF};
  int32_t i = s_beatIdx % 6;
  if (i < 0) i += 6;
  return k[i];
}
constexpr uint32_t kBreathTeal = 0x30D8C0;

// 正在演的只是「自己玩」/ 看着你时的小反应：要紧一点的事（关灯睡觉）可以打断它
bool idleScriptNow() {
  if (!s_scr || s_kind != SK_REACT) return false;
  for (const Step* sc : kSpont)
    if (s_scr == sc) return true;
  for (const Step* sc : kMicro)
    if (s_scr == sc) return true;
  return false;
}

// 串口预览里顺便显示的提示文字
const char* previewText(const char* n) {
  static const struct { const char* name; const char* text; } k[] = {
    {"moodask", "今天心情几分？拍我 1-5 下"}, {"mood5", "太好啦！今天真棒"}, {"mood4", "不错的一天～"},
    {"mood3", "平平稳稳也很好"}, {"mood2", "辛苦啦，抱抱你"}, {"mood1", "抱抱你，我陪着你"},
    {"moodweek", "这周平均 3.6 分，越来越好啦"}, {"moodcare", "很难受时，找信任的人聊聊"},
    {"gameperfect", "完美！"}, {"gamegood", "不错！"}, {"gamemiss", "差一点，再来一次"}, {"gametimeout", "不玩啦？"},
    {"gamewin", "全部过关！你太厉害啦"}, {"gameend", "过了 3 关！"}, {"gameendsoft", "下次再玩～"},
  };
  for (const auto& it : k)
    if (!strcmp(n, it.name)) return it.text;
  return nullptr;
}

// 串口预览
constexpr uint8_t kPvNo = 0xFF;
struct PreviewItem { const char* name; const Step* script; uint8_t careKind, noteKind; };
const PreviewItem kPreviews[] = {
  {"celebrate", kLevelUp, kPvNo, kPvNo}, {"levelup", kLevelUp, kPvNo, kPvNo}, {"milestone", kMilestone, kPvNo, kPvNo},
  {"morning", kGreetMorning, kPvNo, kPvNo}, {"day", kGreetDay, kPvNo, kPvNo}, {"evening", kGreetEvening, kPvNo, kPvNo},
  {"night", kGreetNight, kPvNo, kPvNo}, {"early", kGreetEarly, kPvNo, kPvNo},
  {"welcome", kWelcome, kPvNo, kPvNo}, {"welcomeshy", kWelcomeShy, kPvNo, kPvNo}, {"welcomemiss", kWelcomeMiss, kPvNo, kPvNo},
  {"miss", kSpMiss, kPvNo, kPvNo}, {"yawn", kSpYawn, kPvNo, kPvNo}, {"sneeze", kSpSneeze, kPvNo, kPvNo},
  {"star", kSpStar, kPvNo, kPvNo}, {"hum", kSpHumSoft, kPvNo, kPvNo}, {"doze", kSpDoze, kPvNo, kPvNo}, {"peek", kSpPeek, kPvNo, kPvNo},
  {"charge", kCharge, kPvNo, kPvNo}, {"full", kFull, kPvNo, kPvNo}, {"lowbatt", kLowBatt, kPvNo, kPvNo},
  {"lights", kLightsOff, kPvNo, kPvNo}, {"lightson", kLightsOn, kPvNo, kPvNo}, {"invite", kInvite, kPvNo, kPvNo},
  {"boundary", kBoundary, kPvNo, kPvNo}, {"shy", kTouchShy, kPvNo, kPvNo}, {"love", kTouchLove, kPvNo, kPvNo},
  {"comfort", kTouchComfort, kPvNo, kPvNo}, {"wakepet", kWakePet, kPvNo, kPvNo},
  // 2.8：关心提醒
  {"stretch", kCareStretch, care::K_STRETCH, kPvNo}, {"water", kCareWater, care::K_WATER, kPvNo},
  {"lunch", kCareMeal, care::K_LUNCH, kPvNo}, {"dinner", kCareMeal, care::K_DINNER, kPvNo},
  {"bedtime", kCareBedtime, care::K_BEDTIME, kPvNo}, {"carenudge", kCareNudge, care::K_STRETCH, kPvNo},
  {"ackstretch", kAckStretch, care::K_STRETCH, kPvNo}, {"ackwater", kAckWater, care::K_WATER, kPvNo},
  {"ackmeal", kAckMeal, care::K_LUNCH, kPvNo}, {"ackbedtime", kAckBedtime, care::K_BEDTIME, kPvNo},
  {"praisestretch", kPraiseStretch, care::K_STRETCH, kPvNo}, {"praisemeal", kPraiseMeal, care::K_LUNCH, kPvNo},
  {"hardwork", kPraiseDay, care::K_NONE, kPvNo}, {"goodsleep", kGoodSleep, kPvNo, kPvNo},
  // 2.8：任务提醒
  {"notice", kNoticeCue, kPvNo, care::N_DONE}, {"noticesoft", kNoticeCueSoft, kPvNo, care::N_DONE},
  {"taskdone", kTaskDone, kPvNo, care::N_DONE}, {"taskfailed", kTaskFailed, kPvNo, care::N_FAILED},
  {"remind", kNoticeRemind, kPvNo, care::N_REMIND}, {"praise", kNoticePraise, kPvNo, care::N_PRAISE},
  {"noticenudge", kNoticeNudge, kPvNo, care::N_DONE}, {"ackdone", kNoticeAckDone, kPvNo, care::N_DONE},
  {"ackfailed", kNoticeAckFailed, kPvNo, care::N_FAILED},
  // 2.9：看着你时的小反应
  {"microtilt", kMicroTilt, kPvNo, kPvNo}, {"microsmile", kMicroSmile, kPvNo, kPvNo}, {"microwiggle", kMicroWiggle, kPvNo, kPvNo},
  {"micronod", kMicroNod, kPvNo, kPvNo}, {"microspark", kMicroSpark, kPvNo, kPvNo}, {"micronote", kMicroNote, kPvNo, kPvNo},
  {"microlove", kMicroLove, kPvNo, kPvNo}, {"micropeek", kMicroPeek, kPvNo, kPvNo},
  // 2.9：主动邀请
  {"bidpet", kBidPet, kPvNo, kPvNo}, {"bidheart", kBidHeart, kPvNo, kPvNo}, {"bidnuzzle", kBidNuzzle, kPvNo, kPvNo},
  {"bidplay", kBidPlay, kPvNo, kPvNo}, {"bidshow", kBidShow, kPvNo, kPvNo},
  {"bidpetyes", kBidPetYes, kPvNo, kPvNo}, {"bidheartyes", kBidHeartYes, kPvNo, kPvNo},
  {"bidnuzzleyes", kBidNuzzleYes, kPvNo, kPvNo}, {"bidshowyes", kBidShowYes, kPvNo, kPvNo},
  // 2.9：躲猫猫 / 节奏游戏 / 深呼吸 / 跳舞
  {"peeksearch", kPeekSearch, kPvNo, kPvNo}, {"peekfound", kPeekFound, kPvNo, kPvNo},
  {"peekfoundmore", kPeekFoundMore, kPvNo, kPvNo}, {"peekgiveup", kPeekGiveUp, kPvNo, kPvNo},
  {"gameintro", kGameIntro, kPvNo, kPvNo}, {"gameperfect", kGamePerfect, kPvNo, kPvNo}, {"gamegood", kGameGood, kPvNo, kPvNo},
  {"gamemiss", kGameMiss, kPvNo, kPvNo}, {"gametimeout", kGameTimeout, kPvNo, kPvNo}, {"gamewin", kGameWin, kPvNo, kPvNo},
  {"gameend", kGameEnd, kPvNo, kPvNo}, {"gameendsoft", kGameEndSoft, kPvNo, kPvNo},
  {"breathintro", kBreathIntro, kPvNo, kPvNo}, {"breathdone", kBreathDone, kPvNo, kPvNo},
  {"dancesolo", kDanceSolo, kPvNo, kPvNo}, {"danceend", kDanceEnd, kPvNo, kPvNo}, {"dancetired", kDanceTired, kPvNo, kPvNo},
  // 2.9：心情打卡
  {"moodask", kMoodAsk, kPvNo, kPvNo}, {"mood5", kMood5, kPvNo, kPvNo}, {"mood4", kMood4, kPvNo, kPvNo},
  {"mood3", kMood3, kPvNo, kPvNo}, {"mood2", kMood2, kPvNo, kPvNo}, {"mood1", kMood1, kPvNo, kPvNo},
  {"moodweek", kMoodWeek, kPvNo, kPvNo}, {"moodcare", kMoodCare, kPvNo, kPvNo},
};

}  // namespace

// ============================== 对外接口 ==============================
void begin(pulse::Engine* eng, Planner* plan) {
  E = eng;
  P = plan;
  s_conversationOwned = s_conversationDispatch = false;
  s_facePresent = false;
  s_faceErrorX = s_faceErrorY = 0.f;
  memset(s_idx, -1, sizeof(s_idx));
  for (int i = 0; i < pulse::stateCount(); i++) {
    const int n = atoi(pulse::stateDef(i).id);
    if (n >= 0 && n < 42) s_idx[n] = (int8_t)i;
  }
  s_now = millis();
  s_lastActive = s_now;
  s_lastUser = s_now - 60000;
  s_lastGreet = s_now - 60000;
  s_nextSpont = s_now + 30000;
  // 2.7：陪伴（亲密度由 app 在开机后从 NVS 读回）
  companion::reset(s_aff);
  s_affStarted = false;
  s_touchDown = s_touchSession = s_touchBoundary = false;
  s_avertUntil = s_rainbowUntil = 0;
  s_faceArrival = s_faceEverSeen = false;
  s_pendLevel = s_pendGreet = s_pendWelcome = s_pendCharge = s_pendFull = s_pendLow = false;
  s_pendMilestone = -1;
  s_worldInit = false;
  // 2.8：关心提醒 / 任务提醒（等级和开关由 app 从设置里读回）
  const uint8_t level = s_care.level();
  s_care.reset(s_now);
  s_care.setLevel(level);
  s_inbox.reset();
  s_careTicked = false;
  s_touchEver = s_chatEver = s_nearEver = false;
  s_noticeValid = s_careShow = false;
  s_careKind = care::K_NONE;
  s_noteKind = care::N_DONE;
  s_ledColor = s_ledUntil = s_ledShow = 0;
  s_nextBell = 0;
  s_goodSleepKey = 0;
  s_label[0] = 0;
  s_labelOff = 0;
  // 2.9：一起玩（活跃度 / 听歌开关由 app 从设置里读回，心情记录从 NVS 读回）
  s_mode = PM_NONE;
  s_bids.reset(s_now);
  s_peek.reset();
  s_rhythm = play::Rhythm();
  s_tapSeq.reset();
  s_tapBad = false;
  s_checkIn.reset();
  s_bidTicked = false;
  s_bidAt = s_nextMicro = s_faceSession = 0;
  s_lastMicro = -1;
  s_showEver = false;
  s_showLast = 0;
  s_headDown = s_headMoved = s_headUsed = false;
  s_headSince = 0;
  s_gameArmed = s_gameEver = false;
  s_gameAt = s_gameEnd = 0;
  s_breathN = 0;
  s_breathCur = -1;
  s_breathInhale = false;
  s_breathT0 = 0;
  s_breathLevel = s_guideA = 0.f;
  s_moodStep = MS_DONE;
  s_moodTaps = 0;
  s_moodUntil = s_moodTapAt = s_moodHintAt = 0;
  s_listenUser = s_musicSeen = false;
  s_groove = G_IDLE;
  s_grooveUntil = s_nextListen = s_danceFrom = s_musicAt = 0;
  s_est = s_musicEst = s_lastEst = beat::Estimate();
  s_beatIdx = 0;
  s_segBeats = 0;
  s_tiredN = 0;
  s_tiredAt = 0;
  s_stats = PlayStats();
  s_text[0] = 0;
}

conversation::Hooks conversationHooks() {
  return conversation::Hooks{
    []() -> bool {
      if (!E || !P || !s_booted || s_kind == SK_BOOT) return false;
      s_now = millis();
      bidAccept(false);  // 2.9：它邀请你的时候你和它说话 = 接受了
      stopPlay("聊天");
      abortScript();
      s_settleAt = 0;
      s_petCount = 0;
      s_phase = PH_AWAKE;
      s_lastActive = s_now;
      s_chatLast = s_now;
      s_chatEver = true;
      s_conversationOwned = true;
      P->setIdle(false);
      P->setBreath(0, 4);
      E->clearFx();
      return true;
    },
    [](bool stopped) {
      s_now = millis();
      s_conversationOwned = false;
      abortScript();
      s_settleAt = 0;
      s_phase = PH_AWAKE;
      s_lastActive = s_lastUser = s_now;
      s_chatLast = s_now;
      s_chatEver = true;
      s_nextSpont = s_now + 30000;
      P->release(.4f);
      P->setBreath(0, 4);
      P->setIdle(!s_facePresent, 1.f);
      if (!s_facePresent) P->lookAt(0, -3, .6f);
      E->clearFx();
      goState(stopped ? 41 : 2, false, false);
      if (stopped) s_settleAt = s_now + 1200;
    },
    [](uint8_t semanticId, bool sound) {
      s_conversationDispatch = true;
      goState(semanticId, sound && semanticId != 39, false);
      s_conversationDispatch = false;
    },
    [](uint8_t action, float intensity) {
      if (!isfinite(intensity) || intensity < 0.f || intensity > 1.f ||
          action == A_NONE || action >= A_COUNT) return;
      if (isDirectionalAction(action)) {
        // The wall clock can advance during a synchronous command callback.
        // Never degrade an already expired direction to an ordinary held action.
        if (!conversation::directionalActionHeld(millis())) return;
        P->playDirection(action, intensity);
        s_sensQuiet = millis() + (uint32_t)(actDuration(action) * 1000.f) + 700;
      } else playAct(action, intensity);
    },
    []() { if (P) P->release(.4f); },
    []() { sfx::stopAmbient(); }
  };
}

const char* phaseName() {
  static const char* const k[3] = {"醒着", "犯困", "睡着"};
  return k[s_phase];
}
const char* phaseKey() {
  static const char* const k[3] = {"awake", "tired", "asleep"};
  return k[s_phase];
}

void boot() {
  s_booted = true;
  s_now = millis();
  s_lastActive = s_now;
  runScript(kBoot, SK_BOOT);
}

bool faceTrackingAllowed() { return E && P && s_booted && s_kind != SK_BOOT; }

void setFacePresence(bool present, float errorX, float errorY) {
  present = present && faceTrackingAllowed() && isfinite(errorX) && isfinite(errorY);
  const bool wasPresent = s_facePresent;
  s_facePresent = present;
  if (present) {  // 2.7：记下「来了」的时刻和上一次见到的时刻（用来判断久别重逢）
    const uint32_t t = millis();
    if (!wasPresent) {
      s_faceSince = t;
      s_faceAbsentFrom = s_faceEverSeen ? s_faceLastSeen : 0;
      s_faceArrival = true;
      s_nextMicro = 0;  // 2.9：重新看着你：小反应重新计时
      if (!s_faceEverSeen || t - s_faceLastSeen > 60000u) s_faceSession = t;
    }
    s_faceEverSeen = true;
    s_faceLastSeen = t;
  }
  if (!present) {
    s_faceErrorX = s_faceErrorY = 0.f;
    if (wasPresent && P && !s_conversationOwned && s_phase == PH_AWAKE && !s_scr) P->setIdle(true, 1.f);
    return;
  }
  s_now = millis();
  s_faceErrorX = clampf(errorX, -1.f, 1.f);
  s_faceErrorY = clampf(errorY, -1.f, 1.f);
  s_lastActive = s_now;
  s_nextSpont = s_now + 25000;
  P->setIdle(false);
  if (s_phase != PH_AWAKE) {
    // 有人出现在眼前：只恢复待机和一声轻提示，不抢占成套启动脚本。
    s_phase = PH_AWAKE;
    s_sleepSoon = false;
    stim(companion::ST_WAKE);
    s_settleAt = 0;
    s_nextSnore = 0;
    s_snores = 0;
    P->setBreath(0.f, 4.f);
    P->release(.4f);
    E->clearFx();
    goState(2, false, false);
    sfx::stopAmbient();
    sfx::play(sfx::C_EKKO_EYES_OPEN, .6f);
  }
}

void update(float dt, uint32_t now) {
  s_now = now;
  companionTick();
  if (s_labelOff && due(s_labelOff)) {  // 标题演完：关掉（平时脸上不显示文字）
    s_labelOff = 0;
    if (E) E->setLabelsEnabled(false);
  }
  if (s_conversationOwned) {
    s_lastActive = now;
    s_peek.update(now, s_facePresent, false, false, s_level);  // 2.9：聊天时不玩躲猫猫（只记你在不在）
    careTick();  // 聊天时只记「你在」，不演
    guideTick(dt);
    eyes();
    return;
  }
  tickScript();
  playTick(dt);  // 2.9：游戏 / 跳舞 / 深呼吸 / 打卡 / 连拍 / 按住头顶
  lifeUpdate();
  if (s_booted && s_kind != SK_BOOT) {
    companionFace();
    companionPerform();
    careTick();
    companionGaze();
    livelyTick();  // 2.9：躲猫猫 / 主动邀请 / 看着你时的小反应
  }
  eyes();
}

void goState(int num, bool sound, bool motionOn, bool label) {
  if (s_conversationOwned && !s_conversationDispatch) return;
  if (num < 0 || num > 41 || s_idx[num] < 0) return;
  const int idx = s_idx[num];
  E->setState(idx);
  const pulse::StateDef& d = pulse::stateDef(idx);
  sfx::onState(d.id, sound);
  if (motionOn) {
    const uint8_t a = actForState(num);
    if (a != A_NONE) playAct(a);
    else P->release(.6f);
  }
  if (label) {
    char buf[40];
    snprintf(buf, sizeof(buf), "%s  %s", d.id, d.name);
    E->setLabel(buf, 2500);
  }
  s_stateNum = num;
  Serial.printf("[state] %s %s\n", d.id, d.name);
}

void act(uint8_t a, float scale, float dir) {
  if (s_conversationOwned) return;
  if (a == A_NONE || a >= A_COUNT) return;
  s_now = millis();
  abortScript();
  playAct(a, scale, dir);
  s_settleAt = s_now + (uint32_t)(actDuration(a) * 1000.f) + 1500;
}

// 生活模式本地触摸的表情（导演层的「开心」和「摸太多」）。2.7：
// · 会把它叫醒（以前只换了表情，实际还在睡、还会打呼）；记亲密度和心情
// · 按熟悉程度和心情换不同的反应（害羞 / 开心 / 眯眼信任 / 被安慰）
// · 只换表情和眼神，不做头部动作；声音只在开头且很短（不挡「摸太多」的语音）；夜里不出声
// 2.8：摸一下也是「知道啦 / 收到」；提醒 / 庆祝还没演完时不打断
bool localTouchVisual(bool playfulBoundary, uint32_t now, uint32_t durationMs) {
  if (s_conversationOwned || !faceTrackingAllowed()) return false;
  (void)durationMs;
  s_now = now;
  if (touchCaptured()) return true;  // 2.9：正在玩节奏游戏 / 心情打卡 / 深呼吸：这一下归它们（noteTouch 里处理）
  touchMark(now);
  if (s_mode == PM_DANCE) danceEnd(DE_ABORT);  // 跳舞时摸它：不跳了，正常地回应你
  const bool quiet = nightNow();
  if (playfulBoundary) {
    s_touchBoundary = true;
    stim(companion::ST_OVERTOUCH);
    abortScript();
    engage();
    runScript(kBoundary, SK_REACT, true);  // 语音由导演层负责，这里不出声
    return true;
  }
  if (tryAck(true)) return true;
  if (s_scr && s_kind == SK_CARE) return true;
  if (s_phase != PH_AWAKE) {  // 睡着 / 犯困：这一下先把它叫醒
    const bool wasSleep = s_phase == PH_SLEEP;
    s_phase = PH_AWAKE;
    s_sleepSoon = false;
    s_nextSnore = 0;
    s_snores = 0;
    stim(companion::ST_WAKE);
    abortScript();
    runScript(wasSleep ? kWakePet : kPerkUp, SK_REACT, quiet);
    Serial.println(wasSleep ? "[life] 被摸醒了" : "[life] 被摸了一下，精神了");
    return true;
  }
  if (bidAccept(true)) return true;  // 2.9：它正在邀请你：摸它 = 接受
  abortScript();
  engage();
  const uint8_t lv = bondLevel(), t = tone();
  const Step* sc = kTouchHappy;
  if (t == companion::T_GRUMPY || t == companion::T_LONELY) sc = kTouchComfort;
  else if (t == companion::T_SLEEPY) sc = kTouchSleepy;
  else if (lv <= 1 && random(100) < 70) sc = kTouchShy;
  else if (lv >= 4 && random(100) < 60) sc = kTouchLove;
  runScript(sc, SK_REACT, quiet);
  return true;
}

void onSensors(uint8_t ev) {
  if (!ev) return;
  if (ev & sensors::SE_NEAR) {  // 2.8：记下「有人在」（关心提醒用）
    s_nearLast = millis();
    s_nearEver = true;
  }
  if (ev & sensors::SE_DARK) stim(companion::ST_DARK);
  if (ev & sensors::SE_LIGHT) stim(companion::ST_LIGHT);
  if (s_conversationOwned) return;
  if (s_kind == SK_BOOT) return;
  // 2.7：关灯 / 开灯
  if (ev & sensors::SE_DARK) {
    if (s_mode == PM_RHYTHM || s_mode == PM_MOOD || s_mode == PM_DANCE || s_groove == G_LISTEN) stopPlay("关灯了");  // 2.9：深呼吸不停
    const bool late = nightNow() || (s_world.clock.valid && s_world.clock.hour >= 21);
    if (late && s_care.awaitingKind(s_now) == care::K_BEDTIME) s_care.ack(s_now);  // 提醒睡觉后关灯 = 听话了
    const bool idleScr = idleScriptNow();  // 2.9：正在自己玩：先停下来（以前会错过「关灯」的反应）
    if (s_phase == PH_AWAKE && (!s_scr || idleScr) && !s_touchDown && !s_facePresent) {
      if (idleScr) abortScript();
      if (late && goodSleepNow()) {  // 2.8：早早关灯睡觉，乖（每晚一次）
        s_goodSleepKey = nightKey();
        s_care.bedtimeDone();
        s_careKind = care::K_BEDTIME;
        s_ledColor = careColor(care::K_BEDTIME);
        runScript(kGoodSleep, SK_CARE);
        Serial.println("[care] 早早关灯睡觉，乖");
      } else {
        runScript(late ? kLightsOffNight : kLightsOff, SK_REACT);
      }
      if (late) s_sleepSoon = true;
    } else if (late) s_sleepSoon = true;
  }
  if (ev & sensors::SE_LIGHT) {
    s_sleepSoon = false;
    const bool morning = s_world.clock.valid && companion::period(s_world.clock.hour) == companion::PD_MORNING;
    if (s_phase == PH_SLEEP) {
      if (morning) {  // 早上开灯 / 天亮：伸个懒腰醒来
        s_phase = PH_AWAKE;
        s_lastActive = s_now;
        s_nextSpont = s_now + 25000 + random(30000);
        stim(companion::ST_WAKE);
        P->setBreath(0, 4);
        abortScript();
        runScript(kWakeMorning, SK_REACT);
        Serial.println("[life] 天亮了，醒啦");
      } else {
        E->emit(pulse::FX_Z, 1);  // 夜里开灯：翻个身，接着睡
      }
    } else if (s_phase == PH_AWAKE && !s_scr && !s_touchDown && !nightNow()) {
      runScript(kLightsOn, SK_REACT);
    }
  }
  const bool quiet = !due(s_sensQuiet) || P->busy();
  if ((ev & sensors::SE_SHAKE) && !quiet) {
    stopPlay("被摇了");
    stim(companion::ST_SHAKE);
    s_lastUser = s_now;
    s_lastActive = s_now;
    if (s_phase == PH_SLEEP) { wakeIfNeeded(W_JOLT); return; }
    wakeIfNeeded(W_JOLT);
    abortScript();
    runScript(kDizzy, SK_REACT);  // 晕～
    return;
  }
  if ((ev & sensors::SE_JOLT) && !quiet) {
    stopPlay("吓了一跳");
    stim(companion::ST_JOLT);
    s_lastUser = s_now;
    if (wakeIfNeeded(W_JOLT)) return;
    abortScript();
    engage(1.6f);
    goState(13, false, false);  // 吓一跳
    sfx::play(sfx::C_TRACK_SURPRISE);
    playAct(A_SURPRISE);
    E->emit(pulse::FX_EXCLAIM);
    s_settleAt = s_now + 2000;
    return;
  }
  if (ev & sensors::SE_NEAR) {
    if (s_phase == PH_SLEEP && nightNow()) { E->emit(pulse::FX_Z, 1); return; }  // 2.7：夜里有人走过不叫醒它
    if (s_phase != PH_AWAKE) { wakeIfNeeded(W_NEAR); s_lastUser = s_now; return; }
    const bool greet = !s_scr && !s_settleAt && s_now - s_lastUser > 20000 && s_now - s_lastGreet > 30000;
    s_lastActive = s_now;
    if (greet) {
      s_lastGreet = s_now;
      s_lastUser = s_now;
      stim(companion::ST_NEAR);
      bondEvent(companion::B_NEAR);
      runScript(kGreet, SK_REACT, nightNow());  // 有人来了：是你呀！
    }
  }
}

// 按键：先当作「知道啦 / 收到」；没有在等的就是戳一下（B = 摸摸头）
void onButton(uint8_t b) {
  if (s_conversationOwned) return;
  s_now = millis();
  s_lastUser = s_now;
  if (!s_booted || s_kind == SK_BOOT) return;
  s_touchLast = s_now;
  s_touchEver = true;
  if (playTouch(0, false)) return;  // 2.9：玩游戏 / 打卡时按键 = 拍一下；深呼吸时 = 不做了
  if (tryAck(true)) return;
  if (bidAccept(true)) return;
  if (b == 1) pet();
  else poke();
}

void poke() {
  if (s_conversationOwned) return;
  s_now = millis();
  s_lastUser = s_now;
  if (wakeIfNeeded(W_TOUCH)) return;
  tapReact(random(2) ? 1.f : -1.f);
}

void pet() {
  if (s_conversationOwned) return;
  s_now = millis();
  s_lastUser = s_now;
  if (wakeIfNeeded(W_TOUCH)) return;
  if (s_now - s_lastStroke > 2500) s_petCount = 0;
  s_lastStroke = s_now;
  petReact(random(2) ? 1.f : -1.f);
  s_settleAt = s_now + 2200;
}

void sleepNow() {
  if (s_conversationOwned) return;
  s_now = millis();
  s_lastActive = s_now - PULSE_SLEEP_MS - 1;
  fallAsleep();
}

void wakeNow() {
  if (s_conversationOwned) return;
  s_now = millis();
  if (!wakeIfNeeded(W_TOUCH)) poke();
}

// ============================== 2.7 陪伴：对外接口 ==============================
void setWorld(const companion::World& w) {
  const bool first = !s_worldInit;
  s_worldInit = true;
  s_world = w;
  if (!w.battOk) return;
  const uint32_t t = millis();
  if (first) {
    s_chargeWas = w.charging;
    s_fullArmed = !(w.charging && w.battery >= 100);
  }
  if (w.charging && !s_chargeWas) {  // 插上电
    stim(companion::ST_CHARGE);
    s_pendCharge = true;
    s_pendLow = false;
    s_pendAt = t;
    s_lowArmed = true;
  }
  if (!w.charging && s_chargeWas) s_pendCharge = s_pendFull = false;  // 拔掉了
  s_chargeWas = w.charging;
  if (w.charging && w.battery >= 100 && s_fullArmed) {  // 充满
    s_fullArmed = false;
    s_pendFull = true;
    s_pendAt = t;
  }
  if (w.battery >= 0 && w.battery <= 95) s_fullArmed = true;
  if (!w.charging && w.battery >= 0 && w.battery <= 15 && s_lowArmed) {  // 快没电了（每次放电只说一次）
    s_lowArmed = false;
    s_pendLow = true;
    s_pendAt = t;
  }
  if (w.charging || w.battery >= 25) s_lowArmed = true;
}

void touchContact(bool down, uint32_t now) {
  if (down) {
    s_lastActive = now;
    s_touchLast = now;
    s_touchEver = true;
  }
  s_touchDown = down;
}

void noteTouch(uint8_t g, uint32_t now, bool head) {
  if (s_conversationOwned || !s_booted || s_kind == SK_BOOT) return;
  s_now = now;
  if (head && g == 1) s_headMoved = true;  // 2.9：在头顶滑来滑去 = 不是「按住不动」
  touchMark(now);
  if (playTouch(g, head)) return;   // 2.9：正在玩：归游戏 / 打卡 / 深呼吸
  if (s_phase != PH_AWAKE) return;  // 叫醒由 localTouchVisual 负责
  if (tryAck(true)) return;         // 2.8：摸一下 = 知道啦 / 收到
  if (bidAccept(true)) return;      // 2.9：它在邀请你：摸 / 点 = 接受
  if (g == 0) {  // 2.9：连拍手势（这一组里有叫醒它的那一下：整组不算）
    if (s_scr == kWakePet || s_scr == kPerkUp) s_tapBad = true;
    s_tapSeq.tap(now);
  }
  const bool quiet = nightNow();
  const bool busy = touchScriptBusy();
  if (g == 1) {  // 摸
    stim(companion::ST_STROKE);
    if (s_touchPets < 6) {
      s_touchPets++;
      bondEvent(companion::B_PET);
    }
    if (s_touchBoundary) {  // 已经「放开我」了：继续傲娇，眼睛别开
      if (!s_scr) {
        goState(18, false, false);
        avert(.8f, .2f, 900);
        s_settleAt = now + 1800;
      }
      return;
    }
    s_touchStrokes++;
    if (busy) {
      if (s_touchStrokes == 2) E->emit(pulse::FX_HEART, 1);
      return;
    }
    abortScript();
    switch (s_touchStrokes) {
      case 1: goState(bondLevel() <= 1 ? 14 : 19, false, false); break;  // 脸红 / 舒服
      case 2: goState(19, false, false); E->emit(pulse::FX_HEART, 1); break;
      default:
        goState(19, false, false);
        E->blink(.6f);  // 眯起眼睛慢慢眨
        if (bondLevel() >= 4) E->emit(pulse::FX_HEART, 1);
        break;
    }
    s_settleAt = now + 2200;
    return;
  }
  if (g == 2) {  // 按住不动：安心
    stim(companion::ST_HOLD);
    bondEvent(companion::B_HOLD);
    if (s_touchBoundary || busy) return;
    abortScript();
    goState(19, false, false);
    E->blink(.8f);
    E->emit(pulse::FX_HEART, bondLevel() >= 2 ? 2 : 1);
    s_settleAt = now + 3000;
    return;
  }
  // 点：连着点越来越「有意见」（开心 → 害羞 → 嗯？ → ！ → 哼）
  if (now - s_lastTapAt > 1500) s_touchTaps = 0;
  s_lastTapAt = now;
  if (++s_touchTaps == 1 || s_touchBoundary || busy) return;  // 第一下：开头的反应已经有了
  abortScript();
  switch (s_touchTaps) {
    case 2:
      goState(10, false, false);
      E->pulse();
      E->kick(pulse::I_HOP);
      if (!quiet) sfx::onTap();
      s_settleAt = now + 1500;
      break;
    case 3:
      goState(14, false, false);
      if (!quiet) sfx::play(sfx::C_EKKO_HAPPY, .6f);
      s_settleAt = now + 1800;
      break;
    case 4:
      goState(11, false, false);
      E->emit(pulse::FX_QUESTION);
      if (!quiet) sfx::play(sfx::C_TRACK_HM, .6f);
      s_settleAt = now + 2000;
      break;
    case 5:
      goState(13, false, false);
      E->emit(pulse::FX_EXCLAIM);
      if (!quiet) sfx::play(sfx::C_HOME_SURPRISE, .7f);
      s_settleAt = now + 1800;
      break;
    default:
      s_touchTaps = 0;
      goState(18, false, false);
      avert(.85f, .2f, 1200);
      if (!quiet) sfx::synth(sfx::S_POUT);
      stim(companion::ST_OVERTOUCH, .5f);
      s_settleAt = now + 2200;
      break;
  }
}

void touchPout(uint32_t now) {
  if (s_conversationOwned) return;
  s_now = now;
  if (!nightNow()) sfx::synth(sfx::S_POUT);
}

void noteChat() {
  s_now = millis();
  stim(companion::ST_CHAT);
  bondEvent(companion::B_CHAT);
  visitToday(false);  // 第一次见面就是聊天：记一天，但不另外演打招呼
  s_lastUser = s_lastActive = s_now;
  s_chatLast = s_now;
  s_chatEver = true;
  s_sleepSoon = false;
  tryAck(false);  // 2.8：和它说话也算「知道啦 / 收到」（不另外演，那边正在聊）
}

const companion::Affect& affect() { return s_aff; }
const companion::Bond& bond() { return s_bond; }
const companion::World& world() { return s_world; }
bool bondLoad(const void* blob, size_t n) { return s_bond.load(blob, n); }
const companion::BondData& bondSave() { return s_bond.save(); }
bool bondDirty() { return s_bond.dirty(); }
bool bondUrgent() { return s_bond.urgent(); }
void bondClean() { s_bond.clean(); }
uint32_t bondToday() { return s_world.clock.valid ? s_world.clock.day : 0; }

// ============================== 2.8 陪伴版：对外接口 ==============================
void setCareLevel(uint8_t level) {
  const uint8_t was = s_care.level();
  s_care.setLevel(level);
  if (s_care.level() != was) Serial.printf("[care] 关心提醒：%s\n", care::levelName(s_care.level()));
}
uint8_t careLevel() { return s_care.level(); }

void setNotifyEnabled(bool on) {
  if (s_notifyOn != on) Serial.printf("[notify] 任务提醒：%s\n", on ? "开" : "关");
  s_notifyOn = on;
  if (!on) s_inbox.clear();
}
bool notifyEnabled() { return s_notifyOn; }

uint8_t notify(uint8_t kind, const char* title, const char* source, const char* id, bool* truncated) {
  if (truncated) *truncated = false;
  if (!s_notifyOn) return care::P_INVALID;  // app 先看 notifyEnabled()（关着 = 409）
  const uint32_t now = millis();
  const uint8_t r = s_inbox.push(kind, title, source, id, now, truncated);
  const care::Notice* q = s_inbox.latest();
  if (r == care::P_QUEUED || r == care::P_REPLACED)
    Serial.printf("[notify] 收到%s「%s」%s%s%s\n", care::noticeName(kind), q ? q->title : "",
                  q && q->source[0] ? "（来自 " : "", q && q->source[0] ? q->source : "", q && q->source[0] ? "）" : "");
  else
    Serial.printf("[notify] 没收（%s）\n", care::pushKey(r));
  return r;
}

bool acknowledge() {
  if (s_conversationOwned) return false;
  s_now = millis();
  return tryAck(true);
}

const care::Planner& carePlanner() { return s_care; }
const care::Inbox& noticeInbox() { return s_inbox; }

const char* careLast(uint32_t now, uint32_t* ago) {
  const uint8_t k = s_care.lastKind();
  if (ago) *ago = k == care::K_NONE ? care::kNever : s_care.sinceLast(now);
  return k == care::K_NONE ? "none" : care::kindKey(k);
}

uint8_t ledEffect(uint32_t now) {
  if (s_rainbowUntil) {
    if ((int32_t)(now - s_rainbowUntil) < 0) return LE_RAINBOW;
    s_rainbowUntil = 0;
  }
  if (s_conversationOwned) return LE_NONE;
  if (s_ledUntil) {  // 正在提醒 / 回应：这一种的颜色
    if ((int32_t)(now - s_ledUntil) < 0) {
      s_ledShow = s_ledColor;
      return LE_CARE;
    }
    s_ledUntil = 0;
  }
  if (s_mode == PM_BREATH) {  // 2.9：一起深呼吸：青色，吸气变亮、呼气变暗
    s_ledShow = kBreathTeal;
    return LE_BREATH;
  }
  if (s_mode == PM_DANCE && s_groove == G_DANCE) {  // 2.9：跟着节拍闪，每拍换个颜色
    s_ledShow = beatColor();
    return LE_BEAT;
  }
  if (s_notifyOn && s_inbox.hasNew()) {  // 有消息还没看：琥珀色慢慢呼吸
    s_ledShow = kNoticeAmber;
    return LE_NOTICE;
  }
  const uint8_t k = s_care.awaitingKind(now);
  if (k != care::K_NONE) {  // 刚提醒过，等你回应
    s_ledShow = careColor(k);
    return LE_CARE;
  }
  if (s_phase == PH_SLEEP) return LE_SLEEP;
  return LE_NONE;
}

uint32_t ledColor() { return s_ledShow; }

float ledLevel(uint32_t now) {
  if (s_mode == PM_BREATH) return .12f + .88f * clampf(s_breathLevel, 0.f, 1.f);
  if (s_mode == PM_DANCE && s_groove == G_DANCE && s_est.periodMs) {
    const float ph = beat::beatPhase(s_est, now);
    const float f = ph - floorf(ph);
    return .15f + .85f * expf(-4.f * f);
  }
  return 1.f;
}

bool preview(const char* n) {
  if (!n || !*n || s_conversationOwned || !s_booted || !E || !P || s_kind == SK_BOOT) return false;
  s_now = millis();
  if (!strcmp(n, "goodnight")) {
    fallAsleep(true);
    return true;
  }
  const Step* sc = nullptr;
  const PreviewItem* it = nullptr;
  if (!strcmp(n, "greet")) sc = greetScript();
  else
    for (const PreviewItem& p : kPreviews)
      if (!strcmp(n, p.name)) { it = &p; sc = p.script; break; }
  if (!sc) return false;
  stopPlay("预览");
  if (s_phase != PH_AWAKE) {
    s_phase = PH_AWAKE;
    s_sleepSoon = false;
    P->setBreath(0, 4);
  }
  uint8_t kind = SK_REACT;
  if (it && it->careKind != kPvNo) {
    s_careKind = it->careKind;
    s_ledColor = careColor(s_careKind);
    kind = SK_CARE;
  }
  if (it && it->noteKind != kPvNo) {
    s_noteKind = it->noteKind;
    s_ledColor = (sc == kNoticeCue || sc == kNoticeCueSoft) ? kNoticeAmber : noticeColor(s_noteKind);
    snprintf(s_label, sizeof s_label, "预览：%s", care::noticeName(s_noteKind));
    kind = SK_CARE;
  }
  abortScript();
  s_lastActive = s_now;
  runScript(sc, kind);
  if (const char* t = previewText(n)) showText(t, 3000);
  return true;
}

const char* previewNames() {
  static char buf[2048];
  if (buf[0]) return buf;
  size_t n = 0;
  const int r0 = snprintf(buf, sizeof buf, "greet goodnight");
  if (r0 > 0) n = (size_t)r0;
  for (const PreviewItem& p : kPreviews) {
    if (n + 1 >= sizeof buf) break;
    const int r = snprintf(buf + n, sizeof buf - n, " %s", p.name);
    if (r < 0 || (size_t)r >= sizeof buf - n) {
      buf[n] = 0;
      break;
    }
    n += (size_t)r;
  }
  return buf;
}

// ============================== 2.9 活泼版：对外接口 ==============================
void setLively(uint8_t level) {
  if (level >= play::LV_COUNT) level = play::LV_LIVELY;
  if (level == s_level) return;
  s_level = level;
  if (level == play::LV_QUIET && s_bids.waiting(s_now)) s_bids.cancel();
  s_nextMicro = 0;
  Serial.printf("[play] 活跃度：%s\n", play::levelName(level));
}
uint8_t lively() { return s_level; }

void headContact(bool down, uint32_t now) {
  if (down && !s_headDown) {  // 刚放上来：重新计时
    s_headSince = now;
    s_headMoved = s_headUsed = false;
  }
  s_headDown = down;
}

bool touchCaptured() { return s_mode == PM_RHYTHM || s_mode == PM_MOOD || s_mode == PM_BREATH; }

void setMusicEnabled(bool on) {
  if (s_musicOn != on) Serial.printf("[music] 听歌跳舞：%s\n", on ? "开" : "关");
  s_musicOn = on;
  if (!on) {
    s_now = millis();
    musicOff();
  }
}
bool musicEnabled() { return s_musicOn; }

void setMusicAvailable(bool ok) {
  if (ok == s_musicAvail) return;
  s_musicAvail = ok;
  if (!ok) {
    s_now = millis();
    musicOff();
  }
}

bool musicListenWanted() { return musicOk() && (s_groove == G_LISTEN || s_groove == G_PAUSE); }

// 两次分析的速度差不多（跳到一半停下来听：还是同一首）
bool sameTempo(const beat::Estimate& a, const beat::Estimate& b) {
  if (!a.periodMs || !b.periodMs) return false;
  const float r = (float)a.periodMs / (float)b.periodMs;
  return r > .96f && r < 1.04f;
}

void setBeat(const beat::Estimate& e, uint32_t now) {
  s_now = now;
  s_lastEst = e;
  if (e.music) {
    s_musicSeen = true;
    s_musicAt = now;
    s_musicEst = e;
  }
  if (!musicOk() || s_conversationOwned) return;
  if (s_groove == G_LISTEN) {
    if (!e.music) return;
    if (s_listenUser ? s_mode == PM_DANCE : listenOk()) danceBegin(e);
    return;
  }
  if (s_groove == G_PAUSE && s_mode == PM_DANCE) {
    const bool similar = e.frames >= beat::kMinFrames && e.level >= beat::kMinRms && e.confidence >= .3f && sameTempo(e, s_est);
    if (e.music || similar) danceBegin(e.music ? e : s_est);
  }
}

bool dance() {
  s_now = millis();
  serialWake();
  if (!playStartOk() || s_mode != PM_NONE) return false;
  danceNow();
  return s_mode == PM_DANCE || s_scr == kDanceSolo;
}

bool rhythmStart() {
  s_now = millis();
  serialWake();
  return gameStart("串口");
}

bool breathe(uint8_t minutes) {
  s_now = millis();
  serialWake();
  const uint8_t n = minutes ? (uint8_t)(6u * (minutes > 3 ? 3u : minutes)) : 6u;
  return breathStart(n, "串口");
}

bool stopPlaying() {
  s_now = millis();
  const bool any = s_mode != PM_NONE || s_groove == G_LISTEN || s_groove == G_DANCE || s_groove == G_PAUSE;
  if (!any || s_conversationOwned) return false;
  stopPlay("串口");
  if (E && P && s_booted && s_kind != SK_BOOT) {
    abortScript();
    settle();
  }
  return true;
}

const char* playKey() {
  static const char* const k[5] = {"none", "rhythm", "dance", "breath", "mood"};
  return s_mode < 5 ? k[s_mode] : "none";
}
const char* grooveKey() {
  static const char* const k[5] = {"idle", "listen", "dance", "pause", "rest"};
  return s_groove < 5 ? k[s_groove] : "idle";
}
const beat::Estimate& lastBeat() { return s_lastEst; }
uint32_t musicAgo(uint32_t now) {
  if (!s_musicSeen) return play::kNever;
  const int32_t d = (int32_t)(now - s_musicAt);
  return d > 0 ? (uint32_t)d : 0u;
}
PlayStats playStats() { return s_stats; }
const play::Bids& bids() { return s_bids; }
const play::Peekaboo& peekaboo() { return s_peek; }
const play::Rhythm& rhythm() { return s_rhythm; }

bool moodLoad(const void* blob, size_t n) { return s_mood.load(blob, n); }
const play::MoodData& moodSave() { return s_mood.save(); }
bool moodDirty() { return s_mood.dirty(); }
void moodClean() { s_mood.clean(); }
const play::MoodLog& moodLog() { return s_mood; }

bool moodAsk() {
  s_now = millis();
  serialWake();
  return moodAskNow("串口");
}

bool moodSet(uint8_t score) {
  const uint32_t day = moodDay();
  if (score < 1 || score > 5 || !day) return false;
  s_now = millis();
  if (s_mode == PM_MOOD && s_moodStep == MS_ASK) {  // 正在问：就当你拍了这么多下
    s_moodTaps = score;
    s_moodTapAt = s_now - 1600;
    s_moodHintAt = 0;
    return true;
  }
  s_mood.add(day, score);
  Serial.printf("[mood] 记下了：今天 %u 分（最近 7 天平均 %.1f）\n", (unsigned)score, s_mood.average(day));
  return true;
}

void moodClear() {
  s_mood.clear();
  Serial.println("[mood] 心情记录清空了");
}

}  // namespace brain
