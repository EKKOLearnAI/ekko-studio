#pragma once
// 脉冲 Pulse · 表情引擎和音效共用的事件定义（不依赖硬件）
#include <stdint.h>

namespace pulse {

// 一次性动作（进入状态时触发，或周期触发）
enum Imp : uint8_t { I_NONE = 0, I_HOP, I_SHAKE, I_NOD, I_STRETCH, I_SIGH, I_FLASH, I_BURST, I_JOLT, I_DRAW, I_STOP, I_RING, I_RING2, I_INRING };

// Engine::takeEvents() 返回的位掩码：状态里周期发生的视觉事件，音效跟着它们走
enum : uint32_t {
  EV_PERIODIC = 1u << 16,  // 周期动作触发（同时置位 1u << 动作类型，例如 1u << I_HOP）
  EV_RING_OUT = 1u << 17,  // 周期性向外扩散的光环
  EV_RING_IN = 1u << 18,   // 周期性向内收的光环
  EV_ECG = 1u << 19,       // 心电脉冲经过顶部
  EV_HOT = 1u << 20,       // 高亮光段绕轮廓转完一圈
};

// 屏幕上飘出来的小图案（Engine::emit）
enum Fx : uint8_t {
  FX_HEART = 0, FX_QUESTION, FX_EXCLAIM, FX_Z, FX_NOTE, FX_SPARK,
  // 2.8 陪伴版：水滴（喝水）、一碗饭（吃饭）、月亮（早点睡）、铃铛（提醒）、对勾（任务完成）、小红花（夸你）、伸懒腰的小人（起来活动）
  FX_DROP, FX_BOWL, FX_MOON, FX_BELL, FX_CHECK, FX_FLOWER, FX_PERSON,
  FX_KINDS
};
constexpr uint8_t FX_LEGACY_KINDS = FX_DROP;  // 内存很紧时只生成前 6 种，新的图案换成相近的旧图案

}  // namespace pulse
