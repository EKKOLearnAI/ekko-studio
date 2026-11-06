#pragma once
// 电脑上跑 brain.cpp 仿真用的最小 Arduino 替身（只给 tests/test_brain_life.cpp 用）
#include <math.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

uint32_t millis();
uint32_t micros();
long random(long howbig);
long random(long howsmall, long howbig);

struct HostSerial {
  int printf(const char* fmt, ...) __attribute__((format(printf, 2, 3)));
  size_t println(const char* s = "");
  size_t print(const char* s);
};
extern HostSerial Serial;
