#include "conversation.h"
#include "motion.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

namespace {
unsigned acquired=0, audioAcquired=0, visualRequests=0, actionRequests=0, actionReleases=0, released=0;
int physicalEmotion=14;
bool allowAudio=true,allowVisual=true;
conversation::Hooks hooks{
  [](){++acquired;return allowVisual;},
  [](bool stop){++released;physicalEmotion=stop?41:2;},
  [](uint8_t state,bool){++visualRequests;physicalEmotion=state;},
  [](uint8_t,float){++actionRequests;},[](){++actionReleases;},[](){}
};
void reset() {
  hooks.acquireAudio=[](){++audioAcquired;return allowAudio;};
  conversation::begin(hooks,100);
  acquired=audioAcquired=visualRequests=actionRequests=actionReleases=released=0;
  physicalEmotion=14;allowAudio=allowVisual=true;
}
conversation::Command cueCommand(const char* id="clip") {
  conversation::Command c;c.commandId=id;c.turnId="audio-only";c.generation=1;
  c.expiresAtMs=9000;c.durationMs=8000;c.soundClip=1;c.soundTiming=conversation::SoundTiming::WhenQuiet;
  return c;
}
void checkUntouched(int state=14) {
  assert(acquired==0&&physicalEmotion==state&&visualRequests==0&&actionRequests==0&&actionReleases==0&&released==0);
}
void startAudio() {
  assert(conversation::startTurn("audio-only",1,100,false,true));
  checkUntouched();assert(audioAcquired==1&&conversation::active());
  assert(conversation::phase()==conversation::Phase::Idle&&conversation::visibleEmotionId()==-1);
}
}
int main() {
  reset();startAudio();
  auto command=cueCommand();conversation::Ack ack;
  assert(conversation::apply(command,ack,100));checkUntouched();
  assert(conversation::setPhase(conversation::Phase::Thinking,"metadata only",150));checkUntouched();
  // The original owner is allowed to keep living/animating; conversation must
  // not claim to know its new face or restore a stale captured presentation.
  physicalEmotion=19;conversation::update(200);checkUntouched(19);
  assert(conversation::visibleEmotionId()==-1);
  conversation::SoundCue cue;assert(conversation::takeSoundCue(cue,300,false,true));
  conversation::soundCueFinished(cue.token,500,true);
  assert(!conversation::active()&&conversation::visibleEmotionId()==-1);checkUntouched(19);
  assert(conversation::apply(command,ack,600)&&ack.status==conversation::AckStatus::Duplicate);
  command.commandId="closed-late";
  assert(!conversation::apply(command,ack,600)&&ack.status==conversation::AckStatus::NoTurn);

  reset();startAudio();command=cueCommand();assert(conversation::apply(command,ack,100));
  conversation::update(8100);assert(!conversation::active());checkUntouched();
  assert(!strcmp(conversation::expressionCues().sound_state,"expired"));
  reset();startAudio();conversation::update(30100);assert(!conversation::active());checkUntouched();

  reset();allowAudio=false;
  assert(!conversation::startTurn("audio-only",1,100,false,true));checkUntouched();
  reset();hooks.acquireAudio=nullptr;conversation::begin(hooks,100);
  assert(!conversation::startTurn("audio-only",1,100,false,true));checkUntouched();

  reset();startAudio();command=cueCommand();assert(conversation::apply(command,ack,100));
  auto visual=cueCommand("visual");visual.soundClip=0;visual.emotionId="21";
  allowVisual=false;assert(!conversation::apply(visual,ack,200)&&ack.status==conversation::AckStatus::Busy);
  assert(conversation::expressionCues().sound_pending&&physicalEmotion==14&&visualRequests==0);
  allowVisual=true;assert(conversation::apply(visual,ack,250));
  assert(acquired==2&&physicalEmotion==21&&visualRequests==1&&!conversation::expressionCues().sound_pending);

  reset();startAudio();command=cueCommand();assert(conversation::apply(command,ack,100));
  assert(conversation::takeSoundCue(cue,300,false,true));
  assert(conversation::startTurn("normal",2,400));
  assert(physicalEmotion==35&&acquired==1&&conversation::generation()==2);
  assert(!conversation::takeSoundCue(cue,450,false,true));
  assert(!conversation::apply(command,ack,450)&&ack.status==conversation::AckStatus::Stale);

  reset();startAudio();conversation::cancel(200);
  assert(!conversation::active()&&physicalEmotion==41&&released==1&&actionReleases==1);
  reset();assert(conversation::startTurn("normal",1,100));
  assert(acquired==1&&audioAcquired==0&&physicalEmotion==35&&visualRequests==1);
  puts("audio_only_turn: idle acquisition/finish/expiry preserve living presentation, truthful unknown getter, promotion/boot guard/stop/generation and ordinary turn compatibility passed");
}
