#pragma once
// 脉冲 Pulse · 屏幕上飘出来的小图案的形状（原创代码，纯数学，主机可测：tests/test_fx_shapes.cpp 会把它们画成图片检查）
// (u, v) ∈ [-1, 1]，v 向下为正。返回这个点在不在图案里面。
#include <math.h>
#include "pulse_events.h"

namespace pulse {
namespace fxshape {

constexpr float kPi = 3.14159265359f;

inline float segDist(float px, float py, float ax, float ay, float bx, float by) {
  const float dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  float t = L2 > 1e-9f ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0.f;
  t = t < 0.f ? 0.f : (t > 1.f ? 1.f : t);
  const float ex = px - ax - t * dx, ey = py - ay - t * dy;
  return sqrtf(ex * ex + ey * ey);
}
inline bool inCircle(float u, float v, float cx, float cy, float r) {
  return (u - cx) * (u - cx) + (v - cy) * (v - cy) <= r * r;
}

inline bool inside(int kind, float u, float v) {
  switch (kind) {
    case FX_HEART: {
      const float X = 1.25f * u, Y = -1.25f * v + .1f, a = X * X + Y * Y - 1.f;
      return a * a * a - X * X * Y * Y * Y <= 0.f;
    }
    case FX_QUESTION: {
      const float cy = -.38f, r = .42f, hw = .13f;
      const float dx = u, dy = v - cy, ang = atan2f(dy, dx) * (180.f / kPi);
      float d;
      if (!(ang > 90.f && ang < 160.f)) d = fabsf(sqrtf(dx * dx + dy * dy) - r);
      else {
        const float ax = r * cosf(160.f * kPi / 180.f), ay = cy + r * sinf(160.f * kPi / 180.f);
        d = fminf(sqrtf((u - ax) * (u - ax) + (v - ay) * (v - ay)), sqrtf(u * u + (v - cy - r) * (v - cy - r)));
      }
      if (d <= hw) return true;
      if (segDist(u, v, 0.f, cy + r, 0.f, .3f) <= hw) return true;
      return u * u + (v - .7f) * (v - .7f) <= .14f * .14f;
    }
    case FX_EXCLAIM: {
      if (v >= -.85f && v <= .3f) {
        const float t = (v + .85f) / 1.15f, hw = .17f - .07f * t;
        if (fabsf(u) <= hw) return true;
      }
      if (u * u + (v + .85f) * (v + .85f) <= .17f * .17f) return true;
      return u * u + (v - .72f) * (v - .72f) <= .17f * .17f;
    }
    case FX_Z: {
      const float hw = .13f;
      return segDist(u, v, -.55f, -.62f, .55f, -.62f) <= hw || segDist(u, v, .55f, -.62f, -.55f, .62f) <= hw ||
             segDist(u, v, -.55f, .62f, .55f, .62f) <= hw;
    }
    case FX_NOTE: {
      const float hx = u + .2f, hy = v - .52f, ca = cosf(-.44f), sa = sinf(-.44f);
      const float ex = (hx * ca + hy * sa) / .34f, ey = (-hx * sa + hy * ca) / .24f;
      if (ex * ex + ey * ey <= 1.f) return true;
      if (segDist(u, v, .1f, .47f, .1f, -.82f) <= .075f) return true;
      return segDist(u, v, .1f, -.82f, .5f, -.5f) <= .09f || segDist(u, v, .5f, -.5f, .44f, -.16f) <= .07f;
    }
    case FX_SPARK:  // 四角星
      return sqrtf(fabsf(u)) + sqrtf(fabsf(v)) <= .95f;
    // ---------------- 2.8 陪伴版 ----------------
    case FX_DROP: {  // 水滴：下面圆、上面尖，左上角留一道高光
      const float cy = .3f, r = .6f, tip = -.95f;
      bool in = inCircle(u, v, 0.f, cy, r);
      if (!in && v >= tip && v <= cy) {
        const float t = (v - tip) / (cy - tip);
        in = fabsf(u) <= r * powf(t, .75f);
      }
      if (!in) return false;
      return segDist(u, v, -.3f, .08f, -.33f, .38f) > .075f;  // 高光（镂空）
    }
    case FX_BOWL: {  // 一碗饭：上面一团米饭，碗口一条缝，下面碗身和碗脚
      if (v < -.02f) return (u * u) / (.66f * .66f) + ((v + .02f) * (v + .02f)) / (.42f * .42f) <= 1.f;  // 米饭
      if (v < .08f) return false;                                                                     // 碗口的缝
      if (v <= .1f + .56f) {
        const float t = (v - .08f) / .58f;
        return fabsf(u) <= .92f * sqrtf(fmaxf(0.f, 1.f - t * t));
      }
      return fabsf(u) <= .3f && v <= .84f;  // 碗脚
    }
    case FX_MOON:  // 弯弯的月亮
      return inCircle(u, v, 0.f, 0.f, .8f) && !inCircle(u, v, .4f, -.24f, .66f);
    case FX_BELL: {  // 铃铛：顶上小环 + 钟身 + 底边 + 铃舌
      if (inCircle(u, v, 0.f, -.86f, .13f)) return true;
      if (inCircle(u, v, 0.f, -.42f, .4f) && v <= -.42f) return true;
      if (v >= -.42f && v <= .42f) {
        const float t = (v + .42f) / .84f;
        if (fabsf(u) <= .4f + .38f * t * t) return true;
      }
      if (v >= .4f && v <= .56f && fabsf(u) <= .9f) return true;
      return inCircle(u, v, 0.f, .74f, .17f);
    }
    case FX_CHECK:  // 对勾 ✓
      return segDist(u, v, -.62f, .02f, -.16f, .5f) <= .17f || segDist(u, v, -.16f, .5f, .72f, -.56f) <= .17f;
    case FX_FLOWER: {  // 小红花：五片圆圆的花瓣，中间留个花心
      const float r = sqrtf(u * u + v * v);
      if (r <= .15f) return true;   // 花心
      if (r <= .27f) return false;  // 花心和花瓣之间的一圈缝
      for (int i = 0; i < 5; i++) {
        const float a = -kPi / 2.f + i * (2.f * kPi / 5.f);
        if (inCircle(u, v, .5f * cosf(a), .5f * sinf(a), .36f)) return true;
      }
      return false;
    }
    case FX_PERSON:  // 举起双手伸懒腰的小人
      return inCircle(u, v, 0.f, -.56f, .24f) || segDist(u, v, 0.f, -.26f, 0.f, .28f) <= .14f ||
             segDist(u, v, 0.f, -.2f, -.6f, -.84f) <= .1f || segDist(u, v, 0.f, -.2f, .6f, -.84f) <= .1f ||
             segDist(u, v, 0.f, .26f, -.4f, .88f) <= .115f || segDist(u, v, 0.f, .26f, .4f, .88f) <= .115f;
    default:
      return false;
  }
}

}  // namespace fxshape
}  // namespace pulse
