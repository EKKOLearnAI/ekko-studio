#include "../PulseStackChan/voice_audio.h"
#include "../PulseStackChan/voice_codec.h"

#include <assert.h>
#include <atomic>
#include <future>
#include <mutex>
#include <limits>
#include <stdio.h>
#include <thread>

using voice_audio::detail::OutputLease;
using voice_audio::detail::QuietCuePause;

static void observedQuiet(QuietCuePause& pause, unsigned blocks = 25) {
  for (unsigned i = 0; i < blocks; ++i) pause.observeEnergy(40.f, 100.f, false, 320);
}

static void testCueRequiresIdleHardware() {
  OutputLease lease;
  assert(!lease.blocksCapture());
  assert(!lease.tryBeginCue(false, true));
  assert(!lease.tryBeginCue(true, false));
  assert(!lease.tryBeginCue(false, false));
  assert(!lease.cueActive());
  assert(lease.tryBeginCue(true, true));
  assert(lease.cueActive() && lease.blocksCapture());
  assert(!lease.tryBeginCue(true, true));
  assert(!lease.tryBeginPlayback(true));
  lease.endCue();
  lease.endCue();  // Idempotent cleanup by the same app owner.
  assert(!lease.blocksCapture());
  assert(lease.tryBeginCue(true, true));
  lease.endCue();
}

static void testPlaybackOwnsItsDrain() {
  OutputLease lease;
  assert(lease.tryBeginPlayback(true));
  assert(lease.playbackActive() && lease.blocksCapture());
  assert(!lease.tryBeginCue(true, true));
  assert(!lease.tryBeginPlayback(true));
  lease.endCue();  // Cue cleanup cannot revoke playback ownership.
  assert(lease.playbackActive() && lease.blocksCapture());
  // The request may have been cancelled and the speaker slot released, but
  // playback retains ownership until its actual DMA tail has drained.
  assert(!lease.tryBeginPlayback(false));
  assert(!lease.tryBeginCue(true, true));
  lease.endPlayback();
  assert(!lease.blocksCapture());
  assert(lease.tryBeginCue(true, true));
  lease.endCue();
}

static void testCancelledDownloadNeverPublishesAfterCue() {
  OutputLease lease;
  assert(lease.tryBeginCue(true, true));
  assert(!lease.tryBeginPlayback(true));  // Downloaded TTS waits for the cue.
  assert(!lease.tryBeginPlayback(false)); // Cancellation changes no cue state.
  lease.endPlayback();                   // No playback reservation to release.
  assert(lease.cueActive() && lease.blocksCapture());
  lease.endCue();
  assert(!lease.tryBeginPlayback(false)); // Still stale after the cue drains.
  assert(!lease.blocksCapture());
  assert(lease.tryBeginPlayback(true));   // A later current generation may play.
  lease.endPlayback();
}

static void testSequentialHandoffs() {
  OutputLease lease;
  for (unsigned i = 0; i < 1000; ++i) {
    assert(lease.tryBeginCue(true, true));
    assert(!lease.tryBeginPlayback(true));
    lease.endCue();
    assert(lease.tryBeginPlayback(true));
    assert(!lease.tryBeginCue(true, true));
    lease.endPlayback();
    assert(!lease.blocksCapture());
  }
}

static void testConcurrentPublicationHasOneOwner() {
  // This is the production contract: the same mutex surrounds reservation,
  // clock routing and hardware publication, not just the ownership check.
  for (unsigned i = 0; i < 200; ++i) {
    OutputLease lease;
    std::mutex publication;
    std::atomic<unsigned> ready{0};
    std::atomic<bool> go{false};
    bool cueWon = false, playbackWon = false;
    std::thread cue([&]() {
      ready.fetch_add(1);
      while (!go.load()) std::this_thread::yield();
      std::lock_guard<std::mutex> guard(publication);
      cueWon = lease.tryBeginCue(true, true);
    });
    std::thread playback([&]() {
      ready.fetch_add(1);
      while (!go.load()) std::this_thread::yield();
      std::lock_guard<std::mutex> guard(publication);
      playbackWon = lease.tryBeginPlayback(true);
    });
    while (ready.load() != 2) std::this_thread::yield();
    go.store(true);
    cue.join();
    playback.join();
    assert(cueWon != playbackWon);
    assert(lease.cueActive() == cueWon);
    assert(lease.playbackActive() == playbackWon);
    assert(lease.blocksCapture());
    if (cueWon) lease.endCue();
    else lease.endPlayback();
  }
}

