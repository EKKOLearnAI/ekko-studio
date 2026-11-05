// 脉冲 Pulse · 头顶触摸条（原创代码）
#include "head_touch.h"
#include <M5Unified.h>

namespace headtouch {

namespace {
constexpr uint8_t kAddr = 0x68;
constexpr uint32_t kFreq = 100000;
constexpr uint32_t kPollMs = 40;
constexpr uint32_t kTapMs = 450, kHoldMs = 1200;

bool s_ok = false, s_down = false, s_holdSent = false;
uint32_t s_next = 0, s_downAt = 0;
uint8_t s_raw = 0, s_offCount = 0, s_swipes = 0;
int8_t s_dir = 1;
float s_ref = 0, s_pos = 0;
uint32_t s_chStart[3] = {0, 0, 0};
bool s_chOn[3] = {false, false, false};
bool s_seqDone = false;

bool w(uint8_t reg, uint8_t v) { return m5::In_I2C.writeRegister8(kAddr, reg, v, kFreq); }
}  // namespace

bool begin() {
  if (s_ok) return true;
  if (!m5::In_I2C.isEnabled()) return false;
  uint8_t v = 0;
  if (!m5::In_I2C.readRegister(kAddr, 0x08, &v, 1, kFreq)) return false;
  // 和官方 BSP 一样：打开全部通道和基线校准 → 软件复位 → 配置 → 灵敏度（低灵敏度类型，第 3 档）
  for (uint8_t r = 0x0A; r <= 0x0F; r++) w(r, 0x00);
  w(0x09, 0x0F);
  w(0x09, 0x07);
  w(0x08, 0x22);
  for (uint8_t r = 0x02; r <= 0x06; r++) w(r, 0x33);
  s_ok = true;
  Serial.println("[touch] 头顶触摸条已启用");
  return true;
}

bool ok() { return s_ok; }
bool touching() { return s_down; }
int8_t swipeDir() { return s_dir; }
uint8_t swipeCount() { return s_swipes; }
uint8_t raw() { return s_raw; }

uint8_t update(uint32_t now) {
  if (!s_ok || (int32_t)(now - s_next) < 0) return 0;
  s_next = now + kPollMs;
  uint8_t r = 0;
  if (!m5::In_I2C.readRegister(kAddr, 0x10, &r, 1, kFreq)) return 0;
  s_raw = r;
  // 每段 2 位（0–3 = 力度）；和官方 BSP 一样把顺序反过来，0 = 前面
  int in[3];
  for (int i = 0; i < 3; i++) in[2 - i] = (r >> (2 * i)) & 3;
  const int sum = in[0] + in[1] + in[2];
  uint8_t ev = 0;

  if (sum > 0) {
    s_offCount = 0;
    const float pos = (float)(-100 * in[0] + 100 * in[2]) / (float)sum;  // -100（前）… +100（后）
    if (!s_down) {
      s_down = true;
      s_downAt = now;
      s_holdSent = false;
      s_swipes = 0;
      s_ref = s_pos = pos;
      s_seqDone = false;
      for (int i = 0; i < 3; i++) s_chOn[i] = false;
      ev |= HT_PRESS;
    }
    s_pos += (pos - s_pos) * .6f;
    // 摸头方式一：位置移动了一段（来回摸的时候每一下都算）
    if (fabsf(s_pos - s_ref) > 70.f) {
      s_dir = s_pos > s_ref ? 1 : -1;
      s_ref = s_pos;
      s_swipes++;
      ev |= HT_SWIPE;
    }
    // 摸头方式二（官方 BSP 的判断）：三段依次被碰到，间隔 30–400 毫秒
    for (int i = 0; i < 3; i++)
      if (in[i] > 0 && !s_chOn[i]) { s_chOn[i] = true; s_chStart[i] = now; }
    if (!s_seqDone && s_chOn[0] && s_chOn[1] && s_chOn[2] && !(ev & HT_SWIPE)) {
      const int32_t a = (int32_t)(s_chStart[1] - s_chStart[0]), b = (int32_t)(s_chStart[2] - s_chStart[1]);
      s_seqDone = true;
      if ((a > 30 && b > 30 && a < 400 && b < 400) || (-a > 30 && -b > 30 && -a < 400 && -b < 400)) {
        s_dir = a > 0 ? 1 : -1;
        s_ref = s_pos;
        s_swipes++;
        ev |= HT_SWIPE;
      }
    }
    if (!s_holdSent && !s_swipes && now - s_downAt >= kHoldMs) {
      s_holdSent = true;
      ev |= HT_HOLD;
    }
  } else if (s_down) {
    if (++s_offCount >= 2) {  // 连续两次没碰到才算松手（防抖）
      s_down = false;
      ev |= HT_RELEASE;
      if (!s_swipes && !s_holdSent && now - s_downAt < kTapMs + 2 * kPollMs) ev |= HT_TAP;
    }
  }
  return ev;
}

}  // namespace headtouch
