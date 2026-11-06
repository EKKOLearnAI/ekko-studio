#include "conversation.h"
#include "motion.h"
#include "sfx_bank.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

using namespace conversation;
namespace {
unsigned actions, states, cueCancels, ambientStops;
uint8_t lastAction, lastState;
Hooks hooks{
  [](){return true;}, [](bool){},
  [](uint8_t state,bool){++states;lastState=state;},
  [](uint8_t action,float){++actions;lastAction=action;}, [](){}, [](){++ambientStops;}
};
void reset(uint32_t now=100) {
  hooks.cancelCue=[](){++cueCancels;};
  begin(hooks,now); assert(startTurn("turn",1,now));
  actions=states=cueCancels=ambientStops=0;lastAction=lastState=0;
}
Command cmd(const char* id,uint32_t now=100) {
  Command c;c.commandId=id;c.turnId="turn";c.generation=generation();
  c.durationMs=15000;c.expiresAtMs=now+20000;return c;
}
void applyOk(const Command& c,uint32_t now=100) {Ack ack;assert(apply(c,ack,now));assert(ack.status==AckStatus::Accepted);}
void invalid(Command c) {Ack ack;assert(!apply(c,ack,100));assert(ack.status==AckStatus::Invalid);}
}
int main() {
  reset();
  auto delayed=cmd("deferred");delayed.emotionId="21";delayed.actionId="nod_slow";
  delayed.actionTiming=ActionTiming::SpeechStart;
  applyOk(delayed);assert(lastState==21&&actions==0&&expressionCues().action_pending);
  setPhase(Phase::Thinking,nullptr,200);setPhase(Phase::Working,nullptr,300);
  assert(actions==0);setPhase(Phase::Speaking,nullptr,400);
  assert(actions==0&&expressionCues().action_pending); // Presentation alone is not a player signal.
  setPlaybackActive(true,400);
  assert(actions==1&&lastAction==motion::A_NOD_SLOW&&!expressionCues().action_pending);
  setPhase(Phase::Speaking,"segment",450);setPhase(Phase::Working,nullptr,500);
  setPhase(Phase::Speaking,nullptr,550);assert(actions==1);
  Ack duplicate;assert(apply(delayed,duplicate,600)&&duplicate.status==AckStatus::Duplicate&&actions==1);

  // The first segment has ended, but its presentation phase can stay Speaking
  // while the next segment is still downloading. That phase is not playback.
  reset();setPlaybackActive(true,120);setPhase(Phase::Speaking,nullptr,120);
  setPlaybackActive(false,150);actions=0;
  delayed=cmd("segment-gap");delayed.emotionId="19";delayed.actionId="nod_slow";
  delayed.soundClip=sfx::C_HOME_POP;
  delayed.actionTiming=ActionTiming::SpeechStart;applyOk(delayed,200);
  assert(actions==0&&expressionCues().action_pending);
  setPhase(Phase::Speaking,"presentation heartbeat",250);
  SoundCue segmentCue;assert(!takeSoundCue(segmentCue,260,true,true));
  update(2500);assert(actions==0&&expressionCues().sound_pending);
  setPlaybackActive(true,3000);setPhase(Phase::Speaking,nullptr,3000);
  assert(actions==1&&lastAction==motion::A_NOD_SLOW&&!expressionCues().action_pending);
  setPlaybackActive(true,3050);assert(actions==1);
  setPlaybackActive(false,3100);
  assert(!takeSoundCue(segmentCue,3200,true,true)); // Per-segment Done is not whole-turn completion.
  update(5000);assert(expressionCues().sound_pending);
  speechEnded(6000);setPhase(Phase::Done,nullptr,6000);
  assert(takeSoundCue(segmentCue,6200,true,false));
  assert(!takeSoundCue(segmentCue,6201,true,false));
  soundCueFinished(segmentCue.token,6300,true);
  assert(!takeSoundCue(segmentCue,6400,true,false));

  reset();delayed=cmd("expires");delayed.actionId="nod";delayed.durationMs=100;
  delayed.actionTiming=ActionTiming::SpeechStart;applyOk(delayed);
  update(200);assert(!expressionCues().action_pending);
  setPhase(Phase::Speaking,nullptr,250);assert(lastAction!=motion::A_NOD);

  reset();delayed=cmd("preserved");delayed.emotionId="19";delayed.actionId="nod_slow";
  delayed.actionTiming=ActionTiming::SpeechStart;applyOk(delayed);
  assert(actions==0&&expressionCues().action_pending);
  setPhase(Phase::Thinking,nullptr,150);setPhase(Phase::Listening,nullptr,160);
  assert(actions==0&&expressionCues().action_pending&&visibleEmotionId()==19);
  const unsigned oldStates=states,oldActions=actions;
  auto audio=cmd("audio-only");audio.soundClip=sfx::C_HOME_POP;audio.soundTiming=SoundTiming::WhenQuiet;
  applyOk(audio,200);assert(states==oldStates&&actions==oldActions&&visibleEmotionId()==19&&expressionCues().action_pending);
  SoundCue cue;assert(!takeSoundCue(cue,200,false,false));
  assert(takeSoundCue(cue,201,false,true)&&cue.clip==sfx::C_HOME_POP);
  assert(!takeSoundCue(cue,202,false,true));
  soundCueFinished(cue.token,300,true);assert(!expressionCues().sound_playing&&cueCancels==0);
  audio.commandId="repeat-new-id";Ack busyAck;
  assert(!apply(audio,busyAck,350)&&busyAck.status==AckStatus::Busy);
  assert(states==oldStates&&actions==oldActions);

  reset();audio=cmd("after-speech");audio.soundClip=sfx::C_HOME_SIGH;applyOk(audio);
  assert(!takeSoundCue(cue,200,true,true));
  setPlaybackActive(true,1000);setPhase(Phase::Speaking,nullptr,1000);assert(!takeSoundCue(cue,1001,true,true));
  speechEnded(1001);assert(!takeSoundCue(cue,1002,true,true)); // A still-playing player cannot end speech.
  setPlaybackActive(false,10000);speechEnded(10000);assert(!takeSoundCue(cue,10010,false,true));
  assert(takeSoundCue(cue,10011,true,false)); // Still valid after eight seconds.
  update(15100);assert(!expressionCues().sound_playing&&cueCancels==1);
  assert(!strcmp(expressionCues().sound_state,"expired"));

  reset();audio=cmd("missed-window");audio.soundClip=sfx::C_HOME_POP;applyOk(audio);
  setPlaybackActive(true,200);setPhase(Phase::Speaking,nullptr,200);
  setPlaybackActive(false,1000);speechEnded(1000);
  assert(!takeSoundCue(cue,2500,true,false));
  assert(!strcmp(expressionCues().sound_state,"speech_window_expired"));

  reset();auto shortMood=cmd("short-mood");shortMood.emotionId="19";shortMood.durationMs=100;
  applyOk(shortMood);audio=cmd("independent-audio");audio.soundClip=1;
  audio.soundTiming=SoundTiming::WhenQuiet;applyOk(audio,150);
  assert(takeSoundCue(cue,160,false,true));
  const unsigned stopsBeforeExpiry=ambientStops;
  update(201);assert(expressionCues().sound_playing&&cueCancels==0&&ambientStops==stopsBeforeExpiry);
  setPhase(Phase::Working,nullptr,220);
  assert(expressionCues().sound_playing&&cueCancels==0&&ambientStops==stopsBeforeExpiry);
  soundCueFinished(cue.token,300,true);

  reset();audio=cmd("no-speech");audio.soundClip=sfx::C_HOME_POP;applyOk(audio);
  setPhase(Phase::Speaking,nullptr,200);speechEnded(300);
  assert(!takeSoundCue(cue,301,true,true)); // Phase alone never authorizes the cue.
  update(15100);assert(!takeSoundCue(cue,15100,true,true));
  assert(!strcmp(expressionCues().sound_state,"expired"));

  reset();audio=cmd("old-pending");audio.soundClip=1;applyOk(audio);
  auto replacement=cmd("new-pending");replacement.soundClip=36;replacement.soundTiming=SoundTiming::WhenQuiet;
  applyOk(replacement);assert(takeSoundCue(cue,200,false,true)&&cue.clip==36);
  auto stopped=cmd("stop-all");stopped.emotionId="41";stopped.soundClip=2;
  applyOk(stopped,300);assert(!active()&&!expressionCues().sound_pending&&!expressionCues().sound_playing&&cueCancels==1);

  reset();audio=cmd("generation");audio.soundClip=1;audio.soundTiming=SoundTiming::WhenQuiet;applyOk(audio);
  assert(takeSoundCue(cue,200,false,true));
  assert(startTurn("next",2,300,true));assert(cueCancels==1&&!expressionCues().sound_playing);
  audio.commandId="cooldown";audio.turnId="next";audio.generation=2;audio.expiresAtMs=10300;
  applyOk(audio,300);assert(!takeSoundCue(cue,4199,false,true));assert(takeSoundCue(cue,4200,false,true));

  reset();audio=cmd("new-touch-catalog-clip");audio.soundClip=sfx::C_TOUCH_DIRTY_HANDS;
  audio.soundTiming=SoundTiming::WhenQuiet;applyOk(audio);
  assert(takeSoundCue(cue,200,false,true)&&cue.clip==sfx::C_TOUCH_DIRTY_HANDS&&!cue.local);
  reset();audio=cmd("invalid");audio.soundClip=sfx::C_COUNT;invalid(audio);
  audio.soundClip=1;audio.soundGain=NAN;invalid(audio);audio.soundGain=INFINITY;invalid(audio);
  audio.soundGain=-.01f;invalid(audio);audio.soundGain=.61f;invalid(audio);
  audio.soundGain=.3f;audio.sound=true;invalid(audio);audio.sound=false;
  audio.emotionId="39";invalid(audio);audio.emotionId=nullptr;
  audio.actionTiming=(ActionTiming)2;invalid(audio);audio.actionTiming=ActionTiming::Now;
  audio.soundTiming=(SoundTiming)2;invalid(audio);
  audio.soundTiming=SoundTiming::AfterSpeech;audio.soundClip=0;audio.sound=true;invalid(audio);

  reset();audio=cmd("quiet-hard-cap");audio.soundClip=1;audio.soundTiming=SoundTiming::WhenQuiet;
  applyOk(audio);update(8100);assert(!takeSoundCue(cue,8100,false,true));
  assert(!strcmp(expressionCues().sound_state,"expired"));
  reset();audio=cmd("ttl-min");audio.soundClip=1;audio.expiresAtMs=600;
  applyOk(audio);setPlaybackActive(true,200);setPhase(Phase::Speaking,nullptr,200);
  setPlaybackActive(false,300);speechEnded(300);
  assert(!takeSoundCue(cue,600,true,false)&&!strcmp(expressionCues().sound_state,"expired"));

  const uint32_t wrap=UINT32_MAX-1000;
  reset(wrap);audio=cmd("wrap",wrap);audio.soundClip=1;audio.soundTiming=SoundTiming::WhenQuiet;
  applyOk(audio,wrap);assert(takeSoundCue(cue,wrap+1,false,true));
  soundCueFinished(cue.token,wrap+100,true);assert(startTurn("next",2,wrap+200));
  audio.commandId="wrap-next";audio.turnId="next";audio.generation=2;
  audio.expiresAtMs=wrap+20000;applyOk(audio,wrap+200);
  assert(!takeSoundCue(cue,wrap+4000,false,true));assert(takeSoundCue(cue,wrap+4001,false,true));
  puts("expression_cues: actual player anchors/segment gaps, speech cue once, audio-only preservation, expiry/window/cooldown, stop/generation, enum/gain/catalog bounds passed");
}
