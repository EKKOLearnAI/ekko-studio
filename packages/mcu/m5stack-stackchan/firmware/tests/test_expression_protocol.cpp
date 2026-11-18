#include "expression_protocol.h"
#include "sfx_bank.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

int main() {
  StaticJsonDocument<512> document;
  conversation::Command command;
  assert(!expression_protocol::parseCues(document.to<JsonObject>(),command));
  assert(!command.soundClip&&command.soundGain==.3f&&command.actionTiming==conversation::ActionTiming::Now);
  for(int i=1;i<sfx::C_COUNT;++i){
    document.clear();document["soundId"]=sfx::kClips[i].name;
    assert(!expression_protocol::parseCues(document.as<JsonObjectConst>(),command));
    assert(command.soundClip==i&&command.soundTiming==conversation::SoundTiming::AfterSpeech);
  }
  const char* invalid[]={
    "{\"soundId\":1}","{\"soundId\":null}","{\"soundId\":\"\"}",
    "{\"soundId\":\"https://example.test/audio.wav\"}","{\"soundId\":\"../home_pop\"}",
    "{\"soundId\":\"home_pop\",\"sound\":true}","{\"sound\":1}",
    "{\"soundId\":\"home_pop\",\"emotionId\":\"39\"}",
    "{\"soundGain\":true}","{\"soundGain\":\"0.3\"}","{\"soundGain\":-0.1}","{\"soundGain\":0.61}",
    "{\"soundGain\":1e999}","{\"actionTiming\":1}","{\"actionTiming\":\"tomorrow\"}",
    "{\"soundTiming\":false}","{\"soundTiming\":\"speech_start\"}"
  };
  for(const char* json:invalid){
    assert(!deserializeJson(document,json));
    assert(expression_protocol::parseCues(document.as<JsonObjectConst>(),command));
  }
  assert(!deserializeJson(document,"{\"soundId\":\"home_pop\",\"sound\":false,\"soundGain\":0.6,\"actionTiming\":\"speech_start\",\"soundTiming\":\"when_quiet\"}"));
  assert(!expression_protocol::parseCues(document.as<JsonObjectConst>(),command));
  assert(command.soundClip==sfx::C_HOME_POP&&command.soundGain==.6f&&!command.sound);
  assert(command.actionTiming==conversation::ActionTiming::SpeechStart&&command.soundTiming==conversation::SoundTiming::WhenQuiet);
  puts("expression_protocol: full compiled clip catalog, defaults, audio-only, bool/gain/enum types, URL/path/39 conflicts passed");
}
