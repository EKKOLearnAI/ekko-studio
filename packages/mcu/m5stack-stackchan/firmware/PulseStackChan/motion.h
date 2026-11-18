#pragma once
// 脉冲 Pulse · 头部动作（原创代码，不依赖硬件）
// 头的姿态 = 视线（转头看某处，弹簧平滑）+ 动作（关键帧：点头、摇头、扭动、晕圈……）+ 呼吸 + 表情引擎的小晃动
// 角度单位：度，相对正前方。pan 正 = 向右看；tilt 正 = 低头、负 = 抬头。
#include <stdint.h>

namespace motion {

enum Act : uint8_t {
  A_NONE = 0,
  A_NOD,        // 点一下头
  A_NOD3,       // 连续点头三次（和 home_nod_x3 同步）
  A_NOD_SLOW,   // 满意地慢慢点头
  A_SHAKE,      // 摇头（不要 / 拒绝）
  A_HM,         // 歪头「嗯？」：转向一侧、微微抬头，停一会儿再回来
  A_LOOK_AROUND,// 左右张望
  A_HEY,        // 「嘿！」抬头看你
  A_HOP,        // 开心地上下弹两下
  A_GIGGLE,     // 咯咯笑：左右快速扭动
  A_DANCE,      // 跟着「啦啦啦」左右摇摆（约 2.7 秒，和 track_lalala 同拍）
  A_DIZZY,      // 晕：画圈，越转越小
  A_SURPRISE,   // 吓一跳：猛地抬头再慢慢回来
  A_JOLT,       // 抖一下（被震醒 / 出错）
  A_DROOP,      // 犯困 / 睡着：慢慢低头、头歪向一边（保持）
  A_WAKE,       // 醒来：抬头、甩一甩、看前方
  A_SHY,        // 害羞：扭头躲开、低头（保持）
  A_PROUD,      // 得意：抬头挺胸，左右晃一晃
  A_SIGH,       // 叹气：低下去再慢慢回来
  A_LISTEN,     // 聆听：侧过来一点、抬头看你（保持）
  A_BROADCAST,  // 广播：从左到右慢慢扫过整个房间
  A_SEND,       // 发送指令：朝前方「点」一下
  A_THINK,      // 思考：看左上方（保持）
  A_RECALL,     // 回忆：看右上方（保持）
  A_SEARCH,     // 检索：左右来回扫
  A_PANIC,      // 慌张：乱看
  A_ANGRY,      // 生气：明显左右摆动，轻微低头后回到原视线
  A_STOP,       // 停止：顿一下回到正中
  A_TALK,       // 说话：小幅点动
  A_BUSY,       // 忙碌：有节奏地小幅晃动（一直持续，直到下一个动作）
  A_STRETCH,    // 伸懒腰：抬到最高、停住、回来
  A_PET,        // 被摸头：抬头蹭手、左右轻轻蹭（保持）
  A_TRACK,      // 跟随一张移动的脸：左 → 右 → 中（表演用）
  A_DAZE,       // 发呆：慢慢飘向一边（保持）
  A_SAD,        // 失落：低头、偏开（保持）
  A_TIRED,      // 疲惫：一点一点往下栽（保持）
  A_FOCUS,      // 专注：微微抬头盯着你（保持）
  A_MEH,        // 无奈：慢慢摇头（保持微低头）
  A_BOOT,       // 开机：抬头、左右看一眼
  A_ERROR,      // 出错：一愣 + 摇头
  A_LOOK_UP,    // 抬头看头顶（头顶被摸时，保持）
  A_FLINCH,     // 被戳一下：往另一边躲一下
  A_LOOK_LEFT,  // 单独向左看（显式命令）
  A_LOOK_RIGHT, // 单独向右看（显式命令）
  A_LOOK_DOWN,  // 单独向下看（显式命令）
  A_COUNT
};

struct Limits {
  float panMax;     // 左右最大角度
  float tiltUp;     // 最多抬头（负数）
  float tiltDown;   // 最多低头（正数）
  float tiltScale;  // 动作里的上下幅度倍数（社区版机身上下空间小）
};
Limits limitsFor(uint8_t servoType);  // 0 关 / 1 PWM / 2 SCS0009 / 3 官方机身

const char* actName(uint8_t a);
int findAct(const char* name);        // 按名字找动作（例如 "nod"），找不到返回 -1
bool isDirectionalAction(uint8_t act);
uint8_t actForState(int stateNum);    // 每个状态的招牌动作（stateNum = 0…41）
float actDuration(uint8_t a);         // 秒

class Planner {
 public:
  Planner();
  void setLimits(const Limits& l) { _lim = l; }
  const Limits& limits() const { return _lim; }
  // 0 = 关，0.55 = 小，1 = 中，1.3 = 大；跟随时仅缩放动作，不缩放人脸视线。
  void setAmp(float a) { _amp = a; }
  float amp() const { return _amp; }

