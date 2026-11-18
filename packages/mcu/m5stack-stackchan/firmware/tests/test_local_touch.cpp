#include "conversation.h"
#include "sfx_bank.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

namespace {
unsigned visualCalls=0,actionCalls=0,actionReleases=0,cueCancels=0;
uint8_t lastState=0;
conversation::Hooks hooks{
  [](){return true;},[](bool){},
  [](uint8_t state,bool sound){assert(!sound);++visualCalls;lastState=state;},
  [](uint8_t,float){++actionCalls;},[](){++actionReleases;},[](){}
};
void reset(bool owned=true) {
  hooks.cancelCue=[](){++cueCancels;};
  conversation::begin(hooks,100);
  if(owned)assert(conversation::startTurn("turn",1,100));
  visualCalls=actionCalls=actionReleases=cueCancels=0;lastState=35;
}
conversation::Command command(const char* id) {
  conversation::Command c;c.commandId=id;c.turnId="turn";c.generation=1;
  c.expiresAtMs=10100;c.durationMs=5000;return c;
}
bool localTouch(uint32_t now) {
  return conversation::tryLocalFeedback(10,1000,now);
}
}
int main() {
  using namespace conversation;
  reset();auto explicitMood=command("explicit-angry");explicitMood.emotionId="21";
  Ack ack;assert(apply(explicitMood,ack,100));
  assert(!localTouch(200)&&lastState==21);
  clearLocalFeedback(300);assert(lastState==21&&!localFeedbackActive(300));
  update(5099);assert(lastState==21);update(5100);assert(lastState==35&&localFeedbackAvailable(5100));
  const unsigned oldActions=actionCalls,oldReleases=actionReleases;
  assert(localTouch(5200)&&lastState==10&&localFeedbackActive(5200)&&expressionCues().local_feedback);
  setPhase(Phase::Listening,"heartbeat",5400);assert(lastState==10);
  update(6200);assert(lastState==35&&!localFeedbackActive(6200));
  assert(actionCalls==oldActions&&actionReleases==oldReleases);
  assert(!tryLocalFeedback(10,0,6300)&&!tryLocalFeedback(10,3001,6300));
  assert(!tryLocalFeedback(8,1000,6300)&&!tryLocalFeedback(39,1000,6300)&&!tryLocalFeedback(41,1000,6300));

  reset();assert(localTouch(110));assert(tryQueueLocalCue(sfx::C_TOUCH_DIRTY_HANDS,.3f,3100,100));
  SoundCue expiredVisualCue;
  assert(!takeSoundCue(expiredVisualCue,1110,false,false));
  assert(lastState==35&&!localFeedbackActive(1110)); // Claim polling also maintains expired visuals.

  reset();assert(localTouch(110));
  explicitMood=command("remote-priority");explicitMood.emotionId="21";
  assert(apply(explicitMood,ack,200)&&lastState==21&&!localFeedbackActive(200));
  reset();auto action=command("explicit-action");action.actionId="nod_slow";
  action.actionTiming=ActionTiming::SpeechStart;assert(apply(action,ack,100));
  assert(!localFeedbackAvailable(110)&&!localTouch(110));
  reset();assert(localTouch(110));setPlaybackActive(true,120);
  assert(!localFeedbackActive(120)&&!localFeedbackAvailable(120)&&!localTouch(120));
  reset();assert(localTouch(30090));update(30100);assert(!active()); // No remote lease renewal.
  reset();for(unsigned i=0;i<100;++i)assert(localTouch(101+i));
  for(unsigned i=0;i<64;++i){char id[20];snprintf(id,sizeof(id),"remote-%u",i);auto c=command(id);c.emotionId="10";assert(apply(c,ack,300+i));}
  auto full=command("remote-65");full.emotionId="10";assert(!apply(full,ack,400)&&ack.status==AckStatus::Busy);

  reset();assert(tryQueueLocalCue(sfx::C_TOUCH_DIRTY_HANDS,.3f,3100,100));
  assert(expressionCues().local&&expressionCues().sound_pending);
  assert(!tryQueueLocalCue(sfx::C_TOUCH_DIRTY_HANDS,.3f,3100,110));
  assert(localTouch(120));SoundCue cue;
  assert(!takeSoundCue(cue,500,false,false));
  assert(takeSoundCue(cue,600,false,true)&&cue.local&&cue.expiresAtMs==3100);
  soundCueFinished(cue.token,1100,true);
  auto remote=command("remote-after-local");remote.soundClip=1;remote.soundTiming=SoundTiming::WhenQuiet;
  assert(apply(remote,ack,1200)); // Local cue did not consume the remote turn budget.
  assert(!takeSoundCue(cue,4599,false,true));assert(takeSoundCue(cue,4600,false,true)&&!cue.local);
  soundCueFinished(cue.token,4700,true);
  assert(!tryQueueLocalCue(sfx::C_TOUCH_DIRTY_HANDS,.3f,7800,4800));
  assert(tryQueueLocalCue(sfx::C_TOUCH_DIRTY_HANDS,.3f,11600,8600));
  assert(takeSoundCue(cue,8700,false,true)&&cue.local); // Remote cueUsed does not disable local feedback.
  remote.commandId="second-remote";remote.expiresAtMs=12000;
  assert(!apply(remote,ack,8800)&&ack.status==AckStatus::Busy&&expressionCues().local);
  cancelLocalCue(8900);assert(cueCancels==1&&!expressionCues().sound_playing);

  reset();remote=command("remote-slot");remote.soundClip=1;remote.soundTiming=SoundTiming::WhenQuiet;
  assert(apply(remote,ack,100));assert(!localFeedbackAvailable(150));
  assert(!tryQueueLocalCue(sfx::C_TOUCH_DIRTY_HANDS,.3f,3100,100));
  cancelLocalCue(200);assert(expressionCues().sound_pending&&!expressionCues().local);
  assert(takeSoundCue(cue,300,false,true));cancelLocalCue(400);
  assert(expressionCues().sound_playing&&!expressionCues().local&&cueCancels==0);

  reset();assert(localTouch(110));assert(tryQueueLocalCue(sfx::C_TOUCH_DIRTY_HANDS,.3f,3110,110));
  assert(takeSoundCue(cue,700,false,true));setPhase(Phase::Thinking,nullptr,800);
  assert(!localFeedbackActive(800)&&!expressionCues().sound_playing&&cueCancels==1);
  assert(!tryQueueLocalCue(sfx::C_TOUCH_DIRTY_HANDS,.3f,3800,800));
  reset();assert(tryQueueLocalCue(sfx::C_TOUCH_DIRTY_HANDS,.3f,3100,100));cancelLocalCue(200);
  assert(!tryQueueLocalCue(sfx::C_TOUCH_DIRTY_HANDS,.3f,3100,300)); // Same ticket cannot revive or extend.
  assert(tryQueueLocalCue(sfx::C_TOUCH_DIRTY_HANDS,.3f,3200,300));
  explicitMood=command("explicit-clears-local");explicitMood.emotionId="21";
  assert(apply(explicitMood,ack,400)&&!expressionCues().sound_pending&&!expressionCues().local);

  reset(false);const auto oldGeneration=generation();const auto oldPhase=phase();
  assert(tryQueueLocalCue(sfx::C_TOUCH_DIRTY_HANDS,.3f,3100,100));
  assert(!active()&&generation()==oldGeneration&&phase()==oldPhase&&visualCalls==0&&actionCalls==0&&actionReleases==0);
  assert(takeSoundCue(cue,200,false,true)&&cue.local);update(3100);
  assert(!active()&&generation()==oldGeneration&&!expressionCues().sound_playing&&cueCancels==1);
  assert(visualCalls==0&&actionCalls==0&&actionReleases==0);
  reset(false);assert(tryQueueLocalCue(sfx::C_TOUCH_DIRTY_HANDS,.3f,3100,100));
  assert(takeSoundCue(cue,200,false,true));assert(startTurn("turn",1,300));
  assert(!expressionCues().sound_playing&&cueCancels==1&&generation()==1);
  reset(false);assert(tryQueueLocalCue(sfx::C_TOUCH_DIRTY_HANDS,.3f,3100,100));cancel(200);
  assert(!expressionCues().sound_pending&&visibleEmotionId()==41);
  reset(false);assert(!tryQueueLocalCue(0,.3f,3100,100)&&!tryQueueLocalCue(sfx::C_COUNT,.3f,3100,100));
  assert(!tryQueueLocalCue(1,NAN,3100,100)&&!tryQueueLocalCue(1,.61f,3100,100));
  assert(!tryQueueLocalCue(1,.3f,100,100)&&!tryQueueLocalCue(1,.3f,3101,100));
  const uint32_t wrap=UINT32_MAX-100;
  assert(tryQueueLocalCue(sfx::C_TOUCH_DIRTY_HANDS,.3f,wrap+3000,wrap));
  assert(takeSoundCue(cue,wrap+500,false,true));update(wrap+3000);
  assert(!expressionCues().sound_playing&&!active());
  puts("local_touch: silent lower-priority visuals/no head/history/lease renewal, 3s absolute ticket TTL, ownerless local cue, independent remote budget, shared cooldown, explicit/phase/generation/stop fences passed");
}
