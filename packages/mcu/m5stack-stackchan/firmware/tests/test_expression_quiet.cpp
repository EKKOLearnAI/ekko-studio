#include "expression_audio.h"
#include "voice_audio.h"
#include <assert.h>
#include <stdio.h>

int main() {
  using namespace expression_audio;
  QuietContext c;
  assert(quietMode(c)==QuietMode::Unarmed);
  c.armed=true;c.listening=true;c.phase=conversation::Phase::Listening;c.generation=7;
  assert(quietMode(c)==QuietMode::ListeningGap);
  // A cooperative pause temporarily makes listening false; the main loop must
  // keep polling rather than revoke the worker's still-pending handshake.
  c.listening=false;assert(quietMode(c)==QuietMode::ListeningGap);
  assert(!mayResumeListening(c,7,false));
  assert(!mayResumeListening(c,6,true));
  assert(mayResumeListening(c,7,true));
  const conversation::Phase blocked[]={conversation::Phase::Idle,conversation::Phase::Recognizing,
    conversation::Phase::Thinking,conversation::Phase::Working,conversation::Phase::Speaking,
    conversation::Phase::Done,conversation::Phase::Error,conversation::Phase::Rejected,conversation::Phase::Stopped};
  for(auto phase:blocked){c.phase=phase;assert(quietMode(c)==QuietMode::Unavailable);assert(!mayResumeListening(c,7,true));}
  c.phase=conversation::Phase::Listening;
  bool* guards[]={&c.turn_pending,&c.recording,&c.tts_busy,&c.speaker_busy,&c.diagnostic,&c.maintenance};
  for(bool* guard:guards){*guard=true;assert(quietMode(c)==QuietMode::Unavailable);assert(!mayResumeListening(c,7,true));*guard=false;}
  c.armed=false;c.listening=true;assert(quietMode(c)==QuietMode::Unavailable);
  assert(!mayResumeListening(c,7,true));
  c.listening=false;assert(quietMode(c)==QuietMode::Unarmed);
  // Real arbitration remains queued throughout recording and the cooperative
  // DMA drain. Admission alone never claims a cue before TX ownership exists.
  conversation::Hooks hooks{[](){return true;}};
  conversation::begin(hooks,100);assert(conversation::startTurn("listening",7,100));
  conversation::Command command;command.commandId="quiet-cue";command.turnId="listening";
  command.generation=7;command.expiresAtMs=9000;command.durationMs=8000;
  command.soundClip=1;command.soundTiming=conversation::SoundTiming::WhenQuiet;
  conversation::Ack ack;assert(conversation::apply(command,ack,100));
  c.armed=true;c.phase=conversation::Phase::Listening;c.generation=7;c.recording=true;
  conversation::SoundCue cue;voice_audio::detail::OutputLease lease;
  assert(!lease.tryBeginCue(false,true));
  assert(!conversation::takeSoundCue(cue,200,false,
      quietMode(c)==QuietMode::ListeningGap&&lease.cueActive()));
  assert(conversation::expressionCues().sound_pending);
  c.recording=false;assert(quietMode(c)==QuietMode::ListeningGap);
  assert(!conversation::takeSoundCue(cue,300,false,lease.cueActive()));
  assert(lease.tryBeginCue(true,true)); // Capture worker has now approved quiet and fully drained.
  assert(conversation::takeSoundCue(cue,800,false,
      quietMode(c)==QuietMode::ListeningGap&&lease.cueActive()));
  assert(!mayResumeListening(c,7,!lease.cueActive()));
  conversation::soundCueFinished(cue.token,1000,true);
  assert(!mayResumeListening(c,7,!lease.cueActive())); // SFX completion alone is not TX drain.
  lease.endCue();assert(mayResumeListening(c,7,!lease.cueActive()));
  assert(!conversation::takeSoundCue(cue,1100,false,true));
  puts("expression_quiet: armed Listening admission, recording/TTS/turn/phase guards, pending drain polling, same-generation post-drain resume passed");
}
