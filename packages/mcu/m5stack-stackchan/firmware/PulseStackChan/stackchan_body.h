#pragma once
// 脉冲 Pulse · M5Stack 官方 StackChan（K151）机身支持（原创代码）
// 机身里的 IO 扩展芯片（I2C 0x6F，挂在 CoreS3 内部 I2C 上）负责：舵机电源开关、12 颗 RGB 灯
// 寄存器定义参考了 M5Stack 官方 StackChan-BSP（MIT 许可）
#include <Arduino.h>

namespace body {
bool probe();                                  // 机身在不在（读芯片版本号）
bool begin();                                  // 检测并初始化（舵机电源脚、灯带），成功返回 true
bool ok();                                     // 已初始化
void servoPower(bool on);                      // 舵机电源（VM_EN）
void setAll(uint8_t r, uint8_t g, uint8_t b);  // 12 颗灯设成同一个颜色（0–255）
constexpr int kLedCount = 12;
// 2.7：每颗灯单独设颜色（rgb = kLedCount × 3 字节，0–255），用于彩虹 / 流光灯效
void setLeds(const uint8_t* rgb);
}  // namespace body
