#include "voice_portal.h"
#include "config.h"
#if PULSE_STUDIO_VOICE
#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <esp_system.h>
#include <esp_heap_caps.h>
#include <mbedtls/base64.h>
#include <lwip/sockets.h>
#include <errno.h>
#include <freertos/task.h>
#include "conversation.h"
#include "expression_protocol.h"
#include "face_camera.h"
#include "motion.h"
#include "pulse_engine.h"
#include "studio_link.h"
#include "sfx.h"
#include "scene_wire.h"
#include "voice_audio.h"
#include "care.h"

namespace voiceportal {
namespace {
class PortalServer : public WebServer {
 public:
  PortalServer() : WebServer(80) {}
  bool listening() { return (bool)_server; }
  WiFiClient detachClient() {
    WiFiClient client = _currentClient;
    _currentClient = WiFiClient();
    return client;
  }
};
PortalServer server;
WiFiClient faceReplyClient;
char* faceReply = nullptr;  // Bounded PSRAM-only HTTP response, never logged.
constexpr size_t kFaceReplyCapacity = 8192, kFaceHeaderReserve = facecam::kGray8HeaderReserve;
constexpr size_t kFaceMetadataScratch = 2048;
size_t faceReplySize = 0, faceReplyOffset = 0;
uint32_t faceReplyDeadline = 0;
WiFiClient sceneReplyClient;
char* sceneReply = nullptr;
size_t sceneReplySize = 0, sceneReplyOffset = 0;
uint32_t sceneReplyDeadline = 0, sceneRequestId = 0, sceneRequestGeneration = 0;
char sceneConversationId[64] = {};
Hooks callbacks;
char apSsid[24], apPass[17], pin[7], controlToken[65], bootId[17];
bool opened = false, initialized = false, hotspotActive = false;
uint32_t setupUntil = 0, pinBlockedUntil = 0;
uint8_t pinFailures = 0;
uint32_t stationAddress = 0;
StaticJsonDocument<5120> document;  // 2.9：多了 play 一节

const char page[] PROGMEM = R"HTML(<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pulse · 连接与语音测试</title><style>
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#ece6d9;color:#202f32;font:16px/1.65 'Songti SC','Noto Serif CJK SC',Georgia,serif}main{max-width:680px;margin:auto;padding:32px 22px}small{letter-spacing:.15em;color:#875023}h1{font-size:36px;line-height:1.2;margin:12px 0}section{border-top:2px solid #253b3d;padding:22px 0}label{display:block;margin:12px 0}input,button{font:inherit;border:1px solid #698082;padding:11px 12px;border-radius:3px;width:100%;background:#fffaf0;color:#202f32}button{background:#294749;color:#fffaf0;cursor:pointer;margin-top:12px}button.secondary{background:#dba858;color:#202f32}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 'Courier New',monospace}#result{border-left:4px solid #bd7b27;padding-left:12px}p{margin:10px 0}.hint{font-size:14px;color:#536665}</style><main><small>PULSE / STACKCHAN</small><h1>让声音接上对话。</h1><p>连接 Wi-Fi，再授权这台机器人使用你的 Studio。</p><section><label>屏幕上的六位配置 PIN<input id="pin" inputmode="numeric" maxlength="6" autocomplete="off"></label><button onclick="refresh()">查看设备状态</button><pre id="status">先填写设备屏幕上的 PIN。</pre></section><section><h2>01 · 连接网络</h2><label>2.4 GHz Wi-Fi 名称<input id="ssid" maxlength="32" autocomplete="off"></label><label>Wi-Fi 密码<input id="password" type="password" maxlength="63" autocomplete="new-password"></label><button onclick="saveWifi()">保存并连接</button><p class="hint">若连不上，配置热点会保持可用。不要在聊天中发送密码。</p></section><section><h2>02 · 连接 Studio</h2><label>Studio 地址<input id="endpoint" placeholder="http://电脑的局域网IP:8748" maxlength="220"></label><label>机器人 Profile<input id="profile" value="stackchan" maxlength="63"></label><button onclick="call('/api/setup/studio',{server:val('endpoint'),profile:val('profile')})">保存 Studio 地址</button><label>一次性设备授权码或授权二维码内容<input id="code" autocomplete="off" maxlength="2048"></label><button onclick="authorize()">授权这台设备</button><p class="hint">在 Studio 的「设备互联 → App 连接」生成一次性局域网授权。这里不需要 Studio 主密码或语音服务密钥。</p></section><section><h2>03 · 语音测试</h2><p>本版使用触摸唤醒、自动断句，单句最多 20 秒；回复播放期间暂停采音。一会儿没说话、说「再见」或连着两次没听清会自动结束（设备设置里可关）。尚不包含唤醒词和播报中语音打断。</p><label><input id="allow" type="checkbox" style="width:auto">已将机器人 Profile 限定为允许的表情和动作工具</label><button onclick="enableVoice()">启用此轮语音测试</button><button class="secondary" onclick="call('/api/voice/stop',{})">停止并关闭监听</button><p class="hint">启用后也可以点设备右上角「对话」唤醒，再点可停止。</p></section><p id="result" role="status">等待配置。</p></main><script>
const val=id=>document.getElementById(id).value;function key(){return val('pin').trim()}async function request(path,body){const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Pulse-Setup':key()},body:body===undefined?undefined:JSON.stringify(body)});let j;try{j=await r.json()}catch{throw Error('设备没有返回有效结果')}if(!r.ok||j.ok===false)throw Error(j.error||j.reason||('请求失败 '+r.status));return j}async function call(path,body){try{const j=await request(path,body);document.getElementById('result').textContent=j.message||'请求已接收，请查看实际连接状态。';await refresh();return j}catch(e){document.getElementById('result').textContent=e.message}}async function refresh(){try{const j=await request('/api/status');document.getElementById('status').textContent=JSON.stringify(j,null,2);if(j.server&&!val('endpoint'))document.getElementById('endpoint').value=j.server;if(j.profile)document.getElementById('profile').value=j.profile}catch(e){document.getElementById('result').textContent=e.message}}async function saveWifi(){const p=val('password');await call('/api/setup/wifi',{ssid:val('ssid'),password:p});document.getElementById('password').value=''}async function authorize(){let code=val('code').trim();try{const j=JSON.parse(code);code=j.authorization_code||j.authorizationCode||j.code||code}catch{}try{const u=new URL(code);code=u.searchParams.get('authorization_code')||u.searchParams.get('authorizationCode')||code}catch{}await call('/api/setup/authorize',{code});document.getElementById('code').value=''}async function enableVoice(){if(!document.getElementById('allow').checked){document.getElementById('result').textContent='请先确认 Profile 的工具范围。';return}await call('/api/setup/agent',{enabled:true});await call('/api/voice/wake',{})}
</script></html>)HTML";

void randomHex(char* out, size_t bytes) {
  static const char digits[] = "0123456789abcdef";
  for (size_t i=0;i<bytes;++i) { uint8_t b=(uint8_t)esp_random();out[i*2]=digits[b>>4];out[i*2+1]=digits[b&15]; }
  out[bytes*2]=0;
}
void sendJson(int code) { String body; serializeJson(document,body);server.send(code,"application/json; charset=utf-8",body); }
void fail(int code,const char* reason) { document.clear();document["ok"]=false;document["error"]=reason;sendJson(code); }
void accepted(const char* message="请求已接收；连接结果请查看设备状态。") { document.clear();document["ok"]=true;document["message"]=message;sendJson(202); }
bool setupAuth() {
  const uint32_t now=millis();
  if ((int32_t)(now-pinBlockedUntil)<0) {fail(429,"请稍后重试 PIN");return false;}
  const String provided=server.header("X-Pulse-Setup");
  if (!opened || (int32_t)(setupUntil-now)<=0 || provided!=pin) {
    if(++pinFailures>=5){pinBlockedUntil=now+30000;pinFailures=0;}
    fail(403,"配置 PIN 无效或配置窗口已关闭");return false;
  }
  pinFailures=0;return true;
}
bool controlAuth() {
  const String auth=server.header("Authorization");
  if(auth.length()!=strlen(controlToken)+7 || !auth.startsWith("Bearer "))return false;
  unsigned difference=0;for(size_t i=0;i<strlen(controlToken);++i)difference|=(unsigned)(auth[i+7]^controlToken[i]);
  return difference==0;
}
bool parseBody() {
  if(server.arg("plain").length()>2500){fail(413,"请求过长");return false;}
  document.clear();if(deserializeJson(document,server.arg("plain")) || !document.is<JsonObject>()){fail(400,"JSON 格式不正确");return false;}return true;
}

void clearFaceReply() {
  faceReplyClient.stop();
  if (faceReply) memset(faceReply, 0, kFaceReplyCapacity);
  faceReplySize = faceReplyOffset = 0;
}

void pumpFaceReply() {
  if (!faceReplySize) return;
  if ((int32_t)(millis() - faceReplyDeadline) >= 0 || faceReplyClient.fd() < 0) {
    clearFaceReply(); return;
  }
  // WiFiClient::write can wait seconds for a slow reader. The sample endpoint
  // instead owns this detached connection and uses bounded nonblocking sends.
  const uint32_t started = micros();
  for (unsigned i = 0; i < 4 && micros() - started < 1500; ++i) {
    size_t count = faceReplySize - faceReplyOffset;
    // A complete binary reply fits the 5760-byte TCP send buffer. Queue that
    // bounded reply in one nonblocking send rather than several small writes
    // that each consume extra TCP segments. Legacy larger JSON stays bounded.
    if (count > facecam::kGray8WireMaximum) count = 2048;
    const int sent = ::send(faceReplyClient.fd(), faceReply + faceReplyOffset, count, MSG_DONTWAIT);
    if (sent > 0) {
      faceReplyOffset += (size_t)sent;
      if (faceReplyOffset == faceReplySize) { clearFaceReply(); return; }
    } else {
      if (sent < 0 && (errno == EWOULDBLOCK || errno == EAGAIN || errno == EINTR)) return;
      clearFaceReply(); return;
    }
  }
}

bool sendFaceReply(int code, const facecam::FaceSample& sample, bool pending, bool binary = false) {
  if (!faceReply)
    faceReply = static_cast<char*>(heap_caps_calloc(1, kFaceReplyCapacity, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!faceReply || faceReplySize) return false;
  document.clear();
  document["ok"] = true;
  document["status"] = pending ? "pending" : (sample.valid ? "ready" : sample.reason);
  document["pending"] = pending; document["valid"] = !pending && sample.valid;
  document["reason"] = sample.reason; document["requestId"] = sample.request_id;
  document["bootId"] = bootId; document["trackId"] = sample.track_id;
  document["trackerId"] = sample.tracker_id; document["frameId"] = sample.frame_id;
  document["capturedMs"] = sample.captured_ms; document["ageMs"] = sample.age_ms;
  document["width"] = sample.jpeg ? 112 : facecam::kSampleSide;
  document["height"] = sample.jpeg ? 112 : facecam::kSampleSide;
  document["encoding"] = sample.jpeg ? "jpeg-base64" : "gray8-base64";
  document["mirrored"] = false;
  if (sample.jpeg && sample.valid) {
    auto landmarks = document.createNestedArray("landmarks");
    for (size_t i = 0; i < 10; ++i) landmarks.add(sample.landmarks[i]);
  }
  document["locked"] = sample.locked; document["tracking"] = sample.tracking;
  document["ambiguous"] = sample.ambiguous; document["faces"] = sample.faces;
  document["multipleFaces"] = sample.faces > 1;
  if (pending) document["retryAfterMs"] = 100;
  auto box = document.createNestedObject("box");
  box["x1"] = sample.box.x1; box["y1"] = sample.box.y1;
  box["x2"] = sample.box.x2; box["y2"] = sample.box.y2; box["score"] = sample.box.score;
  char* const body = faceReply + kFaceHeaderReserve;
  const size_t capacity = kFaceReplyCapacity - kFaceHeaderReserve;
  size_t size = serializeJson(document, body, capacity);
  if (!size || size >= capacity || document.overflowed()) return false;
  if (binary && !pending && sample.valid) {
    if (!sample.pixels) return false;
    // This scratch is at the far end of the existing PSRAM response, beyond
    // both the metadata source and the maximum 5632-byte binary packet.
    auto* encodedMetadata = reinterpret_cast<unsigned char*>(faceReply + kFaceReplyCapacity - kFaceMetadataScratch);
    size_t encoded = 0;
    if (mbedtls_base64_encode(encodedMetadata, kFaceMetadataScratch, &encoded,
                              reinterpret_cast<const unsigned char*>(body), size)) return false;
    const bool packed = sample.jpeg
        ? facecam::sampling::packJpegResponse(reinterpret_cast<const char*>(encodedMetadata), encoded,
              sample.pixels, sample.pixel_bytes, faceReply, kFaceReplyCapacity, faceReplySize)
        : facecam::sampling::packGray8Response(reinterpret_cast<const char*>(encodedMetadata), encoded,
              sample.pixels, facecam::kSampleBytes, faceReply, kFaceReplyCapacity, faceReplySize);
    if (!packed) return false;
  } else {
    if (!pending && sample.valid) {
      if (!sample.pixels || body[size - 1] != '}') return false;
      static const char prefix[] = ",\"pixels\":\"";
      --size;
      memcpy(body + size, prefix, sizeof(prefix) - 1); size += sizeof(prefix) - 1;
      size_t encoded = 0;
      if (mbedtls_base64_encode(reinterpret_cast<unsigned char*>(body + size), capacity - size - 3,
                                &encoded, sample.pixels, sample.jpeg ? sample.pixel_bytes : facecam::kSampleBytes)) return false;
      size += encoded;
      memcpy(body + size, "\"}", 2); size += 2;
    }
    const int header = snprintf(faceReply, kFaceHeaderReserve,
      "HTTP/1.1 %d %s\r\nContent-Type: application/json; charset=utf-8\r\n"
      "Content-Length: %u\r\nCache-Control: no-store, private, max-age=0\r\n"
      "Pragma: no-cache\r\nConnection: close\r\n\r\n",
      code, code == 202 ? "Accepted" : "OK", (unsigned)size);
    if (header <= 0 || (size_t)header >= kFaceHeaderReserve) return false;
    memmove(faceReply + header, body, size);
    faceReplySize = header + size;
  }
  faceReplyOffset = 0;
  faceReplyDeadline = !pending && sample.valid ? sample.captured_ms + 450 : millis() + 1000;
  faceReplyClient = server.detachClient();
  pumpFaceReply();  // Do not wait one display frame before the first socket send.
  return true;
}

void faceSample() {
  if (!controlAuth()) { fail(403, "需要设备控制凭据"); return; }
  if (faceReplySize) { fail(409, "face_sample_response_busy"); return; }
  facecam::FaceSample sample;
  facecam::SampleState state;
  const uint32_t now = millis();
  if (server.method() == HTTP_POST) {
    bool jpeg = false;
    const String body = server.arg("plain");
    if (body.length() && body != "null") {
      if (body.length() > 128) { fail(413, "face_sample_request_too_large"); return; }
      document.clear();
      if (deserializeJson(document, body) || !document.is<JsonObject>() ||
          document.size() != 1 || !document["format"].is<const char*>()) {
        fail(400, "invalid_face_sample_format"); return;
      }
      const char* format = document["format"];
      if (!strcmp(format, "jpeg112")) jpeg = true;
      else if (strcmp(format, "gray8")) { fail(400, "invalid_face_sample_format"); return; }
    }
    state = facecam::requestSample(sample, now, jpeg);
    if (state == facecam::SampleState::Busy) { fail(409, "face_sample_busy"); return; }
    if (state == facecam::SampleState::Ready)
      state = facecam::takeSample(sample.request_id, sample, now);
  } else {
    const String id = server.arg("requestId");
    uint32_t value = 0;
    if (!id.length() || id.length() > 10) { fail(400, "invalid_request_id"); return; }
    for (size_t i = 0; i < id.length(); ++i) {
      if (id[i] < '0' || id[i] > '9' || value > (UINT32_MAX - (id[i] - '0')) / 10) {
        fail(400, "invalid_request_id"); return;
      }
      value = value * 10 + id[i] - '0';
    }
    state = facecam::takeSample(value, sample, now);
    if (state == facecam::SampleState::Missing) { fail(404, "face_sample_not_found"); return; }
  }
  const bool pending = state == facecam::SampleState::Pending;
  const bool binary = server.method() == HTTP_GET && server.header("Accept").equalsIgnoreCase(
      sample.jpeg ? "image/jpeg" : "application/vnd.pulse.gray8");
  const bool sent = sendFaceReply(pending ? 202 : 200, sample, pending, binary);
  if (!pending) facecam::releaseSample();
  if (!sent) {
    if (faceReply) memset(faceReply, 0, kFaceReplyCapacity);
    fail(503, "face_sample_response_unavailable");
  }
}

void clearSceneReply() {
  sceneReplyClient.stop();
  if (sceneReply) memset(sceneReply, 0, scene_wire::kWireCapacity);
  sceneReplySize = sceneReplyOffset = 0;
}
bool sceneBindingCurrent() {
  const auto net = studiolink::status();
  return !net.conversation_changing && net.generation == sceneRequestGeneration &&
         !strcmp(net.conversation_id, sceneConversationId);
}
void pumpSceneReply() {
  if (!sceneReplySize) return;
  if (!sceneBindingCurrent() || (int32_t)(millis()-sceneReplyDeadline) >= 0 || sceneReplyClient.fd() < 0) {
    clearSceneReply(); return;
  }
  const uint32_t started = micros();
  for (unsigned i=0; i<4 && micros()-started<1500; ++i) {
    size_t count = sceneReplySize-sceneReplyOffset;
    if (count > 4096) count = 4096;
    const int sent = ::send(sceneReplyClient.fd(), sceneReply+sceneReplyOffset, count, MSG_DONTWAIT);
    if (sent > 0) {
      sceneReplyOffset += static_cast<size_t>(sent);
      if (sceneReplyOffset == sceneReplySize) { clearSceneReply(); return; }
    } else {
      if (sent < 0 && (errno == EWOULDBLOCK || errno == EAGAIN || errno == EINTR)) return;
      clearSceneReply(); return;
    }
  }
}
void sceneMetadata(const facecam::SceneFrame& frame, bool pending) {
  document.clear();document["ok"]=true;document["pending"]=pending;
  document["valid"]=!pending && frame.valid;
  document["status"]=pending?"pending":(frame.valid?"ready":frame.reason);
  document["reason"]=frame.reason;document["requestId"]=frame.request_id;
  document["bootId"]=bootId;document["conversationId"]=sceneConversationId;
  document["generation"]=sceneRequestGeneration;
  document["frameId"]=frame.frame_id;document["capturedMs"]=frame.captured_ms;
  document["ageMs"]=frame.age_ms;document["encodeMs"]=frame.encode_ms;
  document["width"]=frame.width;document["height"]=frame.height;
  document["encoding"]="jpeg";document["mirrored"]=false;document["rotation"]=0;
  if (pending) document["retryAfterMs"]=80;
}
bool sendSceneImage(const facecam::SceneFrame& frame) {
  if (!frame.valid || !frame.pixels || frame.pixel_bytes > scene_wire::kMaximumJpegBytes ||
      frame.age_ms >= facecam::kSceneMaximumAgeMs || !sceneBindingCurrent()) return false;
  if (!sceneReply) sceneReply = static_cast<char*>(heap_caps_calloc(
      1, scene_wire::kWireCapacity, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!sceneReply) return false;
  sceneMetadata(frame, false);
  char metadata[768];
  unsigned char encoded[1025];
  const size_t bytes = serializeJson(document, metadata, sizeof(metadata));
  size_t encodedBytes = 0;
  if (document.overflowed() || !bytes || bytes >= sizeof(metadata) ||
      mbedtls_base64_encode(encoded, sizeof(encoded), &encodedBytes,
          reinterpret_cast<const unsigned char*>(metadata), bytes) != 0 ||
      !scene_wire::pack(reinterpret_cast<const char*>(encoded), encodedBytes,
          frame.pixels, frame.pixel_bytes, sceneReply, scene_wire::kWireCapacity, sceneReplySize)) return false;
  sceneReplyOffset = 0;
  sceneReplyDeadline = frame.captured_ms+facecam::kSceneMaximumAgeMs;
  sceneReplyClient = server.detachClient();
  return true;
}
bool sceneRequestNumber(uint32_t& value) {
  if (server.args() != 1 || server.argName(0) != "requestId") return false;
  const String id = server.arg("requestId");
  if (!id.length() || id.length()>10) return false;
  value = 0;
  for (size_t i=0; i<id.length(); ++i) {
    if (id[i]<'0' || id[i]>'9' || value>(UINT32_MAX-(id[i]-'0'))/10) return false;
    value = value*10+id[i]-'0';
  }
  return value != 0;
}
void sceneFrame() {
  if (!controlAuth()) { fail(403, "需要设备控制凭据"); return; }
  if (sceneReplySize || faceReplySize) { fail(409, "camera_response_busy"); return; }
  facecam::SceneFrame frame;
  facecam::SceneState state;
  const uint32_t now = millis();
  if (server.method() == HTTP_POST) {
    if (server.args()>1 || (server.args()==1 && server.argName(0)!="plain")) {
      fail(400, "invalid_camera_request"); return;
    }
    const String body = server.arg("plain");
    if (body.length()>32) { fail(413, "camera_request_too_large"); return; }
    if (body.length() && body != "null") {
      document.clear();
      if (deserializeJson(document, body) || !document.is<JsonObject>() || document.size()) {
        fail(400, "invalid_camera_request"); return;
      }
    }
    const auto net = studiolink::status();
    if (net.conversation_changing) { fail(409, "conversation_changing"); return; }
    state = facecam::requestSceneFrame(frame, now);
    if (state == facecam::SceneState::Busy) { fail(409, "camera_capture_busy"); return; }
    strlcpy(sceneConversationId, net.conversation_id, sizeof(sceneConversationId));
    sceneRequestGeneration = net.generation;
    sceneRequestId = frame.request_id;
  } else {
    uint32_t requested = 0;
    if (!sceneRequestNumber(requested)) { fail(400, "invalid_request_id"); return; }
    if (requested != sceneRequestId) { fail(404, "camera_frame_not_found"); return; }
    if (!sceneBindingCurrent()) {
      facecam::cancelSceneFrame();sceneRequestId=0;
      fail(409, "camera_conversation_changed"); return;
    }
    if (!server.header("Accept").equalsIgnoreCase("image/jpeg")) {
      fail(406, "camera_requires_jpeg_accept"); return;
    }
    state = facecam::takeSceneFrame(requested, frame, now);
    if (state == facecam::SceneState::Missing) { fail(404, "camera_frame_not_found"); return; }
  }
  const bool pending = state == facecam::SceneState::Pending;
  if (state == facecam::SceneState::Busy) {fail(409,"camera_capture_busy");return;}
  if (pending || !frame.valid || server.method() == HTTP_POST) {
    // POST grants a request ID only; JPEG bytes are never embedded in JSON.
    sceneMetadata(frame, pending || state == facecam::SceneState::Ready);
    server.sendHeader("Cache-Control", "no-store, private, max-age=0");
    sendJson(pending || state == facecam::SceneState::Ready ? 202 : 200);
    if (!pending && state != facecam::SceneState::Ready) facecam::releaseSceneFrame();
    return;
  }
  const bool sent = sendSceneImage(frame);
  // The detached response owns a bounded copy; the worker crop is erased now.
  facecam::releaseSceneFrame();sceneRequestId=0;
  if (!sent) { clearSceneReply();fail(503, "camera_response_unavailable"); return; }
  pumpSceneReply();
}
void status() {
  if(!controlAuth() && !setupAuth())return;
  const auto net=studiolink::status();const auto audio=voice_audio::status();
  document.clear();document["ok"]=true;document["version"]=PULSE_VERSION;
  document["wifi_configured"]=net.wifi_configured;document["wifi_connected"]=net.wifi_connected;
  document["studio_authenticated"]=net.authenticated;document["studio_online"]=net.ready;
  document["agent_allowed"]=net.agent_allowed;document["server"]=net.server;document["profile"]=net.profile;
  document["agent_runtime"]=net.agent_runtime;document["bootId"]=bootId;document["active"]=conversation::active();
  document["portal_listening"]=server.listening();
  TaskHandle_t cameraTask=xTaskGetHandle("cam_task");
  document["cam_stack_bytes"]=cameraTask?(uint32_t)uxTaskGetStackHighWaterMark(cameraTask):0;
  const auto camera=facecam::status();
  document["face_worker"]=camera.running;document["face_frames"]=camera.frames;document["face_errors"]=camera.errors;
  document["face_stack_bytes"]=camera.worker_stack_bytes;document["heap_internal_free"]=ESP.getFreeHeap();
  document["face_jpeg_crops"]=camera.jpeg_crops;document["face_jpeg_ready"]=camera.jpeg_ready;
  document["face_jpeg_prepare_ms"]=camera.jpeg_prepare_ms;
  document["face_jpeg_crop_ms"]=camera.jpeg_crop_ms;
  document["face_jpeg_encode_ms"]=camera.jpeg_encode_ms;
  document["face_inference_ms"]=camera.inference_ms;
  document["face_frame_get_age_ms"]=camera.frame_get_age_ms;
  document["face_frame_inferred_age_ms"]=camera.frame_inferred_age_ms;
  document["face_frame_publish_age_ms"]=camera.frame_publish_age_ms;
  document["face_backlog_discards"]=camera.backlog_discards;
  document["face_backlog_limit_hits"]=camera.backlog_limit_hits;
  document["face_frame_get_failures"]=camera.frame_get_failures;
  document["face_frame_timestamp_errors"]=camera.frame_timestamp_errors;
  document["scene_errors"]=camera.scene_errors;
  document["scene_frame_id"]=camera.scene_frame_id;
  document["scene_encode_ms"]=camera.scene_encode_ms;
  if (callbacks.faceTracking) {
    const auto face = callbacks.faceTracking();
    auto tracking = document.createNestedObject("face_tracking");
    const bool fresh = face.frameId && face.ageMs<=450;
    const bool visible = face.enabled && face.camera && face.worker && face.faces>0 &&
                         face.locked && face.tracking && !face.ambiguous && fresh && face.lostMs<=450;
    tracking["enabled"]=face.enabled;tracking["camera"]=face.camera;tracking["worker"]=face.worker;
    tracking["faces"]=face.faces;tracking["locked"]=face.locked;tracking["tracking"]=face.tracking;
    tracking["ambiguous"]=face.ambiguous;tracking["targetId"]=face.targetId;tracking["frameId"]=face.frameId;
    tracking["capturedMs"]=face.capturedMs;tracking["ageMs"]=face.ageMs;tracking["lostMs"]=face.lostMs;
    tracking["fresh"]=fresh;tracking["targetVisible"]=visible;
    tracking["errorX"]=face.errorX;tracking["errorY"]=face.errorY;tracking["pan"]=face.pan;tracking["tilt"]=face.tilt;
    tracking["mirrored"]=false;tracking["rotation"]=0;
    tracking["position"]=!visible?"unknown":(face.errorX<-.12f?"image_left":(face.errorX>.12f?"image_right":"center"));
  }
  if (callbacks.touchInfo) {
    const auto touch = callbacks.touchInfo();
    JsonObject info = document.createNestedObject("touch_interaction");
    info["head_down"] = touch.headDown; info["screen_down"] = touch.screenDown;
    info["happy"] = touch.happy; info["boundary"] = touch.boundary;
    info["phrase_queued"] = touch.phraseQueued; info["phrase_started"] = touch.phraseStarted;
    info["phrase_done"] = touch.phraseDone; info["phrase_cancelled"] = touch.phraseCancelled;
    info["face_applied"] = touch.faceApplied; info["fx_only"] = touch.fxOnly;
  }
  document["auth_http_status"]=net.auth_http_status;document["socket_stage"]=net.socket_stage;
  document["ws_connected"]=net.ws_connected;document["namespace_acks"]=net.namespace_acks;
  document["ip"]=net.ip;document["deviceId"]=net.device_id;document["network_error"]=net.error;
  document["conversationId"]=net.conversation_id;document["conversation_changing"]=net.conversation_changing;document["backend_pending"]=net.backend_pending;
  document["new_chat_pending"]=callbacks.newChatPending && callbacks.newChatPending();
  document["voice_notice"]=callbacks.voiceNotice?callbacks.voiceNotice():"";
  document["mic_ready"]=audio.ready;document["listening"]=audio.listening;document["recording"]=audio.recording;
  document["playing"]=audio.playback_busy;document["rms"]=audio.rms;document["noise_rms"]=audio.noise_rms;
  document["captured_samples"]=audio.captured_samples;document["audio_error"]=audio.error;
  document["phase"]=conversation::phaseName(conversation::phase());document["turnId"]=conversation::turnId();
  document["generation"]=conversation::generation();document["statusText"]=conversation::statusText();
  document["visible_emotion"]=conversation::visibleEmotionId();document["action_id"]=conversation::actionId();
  document["rendered_emotion_id"]=callbacks.renderedEmotion?callbacks.renderedEmotion():"";
  document["speaker_active"]=callbacks.speakerActive && callbacks.speakerActive();
  const auto cues=conversation::expressionCues();const auto cueAudio=sfx::cueStatus();
  auto expressionCues=document.createNestedObject("expression_cues");
  expressionCues["action_pending"]=cues.action_pending;
  expressionCues["action_timing"]=cues.action_timing==conversation::ActionTiming::SpeechStart?"speech_start":"now";
  expressionCues["sound_pending"]=cues.sound_pending || (cues.sound_playing && cueAudio.state==sfx::CueState::Queued);
  expressionCues["sound_playing"]=cues.sound_playing && cueAudio.state==sfx::CueState::Playing;
  expressionCues["sound_settling"]=audio.external_cue_active && cues.sound_playing && cueAudio.state!=sfx::CueState::Playing && cueAudio.state!=sfx::CueState::Queued;
  expressionCues["sound_id"]=cues.sound_clip>0 && cues.sound_clip<sfx::C_COUNT?sfx::kClips[cues.sound_clip].name:"";
  expressionCues["sound_timing"]=cues.sound_timing==conversation::SoundTiming::WhenQuiet?"when_quiet":"after_speech";
  expressionCues["sound_state"]=cues.sound_state;expressionCues["external_audio_lease"]=audio.external_cue_active;
  expressionCues["local"]=cues.local;expressionCues["local_feedback"]=cues.local_feedback;
  if (callbacks.companionInfo) {
    auto info = callbacks.companionInfo();  // 非 const：local_time 是 char 数组，要复制进文档（info 出了这个块就没了）
    auto r2 = [](float v) { return (double)lroundf(v * 100.f) / 100.0; };
    JsonObject c = document.createNestedObject("companion");
    c["tone"] = info.tone; c["tone_name"] = info.toneName; c["life_phase"] = info.phase;
    c["valence"] = r2(info.valence); c["arousal"] = r2(info.arousal); c["energy"] = r2(info.energy); c["social"] = r2(info.social);
    c["bond_level"] = info.level; c["bond_name"] = info.levelName; c["bond_points"] = info.points; c["bond_progress"] = r2(info.progress);
    c["streak_days"] = info.streak; c["days_together"] = info.daysTogether; c["days_known"] = info.daysKnown;
    c["night"] = info.night; c["clock_valid"] = info.clockValid; c["local_time"] = info.localTime;
    if (info.lux >= 0.f) c["lux"] = r2(info.lux); else c["lux"] = nullptr;
    if (info.battery >= 0) c["battery"] = info.battery; else c["battery"] = nullptr;
    c["charging"] = info.charging;
    // 2.8：关心提醒 + 任务提醒（字符串都是固件里常驻的内存，按指针放进文档，不占文档空间）
    JsonObject k = document.createNestedObject("care");
    k["level"] = info.careLevel; k["here"] = info.careHere; k["sitting_min"] = info.sittingMin;
    k["presence_today_min"] = info.presenceTodayMin; k["reminders_today"] = info.remindersToday; k["acks_today"] = info.acksToday;
    k["last"] = info.careLast;
    if (info.careLastAgoS >= 0) k["last_ago_s"] = info.careLastAgoS; else k["last_ago_s"] = nullptr;
    k["awaiting"] = info.careAwaiting;
    JsonObject n = document.createNestedObject("notify");
    n["enabled"] = info.notifyEnabled; n["new"] = info.noticeNew; n["pending"] = info.noticePending;
    n["received"] = info.noticeReceived; n["acked"] = info.noticeAcked; n["duplicates"] = info.noticeDuplicates;
    n["dropped"] = info.noticeDropped; n["expired"] = info.noticeExpired;
    if (info.noticeKind[0]) {
      JsonObject q = n.createNestedObject("latest");
      q["kind"] = info.noticeKind; q["state"] = info.noticeState; q["title"] = info.noticeTitle;
      q["source"] = info.noticeSource; q["ago_s"] = info.noticeAgoS;
    } else {
      n["latest"] = nullptr;
    }
    // 2.9：一起玩（活跃度、正在玩什么、听歌跳舞、邀请、躲猫猫、心情打卡）
    JsonObject pl = document.createNestedObject("play");
    pl["lively"] = info.lively; pl["playing"] = info.playing; pl["groove"] = info.groove;
    pl["music_enabled"] = info.musicEnabled; pl["music_available"] = info.musicAvailable;
    pl["listening"] = info.listening; pl["music_now"] = info.musicNow;
    if (info.bpm > 0.f) pl["bpm"] = (int)lroundf(info.bpm); else pl["bpm"] = nullptr;
    pl["beat_confidence"] = r2(info.beatConfidence);
    if (info.musicAgoS >= 0) pl["music_ago_s"] = info.musicAgoS; else pl["music_ago_s"] = nullptr;
    pl["games"] = info.games; pl["game_wins"] = info.gameWins; pl["dances"] = info.dances;
    pl["music_dances"] = info.musicDances; pl["breaths"] = info.breaths; pl["micro"] = info.micro;
    pl["bids_offered"] = info.bidsOffered; pl["bids_accepted"] = info.bidsAccepted; pl["bids_ignored"] = info.bidsIgnored;
    pl["bids_today"] = info.bidsToday; pl["bid_acceptance"] = r2(info.bidAcceptance);
    pl["peek_rounds"] = info.peekRounds; pl["peek_found"] = info.peekFound;
    if (info.moodToday > 0) pl["mood_today"] = info.moodToday; else pl["mood_today"] = nullptr;
    pl["mood_entries_7d"] = info.moodEntries;
    if (info.moodEntries) pl["mood_average_7d"] = r2(info.moodAverage); else pl["mood_average_7d"] = nullptr;
    pl["mood_trend"] = info.moodTrend; pl["mood_total"] = info.moodTotal;
    pl["talk_auto_end"] = info.talkAuto;
  }
  document["voice_armed"]=callbacks.armed && callbacks.armed();document["halfDuplex"]=true;
  if(document.overflowed()){fail(503,"status_metadata_overflow");return;}
  sendJson(200);
}
void capabilities() {
  if(!controlAuth()){fail(403,"需要设备控制凭据");return;}
  // Stream bounded individual records instead of a full catalog JSON document.
  server.setContentLength(CONTENT_LENGTH_UNKNOWN);server.send(200,"application/json; charset=utf-8","");
  server.sendContent("{\"ok\":true,\"protocolVersion\":1,\"states\":[");
  for(int i=0;i<pulse::stateCount();++i){document.clear();document["id"]=pulse::stateDef(i).id;document["name"]=pulse::stateDef(i).name;String item;serializeJson(document,item);if(i)server.sendContent(",");server.sendContent(item);}
  server.sendContent("],\"actions\":[");
  for(int i=1;i<motion::A_COUNT;++i){document.clear();document["id"]=motion::actName(i);document["durationMs"]=(uint32_t)(motion::actDuration(i)*1000.f+.5f);String item;serializeJson(document,item);if(i>1)server.sendContent(",");server.sendContent(item);}
  server.sendContent("],\"clips\":[");
  for(int i=1;i<sfx::C_COUNT;++i){document.clear();document["id"]=sfx::kClips[i].name;document["name"]=sfx::kClips[i].name;document["samples"]=sfx::kClips[i].samples;document["sampleRate"]=sfx::kClipRate;document["durationMs"]=(sfx::kClips[i].samples*1000UL+sfx::kClipRate-1)/sfx::kClipRate;String item;serializeJson(document,item);if(i>1)server.sendContent(",");server.sendContent(item);}
  server.sendContent("],\"features\":{\"phase_anchored_expression\":true,\"face_sample_jpeg112\":true,\"scene_frame_jpeg\":true,\"face_tracking_status\":true,\"single_life_mode\":true,\"care_reminders\":true,\"task_notify\":true,\"lively_play\":true,\"mood_checkin\":true,\"music_dance\":true,\"talk_auto_end\":true},\"notify\":{\"path\":\"/api/notify\",\"kinds\":[\"task_done\",\"task_failed\",\"reminder\",\"praise\"],\"titleMaxBytes\":64,\"sourceMaxBytes\":24,\"idMaxBytes\":40,\"perMinute\":20,\"queue\":6},\"limits\":{\"intensityMin\":0,\"intensityMax\":1,\"durationMaxMs\":30000,\"soundGainMax\":0.6,\"sceneFrameMaxBytes\":65536,\"sceneFrameWidth\":320,\"sceneFrameHeight\":240,\"sceneFrameMaxAgeMs\":5000},\"voice\":{\"touchWake\":true,\"automaticEndpoint\":true,\"halfDuplex\":true,\"wakeWord\":false,\"bargeIn\":false}}");server.sendContent("");
}
void control() {
  if(!controlAuth()){fail(403,"需要设备控制凭据");return;}if(!parseBody())return;
  const char* method=document["method"]|"express";
  if(!strcmp(method,"stop")){if(callbacks.stop)callbacks.stop();accepted("已停止旧交互与监听。");return;}
  if(strcmp(method,"express")){fail(400,"不支持的方法");return;}
  if (document.containsKey("visualOnlyWhenListening")) {
    if (!document["visualOnlyWhenListening"].is<bool>()) { fail(400, "invalid_visual_guard"); return; }
    if (document["visualOnlyWhenListening"].as<bool>()) {
      const auto audio = voice_audio::status();
      if (!conversation::active() || conversation::phase() != conversation::Phase::Listening ||
          !callbacks.armed || !callbacks.armed() || !audio.listening || audio.recording) {
        fail(409, "visual_window_changed"); return;
      }
    }
  }
  const char* commandId=document["commandId"]|"";
  const char* requestedBoot=document["bootId"]|"";
  if(!commandId[0]||strlen(commandId)>64){fail(400,"缺少有效commandId");return;}
  if(strcmp(requestedBoot,bootId)){fail(409,"设备已重启，请重新查询状态");return;}
  const char* emotion=document["emotionId"]|static_cast<const char*>(nullptr);
  const char* action=document["actionId"]|static_cast<const char*>(nullptr);
  conversation::Command command;
  if(const char* error=expression_protocol::parseCues(document.as<JsonObjectConst>(),command)){fail(400,error);return;}
  bool validEmotion=!emotion;
  if(emotion)for(int i=0;i<pulse::stateCount();++i)if(!strcmp(emotion,pulse::stateDef(i).id))validEmotion=true;
  if((!emotion&&!action&&!command.soundClip)||!validEmotion||(action&&motion::findAct(action)<=0)){fail(400,"无效表情、动作或素材ID");return;}
  if ((emotion || action) && (!emotion || strcmp(emotion, "41")) && voice_audio::recording()) {
    fail(409, "recording_window_changed"); return;
  }
  const uint32_t now=millis();
  if(!conversation::active()){
    char turn[65];snprintf(turn,sizeof(turn),"tool-%08lx-%08lx",(unsigned long)now,(unsigned long)esp_random());
    const uint32_t generation=studiolink::interrupt();
    voice_audio::cancel(generation);
    const bool audioOnly=command.soundClip&&!emotion&&!action;
    if(!conversation::startTurn(turn,generation,now,false,audioOnly)){fail(409,"设备正在启动或维护");return;}
  }
  command.commandId=document["commandId"]|"";command.turnId=document["turnId"]|conversation::turnId();
  command.generation=document["generation"]|conversation::generation();
  const uint32_t ttl=document["ttlMs"]|5000u;
  if(ttl==0||ttl>30000){fail(400,"ttlMs 必须为1到30000");return;}
  command.expiresAtMs=now+ttl;command.emotionId=document["emotionId"]|static_cast<const char*>(nullptr);
  command.actionId=document["actionId"]|static_cast<const char*>(nullptr);
  if(document.containsKey("intensity") && !document["intensity"].is<float>()){fail(400,"intensity 必须为数值");return;}
  command.intensity=document["intensity"]|.7f;command.durationMs=document["durationMs"]|2500u;
  conversation::Ack ack;const bool ok=conversation::apply(command,ack,now);
  document.clear();document["ok"]=ok;document["commandId"]=ack.commandId;document["status"]=conversation::ackName(ack.status);document["reason"]=ack.reason;
  document["generation"]=ack.generation;sendJson(ok?200:409);
}
// 2.8：Ekko Studio（或任何本机脚本）送来「任务完成 / 失败 / 提醒 / 夸夸」。
// {"kind":"task_done","title":"周报写好了","source":"Ekko Studio","id":"run-42"}
// 202 queued / replaced，200 duplicate，400 参数不对，403 凭据不对，409 任务提醒关着，429 太频繁
static_assert(care::kTitleMax == 64 && care::kSourceMax == 24 && care::kIdMax == 40 && care::kRateMax == 20 && care::Inbox::kCap == 6,
              "/api/capabilities 里写的 notify 限制要和 care.h 一致");
bool optionalText(const char* key) {
  JsonVariantConst v = document[key];
  return v.isNull() || v.is<const char*>();
}
void notifyRoute() {
  if(!controlAuth()){fail(403,"需要设备控制凭据");return;}
  if(!parseBody())return;
  if(!callbacks.notify||!callbacks.notifyEnabled){fail(503,"notify_unavailable");return;}
  JsonVariantConst kindValue=document["kind"];
  const int kind=kindValue.is<const char*>()?care::parseNoticeKind(kindValue.as<const char*>()):-1;
  if(kind<0){fail(400,"invalid_kind");return;}
  if(!optionalText("title")||!optionalText("source")||!optionalText("id")){fail(400,"invalid_field_type");return;}
  const char* title=document["title"]|"";
  const char* source=document["source"]|"";
  const char* id=document["id"]|"";
  if(strlen(id)>care::kIdMax){fail(400,"invalid_id");return;}
  if(strlen(title)>512||strlen(source)>256){fail(400,"field_too_long");return;}
  if(!callbacks.notifyEnabled()){fail(409,"notify_disabled");return;}
  bool truncated=false;
  const uint8_t r=callbacks.notify((uint8_t)kind,title,source,id,&truncated);  // 文档里的字符串在 clear() 之前一直有效
  if(r==care::P_RATE){fail(429,"rate_limited");return;}
  if(r==care::P_INVALID){fail(callbacks.notifyEnabled()?400:409,callbacks.notifyEnabled()?"invalid_notice":"notify_disabled");return;}
  document.clear();document["ok"]=true;document["status"]=care::pushKey(r);document["kind"]=care::noticeKey((uint8_t)kind);
  document["truncated"]=truncated;
  if(callbacks.companionInfo){const auto info=callbacks.companionInfo();document["pending"]=info.noticePending;}
  sendJson(r==care::P_DUPLICATE?200:202);
}
bool configure(JsonObjectConst object) {
  if(callbacks.stop)callbacks.stop();
  if(object.containsKey("ssid") && !studiolink::configureWifi(object["ssid"]|"",object["password"]|""))return false;
  if(object.containsKey("server") && !studiolink::configureEndpoint(object["server"]|"",object["profile"]|"stackchan"))return false;
  if(object.containsKey("runtime") && !studiolink::configureRuntime(object["runtime"]|"hermes"))return false;
  if(object.containsKey("code") && !studiolink::authorize(object["code"]|""))return false;
  return true;
}
}

void openSetup(){
  if(!initialized)return;
  if(WiFi.status()!=WL_CONNECTED){
    WiFi.mode(WIFI_AP_STA);
    hotspotActive=WiFi.softAP(apSsid,apPass,1,false,2);
    opened=hotspotActive;
  }else opened=true;
  setupUntil=millis()+20*60*1000;pinFailures=0;
  if(WiFi.getMode()!=WIFI_OFF)server.begin();
}
bool begin(const Hooks& hooks) {
  callbacks=hooks;snprintf(apSsid,sizeof(apSsid),"Pulse-%06lX",(unsigned long)((ESP.getEfuseMac()>>24)&0xffffff));
  randomHex(bootId,8);
  randomHex(apPass,6);snprintf(pin,sizeof(pin),"%06lu",(unsigned long)(100000+esp_random()%900000));
  Preferences prefs;if(!prefs.begin("pulse_ctl",false))return false;
  const String saved=prefs.getString("token","");
  if(saved.length()==64)strlcpy(controlToken,saved.c_str(),sizeof(controlToken));
  else{randomHex(controlToken,32);prefs.putString("token",controlToken);}prefs.end();
  const char* headers[]={"Authorization","X-Pulse-Setup","Accept"};server.collectHeaders(headers,3);
  server.on("/",HTTP_GET,[]{server.send_P(200,"text/html; charset=utf-8",page);});
  server.on("/api/status",HTTP_GET,status);server.on("/api/capabilities",HTTP_GET,capabilities);server.on("/api/control",HTTP_POST,control);
  server.on("/api/notify",HTTP_POST,notifyRoute);
  server.on("/api/face/sample",HTTP_POST,faceSample);server.on("/api/face/sample",HTTP_GET,faceSample);
  server.on("/api/camera/frame",HTTP_POST,sceneFrame);server.on("/api/camera/frame",HTTP_GET,sceneFrame);
  for(const char* path:{"/api/setup/wifi","/api/setup/studio","/api/setup/authorize"})server.on(path,HTTP_POST,[]{if(!setupAuth()||!parseBody())return;if(!configure(document.as<JsonObjectConst>())){fail(400,"配置无效或设备暂忙");return;}accepted();});
  server.on("/api/setup/agent",HTTP_POST,[]{if(!setupAuth()||!parseBody())return;studiolink::setAgentAllowed(document["enabled"]|false);accepted();});
  server.on("/api/voice/wake",HTTP_POST,[]{if(!setupAuth())return;if(callbacks.wake&&callbacks.wake())accepted("语音已唤醒，请直接说话。");else fail(409,"语音尚未就绪，请检查Studio授权、Profile和麦克风状态");});
  server.on("/api/voice/stop",HTTP_POST,[]{if(!setupAuth())return;if(callbacks.stop)callbacks.stop();accepted("已停止并关闭监听。");});
  server.onNotFound([]{fail(404,"未找到接口");});
  // Arduino's TCP listener requires esp_netif/lwIP first, even before any SSID
  // has been configured. Starting the listener on WIFI_OFF asserts in lwIP.
  initialized=true;
  if(!studiolink::status().wifi_configured)openSetup();
  else if(WiFi.getMode()==WIFI_OFF && !WiFi.mode(WIFI_STA)){initialized=false;return false;}
  if(WiFi.getMode()==WIFI_OFF){initialized=false;return false;}
  server.begin();
  return true;
}
void update(){
  if(!initialized)return;
  facecam::maintainSamples(millis());
  if (sceneRequestId && !sceneBindingCurrent()) {facecam::cancelSceneFrame();sceneRequestId=0;}
  pumpFaceReply();
  pumpSceneReply();
  // Interface activation/removal can invalidate the listener in Arduino 2.x.
  // Rebind after DHCP or AP shutdown rather than keeping a stale TCP socket.
  const uint32_t address=(uint32_t)WiFi.localIP();
  if(address!=stationAddress || !server.listening()){stationAddress=address;server.begin();}
  server.handleClient();
  if(opened&&(int32_t)(millis()-setupUntil)>=0){if(hotspotActive)WiFi.softAPdisconnect(true);hotspotActive=false;opened=false;server.begin();}
}
void cancelCameraFrames(){
  if(!initialized)return;
  clearSceneReply();facecam::cancelSceneFrame();sceneRequestId=0;
}
bool setupOpen(){return opened;}
const char* apName(){return apSsid;}const char* apPassword(){return apPass;}const char* setupPin(){return pin;}
bool handleSerialJson(const char* json){
  if(!json||json[0]!='{')return false;
  document.clear();const auto error=deserializeJson(document,json);
  if(error){Serial.println("{\"ok\":false,\"error\":\"invalid_json\"}");return true;}
  const char* op=document["op"]|"";
  if(!strcmp(op,"setup")){const bool ok=configure(document.as<JsonObjectConst>());Serial.println(ok?"{\"ok\":true,\"accepted\":true}":"{\"ok\":false,\"error\":\"invalid_or_busy\"}");}
  else if(!strcmp(op,"pairing")){
    // Explicit physical USB request; host must store this response privately.
    document.clear();document["pulse_pairing"]=true;document["token"]=controlToken;document["pin"]=pin;
    document["ap"]=apSsid;document["ap_password"]=apPass;document["ip"]=WiFi.localIP().toString();
    serializeJson(document,Serial);Serial.println();
  }else if(!strcmp(op,"setup_open")){openSetup();Serial.println("{\"ok\":true}");}
  else if(!strcmp(op,"agent_gate")){studiolink::setAgentAllowed(document["enabled"]|false);Serial.println("{\"ok\":true}");}
  else if(!strcmp(op,"voice_status")){
    const auto net=studiolink::status();const auto audio=voice_audio::status();
    document.clear();document["voice_status"]=true;document["version"]=PULSE_VERSION;document["wifi"]=net.wifi_connected;document["wifi_state"]=net.wifi_state;document["disconnect_reason"]=net.last_disconnect_reason;document["auth"]=net.authenticated;document["socket"]=net.socket_connected;document["studio"]=net.ready;document["socket_stage"]=net.socket_stage;document["ws_connected"]=net.ws_connected;document["engine_opens"]=net.engine_opens;document["namespace_sends"]=net.namespace_auth_sends;document["namespace_acks"]=net.namespace_acks;document["auth_http_status"]=net.auth_http_status;document["conversation_id"]=net.conversation_id;document["conversation_changing"]=net.conversation_changing;document["backend_pending"]=net.backend_pending;document["new_chat_pending"]=callbacks.newChatPending && callbacks.newChatPending();document["voice_notice"]=callbacks.voiceNotice?callbacks.voiceNotice():"";document["voice_armed"]=callbacks.armed && callbacks.armed();document["portal_listening"]=server.listening();TaskHandle_t cameraTask=xTaskGetHandle("cam_task");document["cam_stack_bytes"]=cameraTask?(uint32_t)uxTaskGetStackHighWaterMark(cameraTask):0;document["agent_allowed"]=net.agent_allowed;document["server"]=net.server;document["profile"]=net.profile;document["ip"]=net.ip;document["mic"]=audio.ready;document["rms"]=audio.rms;document["noise"]=audio.noise_rms;document["listening"]=audio.listening;document["recording"]=audio.recording;document["captured"]=audio.captured_samples;document["error"]=net.error;document["audio_error"]=audio.error;serializeJson(document,Serial);Serial.println();
  }else{Serial.println("{\"ok\":false,\"error\":\"unknown_operation\"}");}
  return true;
}
} // namespace voiceportal
#else
namespace voiceportal {bool begin(const Hooks&){return false;}void update(){}void cancelCameraFrames(){}void openSetup(){}bool setupOpen(){return false;}const char* apName(){return "";}const char* apPassword(){return "";}const char* setupPin(){return "";}bool handleSerialJson(const char*){return false;}}
#endif
