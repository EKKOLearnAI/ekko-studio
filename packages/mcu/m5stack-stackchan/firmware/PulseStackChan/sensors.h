#pragma once
// 脉冲 Pulse · 姿态传感器（IMU：被摇晃、被撞了一下）和接近传感器（CoreS3：有人靠近）（原创代码）
#include <Arduino.h>

namespace sensors {

enum : uint8_t {
  SE_SHAKE = 1,  // 被摇晃（1 秒内 3 次明显的晃动，和官方固件的判断一样）
  SE_JOLT = 2,   // 被撞 / 拍了一下（单独一次明显的冲击）
  SE_NEAR = 4,   // 有东西靠近屏幕上方的接近传感器（CoreS3）
  SE_FAR = 8,    // 又离开了
  SE_DARK = 16,  // 2.7：环境变暗了（关灯；需持续 3 秒）
  SE_LIGHT = 32, // 2.7：又亮起来了（开灯 / 天亮；需持续 2 秒）
};

void begin(bool cores3);
// 每帧调用，返回这次发生的事件。motionVigor = 头自己在动的速度（°/s）：动得快时提高判断门槛，避免把自己的动作当成被摇晃
uint8_t update(uint32_t now, float motionVigor);
void quietProximity(uint32_t ms);  // 这段时间里不报「有人靠近」（手指在点屏幕时）
bool imuOk();
bool proxOk();
int proxValue();      // 最近一次的接近传感器读数（0–2047）
int proxBaseline();
// 2.7：环境光（同一颗 LTR-553 的光线部分；只有 CoreS3 有）
bool alsOk();
float lux();          // 平滑后的照度（lux）；还没有读数时返回 -1
bool dark();          // 现在算不算「黑」（带迟滞，见 SE_DARK / SE_LIGHT）

}  // namespace sensors