  // 播放动作：scale = 幅度倍数，dir = -1 时左右镜像
  void play(uint8_t act, float scale = 1.f, float dir = 1.f);
  // Explicit leased look: absolute robot-relative target, with the unselected
  // physical axis fixed at entry. The conversation owner releases its TTL.
  // Ordinary play(A_LOOK_UP) keeps the original local touch gesture behavior.
  bool playDirection(uint8_t act, float scale = 1.f);
  bool directionActive() const { return _direction; }
  void release(float sec = .6f);       // 结束「保持型」动作，慢慢回正
  bool busy() const;                   // 动作还在进行（保持型动作到位后就算结束）
  uint8_t current() const { return _act; }

  // 视线（绝对角度）：speed 1 = 正常，0.5 = 慢慢转，2 = 很快
  void lookAt(float pan, float tilt, float speed = 1.f);
  // 人脸控制器独立拥有视线目标；保留点头等动作叠加，与 lookAt 使用同一规划坐标。
  // 人脸视线是物理角度；切换所有权时换算弹簧坐标，保持当前合成位置连续。
  // 仅主循环调用。关闭后恢复普通视线目标，不改变当前姿态或动作。
  void setFaceLook(bool enabled, float pan = 0.f, float tilt = 0.f);
  void setIdle(bool on, float scale = 1.f);  // 自己东张西望（生活模式）
  bool takeIdleLook(float& pan, float& tilt);  // 刚选了新的张望目标（眼睛先看过去）
  void setBreath(float amp, float period);   // 呼吸（睡觉时）：上下 amp 度，周期 period 秒
  void setBase(float pan, float tilt) { _bPan = pan; _bTilt = tilt; }  // 表情引擎给的小晃动
  // 2.9：跟着音乐摇摆（叠加在动作上）。amp 0–1（平滑过渡），phase = 现在第几拍（带小数），
  // beatsPerSec = 一秒几拍（两次调用之间自己往前走，动作更顺）。amp 0 = 停
  void setGroove(float amp, float phase, float beatsPerSec);
  float grooveAmp() const { return _gA; }

  void update(float dt);
  float pan() const { return _pan; }
  float tilt() const { return _tilt; }
  float lookPan() const { return _lx; }
  float lookTilt() const { return _ly; }
  // 供人脸控制器接管时使用：输出角度单位的基础视线，按规划限位裁剪，关档为 0。
  // 不含动作、呼吸和表情偏移；这是规划姿态，不是舵机位置反馈。
  float physicalLookPan() const;
  float physicalLookTilt() const;
  float targetPan() const { return _faceLook ? _facePan : _tx; }
  float targetTilt() const { return _faceLook ? _faceTilt : _ty; }
  // 「sec 秒之后头会在哪里」（视线目标 + 动作，不乘幅度、不限位）：眼睛先看过去，头再跟上
  void lead(float sec, float& pan, float& tilt) const;
  float vigor() const { return _vig; }  // 最近的角速度（°/s）

 private:
  void actOffset(float t, float& p, float& q) const;
  void directionPose(float t, float& p, float& q) const;
  void handBackDirection(float seconds);
  void updateStep(float dt);
  float rnd();
  Limits _lim{45, -12, 10, .45f};
  float _amp = 1.f;
  uint8_t _act = A_NONE;
  float _at = 0, _scale = 1, _dir = 1;
  float _fromP = 0, _fromQ = 0, _fromDur = .25f;  // 切换动作时从当前偏移平滑过渡
  float _relT = -1, _relDur = .6f, _relP = 0, _relQ = 0;
  float _offP = 0, _offQ = 0;                    // 当前动作偏移
  bool _direction = false;
  float _dFromP = 0, _dFromQ = 0, _dGoalP = 0, _dGoalQ = 0;
  float _dReleaseT = -1, _dReleaseDur = .4f, _dReleaseP = 0, _dReleaseQ = 0;
  float _tx = 0, _ty = 0, _lx = 0, _ly = 0, _vx = 0, _vy = 0, _ls = 1;  // 视线弹簧
  bool _faceLook = false;
  float _facePan = 0, _faceTilt = 0;
  bool _idle = false;
  float _idleScale = 1, _idleT = 1.5f;
  bool _idleNew = false;
  float _brA = 0, _brP = 4, _brT = 0;
  float _bPan = 0, _bTilt = 0;
  float _gA = 0, _gT = 0, _gPh = 0, _gRate = 0;  // 跟着音乐摇摆
  float _pan = 0, _tilt = 0, _vig = 0;
  uint32_t _rng = 0x9E3779B9u;
  uint32_t _seed = 1;
};

}  // namespace motion
