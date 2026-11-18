#pragma once
// 脉冲 Pulse · 陪伴系统（原创代码，不依赖硬件，可以在电脑上测试）
// ① 心情 Affect：开心、兴奋、精神、想人陪 四个连续量。随时间自然回落；被摸、被看见、聊天、被摇晃时变化。
//    由它们得到一个「基调」（平静 / 开心 / 满足 / 想玩 / 想你了 / 困了 / 有点委屈 / 兴奋），带迟滞，不会来回跳。
// ② 亲密度 Bond：一起相处慢慢积累，10 个等级。每天的收获有递减（狂戳不会暴涨），记录连续见面天数和纪念日。
// ③ 时间小工具：本地日期、时段、夜间安静时段。
#include <stddef.h>
#include <stdint.h>

namespace companion {

// ---------------- 心情 ----------------
enum Stim : uint8_t {
  ST_TOUCH,      // 被摸 / 被点（一次触摸开始）
  ST_STROKE,     // 摸着摸着（每滑一下）
  ST_HOLD,       // 手一直放着（安心）
  ST_OVERTOUCH,  // 摸太久 / 摸太多（「放开你的脏手！」）
  ST_SHAKE,      // 被摇晃
  ST_JOLT,       // 被撞了一下
  ST_FACE,       // 看见你了（久别重逢）
  ST_NEAR,       // 有人靠近
  ST_CHAT,       // 和它说话
  ST_PLAY,       // 一起玩 / 看表演
  ST_WAKE,       // 醒来
  ST_SLEEP,      // 睡着
  ST_DARK,       // 关灯了
  ST_LIGHT,      // 开灯了
  ST_CHARGE,     // 插上电
  ST_COUNT
};

enum Tone : uint8_t { T_CALM, T_JOYFUL, T_CONTENT, T_PLAYFUL, T_LONELY, T_SLEEPY, T_GRUMPY, T_EXCITED, T_COUNT };
const char* toneName(uint8_t tone);  // 中文（串口 / 设置）
const char* toneKey(uint8_t tone);   // 英文（状态接口）

struct Affect {
  float valence;  // -1…1：委屈 ↔ 开心
  float arousal;  // 0…1：安静 ↔ 兴奋
  float energy;   // 0…1：困 ↔ 精神
  float social;   // 0…1：想人陪的程度
  float warmth;   // 0…1：亲密度带来的底色（由 update 写入）
  uint8_t tone;
  float toneAge;  // 当前基调持续了多少秒
};

struct AffectContext {
  bool sleeping = false;  // 睡着：精神在恢复
  bool night = false;     // 夜里：更安静，精神掉得快一点
  bool company = false;   // 有人陪着（看见脸 / 正在被摸 / 正在聊天）
  float warmth = 0.f;     // 0…1：越熟越容易开心、越不容易委屈
};

void reset(Affect& a);
void update(Affect& a, float dt, const AffectContext& ctx);  // dt：秒（超过 600 秒按 600 秒算）
void stimulus(Affect& a, uint8_t stim, float scale = 1.f);
uint8_t classify(const Affect& a);  // 不带迟滞：此刻应该是什么基调

// ---------------- 亲密度 ----------------
constexpr int kLevels = 10;
constexpr uint32_t kUnit = 16;  // 点数在内部按 1/16 点存
const char* levelName(uint8_t level);  // 初次见面 … 一生挚友
uint32_t levelPoints(uint8_t level);   // 这一级从多少点开始（整点）
uint8_t levelFor(uint32_t points16);

enum BondEvent : uint8_t { B_TOUCH, B_PET, B_HOLD, B_FACE, B_CHAT, B_PLAY, B_NEAR, B_DAILY, B_COUNT };

constexpr uint32_t kBondMagic = 0x31424B45u;  // "EKB1"
constexpr uint16_t kBondVersion = 1;
struct BondData {
  uint32_t magic;
  uint16_t version, size;
  uint32_t points16;     // 亲密度（1/16 点）
  uint32_t today16;      // 今天按原值算已经获得多少（每天递减用）
  uint32_t todayKey;     // today16 属于哪一天
  uint32_t firstDay;     // 第一次见面那天（本地日期序号；0 = 还不知道）
  uint32_t lastDay;      // 最近一次互动那天
  uint16_t streak, bestStreak;  // 连续见面天数
  uint16_t daysTogether;        // 有互动的天数
  uint16_t milestones;          // 已经庆祝过的纪念日（位）
  uint32_t touches, chats, faces;
  uint32_t minutes;      // 一起度过的开机分钟数
  uint8_t level, pad[3];
  uint32_t crc;
};

enum DayFlag : uint8_t { DF_NEW_DAY = 1, DF_STREAK = 2, DF_MILESTONE = 4, DF_FIRST_MEET = 8 };
constexpr int kMilestones = 6;
extern const uint16_t kMilestoneDays[kMilestones];  // 7、30、100、365、520、1000 天

class Bond {
 public:
  Bond() { reset(); }
  void reset();
  bool load(const void* blob, size_t n);  // 校验失败返回 false，内容保持不变
  const BondData& save();                 // 算好校验值后返回（写 NVS 用）
  const BondData& data() const { return _d; }
  // 获得亲密度。day = 今天（真实日期序号，没有时钟时用开机天数做的伪日期）。返回 true = 升级了
  bool add(uint8_t ev, uint32_t day);
  // 有互动时调用（只传真实日期，0 = 不知道）。返回 DayFlag 位
  uint8_t visit(uint32_t realDay);
  uint8_t level() const { return _d.level; }
  uint32_t points() const { return _d.points16 / kUnit; }
  float progress() const;                      // 到下一级的进度 0…1
  uint32_t daysKnown(uint32_t realDay) const;  // 认识的第几天（1 = 第一天；0 = 不知道）
  int8_t lastMilestone() const { return _lastMilestone; }
  void tickMinute() { _d.minutes++; _dirty = true; }
  bool dirty() const { return _dirty; }
  bool urgent() const { return _urgent; }  // 升级 / 新的一天：尽快保存
  void clean() { _dirty = _urgent = false; }
  float warmth() const;                    // 0…1
 private:
  BondData _d;
  bool _dirty = false, _urgent = false;
  int8_t _lastMilestone = -1;
};
uint32_t crc32(const void* data, size_t n);

// ---------------- 时间 ----------------
struct Clock {
  bool valid = false;
  uint8_t hour = 0, minute = 0, wday = 0;  // wday：0 = 周日
  uint32_t day = 0;                        // 本地日期序号（自 1970-01-01 起的天数）
};
enum Period : uint8_t { PD_NIGHT, PD_MORNING, PD_DAY, PD_EVENING };
uint8_t period(uint8_t hour);  // 5–10 点早上，10–17 点白天，17–22 点晚上，其余是夜里
bool quietHours(uint8_t hour, uint8_t startHour = 22, uint8_t endHour = 7);
constexpr int64_t kMinValidEpoch = 1735689600;  // 2025-01-01 00:00 UTC：早于它当作时钟没对过
Clock clockFromEpoch(int64_t utcSeconds, int32_t tzOffsetSeconds);

struct World {
  Clock clock;
  bool night = false;  // 夜间安静（设置开启，且在 22:00–07:00；没对时的话用房间长时间很暗代替）
  bool alsOk = false;
  float lux = -1.f;
  bool dark = false;   // 房间暗（有迟滞）
  bool battOk = false;
  int8_t battery = -1;  // 0–100
  bool charging = false;
  bool quietOn = true;  // 2.8：设置里「夜间安静」开着（关掉 = 也不提醒早点睡）
  bool soundOn = true;  // 2.8：声音没关（关了就不「叮咚」叫你，只亮灯）
};

// ---------------- 小工具 ----------------
int pickWeighted(const float* weights, int n, float r01);  // 按权重随机挑一个；全是 0 返回 -1

}  // namespace companion