static void testReservationAndHardwarePublicationShareMutex() {
  OutputLease lease;
  std::mutex publication;
  std::promise<void> reserved, allowPublish;
  std::future<void> reservedFuture = reserved.get_future();
  std::future<void> publishFuture = allowPublish.get_future();
  bool published = false;
  std::thread playback([&]() {
    std::lock_guard<std::mutex> guard(publication);
    assert(lease.tryBeginPlayback(true));
    reserved.set_value();
    publishFuture.wait();
    // Represents routeClock + playRaw under the same mutex as reservation.
    assert(!lease.cueActive());
    published = true;
  });
  reservedFuture.wait();
  assert(!publication.try_lock()); // Nonblocking cue API cannot enter this gap.
  assert(lease.blocksCapture());  // Atomic capture reader sees the reservation.
  allowPublish.set_value();
  playback.join();
  assert(published);
  {
    std::lock_guard<std::mutex> guard(publication);
    assert(!lease.tryBeginCue(true, true));
    lease.endPlayback();
    assert(lease.tryBeginCue(true, true));
    lease.endCue();
  }
}

static void testMicPublicationMustDrainBeforeCue() {
  OutputLease lease;
  std::mutex publication;
  std::promise<void> recording, releasePublication;
  std::future<void> recordingFuture = recording.get_future();
  std::future<void> releaseFuture = releasePublication.get_future();
  bool micBusy = false;
  std::thread capture([&]() {
    std::lock_guard<std::mutex> guard(publication);
    assert(!lease.blocksCapture());
    micBusy = true;  // Mic.record is accepted while publication lock is held.
    recording.set_value();
    releaseFuture.wait();
  });
  recordingFuture.wait();
  assert(!publication.try_lock());
  releasePublication.set_value();
  capture.join();
  {
    std::lock_guard<std::mutex> guard(publication);
    assert(!lease.tryBeginCue(!micBusy, true));
    micBusy = false; // Actual asynchronous microphone requests have drained.
    assert(lease.tryBeginCue(!micBusy, true));
    assert(lease.blocksCapture());
    lease.endCue();
  }
}

static void testDefaultStatusKeepsWorkAndCueSeparate() {
  voice_audio::Status status;
  assert(!status.playback_busy && !status.external_cue_active);
  status.external_cue_active = true;
  assert(!status.playback_busy); // The cue owner must distinguish new TTS work.
}

static void testQuietPauseRequiresObservedTimeAndDrain() {
  QuietCuePause pause;
  OutputLease output;
  pause.request(7, 8, 9);
  for (unsigned i = 0; i < 100; ++i) pause.request(7, 8, 9); // Polling is not audio evidence.
  assert(pause.quietSamples() == 0 && !pause.draining());
  observedQuiet(pause, 24);
  assert(pause.quietSamples() == 7680 && !pause.draining());
  assert(!pause.grant(output, true, true));
  observedQuiet(pause, 1);
  assert(pause.draining() && pause.quietSamples() == 8000);
  assert(!pause.grant(output, false, true)); // Accepted blocks/callbacks still pending.
  assert(!pause.grant(output, true, false)); // Another output is still audible.
  assert(!output.blocksCapture());          // Draining keeps RX available.
  assert(pause.grant(output, true, true));
  assert(output.cueActive() && output.blocksCapture());
  assert(!pause.grant(output, true, true));
  pause.routedSession(10);                  // TX routing invalidates the capture session.
  assert(!pause.claim(7, 8, 9));
  assert(pause.claim(7, 8, 10));
  assert(!pause.claim(7, 8, 10));            // Exactly one app owner.
  assert(!pause.cancel(output));
  assert(output.cueActive());              // Cancel wait cannot revoke the claimed lease.
  output.endCue();
}

