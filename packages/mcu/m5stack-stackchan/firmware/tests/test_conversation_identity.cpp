#include "conversation_identity.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <string>
#include <set>

using namespace conversation_identity;
namespace {
struct Storage { bool allowed=true; unsigned calls=0; uint64_t value=0; uint32_t unrelated=0x12345678; };
bool persist(void* context,uint64_t value) {
  Storage& storage=*static_cast<Storage*>(context);++storage.calls;
  if(!storage.allowed)return false;
  storage.value=value;return true;
}
}
int main() {
  Identity identity;Storage storage;
  assert(identity.initialize("pulse-123456789abc",0));
  assert(!strcmp(identity.physicalId(),"pulse-123456789abc"));
  assert(!strcmp(identity.conversationId(),identity.physicalId())&&identity.revision()==0);
  assert(identity.advance(persist,&storage)==AdvanceResult::Changed);
  assert(!strcmp(identity.conversationId(),"pulse-123456789abc-c0000000000000001"));
  assert(!strcmp(identity.physicalId(),"pulse-123456789abc")&&storage.value==1&&storage.unrelated==0x12345678);
  assert(identity.initialize("pulse-123456789abc",42));
  assert(!strcmp(identity.conversationId(),"pulse-123456789abc-c000000000000002a"));
  char before[64];strcpy(before,identity.conversationId());storage.allowed=false;
  assert(identity.advance(persist,&storage)==AdvanceResult::PersistenceFailed);
  assert(identity.revision()==42&&!strcmp(identity.conversationId(),before));
  assert(identity.advance(nullptr,nullptr)==AdvanceResult::PersistenceFailed);
  assert(identity.initialize("pulse-123456789abc",UINT64_MAX));
  const unsigned calls=storage.calls;strcpy(before,identity.conversationId());
  assert(identity.advance(persist,&storage)==AdvanceResult::RevisionOverflow&&storage.calls==calls);
  assert(identity.revision()==UINT64_MAX&&!strcmp(identity.conversationId(),before));

  char out[96]="unchanged";
  assert(!formatLogicalId(nullptr,1,out,sizeof(out))&&!strcmp(out,"unchanged"));
  assert(!formatLogicalId("",1,out,sizeof(out))&&!strcmp(out,"unchanged"));
  assert(!formatLogicalId("not/an/id",1,out,sizeof(out))&&!strcmp(out,"unchanged"));
  assert(!formatLogicalId("physical",1,out,5)&&!strcmp(out,"unchanged"));
  const std::string maximum(63,'a'),suffixBoundary(45,'a'),tooLong(46,'a');
  assert(formatLogicalId(maximum.c_str(),0,out,sizeof(out))&&strlen(out)==63);
  assert(!formatLogicalId(maximum.c_str(),1,out,sizeof(out))&&strlen(out)==63);
  assert(formatLogicalId(suffixBoundary.c_str(),1,out,sizeof(out))&&strlen(out)==63);
  assert(!formatLogicalId(tooLong.c_str(),1,out,sizeof(out))&&strlen(out)==63);
  assert(!formatLogicalId(std::string(64,'a').c_str(),0,out,sizeof(out)));
  assert(identity.initialize(suffixBoundary.c_str(),0));storage.allowed=true;
  const unsigned beforeBounds=storage.calls;
  assert(identity.advance(persist,&storage)==AdvanceResult::InvalidIdentity&&storage.calls==beforeBounds);
  assert(identity.revision()==0); // Logical63 cannot fit the existing64-byte interaction contract.

  assert(identity.initialize("pulse-123456789abc",0));storage.allowed=true;
  const Identity oldSnapshot=identity;
  char oldInteraction[65];assert(oldSnapshot.interactionId(7,1,oldInteraction,sizeof(oldInteraction)));
  assert(identity.advance(persist,&storage)==AdvanceResult::Changed);
  assert(oldSnapshot.ownsInteraction(oldInteraction)&&!identity.ownsInteraction(oldInteraction));
  char newInteraction[65];assert(identity.interactionId(7,2,newInteraction,sizeof(newInteraction)));
  assert(identity.ownsInteraction(newInteraction)&&!oldSnapshot.ownsInteraction(newInteraction));
  assert(!identity.ownsInteraction(nullptr)&&!identity.ownsInteraction(identity.conversationId()));
  assert(!identity.ownsInteraction((std::string(identity.conversationId())+"-00000000-4294967296").c_str()));
  assert(!identity.ownsInteraction((std::string(identity.conversationId())+"-nothex00-1").c_str()));
  assert(!strcmp(oldSnapshot.conversationId(),oldSnapshot.physicalId())); // Old HTTP/auth snapshot is immutable.
  assert(!strcmp(identity.physicalId(),oldSnapshot.physicalId()));
  assert(identity.initialize("pulse-123456789abc",0));storage.value=0;
  std::set<std::string> seen;
  for(unsigned i=1;i<=1000;++i){assert(identity.advance(persist,&storage)==AdvanceResult::Changed);assert(seen.insert(identity.conversationId()).second);assert(storage.value==i&&identity.revision()==i);}
  char interaction[65];assert(identity.interactionId(0x1234abcd,UINT32_MAX,interaction,sizeof(interaction)));
  assert(strlen(interaction)<=64&&strstr(interaction,identity.conversationId())==interaction);
  assert(strstr(interaction,"-1234abcd-4294967295"));
  strcpy(out,"unchanged");assert(!identity.interactionId(0,1,out,3)&&!strcmp(out,"unchanged"));
  assert(identity.initialize(std::string(26,'a').c_str(),1));
  assert(identity.interactionId(UINT32_MAX,UINT32_MAX,interaction,sizeof(interaction))&&strlen(interaction)==64);
  assert(!identity.initialize(std::string(27,'a').c_str(),1));

  ChangeGate gate;assert(gate.request(100,7));assert(!gate.request(200,7));
  for(unsigned mask=1;mask<16;++mask)
    assert(gate.poll(300,7,mask&1,mask&2,mask&4,mask&8)==ChangeDecision::Waiting);
  assert(gate.poll(300,7,false,false,false,false)==ChangeDecision::Ready);
  assert(gate.poll(300,8,false,false,false,false)==ChangeDecision::ConfigurationChanged);
  assert(gate.poll(40099,7,false,false,false,false)==ChangeDecision::Ready);
  assert(gate.poll(40100,7,false,false,false,false)==ChangeDecision::TimedOut);
  gate.finish();assert(!gate.active()&&gate.poll(50000,7,false,false,false,false)==ChangeDecision::Idle);
  const uint32_t wrap=UINT32_MAX-100;assert(gate.request(wrap,9));
  assert(gate.poll(wrap+39999,9,false,false,false,false)==ChangeDecision::Ready);
  assert(gate.poll(wrap+40000,9,false,false,false,false)==ChangeDecision::TimedOut);gate.finish();

  OutstandingTurns backend;
  assert(backend.add(oldInteraction)&&backend.add(oldInteraction)&&backend.count()==1);
  assert(!backend.terminal(oldInteraction,"interrupt")&&!backend.terminal(oldInteraction,"thinking"));
  assert(backend.count()==1); // Local interrupt and WS delivery do not prove async STT/LLM completion.
  assert(gate.request(100,1));
  assert(gate.poll(1000,1,false,false,false,backend.count()!=0)==ChangeDecision::Waiting);
  assert(gate.poll(40100,1,false,false,false,backend.count()!=0)==ChangeDecision::TimedOut);
  assert(!backend.terminal("unknown","completed")&&backend.count()==1);
  assert(!backend.terminal(oldInteraction,"aborted")&&backend.count()==1);
  assert(backend.terminal(oldInteraction,"completed")&&backend.count()==0);
  assert(gate.poll(2000,1,false,false,false,backend.count()!=0)==ChangeDecision::Ready);gate.finish();
  for(unsigned i=1;i<=OutstandingTurns::kCapacity;++i){char id[65];assert(oldSnapshot.interactionId(0,i,id,sizeof(id)));assert(backend.add(id));}
  assert(backend.count()==OutstandingTurns::kCapacity);
  assert(!backend.add(newInteraction)&&backend.count()==OutstandingTurns::kCapacity);
  char retired[65];assert(oldSnapshot.interactionId(0,1,retired,sizeof(retired)));
  assert(!backend.terminal(retired,"tool.completed")&&!backend.terminal(retired,"failed"));
  assert(backend.count()==OutstandingTurns::kCapacity); // A TTS segment failure is not backend completion.
  assert(!backend.terminal(retired,"aborted"));
  assert(backend.terminal(retired,"completed")&&backend.add(newInteraction));
  assert(backend.terminal(newInteraction,"completed"));
  assert(!backend.add(nullptr)&&!backend.add("")&&!backend.add(std::string(65,'a').c_str()));
  puts("conversation_identity: rev0/physical binding compatibility, persistent rotation/failure/overflow/bounds, 1000 unique IDs, old snapshot/report ownership, staged cancel/upload/report/terminal fences and40s timeout passed");
}
