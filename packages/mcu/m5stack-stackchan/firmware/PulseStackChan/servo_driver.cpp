// 脉冲 Pulse · 头部舵机驱动（原创代码）
#include "servo_driver.h"
#include "config.h"

#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
#define PULSE_LEDC_V3 1
#else
#define PULSE_LEDC_V3 0
#endif

static constexpr int kLedcChan[2] = {4, 5};  // 避开 M5GFX 背光用的通道 7
static constexpr int kLedcBits = 14;
static constexpr int kPeriodUs = 20000;      // 50 Hz
// Feetech SCS 协议（SCS 系列多字节数据高字节在前）
static constexpr uint8_t kBroadcast = 0xFE;  // 广播：所有舵机执行、不回应答（不会和下一条指令撞车）
static constexpr uint8_t kRead = 0x02, kWrite = 0x03, kSyncWrite = 0x83;
static constexpr uint8_t kRegMinAngle = 0x09, kRegTorque = 0x28, kRegGoal = 0x2A, kRegPos = 0x38;
static constexpr float kK151StepsPerDeg = 3.2f;  // 官方机身：1 步 = 0.3125°

static inline float clampf_(float v, float a, float b) { return v < a ? a : (v > b ? b : v); }
static inline int clampi_(int v, int a, int b) { return v < a ? a : (v > b ? b : v); }

void HeadServo::begin(uint8_t type, int pinX, int pinY, bool invPan, bool invTilt) {
  end();
  _type = type;
  _pinX = pinX;
  _pinY = pinY;
  _invPan = invPan;
  _invTilt = invTilt;
  _ping[0] = _ping[1] = -1;
  _modeFixed = false;
  _trackingLimits = false;
  _rawPos[0] = _rawPos[1] = -1;
  if (_type == SERVO_OFF || pinX < 0 || pinY < 0) { _type = SERVO_OFF; return; }

  _cPan = _cTilt = 0;
  _sentPan = _sentTilt = 999;
  _paused = false;
  _pausedAck = false;
  if (_type == SERVO_PWM) {
#if PULSE_LEDC_V3
    ledcAttach(pinX, 50, kLedcBits);
    ledcAttach(pinY, 50, kLedcBits);
#else
    ledcSetup(kLedcChan[0], 50, kLedcBits);
    ledcAttachPin(pinX, kLedcChan[0]);
    ledcSetup(kLedcChan[1], 50, kLedcBits);
    ledcAttachPin(pinY, kLedcChan[1]);
#endif
    _initPending = false;
    _holdUntil = millis();
    sendPose(0, 0);
  } else {
    Serial2.begin(PULSE_SCS_BAUD, SERIAL_8N1, pinX, pinY);
    // 刚上电的舵机需要一点时间启动；检测、开扭矩和第一次（慢速）回中都在舵机任务里做，不卡住画面
    _initPending = true;
    _holdUntil = millis() + (_type == SERVO_K151 ? 450 : 80);
  }
  _run = true;
  _alive = true;
  if (xTaskCreatePinnedToCore(taskFn, "pulse_servo", 3072, this, 2, nullptr, 0) != pdPASS) {
    _alive = false;
    _run = false;
  }
}

void HeadServo::end() {
  if (_alive) {
    _run = false;
    for (int i = 0; i < 100 && _alive; i++) delay(5);
  }
  if (_type == SERVO_PWM) {
#if PULSE_LEDC_V3
    if (_pinX >= 0) ledcDetach(_pinX);
    if (_pinY >= 0) ledcDetach(_pinY);
#else
    if (_pinX >= 0) ledcDetachPin(_pinX);
    if (_pinY >= 0) ledcDetachPin(_pinY);
#endif
  } else if (serialBus()) {
    Serial2.flush();
    Serial2.end();
  }
  _type = SERVO_OFF;
  _paused = false;
  _initPending = false;
}

void HeadServo::taskFn(void* arg) {
  static_cast<HeadServo*>(arg)->loopTask();
  vTaskDelete(nullptr);
}