static voice_audio::detail::GateResult energyBlock(voice_audio::detail::EnergyGate& gate,
                                                  QuietCuePause& pause, int16_t amplitude) {
  int16_t samples[320];
  // 低频方波（每 32 采样一个周期）：和真人浊音一样低过零率，才会被门限当成说话
  for (unsigned i = 0; i < 320; ++i) samples[i] = (i / 16) & 1 ? amplitude : -amplitude;
  const auto result = gate.consume(samples, 320);
  pause.observeEnergy(result.rms, result.noise_rms, result.recording, 320);
  return result;
}

static void testQueuedOnsetAbandonsDrainWithoutResettingVad() {
  QuietCuePause pause;
  OutputLease output;
  voice_audio::detail::EnergyGate gate;
  pause.request(1, 1, 1);
  for (unsigned i = 0; i < 25; ++i) energyBlock(gate, pause, 40);
  assert(pause.draining());
  assert(!pause.grant(output, false, true)); // The final accepted requests must be consumed.
  auto onset = energyBlock(gate, pause, 2000);
  assert(!onset.started && !onset.recording); // One block is only an onset candidate.
  assert(!pause.draining() && pause.quietSamples() == 0);
  assert(!pause.grant(output, true, true));
  for (unsigned i = 0; i < 3; ++i) onset = energyBlock(gate, pause, 2000);
  assert(onset.started && onset.recording); // Original four-block onset was retained.
  assert(!pause.active() && !output.blocksCapture());
  // 4 onset + 11 = 15 blocks = 300ms voiced, the minimum the gate now uploads.
  for (unsigned i = 0; i < 11; ++i) energyBlock(gate, pause, 2000);
  voice_audio::detail::GateResult end;
  for (unsigned i = 0; i < 40; ++i) end = energyBlock(gate, pause, 0);
  assert(end.finished && !end.too_short); // The complete utterance survives the aborted pause.
}

static void testWeakOnsetAlsoRestartsQuietEvidence() {
  QuietCuePause pause;
  pause.request(1, 2, 3);
  observedQuiet(pause);
  assert(pause.draining());
  // Below VAD's onset threshold (350), above its remain threshold (230).
  pause.observeEnergy(250.f, 100.f, false, 320);
  assert(pause.state() == QuietCuePause::State::Waiting && pause.quietSamples() == 0);
  observedQuiet(pause, 24);
  assert(!pause.draining());
  observedQuiet(pause, 1);
  assert(pause.draining());
}

static void testUnclaimedCancellationAndClaimedOwnership() {
  QuietCuePause pause;
  OutputLease output;
  pause.request(4, 5, 6);
  observedQuiet(pause);
  assert(pause.grant(output, true, true));
  pause.routedSession(7);
  pause.requestCancellation();
  assert(!pause.claim(4, 5, 7)); // Atomic cancellation wins before app handoff.
  assert(pause.takeCancellation());
  assert(pause.cancel(output)); // Caller restores its previous listening intent.
  assert(!output.blocksCapture() && !pause.active());
  pause.request(4, 5, 8);
  observedQuiet(pause);
  assert(pause.grant(output, true, true));
  assert(pause.claim(4, 5, 8));
  pause.requestCancellation();
  assert(pause.takeCancellation());
  assert(!pause.cancel(output));
  assert(output.cueActive()); // Only the app's drain path may release it now.
  output.endCue();
}

static void testQuietEpochFencesAndExplicitCloseClearCancellation() {
  QuietCuePause pause;
  OutputLease output;
  pause.request(7, 8, 9);
  observedQuiet(pause);
  assert(pause.grant(output, true, true));
  assert(!pause.claim(8, 8, 9));
  assert(!pause.claim(7, 9, 9));
  assert(!pause.claim(7, 8, 10));
  pause.requestCancellation();
  assert(pause.cancel(output)); // Explicit close discards restoration, clears old atomic cancel.
  assert(!pause.takeCancellation() && !pause.active());
  assert(!output.blocksCapture());
  pause.request(8, 9, 10);
  assert(pause.matches(8, 9, 10) && !pause.matches(7, 8, 9));
  assert(pause.quietSamples() == 0 && !pause.draining());
}

