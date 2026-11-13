#pragma once
// ============================================================
//  脉冲 Pulse · StackChan 固件 —— 默认设置
//  这些值只在第一次开机时使用；之后可以在设备上修改并保存：
//  按住屏幕 3 秒（Basic/Gray/Fire：长按中间键 B）→ 设置
// ============================================================

#define PULSE_VERSION "2.9-lively.1-dir.1-voice.3"

// 2.9：玩游戏 / 深呼吸 / 心情打卡时在脸的上方短暂显示一句提示（平时脸上不显示文字）
#ifndef PULSE_PLAY_TEXT
#define PULSE_PLAY_TEXT 1
#endif

#ifndef PULSE_STUDIO_VOICE
#define PULSE_STUDIO_VOICE 0
#endif

#ifndef PULSE_FACE_FOLLOW
#define PULSE_FACE_FOLLOW 0
#endif
#define PULSE_DEFAULT_FACE_FOLLOW PULSE_FACE_FOLLOW

// 舵机类型：0 = 关闭，1 = PWM 舵机（SG90 等），2 = 串口舵机（Feetech SCS0009），
//          3 = M5Stack 官方 StackChan 机身（K151，仅 CoreS3）
// 提示：开机检测到官方机身、并且没有手动选过舵机类型时，会自动用 3
#define PULSE_DEFAULT_SERVO      0
// 接口：0 = Port A，1 = Port C，2 = Stack-chan 主板（CoreS3 上为 Port B）
#define PULSE_DEFAULT_PORT       1
// 2.8 陪伴版只保留生活模式（像宠物一样自己玩、对触摸有反应、会关心人）。
// 以前的「轮播 / 表演循环」已经去掉；旧设置里存的模式会被忽略。

// 动作幅度：0 = 关（头不动），1 = 小，2 = 中，3 = 大
#define PULSE_DEFAULT_MOTION     3

// 生活模式：多久没人理它就犯困 / 睡着（毫秒）
#define PULSE_TIRED_MS           90000
#define PULSE_SLEEP_MS           150000

// 社区版 Stack-chan 舵机的中位（度）
#define PULSE_PAN_CENTER    90   // 左右舵机的中位
#define PULSE_TILT_CENTER   90   // 上下舵机的中位

// SG90 脉宽（微秒）：0° 和 180° 对应的脉宽
#define PULSE_PWM_MIN_US    500
#define PULSE_PWM_MAX_US    2400

// SCS0009 舵机 ID（Stack-chan 惯例：1 = 左右，2 = 上下）
#define PULSE_SCS_PAN_ID    1
#define PULSE_SCS_TILT_ID   2
#define PULSE_SCS_BAUD      1000000

// ---- M5Stack 官方 StackChan 机身（K151）----
// 机身里是两个 Feetech 串口舵机（1 = 左右，2 = 上下），舵机电源和 12 颗 RGB 灯由机身的 IO 扩展芯片（I2C 0x6F）控制，
// 头顶有 3 段触摸条（Si12T，I2C 0x68）
#define PULSE_K151_TX           6     // 舵机总线 TX（GPIO6）
#define PULSE_K151_RX           7     // 舵机总线 RX（GPIO7）
#define PULSE_K151_YAW_ZERO     460   // 左右舵机「正前方」的原始位置（没校准过时用；和官方默认值一致）
#define PULSE_K151_PITCH_ZERO   620   // 上下舵机「最低位 / 平视」的原始位置
#define PULSE_K151_PITCH_REST   15    // 平时微微抬头多少度（留出点头、低头的空间）
#define PULSE_K151_PITCH_MIN    3     // 上下舵机允许的角度范围（度，0 = 最低位）
#define PULSE_K151_PITCH_MAX    60
#define PULSE_K151_LED_LEVEL    0.35f // 机身 RGB 灯亮度（0–1），颜色跟随轮廓光

