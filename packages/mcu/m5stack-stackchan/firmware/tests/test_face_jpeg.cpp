#include "face_camera.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <vector>

using namespace facecam;

static void closeTo(float a, float b) { assert(fabsf(a - b) < .001f); }
static unsigned pixel(const uint8_t* image, size_t x, size_t y) {
  const size_t at = (y * kJpegSampleSide + x) * 2;
  return ((unsigned)image[at] << 8) | image[at + 1];
}

static unsigned nativeChannel(unsigned p, unsigned c) {
  return c == 0 ? p >> 11 : (c == 1 ? (p >> 5) & 63 : p & 31);
}
static unsigned expandChannel(unsigned value, unsigned c) {
  return c == 1 ? (value << 2) | (value >> 4) : (value << 3) | (value >> 2);
}
static double sourceChannel(const uint8_t* source, int width, int x, int y, unsigned c) {
  const size_t at = ((size_t)y * width + x) * 2;
  const unsigned packed = ((unsigned)source[at] << 8) | source[at + 1];
  return expandChannel(nativeChannel(packed, c), c);
}
static unsigned idealPixel(const uint8_t* source, int width, int height,
                           const sampling::SquareCrop& roi, size_t x, size_t y,
                           double* idealChannels) {
  // Independent floating reference: exact double coordinates, expanded RGB8
  // bilinear interpolation, nearest RGB8, then the original RGB565 quantizer.
  const double scale = (double)roi.side / 112.;
  const double sx = fmax(0., fmin((double)roi.left + (x + .5) * scale - .5, width - 1.));
  const double sy = fmax(0., fmin((double)roi.top + (y + .5) * scale - .5, height - 1.));
  const int x0 = (int)floor(sx), y0 = (int)floor(sy);
  const int x1 = x0 + 1 < width ? x0 + 1 : x0, y1 = y0 + 1 < height ? y0 + 1 : y0;
  const double fx = sx - x0, fy = sy - y0;
  unsigned codes[3];
  for (unsigned c = 0; c < 3; ++c) {
    const double upper = sourceChannel(source, width, x0, y0, c) * (1. - fx) +
                         sourceChannel(source, width, x1, y0, c) * fx;
    const double lower = sourceChannel(source, width, x0, y1, c) * (1. - fx) +
                         sourceChannel(source, width, x1, y1, c) * fx;
    idealChannels[c] = upper * (1. - fy) + lower * fy;
    const unsigned channel = (unsigned)floor(idealChannels[c] + .5);
    codes[c] = (channel * (c == 1 ? 63 : 31) + 127) / 255;
  }
  return (codes[0] << 11) | (codes[1] << 5) | codes[2];
}

