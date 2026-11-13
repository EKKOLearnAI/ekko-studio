#pragma once
#include <ArduinoJson.h>
#include "conversation.h"

namespace expression_protocol {
// Validates only the optional cue extension. Existing control arbitration,
// IDs, deadlines and visual guard remain the caller's responsibility.
const char* parseCues(JsonObjectConst object, conversation::Command& command);
}
