#include "expression_protocol.h"
#include "sfx_bank.h"
#include <math.h>
#include <string.h>

namespace expression_protocol {
const char* parseCues(JsonObjectConst object, conversation::Command& command) {
  command.soundClip = 0;
  if (object.containsKey("soundId")) {
    if (!object["soundId"].is<const char*>()) return "soundId must be a clip name";
    const int found = sfx::findClip(object["soundId"].as<const char*>());
    if (found <= 0) return "unknown soundId";
    command.soundClip = (uint8_t)found;
  }
  if (object.containsKey("sound") && !object["sound"].is<bool>()) return "sound must be boolean";
  command.sound = object["sound"] | false;
  const char* emotion = object["emotionId"] | static_cast<const char*>(nullptr);
  if (command.soundClip && (command.sound || (emotion && !strcmp(emotion, "39"))))
    return "soundId conflicts with legacy sound or reply state";
  if (object.containsKey("soundGain") && (!object["soundGain"].is<float>() || object["soundGain"].is<bool>()))
    return "soundGain must be numeric";
  command.soundGain = object["soundGain"] | .3f;
  if (!isfinite(command.soundGain) || command.soundGain < 0 || command.soundGain > .6f)
    return "soundGain outside 0..0.6";
  if ((object.containsKey("actionTiming") && !object["actionTiming"].is<const char*>()) ||
      (object.containsKey("soundTiming") && !object["soundTiming"].is<const char*>())) return "invalid cue timing type";
  const char* action = object["actionTiming"] | "now";
  const char* sound = object["soundTiming"] | "after_speech";
  if ((strcmp(action, "now") && strcmp(action, "speech_start")) ||
      (strcmp(sound, "after_speech") && strcmp(sound, "when_quiet"))) return "unknown cue timing";
  command.actionTiming = !strcmp(action, "speech_start") ? conversation::ActionTiming::SpeechStart : conversation::ActionTiming::Now;
  command.soundTiming = !strcmp(sound, "when_quiet") ? conversation::SoundTiming::WhenQuiet : conversation::SoundTiming::AfterSpeech;
  return nullptr;
}
}
