#include "sfx_mixer.h"
#include "sfx.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

int main() {
  static_assert(sfx::C_COUNT==38,"Director clip whitelist must match all 37 compiled clips");
  assert(sfx::detail::ordinaryPostAllowed(true,false,false)); // Original voice-off life mode.
  assert(!sfx::detail::ordinaryPostAllowed(true,false,true)); // Reserved queued/playing cue.
  assert(!sfx::detail::ordinaryPostAllowed(true,true,true));
  assert(!sfx::detail::ordinaryPostAllowed(true,true,false)); // Reserved flag ends before drain/settle.
  assert(!sfx::detail::ordinaryPostAllowed(false,false,false));
  assert(sfx::detail::ordinaryPostAllowed(true,false,false)); // Restore life only after lease release.
  assert(!sfx::detail::stopAllowed(false,true)); // Ordinary face-presence wake/phase cleanup.
  assert(sfx::detail::stopAllowed(false,false));
  assert(sfx::detail::stopAllowed(true,true)); // Explicit stop/new TTS/volume-off cancellation.
  assert(sfx::detail::stopAllowed(true,false));
  int16_t block[960];
  {
    sfx::Mixer expected,actual;
    expected.playClip(sfx::C_TRACK_LALALA,.3f,1.f,true);
    actual.playClip(sfx::C_TRACK_LALALA,.3f,1.f,true);
    int16_t reference[960];
    // Apply the exact production admission policy before an ordinary cut or
    // ambient wake-stop. Neither may change the real cue PCM being rendered.
    for(unsigned i=0;i<4;++i) {
      if(sfx::detail::ordinaryPostAllowed(true,true,true))actual.playClip(sfx::C_HOME_POP,.6f,1.f,true);
      if(sfx::detail::stopAllowed(false,true))actual.stopAll();
      expected.render(reference,960);actual.render(block,960);
      assert(!memcmp(reference,block,sizeof(block))&&actual.busy());
    }
    // A real stop retains its force-cancellation policy and bounded fade.
    assert(sfx::detail::stopAllowed(true,true));actual.stopAll();
    for(unsigned i=0;i<4&&actual.busy();++i)actual.render(block,960);
    assert(!actual.busy());
    // Ordinary sound is admitted again only after lease/drain suspension ends.
    assert(sfx::detail::ordinaryPostAllowed(true,false,false));
    actual.playClip(sfx::C_HOME_POP,.3f,1.f,true);assert(actual.busy());
  }
  for(int clip=1;clip<sfx::C_COUNT;++clip) {
    sfx::Mixer mixer;mixer.playClip(clip,.6f,1.f,true);
    assert(mixer.busy());
    unsigned blocks=0;
    const unsigned limit=(sfx::kClips[clip].samples*2+959)/960+4;
    while(mixer.busy()&&blocks<limit){mixer.render(block,960);++blocks;}
    assert(!mixer.busy()&&blocks<=limit);
    mixer.playClip(clip,.3f,1.f,true);mixer.render(block,960);
    mixer.stopAll();unsigned fadeBlocks=0;
    while(mixer.busy()&&fadeBlocks<4){mixer.render(block,960);++fadeBlocks;}
    assert(!mixer.busy());
  }
  puts("cue_mixer: production admission keeps cue PCM identical under ordinary posts/ambient stops, forced stop cancels, post admission restores after drain; all 37 real bank clips finish within sample duration and cancellation fades drain boundedly");
}