// ---- 音效（用机器自带的喇叭）----
// 0 = 关，1 = 小，2 = 中，3 = 大；第一次开机用这个，之后在设置里改（会保存）
#define PULSE_DEFAULT_SOUND     2
#define PULSE_SFX_VOL_LOW       80    // 三档对应的喇叭音量（0–255）
#define PULSE_SFX_VOL_MID       150
#define PULSE_SFX_VOL_HIGH      230
#define PULSE_SFX_GAIN          1.25f // 素材音效整体增益（音效包的响度约 -16 dBFS）
// 状态里跟着灯效走的小声音（开心时的跳跃、思考的气泡、加载的滴答……）只在进入状态后的这段时间里响，
// 停在一个状态很久也不会一直吵
#define PULSE_SFX_AMBIENT_MS    15000

// 屏幕亮度（0–255）
#define PULSE_BRIGHTNESS    150

// ---- 2.7 情绪价值版：陪伴 ----
// 时区（秒）。默认东八区（北京时间）；串口 `time tz 9` 之类可以改（会保存）
#ifndef PULSE_TZ_OFFSET
#define PULSE_TZ_OFFSET     28800
#endif
// 夜间安静时段（本地时间，整点）：更安静、更暗、更容易睡着
#define PULSE_QUIET_START   22
#define PULSE_QUIET_END     7
// 自动亮度：环境光 ≤ 低点时屏幕降到这个比例，≥ 高点时为 100%
#define PULSE_ABRT_LOW_LUX   3.f
#define PULSE_ABRT_HIGH_LUX  150.f
#define PULSE_ABRT_MIN       .55f
#define PULSE_NIGHT_DIM      .5f    // 夜间安静时屏幕再乘这个
#define PULSE_NIGHT_VOLUME   .45f   // 夜间安静时音效音量比例
#define PULSE_NIGHT_LED      .3f    // 夜间安静时机身灯亮度比例

// ---- 2.8 陪伴版：会关心人 + 任务提醒 ----
// 关心提醒（起来活动 / 喝水 / 吃饭 / 早点睡 / 夸你）：0 = 关，1 = 少一点，2 = 开。设置里可以改（会保存）
#ifndef PULSE_DEFAULT_CARE
#define PULSE_DEFAULT_CARE   2
#endif
// 任务提醒（Ekko Studio 通过 /api/notify 送来「任务完成 / 没成功 / 提醒 / 夸夸」）：1 = 开，0 = 关
#ifndef PULSE_DEFAULT_TASK
#define PULSE_DEFAULT_TASK   1
#endif
// 演任务提醒时在脸的上方短暂显示这条消息的标题（6 秒）：1 = 显示，0 = 只用表情 / 小图案 / 声音 / 灯
#ifndef PULSE_NOTICE_TITLE
#define PULSE_NOTICE_TITLE   1
#endif

// ---- 2.9 活泼版：一起玩 ----
// 活跃度：0 = 安静（和 2.8 一样）/ 1 = 适中 / 2 = 活泼（看着你时常有小反应、会主动找你玩、躲猫猫）。设置里可以改（会保存）
#ifndef PULSE_DEFAULT_LIVELY
#define PULSE_DEFAULT_LIVELY 2
#endif
// 听歌跳舞：1 = 开（醒着、空着时偶尔用麦克风听几秒有没有在放歌；只在本机算节拍，不录音、不上传）/ 0 = 关（不碰麦克风）
#ifndef PULSE_DEFAULT_MUSIC
#define PULSE_DEFAULT_MUSIC  1
#endif
// 对话自动结束：1 = 开（一会儿没说话 / 说「再见」/ 连着两次没听清就不再听）/ 0 = 关（像 2.8 一样一直听，直到点右上角）
#ifndef PULSE_DEFAULT_TALK_AUTO
#define PULSE_DEFAULT_TALK_AUTO 1
#endif
#define PULSE_TALK_IDLE_MS      40000u   // 等你说话：多久没开口就结束
#define PULSE_TALK_IDLE_FACE_MS 120000u  // 你还在镜头前：多等一会儿
#define PULSE_MIN_BRIGHTNESS 24     // 再暗也不低于这个（0–255）
