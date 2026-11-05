#include "studio_link.h"
#include "voice_audio.h"
#include "conversation_identity.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WebSocketsClient.h>
#include <WiFi.h>
#include <esp_heap_caps.h>
#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <ctype.h>
#include <atomic>
#include <new>
#include <stdlib.h>
#include <string.h>

namespace studiolink {
namespace {
constexpr size_t kBearerSize = 2048;
constexpr size_t kEventSlots = 12;
constexpr size_t kReportSlots = 8;
constexpr size_t kFrameLimit = 8192;
constexpr uint32_t kHttpTimeoutMs = 10000;
constexpr uint32_t kWifiConnectTimeoutMs = 30000;

struct JsonAllocator {
  void* allocate(size_t n) { return heap_caps_malloc(n, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT); }
  void deallocate(void* p) { heap_caps_free(p); }
  void* reallocate(void* p, size_t n) { return heap_caps_realloc(p, n, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT); }
};
using Json = BasicJsonDocument<JsonAllocator>;

struct Origin {
  char text[256];
  char host[200];
  uint16_t port;
};
struct Config {
  char ssid[33];
  char password[65];
  char server[256];
  char profile[64];
  char runtime[12];
  char bearer[kBearerSize];
  conversation_identity::Identity identity;
  uint32_t revision;
};
struct Upload {
  int16_t* samples;
  size_t count;
  uint32_t sample_rate;
  uint32_t generation;
  char interaction_id[96];
};
struct WorkerData {
  Config config;
  conversation_identity::OutstandingTurns backend;
  Event scratch;
  voice_audio::Event report;
  Upload upload;
  char code[256];
  char fragment[kFrameLimit + 1];
  char http_body[16385];
  size_t fragment_size;
  bool fragment_valid;
};

SemaphoreHandle_t gMutex = nullptr;
TaskHandle_t gTask = nullptr;
Config* gConfig = nullptr;
WorkerData* gWorker = nullptr;
Event* gEvents = nullptr;
voice_audio::Event* gReports = nullptr;
size_t gEventRead = 0, gEventCount = 0, gReportRead = 0, gReportCount = 0;
Status gStatus;
Upload gPending = {};
WebSocketsClient gSocket;
bool gWifiDirty = false, gSocketDirty = false, gSocketStarted = false;
std::atomic<bool> gNamespaceReady(false);
bool gAuthPending = false, gInterruptPending = false;
bool gSavedAgentConsent = false;  // NVS 里保存的用户授权（开机读取一次）
char gAuthCode[256] = {};
char gActiveId[96] = {}, gInterruptId[96] = {}, gInterruptProfile[64] = {};
char gInterruptRuntime[12] = {};
bool gTurnActive = false;
conversation_identity::ChangeGate gConversationChange;
bool gPlannedSocketDisconnect = false, gBackendTrackingUncertain = false;
uint32_t gBootId = 0, gTurnSequence = 0;
uint32_t gSocketRevision = 0;
uint32_t gSocketStartedMs = 0;
bool gSocketTimeoutReported = false;
std::atomic<int> gLastDisconnectReason(0);
std::atomic<uint32_t> gWifiEventSequence(0);
bool gWifiEventRegistered = false;
uint32_t gWifiAttemptStartedMs = 0;
bool gWifiAttemptActive = false;
int gWifiAttemptReason = 0;
char gLastWifiError[120] = {};

class Lock {
 public:
  Lock() { if (gMutex) xSemaphoreTake(gMutex, portMAX_DELAY); }
  ~Lock() { if (gMutex) xSemaphoreGive(gMutex); }
};

template <size_t N> void copy(char (&dst)[N], const char* src) {
  strlcpy(dst, src ? src : "", N);
}
void clearEvent(Event& event) {
  memset(&event, 0, sizeof(event));
  event.type = EventType::Network;
}
uint32_t interruptLocked() {
  if (*gActiveId && !gInterruptPending) {
    copy(gInterruptId, gActiveId);
    if (gConfig) { copy(gInterruptProfile, gConfig->profile); copy(gInterruptRuntime, gConfig->runtime); }
    gInterruptPending = true;
  }
  gActiveId[0] = 0; gTurnActive = false;
  if (++gStatus.generation == 0) ++gStatus.generation;
  return gStatus.generation;
}

bool validProfile(const char* value) {
  if (!value || !*value || strlen(value) >= sizeof(gStatus.profile)) return false;
  for (const unsigned char* p = reinterpret_cast<const unsigned char*>(value); *p; ++p) {
    if (*p < 0x20 || *p == 0x7f || *p == '/' || *p == '\\') return false;
  }
  return true;
}

// This first LAN implementation deliberately requires HTTP. HTTPS needs a
// provisioned CA rather than disabling certificate verification.
bool parseOrigin(const char* input, Origin& out) {
  memset(&out, 0, sizeof(out));
  if (!input || strncmp(input, "http://", 7) != 0 || strlen(input) >= sizeof(out.text)) return false;
  String authority(input + 7);
  if (authority.endsWith("/")) authority.remove(authority.length() - 1);
  if (!authority.length() || authority.indexOf('/') >= 0 || authority.indexOf('?') >= 0 ||
      authority.indexOf('#') >= 0 || authority.indexOf('@') >= 0) return false;
  String host, portText;
  bool ipv6 = authority[0] == '[';
  if (ipv6) {
    const int end = authority.indexOf(']');
    if (end < 2) return false;
    host = authority.substring(1, end);
    if (authority.length() > static_cast<size_t>(end + 1)) {
      if (authority[end + 1] != ':') return false;
      portText = authority.substring(end + 2);
      if (!portText.length()) return false;
    }
    for (size_t i = 0; i < host.length(); ++i) if (!isxdigit(host[i]) && host[i] != ':' && host[i] != '.') return false;
  } else {
    const int colon = authority.indexOf(':');
    host = colon < 0 ? authority : authority.substring(0, colon);
    if (colon >= 0) {
      portText = authority.substring(colon + 1);
      if (!portText.length()) return false;
    }
    for (size_t i = 0; i < host.length(); ++i) {
      const unsigned char c = host[i];
      if (!isalnum(c) && c != '.' && c != '-') return false;
    }
  }
  if (!host.length() || host.length() >= sizeof(out.host)) return false;
  unsigned long port = 80;
  if (portText.length()) {
    if (portText.length() > 5) return false;
    for (size_t i = 0; i < portText.length(); ++i) if (!isdigit(portText[i])) return false;
    port = strtoul(portText.c_str(), nullptr, 10);
    if (!port || port > 65535) return false;
  }
  host.toLowerCase();
  copy(out.host, host.c_str());
  out.port = static_cast<uint16_t>(port);
  const int n = snprintf(out.text, sizeof(out.text), ipv6 ? "http://[%s]" : "http://%s", host.c_str());
  if (n < 0 || static_cast<size_t>(n) >= sizeof(out.text)) return false;
  if (port != 80) {
    const size_t used = strlen(out.text);
    if (snprintf(out.text + used, sizeof(out.text) - used, ":%lu", port) >= static_cast<int>(sizeof(out.text) - used)) return false;
  }
  return true;
}

bool audioUrlFor(const char* url, const char* server, char* out, size_t capacity) {
  if (!out || !capacity) return false;
  out[0] = 0;
  Origin configured;
  if (!url || !parseOrigin(server, configured)) return false;
  const char* path = url;
  if (*url != '/') {
    const char* slash = strstr(url, "://");
    slash = slash ? strchr(slash + 3, '/') : nullptr;
    if (!slash) return false;
    const size_t len = static_cast<size_t>(slash - url);
    if (len >= sizeof(configured.text)) return false;
    char originText[256];
    memcpy(originText, url, len);
    originText[len] = 0;
    Origin candidate;
    if (!parseOrigin(originText, candidate) || strcmp(candidate.text, configured.text)) return false;
    path = slash;
  }
  constexpr const char* prefix = "/api/studio/mcu/audio/";
  if (strncmp(path, prefix, strlen(prefix))) return false;
  const char* file = path + strlen(prefix);
  if (!*file || strlen(file) > 100 || strstr(file, "..")) return false;
  for (const unsigned char* p = reinterpret_cast<const unsigned char*>(file); *p; ++p) {
    if (!isalnum(*p) && *p != '-' && *p != '.') return false;
  }
  const size_t n = strlen(file);
  if (!((n > 6 && !strcmp(file + n - 6, ".adpcm")) || (n > 4 && !strcmp(file + n - 4, ".pcm")))) return false;
  const int written = snprintf(out, capacity, "%s%s", configured.text, path);
  return written > 0 && static_cast<size_t>(written) < capacity;
}

void refreshReadyLocked() {
  gStatus.ready = gStatus.wifi_connected && gStatus.endpoint_configured && gNamespaceReady && !gStatus.conversation_changing;
  gStatus.socket_connected = gNamespaceReady;
}
void error(const char* message) {
  Lock lock;
  copy(gStatus.error, message);
  ++gStatus.errors;
}

// Called on Arduino's event task: no allocation, mutex, serial or network I/O.
void wifiEvent(arduino_event_id_t event, arduino_event_info_t info) {
  if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
    gLastDisconnectReason.store(info.wifi_sta_disconnected.reason, std::memory_order_relaxed);
    gWifiEventSequence.fetch_add(1, std::memory_order_release);
  }
}

void updateWifiDiagnosticLocked(wl_status_t state, int reason, bool eventChanged) {
  gStatus.wifi_state = static_cast<int>(state);
  gStatus.last_disconnect_reason = reason;
  if (state == WL_CONNECTED) {
    gWifiAttemptActive = false;
    gWifiAttemptReason = 0;
    if (*gLastWifiError && !strcmp(gStatus.error, gLastWifiError)) gStatus.error[0] = 0;
    gLastWifiError[0] = 0;
    return;
  }
  if (!gStatus.wifi_configured) return;
  if (!gWifiAttemptActive) {
    gWifiAttemptStartedMs = millis();
    gWifiAttemptActive = true;
  }
  if (eventChanged) gWifiAttemptReason = reason;
  // last_disconnect_reason is historical; a previous connection's reason
  // must not be presented as the cause of a new connection attempt.
  reason = gWifiAttemptReason;
  char message[120] = {};
  if (state == WL_NO_SSID_AVAIL || reason == WIFI_REASON_NO_AP_FOUND) {
    snprintf(message, sizeof(message), "Wi-Fi network not found; check SSID and 2.4 GHz coverage (reason %d)", reason);
  } else if (state == WL_CONNECT_FAILED) {
    snprintf(message, sizeof(message), "Wi-Fi connection failed; check signal and security settings (reason %d)", reason);
  } else if (state == WL_NO_SHIELD) {
    copy(message, "Wi-Fi driver unavailable; check initialization and internal memory");
  } else if (reason == WIFI_REASON_AUTH_FAIL || reason == WIFI_REASON_HANDSHAKE_TIMEOUT || reason == WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT) {
    snprintf(message, sizeof(message), "Wi-Fi authentication/handshake failed; check security and signal (reason %d)", reason);
  } else if (reason == WIFI_REASON_ASSOC_FAIL) {
    snprintf(message, sizeof(message), "Wi-Fi association failed; check AP capacity and signal (reason %d)", reason);
  } else if (millis() - gWifiAttemptStartedMs >= kWifiConnectTimeoutMs) {
    snprintf(message, sizeof(message), "Wi-Fi connection timed out; check SSID, coverage and AP settings (state %d, reason %d)", static_cast<int>(state), reason);
  } else if (eventChanged && reason) {
    snprintf(message, sizeof(message), "Wi-Fi disconnected; reconnecting (reason %d)", reason);
  }
  if (*message && strcmp(message, gLastWifiError)) {
    copy(gStatus.error, message);
    copy(gLastWifiError, message);
    ++gStatus.errors;
  }
}
bool pushEvent(const Event& event) {
  Lock lock;
  if (gEventCount == kEventSlots) {
    ++gStatus.errors;
    copy(gStatus.error, "Studio event queue full");
    return false;
  }
  gEvents[(gEventRead + gEventCount++) % kEventSlots] = event;
  return true;
}
// 2026-11-05：用户明确开启的 Agent 授权保存在 NVS，开机后恢复（同一凭据/服务器/运行时下）。
// 任何会改变身份或去向的操作（改服务器、换运行时、清除授权）都会同时清掉这条保存的授权。
void persistAgentConsentLocked(bool allowed) {
  Preferences prefs;
  if (!prefs.begin("pulse_net", false)) return;
  if (allowed) prefs.putBool("agent_ok", true);
  else prefs.remove("agent_ok");
  prefs.end();
}
void persistConfigLocked(bool wifi, bool endpoint, bool token) {
  Preferences prefs;
  if (!prefs.begin("pulse_net", false)) {
    copy(gStatus.error, "Network settings storage unavailable");
    ++gStatus.errors;
    return;
  }
  bool ok = true;
  if (wifi) {
    ok = prefs.putString("ssid", gConfig->ssid) > 0 && ok;
    ok = prefs.putString("pass", gConfig->password) > 0 && ok;
  }
  if (endpoint) {
    ok = prefs.putString("server", gConfig->server) > 0 && ok;
    ok = prefs.putString("profile", gConfig->profile) > 0 && ok;
    ok = prefs.putString("runtime", gConfig->runtime) > 0 && ok;
  }
  if (token) {
    if (*gConfig->bearer) ok = prefs.putString("jwt", gConfig->bearer) > 0 && ok;
    else prefs.remove("jwt");
  }
  prefs.end();
  if (!ok) { copy(gStatus.error, "Network settings were not saved"); ++gStatus.errors; }
}
bool persistChatRevision(void*, uint64_t revision) {
  Preferences prefs;
  if (!prefs.begin("pulse_net", false)) return false;
  const bool correctType = !prefs.isKey("chat_rev") || prefs.getType("chat_rev") == PT_U64;
  const bool saved = correctType && prefs.putULong64("chat_rev", revision) == sizeof(uint64_t) &&
                     prefs.getULong64("chat_rev", 0) == revision;
  prefs.end();
  return saved;
}
void serviceConversationChange() {
  Lock lock;
  const auto decision = gConversationChange.poll(millis(), gConfig->revision, gInterruptPending,
      gStatus.uploading || gPending.samples, gReportCount != 0,
      gWorker->backend.count() != 0 || gBackendTrackingUncertain);
  if (decision == conversation_identity::ChangeDecision::Idle || decision == conversation_identity::ChangeDecision::Waiting) return;
  gConversationChange.finish();
  gStatus.conversation_changing = false;
  if (decision != conversation_identity::ChangeDecision::Ready) {
    copy(gStatus.error, decision == conversation_identity::ChangeDecision::TimedOut
        ? "New conversation timed out waiting for old turn/audio drain; routing unchanged"
        : "New conversation cancelled by configuration change; routing unchanged");
    ++gStatus.errors; refreshReadyLocked(); return;
  }
  const auto result = gConfig->identity.advance(persistChatRevision, nullptr);
  if (result != conversation_identity::AdvanceResult::Changed) {
    copy(gStatus.error, result == conversation_identity::AdvanceResult::RevisionOverflow
        ? "Conversation revision exhausted"
        : result == conversation_identity::AdvanceResult::InvalidIdentity
          ? "Conversation identity exceeds protocol limits"
          : "Conversation revision was not saved; routing identity unchanged");
    ++gStatus.errors; refreshReadyLocked(); return;
  }
  copy(gStatus.conversation_id, gConfig->identity.conversationId());
  ++gConfig->revision;
  // All old reports have been sent on the old namespace. Late reports are
  // filtered by routing identity at ingress and again at send time.
  gEventRead = gEventCount = 0;
  gNamespaceReady = false;
  gSocketDirty = true;
  refreshReadyLocked();
}

bool sendMcu(const char* name, Json& body) {
  if (!gNamespaceReady) return false;
  {
    Lock lock;
    if (gSocketDirty || gConfig->revision != gSocketRevision) return false;
    body["apiToken"] = String(gConfig->bearer);
    if (!body.containsKey("profile")) body["profile"] = String(gConfig->profile);
  }
  body["type"] = name;
  if (body.overflowed()) { error("Studio event allocation failed"); return false; }
  String frame("42/global-agent,[\"");
  frame += name;
  frame += "\",";
  serializeJson(body, frame);
  frame += ']';
  return gSocket.sendTXT(frame);
}
bool sendAudioReport(const voice_audio::Event& event) {
  if (!gWorker->config.identity.ownsInteraction(event.interaction_id)) return true;
  const char* name = "audio.dropped";
  switch (event.kind) {
    case voice_audio::EventKind::Started: name = "audio.started"; break;
    case voice_audio::EventKind::Done: name = "audio.done"; break;
    case voice_audio::EventKind::Cancelled: name = "audio.interrupted"; break;
    case voice_audio::EventKind::Failed: break;
  }
  Json body(4096);
  body["interactionId"] = event.interaction_id;
  body["segmentId"] = event.segment_id;
  body["generation"] = event.generation;
  if (*event.error) body["reason"] = "device_audio_failed";
  return sendMcu(name, body);
}
void rejectAudio(const char* interaction, const char* segment, const char* reason) {
  if (!segment || !*segment) return;
  Json body(4096);
  body["interactionId"] = interaction ? interaction : "";
  body["segmentId"] = segment;
  body["reason"] = reason;
  sendMcu("audio.dropped", body);
}

void handlePacket(const char* data, size_t length) {
  if (!length) return;
  if (data[0] == '2') {
    String pong("3");
    if (length > 1) pong.concat(data + 1, length - 1);
    gSocket.sendTXT(pong);
    return;
  }
  if (data[0] == '0') {
    { Lock lock; ++gStatus.engine_opens; gStatus.socket_stage = 3; }
    Json auth(4096);
    {
      Lock lock;
      if (gSocketDirty || gConfig->revision != gSocketRevision) return;
      auth["token"] = String(gConfig->bearer);
      auth["profile"] = String(gConfig->profile);
      auth["instanceId"] = gWorker->config.identity.conversationId();
      auth["deviceCode"] = gWorker->config.identity.physicalId();
    }
    auth["role"] = "hermes-studio";
    auth["agentRuntime"] = gWorker->config.runtime;
    if (auth.overflowed()) { error("Socket authentication allocation failed"); return; }
    String packet("40/global-agent,");
    serializeJson(auth, packet);
    if (gSocket.sendTXT(packet)) {
      Lock lock;
      ++gStatus.namespace_auth_sends;
      gStatus.socket_stage = 4;
    } else error("Studio namespace authentication could not be sent");
    return;
  }
  if (length >= 16 && !strncmp(data, "40/global-agent,", 16)) {
    {
      Lock lock;
      if (gSocketDirty || gConfig->revision != gSocketRevision) return;
      gNamespaceReady = true;
      ++gStatus.namespace_acks;
      gStatus.socket_stage = 5;
      refreshReadyLocked();
      gStatus.error[0] = 0;
    }
    Json ready(4096);
    ready["id"] = gWorker->config.identity.conversationId();
    ready["agentRuntime"] = gWorker->config.runtime;
    ready["capabilities"]["display"] = true;
    ready["capabilities"]["audio_queue"] = true;
    ready["capabilities"]["audio_playback"] = true;
    ready["capabilities"]["pcm_stream"] = false;
    sendMcu("mcu.ready", ready);
    return;
  }
  if (length >= 15 && (!strncmp(data, "44/global-agent", 15) || !strncmp(data, "41/global-agent", 15))) {
    { Lock lock;
      gNamespaceReady = false;
      ++gStatus.namespace_errors;
      gStatus.socket_stage = 6;
      refreshReadyLocked();
    }
    error("Studio authorization rejected; pair again");
    gSocket.disconnect();
    return;
  }
  constexpr const char* prefix = "42/global-agent,";
  const size_t prefixSize = strlen(prefix);
  if (length <= prefixSize || strncmp(data, prefix, prefixSize)) return;
  // Socket.IO may insert an acknowledgement id before the JSON array.
  size_t start = prefixSize;
  while (start < length && isdigit(static_cast<unsigned char>(data[start]))) ++start;
  if (start >= length || data[start] != '[') return;
  Json doc(12288);
  if (deserializeJson(doc, data + start, length - start) || !doc.is<JsonArray>()) {
    error("Invalid Studio event");
    return;
  }
  const char* name = doc[0] | "";
  JsonObject body = doc[1].as<JsonObject>();
  if (body.isNull()) return;
  if (!strcmp(name, "auth.invalid")) {
    error("Studio token expired; pair again");
    return;
  }
  const char* interaction = body["interactionId"] | "";
  const char* segment = body["segmentId"] | "";
  uint32_t generation;
  bool current;
  {
    Lock lock;
    // Terminals for interrupted turns must clear the backend fence before
    // active-ID/generation filtering, or an old asynchronous STT turn leaks.
    if (!strcmp(name, "interaction.status")) {
      gWorker->backend.terminal(interaction, body["status"] | "");
      gStatus.backend_pending = gWorker->backend.count() + (gBackendTrackingUncertain ? 1 : 0);
    }
    generation = gStatus.generation;
    current = *interaction && !strcmp(interaction, gActiveId);
  }
  if (!current) {
    if (!strcmp(name, "audio.enqueue")) rejectAudio(interaction, segment, "stale_interaction");
    return;
  }
  Event& event = gWorker->scratch;
  clearEvent(event);
  event.generation = generation;
  copy(event.interaction_id, interaction);
  copy(event.segment_id, segment);
  if (!strcmp(name, "interaction.status")) {
    const char* phase = body["status"] | "";
    const char* text = body["text"] | "";
    event.type = EventType::Phase;
    copy(event.phase, phase);
    copy(event.text, text);
    pushEvent(event);
    if (!strcmp(phase, "thinking") && *text) {
      event.type = EventType::Transcript;
      pushEvent(event);
    } else if (!strcmp(phase, "speaking") && *text) {
      event.type = EventType::Reply;
      pushEvent(event);
    }
    if (!strcmp(phase, "completed") || !strcmp(phase, "failed") || !strcmp(phase, "aborted")) {
      Lock lock;
      if (!strcmp(gActiveId, interaction)) gTurnActive = false;
    }
  } else if (!strcmp(name, "audio.enqueue")) {
    char server[256];
    { Lock lock; copy(server, gConfig->server); }
    event.type = EventType::Audio;
    copy(event.text, body["text"] | "");
    copy(event.mime, body["mimeType"] | "");
    const uint32_t rate = body["sampleRate"] | 0U;
    const unsigned channels = body["channels"] | 0U;
    if (!*segment || strlen(segment) >= 80 || strlen(interaction) >= 80 ||
        (strcmp(event.mime, "audio/x-ima-adpcm") && strcmp(event.mime, "audio/x-pcm") && strcmp(event.mime, "audio/pcm")) ||
        channels != 1 || rate < 8000 || rate > 48000 ||
        !audioUrlFor(body["url"] | "", server, event.url, sizeof(event.url))) {
      rejectAudio(interaction, segment, "unsupported_audio");
      error("Studio audio metadata or origin rejected");
      return;
    }
    event.sample_rate = rate;
    event.channels = 1;
    event.completion_managed = body["completionManagedByServer"] | false;
    if (!pushEvent(event)) rejectAudio(interaction, segment, "device_queue_full");
  } else if (!strcmp(name, "tool.started") || !strcmp(name, "tool.completed") || !strcmp(name, "tool.failed")) {
    event.type = EventType::Phase;
    copy(event.phase, !strcmp(name, "tool.started") ? "tool" : "thinking");
    copy(event.text, body["tool"] | "");
    pushEvent(event);
  }
}

void disconnected() {
  const uint32_t generation = interrupt();
  Event& event = gWorker->scratch;
  clearEvent(event);
  event.type = EventType::Network;
  event.generation = generation;
  copy(event.phase, "disconnected");
  copy(event.text, "Studio connection lost");
  pushEvent(event);
}

void socketEvent(WStype_t type, uint8_t* payload, size_t length) {
  if (type == WStype_CONNECTED) {
    Lock lock;
    gStatus.ws_connected = true;
    ++gStatus.ws_connects;
    gStatus.socket_stage = 2;
    gSocketStartedMs = millis();
    gSocketTimeoutReported = false;
    return;
  }
  if (type == WStype_ERROR) {
    { Lock lock; ++gStatus.ws_errors; }
    error("Studio WebSocket transport error");
    return;
  }
  if (type == WStype_DISCONNECTED) {
    // Reconnection gets its own deadline; the old connection may have been
    // healthy for hours before this transport loss.
    gSocketStartedMs = millis();
    gSocketTimeoutReported = false;
    bool wasReady, planned;
    { Lock lock;
      wasReady = gNamespaceReady;
      planned = gPlannedSocketDisconnect || gSocketDirty || (gConfig && gSocketRevision != gConfig->revision);
      gNamespaceReady = false;
      gStatus.ws_connected = false;
      ++gStatus.ws_disconnects;
      if (gStatus.socket_stage != 6) gStatus.socket_stage = 7;
      refreshReadyLocked();
    }
    if (wasReady && !planned) disconnected();
    return;
  }
  if (type == WStype_TEXT) {
    if (length > kFrameLimit) { error("Studio frame exceeds limit"); return; }
    handlePacket(reinterpret_cast<const char*>(payload), length);
    return;
  }
  if (type == WStype_FRAGMENT_TEXT_START) {
    gWorker->fragment_size = 0;
    gWorker->fragment_valid = true;
  } else if (type != WStype_FRAGMENT && type != WStype_FRAGMENT_FIN) {
    return;
  }
  if (gWorker->fragment_valid && length <= kFrameLimit - gWorker->fragment_size) {
    memcpy(gWorker->fragment + gWorker->fragment_size, payload, length);
    gWorker->fragment_size += length;
  } else {
    gWorker->fragment_valid = false;
  }
  if (type == WStype_FRAGMENT_FIN) {
    if (gWorker->fragment_valid) handlePacket(gWorker->fragment, gWorker->fragment_size);
    else error("Fragmented Studio frame exceeds limit");
    gWorker->fragment_valid = false;
  }
}

void put16(uint8_t* p, uint16_t value) { p[0] = value; p[1] = value >> 8; }
void put32(uint8_t* p, uint32_t value) { for (unsigned i = 0; i < 4; ++i) p[i] = value >> (i * 8); }
class WavStream : public Stream {
 public:
  explicit WavStream(const Upload& upload) : data_(reinterpret_cast<const uint8_t*>(upload.samples)), bytes_(upload.count * 2) {
    memcpy(header_, "RIFF", 4); put32(header_ + 4, bytes_ + 36);
    memcpy(header_ + 8, "WAVEfmt ", 8); put32(header_ + 16, 16);
    put16(header_ + 20, 1); put16(header_ + 22, 1);
    put32(header_ + 24, upload.sample_rate); put32(header_ + 28, upload.sample_rate * 2);
    put16(header_ + 32, 2); put16(header_ + 34, 16);
    memcpy(header_ + 36, "data", 4); put32(header_ + 40, bytes_);
  }
  int available() override { return static_cast<int>(bytes_ + sizeof(header_) - position_); }
  int read() override { const int v = peek(); if (v >= 0) ++position_; return v; }
  int peek() override {
    if (!available()) return -1;
    return position_ < sizeof(header_) ? header_[position_] : data_[position_ - sizeof(header_)];
  }
  void flush() override {}
  size_t write(uint8_t) override { return 0; }
 private:
  const uint8_t* data_;
  size_t bytes_, position_ = 0;
  uint8_t header_[44] = {};
};

class ResponseStream : public Stream {
 public:
  ResponseStream(char* buffer, size_t capacity) : buffer_(buffer), capacity_(capacity) { buffer_[0] = 0; }
  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  void flush() override {}
  size_t write(uint8_t value) override { return write(&value, 1); }
  size_t write(const uint8_t* data, size_t length) override {
    if (length > capacity_ - size_ - 1) return 0;
    memcpy(buffer_ + size_, data, length);
    size_ += length;
    buffer_[size_] = 0;
    return length;
  }
  size_t size() const { return size_; }
 private:
  char* buffer_;
  size_t capacity_, size_ = 0;
};

bool readResponse(HTTPClient& http, Json& response, size_t capacity) {
  if (http.getSize() > static_cast<int>(capacity - 1)) return false;
  ResponseStream stream(gWorker->http_body, capacity);
  if (http.writeToStream(&stream) < 0 || !stream.size()) return false;
  return !deserializeJson(response, gWorker->http_body, stream.size());
}

bool startHttp(HTTPClient& http, WiFiClient& client, const Config& config, const char* path) {
  String url(config.server);
  url += path;
  http.setConnectTimeout(4000);
  http.setTimeout(kHttpTimeoutMs);
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  http.setReuse(false);
  return http.begin(client, url);
}

void authorizeHttp() {
  WorkerData& worker = *gWorker;
  WiFiClient client;
  HTTPClient http;
  int code = -1;
  bool success = false;
  if (startHttp(http, client, worker.config, "/api/auth/app-login")) {
    Json request(2048);
    request["authorization_code"] = worker.code;
    request["device_code"] = worker.config.identity.physicalId();
    request["device_name"] = "Pulse StackChan";
    request["device_brand"] = "M5Stack";
    request["device_model"] = "CoreS3 StackChan";
    String json;
    serializeJson(request, json);
    http.addHeader("Content-Type", "application/json");
    code = http.POST(json);
    { Lock lock; gStatus.auth_http_status = code; }
    if (code >= 200 && code < 300 && http.getSize() <= 16384) {
      Json response(16384);
      if (readResponse(http, response, sizeof(worker.http_body))) {
        const char* bearer = response["token"] | "";
        bool profileAllowed = false;
        for (JsonVariant profile : response["profiles"].as<JsonArray>()) {
          if (profile.is<const char*>() && !strcmp(profile.as<const char*>(), worker.config.profile)) profileAllowed = true;
        }
        if (*bearer && strlen(bearer) < kBearerSize && profileAllowed && !strchr(bearer, '\r') && !strchr(bearer, '\n')) {
          Lock lock;
          if (gConfig->revision == worker.config.revision) {
            copy(gConfig->bearer, bearer);
            gStatus.authenticated = true;
            gStatus.error[0] = 0;
            gSocketDirty = true;
            persistConfigLocked(false, false, true);
            success = true;
          }
        }
      }
    }
    http.end();
  }
  memset(worker.code, 0, sizeof(worker.code));
  { Lock lock; gStatus.authorizing = false; }
  if (!success) error(code == 401 || code == 409 || code == 410 ? "Pairing code rejected or expired" : "Pairing failed; check server and Profile access");
}

void uploadHttp() {
  WorkerData& worker = *gWorker;
  bool allowed;
  {
    Lock lock;
    allowed = gStatus.agent_allowed && gStatus.generation == worker.upload.generation && gConfig->revision == worker.config.revision;
  }
  int code = -1;
  bool backendMayHaveStarted = false;
  if (allowed) {
    WiFiClient client;
    HTTPClient http;
    bool backendRoom;
    { Lock lock; backendRoom = !gBackendTrackingUncertain && worker.backend.count() < conversation_identity::OutstandingTurns::kCapacity; }
    if (backendRoom && startHttp(http, client, worker.config, "/api/studio/mcu/voice-turn")) {
      http.addHeader("Authorization", String("Bearer ") + worker.config.bearer);
      http.addHeader("Content-Type", "audio/wav");
      http.addHeader("X-Hermes-Profile", worker.config.profile);
      http.addHeader("X-Hermes-Mcu-Interaction-Id", worker.upload.interaction_id);
      http.addHeader("X-Hermes-Mcu-Device-Id", worker.config.identity.conversationId());
      http.addHeader("X-Hermes-Mcu-Agent-Runtime", worker.config.runtime);
      WavStream stream(worker.upload);
      code = http.sendRequest("POST", &stream, worker.upload.count * 2 + 44);
      if (code >= 200 && code < 300) {
        Json response(4096);
        const bool parsed = readResponse(http, response, 4096);
        backendMayHaveStarted = !parsed || (response["accepted"] | false);
        if (!parsed || !(response["accepted"] | false)) code = -2;
      } else if (code < 0 || code >= 500) {
        // A transport failure cannot prove that an asynchronous backend did
        // not receive the request. Keep the conservative terminal fence.
        backendMayHaveStarted = true;
      }
      http.end();
    }
  }
  free(worker.upload.samples);
  worker.upload.samples = nullptr;
  {
    Lock lock;
    if (backendMayHaveStarted && !worker.backend.add(worker.upload.interaction_id)) gBackendTrackingUncertain = true;
    gStatus.backend_pending = worker.backend.count() + (gBackendTrackingUncertain ? 1 : 0);
    gStatus.uploading = false;
    if (code >= 200 && code < 300) ++gStatus.uploads;
    else if (!strcmp(worker.upload.interaction_id, gActiveId)) gTurnActive = false;
  }
  if (allowed && !(code >= 200 && code < 300)) {
    error(code == 401 ? "Studio token expired; pair again" : "Voice upload was not accepted");
    Event& event = worker.scratch;
    clearEvent(event);
    event.type = EventType::Phase;
    event.generation = worker.upload.generation;
    copy(event.phase, "failed");
    copy(event.interaction_id, worker.upload.interaction_id);
    copy(event.text, "Voice upload failed");
    pushEvent(event);
  }
}

void task(void*) {
  gSocket.onEvent(socketEvent);
  // The library defaults to Origin: file://, rejected by Studio's upgrade
  // origin policy. This native device sends no browser Origin, like the
  // existing official MCU client; namespace JWT authentication still applies.
  gSocket.setExtraHeaders("");
  gSocket.setReconnectInterval(5000);
  gSocket.disableHeartbeat(); // Engine.IO ping/pong is handled as text packets.
  uint32_t observedWifiEvent = gWifiEventSequence.load(std::memory_order_acquire);
  for (;;) {
    bool wifiDirty, socketDirty;
    {
      Lock lock;
      gWorker->config = *gConfig;
      wifiDirty = gWifiDirty;
      socketDirty = gSocketDirty;
      gWifiDirty = gSocketDirty = false;
    }
    if (socketDirty || wifiDirty) {
      gPlannedSocketDisconnect = true;
      gSocket.disconnect();
      gPlannedSocketDisconnect = false;
      gSocketStarted = false;
      { Lock lock;
        gNamespaceReady = false;
        gStatus.ws_connected = false;
        gStatus.socket_stage = 0;
        refreshReadyLocked();
      }
    }
    if (wifiDirty && *gWorker->config.ssid) {
      {
        Lock lock;
        gWifiAttemptStartedMs = millis();
        gWifiAttemptActive = true;
        gWifiAttemptReason = 0;
        gLastWifiError[0] = 0;
      }
      WiFi.persistent(false);
      const wifi_mode_t mode = WiFi.getMode();
      if (!WiFi.mode(mode == WIFI_AP || mode == WIFI_AP_STA ? WIFI_AP_STA : WIFI_STA)) {
        error("Wi-Fi driver failed to start; check free internal memory");
      } else {
        WiFi.setAutoReconnect(true);
        const wl_status_t result = WiFi.begin(gWorker->config.ssid, gWorker->config.password);
        if (result == WL_CONNECT_FAILED || result == WL_NO_SHIELD) error("Wi-Fi connection could not start");
      }
    }
    const wl_status_t wifiState = WiFi.status();
    const bool wifiConnected = wifiState == WL_CONNECTED;
    const uint32_t wifiEventSequence = gWifiEventSequence.load(std::memory_order_acquire);
    const bool wifiEventChanged = observedWifiEvent != wifiEventSequence;
    observedWifiEvent = wifiEventSequence;
    const int disconnectReason = gLastDisconnectReason.load(std::memory_order_relaxed);
    bool lostConnection = false;
    {
      Lock lock;
      lostConnection = gStatus.wifi_connected && !wifiConnected && (gNamespaceReady || gTurnActive);
      gStatus.wifi_connected = wifiConnected;
      updateWifiDiagnosticLocked(wifiState, disconnectReason, wifiEventChanged);
      if (wifiConnected) copy(gStatus.ip, WiFi.localIP().toString().c_str());
      else { gStatus.ip[0] = 0; gNamespaceReady = false; }
      refreshReadyLocked();
    }
    if (lostConnection) disconnected();
    if (wifiConnected && *gWorker->config.server && *gWorker->config.bearer && !gSocketStarted) {
      Origin origin;
      if (parseOrigin(gWorker->config.server, origin)) {
        gSocketRevision = gWorker->config.revision;
        gSocket.begin(origin.host, origin.port, "/socket.io/?EIO=4&transport=websocket", "");
        gSocketStarted = true;
        gSocketStartedMs = millis();
        gSocketTimeoutReported = false;
        { Lock lock; ++gStatus.ws_begins; gStatus.socket_stage = 1; }
      }
    }
    if (wifiConnected && gSocketStarted) gSocket.loop();
    if (wifiConnected && gSocketStarted && !gNamespaceReady && !gSocketTimeoutReported && millis() - gSocketStartedMs >= 20000) {
      bool upgraded;
      { Lock lock; upgraded = gStatus.ws_connected; }
      error(upgraded ? "Studio WebSocket connected; namespace authentication timed out" : "Studio WebSocket upgrade timed out; check server address and upgrade access");
      gSocketTimeoutReported = true;
    }
    if (gNamespaceReady) {
      bool pendingInterrupt;
      {
        Lock lock;
        pendingInterrupt = gInterruptPending;
        if (pendingInterrupt) {
          copy(gWorker->scratch.interaction_id, gInterruptId);
          copy(gWorker->scratch.phase, "");
        }
      }
      if (pendingInterrupt && *gWorker->scratch.interaction_id) {
        Json body(4096);
        body["interactionId"] = gWorker->scratch.interaction_id;
        { Lock lock;
          body["profile"] = String(gInterruptProfile);
          body["agentRuntime"] = String(gInterruptRuntime);
        }
        if (sendMcu("mcu.interrupt", body)) {
          Lock lock;
          if (!strcmp(gInterruptId, gWorker->scratch.interaction_id)) gInterruptPending = false;
        }
      }
      for (unsigned n = 0; n < kReportSlots; ++n) {
        bool report;
        {
          Lock lock;
          report = gReportCount != 0;
          if (report) {
            gWorker->report = gReports[gReportRead];
          }
        }
        if (!report) break;
        if (!sendAudioReport(gWorker->report)) break;
        { Lock lock;
          gReportRead = (gReportRead + 1) % kReportSlots;
          --gReportCount;
        }
      }
    }
    bool authorizeNow = false;
    {
      Lock lock;
      if (wifiConnected && gAuthPending && *gConfig->server) {
        copy(gWorker->code, gAuthCode);
        memset(gAuthCode, 0, sizeof(gAuthCode));
        gAuthPending = false;
        gStatus.authorizing = true;
        gWorker->config = *gConfig;
        authorizeNow = true;
      }
    }
    if (authorizeNow) authorizeHttp();
    bool uploadNow = false;
    {
      Lock lock;
      if (gPending.samples && (gStatus.ready || gPending.generation != gStatus.generation || !gStatus.agent_allowed)) {
        gWorker->upload = gPending;
        gPending = {};
        gWorker->config = *gConfig;
        gStatus.uploading = true;
        uploadNow = true;
      }
    }
    if (uploadNow) {
      bool current;
      { Lock lock; current = gStatus.generation == gWorker->upload.generation; }
      if (current) {
        Event& event = gWorker->scratch;
        clearEvent(event);
        event.type = EventType::Phase;
        event.generation = gWorker->upload.generation;
        copy(event.phase, "recognizing");
        copy(event.interaction_id, gWorker->upload.interaction_id);
        pushEvent(event);
      }
      uploadHttp();
    }
    serviceConversationChange();
    vTaskDelay(pdMS_TO_TICKS(5));
  }
}
} // namespace

