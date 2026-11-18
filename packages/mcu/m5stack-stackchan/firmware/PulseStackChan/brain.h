#pragma once
// 脉冲 Pulse · 「性格」（原创代码）
// 2.8 陪伴版：只保留生活模式——像宠物一样自己玩、犯困、睡觉，对触摸 / 摇晃 / 靠近 / 光线有反应；
// 会主动关心你（起来活动、喝水、吃饭、早点睡），Ekko Studio 有任务完成了会叫你、会夸你。
// 2.9 活泼版：看着你时的小反应、主动找你玩、躲猫猫、节奏游戏、连拍手势、听歌跳舞、一起深呼吸、每晚心情打卡。
#include <stddef.h>
#include <stdint.h>
#include "pulse_engine.h"
#include "motion.h"
#include "conversation.h"
#include "companion.h"
#include "care.h"
#include "play.h"
#include "beat.h"

namespace brain {

void begin(pulse::Engine* eng, motion::Planner* plan);
conversation::Hooks conversationHooks();  // Bind once after brain::begin().

void boot();                       // 开机：描边动画 + 开机提示音 + 抬头左右看一眼
// 仅主循环调用：误差为归一化图像坐标，右/下为正。头部目标由独立跟踪控制器更新。
void setFacePresence(bool present, float errorX = 0.f, float errorY = 0.f);
// 启动动画拥有头部控制权；设置/校准还须由 app 显式暂停跟踪。
bool faceTrackingAllowed();

void update(float dt, uint32_t now);  // 每帧调用（在 planner.update 之前）

// ---- 输入 ----
bool localTouchVisual(bool playfulBoundary, uint32_t now, uint32_t durationMs);  // 本地触摸开始（导演层的「开心」/「摸太多」）
void onSensors(uint8_t seEvents);            // 摇晃 / 撞击 / 靠近 / 光线（sensors::SE_*）
void onButton(uint8_t b);                    // 0 = A，1 = B，2 = C，3 = 电源键（单击）：先当作「知道啦 / 收到」

// ---- 串口 / 设置里用 ----
void goState(int stateNum, bool sound = true, bool motion = true, bool label = false);
void act(uint8_t a, float scale = 1.f, float dir = 1.f);
void poke();
void pet();
void sleepNow();
void wakeNow();
const char* phaseName();           // 醒着 / 犯困 / 睡着
const char* phaseKey();            // awake / tired / asleep（状态接口用）

// ---- 2.7 情绪价值版：陪伴（心情 + 亲密度 + 时间 / 光线 / 电量）----
void setWorld(const companion::World& w);      // app 每秒左右更新一次（时钟、夜间、光线、电量）
void touchContact(bool down, uint32_t now);    // 本地触摸：手还在不在（每帧）
// 本地触摸的每个手势（0 = 点、1 = 摸、2 = 按住）。只做表情和眼神，不动头、不抢播报
// 2.9：head = 来自头顶的触摸条（摸头滑动会打断「按住头顶深呼吸」；玩节奏游戏时拍头也算）
void noteTouch(uint8_t gesture, uint32_t now, bool head = false);
void touchPout(uint32_t now);                  // 「摸太多」的边界没有配套语音时（冷却中）：自己小声「哼」一下
void noteChat();                               // 和它说了一句话（已成功提交）
const companion::Affect& affect();
const companion::Bond& bond();
const companion::World& world();
bool bondLoad(const void* blob, size_t n);     // 开机从 NVS 读回（校验失败 = 保持初始）
const companion::BondData& bondSave();         // 取出要写入 NVS 的数据（含校验）
bool bondDirty();
bool bondUrgent();
void bondClean();
uint32_t bondToday();                          // 今天（真实日期序号；不知道 = 0）

// ---- 2.8 陪伴版：会关心人 + 任务提醒 ----
void setCareLevel(uint8_t level);              // care::L_OFF / L_LESS / L_ON
uint8_t careLevel();
void setNotifyEnabled(bool on);                // 关掉 = 不收任务提醒（/api/notify 返回 409）
bool notifyEnabled();
// Ekko Studio / 本机脚本送来一条（care::N_*）。返回 care::P_*；truncated = 标题太长被截断了
uint8_t notify(uint8_t kind, const char* title, const char* source, const char* id, bool* truncated = nullptr);
bool acknowledge();                            // 「知道啦 / 收到」：有在等回应的就回应；有没看过的消息就马上演给你看
const care::Planner& carePlanner();
const care::Inbox& noticeInbox();
const char* careLast(uint32_t now, uint32_t* agoMs = nullptr);  // 最近一次关心提醒的种类（care::kindKey），没有 = "none"

// ---- 2.9 活泼版：一起玩 ----
void setLively(uint8_t level);                 // play::LV_QUIET / LV_NORMAL / LV_LIVELY（安静 = 和 2.8 一样）
uint8_t lively();
void headContact(bool down, uint32_t now);     // 头顶的手还在不在（每帧）。按住不动 3.5 秒 = 一起深呼吸
bool touchCaptured();                          // 正在玩节奏游戏 / 心情打卡 / 深呼吸：触摸归它们（导演层先别反应）
void setMusicEnabled(bool on);                 // 听歌跳舞开关（关 = 不碰麦克风）
bool musicEnabled();
void setMusicAvailable(bool ok);               // app：现在有没有麦克风可以用来听节拍
bool musicListenWanted();                      // 现在想听环境声音（app 据此开关 voice_audio::setAmbient）
void setBeat(const beat::Estimate& e, uint32_t now);  // app：有新的节拍分析结果（这一次收音的）
bool dance();                                  // 跳一段（连拍两下 / 串口）：在放歌就跟着节拍跳，没放歌就自己「啦啦啦」
bool rhythmStart();                            // 节奏游戏（连拍三下 / 接受「一起玩」/ 串口）
bool breathe(uint8_t minutes);                 // 一起深呼吸：1–3 分钟（每分钟 6 次：吸 4 秒、呼 6 秒）；0 = 一轮 6 次
bool stopPlaying();                            // 串口：停下正在玩的
const char* playKey();                         // none / rhythm / dance / breath / mood
const char* grooveKey();                       // idle / listen / dance / pause / rest（听歌跳舞的状态）
const beat::Estimate& lastBeat();              // 最近一次收到的节拍分析
uint32_t musicAgo(uint32_t now);               // 多久以前听到过音乐（毫秒；没有 = play::kNever）
struct PlayStats {
  uint32_t games = 0, gameWins = 0, dances = 0, musicDances = 0, breaths = 0, moodAsks = 0, micro = 0;
};
PlayStats playStats();
const play::Bids& bids();
const play::Peekaboo& peekaboo();
const play::Rhythm& rhythm();
// 心情打卡（每晚 19:30–22:00 看见你时问一次「今天心情几分？」，拍 1–5 下回答；记最近 7 天）
bool moodLoad(const void* blob, size_t n);     // 开机从 NVS 读回（校验失败 = 保持空）
const play::MoodData& moodSave();
bool moodDirty();
void moodClean();
const play::MoodLog& moodLog();
bool moodAsk();                                // 串口：现在就问
bool moodSet(uint8_t score);                   // 串口：今天几分（1–5，需要已对时）
void moodClear();

enum : uint8_t { LE_NONE = 0, LE_RAINBOW, LE_SLEEP, LE_NOTICE, LE_CARE, LE_BEAT, LE_BREATH };
uint8_t ledEffect(uint32_t now);               // 机身灯效：彩虹（庆祝）/ 睡觉呼吸 / 有消息（琥珀色呼吸）/ 关心提醒（按种类的颜色）
                                               // 2.9：跟着节拍闪（LE_BEAT）/ 深呼吸（LE_BREATH，青色，跟着吸气变亮）
uint32_t ledColor();                           // LE_NOTICE / LE_CARE / LE_BEAT / LE_BREATH 的颜色（0xRRGGBB）
float ledLevel(uint32_t now);                  // 2.9：LE_BEAT / LE_BREATH 的亮度（0–1）；其他 = 1
// 串口预览：celebrate / milestone / greet / welcome / goodnight / stretch / water / lunch / taskdone / …（help 里有完整列表）
bool preview(const char* name);
const char* previewNames();                    // 用空格分开的全部预览名字

}  // namespace brain