void HeadServo::loopTask() {
  TickType_t last = xTaskGetTickCount();
  uint32_t previousUs = micros();
  // 每种机身的最大角速度（°/s）：动作本身已经是平滑曲线，这里只防止突变
  const float vp = _type == SERVO_K151 ? 520.f : (_type == SERVO_SCS ? 420.f : 320.f);
  const float vt = _type == SERVO_K151 ? 360.f : (_type == SERVO_SCS ? 300.f : 240.f);
  int retry = 0;
  while (_run) {
    const uint32_t currentUs = micros();
    const float dt = fminf((currentUs - previousUs) * .000001f, .02f);
    previousUs = currentUs;
    const uint32_t now = millis();
    if (_paused || (int32_t)(now - _holdUntil) < 0) {
      _pausedAck = _paused;
      // 暂停（校准中）或等待中
    } else if (_initPending) {
      if (serialBus()) {
        checkServos(true);
        // 舵机刚上电时偶尔不应答：再等一会儿重试几次（每次 0.3 秒）
        if ((_ping[0] != 1 || _ping[1] != 1) && retry < 6) {
          retry++;
          _holdUntil = millis() + 300;
          last = xTaskGetTickCount();
          vTaskDelayUntil(&last, pdMS_TO_TICKS(20));
          continue;
        }
        if (_ping[0] != 1 || _ping[1] != 1) {
          setTorque(false);
          Serial.println("[servo] initialization failed: position mode not confirmed; motion disabled");
          _initPending = false;
          _run = false;
          break;
        }
        setTorque(true);
      }
      _sentPan = _sentTilt = 999;
      _cPan = _cTilt = 0;
      _slowMs = 700;  // 第一次用 0.7 秒慢慢转到正前方，避免猛地一甩
      sendPose(0, 0);
      _holdUntil = millis() + 750;
      _initPending = false;
      if (serialBus())
        Serial.printf("[servo] 舵机 1（左右）%s，舵机 2（上下）%s%s\n", _ping[0] == 1 ? "有应答" : "没有应答",
                      _ping[1] == 1 ? "有应答" : "没有应答", _modeFixed ? "，已从电机模式切回位置模式" : "");
    } else {
      if (_checkReq && serialBus()) {
        _checkReq = false;
        checkServos(false);
        if (_ping[0] != 1 || _ping[1] != 1) {
          setTorque(false);
          Serial.println("[servo] feedback check failed; motion disabled");
          _run = false;
          break;
        }
        _sentPan = _sentTilt = 999;  // 读完位置后重新发一次目标
      }
      const float tp = _tPan, tt = _tTilt;
      // 轻微平滑 + 限制角速度
      float dp = (tp - _cPan) * .6f, dq = (tt - _cTilt) * .6f;
      const float mp = (_trackingLimits ? 35.f : vp) * dt;
      const float mq = (_trackingLimits ? 20.f : vt) * dt;
      dp = clampf_(dp, -mp, mp);
      dq = clampf_(dq, -mq, mq);
      _cPan += dp;
      _cTilt += dq;
      sendPose(_cPan, _cTilt);
    }
    // A register query can block for several periods. Never replay missed
    // motion ticks in a burst: the speed limit applies to real elapsed time.
    if (xTaskGetTickCount() - last > pdMS_TO_TICKS(20)) last = xTaskGetTickCount();
    vTaskDelayUntil(&last, pdMS_TO_TICKS(20));
  }
  _alive = false;
}

void HeadServo::sendPose(float pan, float tilt) {
  // 最后的安全限位（度）
  if (_type == SERVO_K151) {
    pan = clampf_(pan, -80.f, 80.f);
  } else {
    pan = clampf_(pan, -60.f, 60.f);
    tilt = clampf_(tilt, -20.f, 20.f);
  }
  const bool chP = fabsf(pan - _sentPan) >= .12f;  // 变化太小就不发，减少抖动
  const bool chT = fabsf(tilt - _sentTilt) >= .12f;
  if (!chP && !chT) return;
  if (_type == SERVO_PWM) {
    if (chP) { _sentPan = pan; writePwm(0, pan); }
    if (chT) { _sentTilt = tilt; writePwm(1, tilt); }
    return;
  }
  if (!serialBus()) return;
  _sentPan = pan;
  _sentTilt = tilt;
  const uint16_t ms = _slowMs ? _slowMs : 20;
  _slowMs = 0;
  scsSyncPos(rawFor(0, pan), rawFor(1, tilt), ms);
}

// 相对正前方的角度（度）→ 串口舵机原始位置
int HeadServo::rawFor(int axis, float rel) const {
  const bool inv = axis ? _invTilt : _invPan;
  const float r = inv ? -rel : rel;
  if (_type == SERVO_K151) {
    if (axis == 0) {
      // 官方机身左右舵机：正角度 = 向左转，所以「向右看」取负
      return clampi_((int)lroundf(_zYaw - r * kK151StepsPerDeg), 0, 1000);
    }
    // 上下舵机：0° = 最低位（平视），正角度 = 抬头；这里 tilt 正 = 低头
    const float pitch = clampf_(PULSE_K151_PITCH_REST - r, PULSE_K151_PITCH_MIN, PULSE_K151_PITCH_MAX);
    return clampi_((int)lroundf(_zPitch + pitch * kK151StepsPerDeg), 0, 1000);
  }
  // SCS0009：0–1023 对应约 300°，512 为中位（这里把 90° 当作中位）
  const float deg = (axis ? PULSE_TILT_CENTER : PULSE_PAN_CENTER) + r;
  return clampi_((int)lroundf(512.f + (deg - 90.f) * 1023.f / 300.f), 0, 1023);
}