bool begin() {
  if (gTask) return true;
  if (!gMutex) gMutex = xSemaphoreCreateMutex();
  if (!gMutex) return false;
  if (!gConfig) { void* p = heap_caps_malloc(sizeof(Config), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT); if (p) gConfig = new (p) Config{}; }
  if (!gWorker) { void* p = heap_caps_malloc(sizeof(WorkerData), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT); if (p) gWorker = new (p) WorkerData{}; }
  if (!gEvents) {
    gEvents = static_cast<Event*>(heap_caps_malloc(kEventSlots * sizeof(Event), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (gEvents) for (size_t i = 0; i < kEventSlots; ++i) new (gEvents + i) Event{};
  }
  if (!gReports) {
    gReports = static_cast<voice_audio::Event*>(heap_caps_malloc(kReportSlots * sizeof(voice_audio::Event), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (gReports) for (size_t i = 0; i < kReportSlots; ++i) new (gReports + i) voice_audio::Event{};
  }
  if (!gConfig || !gWorker || !gEvents || !gReports) { error("Studio link requires available PSRAM"); return false; }
  if (!gWifiEventRegistered) {
    WiFi.onEvent(wifiEvent, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
    gWifiEventRegistered = true;
  }
  {
    Lock lock;
    Preferences prefs;
    uint64_t chatRevision = 0;
    if (prefs.begin("pulse_net", true)) {
      copy(gConfig->ssid, prefs.getString("ssid", "").c_str());
      copy(gConfig->password, prefs.getString("pass", "").c_str());
      copy(gConfig->server, prefs.getString("server", "").c_str());
      copy(gConfig->profile, prefs.getString("profile", "default").c_str());
      copy(gConfig->runtime, prefs.getString("runtime", "hermes").c_str());
      copy(gConfig->bearer, prefs.getString("jwt", "").c_str());
      gSavedAgentConsent = prefs.getBool("agent_ok", false);
      if (prefs.isKey("chat_rev") && prefs.getType("chat_rev") != PT_U64) {
        prefs.end();
        copy(gStatus.error, "Conversation revision storage has an invalid type"); ++gStatus.errors;
        return false;
      }
      chatRevision = prefs.getULong64("chat_rev", 0);
      prefs.end();
    } else { copy(gConfig->profile, "default"); copy(gConfig->runtime, "hermes"); }
    Origin origin;
    if (!parseOrigin(gConfig->server, origin)) { gConfig->server[0] = 0; gConfig->bearer[0] = 0; }
    else copy(gConfig->server, origin.text);
    if (!validProfile(gConfig->profile)) copy(gConfig->profile, "default");
    if (strcmp(gConfig->runtime, "hermes") && strcmp(gConfig->runtime, "ekko")) copy(gConfig->runtime, "hermes");
    snprintf(gStatus.device_id, sizeof(gStatus.device_id), "pulse-%012llx", static_cast<unsigned long long>(ESP.getEfuseMac()));
    if (!gConfig->identity.initialize(gStatus.device_id, chatRevision)) {
      copy(gStatus.error, "Stored conversation identity exceeds protocol limits"); ++gStatus.errors;
      return false;
    }
    copy(gStatus.conversation_id, gConfig->identity.conversationId());
    gBootId = esp_random();
    gConfig->revision = 1;
    copy(gStatus.server, gConfig->server);
    copy(gStatus.profile, gConfig->profile);
    copy(gStatus.agent_runtime, gConfig->runtime);
    gStatus.wifi_configured = *gConfig->ssid;
    gStatus.endpoint_configured = *gConfig->server;
    gStatus.authenticated = *gConfig->bearer;
    // 只有在已授权（有设备凭据）且之前由用户明确开启过时才恢复
    gStatus.agent_allowed = gSavedAgentConsent && gStatus.authenticated && gStatus.endpoint_configured;
    gWifiDirty = gSocketDirty = true;
  }
  if (xTaskCreatePinnedToCore(task, "studio_link", 6144, nullptr, 1, &gTask, 0) != pdPASS) {
    gTask = nullptr;
    error("Studio task allocation failed");
    return false;
  }
  { Lock lock; gStatus.running = true; }
  return true;
}

void update() {}
Status status() { Lock lock; return gStatus; }

bool configureWifi(const char* ssid, const char* password) {
  if (!gConfig || !ssid || !*ssid || strlen(ssid) > 32 || !password || strlen(password) > 64) return false;
  interrupt();
  Lock lock;
  copy(gConfig->ssid, ssid);
  copy(gConfig->password, password);
  ++gConfig->revision;
  gStatus.wifi_configured = true;
  gStatus.wifi_connected = false;
  gStatus.wifi_state = static_cast<int>(WL_IDLE_STATUS);
  gStatus.last_disconnect_reason = 0;
  gWifiAttemptReason = 0;
  gLastDisconnectReason.store(0, std::memory_order_relaxed);
  gNamespaceReady = false;
  refreshReadyLocked();
  gStatus.ip[0] = 0;
  if (*gLastWifiError && !strcmp(gStatus.error, gLastWifiError)) gStatus.error[0] = 0;
  gLastWifiError[0] = 0;
  gWifiDirty = true;
  persistConfigLocked(true, false, false);
  return true;
}
bool configureEndpoint(const char* url, const char* profile) {
  if (!gConfig || !validProfile(profile)) return false;
  Origin origin;
  if (!parseOrigin(url, origin)) { error("Use an HTTP LAN origin without a path"); return false; }
  interrupt();
  Lock lock;
  const bool changed = strcmp(gConfig->server, origin.text) || strcmp(gConfig->profile, profile);
  if (strcmp(gConfig->server, origin.text)) {
    memset(gConfig->bearer, 0, sizeof(gConfig->bearer));
    gStatus.authenticated = false;
  }
  copy(gConfig->server, origin.text);
  copy(gConfig->profile, profile);
  copy(gStatus.server, origin.text);
  copy(gStatus.profile, profile);
  ++gConfig->revision;
  gStatus.endpoint_configured = true;
  if (changed) { gStatus.agent_allowed = false; persistAgentConsentLocked(false); }
  gNamespaceReady = false;
  refreshReadyLocked();
  gSocketDirty = true;
  persistConfigLocked(false, true, true);
  return true;
}
bool authorize(const char* code) {
  if (!gConfig || !code || !*code || strlen(code) >= sizeof(gAuthCode)) return false;
  for (const unsigned char* p = reinterpret_cast<const unsigned char*>(code); *p; ++p) if (*p <= 0x20 || *p >= 0x7f) return false;
  Lock lock;
  if (!gStatus.endpoint_configured || gStatus.authorizing || gAuthPending) return false;
  copy(gAuthCode, code);
  gAuthPending = true;
  return true;
}
bool configureRuntime(const char* runtime) {
  if (!gConfig || !runtime || (strcmp(runtime, "hermes") && strcmp(runtime, "ekko"))) return false;
  {
    Lock lock;
    if (!strcmp(runtime, gConfig->runtime)) return true;
  }
  interrupt();
  Lock lock;
  copy(gConfig->runtime, runtime);
  copy(gStatus.agent_runtime, runtime);
  ++gConfig->revision;
  gStatus.agent_allowed = false;
  persistAgentConsentLocked(false);
  gNamespaceReady = false;
  refreshReadyLocked();
  gSocketDirty = true;
  persistConfigLocked(false, true, false);
  return true;
}
void clearAuthorization() {
  if (!gConfig) return;
  interrupt();
  Lock lock;
  memset(gConfig->bearer, 0, sizeof(gConfig->bearer));
  memset(gAuthCode, 0, sizeof(gAuthCode));
  gAuthPending = false;
  ++gConfig->revision;
  gStatus.authenticated = false;
  gStatus.agent_allowed = false;
  persistAgentConsentLocked(false);
  gNamespaceReady = false;
  refreshReadyLocked();
  gSocketDirty = true;
  persistConfigLocked(false, false, true);
}
void setAgentAllowed(bool allowed) {
  bool stop;
  {
    Lock lock;
    stop = gStatus.agent_allowed && !allowed;
    const bool changed = gStatus.agent_allowed != allowed;
    gStatus.agent_allowed = allowed;
    if (changed) persistAgentConsentLocked(allowed);
  }
  if (stop) interrupt();
}
bool takeEvent(Event& out) {
  Lock lock;
  while (gEventCount) {
    out = gEvents[gEventRead];
    gEventRead = (gEventRead + 1) % kEventSlots;
    --gEventCount;
    if (out.generation == gStatus.generation) return true;
  }
  return false;
}
bool submit(voice_audio::Utterance& utterance) {
  if (!utterance.samples || !utterance.count || utterance.count > voice_audio::kMaximumUtteranceSamples || utterance.sample_rate != 16000) return false;
  Lock lock;
  if (!gTask || !gStatus.ready || !gStatus.agent_allowed || gPending.samples || gStatus.uploading || gTurnActive ||
      (utterance.generation && utterance.generation != gStatus.generation)) return false;
  if (gTurnSequence == UINT32_MAX ||
      !gConfig->identity.interactionId(gBootId, gTurnSequence + 1, gActiveId, sizeof(gActiveId))) return false;
  ++gTurnSequence;
  ++gStatus.generation;
  if (!gStatus.generation) ++gStatus.generation;
  gPending.samples = utterance.samples;
  gPending.count = utterance.count;
  gPending.sample_rate = utterance.sample_rate;
  gPending.generation = gStatus.generation;
  copy(gPending.interaction_id, gActiveId);
  gTurnActive = true;
  utterance.samples = nullptr;
  utterance.count = 0;
  utterance.generation = gStatus.generation;
  return true;
}
uint32_t interrupt() {
  Lock lock;
  return interruptLocked();
}
bool newConversation() {
  Lock lock;
  if (!gConfig || !gTask || gConversationChange.active()) return false;
  interruptLocked();
  gConversationChange.request(millis(), gConfig->revision);
  gStatus.conversation_changing = true;
  refreshReadyLocked();
  return true;
}
void reportAudioEvent(const voice_audio::Event& event) {
  Lock lock;
  if (!gReports || !*event.segment_id || !gConfig || !gConfig->identity.ownsInteraction(event.interaction_id)) return;
  if (gReportCount == kReportSlots) {
    copy(gStatus.error, "Audio report queue full");
    ++gStatus.errors;
    return;
  }
  gReports[(gReportRead + gReportCount++) % kReportSlots] = event;
}
bool getBearer(char* out, size_t capacity) {
  if (!out || !capacity) return false;
  out[0] = 0;
  Lock lock;
  if (!gConfig || !*gConfig->bearer || strlen(gConfig->bearer) >= capacity) return false;
  strlcpy(out, gConfig->bearer, capacity);
  return true;
}
bool resolveAudioUrl(const char* url, char* out, size_t capacity) {
  char server[256];
  { Lock lock; if (!gConfig) return false; copy(server, gConfig->server); }
  return audioUrlFor(url, server, out, capacity);
}

} // namespace studiolink