static void testRandomFixedPointAgainstIdeal() {
  uint32_t seed = 0x93247a5u;
  auto next = [&]() -> uint32_t { seed = seed * 1664525u + 1013904223u; return seed; };
  unsigned maximumCodeError[3] = {};
  double maximumRgbError[3] = {};
  const unsigned solid[] = {0, 0xffff, 0xf800, 0x07e0, 0x001f};
  for (unsigned trial = 0; trial < 100; ++trial) {
    int width = 32 + (int)(next() % 4065), height = 32 + (int)(next() % 481);
    if (trial & 1) { const int swap = width; width = height; height = swap; }
    if (trial == 0) width = height = 1;
    if (trial == 1) width = height = 2;
    if (trial == 2) width = height = 112;
    if (trial == 3) { width = 4096; height = 32; }
    if (trial == 4) { width = 32; height = 4096; }
    if (trial == 5) width = height = 4096;
    const size_t bytes = (size_t)width * height * 2;
    // Independent guards, distinct allocations and a complete source snapshot
    // catch both border writes and accidental in-place resampling.
    std::vector<uint8_t> source(bytes + 72, 0xa5);
    uint8_t* raster = source.data() + 32;
    for (size_t at = 0; at < bytes; at += 2) {
      const unsigned packed = trial < 5 ? solid[trial] : (next() >> 16);
      raster[at] = (uint8_t)(packed >> 8); raster[at + 1] = (uint8_t)packed;
    }
    const std::vector<uint8_t> original = source;
    std::vector<uint8_t> output(kJpegScratchBytes + 64, 0xd3);
    float mappedGuard[12]; for (float& value : mappedGuard) value = -1234.f;
    facetrack::BBox box(0, 0, (float)width, (float)height, .95f);
    if (trial > 2) {
      const int limit = width < height ? width : height;
      const float w = 8.25f + next() % (limit - 8), h = 8.25f + next() % (limit - 8);
      const float maxX = width - w, maxY = height - h;
      const float left = trial % 4 == 0 ? 0.f : (trial % 4 == 1 ? maxX :
          .25f * (next() % ((unsigned)(maxX * 4) + 1)));
      const float top = trial % 4 == 2 ? 0.f : (trial % 4 == 3 ? maxY :
          .25f * (next() % ((unsigned)(maxY * 4) + 1)));
      box = facetrack::BBox(left, top, left + w, top + h, .95f);
    }
    const float w = box.x2 - box.x1, h = box.y2 - box.y1;
    float landmarks[] = {box.x1 + .28f*w, box.y1 + .28f*h,
                         box.x1 + .32f*w, box.y1 + .75f*h,
                         box.x1 + .50f*w, box.y1 + .50f*h,
                         box.x1 + .72f*w, box.y1 + .28f*h,
                         box.x1 + .68f*w, box.y1 + .75f*h};
    if (width == 1 && height == 1) memset(landmarks, 0, sizeof(landmarks));
    sampling::SquareCrop roi;
    assert(sampling::squareCrop(width, height, box, roi));
    assert(sampling::cropRgb112(raster, bytes, width, height, box, landmarks, 10,
                               output.data() + 32, kJpegScratchBytes, mappedGuard + 1, 10));
    assert(!memcmp(source.data(), original.data(), source.size()));
    for (size_t i = 0; i < 32; ++i) {
      assert(output[i] == 0xd3 && output[32 + kJpegScratchBytes + i] == 0xd3);
    }
    assert(mappedGuard[0] == -1234.f && mappedGuard[11] == -1234.f);
    for (size_t y = 0; y < 112; ++y) for (size_t x = 0; x < 112; ++x) {
      double ideal[3];
      const unsigned reference = idealPixel(raster, width, height, roi, x, y, ideal);
      const unsigned fixed = pixel(output.data() + 32, x, y);
      for (unsigned c = 0; c < 3; ++c) {
        const unsigned actual = nativeChannel(fixed, c), expected = nativeChannel(reference, c);
        const unsigned delta = actual > expected ? actual - expected : expected - actual;
        if (delta > maximumCodeError[c]) maximumCodeError[c] = delta;
        const double rgbError = fabs(expandChannel(actual, c) - ideal[c]);
        if (rgbError > maximumRgbError[c]) maximumRgbError[c] = rgbError;
        assert(delta <= 1); // At most one native 5/6-bit quantization code.
        assert(rgbError <= (c == 1 ? 5. : 9.)); // Largest bit-expanded code step.
      }
    }
  }
  printf("face_jpeg: 100 seeded color/stride/border cases, max native-code error=%u/%u/%u, "
         "max RGB8 error=%.3f/%.3f/%.3f\n", maximumCodeError[0], maximumCodeError[1], maximumCodeError[2],
         maximumRgbError[0], maximumRgbError[1], maximumRgbError[2]);
}

