// 2.8 陪伴版：屏幕小图案的形状（爱心 ? ! Z 音符 星星 + 水滴 饭碗 月亮 铃铛 对勾 小红花 小人）
// 和 pulse_engine.cpp 一样生成 32×32 抗锯齿遮罩，检查每个图案的面积、边界、对称性，并输出一张 fx_shapes.pgm 方便人眼检查
#include "fx_shapes.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

using namespace pulse;

static const int M = 32;
static const float PAD = 1.3f;  // 和 pulse_engine.cpp 的 FX_PAD 一样
static unsigned char mask[FX_KINDS][M][M];

int main() {
  static const char* const names[FX_KINDS] = {"heart", "question", "exclaim", "z", "note", "spark", "drop",
                                              "bowl", "moon", "bell", "check", "flower", "person"};
  for (int k = 0; k < FX_KINDS; k++) {
    long sum = 0;
    for (int y = 0; y < M; y++)
      for (int x = 0; x < M; x++) {
        int n = 0;
        for (int sy = 0; sy < 4; sy++)
          for (int sx = 0; sx < 4; sx++) {
            const float u = ((x + (sx + .5f) * .25f) / M * 2.f - 1.f) * PAD, v = ((y + (sy + .5f) * .25f) / M * 2.f - 1.f) * PAD;
            n += fxshape::inside(k, u, v) ? 1 : 0;
          }
        mask[k][y][x] = (unsigned char)(n * 255 / 16);
        sum += mask[k][y][x];
      }
    const float cover = sum / (255.f * M * M);
    // 边上两圈留给光晕：不能有图案
    int edge = 0;
    for (int i = 0; i < M; i++)
      for (int j = 0; j < 2; j++)
        edge += mask[k][i][j] + mask[k][i][M - 1 - j] + mask[k][j][i] + mask[k][M - 1 - j][i];
    // 左右对称程度
    long diff = 0;
    for (int y = 0; y < M; y++)
      for (int x = 0; x < M; x++) diff += mask[k][y][x] > mask[k][y][M - 1 - x] ? mask[k][y][x] - mask[k][y][M - 1 - x] : mask[k][y][M - 1 - x] - mask[k][y][x];
    const float asym = sum ? (float)diff / sum : 0.f;
    printf("  %-8s cover %.2f  asym %.2f  edge %d\n", names[k], cover, asym, edge);
    assert(cover > .06f && cover < .55f);
    assert(edge == 0);
    if (k == FX_HEART || k == FX_EXCLAIM || k == FX_SPARK || k == FX_BOWL || k == FX_BELL || k == FX_FLOWER || k == FX_PERSON)
      assert(asym < .05f);
  }
  // 拼成一张 13 × 1 的图（每个放大 4 倍）
  const int S = 4, W = FX_KINDS * (M + 2) * S, H = (M + 2) * S;
  FILE* f = fopen("fx_shapes.pgm", "wb");
  if (f) {
    fprintf(f, "P5 %d %d 255\n", W, H);
    for (int y = 0; y < H; y++)
      for (int x = 0; x < W; x++) {
        const int k = x / ((M + 2) * S), lx = (x % ((M + 2) * S)) / S - 1, ly = y / S - 1;
        const unsigned char c = (lx >= 0 && lx < M && ly >= 0 && ly < M) ? mask[k][ly][lx] : 40;
        fputc(c, f);
      }
    fclose(f);
  }
  printf("test_fx_shapes: all passed\n");
  return 0;
}
