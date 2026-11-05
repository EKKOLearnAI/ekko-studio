// 32 个状态（编号与网页原型一致：00–07 生命周期 / 10–21 情绪 / 30–41 工作状态）
// 只在 pulse_engine.cpp 里 include 一次（位于 namespace pulse 内）。
#pragma once

static const KV kv00[] = {{P_DIM, .45f}, {P_GLOW, .35f}, {P_EYE_H, .07f}, {P_EYE_W, 1.15f}, {P_EYE_Y, 4}, {P_BLINK, 0}, {P_FOLLOW, 0}, {P_BREATHE, .03f}, {P_BREATHE_SPEED, .22f}, {P_BOB, 1}, {P_BOB_SPEED, .22f}, {P_DOTS, 1}, {P_A3, .8f}, {P_S3, .15f}, {P_TINT, .08f}};
static const KV kv01[] = {{P_BLINK, .6f}, {P_EYE_H, 1.02f}, {P_FOLLOW, .6f}};
static const KV kv02[] = {{P_GLOW, .85f}};
static const KV kv03[] = {{P_REACH, 7}, {P_REACH_FOLLOW, 1}, {P_REACH_A, -40}, {P_EYE_H, 1.12f}, {P_EYE_W, 1.08f}, {P_TILT, 6}, {P_GAZE_X, 4}, {P_GAZE_Y, -2}, {P_LEAN, 4}, {P_FOLLOW, 1.2f}, {P_BLINK, .18f}};
static const KV kv04[] = {{P_EYE_H, .78f}, {P_LID_O, .22f}, {P_LID_I, .22f}, {P_GAZE_X, -3}, {P_GAZE_Y, 3}, {P_FOLLOW, .12f}, {P_BLINK, .12f}, {P_A2, 1.4f}, {P_S2, .12f}, {P_A3, .4f}, {P_BOB, 2}, {P_BOB_SPEED, .18f}, {P_SWING, 1.5f}, {P_SWING_SPEED, .12f}};
static const KV kv05[] = {{P_HOT, .85f}, {P_HOT_SPEED, .7f}, {P_HOT_LEN, .1f}, {P_FOLLOW, .5f}};
static const KV kv06[] = {{P_DIM, .7f}, {P_GLOW, .12f}, {P_RIM_W, 2.4f}, {P_EYE_H, .05f}, {P_EYE_BRIGHT, .25f}, {P_BLINK, 0}, {P_FOLLOW, 0}, {P_BOB, 0}, {P_BREATHE, .006f}, {P_BREATHE_SPEED, .12f}, {P_A3, 0}, {P_TINT, .04f}};
static const KV kv07[] = {{P_EYE_H, 1.2f}, {P_EYE_W, 1.1f}, {P_BLINK, .12f}, {P_GLOW, 1.05f}, {P_A5, .8f}, {P_S5, 1.5f}};
static const KV kv10[] = {{P_A8, 3.8f}, {P_S8, 1.3f}, {P_A3, 0}, {P_BITE, 1}, {P_EYE_W, 1.45f}, {P_EYE_H, .7f}, {P_EYE_Y, -2}, {P_BOB, 2.4f}, {P_BOB_SPEED, .9f}, {P_GLOW, 1}, {P_BLINK, 0}};
static const KV kv11[] = {{P_REACH, 8}, {P_REACH_A, -55}, {P_TILT, -8}, {P_ASYM, .24f}, {P_GAZE_X, 3}, {P_GAZE_Y, -4}, {P_FOLLOW, .4f}, {P_BLINK, .2f}, {P_A3, .3f}};
static const KV kv12[] = {{P_SAG, 1}, {P_DIM, .22f}, {P_GLOW, .5f}, {P_LID_O, .4f}, {P_EYE_H, .86f}, {P_GAZE_Y, 5}, {P_FOLLOW, .3f}, {P_BOB, 1}, {P_BOB_SPEED, .22f}, {P_A2, .6f}, {P_S2, .1f}, {P_A3, .2f}, {P_BLINK, .18f}};
static const KV kv13[] = {{P_EYE_W, 1.55f}, {P_EYE_H, .9f}, {P_RIM_W, 3.8f}, {P_GLOW, 1.2f}, {P_BLINK, 0}, {P_A5, 1.2f}, {P_S5, 2}, {P_A3, 0}, {P_FOLLOW, .4f}};
static const KV kv14[] = {{P_SCALE, .9f}, {P_GAZE_X, -4}, {P_GAZE_Y, 5}, {P_FOLLOW, -.5f}, {P_LID_B, .3f}, {P_EYE_H, .82f}, {P_BLUSH, 1}, {P_TREMBLE, .5f}, {P_A11, 1}, {P_S11, 1.6f}, {P_TILT, -4}, {P_BLINK, .45f}};
static const KV kv15[] = {{P_LID_O, .45f}, {P_LID_I, .45f}, {P_EYE_H, .9f}, {P_SQUASH, .05f}, {P_SAG, .35f}, {P_DIM, .3f}, {P_GLOW, .45f}, {P_BOB, 1.5f}, {P_BOB_SPEED, .2f}, {P_BLINK, .4f}, {P_A2, .8f}, {P_S2, .1f}, {P_A3, .2f}, {P_FOLLOW, .3f}};
static const KV kv16[] = {{P_EYE_W, .92f}, {P_EYE_H, .78f}, {P_LID_B, .18f}, {P_LID_O, .1f}, {P_LID_I, .22f}, {P_HOT, .9f}, {P_HOT_SPEED, .32f}, {P_HOT_LEN, .18f}, {P_RIM_W, 3.6f}, {P_GLOW, 1}, {P_BOB, .4f}, {P_FOLLOW, .3f}, {P_BLINK, .1f}, {P_A3, .2f}};
static const KV kv17[] = {{P_JITTER, 2.4f}, {P_DART, 1}, {P_TREMBLE, 1.1f}, {P_EYE_W, .9f}, {P_EYE_H, 1.15f}, {P_SCALE, .96f}, {P_BLINK, .8f}, {P_FOLLOW, 0}, {P_A3, 0}};
static const KV kv18[] = {{P_LID_O, .32f}, {P_LID_I, .32f}, {P_EYE_W, 1.15f}, {P_EYE_H, .55f}, {P_GAZE_X, -4}, {P_GAZE_Y, -3}, {P_FOLLOW, .15f}, {P_SAG, .25f}, {P_BLINK, .15f}, {P_BOB, .8f}};
static const KV kv19[] = {{P_BITE, .65f}, {P_EYE_W, 1.3f}, {P_EYE_H, .7f}, {P_A3, 1.2f}, {P_S3, .35f}, {P_BREATHE, .02f}, {P_BREATHE_SPEED, .35f}, {P_GLOW, .9f}, {P_BLUSH, .2f}, {P_BLINK, .1f}};
static const KV kv20[] = {{P_A5, 2.2f}, {P_S5, .9f}, {P_A8, 1.8f}, {P_S8, -1.4f}, {P_A3, 0}, {P_ASYM, -.2f}, {P_SWING, 4}, {P_SWING_SPEED, .45f}, {P_SCAN, .45f}, {P_SCAN_SPEED, .35f}, {P_FOLLOW, .2f}};
static const KV kv21[] = {{P_SPIKE, 9}, {P_LID_I, .42f}, {P_EYE_H, .9f}, {P_EYE_W, 1.05f}, {P_TREMBLE, .45f}, {P_GLOW, 1.25f}, {P_RIM_W, 3.6f}, {P_SCALE, 1.03f}, {P_BOB, .5f}, {P_BLINK, .1f}, {P_A3, 0}, {P_FOLLOW, .7f}, {P_TINT, .24f}};
static const KV kv30[] = {{P_ECG, 13}, {P_ECG_SPEED, .5f}, {P_GAZE_X, 4}, {P_GAZE_Y, -4}, {P_FOLLOW, .2f}, {P_EYE_H, .95f}, {P_BLINK, .22f}, {P_A3, 0}};
static const KV kv31[] = {{P_EYE_H, 1.05f}, {P_FOLLOW, .8f}, {P_A3, .4f}};
static const KV kv32[] = {{P_ECG, 9}, {P_ECG_SPEED, 1.1f}, {P_HOT, .45f}, {P_HOT_SPEED, 1.4f}, {P_HOT_LEN, .08f}, {P_EYE_H, .82f}, {P_LID_B, .15f}, {P_BOB, .7f}, {P_BOB_SPEED, 2.2f}, {P_FOLLOW, .2f}, {P_A3, 0}, {P_BLINK, .2f}};
static const KV kv33[] = {{P_BITE, 1}, {P_EYE_W, 1.4f}, {P_EYE_H, .7f}, {P_A5, 1}, {P_S5, .6f}, {P_A3, 0}, {P_GLOW, 1.1f}, {P_BLINK, 0}};
static const KV kv34[] = {{P_GLITCH, 1}, {P_EYE_H, .5f}, {P_EYE_W, 1.2f}, {P_ASYM, .32f}, {P_LID_I, .15f}, {P_JITTER, .6f}, {P_BLINK, 0}, {P_FOLLOW, 0}, {P_A3, 0}};
static const KV kv35[] = {{P_GLOW_PULSE, 1}, {P_GLOW_SPEED, .55f}, {P_FOLLOW, 1.25f}, {P_EYE_H, 1.06f}, {P_EYE_Y, -1}, {P_TILT, 3}, {P_BLINK, .25f}};
static const KV kv36[] = {{P_HOT, 1}, {P_HOT_SPEED, .85f}, {P_HOT_LEN, .22f}, {P_EYE_HOT, 1}, {P_DIM, .28f}, {P_EYE_H, .9f}, {P_FOLLOW, 0}, {P_A3, 0}, {P_BLINK, .15f}};
static const KV kv37[] = {{P_A5, 1.6f}, {P_S5, -.5f}, {P_A3, 0}, {P_ECHO, 1}, {P_GAZE_X, -5}, {P_GAZE_Y, -4}, {P_FOLLOW, .2f}, {P_LID_B, .1f}, {P_BLINK, .15f}};
static const KV kv38[] = {{P_BOXY, 1}, {P_LID_I, .25f}, {P_EYE_H, .8f}, {P_EYE_W, 1.1f}, {P_RIM_W, 4}, {P_A3, 0}, {P_FOLLOW, .3f}, {P_BLINK, .15f}};
static const KV kv39[] = {{P_VOICE, 5}, {P_FOLLOW, .9f}, {P_BOB, 1.2f}, {P_BOB_SPEED, .8f}, {P_BLINK, .35f}, {P_A3, .2f}};
static const KV kv40[] = {{P_HOT, .9f}, {P_HOT_SPEED, 1.6f}, {P_HOT_LEN, .1f}, {P_SCAN, 1}, {P_SCAN_SPEED, .9f}, {P_FOLLOW, 0}, {P_EYE_W, .95f}, {P_EYE_H, .9f}, {P_LID_B, .1f}, {P_A3, 0}, {P_BLINK, .1f}};
static const KV kv41[] = {{P_DIM, .5f}, {P_GLOW, .15f}, {P_EYE_H, .22f}, {P_EYE_W, .95f}, {P_BLINK, 0}, {P_FOLLOW, 0}, {P_BOB, 0}, {P_BREATHE, 0}, {P_A3, 0}, {P_TINT, .05f}};