int main() {
  assert(status().jpeg_crop_ms == 0 && status().jpeg_encode_ms == 0);
  FaceSample sample;
  assert(!sample.jpeg && !sample.pixel_bytes && !sample.pixels);
  for (float p : sample.landmarks) assert(p == 0);
  assert(requestSample(sample, 0) == SampleState::Unavailable && !sample.jpeg);
  assert(requestSample(sample, 0, true) == SampleState::Unavailable && sample.jpeg);

  sampling::SquareCrop roi;
  const facetrack::BBox tall(80, 40, 180, 160, .95f);
  assert(sampling::squareCrop(320, 240, tall, roi));
  closeTo(roi.side, 138); closeTo(roi.left, 61); closeTo(roi.top, 31);
  assert(sampling::squareCrop(320, 240, facetrack::BBox(2, 2, 102, 122, 1), roi));
  closeTo(roi.left, 0); closeTo(roi.top, 0); closeTo(roi.side, 138);
  assert(sampling::squareCrop(320, 240, facetrack::BBox(218, 118, 318, 238, 1), roi));
  closeTo(roi.left, 182); closeTo(roi.top, 102);
  assert(!sampling::squareCrop(320, 240, facetrack::BBox(10, 5, 300, 235, 1), roi));
  assert(!sampling::squareCrop(320, 240, facetrack::BBox(-1, 5, 50, 55, 1), roi));
  assert(!sampling::squareCrop(320, 240, facetrack::BBox(NAN, 5, 50, 55, 1), roi));
  assert(!sampling::squareCrop(0, 240, tall, roi));
  assert(!sampling::squareCrop(320, 240, facetrack::BBox(0, 0, 1.e-30f, 1.e-30f, 1), roi));
  for (int y = 0; y < 190; y += 19) for (int x = 0; x < 270; x += 27) {
    const facetrack::BBox box((float)x, (float)y, (float)x + 45, (float)y + 47, 1);
    assert(sampling::squareCrop(320, 240, box, roi));
    assert(roi.left >= 0 && roi.top >= 0 && roi.left + roi.side <= 320.001f &&
           roi.top + roi.side <= 240.001f);
    assert(roi.left <= box.x1 && roi.top <= box.y1 &&
           roi.left + roi.side >= box.x2 && roi.top + roi.side >= box.y2);
  }

  // Source borders and padding are guarded. No photos, camera or encoder fake.
  const uint8_t quad[] = {0xf8, 0x00, 0x07, 0xe0, 0x00, 0x1f, 0xff, 0xff};
  const float tinyPoints[] = {.25f, .25f, .4f, 1.5f, 1, 1, 1.5f, .25f, 1.5f, 1.5f};
  std::vector<uint8_t> guarded(kJpegScratchBytes + 2, 0xa5);
  uint8_t* image = guarded.data() + 1;
  float mappedGuard[12];
  for (float& p : mappedGuard) p = -1000;
  float* mapped = mappedGuard + 1;
  assert(sampling::cropRgb112(quad, sizeof(quad), 2, 2, facetrack::BBox(0, 0, 2, 2, 1),
      tinyPoints, 10, image, kJpegScratchBytes, mapped, 10));
  assert(guarded.front() == 0xa5 && guarded.back() == 0xa5);
  assert(mappedGuard[0] == -1000 && mappedGuard[11] == -1000);
  assert(pixel(image, 0, 0) == 0xf800 && pixel(image, 111, 0) == 0x07e0);
  assert(pixel(image, 0, 111) == 0x001f && pixel(image, 111, 111) == 0xffff);
  // 55,55 blends all four neighbours rather than picking the red one.
  assert(pixel(image, 55, 55) == 0x83ef);

  std::vector<uint8_t> source(320 * 240 * 2 + 2, 0xa5);
  for (int y = 0; y < 240; ++y) for (int x = 0; x < 320; ++x) {
    const unsigned p = ((x % 32) << 11) | ((y % 64) << 5) | ((x + y) % 32);
    source[1 + (y * 320 + x) * 2] = (uint8_t)(p >> 8);
    source[2 + (y * 320 + x) * 2] = (uint8_t)p;
  }
  const float legacy[] = {104, 78, 110, 136, 130, 106, 156, 78, 150, 136};
  assert(sampling::cropRgb112(source.data() + 1, 320 * 240 * 2, 320, 240, tall,
      legacy, 10, image, kJpegScratchBytes, mapped, 10));
  assert(sampling::squareCrop(320, 240, tall, roi));
  const size_t order[] = {0, 6, 4, 2, 8};
  for (size_t p = 0; p < 5; ++p) {
    closeTo((mapped[p * 2] + .5f) * roi.side / 112 + roi.left - .5f, legacy[order[p]]);
    closeTo((mapped[p * 2 + 1] + .5f) * roi.side / 112 + roi.top - .5f, legacy[order[p] + 1]);
    assert(mapped[p * 2] >= 0 && mapped[p * 2] < 112);
    assert(mapped[p * 2 + 1] >= 0 && mapped[p * 2 + 1] < 112);
  }
  // Both axes use exactly the same scale, including near-border translation.
  closeTo((mapped[2] - mapped[0]) / (legacy[6] - legacy[0]),
          (mapped[9] - mapped[1]) / (legacy[9] - legacy[1]));
  assert(source.front() == 0xa5 && source.back() == 0xa5);
  assert(guarded.front() == 0xa5 && guarded.back() == 0xa5);
  assert(!sampling::cropRgb112(source.data() + 1, 320 * 240 * 2 - 1, 320, 240, tall,
      legacy, 10, image, kJpegScratchBytes, mapped, 10));
  assert(!sampling::cropRgb112(source.data() + 1, 320 * 240 * 2, 320, 240, tall,
      legacy, 10, image, kJpegScratchBytes - 1, mapped, 10));
  assert(!sampling::cropRgb112(source.data() + 1, 320 * 240 * 2, 320, 240, tall,
      legacy, 9, image, kJpegScratchBytes, mapped, 10));
  assert(!sampling::cropRgb112(source.data() + 1, 320 * 240 * 2, 320, 240, tall,
      legacy, 10, image, kJpegScratchBytes, mapped, 9));
  float invalid[10]; memcpy(invalid, legacy, sizeof(invalid)); invalid[3] = NAN;
  assert(!sampling::cropRgb112(source.data() + 1, 320 * 240 * 2, 320, 240, tall,
      invalid, 10, image, kJpegScratchBytes, mapped, 10));
  invalid[3] = 1000;
  assert(!sampling::cropRgb112(source.data() + 1, 320 * 240 * 2, 320, 240, tall,
      invalid, 10, image, kJpegScratchBytes, mapped, 10));

  // The same scene at 1:1 size proves stride, byte order and no implicit flip.
  std::vector<uint8_t> exact(112 * 112 * 2);
  for (size_t p = 0; p < exact.size(); ++p) exact[p] = (uint8_t)(p * 13 + p / 224);
  const float exactPoints[] = {20, 20, 20, 90, 56, 56, 90, 20, 90, 90};
  assert(sampling::cropRgb112(exact.data(), exact.size(), 112, 112,
      facetrack::BBox(0, 0, 112, 112, 1), exactPoints, 10, image,
      kJpegScratchBytes, mapped, 10));
  assert(!memcmp(exact.data(), image, exact.size()));

  // The bounded callback must latch errors: the encoder ignores short writes.
  uint8_t sinkGuard[10]; memset(sinkGuard, 0xa5, sizeof(sinkGuard));
  sampling::JpegSink sink; sink.pixels = sinkGuard + 1; sink.capacity = 8;
  const uint8_t jpeg[] = {0xff, 0xd8, 1, 2, 3, 4, 0xff, 0xd9};
  assert(sampling::appendJpeg(&sink, 0, jpeg, 3) == 3);
  assert(sampling::appendJpeg(&sink, 3, jpeg + 3, 5) == 5);
  assert(sampling::appendJpeg(&sink, 8, nullptr, 0) == 0 && !sink.failed);
  assert(sink.used == 8 && !memcmp(sink.pixels, jpeg, 8));
  assert(sampling::validJpeg(sink.pixels, sink.used));
  assert(sampling::appendJpeg(&sink, 8, jpeg, 1) == 0 && sink.failed && sink.used == 8);
  assert(sampling::appendJpeg(&sink, 8, nullptr, 0) == 0 && sink.failed);
  assert(sinkGuard[0] == 0xa5 && sinkGuard[9] == 0xa5);
  sink.failed = false; sink.used = 0;
  assert(sampling::appendJpeg(&sink, 1, jpeg, 1) == 0 && sink.failed);
  sink.failed = false;
  assert(sampling::appendJpeg(&sink, 0, nullptr, 1) == 0 && sink.failed);
  sink.failed = false; sink.capacity = kSampleBytes + 1;
  assert(sampling::appendJpeg(&sink, 0, jpeg, 1) == 0 && sink.failed);
  assert(sampling::appendJpeg(nullptr, 0, jpeg, 1) == 0);
  assert(!sampling::validJpeg(jpeg, 3));
  assert(!sampling::validJpeg(nullptr, 8));
  testRandomFixedPointAgainstIdeal();
  puts("face_jpeg: square ROI, equal-axis scale, bilinear BE RGB565, 5-point order, stride/guards, bounded callback passed");
}
