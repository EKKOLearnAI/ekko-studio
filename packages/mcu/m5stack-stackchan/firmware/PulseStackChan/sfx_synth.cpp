// 脉冲 Pulse · 音效合成器（原创代码）
// 每个声音是一小段「乐谱」：几个音符，每个音符有波形、滑音、颤音和包络。
// 音色走「霓虹玻璃」的感觉：玻璃 / 风铃一样的 FM 音色 + 像小机器人说话的啾啾声，都在 D 大调里。
#include "sfx_synth.h"
#include "pulse_events.h"
#include <math.h>
#include <string.h>

namespace sfx {

namespace {

enum Wave : uint8_t {
  W_SIN,    // 正弦：柔和的「嘟」
  W_TRI,    // 三角波：清脆一点的电子音
  W_VOX,    // 带两个泛音的正弦：像小机器人在「说话」
  W_SQR,    // 柔化的方波（只有 3 个奇次谐波）：嘟囔、生气
  W_GLASS,  // FM（调制比 2）：玻璃一样的叮
  W_BELL,   // FM（调制比 3.5）：风铃 / 闪光
  W_NOISE,  // 带通噪声（中心频率可以滑动）：呼气、光刷过去的「唰」
};
enum Env : uint8_t {
  E_PLUCK,  // 起音后指数衰减（叮）
  E_SWELL,  // 起音后余弦收尾（像哼出来的）
  E_HOLD,   // 起音、保持、最后 40 毫秒收掉（嘀）
};

struct Note {
  float t, d;        // 开始时间、时长（秒）
  float f0, f1;      // 起止频率（Hz），中间按对数滑音
  float amp;         // 音量（0–1）
  uint8_t wave, env;
  float atk;         // 起音时间（秒）
  float glide;       // 滑音用多久（秒；0 = 整个音）
  float vib, vibHz;  // 颤音深度（半音）和速度（Hz）
};

// 小事件每次的变化：0 = 不变，1 = 五声音阶里随机挑，2 = 上下一个半音以内，3 = 三个音高轮流
enum Var : uint8_t { V_NONE, V_PENTA, V_SMALL, V_CYCLE };
struct SoundDef { const char* name; const Note* notes; uint8_t n; uint8_t var; };

// 音高（Hz）
constexpr float C5 = 523.25f, D5 = 587.33f, E5 = 659.26f, Fs5 = 739.99f, G5 = 783.99f, A5 = 880.f, B5 = 987.77f;
constexpr float Cs6 = 1108.73f, D6 = 1174.66f, E6 = 1318.51f, Fs6 = 1479.98f, G6 = 1567.98f, A6 = 1760.f, B6 = 1975.53f;
constexpr float D7 = 2349.32f, E7 = 2637.02f, Fs7 = 2959.96f, A7 = 3520.f;

//            t      d      f0     f1     amp    wave     env      atk     glide  vib   vibHz
const Note nSleep[] = {
  {0.00f, 0.55f, A5, A5, .14f, W_SIN, E_SWELL, .06f},
  {0.32f, 0.70f, Fs5, Fs5, .12f, W_SIN, E_SWELL, .08f},
  {0.70f, 1.20f, D5, D5, .10f, W_SIN, E_SWELL, .15f, 0, .08f, 3.f},
  {0.30f, 1.40f, 1500, 700, .025f, W_NOISE, E_SWELL, .60f},
};
const Note nWake[] = {
  {0.00f, 0.60f, A6, A6, .10f, W_GLASS, E_PLUCK, .003f},
  {0.05f, 0.95f, 520, 900, .16f, W_VOX, E_SWELL, .55f, .80f, .12f, 5.f},  // 伸懒腰：慢慢升上去……
  {0.98f, 0.45f, 900, 700, .11f, W_VOX, E_SWELL, .04f, .40f},             // ……再落下来
  {1.45f, 0.16f, E6, A6, .16f, W_SIN, E_PLUCK, .004f, .06f},              // 醒啦
};
const Note nIdle[] = {
  {0.00f, 0.10f, A5, A5, .11f, W_SIN, E_PLUCK, .003f},
  {0.09f, 0.16f, D6, D6, .09f, W_SIN, E_PLUCK, .003f},
};
const Note nCurious[] = {
  {0.00f, 0.10f, 700, 900, .15f, W_VOX, E_HOLD, .006f},
  {0.14f, 0.24f, 900, 1500, .16f, W_VOX, E_SWELL, .02f, .20f},  // 往上挑：「嗯？」
};
const Note nDaze[] = {
  {0.00f, 1.10f, E5, D5, .11f, W_SIN, E_SWELL, .45f, 0, .25f, 2.5f},
  {0.15f, 1.00f, B5, A5, .05f, W_SIN, E_SWELL, .50f, 0, .20f, 2.f},
};
const Note nBoot[] = {  // 05 加载苏醒：和 1.9 秒的描边动画对齐，轮廓合上时落在和弦上
  {0.00f, 1.80f, 700, 3400, .014f, W_NOISE, E_SWELL, 1.30f},    // 光沿着轮廓「唰」过去
  {0.05f, 1.75f, D5, D6, .06f, W_SIN, E_SWELL, 1.10f, 1.50f},    // 底下慢慢升起来的长音
  {0.25f, 1.10f, D6, D6, .13f, W_GLASS, E_PLUCK, .004f},
  {0.60f, 1.10f, Fs6, Fs6, .12f, W_GLASS, E_PLUCK, .004f},
  {0.95f, 1.10f, A6, A6, .12f, W_GLASS, E_PLUCK, .004f},
  {1.30f, 1.20f, D7, D7, .10f, W_GLASS, E_PLUCK, .004f},
  {1.85f, 1.60f, D6, D6, .12f, W_BELL, E_PLUCK, .003f},
  {1.85f, 1.60f, A6, A6, .09f, W_BELL, E_PLUCK, .003f},
  {1.90f, 0.90f, Fs7, Fs7, .035f, W_SIN, E_PLUCK, .002f},
};
const Note nPowerDown[] = {
  {0.00f, 0.60f, D6, D6, .08f, W_GLASS, E_PLUCK, .003f},
  {0.02f, 0.95f, 880, 300, .14f, W_SIN, E_SWELL, .03f, .90f},
};
const Note nJolt[] = {
  {0.00f, 0.45f, 520, 760, .16f, W_VOX, E_SWELL, .02f, 0, 1.1f, 21.f},  // 被晃醒：抖
  {0.00f, 0.30f, 2500, 1800, .03f, W_NOISE, E_PLUCK, .002f},
  {0.40f, 0.22f, 800, 1700, .18f, W_VOX, E_SWELL, .01f, .12f},           // 「！」
  {0.45f, 0.90f, E7, E7, .07f, W_BELL, E_PLUCK, .002f},
};
const Note nHappy[] = {  // 10 开心：跳起来的时候「啾啾啾」，0.53 秒落地
  {0.00f, 0.11f, A5, E6, .17f, W_VOX, E_HOLD, .004f, .06f},
  {0.12f, 0.10f, E6, A6, .16f, W_VOX, E_HOLD, .004f, .05f},
  {0.23f, 0.20f, A6, D7, .15f, W_VOX, E_SWELL, .01f, .05f, .30f, 9.f},
  {0.25f, 0.60f, Fs7, Fs7, .05f, W_BELL, E_PLUCK, .002f},
  {0.53f, 0.06f, 760, 520, .10f, W_SIN, E_PLUCK, .001f},
};
const Note nPuzzled[] = {
  {0.00f, 0.09f, 700, 640, .15f, W_VOX, E_HOLD, .005f},
  {0.13f, 0.32f, 640, 1150, .16f, W_VOX, E_SWELL, .03f, .28f},  // 「嗯？」
};
const Note nSad[] = {
  {0.00f, 0.85f, A5, D5, .15f, W_VOX, E_SWELL, .08f, .75f, .18f, 5.f},
  {0.88f, 0.55f, D5, C5, .07f, W_SIN, E_SWELL, .05f},
};
const Note nSurprise[] = {
  {0.00f, 0.20f, 600, 1900, .16f, W_VOX, E_SWELL, .01f, .12f},
  {0.00f, 0.15f, 3800, 2000, .03f, W_NOISE, E_PLUCK, .001f},
  {0.03f, 0.85f, A6, A6, .10f, W_BELL, E_PLUCK, .002f},
  {0.07f, 0.65f, E7, E7, .07f, W_BELL, E_PLUCK, .002f},
};
const Note nShy[] = {  // 14 害羞：小小声，带一点发抖的颤音
  {0.00f, 0.12f, G6, Fs6, .10f, W_SIN, E_HOLD, .006f, .10f},
  {0.16f, 0.36f, Fs6, D6, .09f, W_SIN, E_SWELL, .04f, .28f, .35f, 9.f},
  {0.58f, 0.07f, Fs6, Fs6, .045f, W_SIN, E_PLUCK, .003f},
  {0.68f, 0.08f, E6, E6, .04f, W_SIN, E_PLUCK, .003f},
};
const Note nTired[] = {
  {0.00f, 0.95f, 1500, 650, .035f, W_NOISE, E_SWELL, .30f},  // 呼气
  {0.05f, 0.90f, 660, 440, .11f, W_VOX, E_SWELL, .20f, .80f, .10f, 4.f},
};
const Note nFocus[] = {
  {0.00f, 0.045f, A6, A6, .11f, W_SIN, E_HOLD, .002f},
  {0.09f, 0.070f, D7, D7, .11f, W_SIN, E_HOLD, .002f},
  {0.09f, 0.500f, D7, D7, .035f, W_GLASS, E_PLUCK, .002f},
};
const Note nPanic[] = {
  {0.00f, .05f, D6, D6, .12f, W_VOX, E_HOLD, .003f}, {0.06f, .05f, Fs6, Fs6, .12f, W_VOX, E_HOLD, .003f},
  {0.12f, .05f, D6, D6, .12f, W_VOX, E_HOLD, .003f}, {0.18f, .05f, Fs6, Fs6, .12f, W_VOX, E_HOLD, .003f},
  {0.24f, .05f, E6, E6, .12f, W_VOX, E_HOLD, .003f}, {0.30f, .05f, G6, G6, .12f, W_VOX, E_HOLD, .003f},
  {0.36f, .05f, E6, E6, .12f, W_VOX, E_HOLD, .003f},
  {0.43f, .14f, Fs6, B6, .14f, W_VOX, E_SWELL, .01f, .10f},
};
const Note nMeh[] = {
  {0.00f, 0.18f, 740, 640, .14f, W_VOX, E_HOLD, .010f, .15f},
  {0.22f, 0.32f, 640, 560, .12f, W_VOX, E_SWELL, .020f, .25f},
};
const Note nContent[] = {  // 19 满意：和两下点头对齐的「嗯～嗯」
  {0.10f, 0.20f, G5, A5, .13f, W_SIN, E_SWELL, .03f, .10f},
  {0.55f, 0.35f, D6, D6, .14f, W_SIN, E_SWELL, .02f},
  {0.56f, 0.90f, D7, D7, .035f, W_GLASS, E_PLUCK, .003f},
};
const Note nConfused[] = {
  {0.00f, .14f, 900, 720, .13f, W_VOX, E_HOLD, .008f, 0, .20f, 7.f},
  {0.16f, .14f, 720, 950, .13f, W_VOX, E_HOLD, .008f, 0, .20f, 7.f},
  {0.32f, .14f, 950, 760, .13f, W_VOX, E_HOLD, .008f, 0, .20f, 7.f},
  {0.48f, .26f, 760, 1150, .14f, W_VOX, E_SWELL, .02f, .20f},
};
const Note nAngry[] = {
  {0.00f, 0.18f, 440, 400, .11f, W_SQR, E_HOLD, .006f, 0, .5f, 28.f},
  {0.00f, 0.12f, 2200, 1500, .025f, W_NOISE, E_PLUCK, .002f},
  {0.24f, 0.24f, 494, 415, .12f, W_SQR, E_HOLD, .006f, 0, .5f, 28.f},
};
const Note nThink[] = {  // 30 思考中：「嗯……」+ 几个冒出来的小气泡
  {0.00f, 0.80f, E5, Fs5, .07f, W_SIN, E_SWELL, .30f, 0, .10f, 3.f},
  {0.25f, 0.08f, E6, G6, .08f, W_SIN, E_PLUCK, .004f},
  {0.55f, 0.08f, D6, Fs6, .07f, W_SIN, E_PLUCK, .004f},
  {0.85f, 0.10f, Fs6, A6, .07f, W_SIN, E_PLUCK, .004f},
};
const Note nTask[] = {
  {0.00f, 0.40f, D6, D6, .15f, W_GLASS, E_PLUCK, .003f},
  {0.11f, 0.75f, A6, A6, .15f, W_GLASS, E_PLUCK, .003f},
};
const Note nBusy[] = {
  {0.00f, .05f, D6, D6, .09f, W_TRI, E_HOLD, .002f},
  {0.07f, .05f, Fs6, Fs6, .09f, W_TRI, E_HOLD, .002f},
  {0.14f, .05f, A6, A6, .09f, W_TRI, E_HOLD, .002f},
};
const Note nDone[] = {  // 33 任务完成：叮—— 当！跳起来、0.53 秒落地
  {0.00f, 0.45f, D6, D6, .15f, W_GLASS, E_PLUCK, .003f},
  {0.12f, 1.20f, A6, A6, .16f, W_GLASS, E_PLUCK, .003f},
  {0.12f, 1.20f, D7, D7, .06f, W_BELL, E_PLUCK, .003f},
  {0.24f, 0.80f, Fs7, Fs7, .035f, W_BELL, E_PLUCK, .002f},
  {0.53f, 0.06f, 760, 520, .08f, W_SIN, E_PLUCK, .001f},
};
const Note nError[] = {  // 34 出错：两下故障「滋」+「呃—哦」
  {0.00f, 0.05f, 2600, 2600, .05f, W_NOISE, E_HOLD, .001f},
  {0.07f, 0.04f, 1800, 1800, .04f, W_NOISE, E_HOLD, .001f},
  {0.02f, 0.17f, E6, E6, .14f, W_VOX, E_HOLD, .006f},
  {0.24f, 0.36f, Cs6, B5, .14f, W_VOX, E_SWELL, .010f, .30f},
};
const Note nWait[] = {
  {0.00f, 0.26f, A5, E6, .11f, W_SIN, E_SWELL, .03f, .18f},
  {0.24f, 0.60f, A6, A6, .045f, W_GLASS, E_PLUCK, .003f},
};
const Note nLoad[] = {
  {0.00f, .10f, D6, Fs6, .10f, W_SIN, E_HOLD, .005f},
  {0.14f, .12f, Fs6, A6, .10f, W_SIN, E_HOLD, .005f},
};
const Note nRecall[] = {  // 37 复述回忆：像回声一样一个比一个远
  {0.00f, 0.60f, A6, A6, .12f, W_GLASS, E_PLUCK, .003f},
  {0.14f, 0.60f, Fs6, Fs6, .09f, W_GLASS, E_PLUCK, .003f},
  {0.28f, 0.60f, D6, D6, .07f, W_GLASS, E_PLUCK, .003f},
  {0.42f, 0.80f, A5, A5, .055f, W_GLASS, E_PLUCK, .003f},
};
const Note nDeny[] = {  // 38 拒绝：「嗯—嗯」（不行）
  {0.00f, .13f, A5, A5, .14f, W_VOX, E_HOLD, .006f},
  {0.19f, .22f, Fs5, Fs5, .14f, W_VOX, E_HOLD, .006f},
};
const Note nTalk[] = {  // 39 输出回复：叽里咕噜说一句
  {0.00f, .07f, 1100, 1300, .12f, W_VOX, E_HOLD, .004f},
  {0.09f, .06f, 1450, 1250, .11f, W_VOX, E_HOLD, .004f},
  {0.17f, .09f, 1000, 1150, .12f, W_VOX, E_HOLD, .004f},
  {0.29f, .06f, 1350, 1500, .10f, W_VOX, E_HOLD, .004f},
  {0.37f, .10f, 1200, 900, .11f, W_VOX, E_HOLD, .004f},
  {0.50f, .08f, 1300, 1600, .10f, W_VOX, E_HOLD, .004f},
};
const Note nSearch[] = {  // 40 检索资料：声呐一样「叮——」
  {0.00f, 0.70f, A6, A6, .10f, W_BELL, E_PLUCK, .002f},
  {0.00f, 0.25f, A6, D7, .05f, W_SIN, E_SWELL, .02f},
};
const Note nStop[] = {
  {0.00f, 0.30f, D6, D5, .14f, W_SIN, E_HOLD, .004f, .22f},
  {0.34f, 0.14f, D5, D5, .08f, W_SIN, E_PLUCK, .003f},
};
const Note nTap[] = {  // 点一下脸：「啵！」
  {0.00f, .10f, D6, A6, .15f, W_VOX, E_SWELL, .008f, .05f},
  {0.02f, .35f, D7, D7, .04f, W_GLASS, E_PLUCK, .002f},
};
const Note nHop[] = {  // 开心时每次跳起来
  {0.04f, 0.12f, 1000, 1800, .14f, W_VOX, E_SWELL, .01f, .07f},
  {0.53f, 0.06f, 760, 520, .09f, W_SIN, E_PLUCK, .001f},
};
const Note nSigh[] = {
  {0.00f, 1.00f, 1300, 600, .03f, W_NOISE, E_SWELL, .35f},
  {0.10f, 0.80f, 620, 470, .07f, W_SIN, E_SWELL, .20f},
};
const Note nNope[] = {
  {0.00f, .11f, A5, A5, .09f, W_VOX, E_HOLD, .006f},
  {0.17f, .18f, Fs5, Fs5, .09f, W_VOX, E_HOLD, .006f},
};
const Note nBubble[] = {
  {0.00f, 0.09f, D6, Fs6, .06f, W_SIN, E_PLUCK, .004f},
  {0.11f, 0.07f, Fs6, A6, .04f, W_SIN, E_PLUCK, .004f},
};
const Note nTick[] = {
  {0.00f, .025f, D7, D7, .035f, W_SIN, E_PLUCK, .001f},
};
const Note nIncoming[] = {
  {0.00f, 0.20f, A6, D6, .045f, W_SIN, E_SWELL, .08f},
};
const Note nSparkle[] = {
  {0.00f, 0.60f, D7, D7, .03f, W_BELL, E_PLUCK, .002f},
  {0.06f, 0.50f, A7, A7, .012f, W_SIN, E_PLUCK, .002f},
};
const Note nLoadTick[] = {
  {0.00f, 0.07f, A6, Fs6, .04f, W_SIN, E_PLUCK, .003f},
};
const Note nScanTick[] = {
  {0.00f, 0.03f, E7, E7, .02f, W_SIN, E_PLUCK, .001f},
};

// ---------------- 2.7 情绪价值版：陪伴音效 ----------------
// 小喇叭 400 Hz 以下基本发不出声，所以「心跳」「哼」这些低沉的感觉都用 500 Hz 以上的 VOX 音色来做。
const Note nLevelUp[] = {  // 陪伴升级：一串往上爬的「叮叮叮——」+「耶～」+ 亮起来的和弦
  {0.00f, 0.45f, 900, 3200, .012f, W_NOISE, E_SWELL, .30f},
  {0.00f, 0.30f, D6, D6, .12f, W_GLASS, E_PLUCK, .003f},
  {0.10f, 0.30f, Fs6, Fs6, .12f, W_GLASS, E_PLUCK, .003f},
  {0.20f, 0.30f, A6, A6, .12f, W_GLASS, E_PLUCK, .003f},
  {0.30f, 1.30f, D7, D7, .12f, W_GLASS, E_PLUCK, .003f},
  {0.30f, 1.30f, A6, A6, .06f, W_BELL, E_PLUCK, .003f},
  {0.32f, 0.32f, A5, D7, .12f, W_VOX, E_SWELL, .01f, .12f, .25f, 8.f},
  {0.46f, 0.90f, Fs7, Fs7, .03f, W_BELL, E_PLUCK, .002f},
  {0.62f, 0.70f, A7, A7, .012f, W_SIN, E_PLUCK, .002f},
};
const Note nLove[] = {  // 爱心：两下软软的「怦、怦」+ 暖暖的「嗯～」
  {0.00f, 0.09f, 640, 560, .12f, W_VOX, E_PLUCK, .004f},
  {0.17f, 0.11f, 600, 520, .10f, W_VOX, E_PLUCK, .004f},
  {0.38f, 0.75f, Fs5, A5, .12f, W_SIN, E_SWELL, .08f, .25f, .18f, 5.f},
  {0.42f, 0.70f, D6, D6, .045f, W_SIN, E_SWELL, .10f},
  {0.44f, 0.90f, Fs7, Fs7, .028f, W_BELL, E_PLUCK, .002f},
};
const Note nMorning[] = {  // 早安：往上升的「叮叮叮」+ 窗外小鸟「啾啾」+ 伸个懒腰「早～」
  {0.00f, 0.50f, D6, D6, .10f, W_GLASS, E_PLUCK, .003f},
  {0.14f, 0.50f, Fs6, Fs6, .10f, W_GLASS, E_PLUCK, .003f},
  {0.28f, 0.90f, A6, A6, .11f, W_GLASS, E_PLUCK, .003f},
  {0.50f, 0.07f, 2400, 3100, .055f, W_SIN, E_HOLD, .004f, .05f},
  {0.61f, 0.07f, 2500, 3300, .05f, W_SIN, E_HOLD, .004f, .05f},
  {0.82f, 0.42f, 700, 1150, .13f, W_VOX, E_SWELL, .03f, .25f, .15f, 6.f},
};
const Note nGoodnight[] = {  // 晚安：一小段八音盒摇篮曲（A F# E D），越来越轻
  {0.00f, 0.70f, A6, A6, .06f, W_BELL, E_PLUCK, .003f},
  {0.00f, 0.55f, A5, A5, .085f, W_SIN, E_SWELL, .05f},
  {0.45f, 0.70f, Fs6, Fs6, .055f, W_BELL, E_PLUCK, .003f},
  {0.45f, 0.55f, Fs5, Fs5, .08f, W_SIN, E_SWELL, .05f},
  {0.90f, 0.70f, E6, E6, .05f, W_BELL, E_PLUCK, .003f},
  {0.90f, 0.55f, E5, E5, .075f, W_SIN, E_SWELL, .05f},
  {1.35f, 1.40f, D6, D6, .045f, W_BELL, E_PLUCK, .003f},
  {1.35f, 1.30f, D5, D5, .07f, W_SIN, E_SWELL, .08f, 0, .10f, 3.f},
  {1.50f, 1.20f, 1200, 600, .014f, W_NOISE, E_SWELL, .50f},
};
const Note nCharge[] = {  // 插上电：「嗡～」充上去 + 叮、叮
  {0.00f, 0.35f, 600, 1800, .10f, W_SIN, E_SWELL, .03f, .30f},
  {0.00f, 0.30f, 800, 2800, .014f, W_NOISE, E_SWELL, .20f},
  {0.30f, 0.40f, A6, A6, .12f, W_GLASS, E_PLUCK, .003f},
  {0.40f, 0.70f, D7, D7, .11f, W_GLASS, E_PLUCK, .003f},
};
const Note nYawn[] = {  // 打哈欠：「啊——呜～」+ 吧唧一下嘴
  {0.00f, 0.70f, 560, 880, .12f, W_VOX, E_SWELL, .20f, .50f, .10f, 4.f},
  {0.05f, 0.90f, 1400, 900, .02f, W_NOISE, E_SWELL, .30f},
  {0.68f, 0.65f, 880, 520, .10f, W_VOX, E_SWELL, .03f, .55f, .12f, 4.f},
  {1.38f, 0.05f, 1300, 1100, .05f, W_SIN, E_PLUCK, .002f},
};
const Note nSneeze[] = {  // 打喷嚏：「哈……哈……啾！」
  {0.00f, 0.22f, 640, 760, .09f, W_VOX, E_SWELL, .05f},
  {0.00f, 0.22f, 1800, 2200, .012f, W_NOISE, E_SWELL, .10f},
  {0.36f, 0.26f, 720, 900, .11f, W_VOX, E_SWELL, .05f},
  {0.36f, 0.26f, 2000, 2600, .015f, W_NOISE, E_SWELL, .10f},
  {0.78f, 0.16f, 3400, 1600, .09f, W_NOISE, E_PLUCK, .002f},
  {0.78f, 0.10f, 1700, 1100, .14f, W_VOX, E_PLUCK, .002f},
  {1.00f, 0.30f, E6, E6, .03f, W_GLASS, E_PLUCK, .003f},
};
const Note nHum[] = {  // 自己哼小曲：「嗯嗯～嗯～」（F# A B A F# D）
  {0.00f, 0.28f, Fs5, Fs5, .08f, W_VOX, E_SWELL, .04f, 0, .12f, 5.f},
  {0.30f, 0.28f, A5, A5, .085f, W_VOX, E_SWELL, .04f, 0, .12f, 5.f},
  {0.60f, 0.45f, B5, A5, .09f, W_VOX, E_SWELL, .04f, .35f, .15f, 5.f},
  {1.08f, 0.60f, Fs5, D5, .08f, W_VOX, E_SWELL, .05f, .40f, .18f, 4.5f},
};
const Note nMiss[] = {  // 想你了：轻轻喊两声「嗯？」，没人应，小声叹一口气
  {0.00f, 0.30f, A5, D6, .11f, W_VOX, E_SWELL, .03f, .20f, .10f, 5.f},
  {0.55f, 0.30f, A5, D6, .08f, W_VOX, E_SWELL, .03f, .20f, .10f, 5.f},
  {1.10f, 0.70f, B5, Fs5, .07f, W_SIN, E_SWELL, .08f, .60f},
  {1.10f, 0.80f, 1100, 600, .014f, W_NOISE, E_SWELL, .30f},
};
const Note nPout[] = {  // 傲娇的「哼！」：鼻子出气 + 往下一甩
  {0.00f, 0.08f, 1500, 900, .02f, W_NOISE, E_PLUCK, .002f},
  {0.02f, 0.22f, 820, 600, .12f, W_SQR, E_SWELL, .006f, .15f},
  {0.27f, 0.08f, Fs5, Fs5, .05f, W_SIN, E_PLUCK, .003f},
};

// ---------------- 2.8 陪伴版：会关心人 + 任务提醒 ----------------
const Note nDing[] = {  // 叮咚：门铃一样的两声（有消息啦）
  {0.00f, 0.90f, Fs6, Fs6, .13f, W_BELL, E_PLUCK, .002f},
  {0.00f, 0.60f, Fs5, Fs5, .05f, W_SIN, E_PLUCK, .003f},
  {0.42f, 1.30f, D6, D6, .13f, W_BELL, E_PLUCK, .002f},
  {0.42f, 1.00f, D5, D5, .05f, W_SIN, E_PLUCK, .003f},
};
const Note nPraise[] = {  // 夸夸：「真～棒！」两声往上扬 + 亮晶晶的叮叮叮
  {0.00f, 0.22f, 700, 980, .13f, W_VOX, E_SWELL, .02f, .15f, .10f, 6.f},
  {0.24f, 0.36f, 880, 1320, .14f, W_VOX, E_SWELL, .02f, .12f, .15f, 7.f},
  {0.30f, 0.35f, D6, D6, .09f, W_GLASS, E_PLUCK, .003f},
  {0.40f, 0.35f, Fs6, Fs6, .09f, W_GLASS, E_PLUCK, .003f},
  {0.50f, 0.90f, A6, A6, .10f, W_GLASS, E_PLUCK, .003f},
  {0.55f, 0.80f, Fs7, Fs7, .03f, W_BELL, E_PLUCK, .002f},
};
const Note nClap[] = {  // 拍拍手：「啪啪啪啪」越拍越快
  {0.00f, 0.06f, 2600, 1800, .121f, W_NOISE, E_PLUCK, .001f},
  {0.16f, 0.06f, 2400, 1700, .108f, W_NOISE, E_PLUCK, .001f},
  {0.30f, 0.06f, 2700, 1900, .121f, W_NOISE, E_PLUCK, .001f},
  {0.42f, 0.06f, 2500, 1800, .108f, W_NOISE, E_PLUCK, .001f},
  {0.53f, 0.06f, 2600, 1800, .115f, W_NOISE, E_PLUCK, .001f},
  {0.63f, 0.06f, 2400, 1700, .101f, W_NOISE, E_PLUCK, .001f},
  {0.73f, 0.06f, 2700, 1900, .095f, W_NOISE, E_PLUCK, .001f},
  {0.83f, 0.06f, 2500, 1800, .081f, W_NOISE, E_PLUCK, .001f},
};
const Note nWater[] = {  // 喝水：水滴「嘀、嗒」+ 小气泡「咕嘟咕嘟」
  {0.00f, 0.09f, 900, 2200, .169f, W_SIN, E_PLUCK, .002f, .05f},
  {0.22f, 0.08f, 1100, 2600, .130f, W_SIN, E_PLUCK, .002f, .05f},
  {0.48f, 0.06f, 700, 1300, .117f, W_SIN, E_PLUCK, .002f, .04f},
  {0.58f, 0.06f, 800, 1500, .104f, W_SIN, E_PLUCK, .002f, .04f},
  {0.68f, 0.06f, 750, 1400, .091f, W_SIN, E_PLUCK, .002f, .04f},
  {0.85f, 0.45f, A6, A6, .05f, W_GLASS, E_PLUCK, .003f},
};
const Note nTummy[] = {  // 肚子饿：「咕噜噜～」+「饭～饭！」+ 碗筷叮叮
  {0.00f, 0.40f, 560, 640, .09f, W_SQR, E_SWELL, .02f, 0, .9f, 14.f},
  {0.42f, 0.24f, 700, 900, .12f, W_VOX, E_SWELL, .02f, .12f, .08f, 6.f},
  {0.70f, 0.30f, 900, 1200, .13f, W_VOX, E_SWELL, .02f, .10f, .10f, 6.f},
  {1.05f, 0.40f, E6, E6, .08f, W_GLASS, E_PLUCK, .002f},
  {1.18f, 0.60f, A6, A6, .08f, W_GLASS, E_PLUCK, .002f},
};
const Note nStretch[] = {  // 起来活动：「嗯～嘿——咻！」
  {0.00f, 0.55f, 600, 1000, .12f, W_VOX, E_SWELL, .10f, .50f, .10f, 5.f},
  {0.60f, 0.22f, 1000, 1500, .13f, W_VOX, E_SWELL, .02f, .10f},
  {0.62f, 0.25f, 1200, 3200, .02f, W_NOISE, E_SWELL, .05f},
  {0.86f, 0.30f, A6, A6, .09f, W_GLASS, E_PLUCK, .003f},
};
const Note nCheer[] = {  // 任务完成：「嗒、哒、哒、嗒——！」小号角 +「耶～」+ 闪闪
  {0.00f, 0.12f, D6, D6, .11f, W_TRI, E_HOLD, .005f},
  {0.13f, 0.12f, Fs6, Fs6, .11f, W_TRI, E_HOLD, .005f},
  {0.26f, 0.12f, A6, A6, .11f, W_TRI, E_HOLD, .005f},
  {0.40f, 0.80f, D7, D7, .10f, W_TRI, E_SWELL, .01f, 0, .12f, 6.f},
  {0.40f, 1.10f, D7, D7, .06f, W_GLASS, E_PLUCK, .003f},
  {0.42f, 0.40f, 760, 1300, .12f, W_VOX, E_SWELL, .02f, .20f, .20f, 7.f},
  {0.40f, 0.60f, 1500, 4000, .012f, W_NOISE, E_SWELL, .30f},
  {0.70f, 0.80f, Fs7, Fs7, .03f, W_BELL, E_PLUCK, .002f},
};
const Note nOops[] = {  // 哎呀～（任务没成功：不吓人，软软的）
  {0.00f, 0.22f, 1000, 1250, .11f, W_VOX, E_SWELL, .02f, .10f},
  {0.26f, 0.50f, 1050, 700, .11f, W_VOX, E_SWELL, .03f, .40f, .15f, 5.f},
  {0.30f, 0.60f, B5, Fs5, .04f, W_SIN, E_SWELL, .05f, .50f},
};
const Note nAck[] = {  // 知道啦：「嗯嗯！」
  {0.00f, 0.12f, 760, 900, .12f, W_VOX, E_SWELL, .01f, .08f},
  {0.16f, 0.16f, 860, 1120, .13f, W_VOX, E_SWELL, .01f, .08f},
  {0.30f, 0.40f, A6, A6, .07f, W_GLASS, E_PLUCK, .003f},
};
const Note nNudge[] = {  // 轻轻提醒：小声「嗯？」+ 一下小铃铛
  {0.00f, 0.30f, 700, 1000, .10f, W_VOX, E_SWELL, .03f, .25f, .10f, 5.f},
  {0.34f, 0.60f, Fs6, Fs6, .07f, W_BELL, E_PLUCK, .002f},
};
// ---- 2.9 活泼版 ----
const Note nBop[] = {  // 节奏「嘟」：节奏游戏里敲的那一下（像木鱼，很短，三个音高轮流）
  {0.00f, 0.11f, 1180, 880, .11f, W_TRI, E_PLUCK, .001f, .03f},
  {0.00f, 0.03f, 2800, 1800, .04f, W_NOISE, E_PLUCK, .001f},
};
const Note nTurn[] = {  // 轮到你啦：「嗯？」往上扬 + 小铃铛
  {0.00f, 0.26f, 760, 1150, .12f, W_VOX, E_SWELL, .02f, .20f},
  {0.24f, 0.50f, A6, A6, .07f, W_BELL, E_PLUCK, .002f},
};
const Note nBreath[] = {  // 吸气引导：很轻的「呼——」风声 + 慢慢往上走的软长音（4 秒内放完）
  {0.00f, 3.60f, 500, 1300, .022f, W_NOISE, E_SWELL, 1.6f},
  {0.20f, 3.40f, D5, A5, .035f, W_SIN, E_SWELL, 1.4f, 3.4f},
};
const Note nPurr[] = {  // 舒服的「咕噜噜」
  {0.00f, 0.90f, 150, 140, .08f, W_SQR, E_SWELL, .08f, 0, .6f, 22.f},
  {0.10f, 0.70f, 300, 280, .03f, W_SIN, E_SWELL, .08f, 0, .4f, 22.f},
};
const Note nPlease[] = {  // 撒娇「嗯～？」：拖长、往上扬再落一点 + 一下小叮
  {0.00f, 0.55f, 820, 1150, .12f, W_VOX, E_SWELL, .04f, .40f, .25f, 6.f},
  {0.50f, 0.25f, 1150, 980, .09f, W_VOX, E_SWELL, .02f},
  {0.40f, 0.60f, Fs6, Fs6, .05f, W_GLASS, E_PLUCK, .003f},
};

#define SND(name, arr, var) {name, arr, (uint8_t)(sizeof(arr) / sizeof(arr[0])), var}
const SoundDef kSounds[] = {
  {"none", nullptr, 0, V_NONE},
  SND("sleep", nSleep, V_NONE), SND("wake", nWake, V_NONE), SND("idle", nIdle, V_NONE), SND("curious", nCurious, V_NONE),
  SND("daze", nDaze, V_NONE), SND("boot", nBoot, V_NONE), SND("powerdown", nPowerDown, V_NONE), SND("jolt", nJolt, V_NONE),
  SND("happy", nHappy, V_NONE), SND("puzzled", nPuzzled, V_NONE), SND("sad", nSad, V_NONE), SND("surprise", nSurprise, V_NONE),
  SND("shy", nShy, V_NONE), SND("tired", nTired, V_NONE), SND("focus", nFocus, V_NONE), SND("panic", nPanic, V_NONE),
  SND("meh", nMeh, V_NONE), SND("content", nContent, V_NONE), SND("confused", nConfused, V_NONE), SND("angry", nAngry, V_NONE),
  SND("think", nThink, V_NONE), SND("task", nTask, V_NONE), SND("busy", nBusy, V_NONE), SND("done", nDone, V_NONE),
  SND("error", nError, V_NONE), SND("wait", nWait, V_NONE), SND("load", nLoad, V_NONE), SND("recall", nRecall, V_NONE),
  SND("deny", nDeny, V_NONE), SND("talk", nTalk, V_NONE), SND("search", nSearch, V_NONE), SND("stop", nStop, V_NONE),
  SND("tap", nTap, V_SMALL), SND("hop", nHop, V_SMALL), SND("sigh", nSigh, V_SMALL), SND("nope", nNope, V_NONE),
  SND("bubble", nBubble, V_PENTA), SND("tick", nTick, V_CYCLE), SND("incoming", nIncoming, V_SMALL),
  SND("sparkle", nSparkle, V_CYCLE), SND("loadtick", nLoadTick, V_NONE), SND("scantick", nScanTick, V_CYCLE),
  SND("levelup", nLevelUp, V_NONE), SND("love", nLove, V_NONE), SND("morning", nMorning, V_NONE),
  SND("goodnight", nGoodnight, V_NONE), SND("charge", nCharge, V_NONE), SND("yawn", nYawn, V_SMALL),
  SND("sneeze", nSneeze, V_SMALL), SND("hum", nHum, V_SMALL), SND("miss", nMiss, V_NONE), SND("pout", nPout, V_SMALL),
  SND("ding", nDing, V_NONE), SND("praise", nPraise, V_NONE), SND("clap", nClap, V_NONE), SND("water", nWater, V_SMALL),
  SND("tummy", nTummy, V_NONE), SND("stretch", nStretch, V_NONE), SND("cheer", nCheer, V_NONE), SND("oops", nOops, V_NONE),
  SND("ack", nAck, V_SMALL), SND("nudge", nNudge, V_SMALL),
  SND("bop", nBop, V_CYCLE), SND("turn", nTurn, V_NONE), SND("breath", nBreath, V_NONE), SND("purr", nPurr, V_SMALL),
  SND("please", nPlease, V_SMALL),
};
#undef SND
static_assert(sizeof(kSounds) / sizeof(kSounds[0]) == S_COUNT, "kSounds 和 Sound 枚举要一一对应");

// ---------------- 波形 ----------------
float gSin[1025];
bool gSinOk = false;
void initSin() {
  for (int i = 0; i <= 1024; i++) gSin[i] = sinf(6.2831853f * i / 1024.f);
  gSinOk = true;
}
inline float tsin(float ph) {  // ph 单位：周（任意实数）
  ph -= (float)(int32_t)ph;
  if (ph < 0.f) ph += 1.f;
  const float x = ph * 1024.f;
  const int i = (int)x;
  const float fr = x - (float)i;
  return gSin[i] + (gSin[i + 1] - gSin[i]) * fr;
}

float envAt(const Note& n, float tau) {
  const float a = n.atk > .001f ? n.atk : .001f;
  float e;
  if (tau < a) {
    const float s = sinf(1.5707963f * tau / a);
    e = s * s;
  } else {
    const float r = n.d - a;
    const float u = r > 0.f ? (tau - a) / r : 1.f;
    switch (n.env) {
      case E_PLUCK: e = expf(-5.5f * u); break;
      case E_SWELL: { const float c = cosf(1.5707963f * (u > 1.f ? 1.f : u)); e = c * c; } break;
      default: {
        const float rl = n.d * .25f < .04f ? n.d * .25f : .04f;
        const float x = (n.d - tau) / rl;
        if (x >= 1.f) e = 1.f;
        else if (x <= 0.f) e = 0.f;
        else { const float s = sinf(1.5707963f * x); e = s * s; }
      } break;
    }
  }
  const float tail = (n.d - tau) / .006f;  // 最后 6 毫秒收到 0，避免「咔哒」
  if (tail < 1.f) e *= tail > 0.f ? tail : 0.f;
  return e;
}

float freqAt(const Note& n, float lr, float pitch, float tau) {
  float g = n.glide > 0.f ? tau / n.glide : tau / n.d;
  if (g > 1.f) g = 1.f;
  if (g < 0.f) g = 0.f;
  g = 1.f - (1.f - g) * (1.f - g);  // 先快后慢，像说话的语调
  float f = n.f0 * exp2f(lr * g);
  if (n.vib > 0.f) {
    const float ramp = tau < .06f ? tau / .06f : 1.f;
    f *= exp2f(n.vib * (1.f / 12.f) * ramp * sinf(6.2831853f * n.vibHz * tau));
  }
  return f * pitch;
}

inline int stateNum(const char* id) {
  if (!id || id[0] < '0' || id[0] > '9' || id[1] < '0' || id[1] > '9') return -1;
  return (id[0] - '0') * 10 + (id[1] - '0');
}

}  // namespace

uint8_t enterSound(const char* stateId) {
  switch (stateNum(stateId)) {
    case 0: return S_SLEEP;
    case 1: return S_WAKE;
    case 2: return S_IDLE;
    case 3: return S_CURIOUS;
    case 4: return S_DAZE;
    case 5: return S_BOOT;
    case 6: return S_POWERDOWN;
    case 7: return S_JOLT;
    case 10: return S_HAPPY;
    case 11: return S_PUZZLED;
    case 12: return S_SAD;
    case 13: return S_SURPRISE;
    case 14: return S_SHY;
    case 15: return S_TIRED;
    case 16: return S_FOCUS;
    case 17: return S_PANIC;
    case 18: return S_MEH;
    case 19: return S_CONTENT;
    case 20: return S_CONFUSED;
    case 21: return S_ANGRY;
    case 30: return S_THINK;
    case 31: return S_TASK;
    case 32: return S_BUSY;
    case 33: return S_DONE;
    case 34: return S_ERROR;
    case 35: return S_WAIT;
    case 36: return S_LOAD;
    case 37: return S_RECALL;
    case 38: return S_DENY;
    case 39: return S_TALK;
    case 40: return S_SEARCH;
    case 41: return S_STOP;
    default: return S_NONE;
  }
}

uint8_t eventSound(const char* stateId, uint32_t ev) {
  using namespace pulse;
  if (!ev) return S_NONE;
  const int s = stateNum(stateId);
  if (ev & EV_PERIODIC) {
    if (ev & (1u << I_HOP)) return S_HOP;
    if (ev & (1u << I_SIGH)) return S_SIGH;
    if (ev & (1u << I_SHAKE)) return S_NOPE;
  }
  if ((ev & EV_RING_OUT) && s == 33) return S_SPARKLE;
  if ((ev & EV_RING_IN) && s == 31) return S_INCOMING;
  if (ev & EV_ECG) {
    if (s == 30) return S_BUBBLE;
    if (s == 32) return S_TICK;
  }
  if (ev & EV_HOT) {
    if (s == 36) return S_LOADTICK;
    if (s == 40) return S_SCANTICK;
  }
  return S_NONE;
}

const char* soundName(uint8_t id) { return id < S_COUNT ? kSounds[id].name : "?"; }

int findSound(const char* name) {
  if (!name || !*name) return -1;
  for (int i = 1; i < (int)S_COUNT; i++)
    if (strcmp(kSounds[i].name, name) == 0) return i;
  return -1;
}

Synth::Synth() { memset(_v, 0, sizeof(_v)); }

void Synth::release(bool all) {
  for (Voice& v : _v) {
    if (!v.on) continue;
    if ((int32_t)(_clock - v.start) < 0) { v.on = false; continue; }  // 还没开始的音符直接取消
    if (all || v.relStep == 0.f) v.relStep = 1.f / (.025f * kRate);
  }
}

void Synth::stop() { release(true); }

bool Synth::busy() const {
  for (const Voice& v : _v)
    if (v.on) return true;
  return false;
}

void Synth::play(uint8_t id, bool replace, uint32_t seed) {
  if (replace) release(true);
  if (id == S_NONE || id >= S_COUNT) return;
  const SoundDef& s = kSounds[id];
  static const float kPenta[5] = {1.f, 1.1224620f, 1.2599210f, 1.4983071f, 1.6817928f};
  static const float kCycle[3] = {1.f, 1.1224620f, .8908987f};
  uint32_t h = seed * 2654435761u + 12345u;
  h ^= h >> 15;
  float pitch = 1.f, gain = 1.f;
  switch (s.var) {
    case V_PENTA: pitch = kPenta[h % 5] * .8908987f; gain = .8f + .2f * ((h >> 8) & 255) / 255.f; break;
    case V_SMALL: pitch = exp2f(((float)((h >> 4) % 200) - 100.f) / 1200.f); gain = .85f + .15f * ((h >> 12) & 255) / 255.f; break;
    case V_CYCLE: pitch = kCycle[seed % 3]; break;
    default: break;
  }
  for (int i = 0; i < s.n; i++) {
    const Note& n = s.notes[i];
    Voice* v = nullptr;
    for (Voice& c : _v)
      if (!c.on) { v = &c; break; }
    if (!v) {  // 都在用：顶掉最早的那个
      v = &_v[0];
      for (Voice& c : _v)
        if (c.serial < v->serial) v = &c;
    }
    memset(v, 0, sizeof(Voice));
    v->note = &n;
    v->start = _clock + (uint32_t)(n.t * kRate + .5f);
    v->len = (int32_t)(n.d * kRate + .5f);
    v->rel = 1.f;
    v->pitch = pitch;
    v->gain = gain;
    v->lr = log2f(n.f1 / n.f0);
    v->rng = (seed + 1u) * 747796405u + (uint32_t)i * 2891336453u + 1u;
    v->serial = ++_serial;
    v->on = true;
  }
}

void Synth::render(int16_t* out, int n) {
  if (!gSinOk) initSin();
  constexpr int kSub = 32;  // 每 32 个采样（0.67 毫秒）重新算一次频率和包络，中间线性插值
  constexpr float kDt = 1.f / kRate;
  float mix[kSub];
  int done = 0;
  while (done < n) {
    const int m = (n - done) < kSub ? (n - done) : kSub;
    for (int i = 0; i < m; i++) mix[i] = 0.f;
    for (Voice& v : _v) {
      if (!v.on) continue;
      const int32_t r0 = (int32_t)(_clock - v.start);
      if (r0 + m <= 0) continue;  // 还没到
      if (r0 >= v.len || v.rel <= 0.f) { v.on = false; continue; }
      const Note& nt = *(const Note*)v.note;
      const int i0 = r0 < 0 ? -r0 : 0;
      const int i1 = (v.len - r0) < m ? (int)(v.len - r0) : m;
      const int cnt = i1 - i0;
      if (cnt <= 0) continue;
      const float ta = (r0 + i0) * kDt, tb = (r0 + i1) * kDt;
      const float fa = freqAt(nt, v.lr, v.pitch, ta), fb = freqAt(nt, v.lr, v.pitch, tb);
      const float xa = envAt(nt, ta), xb = envAt(nt, tb);
      const float ra = v.rel;
      if (v.relStep > 0.f) {
        v.rel -= v.relStep * cnt;
        if (v.rel < 0.f) v.rel = 0.f;
      }
      const float k = nt.amp * v.gain;
      const float inv = 1.f / cnt;
      float f = fa * kDt, df = (fb - fa) * kDt * inv;  // 每个采样的相位增量
      float e = xa * ra * k, de = (xb * v.rel * k - e) * inv;
      float* o = mix + i0;
      float ph = v.ph, mph = v.mph;
      switch (nt.wave) {
        case W_SIN:
          for (int i = 0; i < cnt; i++) {
            o[i] += e * tsin(ph);
            ph += f; if (ph >= 1.f) ph -= 1.f;
            f += df; e += de;
          }
          break;
        case W_TRI:
          for (int i = 0; i < cnt; i++) {
            o[i] += e * (4.f * fabsf(ph - .5f) - 1.f);
            ph += f; if (ph >= 1.f) ph -= 1.f;
            f += df; e += de;
          }
          break;
        case W_VOX:
          for (int i = 0; i < cnt; i++) {
            o[i] += e * .72f * (tsin(ph) + .35f * tsin(2.f * ph) + .12f * tsin(3.f * ph));
            ph += f; if (ph >= 1.f) ph -= 1.f;
            f += df; e += de;
          }
          break;
        case W_SQR:
          for (int i = 0; i < cnt; i++) {
            o[i] += e * .85f * (tsin(ph) + .3333f * tsin(3.f * ph) + .2f * tsin(5.f * ph));
            ph += f; if (ph >= 1.f) ph -= 1.f;
            f += df; e += de;
          }
          break;
        case W_GLASS:
        case W_BELL: {
          const float ratio = nt.wave == W_GLASS ? 2.f : 3.5f;
          // 调制指数 β（弧度）：玻璃 1.6、风铃 2.6；高音时按 Carson 带宽减小，主要边带都留在奈奎斯特频率以下，不产生混叠杂音
          float beta = nt.wave == W_GLASS ? 1.6f : 2.6f;
          const float bmax = (.45f * kRate - fa) / (ratio * fa) - 1.f;
          if (beta > bmax) beta = bmax > 0.f ? bmax : 0.f;
          beta *= 1.f / 6.2831853f;  // 相位单位是「周」
          float idx = beta * (.3f + .7f * xa), didx = (beta * (.3f + .7f * xb) - idx) * inv;  // 调制深度跟着包络走：越来越「圆」
          for (int i = 0; i < cnt; i++) {
            o[i] += e * tsin(ph + idx * tsin(mph));
            ph += f; if (ph >= 1.f) ph -= 1.f;
            mph += f * ratio; if (mph >= 1.f) mph -= (float)(int32_t)mph;
            f += df; e += de; idx += didx;
          }
        } break;
        case W_NOISE: {
          float fc = (fa + fb) * .5f;
          if (fc > 3500.f) fc = 3500.f;
          const float g = 2.f * sinf(3.1415927f * fc * kDt), q = .4f;
          float lp = v.lp, bp = v.bp;
          uint32_t r = v.rng;
          for (int i = 0; i < cnt; i++) {
            r ^= r << 13; r ^= r >> 17; r ^= r << 5;
            const float x = (float)(int32_t)r * (1.f / 2147483648.f);
            lp += g * bp;
            const float hp = x - lp - q * bp;
            bp += g * hp;
            o[i] += e * 1.6f * bp;
            e += de;
          }
          v.lp = lp; v.bp = bp; v.rng = r;
        } break;
      }
      v.ph = ph;
      v.mph = mph;
      if (v.rel <= 0.f) v.on = false;
    }
    for (int i = 0; i < m; i++) {
      float x = mix[i] * _gain;
      const float ax = fabsf(x);
      if (ax > .7f) {  // 软限幅：叠在一起也不会爆音
        const float u = (ax - .7f) * (1.f / .3f);
        x = (x > 0.f ? 1.f : -1.f) * (.7f + .3f * u / (1.f + u));
      }
      out[done + i] = (int16_t)(x * 32000.f);
    }
    _clock += m;
    done += m;
  }
}

}  // namespace sfx
