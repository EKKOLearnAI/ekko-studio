#pragma once

#include <stddef.h>
#include <stdint.h>

namespace voice_audio {
struct Utterance;
struct Event;
}

// All network I/O runs in the link task. Public calls copy bounded metadata;
// submit() alone transfers a PCM buffer, and only when it returns true.
namespace studiolink {

enum class EventType : uint8_t { Phase, Transcript, Reply, Audio, Error, Network };

struct Event {
  EventType type = EventType::Network;
  uint32_t generation = 0;
  char phase[24] = {};
  char text[1536] = {};
  char interaction_id[96] = {};
  char segment_id[128] = {};
  char url[384] = {};           // Validated absolute URL on the configured origin.
  char mime[40] = {};
  uint32_t sample_rate = 0;
  uint8_t channels = 0;
  bool completion_managed = false;
};

struct Status {
  bool running = false;
  bool wifi_configured = false;
  bool wifi_connected = false;
  bool endpoint_configured = false;
  bool authenticated = false;  // A JWT is stored; a Socket connection verifies it.
  bool socket_connected = false;
  bool ready = false;          // Wi-Fi + endpoint + authenticated Socket namespace.
  bool agent_allowed = false;  // Explicit runtime gate; defaults to false on boot.
  bool authorizing = false;
  bool uploading = false;
  uint32_t generation = 1;
  uint32_t uploads = 0;
  uint32_t errors = 0;
  char server[256] = {};
  char profile[64] = {};
  char agent_runtime[12] = {};
  char ip[40] = {};
  char device_id[64] = {};
  char conversation_id[64] = {}; // Logical routing ID; physical authorization remains device_id.
  bool conversation_changing = false;
  uint32_t backend_pending = 0; // Accepted/uncertain backend turns awaiting an explicit terminal status.
  char error[120] = {};
  int wifi_state = -1;                 // Arduino wl_status_t; -1 before first poll.
  int last_disconnect_reason = 0;      // ESP-IDF Wi-Fi reason; 0 means none observed.
  bool ws_connected = false;          // HTTP Upgrade completed, before namespace auth.
  int auth_http_status = 0;           // App-login HTTP result; negatives are transport errors.
  int socket_stage = 0;              // 0=off,1=starting,2=WS,3=Engine open,4=auth sent,5=ready,6=rejected,7=disconnected.
  uint32_t ws_begins = 0;
  uint32_t ws_connects = 0;
  uint32_t ws_disconnects = 0;
  uint32_t ws_errors = 0;
  uint32_t engine_opens = 0;
  uint32_t namespace_auth_sends = 0;
  uint32_t namespace_acks = 0;
  uint32_t namespace_errors = 0;
};

bool begin();
void update();                 // Nonblocking compatibility hook; task owns I/O.
Status status();
bool configureWifi(const char* ssid, const char* password);
bool configureEndpoint(const char* server_url, const char* profile = "default");
bool configureRuntime(const char* runtime); // "hermes" (default) or "ekko".
bool authorize(const char* one_time_app_authorization_code);
void clearAuthorization();
void setAgentAllowed(bool allowed);
bool takeEvent(Event& out);
bool submit(voice_audio::Utterance& utterance);
uint32_t interrupt();          // Invalidates old turns immediately; returns new generation.
// Trusted local/USB action only. Queue an old-turn cancellation/terminal drain,
// then persist only chat_rev and reconnect. Success means accepted, not ready;
// wait for !conversation_changing, a changed conversation_id and ready together.
// A40s drain/storage failure preserves the old identity. Never starts capture.
bool newConversation();
void reportAudioEvent(const voice_audio::Event& event);
bool getBearer(char* out, size_t capacity);
bool resolveAudioUrl(const char* url, char* out, size_t capacity);

} // namespace studiolink
