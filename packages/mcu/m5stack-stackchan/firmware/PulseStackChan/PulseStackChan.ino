// 脉冲 Pulse · M5Stack StackChan 表情固件
// 支持：M5Stack 官方 StackChan（K151，自动识别机身舵机和灯光）
//       CoreS3 / CoreS3 SE / Core2 / Tough / Basic / Gray / Fire（社区版 Stack-chan：PWM 或 SCS0009 舵机）
// 依赖库：M5Unified（会自动带上 M5GFX）
#include "app.h"

void setup() { appSetup(); }
void loop() { appLoop(); }
