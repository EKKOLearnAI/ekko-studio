// 脉冲 Pulse · M5Stack 官方 StackChan（K151）机身支持（原创代码）
#include "stackchan_body.h"
#include <M5Unified.h>

namespace body {

static constexpr uint8_t kAddr = 0x6F;
static constexpr uint32_t kFreq = 100000;
static constexpr uint8_t REG_VERSION = 0x02;
static constexpr uint8_t REG_DIR_L = 0x03, REG_DIR_H = 0x04;  // 1 = 输出
static constexpr uint8_t REG_OUT_L = 0x05, REG_OUT_H = 0x06;
static constexpr uint8_t REG_PU_L = 0x09, REG_PU_H = 0x0A;
static constexpr uint8_t REG_PD_L = 0x0B, REG_PD_H = 0x0C;
static constexpr uint8_t REG_DRV_L = 0x13, REG_DRV_H = 0x14;  // 1 = 开漏
static constexpr uint8_t REG_LED_CFG = 0x24;                  // 低 6 位 = 灯数，bit6 = 刷新
static constexpr uint8_t REG_LED_RAM = 0x30;                  // 每颗灯 2 字节 RGB565（低字节在前）
static constexpr uint8_t PIN_VM_EN = 0;
static constexpr uint8_t PIN_LED = 13;
static constexpr int kLeds = 12;

static bool s_ok = false;
static uint8_t s_ledCfg = kLeds;

static void setBit(uint8_t regL, uint8_t regH, uint8_t pin, bool on) {
  const uint8_t reg = pin < 8 ? regL : regH;
  const uint8_t mask = (uint8_t)(1u << (pin & 7));
  if (on) m5::In_I2C.bitOn(kAddr, reg, mask, kFreq);
  else m5::In_I2C.bitOff(kAddr, reg, mask, kFreq);
}

static void outputPullUp(uint8_t pin) {
  setBit(REG_DIR_L, REG_DIR_H, pin, true);
  setBit(REG_PD_L, REG_PD_H, pin, false);
  setBit(REG_PU_L, REG_PU_H, pin, true);
}

bool probe() {
#if defined(CONFIG_IDF_TARGET_ESP32S3)
  if (!m5::In_I2C.isEnabled()) return false;
  const uint8_t v = m5::In_I2C.readRegister8(kAddr, REG_VERSION, kFreq);
  return v != 0 && v != 0xFF;
#else
  return false;
#endif
}

bool begin() {
  if (s_ok) return true;
  if (!probe()) return false;
  outputPullUp(PIN_VM_EN);
  outputPullUp(PIN_LED);
  setBit(REG_DRV_L, REG_DRV_H, PIN_LED, false);  // 推挽
  m5::In_I2C.writeRegister8(kAddr, REG_LED_CFG, kLeds & 0x3F, kFreq);
  delay(30);
  s_ledCfg = m5::In_I2C.readRegister8(kAddr, REG_LED_CFG, kFreq) & ~0x40;
  if ((s_ledCfg & 0x3F) != kLeds) s_ledCfg = kLeds;
  s_ok = true;
  setAll(0, 0, 0);
  delay(20);
  setAll(0, 0, 0);
  return true;
}

bool ok() { return s_ok; }

void servoPower(bool on) {
  if (!s_ok) return;
  setBit(REG_OUT_L, REG_OUT_H, PIN_VM_EN, on);
}

void setAll(uint8_t r, uint8_t g, uint8_t b) {
  if (!s_ok) return;
  const uint16_t c = (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
  uint8_t d[kLeds * 2];
  for (int i = 0; i < kLeds; i++) {
    d[2 * i] = (uint8_t)(c & 0xFF);
    d[2 * i + 1] = (uint8_t)(c >> 8);
  }
  m5::In_I2C.writeRegister(kAddr, REG_LED_RAM, d, sizeof(d), kFreq);
  m5::In_I2C.writeRegister8(kAddr, REG_LED_CFG, s_ledCfg | 0x40, kFreq);
}

static_assert(kLedCount == kLeds, "灯数要一致");

void setLeds(const uint8_t* rgb) {
  if (!s_ok || !rgb) return;
  uint8_t d[kLeds * 2];
  for (int i = 0; i < kLeds; i++) {
    const uint8_t r = rgb[3 * i], g = rgb[3 * i + 1], b = rgb[3 * i + 2];
    const uint16_t c = (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
    d[2 * i] = (uint8_t)(c & 0xFF);
    d[2 * i + 1] = (uint8_t)(c >> 8);
  }
  m5::In_I2C.writeRegister(kAddr, REG_LED_RAM, d, sizeof(d), kFreq);
  m5::In_I2C.writeRegister8(kAddr, REG_LED_CFG, s_ledCfg | 0x40, kFreq);
}

}  // namespace body