void HeadServo::writePwm(int axis, float rel) {
  const bool inv = axis ? _invTilt : _invPan;
  const float deg = clampf_((axis ? PULSE_TILT_CENTER : PULSE_PAN_CENTER) + (inv ? -rel : rel), 0, 180);
  const float us = PULSE_PWM_MIN_US + (PULSE_PWM_MAX_US - PULSE_PWM_MIN_US) * deg / 180.f;
  const uint32_t duty = (uint32_t)(us * (float)(1 << kLedcBits) / kPeriodUs);
#if PULSE_LEDC_V3
  ledcWrite(axis ? _pinY : _pinX, duty);
#else
  ledcWrite(kLedcChan[axis], duty);
#endif
}

// 检测两个舵机：读位置（= 有没有应答）；fixMode 时顺便检查是不是被别的固件留在了「电机模式」
// （角度限制 = 0/0 时舵机只会转圈、不会停在指定位置），是的话写回 0–1000 切回位置模式（只改内存，不写 EEPROM）
void HeadServo::checkServos(bool fixMode) {
  const uint8_t ids[2] = {PULSE_SCS_PAN_ID, PULSE_SCS_TILT_ID};
  for (int a = 0; a < 2; a++) {
    int pos = -1;
    bool ok = false;
    for (int k = 0; k < 3 && !ok; k++) ok = scsReadPos(ids[a], pos);
    _ping[a] = ok ? 1 : 0;
    _rawPos[a] = ok ? pos : -1;
    if (!ok || !fixMode) continue;
    uint8_t lim[4];
    if (scsRead(ids[a], kRegMinAngle, 4, lim)) {
      const int mn = (lim[0] << 8) | lim[1], mx = (lim[2] << 8) | lim[3];
      if (mn == 0 && mx == 0) {
        const uint8_t v[4] = {0, 0, (uint8_t)(1000 >> 8), (uint8_t)(1000 & 0xFF)};
        scsWrite(ids[a], kRegMinAngle, v, 4);
        uint8_t confirmed[4];
        if (!scsRead(ids[a], kRegMinAngle, 4, confirmed) ||
            memcmp(v, confirmed, sizeof(v)) != 0) {
          _ping[a] = 0;
          continue;
        }
        _modeFixed = true;
      }
    } else {
      _ping[a] = 0;
    }
  }
}

// ---------------- 校准（官方机身 / SCS 舵机） ----------------
bool HeadServo::calibrateStart() {
  if (!serialBus() || !_alive) return false;
  for (int i = 0; i < 300 && _initPending; i++) delay(10);  // 等开机初始化做完
  if (!ready() || _ping[0] != 1 || _ping[1] != 1) return false;
  _pausedAck = false;
  _paused = true;
  for (int i = 0; i < 100 && _alive && !_pausedAck; ++i) delay(5);
  if (!_alive || !_pausedAck) { _paused = false; return false; }
  setTorque(false);
  return true;
}

bool HeadServo::calibrateCapture(int& yaw, int& pitch) {
  if (!_paused) return false;
  int a = -1, b = -1;
  bool good = scsReadPos(PULSE_SCS_PAN_ID, a) && scsReadPos(PULSE_SCS_TILT_ID, b);
  if (good && (a > 1000 || b > 1000)) good = false;
  if (good) {
    _zYaw = yaw = a;
    _zPitch = pitch = b;
  }
  resume();
  return good;
}

void HeadServo::calibrateCancel() {
  if (_paused) resume();
}

void HeadServo::resume() {
  if (!_alive || _initPending || !_pausedAck) { _paused = false; return; }
  checkServos(true);
  if (_ping[0] != 1 || _ping[1] != 1) {
    setTorque(false);
    _run = false;
    _paused = false;
    Serial.println("[servo] calibration resume failed; motion disabled");
    return;
  }
  setTorque(true);
  _cPan = _cTilt = 0;
  _sentPan = _sentTilt = 999;
  _slowMs = 600;
  sendPose(0, 0);
  _holdUntil = millis() + 650;
  _paused = false;
  _pausedAck = false;
}

