#include "face_camera.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

using namespace facecam;

int main() {
  using sampling::FrameAdmission;
  assert(sampling::kMaximumBacklogDiscards == 2);
  assert(sampling::frameAdmission(100, 200, false, 150, 0) == FrameAdmission::Use);
  assert(sampling::frameAdmission(100, 200, true, 150, 0) == FrameAdmission::Discard);
  assert(sampling::frameAdmission(100, 200, true, 150, 1) == FrameAdmission::Limit);
  assert(sampling::frameAdmission(150, 200, true, 150, 0) == FrameAdmission::Use); // Same-ms fresh exposure.
  assert(sampling::frameAdmission(151, 200, true, 150, 1) == FrameAdmission::Use); // One bounded retry.
  assert(sampling::frameAdmission(151, 200, true, 150, 2) == FrameAdmission::Limit);
  assert(sampling::frameAdmission(0, 450, false, 0, 0) == FrameAdmission::Use);
  assert(sampling::frameAdmission(0, 451, false, 0, 0) == FrameAdmission::Discard);
  assert(sampling::frameAdmission(0, 451, false, 0, 1) == FrameAdmission::Limit);
  assert(sampling::frameAdmission(201, 200, false, 0, 0) == FrameAdmission::InvalidTimestamp);
  const uint32_t beforeWrap = UINT32_MAX - 100;
  assert(sampling::frameAdmission(beforeWrap, 349, false, 0, 0) == FrameAdmission::Use);
  assert(sampling::frameAdmission(beforeWrap, 350, false, 0, 0) == FrameAdmission::Discard);
  assert(sampling::frameAdmission(beforeWrap, 10, true, 0, 0) == FrameAdmission::Discard);
  assert(sampling::frameAdmission(1, 10, true, beforeWrap, 1) == FrameAdmission::Use);
  assert(sampling::frameAdmission(10, beforeWrap, false, 0, 0) == FrameAdmission::InvalidTimestamp);
  assert(sampling::frameAdmission(0, 0x80000000u, false, 0, 0) == FrameAdmission::InvalidTimestamp);

  assert(!sampling::expiryReason(450, 0, 0, true));
  assert(!strcmp(sampling::expiryReason(451, 0, 0, true), "stale"));
  assert(!sampling::expiryReason(1200, 0, 0, false));
  assert(!strcmp(sampling::expiryReason(1201, 0, 0, false), "timeout"));
  const uint32_t wrapped = UINT32_MAX - 100;
  assert(!sampling::expiryReason(349, wrapped, wrapped, true));
  assert(!strcmp(sampling::expiryReason(350, wrapped, wrapped, true), "stale"));

  // POST requests a future frame; a retained lock must not be rejected because
  // the preceding main-loop observation is already old. No old frame may pass
  // the separate publication/consumption guard after admission succeeds.
  Detection previous;
  previous.width = 320; previous.height = 240; previous.count = 1;
  previous.sequence = 43; previous.captured_ms = 100;
  previous.boxes[0] = facetrack::BBox(80, 40, 180, 160, .95f);
  facetrack::Snapshot locked;
  locked.locked = locked.tracking = true; locked.lock_id = 7; locked.lost_ms = 500;
  locked.target = previous.boxes[0];
  assert(!strcmp(sampling::frameRejection(locked, previous, 600), "stale"));
  assert(!sampling::requestAdmissionReason(true, locked, previous, 600));
  locked.tracking = false;
  assert(!sampling::requestAdmissionReason(true, locked, previous, 600));
  assert(!strcmp(sampling::frameRejection(locked, previous, 600), "target_lost"));
  assert(!strcmp(sampling::requestAdmissionReason(false, locked, previous, 600), "disabled"));
  locked.ambiguous = true;
  assert(!strcmp(sampling::requestAdmissionReason(true, locked, previous, 600), "ambiguous"));
  locked.ambiguous = false; locked.locked = false;
  assert(!strcmp(sampling::requestAdmissionReason(true, locked, previous, 600), "unlocked"));
  locked.locked = true; locked.lock_id = 0;
  assert(!strcmp(sampling::requestAdmissionReason(true, locked, previous, 600), "unlocked"));
  locked.lock_id = 7; locked.tracking = true; locked.lost_ms = 50;
  Detection next = previous; next.sequence = 44; next.captured_ms = 600;
  assert(!sampling::frameRejection(locked, next, 650));
  assert(sampling::exactTargetIndex(next, locked) == 0);
  assert(!strcmp(sampling::expiryReason(650, previous.captured_ms, 600, true), "stale"));
  previous.count = 0; locked.tracking = false;
  assert(!sampling::requestAdmissionReason(true, locked, previous, 650));
  assert(!strcmp(sampling::frameRejection(locked, previous, 650), "no_face"));
  locked.locked = false;
  assert(!strcmp(sampling::requestAdmissionReason(true, locked, previous, 650), "no_face"));

  const facetrack::BBox good(16, 16, 112, 128, .95f);
  // Arduino 2.0.17 CameraWebServer/app_httpd.cpp:242 documents MNP01 order:
  // left eye, mouth left, nose, right eye, mouth right (interleaved x/y).
  // Keep this fixture in SDK order; a conventional eye/eye/nose/mouth/mouth
  // fixture can hide a production index error while synthetic tests pass.
  int landmarks[] = {40, 50, 44, 98, 64, 75, 88, 50, 84, 98};
  assert(!sampling::qualityReason(good, 128, 144, landmarks, 10));
  assert(!strcmp(sampling::qualityReason(facetrack::BBox(16, 16, 112, 128, .79f),
                                        128, 144, landmarks, 10), "low_confidence"));
  assert(!strcmp(sampling::qualityReason(facetrack::BBox(0, 16, 96, 128, .95f),
                                        128, 144, landmarks, 10), "clipped"));
  assert(!strcmp(sampling::qualityReason(facetrack::BBox(16, 16, 40, 40, .95f),
                                        128, 144, landmarks, 10), "face_too_small"));
  assert(!strcmp(sampling::qualityReason(good, 128, 144, nullptr, 0), "occlusion_suspected"));
  int upsideDown[] = {40, 94, 44, 46, 64, 69, 88, 94, 84, 46};
  assert(!strcmp(sampling::qualityReason(good, 128, 144, upsideDown, 10), "occlusion_suspected"));
  int sideFace[] = {40, 50, 44, 98, 64, 75, 48, 50, 84, 98};
  assert(!strcmp(sampling::qualityReason(good, 128, 144, sideFace, 10), "occlusion_suspected"));
  int blockedMouth[] = {40, 50, 44, 50, 64, 75, 88, 50, 84, 50};
  assert(!strcmp(sampling::qualityReason(good, 128, 144, blockedMouth, 10), "occlusion_suspected"));
  landmarks[5] = 40;
  assert(!strcmp(sampling::qualityReason(good, 128, 144, landmarks, 10), "occlusion_suspected"));
  assert(sampling::qualityReason(facetrack::BBox(NAN, 0, 90, 90, 1), 128, 144, landmarks, 10));

  Detection d;
  d.width = 320; d.height = 240; d.count = 2;
  d.boxes[0] = facetrack::BBox(4, 4, 180, 200, .99f);  // Larger neighbour.
  d.boxes[1] = facetrack::BBox(200, 40, 260, 120, .90f);
  facetrack::Snapshot target;
  target.locked = target.tracking = true; target.lock_id = 8;
  target.target = d.boxes[1];
  assert(sampling::exactTargetIndex(d, target) == 1);
  target.target.x1 += .0001f;
  assert(sampling::exactTargetIndex(d, target) == 1);
  target.ambiguous = true; assert(sampling::exactTargetIndex(d, target) == -1);
  target.ambiguous = false; target.tracking = false;
  assert(sampling::exactTargetIndex(d, target) == -1);
  target.tracking = true; d.boxes[0] = d.boxes[1];
  assert(sampling::exactTargetIndex(d, target) == -1);
  d.count = 9; assert(sampling::exactTargetIndex(d, target) == -1);

  // Synthetic colors only: no camera/real face, network, or image files.
  const uint8_t rgb[] = {0xf8, 0x00, 0x07, 0xe0, 0x00, 0x1f, 0xff, 0xff};
  uint8_t guarded[kSampleBytes + 2]; memset(guarded, 0xa5, sizeof(guarded));
  assert(sampling::cropGray64(rgb, sizeof(rgb), 2, 2, facetrack::BBox(0, 0, 2, 2, 1),
                              guarded + 1, kSampleBytes));
  assert(guarded[0] == 0xa5 && guarded[kSampleBytes + 1] == 0xa5);
  assert(guarded[1] == 77 && guarded[1 + 63] == 149);
  assert(guarded[1 + 63 * 64] == 29 && guarded[kSampleBytes] == 255);
  assert(!sampling::cropGray64(rgb, sizeof(rgb) - 1, 2, 2, facetrack::BBox(0, 0, 2, 2, 1),
                               guarded + 1, kSampleBytes));
  assert(!sampling::cropGray64(rgb, sizeof(rgb), 2, 2, facetrack::BBox(-1, 0, 2, 2, 1),
                               guarded + 1, kSampleBytes));
  assert(!sampling::cropGray64(rgb, sizeof(rgb), 2, 2, facetrack::BBox(0, 0, 3, 2, 1),
                               guarded + 1, kSampleBytes));
  assert(!sampling::cropGray64(rgb, sizeof(rgb), 2, 2, facetrack::BBox(0, 0, 2, 2, 1),
                               guarded + 1, kSampleBytes - 1));
  puts("face_sample: bounded backlog admission/2-discard limit, strict exposure expiry/wraparound, "
       "target correspondence, ambiguity, quality, RGB565BE/gray layout, bounds passed");
}