#define PULSE_KV(a) a, (uint8_t)(sizeof(a) / sizeof(a[0]))

//  id    name          color     kv            from ease  enter                         every       period ringR inR  ecgN hold
static const StateDef kStates[] = {
  {"00", "睡眠",       0x5D6FA8, PULSE_KV(kv00), -1, 0,    {0},                          0,          0,     0,    0,   0, 0},
  {"01", "唤醒",       0x8BF3FF, PULSE_KV(kv01),  0, 2.2f, {I_STRETCH, I_FLASH},         0,          0,     0,    0,   0, 3400},
  {"02", "待机放空",   0x8BF3FF, PULSE_KV(kv02), -1, 0,    {0},                          0,          0,     0,    0,   0, 0},
  {"03", "好奇",       0x9CFFE0, PULSE_KV(kv03), -1, 0,    {0},                          0,          0,     0,    0,   0, 0},
  {"04", "发呆",       0x7FD3E0, PULSE_KV(kv04), -1, 0,    {0},                          0,          0,     0,    0,   0, 0},
  {"05", "加载苏醒",   0x6FA8FF, PULSE_KV(kv05),  6, 3.0f, {I_DRAW},                     0,          0,     0,    0,   0, 3400},
  {"06", "休眠",       0x42507A, PULSE_KV(kv06), -1, 0,    {0},                          0,          0,     0,    0,   0, 0},
  {"07", "抖动唤醒",   0xA5F6FF, PULSE_KV(kv07),  0, 5.0f, {I_JOLT, I_FLASH, I_RING},    0,          0,     0,    0,   0, 3000},
  {"10", "开心",       0xFFD45C, PULSE_KV(kv10), -1, 0,    {I_HOP},                      I_HOP,      1.7f,  0,    0,   0, 0},
  {"11", "疑惑",       0xB9A6FF, PULSE_KV(kv11), -1, 0,    {0},                          0,          0,     0,    0,   0, 0},
  {"12", "失落",       0x6E88FF, PULSE_KV(kv12), -1, 3.5f, {0},                          0,          0,     0,    0,   0, 0},
  {"13", "惊讶",       0xFFFFFF, PULSE_KV(kv13), -1, 9.0f, {I_BURST, I_FLASH, I_RING},   0,          0,     0,    0,   0, 0},
  {"14", "害羞",       0xFF8EC6, PULSE_KV(kv14), -1, 0,    {0},                          0,          0,     0,    0,   0, 0},
  {"15", "疲惫",       0x8D97B5, PULSE_KV(kv15), -1, 0,    {0},                          I_SIGH,     3.6f,  0,    0,   0, 4000},
  {"16", "专注",       0x4FE6FF, PULSE_KV(kv16), -1, 0,    {0},                          0,          0,     0,    0,   0, 0},
  {"17", "慌张",       0xFF9F45, PULSE_KV(kv17), -1, 0,    {0},                          0,          0,     0,    0,   0, 0},
  {"18", "无奈",       0xA0AABF, PULSE_KV(kv18), -1, 0,    {0},                          I_SIGH,     2.9f,  0,    0,   0, 3400},
  {"19", "满意",       0x7CF5B0, PULSE_KV(kv19), -1, 0,    {I_NOD},                      0,          0,     0,    0,   0, 0},
  {"20", "困惑",       0xB68CFF, PULSE_KV(kv20), -1, 0,    {0},                          0,          0,     0,    0,   0, 0},
  {"21", "生气",       0xFF4D5E, PULSE_KV(kv21), -1, 0,    {I_FLASH},                    0,          0,     0,    0,   0, 0},
  {"30", "思考中",     0xCFF7FF, PULSE_KV(kv30), -1, 0,    {0},                          0,          0,     0,    0,   0, 0},
  {"31", "接收任务",   0x6FE9FF, PULSE_KV(kv31), -1, 0,    {I_NOD, I_FLASH},             0,          0,     0,    0.9f, 0, 0},
  {"32", "处理中忙碌", 0x4FB8FF, PULSE_KV(kv32), -1, 0,    {0},                          0,          0,     0,    0,   3, 0},
  {"33", "任务完成",   0x6CF5A0, PULSE_KV(kv33), -1, 0,    {I_HOP, I_FLASH, I_RING2},    0,          0,     0.75f, 0,  0, 0},
  {"34", "出错",       0xFF5A3C, PULSE_KV(kv34), -1, 0,    {I_FLASH},                    0,          0,     0,    0,   0, 0},
  {"35", "等待输入",   0x8BF3FF, PULSE_KV(kv35), -1, 0,    {0},                          0,          0,     0,    0,   0, 0},
  {"36", "联网加载",   0x5B8CFF, PULSE_KV(kv36), -1, 0,    {0},                          0,          0,     0,    0,   0, 0},
  {"37", "复述回忆",   0xA78BFF, PULSE_KV(kv37), -1, 0,    {0},                          0,          0,     0,    0,   0, 0},
  {"38", "拒绝/受限",  0xFFB547, PULSE_KV(kv38), -1, 0,    {I_SHAKE},                    I_SHAKE,    2.4f,  0,    0,   0, 3000},
  {"39", "输出回复",   0x9FF6FF, PULSE_KV(kv39), -1, 0,    {0},                          0,          0,     0,    0,   0, 0},
  {"40", "检索资料",   0x35E0C9, PULSE_KV(kv40), -1, 0,    {0},                          0,          0,     0,    0,   0, 0},
  {"41", "停止终止",   0x7A8494, PULSE_KV(kv41), -1, 0,    {I_STOP},                     0,          0,     0,    0,   0, 0},
};
static constexpr int kStateCount = sizeof(kStates) / sizeof(kStates[0]);