static void testTtsCannotBeStolenByQuietGrant() {
  QuietCuePause pause;
  OutputLease output;
  pause.request(1, 1, 1);
  observedQuiet(pause);
  assert(output.tryBeginPlayback(true));
  assert(!pause.grant(output, true, true));
  assert(!pause.cancel(output)); // TTS arrival abandons pause, not the TTS owner.
  assert(output.playbackActive());
  output.endPlayback();
  pause.request(1, 1, 1);
  observedQuiet(pause);
  assert(pause.grant(output, true, true));
  assert(pause.cancel(output)); // TTS arrival before claim reclaims the never-played cue.
  assert(output.tryBeginPlayback(true));
  output.endPlayback();
}

static void testQuietCancellationDoesNotWaitForPublicationMutex() {
  QuietCuePause pause;
  OutputLease output;
  std::mutex publication;
  std::promise<void> workerLocked, allowWorker;
  auto locked = workerLocked.get_future();
  auto allowed = allowWorker.get_future();
  pause.request(1, 2, 3);
  observedQuiet(pause);
  std::thread capture([&]() {
    std::lock_guard<std::mutex> guard(publication);
    workerLocked.set_value();
    allowed.wait();
    assert(!pause.grant(output, true, true)); // Cancel is visible even before servicing it.
    assert(pause.takeCancellation());
    assert(!pause.cancel(output));
  });
  locked.wait();
  assert(!publication.try_lock());
  pause.requestCancellation(); // Must work while another task holds publication.
  allowWorker.set_value();
  capture.join();
  assert(!pause.active() && !output.blocksCapture());
}

static void testQuietInvalidEnergyAndRecordingNeverAuthorizePause() {
  QuietCuePause pause;
  pause.request(1, 2, 3);
  const float invalid[] = {std::numeric_limits<float>::infinity(),
                           std::numeric_limits<float>::quiet_NaN(), -1.f};
  for (float rms : invalid) {
    observedQuiet(pause, 24);
    pause.observeEnergy(rms, 100.f, false, 320);
    assert(!pause.draining() && pause.quietSamples() == 0);
  }
  for (float noise : {std::numeric_limits<float>::infinity(),
                      std::numeric_limits<float>::quiet_NaN(), -1.f,
                      std::numeric_limits<float>::max()}) {
    observedQuiet(pause, 24);
    pause.observeEnergy(0.f, noise, false, 320);
    assert(!pause.draining() && pause.quietSamples() == 0);
  }
  observedQuiet(pause, 24);
  pause.observeEnergy(0.f, 100.f, false, 0);
  assert(pause.quietSamples() == 7680 && !pause.draining());
  pause.observeEnergy(0.f, 100.f, false, 16001);
  assert(pause.quietSamples() == 0 && !pause.draining());
  observedQuiet(pause);
  pause.observeEnergy(0.f, 100.f, true, 0);
  assert(!pause.active()); // An existing utterance wins even without a new block.
}

int main() {
  testCueRequiresIdleHardware();
  testPlaybackOwnsItsDrain();
  testCancelledDownloadNeverPublishesAfterCue();
  testSequentialHandoffs();
  testConcurrentPublicationHasOneOwner();
  testReservationAndHardwarePublicationShareMutex();
  testMicPublicationMustDrainBeforeCue();
  testDefaultStatusKeepsWorkAndCueSeparate();
  testQuietPauseRequiresObservedTimeAndDrain();
  testQueuedOnsetAbandonsDrainWithoutResettingVad();
  testWeakOnsetAlsoRestartsQuietEvidence();
  testUnclaimedCancellationAndClaimedOwnership();
  testQuietEpochFencesAndExplicitCloseClearCancellation();
  testTtsCannotBeStolenByQuietGrant();
  testQuietCancellationDoesNotWaitForPublicationMutex();
  testQuietInvalidEnergyAndRecordingNeverAuthorizePause();
  puts("PASS 16 voice cue lease cases: 500ms observed quiet, queued onset/VAD retention, "
       "drain and epoch gates, nonblocking cancellation, 1000 handoffs, 200 concurrent races");
}
