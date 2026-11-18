#pragma once
// 脉冲 Pulse · 头部舵机驱动（PWM 舵机 / Feetech SCS0009 串口舵机 / M5Stack 官方 StackChan 机身）
#include <Arduino.h>

enum ServoType : uint8_t { SERVO_OFF = 0, SERVO_PWM = 1, SERVO_SCS = 2, SERVO_K151 = 3 };

class HeadServo {
 public:
  // pinX / pinY：PWM 时分别是左右、上下舵机信号脚；串口舵机时 pinX = RX，pinY = TX
  void begin(uint8_t type, int pinX, int pinY, bool invPan, bool invTilt);
  void end();
  // 目标姿态：相对正前方的角度（度）。pan 正 = 向右看，tilt 正 = 低头、负 = 抬头
  // （动作的幅度由 motion.cpp 按机身类型限制；这里只做最后的安全限位）
  void setTarget(float pan, float tilt) { _tPan = pan; _tTilt = tilt; }
  void setTrackingLimits(bool on) { _trackingLimits = on; }
  bool active() const { return _type != SERVO_OFF && _alive; }
  uint8_t type() const { return _type; }
  bool ready() const { return _alive && !_initPending; }
  // 官方机身：两个舵机的零位原始值（左右 = 正前方，上下 = 最低位 / 平视）
  void setZero(int yaw, int pitch) { _zYaw = yaw; _zPitch = pitch; }
  // 校准零位：start 松开扭矩（可以用手摆头）→ capture 读当前位置当零位；cancel 放弃
  bool calibrateStart();
  bool calibrateCapture(int& yaw, int& pitch);
  void calibrateCancel();
  // 诊断（串口舵机）：-1 = 还没检测，0 = 没有应答，1 = 正常
  int8_t ping(int axis) const { return _ping[axis & 1]; }
  int rawPos(int axis) const { return _rawPos[axis & 1]; }
  bool modeFixed() const { return _modeFixed; }   // 开机时发现舵机在「电机模式」，已经切回位置模式
  void requestCheck() { _checkReq = true; }       // 让舵机任务重新检测一次（结果约 0.1 秒后可读）

 private:
  static void taskFn(void* arg);
  void loopTask();
  bool serialBus() const { return _type == SERVO_SCS || _type == SERVO_K151; }
  void sendPose(float pan, float tilt);
  int rawFor(int axis, float rel) const;
  void writePwm(int axis, float rel);
  void resume();
  void setTorque(bool on);
  void checkServos(bool fixMode);
  void scsPacket(uint8_t id, uint8_t instr, uint8_t addr, const uint8_t* data, uint8_t n);
  void scsSyncPos(int panRaw, int tiltRaw, uint16_t ms);
  bool scsRead(uint8_t id, uint8_t addr, uint8_t n, uint8_t* out);
  bool scsReadPos(uint8_t id, int& out);
  void scsWrite(uint8_t id, uint8_t addr, const uint8_t* data, uint8_t n);

  volatile float _tPan = 0, _tTilt = 0;
  float _cPan = 0, _cTilt = 0, _sentPan = 999, _sentTilt = 999;
  uint8_t _type = SERVO_OFF;
  int _pinX = -1, _pinY = -1;
  bool _invPan = false, _invTilt = false;
  int _zYaw = 460, _zPitch = 620;
  uint16_t _slowMs = 0;              // 下一次发送用的移动时间（0 = 正常跟随）
  volatile uint32_t _holdUntil = 0;  // 这之前舵机任务不发新位置
  volatile bool _initPending = false;
  volatile bool _paused = false;
  volatile bool _pausedAck = false;
  volatile bool _run = false;
  volatile bool _alive = false;
  volatile int8_t _ping[2] = {-1, -1};
  volatile int _rawPos[2] = {-1, -1};
  volatile bool _checkReq = false;
  volatile bool _trackingLimits = false;
  bool _modeFixed = false;
};
