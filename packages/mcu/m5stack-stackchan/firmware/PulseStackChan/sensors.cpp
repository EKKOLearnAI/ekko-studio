// 脉冲 Pulse · 姿态 / 接近传感器（原创代码）
#include "sensors.h"
#include <M5Unified.h>

namespace sensors {

namespace {
// ---- IMU ----
bool s_imu = false;
uint32_t s_imuNext = 0;
float s_last[3] = {0, 0, 0};
bool s_haveLast = false;
uint32_t s_peaks[4] = {0, 0, 0, 0};
int s_nPeaks = 0;
uint32_t s_cooldown = 0, s_joltAt = 0;
float s_joltMag = 0;

// ---- LTR-553（CoreS3 内置，I2C 0x23）----
constexpr uint8_t kLtr = 0x23;
constexpr uint32_t kLtrFreq = 400000;
bool s_prox = false, s_near = false;
uint32_t s_proxNext = 0, s_quietUntil = 0, s_nearSince = 0;
int s_pv = 0, s_nearCount = 0, s_farCount = 0;
float s_base = -1;
uint32_t s_nearEnd = 0;  // 上一次「靠近」结束的时刻（手挡住传感器会让光线读数变黑）

// ---- 环境光（ALS）：增益 8 倍、积分 100 毫秒、每 500 毫秒一次（0.125 – 8000 lux）----
constexpr float kAlsGain = 8.f;
constexpr float kDarkLux = 2.5f, kLightLux = 12.f;
constexpr uint32_t kDarkHold = 3000, kLightHold = 2000, kProxSettle = 3000;
bool s_als = false, s_dark = false, s_alsPrimed = false;
uint32_t s_alsNext = 0, s_darkSince = 0, s_lightSince = 0;
float s_lux = -1.f;
int s_alsSamples = 0;

// LTR-553 数据手册里的换算：按两个通道（可见 + 红外 / 红外）的比例分段
float alsLux(uint16_t ch0, uint16_t ch1) {
  const float sum = (float)ch0 + (float)ch1;
  if (sum <= 0.f) return 0.f;
  const float ratio = (float)ch1 / sum;
  float lux;
  if (ratio < .45f) lux = 1.7743f * ch0 + 1.1059f * ch1;
  else if (ratio < .64f) lux = 4.2785f * ch0 - 1.9548f * ch1;
  else if (ratio < .85f) lux = .5926f * ch0 + .1185f * ch1;
  else lux = 0.f;
  lux /= kAlsGain;  // 积分时间 100 毫秒 = 系数 1
  return lux > 0.f ? lux : 0.f;
}
}  // namespace

void begin(bool cores3) {
  s_imu = M5.Imu.isEnabled();
  if (s_imu) Serial.println("[imu] 姿态传感器已启用（摇一摇会晕）");
  if (!cores3 || !m5::In_I2C.isEnabled()) return;
  uint8_t id = 0;
  if (!m5::In_I2C.readRegister(kLtr, 0x86, &id, 1, kLtrFreq) || (id & 0xF0) != 0x90) return;
  m5::In_I2C.writeRegister8(kLtr, 0x82, 0x7B, kLtrFreq);  // 红外灯：60 kHz、100% 占空、50 mA
  m5::In_I2C.writeRegister8(kLtr, 0x83, 0x04, kLtrFreq);  // 每次测量 4 个脉冲
  m5::In_I2C.writeRegister8(kLtr, 0x84, 0x00, kLtrFreq);  // 每 50 毫秒测一次
  m5::In_I2C.writeRegister8(kLtr, 0x81, 0x03, kLtrFreq);  // 接近检测：开始工作
  s_prox = true;
  Serial.println("[prox] 接近传感器已启用（手靠近会把它叫醒）");
  // 2.7：顺便打开光线检测（只读，不影响接近检测）
  const bool rateOk = m5::In_I2C.writeRegister8(kLtr, 0x85, 0x03, kLtrFreq);   // 积分 100 毫秒、每 500 毫秒测一次
  const bool alsOn = m5::In_I2C.writeRegister8(kLtr, 0x80, 0x0D, kLtrFreq);    // 增益 8 倍、开始工作
  s_als = rateOk && alsOn;
  s_alsNext = millis() + 700;  // 第一次积分完成之后再读
  if (s_als) Serial.println("[als] 环境光传感器已启用（关灯 / 开灯会有反应）");
}

bool alsOk() { return s_als; }
float lux() { return s_alsPrimed ? s_lux : -1.f; }
bool dark() { return s_als && s_alsPrimed && s_dark; }

bool imuOk() { return s_imu; }
bool proxOk() { return s_prox; }
int proxValue() { return s_pv; }
int proxBaseline() { return (int)s_base; }
void quietProximity(uint32_t ms) { s_quietUntil = millis() + ms; }

uint8_t update(uint32_t now, float vig) {
  uint8_t ev = 0;
  // ---- 摇晃 / 冲击：每 100 毫秒采一次，三个轴加速度变化量之和 ----
  if (s_imu && (int32_t)(now - s_imuNext) >= 0) {
    s_imuNext = now + 100;
    M5.Imu.update();
    float a[3];
    if (M5.Imu.getAccel(&a[0], &a[1], &a[2])) {
      if (s_haveLast) {
        const float d = (fabsf(a[0] - s_last[0]) + fabsf(a[1] - s_last[1]) + fabsf(a[2] - s_last[2])) * 9.81f;  // m/s²
        const float th = 16.f * (vig > 200.f ? 1.5f : 1.f);  // 官方固件：16 m/s²
        if (d > th && (int32_t)(now - s_cooldown) >= 0) {
          if (s_nPeaks < 4) s_peaks[s_nPeaks++] = now;
          else { memmove(s_peaks, s_peaks + 1, sizeof(uint32_t) * 3); s_peaks[3] = now; }
          if (s_nPeaks == 1) { s_joltAt = now; s_joltMag = d; }
          int recent = 0;
          for (int i = 0; i < s_nPeaks; i++)
            if (now - s_peaks[i] <= 1000) recent++;
          if (recent >= 3) {
            ev |= SE_SHAKE;
            s_nPeaks = 0;
            s_joltAt = 0;
            s_cooldown = now + 1500;
          }
        }
        // 只有一次冲击、之后 0.6 秒没再晃：算「被撞了一下」
        if (s_joltAt && now - s_joltAt > 600) {
          if (s_nPeaks == 1 && s_joltMag > 20.f) ev |= SE_JOLT;
          s_joltAt = 0;
          s_nPeaks = 0;
        }
        if (s_nPeaks && now - s_peaks[s_nPeaks - 1] > 1200) s_nPeaks = 0;
      }
      memcpy(s_last, a, sizeof(a));
      s_haveLast = true;
    }
  }
  // ---- 接近：基线慢慢跟随环境，读数明显高出基线 = 有东西靠近 ----
  if (s_prox && (int32_t)(now - s_proxNext) >= 0) {
    s_proxNext = now + 100;
    uint8_t d[2] = {0, 0};
    if (m5::In_I2C.readRegister(kLtr, 0x8D, d, 2, kLtrFreq)) {
      s_pv = d[0] | ((d[1] & 0x07) << 8);
      if (s_base < 0) s_base = (float)s_pv;
      const float delta = fmaxf(120.f, s_base * .4f);
      if (!s_near) {
        if (s_pv > s_base + delta) s_nearCount++;
        else {
          s_nearCount = 0;
          s_base += ((float)s_pv - s_base) * .03f;
        }
        if (s_nearCount >= 2) {
          s_near = true;
          s_nearSince = now;
          s_farCount = 0;
          if ((int32_t)(now - s_quietUntil) >= 0) ev |= SE_NEAR;
        }
      } else {
        if (s_pv < s_base + delta * .4f) s_farCount++;
        else s_farCount = 0;
        if (s_farCount >= 4) {
          s_near = false;
          s_nearCount = 0;
          s_nearEnd = now;
          ev |= SE_FAR;
        } else if (now - s_nearSince > 20000) {  // 一直挡着（比如放在墙边）：当成新的环境基线
          s_near = false;
          s_nearCount = 0;
          s_nearEnd = now;
          s_base = (float)s_pv;
        }
      }
    }
  }
  // ---- 环境光：平滑 + 迟滞 + 持续时间，手挡住传感器（接近）的时候和之后 3 秒不算 ----
  if (s_als && (int32_t)(now - s_alsNext) >= 0) {
    s_alsNext = now + 500;
    uint8_t d[4] = {0, 0, 0, 0};
    uint8_t st = 0;
    // 先读 0x8C 状态（bit7 = 数据无效），再按顺序读 CH1、CH0（读 CH1 低字节会锁住这一组数据）
    if (m5::In_I2C.readRegister(kLtr, 0x8C, &st, 1, kLtrFreq) && !(st & 0x80) &&
        m5::In_I2C.readRegister(kLtr, 0x88, d, 4, kLtrFreq)) {
      const uint16_t ch1 = (uint16_t)(d[0] | (d[1] << 8)), ch0 = (uint16_t)(d[2] | (d[3] << 8));
      const float raw = alsLux(ch0, ch1);
      const bool covered = s_near || (s_nearEnd && now - s_nearEnd < kProxSettle);
      if (!s_alsPrimed) {
        s_lux = raw;
        if (++s_alsSamples >= 2) {  // 开机的头两次读数：直接定下亮 / 暗，不发事件（不会一开机就「被关灯」）
          s_alsPrimed = true;
          s_dark = s_lux < (kDarkLux + kLightLux) * .5f;
        }
      } else if (!covered) {
        // 变暗跟得快一点，变亮慢一点（开灯的瞬间常有闪烁）
        const float a = raw < s_lux ? .45f : .30f;
        s_lux += (raw - s_lux) * a;
        if (!s_dark) {
          s_lightSince = 0;
          if (s_lux < kDarkLux) {
            if (!s_darkSince) s_darkSince = now ? now : 1;
            if (now - s_darkSince >= kDarkHold) { s_dark = true; s_darkSince = 0; ev |= SE_DARK; }
          } else s_darkSince = 0;
        } else {
          s_darkSince = 0;
          if (s_lux > kLightLux) {
            if (!s_lightSince) s_lightSince = now ? now : 1;
            if (now - s_lightSince >= kLightHold) { s_dark = false; s_lightSince = 0; ev |= SE_LIGHT; }
          } else s_lightSince = 0;
        }
      } else {
        s_darkSince = s_lightSince = 0;  // 挡着的时候不计时
      }
    }
  }
  return ev;
}

}  // namespace sensors
