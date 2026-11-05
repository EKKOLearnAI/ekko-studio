#pragma once
// 脉冲 Pulse · 音效数据（由 tools/make_sfx_bank.py 自动生成，不要手改）
// 37 个音效，μ-law 8 位 24000 Hz，合计 520068 字节
#include <stdint.h>

namespace sfx {

constexpr int kClipRate = 24000;

enum Clip : uint8_t {
  C_NONE = 0,
  C_EKKO_BOOT,
  C_EKKO_EYES_OPEN,
  C_EKKO_HAPPY,
  C_EKKO_ACK,
  C_EKKO_TALK,
  C_TRACK_SNORE,
  C_TRACK_FACE_FOUND,
  C_TRACK_EYES_OPEN,
  C_TRACK_SURPRISE,
  C_TRACK_HEART,
  C_TRACK_ITS_YOU,
  C_TRACK_DIZZY,
  C_TRACK_LISTEN,
  C_TRACK_HM,
  C_TRACK_RECOGNIZED,
  C_TRACK_OK,
  C_TRACK_LALALA,
  C_TRACK_GIGGLE,
  C_HOME_SLEEP_Z,
  C_HOME_WAKE,
  C_HOME_DETECT,
  C_HOME_SURPRISE,
  C_HOME_JOY,
  C_HOME_NOD,
  C_HOME_NOD_X3,
  C_HOME_GIGGLE,
  C_HOME_HM,
  C_HOME_SEND,
  C_HOME_WOW,
  C_HOME_POP,
  C_HOME_HEY,
  C_HOME_TADA,
  C_HOME_BROADCAST,
  C_HOME_LIGHTS_ON,
  C_HOME_FINAL_NOD,
  C_HOME_SIGH,
  C_TOUCH_DIRTY_HANDS,
  C_COUNT
};

struct ClipDef {
  const char* name;
  const uint8_t* data;  // G.711 μ-law，每个采样 1 字节
  uint32_t samples;
};

extern const ClipDef kClips[C_COUNT];  // kClips[0] = 空
int findClip(const char* name);        // 按名字找（例如 "home_nod"），找不到返回 0

}  // namespace sfx
