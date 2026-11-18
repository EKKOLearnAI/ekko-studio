#pragma once
// 脉冲 Pulse · 官方 StackChan 机身头顶的触摸条（Si12T，3 段，I2C 0x68）（原创代码）
// 初始化寄存器参考了 M5Stack 官方 StackChan-BSP（MIT 许可）
#include <Arduino.h>

namespace headtouch {

enum : uint8_t {
  HT_PRESS = 1,    // 手放上来
  HT_RELEASE = 2,  // 手拿开
  HT_TAP = 4,      // 轻拍一下（很快拿开、没有滑动）
  HT_SWIPE = 8,    // 摸头：沿着触摸条滑了一下（每滑一下来一次）
  HT_HOLD = 16,    // 一直按着不动（1.2 秒）
};

bool begin();                   // 检测并初始化（只在检测到官方机身时调用），成功返回 true
bool ok();
uint8_t update(uint32_t now);   // 每帧调用（内部每 40 毫秒读一次），返回这次发生的事件（位掩码）
bool touching();
int8_t swipeDir();              // 最近一次滑动的方向：+1 / -1
uint8_t swipeCount();           // 这次按下以来滑了几下
uint8_t raw();                  // 最近一次读到的原始值（3 段 × 2 位，诊断用）

}  // namespace headtouch