// ---------------- Feetech SCS 协议：FF FF ID LEN INSTR PARAM... CHECKSUM ----------------
void HeadServo::scsPacket(uint8_t id, uint8_t instr, uint8_t addr, const uint8_t* data, uint8_t n) {
  uint8_t pkt[24];
  if (n > 16) n = 16;
  const uint8_t len = n + 3;  // INSTR + ADDR + DATA + CHECKSUM
  pkt[0] = 0xFF;
  pkt[1] = 0xFF;
  pkt[2] = id;
  pkt[3] = len;
  pkt[4] = instr;
  pkt[5] = addr;
  uint8_t sum = id + len + instr + addr;
  for (uint8_t i = 0; i < n; i++) {
    pkt[6 + i] = data[i];
    sum += data[i];
  }
  pkt[6 + n] = (uint8_t)~sum;
  Serial2.write(pkt, 7 + n);
}

void HeadServo::setTorque(bool on) {
  const uint8_t v = on ? 1 : 0;
  scsPacket(kBroadcast, kWrite, kRegTorque, &v, 1);
  Serial2.flush();
  delay(3);
}

// 写单个舵机（会回一个状态包，等一下再丢掉，免得和下一条撞车）
void HeadServo::scsWrite(uint8_t id, uint8_t addr, const uint8_t* data, uint8_t n) {
  while (Serial2.available()) Serial2.read();
  scsPacket(id, kWrite, addr, data, n);
  Serial2.flush();
  delay(4);
  while (Serial2.available()) Serial2.read();
}

// 一条「同步写」同时发两个舵机的目标位置（广播，舵机不回应答）
void HeadServo::scsSyncPos(int panRaw, int tiltRaw, uint16_t ms) {
  const uint8_t ids[2] = {PULSE_SCS_PAN_ID, PULSE_SCS_TILT_ID};
  const int pos[2] = {panRaw, tiltRaw};
  uint8_t pkt[7 + 2 * 7 + 1];
  int n = 0;
  pkt[n++] = 0xFF;
  pkt[n++] = 0xFF;
  pkt[n++] = kBroadcast;
  pkt[n++] = (6 + 1) * 2 + 4;  // LEN
  pkt[n++] = kSyncWrite;
  pkt[n++] = kRegGoal;
  pkt[n++] = 6;                // 每个舵机 6 字节：位置、时间、速度
  for (int i = 0; i < 2; i++) {
    pkt[n++] = ids[i];
    pkt[n++] = (uint8_t)(pos[i] >> 8);
    pkt[n++] = (uint8_t)(pos[i] & 0xFF);
    pkt[n++] = (uint8_t)(ms >> 8);
    pkt[n++] = (uint8_t)(ms & 0xFF);
    pkt[n++] = 0;
    pkt[n++] = 0;
  }
  uint8_t sum = 0;
  for (int i = 2; i < n; i++) sum += pkt[i];
  pkt[n++] = (uint8_t)~sum;
  Serial2.write(pkt, n);
}

// 读寄存器：应答 FF FF ID LEN ERR DATA... CHK（LEN = n + 2；如果线路有回显，会先收到自己发的那条，跳过）
bool HeadServo::scsRead(uint8_t id, uint8_t addr, uint8_t n, uint8_t* out) {
  if (n > 8) return false;
  while (Serial2.available()) Serial2.read();
  const uint8_t req[8] = {0xFF, 0xFF, id, 4, kRead, addr, n, (uint8_t)~(uint8_t)(id + 4 + kRead + addr + n)};
  Serial2.write(req, sizeof(req));
  Serial2.flush();
  uint8_t buf[16];
  const int total = 6 + n;  // FF FF ID LEN ERR DATA×n CHK
  int k = 0;
  const uint32_t t0 = millis();
  while (millis() - t0 < 30) {
    if (!Serial2.available()) { delayMicroseconds(50); continue; }
    const uint8_t b = (uint8_t)Serial2.read();
    if (k < 2 && b != 0xFF) { k = 0; continue; }
    if (k == 2 && b == 0xFF) continue;  // 多余的 0xFF 前导
    buf[k++] = b;
    if (k == 4 && buf[3] != n + 2) {  // 长度不对：可能是回显的读指令，跳过它剩下的字节
      k = 0;
      continue;
    }
    if (k == total) {
      if (total == (int)sizeof(req) && !memcmp(buf, req, sizeof(req))) { k = 0; continue; }  // 回显
      uint8_t sum = 0;
      for (int i = 2; i < total - 1; i++) sum += buf[i];
      sum = (uint8_t)~sum;
      if (buf[2] == id && buf[4] == 0 && sum == buf[total - 1]) {
        for (int i = 0; i < n; i++) out[i] = buf[5 + i];
        return true;
      }
      k = 0;
    }
  }
  return false;
}

bool HeadServo::scsReadPos(uint8_t id, int& out) {
  uint8_t d[2];
  if (!scsRead(id, kRegPos, 2, d)) return false;
  const int v = (d[0] << 8) | d[1];
  if (v > 1023) return false;
  out = v;
  return true;
}
