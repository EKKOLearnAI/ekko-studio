// 脉冲 Pulse · 应用层：硬件、输入、设置界面、自检、串口命令（原创代码）
#include <M5Unified.h>
#include <Preferences.h>
#include <WiFi.h>
#include <mbedtls/base64.h>
#include <math.h>
#include <new>
#include <sys/time.h>
#include <time.h>
#if PULSE_STUDIO_VOICE
#include <esp_sntp.h>
#endif
#include "app.h"
#include "brain.h"
#include "companion.h"
#include "config.h"
#include "conversation.h"
#include "expression_audio.h"
#include "face_camera.h"
#include "face_tracker.h"
#include "head_touch.h"
#include "motion.h"
#include "pulse_engine.h"
#include "sensors.h"
#include "servo_driver.h"
#include "sfx.h"
#include "stackchan_body.h"
#include "studio_link.h"
#include "touch_interaction.h"
#include "touch_dispatch.h"
#include "voice_audio.h"
#include "voice_portal.h"

static pulse::Engine* eng = nullptr;
static HeadServo head;
static motion::Planner plan;
static Preferences prefs;
static facetrack::Controller faceController;
static bool faceMaintenance = false, faceOwned = false, faceWasAllowed = false;
static uint32_t lastFaceLock = 0;
static uint32_t faceObservedFrame = 0, faceObservedAt = 0;
static size_t faceObservedCount = 0;

struct Settings {
  uint8_t care = PULSE_DEFAULT_CARE;     // 2.8 关心提醒：0 关 / 1 少一点 / 2 开
  bool task = PULSE_DEFAULT_TASK;        // 2.8 任务提醒（Ekko Studio → /api/notify）
  uint8_t snd = PULSE_DEFAULT_SOUND;     // 声音：0 关 / 1 小 / 2 中 / 3 大
  uint8_t mot = PULSE_DEFAULT_MOTION;    // 动作幅度：0 关 / 1 小 / 2 中 / 3 大
  uint8_t servo = PULSE_DEFAULT_SERVO;
  uint8_t port = PULSE_DEFAULT_PORT;
  uint8_t dir = 0;                       // 第 0 位：左右反向；第 1 位：上下反向
  bool led = true;                       // 官方机身的 RGB 灯
  bool face = PULSE_DEFAULT_FACE_FOLLOW;
  int32_t z1 = -1, z2 = -1;              // 官方机身校准过的零位（-1 = 没校准过）
  uint8_t night = 0;                     // 2.7 夜间安静：0 自动（22:00–07:00 或房间长时间很暗）/ 1 关
  bool abrt = true;                      // 2.7 自动亮度（按环境光）
  int32_t tz = PULSE_TZ_OFFSET;          // 2.7 时区（秒，默认东八区）
  uint8_t live = PULSE_DEFAULT_LIVELY;   // 2.9 活跃度：0 安静（和 2.8 一样）/ 1 适中 / 2 活泼
  bool music = PULSE_DEFAULT_MUSIC;      // 2.9 听歌跳舞（麦克风只在本机算节拍）
  bool talk = PULSE_DEFAULT_TALK_AUTO;   // 2.9 对话自动结束
};
static Settings cfg;
static bool servoUser = false;  // 用户亲自选过舵机类型（否则检测到官方机身时自动选它）
static const float kAmp[4] = {0.f, .55f, 1.f, 1.3f};
static const char* const kLevelName[4] = {"关", "小", "中", "大"};
static const char* const kDirName[4] = {"正常", "左右反向", "上下反向", "都反向"};

#if defined(CONFIG_IDF_TARGET_ESP32S3)
static constexpr uint8_t kServoTypes = 4;  // CoreS3 多一个「官方 StackChan 机身」
#else
static constexpr uint8_t kServoTypes = 3;
#endif

// 官方 StackChan 机身
static bool bodyOk = false;
static uint32_t bodyProbeUntil = 0, bodyNextProbe = 0, lastLedMs = 0;
static bool k151PowerCycled = false;
static int32_t ledSent = -1;

static bool engineOk = false;
static uint32_t lastUs = 0, lastBrightMs = 0, diagAt = 0;
static int lastBright = -1;
static uint32_t fpsT0 = 0, fpsFrames = 0;

static bool voiceArmed = false, voiceTurnPending = false, voiceTurnFinished = false;
static bool voiceMicDiagnostic = false;
static bool voicePlaybackActive = false;
static char voicePlaybackSegment[80] = {};
static uint32_t voiceMicUntil = 0, voiceHeartbeat = 0, voiceFinishedAt = 0, voiceEventAt = 0;
static studiolink::Event* voiceNetEvent = nullptr;
static voice_audio::PlaybackRequest* voicePlayback = nullptr;
static char voiceLastReply[192] = {};
static char voiceNotice[128] = {};
static bool newChatPending = false;
static bool musicMicOk = false;  // 2.9：有麦克风可以听节拍（CoreS3 + 语音版）
// 2.9 对话自动结束（设置 → 对话自动结束）：一会儿没说话 / 说了再见 / 连着两次没听清 → 不再听
static uint32_t voiceIdleFrom = 0;   // 开始等你说话的时间（0 = 没在等）
static uint32_t faceSeenAt = 0;      // 最近一次在镜头里看见你
static uint8_t voiceEmptyTurns = 0;  // 连着几轮没听清
static bool voiceTurnHeard = false, voiceGoodbye = false, voiceTranscripts = false;
static uint32_t newChatStartedAt = 0;
static char newChatPreviousId[64] = {};
static conversation::SoundCue directorCue;
static bool directorLease = false, directorSettling = false, directorWakePending = false;
static bool directorTouchStarted = false;
static uint32_t directorSettleAt = 0, directorStartedAt = 0;
static bool directorQuietWaiting = false, directorResumeListening = false;
static uint32_t directorResumeGeneration = 0;
static bool voiceSpeechSeen = false, voiceSpeechEndNotified = false;
static uint32_t voiceSpeechDoneAt = 0;
static touchinteraction::Controller touchController;
static uint32_t touchEpoch = 1, touchPhraseTicket = 0, touchPhraseExpiresAt = 0;
static voiceportal::TouchInfo touchInfo;
static bool touchBaseHeld = false;
static uint32_t touchBaseUntil = 0;
static pulse::Pose touchBase = {0.f, 0.f};

static void touchFx(touchinteraction::Visual visual) {
  if (eng && engineOk) eng->emit(visual == touchinteraction::Visual::Happy ? pulse::FX_HEART : pulse::FX_EXCLAIM, 2);
}
static bool idleTouchVisual(uint8_t semanticId, bool, uint32_t durationMs, uint32_t now) {
  return brain::localTouchVisual(semanticId == 21, now, durationMs);
}
static touchdispatch::Hooks touchHooks() {
  touchdispatch::Hooks hooks;
  hooks.fx = touchFx; hooks.localIdleVisual = idleTouchVisual;
  return hooks;
}
static touchdispatch::Dispatcher touchDispatcher(touchHooks(), sfx::C_TOUCH_DIRTY_HANDS, .48f);
static touchinteraction::Context touchContext(uint32_t now, bool audioReady = false) {
  const auto audio = voice_audio::status();
  touchinteraction::Context context;
  // 2.9：正在玩节奏游戏 / 心情打卡 / 深呼吸：触摸归它们（导演层先别反应）
  context.enabled = engineOk && !faceMaintenance && brain::faceTrackingAllowed() && !brain::touchCaptured();
  context.recording = audio.recording;
  context.speaking = audio.playback_busy || voicePlaybackActive || M5.Speaker.isPlaying();
  context.expressionOwned = conversation::active() && !conversation::localFeedbackAvailable(now);
  context.audioReady = audioReady;
  context.generation = conversation::generation(); context.epoch = touchEpoch;
  return context;
}
static voiceportal::TouchInfo readTouchInfo() { return touchInfo; }
static voiceportal::CompanionInfo readCompanion();  // 2.7：定义在「陪伴」一节
static voiceportal::FaceTrackingInfo readFaceTracking() {
  const auto camera = facecam::status();
  const auto target = faceController.snapshot();
  voiceportal::FaceTrackingInfo info;
  info.enabled = cfg.face && !faceMaintenance && brain::faceTrackingAllowed();
  info.camera = camera.initialized; info.worker = camera.running;
  // Use the observation consumed by this Controller, not a newer worker frame
  // whose target selection has not yet run on the main loop.
  info.faces = static_cast<int>(faceObservedCount); info.frameId = faceObservedFrame;
  info.capturedMs = faceObservedAt;
  info.ageMs = faceObservedFrame ? millis()-faceObservedAt : UINT32_MAX;
  info.lostMs = target.lost_ms;
  info.locked = target.locked; info.tracking = target.tracking;
  info.ambiguous = target.ambiguous; info.targetId = target.lock_id;
  info.errorX = target.error_x; info.errorY = target.error_y;
  info.pan = target.pan; info.tilt = target.tilt;
  return info;
}

static void cancelDirectorCue() {
  voice_audio::cancelQuietListeningCueWait();
  directorQuietWaiting = false;
  sfx::cancelCue();
  // Retain the hardware lease until updateDirectorCue observes real drain.
  if (directorLease) { directorSettling = true; directorSettleAt = 0; }
}

static bool voiceIsArmed() { return voiceArmed; }
static bool newChatIsPending() { return newChatPending; }
static const char* currentVoiceNotice() { return voiceNotice; }
static bool voiceSpeakerActive() { return voicePlaybackActive; }
static const char* renderedEmotion() {
  return eng && engineOk ? pulse::stateDef(eng->state()).id : "";
}
static void clearVoicePlayback() {
  voicePlaybackActive = false;
  conversation::setPlaybackActive(false, millis());
  voicePlaybackSegment[0] = 0;
}

static void stopVoice() {
#if PULSE_STUDIO_VOICE
  voiceportal::cancelCameraFrames();
  // A later manual stop cancels the automatic wake, even if routing is
  // already being changed by the network task.
  newChatPending = false;
  ++touchEpoch;
  touchController.reset(millis()); touchDispatcher.reset(millis());
  directorWakePending = false;
  voiceArmed = voiceTurnPending = voiceTurnFinished = voiceMicDiagnostic = false;
  clearVoicePlayback();
  voice_audio::cancel(studiolink::interrupt());
  conversation::cancel(millis(), "监听已关闭");
  sfx::setSuspended(directorLease);
  voiceLastReply[0] = 0;
  voiceSpeechSeen = voiceSpeechEndNotified = false; voiceSpeechDoneAt = 0;
  voiceIdleFrom = 0; voiceEmptyTurns = 0; voiceTurnHeard = voiceGoodbye = voiceTranscripts = false;
  strlcpy(voiceNotice, "监听已关闭", sizeof(voiceNotice));
#endif
}

static bool listenForNextUtterance(uint32_t now, bool preserveEmotion = false) {
#if PULSE_STUDIO_VOICE
  const auto net = studiolink::status();
  if (!net.ready || !net.agent_allowed || !voice_audio::ok()) return false;
  const uint32_t generation = studiolink::interrupt();
  clearVoicePlayback();
  voice_audio::cancel(generation);
  char id[65];
  snprintf(id, sizeof(id), "listen-%08lx-%08lx", (unsigned long)generation, (unsigned long)now);
  if (!conversation::startTurn(id, generation, now, preserveEmotion)) return false;
  conversation::setPhase(conversation::Phase::Listening, "请直接说话；停顿后自动发送", now);
  sfx::setSuspended(true);
  voice_audio::setListening(true);
  voiceSpeechSeen = voiceSpeechEndNotified = false; voiceSpeechDoneAt = 0;
  voiceTurnPending = voiceTurnFinished = false;
  voiceHeartbeat = voiceEventAt = now;
  voiceLastReply[0] = voiceNotice[0] = 0;
  voiceIdleFrom = now ? now : 1;  // 2.9：开始等你开口
  voiceTurnHeard = false;
  return true;
#else
  (void)now; (void)preserveEmotion; return false;
#endif
}

static bool wakeVoice(bool openSetupOnFail = true) {
#if PULSE_STUDIO_VOICE
  if (newChatPending || studiolink::status().conversation_changing) return false;
  if (faceMaintenance || !voiceNetEvent || !voicePlayback) return false;
  if (directorLease) {
    cancelDirectorCue(); directorWakePending = true;
    return true;  // Wake is deferred until cue drain and clock lease release.
  }
  if (voiceArmed) return true;
  voiceEmptyTurns = 0; voiceGoodbye = voiceTranscripts = false;
  if (!listenForNextUtterance(millis())) {
    if (!openSetupOnFail) return false;  // 自动/摸头唤醒失败时不弹配网页
    voiceportal::openSetup();
    strlcpy(voiceNotice, "先完成 Wi-Fi、Studio 授权和语音配置", sizeof(voiceNotice));
    return false;
  }
  voiceArmed = true;
  return true;
#else
  return false;
#endif
}

// 摸头唤醒：只在 Studio 已连接且已授权时才唤醒，条件不满足不弹设置页（避免误触打开配网热点）
static bool headWakeVoice() {
#if PULSE_STUDIO_VOICE
  const auto net = studiolink::status();
  if (voiceArmed || newChatPending || net.conversation_changing || !net.ready || !net.agent_allowed) return false;
  const bool ok = wakeVoice(false);
  Serial.printf("[voice] head-tap wake: %s\n", ok ? "listening" : "not ready");
  return ok;
#else
  return false;
#endif
}

// 开机后 Studio 连上且授权有效时自动开始听，每次开机只做一次（之后靠摸头恢复）
static void bootAutoListen(uint32_t now) {
#if PULSE_STUDIO_VOICE
  static bool done = false;
  static uint32_t nextCheck = 0;
  static uint8_t fails = 0;
  if (done || (int32_t)(now - nextCheck) < 0) return;
  nextCheck = now + 2000;
  if (now < 4000) return;              // 等开机动画和舵机校准走完
  if (now > 180000) { done = true; return; }  // 开机 3 分钟内没连上就不再自动开，避免意外开麦
  if (voiceArmed) { done = true; return; }
  if (faceMaintenance || newChatPending) return;
  const auto net = studiolink::status();
  if (!net.ready || !net.agent_allowed || net.conversation_changing || !voice_audio::ok()) return;
  const bool ok = wakeVoice(false);
  if (ok) { done = true; Serial.println("[voice] boot auto-listen: listening"); return; }
  // 开机时声卡/对话状态可能还没就绪：每 2 秒再试，前几次把原因打出来
  if (fails < 3) {
    ++fails;
    const auto audio = voice_audio::status();
    Serial.printf("[voice] boot auto-listen retry: lease=%d maint=%d conv=%d audio_busy=%d err=%s\n", directorLease, faceMaintenance,
                  conversation::active(), voice_audio::busy(), audio.error);
  }
#else
  (void)now;
#endif
}

static bool startNewChat() {
#if PULSE_STUDIO_VOICE
  if (newChatPending) return true; // Repeated USB requests cannot rotate twice.
  const auto net = studiolink::status();
  if (faceMaintenance || !voiceNetEvent || !voicePlayback || !net.ready ||
      !net.agent_allowed || net.conversation_changing) {
    strlcpy(voiceNotice, "新聊天需要已授权的 Studio 连接", sizeof(voiceNotice));
    return false;
  }
  stopVoice();
  strlcpy(newChatPreviousId, net.conversation_id, sizeof(newChatPreviousId));
  if (!studiolink::newConversation()) {
    strlcpy(voiceNotice, "新聊天切换未受理，监听保持关闭", sizeof(voiceNotice));
    return false;
  }
  newChatPending = true;
  newChatStartedAt = millis();
  strlcpy(voiceNotice, "正在结束旧对话并连接新聊天", sizeof(voiceNotice));
  return true;
#else
  return false;
#endif
}

static void updateNewChat(uint32_t now) {
#if PULSE_STUDIO_VOICE
  if (!newChatPending) return;
  if (now - newChatStartedAt >= 45000) {
    newChatPending = false;
    strlcpy(voiceNotice, "新聊天连接超时，监听保持关闭", sizeof(voiceNotice));
    Serial.println("[voice-new] connection timeout; microphone remains off");
    return;
  }
  const auto net = studiolink::status();
  if (!net.conversation_changing) {
    if (!strcmp(net.conversation_id, newChatPreviousId)) {
      newChatPending = false;
      strlcpy(voiceNotice, "新聊天编号未切换，监听保持关闭", sizeof(voiceNotice));
      Serial.println("[voice-new] failed; identity unchanged");
      return;
    }
    if (net.ready) {
      newChatPending = false;
      const bool listening = wakeVoice();
      if (!listening) strlcpy(voiceNotice, "新聊天已连接，监听尚未开启", sizeof(voiceNotice));
      Serial.printf("[voice-new] conversation=%s listening=%d\n", net.conversation_id, listening);
      return;
    }
  }
#else
  (void)now;
#endif
}

static bool voiceEventBelongs(const char* id, uint32_t generation) {
  return conversation::active() && generation == conversation::generation()
      && id && !strcmp(id, conversation::turnId());
}

static expression_audio::QuietContext directorQuietContext(const voice_audio::Status& audio) {
  expression_audio::QuietContext context;
  context.armed = voiceArmed; context.turn_pending = voiceTurnPending;
  context.listening = audio.listening; context.recording = audio.recording;
  context.tts_busy = audio.playback_busy; context.speaker_busy = M5.Speaker.isPlaying();
  context.diagnostic = voiceMicDiagnostic; context.maintenance = faceMaintenance;
  context.phase = conversation::phase(); context.generation = conversation::generation();
  return context;
}
static void cancelDirectorQuietWait() {
  if (!directorQuietWaiting) return;
  voice_audio::cancelQuietListeningCueWait();
  directorQuietWaiting = false;
}
static void resumeDirectorListening() {
  const bool resume = directorResumeListening && conversation::active() &&
      expression_audio::mayResumeListening(directorQuietContext(voice_audio::status()),
                                          directorResumeGeneration, !directorLease);
  directorResumeListening = false; directorResumeGeneration = 0;
  if (resume) voice_audio::setListening(true);
}

static void updateDirectorCue(uint32_t now) {
#if PULSE_STUDIO_VOICE
  now = millis();  // HTTP/decoder work may have advanced the caller's timestamp.
  const auto summary = conversation::expressionCues();
  if (directorLease) {
    const auto audio = voice_audio::status();
    if (!summary.sound_playing || directorCue.generation != conversation::generation() ||
        audio.playback_busy || (int32_t)(now - directorCue.expiresAtMs) >= 0 ||
        now - directorStartedAt > 4000) {
      sfx::cancelCue(); directorSettling = true;
    }
    const auto playback = sfx::cueStatus();
    if (directorCue.local && !directorTouchStarted && playback.token == directorCue.token &&
        playback.state == sfx::CueState::Playing) {
      directorTouchStarted = true; ++touchInfo.phraseStarted;
    }
    if (playback.token == directorCue.token && playback.state != sfx::CueState::Queued &&
        playback.state != sfx::CueState::Playing) directorSettling = true;
    if (directorSettling && !sfx::busy() && !M5.Speaker.isPlaying()) {
      if (!directorSettleAt) directorSettleAt = now + 100;
      if ((int32_t)(now - directorSettleAt) >= 0) {
        const bool completed = playback.token == directorCue.token && playback.state == sfx::CueState::Done;
        if (directorCue.local) {
          if (completed) ++touchInfo.phraseDone;
          else ++touchInfo.phraseCancelled;
        }
        conversation::soundCueFinished(directorCue.token, now, completed);
        voice_audio::endExternalCue();
        directorLease = directorSettling = false; directorSettleAt = 0;
        directorCue = conversation::SoundCue();
        directorTouchStarted = false;
        sfx::setSuspended(voiceArmed || voiceMicDiagnostic);
        resumeDirectorListening();  // Same Listening turn, after real cue drain/settle only.
        if (directorWakePending) { directorWakePending = false; wakeVoice(); }
      }
    } else directorSettleAt = 0;
    return;
  }
  if (voiceSpeechSeen && voiceTurnFinished && !voicePlaybackActive && !voice_audio::busy() &&
      voiceSpeechDoneAt && !voiceSpeechEndNotified) {
    conversation::speechEnded(voiceSpeechDoneAt);
    voiceSpeechEndNotified = true;
  }
  if (!summary.sound_pending || voiceMicDiagnostic || sfx::busy() || M5.Speaker.isPlaying()) {
    cancelDirectorQuietWait(); return;
  }
  const uint32_t phraseWindow = static_cast<uint32_t>(
      (static_cast<uint64_t>(sfx::kClips[sfx::C_TOUCH_DIRTY_HANDS].samples) * 1000 + sfx::kClipRate - 1) /
      sfx::kClipRate) + 200;
  if (summary.local && static_cast<int32_t>(touchPhraseExpiresAt - now) < static_cast<int32_t>(phraseWindow)) {
    conversation::cancelLocalCue(now);
    cancelDirectorQuietWait(); ++touchInfo.phraseCancelled;
    return;  // Keep enough time for the complete compiled phrase and drain.
  }
  const auto audio = voice_audio::status();
  const bool after = voiceArmed && voiceTurnPending && voiceTurnFinished && voiceSpeechEndNotified &&
                     !audio.playback_busy && !voicePlaybackActive && now - voiceFinishedAt >= 700;
  const auto quietMode = expression_audio::quietMode(directorQuietContext(audio));
  const bool quiet = quietMode != expression_audio::QuietMode::Unavailable;
  if ((summary.sound_timing == conversation::SoundTiming::AfterSpeech && !after) ||
      (summary.sound_timing == conversation::SoundTiming::WhenQuiet && !quiet)) {
    cancelDirectorQuietWait(); return;
  }
  const bool listeningGap = summary.sound_timing == conversation::SoundTiming::WhenQuiet &&
                            quietMode == expression_audio::QuietMode::ListeningGap;
  if (listeningGap) {
    // Do not turn RX off from a stale status snapshot. The capture worker must
    // observe sustained quiet and consume every queued DMA block before it can
    // hand over the same exclusive lease used by the ordinary cue path.
    directorQuietWaiting = true;
    if (!voice_audio::tryBeginQuietListeningCue()) return;
    directorQuietWaiting = false;
    directorResumeListening = true; directorResumeGeneration = conversation::generation();
  } else {
    cancelDirectorQuietWait();
    voice_audio::setListening(false);
    if (audio.recording || M5.Mic.isRecording() || !voice_audio::tryBeginExternalCue()) return;
    directorResumeListening = false; directorResumeGeneration = 0;
  }
  directorLease = true; directorSettling = false; directorSettleAt = 0;
  directorTouchStarted = false;
  sfx::setSuspended(true);  // Keep ordinary/ambient SFX blocked for this lease.
  if (!conversation::takeSoundCue(directorCue, now, after, quiet)) {
    voice_audio::endExternalCue(); directorLease = false;
    sfx::setSuspended(voiceArmed || voiceMicDiagnostic);
    resumeDirectorListening();
    return;
  }
  if (directorCue.local && !touchController.claimPhrase(touchPhraseTicket, now, touchContext(now, true))) {
    conversation::soundCueFinished(directorCue.token, now, false);
    voice_audio::endExternalCue(); directorLease = false;
    directorCue = conversation::SoundCue();
    sfx::setSuspended(voiceArmed || voiceMicDiagnostic);
    resumeDirectorListening(); ++touchInfo.phraseCancelled;
    return;
  }
  directorStartedAt = now;
  if (!sfx::playCue(directorCue.clip, directorCue.gain, directorCue.token)) {
    conversation::soundCueFinished(directorCue.token, now, false);
    directorSettling = true;
  }
#else
  (void)now;
#endif
}

// 2.9：短短一句里有「再见 / 拜拜 / 晚安 / 不聊了」= 这轮回复完就不再听（长句子里顺带提到不算）
static bool goodbyeWords(const char* t) {
  if (!t || !*t || strlen(t) > 30) return false;
  static const char* const kBye[] = {"再见", "拜拜", "拜了", "bye", "Bye", "BYE", "晚安", "不聊了", "先这样", "下次聊", "下次再聊", "回头聊", "退下吧", "没事了"};
  for (const char* w : kBye)
    if (strstr(t, w)) return true;
  return false;
}
// 一轮说完：要不要接着听（nullptr = 接着听）
static const char* talkEndReason() {
  if (!cfg.talk) return nullptr;
  if (voiceGoodbye) return "说了再见，先不听了";
  voiceEmptyTurns = voiceTurnHeard ? 0 : (uint8_t)(voiceEmptyTurns + 1);
  if (voiceEmptyTurns >= 3) return "连着三次没听清，先不听了（摸摸头就能接着聊）";
  return nullptr;
}
static void endTalk(const char* why) {
  stopVoice();
  strlcpy(voiceNotice, why, sizeof(voiceNotice));
  Serial.printf("[voice] 自动结束：%s（设置 → 对话自动结束 可以关掉）\n", why);
}

static void updateVoice(uint32_t now) {
#if PULSE_STUDIO_VOICE
  studiolink::update();
  voiceportal::update();
  now = millis();
  if (!voiceNetEvent || !voicePlayback) return;
  bootAutoListen(now);
  // Bound event work so incoming traffic cannot monopolize display/face control.
  for (int n = 0; n < 6 && studiolink::takeEvent(*voiceNetEvent); ++n) {
    auto& event = *voiceNetEvent;
    if (event.type == studiolink::EventType::Network) {
      if (!strcmp(event.phase, "disconnected") && voiceArmed) {
        stopVoice();
        strlcpy(voiceNotice, "连接中断，监听已停止", sizeof(voiceNotice));
      }
      continue;
    }
    if (!voiceArmed || !event.interaction_id[0]) {
      if (event.type == studiolink::EventType::Error)
        strlcpy(voiceNotice, event.text, sizeof(voiceNotice));
      continue;
    }
    if (event.generation > conversation::generation()) {
      clearVoicePlayback();
      voice_audio::cancel(event.generation);
      // A new audio upload can be noise, not a new emotional intention. Carry
      // only the existing visual lease; its deadline and old-command fencing
      // are unchanged. Explicit emotion commands can replace it immediately.
      if (!conversation::startTurn(event.interaction_id, event.generation, now, true)) continue;
      voiceTurnPending = true;
      voiceTurnFinished = false;
    }
    if (!voiceEventBelongs(event.interaction_id, event.generation)) continue;
    voiceEventAt = now;
    if (event.type == studiolink::EventType::Transcript) {
      if (event.text[0]) {  // 2.9：听清了你说什么
        voiceTranscripts = voiceTurnHeard = true;
        if (goodbyeWords(event.text)) voiceGoodbye = true;
      }
      conversation::setPhase(voicePlaybackActive ? conversation::Phase::Speaking : conversation::Phase::Thinking, event.text, now);
    } else if (event.type == studiolink::EventType::Reply) {
      if (!voiceTranscripts) voiceTurnHeard = true;  // Studio 不送识别文字：有回复就算听清了
      strlcpy(voiceLastReply, event.text, sizeof(voiceLastReply));
      // Text is not proof that the speaker is already playing it.
      if (!voicePlaybackActive && !voice_audio::busy()) conversation::setPhase(conversation::Phase::Working, event.text, now);
    } else if (event.type == studiolink::EventType::Audio) {
      if (!voiceTranscripts) voiceTurnHeard = true;
      *voicePlayback = voice_audio::PlaybackRequest();
      if (strlen(event.interaction_id) >= sizeof(voicePlayback->interaction_id)
          || strlen(event.segment_id) >= sizeof(voicePlayback->segment_id)
          || !voice_audio::setAllowedOrigin(studiolink::status().server)
          || !studiolink::getBearer(voicePlayback->bearer, sizeof(voicePlayback->bearer))) {
        stopVoice();strlcpy(voiceNotice, "回复音频参数无效", sizeof(voiceNotice));continue;
      }
      strlcpy(voicePlayback->url, event.url, sizeof(voicePlayback->url));
      strlcpy(voicePlayback->interaction_id, event.interaction_id, sizeof(voicePlayback->interaction_id));
      strlcpy(voicePlayback->segment_id, event.segment_id, sizeof(voicePlayback->segment_id));
      voicePlayback->generation = event.generation;
      if (!voice_audio::enqueuePlayback(*voicePlayback)) {
        voice_audio::Event failed;
        failed.kind = voice_audio::EventKind::Failed;
        failed.generation = event.generation;
        strlcpy(failed.interaction_id, event.interaction_id, sizeof(failed.interaction_id));
        strlcpy(failed.segment_id, event.segment_id, sizeof(failed.segment_id));
        strlcpy(failed.error, "playback_queue_rejected", sizeof(failed.error));
        studiolink::reportAudioEvent(failed);
        stopVoice();strlcpy(voiceNotice, "音频队列暂忙，监听已停止", sizeof(voiceNotice));
      }
      memset(voicePlayback->bearer, 0, sizeof(voicePlayback->bearer));
    } else if (event.type == studiolink::EventType::Error) {
      char message[128];strlcpy(message, event.text, sizeof(message));
      stopVoice();strlcpy(voiceNotice, message, sizeof(voiceNotice));
    } else if (event.type == studiolink::EventType::Phase) {
      if (!strcmp(event.phase, "recognizing")) conversation::setPhase(conversation::Phase::Recognizing, "正在识别语音", now);
      else if (!strcmp(event.phase, "thinking")) conversation::setPhase(voicePlaybackActive ? conversation::Phase::Speaking : conversation::Phase::Thinking, event.text, now);
      else if (!strcmp(event.phase, "working") || !strcmp(event.phase, "tool")) conversation::setPhase(voicePlaybackActive ? conversation::Phase::Speaking : conversation::Phase::Working, event.text, now);
      else if (!strcmp(event.phase, "completed") || !strcmp(event.phase, "done") || !strcmp(event.phase, "idle")) {
        voiceTurnFinished = true;voiceFinishedAt = now;
      } else if (!strcmp(event.phase, "aborted")) {
        stopVoice();strlcpy(voiceNotice, "本轮已取消", sizeof(voiceNotice));
      } else if (!strcmp(event.phase, "failed") || !strcmp(event.phase, "error")) {
        stopVoice();strlcpy(voiceNotice, event.text[0] ? event.text : "对话失败，请查看 Studio", sizeof(voiceNotice));
      }
    }
  }
  voice_audio::Event audioEvent;
  while (voice_audio::takeEvent(audioEvent)) {
    // Report actual completion/cancellation even when the UI has moved on.
    studiolink::reportAudioEvent(audioEvent);
    if (!voiceEventBelongs(audioEvent.interaction_id, audioEvent.generation)) continue;
    voiceEventAt = now;
    if (audioEvent.kind == voice_audio::EventKind::Started) {
      voiceSpeechSeen = true;
      voicePlaybackActive = true;
      strlcpy(voicePlaybackSegment, audioEvent.segment_id, sizeof(voicePlaybackSegment));
      sfx::stop();
      conversation::setPlaybackActive(true, now);
      conversation::setPhase(conversation::Phase::Speaking, voiceLastReply[0] ? voiceLastReply : "正在回复", now);
    } else if (audioEvent.kind == voice_audio::EventKind::Done) {
      voiceSpeechDoneAt = now;
      if (!strcmp(voicePlaybackSegment, audioEvent.segment_id)) {
        clearVoicePlayback();
        conversation::setPhase(voiceTurnFinished ? conversation::Phase::Done : conversation::Phase::Working,
                               voiceTurnFinished ? "回复完成" : "正在准备下一段回复", now);
      }
    } else if (audioEvent.kind == voice_audio::EventKind::Cancelled) {
      if (!strcmp(voicePlaybackSegment, audioEvent.segment_id)) {
        clearVoicePlayback();
        conversation::setPhase(conversation::Phase::Working, "回复音频已取消", now);
      }
    } else if (audioEvent.kind == voice_audio::EventKind::Failed) {
      stopVoice();strlcpy(voiceNotice, audioEvent.error, sizeof(voiceNotice));
    }
  }
  voice_audio::Utterance utterance;
  if (voice_audio::takeUtterance(utterance)) {
    if (newChatPending || studiolink::status().conversation_changing) {
      // Capture cancellation can finish after the switch request. Discard
      // that old buffer without cancelling the user's pending new-chat wake.
      voice_audio::freeUtterance(utterance);
    } else if (voiceMicDiagnostic) {
      Serial.printf("[voice-mic] captured=%u samples limit=%d (local only)\n", (unsigned)utterance.count, utterance.ended_by_limit);
      voice_audio::freeUtterance(utterance);
      voice_audio::setListening(true);
    } else if (voiceArmed && studiolink::submit(utterance)) {
      voiceTurnPending = true;voiceTurnFinished = false;
      brain::noteChat();
      conversation::setPhase(conversation::Phase::Recognizing, "正在提交语音", now);
      voiceEventAt = now;
    } else {
      voice_audio::freeUtterance(utterance);
      stopVoice();strlcpy(voiceNotice, "语音提交失败，请检查连接", sizeof(voiceNotice));
    }
  }
  if (voiceMicDiagnostic && (int32_t)(now-voiceMicUntil)>=0) {
    voice_audio::cancel(studiolink::status().generation);voiceMicDiagnostic=false;
    sfx::setSuspended(false);
    Serial.println("[voice-mic] local test ended");
  }
  updateDirectorCue(now);
  const auto cues = conversation::expressionCues();
  const bool waitCue = directorLease || cues.sound_playing ||
                       (voiceSpeechSeen && cues.sound_pending && cues.sound_timing == conversation::SoundTiming::AfterSpeech);
  if (voiceArmed && voiceTurnPending && voiceTurnFinished && !voice_audio::busy() &&
      !waitCue && !sfx::busy() && now-voiceFinishedAt>=700) {
    if (const char* why = talkEndReason()) endTalk(why);
    else if (!listenForNextUtterance(now, true)) {stopVoice();strlcpy(voiceNotice, "无法恢复监听", sizeof(voiceNotice));}
  }
  // 2.9：等你开口等了很久（你还在镜头前就多等一会儿）
  if (voiceArmed && voiceIdleFrom && !voiceTurnPending) {
    if (voice_audio::status().recording) voiceIdleFrom = now ? now : 1;
    else if (cfg.talk && conversation::phase() == conversation::Phase::Listening) {
      const bool face = faceSeenAt && now - faceSeenAt < 8000;
      if (now - voiceIdleFrom >= (face ? PULSE_TALK_IDLE_FACE_MS : PULSE_TALK_IDLE_MS)) endTalk("一会儿没说话，先不听了");
    }
  }
  if (voiceArmed && now-voiceEventAt>180000 && voiceTurnPending) {
    stopVoice();strlcpy(voiceNotice, "本轮等待超时，监听已停止", sizeof(voiceNotice));
  }
  if (voiceArmed && conversation::active() && now-voiceHeartbeat>=5000) {
    conversation::setPhase(conversation::phase(), conversation::statusText(), now);
    voiceHeartbeat=now;
  }
  conversation::update(now);
  if (voiceArmed && !conversation::active()) {
    voice_audio::cancel(studiolink::interrupt());voiceArmed=false;
  }
  // Drain old network/audio events before waking the new logical connection.
  updateNewChat(now);
#else
  (void)now;
#endif
}

static void drawVoiceOverlay() {
  // The everyday display is the expression itself. The existing top-right
  // touch target still toggles listening; diagnostics stay on USB/web UI.
}

// One explicitly requested render frame, exported over USB in bounded packets.
// The camera is not involved; pixels are the RGB565 bands sent to the LCD.
static uint16_t* screenExportPixels = nullptr;
static size_t screenExportBytes = 0, screenExportOffset = 0;
static uint32_t screenExportStarted = 0;
static int screenExportWidth = 0, screenExportHeight = 0;
static bool screenExportReady = false, screenExportHeader = false;
static char screenExportEmotion[3] = {};

static void freeScreenSnapshot() {
  if (eng) eng->cancelFrameCapture();
  free(screenExportPixels);
  screenExportPixels = nullptr;
  screenExportBytes = screenExportOffset = 0;
  screenExportReady = screenExportHeader = false;
}

static void requestScreenSnapshot() {
  freeScreenSnapshot();
  if (!engineOk || !eng) return;
  screenExportWidth = eng->captureWidth();
  screenExportHeight = eng->captureHeight();
  const size_t count = static_cast<size_t>(screenExportWidth) * screenExportHeight;
  screenExportPixels = static_cast<uint16_t*>(ps_malloc(count * sizeof(uint16_t)));
  if (!screenExportPixels || !eng->requestFrameCapture(screenExportPixels, count)) {
    freeScreenSnapshot();
    Serial.println("[screen-snapshot-unavailable]");
    return;
  }
  screenExportBytes = count * sizeof(uint16_t);
  screenExportStarted = millis();
}

static void publishScreenSnapshot() {
  if (!screenExportPixels) return;
  if (millis() - screenExportStarted >= 60000) {
    freeScreenSnapshot();
    if (Serial.availableForWrite() >= 64) Serial.println("[screen-snapshot-cancelled]");
    return;
  }
  if (!screenExportReady) {
    uint16_t* pixels = nullptr;
    size_t count = 0;
    if (!eng->takeFrameCapture(pixels, count)) return;
    if (pixels != screenExportPixels || count * sizeof(uint16_t) != screenExportBytes) {
      freeScreenSnapshot();
      return;
    }
    strlcpy(screenExportEmotion, renderedEmotion(), sizeof(screenExportEmotion));
    screenExportReady = true;
  }
  const uint32_t started = micros();
  for (unsigned n = 0; n < 32 && micros() - started < 2500; ++n) {
    char line[224];
    int length;
    size_t advance = 0;
    if (!screenExportHeader) {
      length = snprintf(line, sizeof(line), "[screen-snapshot] width=%d height=%d bytes=%u format=rgb565be emotion=%s\n",
                        screenExportWidth, screenExportHeight, (unsigned)screenExportBytes, screenExportEmotion);
    } else if (screenExportOffset < screenExportBytes) {
      advance = screenExportBytes - screenExportOffset;
      if (advance > 96) advance = 96;
      unsigned char encoded[129];
      size_t count = 0;
      if (mbedtls_base64_encode(encoded, sizeof(encoded), &count,
          reinterpret_cast<const uint8_t*>(screenExportPixels) + screenExportOffset, advance)) {
        freeScreenSnapshot(); return;
      }
      encoded[count] = 0;
      length = snprintf(line, sizeof(line), "[screen-data] %u %s\n", (unsigned)screenExportOffset, encoded);
    } else length = snprintf(line, sizeof(line), "[screen-snapshot-end]\n");
    if (length <= 0 || static_cast<size_t>(length) >= sizeof(line)) { freeScreenSnapshot(); return; }
    if (Serial.availableForWrite() < length) return;
    if (Serial.write(reinterpret_cast<const uint8_t*>(line), length) != static_cast<size_t>(length)) {
      freeScreenSnapshot(); return;
    }
    if (!screenExportHeader) screenExportHeader = true;
    else if (screenExportOffset < screenExportBytes) screenExportOffset += advance;
    else { freeScreenSnapshot(); return; }
  }
}

static void pauseFaceTracking() {
  facecam::setEnabled(false);
  brain::setFacePresence(false);
  plan.setFaceLook(false);
  head.setTrackingLimits(false);
  faceController.reset(plan.physicalLookPan(), plan.physicalLookTilt(), millis());
  faceOwned = faceWasAllowed = false;
  lastFaceLock = 0;
  faceObservedFrame = faceObservedAt = 0;faceObservedCount = 0;
}

static facecam::Snapshot faceExport;
static size_t faceExportOffset = 0, faceExportBox = 0;
static uint32_t faceExportStarted = 0;
static bool faceExportHeader = false;

static void publishFaceSnapshot() {
  if (!faceExport.pixels) {
    if (!facecam::takeSnapshot(faceExport)) return;
    faceExportOffset = faceExportBox = 0;
    faceExportHeader = false;
    faceExportStarted = millis();
  }
  // A host that stops reading must not block the UI or retain a frame forever.
  if (millis() - faceExportStarted > 60000) {
    facecam::freeSnapshot(faceExport);
    if (Serial.availableForWrite() >= 64) Serial.println("[face-snapshot-cancelled]");
    return;
  }
  const uint32_t started = micros();
  for (int packets = 0; packets < 32 && micros() - started < 3000; ++packets) {
    const facecam::Detection& d = faceExport.detection;
    char line[224];
    int length = 0;
    size_t advance = 0;
    if (!faceExportHeader) {
      length = snprintf(line, sizeof(line), "[face-snapshot] width=%d height=%d bytes=%u faces=%u captured=%u\n",
                        d.width, d.height, (unsigned)faceExport.bytes, (unsigned)d.count,
                        (unsigned)d.captured_ms);
    } else if (faceExportBox < d.count) {
      const facetrack::BBox& box = d.boxes[faceExportBox];
      length = snprintf(line, sizeof(line), "[face-box] %.1f %.1f %.1f %.1f %.3f\n",
                        box.x1, box.y1, box.x2, box.y2, box.score);
    } else if (faceExportOffset < faceExport.bytes) {
      const uint8_t* pixels = reinterpret_cast<const uint8_t*>(faceExport.pixels);
      advance = faceExport.bytes - faceExportOffset;
      if (advance > 96) advance = 96;
      unsigned char encoded[129];
      size_t count = 0;
      if (mbedtls_base64_encode(encoded, sizeof(encoded), &count,
                               pixels + faceExportOffset, advance) != 0) {
        facecam::freeSnapshot(faceExport);
        return;
      }
      length = snprintf(line, sizeof(line), "[face-data] %u %s\n",
                        (unsigned)faceExportOffset, encoded);
    } else {
      length = snprintf(line, sizeof(line), "[face-snapshot-end]\n");
    }
    if (length <= 0 || (size_t)length >= sizeof(line)) {
      facecam::freeSnapshot(faceExport);
      return;
    }
    if (Serial.availableForWrite() < length) return;
    if (Serial.write(reinterpret_cast<const uint8_t*>(line), length) != (size_t)length) {
      facecam::freeSnapshot(faceExport);
      if (Serial.availableForWrite() >= 64) Serial.println("\n[face-snapshot-cancelled]");
      return;
    }
    if (!faceExportHeader) faceExportHeader = true;
    else if (faceExportBox < d.count) ++faceExportBox;
    else if (faceExportOffset < faceExport.bytes) faceExportOffset += advance;
    else { facecam::freeSnapshot(faceExport); return; }
  }
}

static void updateFaceTracking(float dt, uint32_t now) {
  const bool allowed = cfg.face && !faceMaintenance && brain::faceTrackingAllowed();
  facecam::setEnabled(allowed);
  if (!allowed) {
    if (faceWasAllowed || faceOwned) pauseFaceTracking();
    return;
  }
  if (!faceWasAllowed) {
    faceController.reset(plan.physicalLookPan(), plan.physicalLookTilt(), now);
    faceWasAllowed = true;
  }
  facecam::Detection d;
  const facecam::Detection* observed = nullptr;
  if (facecam::takeDetection(d)) {
    now = millis();  // The worker may have published after the loop timestamp.
    const int32_t age = (int32_t)(now - d.captured_ms);
    if (age >= 0 && age <= 450) {
      faceController.observe(d.boxes, d.count, d.width, d.height, d.captured_ms);
      faceObservedFrame=d.sequence;faceObservedAt=d.captured_ms;faceObservedCount=d.count;
      observed = &d;
    }
  }
  const bool directed = plan.directionActive();
  faceController.setActuationEnabled(!directed,
      directed ? plan.pan() : plan.physicalLookPan(),
      directed ? plan.tilt() : plan.physicalLookTilt(), now);
  faceController.update(dt, now);
  const facetrack::Snapshot s = faceController.snapshot();
  facecam::updateTracking(s, observed, now);
  faceOwned = s.locked || s.returning;
  brain::setFacePresence(s.locked && s.lost_ms < 900, s.error_x, s.error_y);
  if (s.locked && s.lost_ms < 900) faceSeenAt = now ? now : 1;
  plan.setFaceLook(!directed && faceOwned, s.pan, s.tilt);
  head.setTrackingLimits(faceOwned && cfg.mot != 0);
  if (s.locked && s.lock_id != lastFaceLock) {
    lastFaceLock = s.lock_id;
    Serial.printf("[face] locked target %u\n", (unsigned)s.lock_id);
  }
}

static void printFaceStatus() {
  const facecam::Status c = facecam::status();
  const facetrack::Snapshot f = faceController.snapshot();
  Serial.printf("[face] enabled=%d camera=%d worker=%d faces=%d frames=%u infer=%ums errors=%u stale=%u locked=%d id=%u tracking=%d ambiguous=%d age=%ums error=%.3f,%.3f pan=%.2f tilt=%.2f %s\n",
                cfg.face, c.initialized, c.running, c.faces, (unsigned)c.frames,
                (unsigned)c.inference_ms, (unsigned)c.errors, (unsigned)c.stale_frames,
                f.locked, (unsigned)f.lock_id, f.tracking, f.ambiguous, (unsigned)f.lost_ms,
                f.error_x, f.error_y, f.pan, f.tilt, c.error);
}

// ---------------- 板子与接口 ----------------
enum BoardKind : uint8_t { BK_CORES3, BK_CORE2, BK_CORE1 };
static BoardKind boardKind() {
#if defined(CONFIG_IDF_TARGET_ESP32S3)
  return BK_CORES3;
#else
  const auto b = M5.getBoard();
  if (b == m5::board_t::board_M5StackCore2 || b == m5::board_t::board_M5Tough) return BK_CORE2;
  return BK_CORE1;
#endif
}
static const char* boardName() {
  switch (boardKind()) {
    case BK_CORES3: return "CoreS3";
    case BK_CORE2: return "Core2";
    default: return "Basic/Gray/Fire";
  }
}

struct PortDef { const char* name; int x, y; };
static PortDef portDef(uint8_t p) {
  static const PortDef s3[3] = {{"Port A", 1, 2}, {"Port C", 18, 17}, {"Port B", 8, 9}};
  static const PortDef c2[3] = {{"Port A", 33, 32}, {"Port C", 13, 14}, {"Stack-chan 主板", 19, 27}};
  static const PortDef c1[3] = {{"Port A", 22, 21}, {"Port C", 16, 17}, {"Stack-chan 主板", 5, 2}};
  if (p > 2) p = 1;
  switch (boardKind()) {
    case BK_CORES3: return s3[p];
    case BK_CORE2: return c2[p];
    default: return c1[p];
  }
}

static const char* servoName(uint8_t t) {
  switch (t) {
    case SERVO_PWM: return "PWM 舵机 (SG90)";
    case SERVO_SCS: return "串口舵机 (SCS0009)";
    case SERVO_K151: return "官方 StackChan 机身";
    default: return "关闭";
  }
}

// 官方机身的零位：自己校准过的 → 出厂固件存在 NVS 里的 → 默认值
static int k151Zero(int axis) {
  const int32_t mine = axis ? cfg.z2 : cfg.z1;
  if (mine >= 0 && mine <= 1000) return mine;
  Preferences p;
  int32_t v = -1;
  if (p.begin("servo", true)) {
    v = p.getInt(axis ? "zero_pos_2" : "zero_pos_1", -1);
    p.end();
  }
  if (v >= 0 && v <= 1000) return v;
  return axis ? PULSE_K151_PITCH_ZERO : PULSE_K151_YAW_ZERO;
}

static void applyMotion() {
  plan.setLimits(motion::limitsFor(cfg.servo));
  plan.setAmp(kAmp[cfg.mot & 3]);
}

static void applyServo() {
  const bool invP = cfg.dir & 1, invT = (cfg.dir >> 1) & 1;
  applyMotion();
  if (cfg.servo == SERVO_K151) {
    if (!bodyOk) {
      head.begin(SERVO_OFF, -1, -1, false, false);
      Serial.println("[servo] 选了官方 StackChan 机身，但没检测到机身");
      return;
    }
    if (!k151PowerCycled) {  // 每次开机第一次用：舵机断电再上电，保证回到位置模式
      body::servoPower(false);
      delay(120);
      k151PowerCycled = true;
    }
    body::servoPower(true);
    const int zy = k151Zero(0), zp = k151Zero(1);
    head.setZero(zy, zp);
    head.begin(SERVO_K151, PULSE_K151_RX, PULSE_K151_TX, invP, invT);
    Serial.printf("[servo] 官方 StackChan 机身（TX G%d / RX G%d），零位 %d / %d\n", PULSE_K151_TX, PULSE_K151_RX, zy, zp);
    return;
  }
  if (bodyOk) {  // 机身舵机不用时断电，头可以用手转
    body::servoPower(false);
    k151PowerCycled = false;
  }
  const PortDef pd = portDef(cfg.port);
  head.begin(cfg.servo, pd.x, pd.y, invP, invT);
  if (cfg.servo != SERVO_OFF)
    Serial.printf("[servo] %s @ %s (G%d, G%d)\n", cfg.servo == SERVO_PWM ? "PWM" : "SCS0009", pd.name, pd.x, pd.y);
  else
    Serial.println("[servo] 关闭（设置里可以选舵机类型）");
}

// ---------------- 设置的保存（v2 用新的存储区，旧版本的设置不会挡住自动识别机身）----------------
static void loadSettings() {
  const bool fresh = !prefs.begin("pulse2", true) || !prefs.isKey("ver");
  if (!fresh) {
    cfg.care = prefs.getUChar("care", PULSE_DEFAULT_CARE);  // 2.8（旧的 mode / show 不再使用）
    cfg.task = prefs.getBool("task", PULSE_DEFAULT_TASK);
    cfg.snd = prefs.getUChar("snd", PULSE_DEFAULT_SOUND);
    cfg.mot = prefs.getUChar("mot", PULSE_DEFAULT_MOTION);
    cfg.servo = prefs.getUChar("servo", PULSE_DEFAULT_SERVO);
    cfg.port = prefs.getUChar("port", PULSE_DEFAULT_PORT);
    cfg.dir = prefs.getUChar("dir", 0);
    cfg.led = prefs.getBool("led", true);
    cfg.face = prefs.getBool("face", PULSE_DEFAULT_FACE_FOLLOW);
    cfg.z1 = prefs.getInt("z1", -1);
    cfg.z2 = prefs.getInt("z2", -1);
    servoUser = prefs.getBool("svU", false);
    cfg.night = prefs.getUChar("night", 0);
    cfg.abrt = prefs.getBool("abrt", true);
    cfg.tz = prefs.getInt("tz", PULSE_TZ_OFFSET);
    cfg.live = prefs.getUChar("live", PULSE_DEFAULT_LIVELY);  // 2.9
    cfg.music = prefs.getBool("music", PULSE_DEFAULT_MUSIC);
    cfg.talk = prefs.getBool("talk", PULSE_DEFAULT_TALK_AUTO);
  }
  prefs.end();
  if (fresh) {  // 第一次运行 v2：只沿用旧版本校准过的中位
    Preferences old;
    if (old.begin("pulse", true)) {
      cfg.z1 = old.getInt("z1", -1);
      cfg.z2 = old.getInt("z2", -1);
      old.end();
    }
  }
  if (cfg.care >= care::L_COUNT) cfg.care = PULSE_DEFAULT_CARE;
  if (cfg.snd > 3) cfg.snd = PULSE_DEFAULT_SOUND;
  if (cfg.mot > 3) cfg.mot = PULSE_DEFAULT_MOTION;
  if (cfg.servo >= kServoTypes) cfg.servo = 0;
  if (cfg.port > 2) cfg.port = 1;
  cfg.dir &= 3;
  if (cfg.night > 1) cfg.night = 0;
  if (cfg.tz < -12 * 3600 || cfg.tz > 14 * 3600) cfg.tz = PULSE_TZ_OFFSET;
  if (cfg.live >= play::LV_COUNT) cfg.live = PULSE_DEFAULT_LIVELY;
}

static void saveSettings() {
  prefs.begin("pulse2", false);
  prefs.putUChar("ver", 2);
  prefs.putUChar("care", cfg.care);
  prefs.putBool("task", cfg.task);
  prefs.putUChar("snd", cfg.snd);
  prefs.putUChar("mot", cfg.mot);
  prefs.putUChar("servo", cfg.servo);
  prefs.putUChar("port", cfg.port);
  prefs.putUChar("dir", cfg.dir);
  prefs.putBool("led", cfg.led);
  prefs.putBool("face", cfg.face);
  prefs.putInt("z1", cfg.z1);
  prefs.putInt("z2", cfg.z2);
  prefs.putBool("svU", servoUser);
  prefs.putUChar("night", cfg.night);
  prefs.putBool("abrt", cfg.abrt);
  prefs.putInt("tz", cfg.tz);
  prefs.putUChar("live", cfg.live);
  prefs.putBool("music", cfg.music);
  prefs.putBool("talk", cfg.talk);
  prefs.end();
}

// ---------------- 设置界面里让头动起来（主循环这时不跑）----------------
static void pumpMotion(uint32_t ms) {
  uint32_t last = millis();
  const uint32_t t0 = last;
  while (millis() - t0 < ms) {
    M5.update();
    updateDirectorCue(millis());  // Maintenance must still release a draining cue lease.
    facecam::maintainSamples(millis());  // Erase expired ROI without starting capture or HTTP.
    const uint32_t n = millis();
    plan.update((n - last) * .001f);
    last = n;
    if (head.active()) head.setTarget(plan.pan(), plan.tilt());
    delay(10);
  }
}

static void motionTest() {
  using namespace motion;
  plan.setIdle(false);
  plan.setBreath(0, 4);
  plan.setBase(0, 0);
  plan.release(.3f);
  plan.lookAt(0, 0, 1);
  pumpMotion(700);
  sfx::play(sfx::C_HOME_HM);
  plan.lookAt(-35, -5, 1);
  pumpMotion(1000);
  plan.lookAt(35, -5, 1);
  pumpMotion(1300);
  plan.lookAt(0, 0, 1);
  pumpMotion(700);
  sfx::play(sfx::C_HOME_NOD_X3);
  plan.play(A_NOD3);
  pumpMotion(1500);
  plan.play(A_SHAKE);
  pumpMotion(1100);
  sfx::play(sfx::C_TRACK_SURPRISE);
  plan.play(A_SURPRISE);
  pumpMotion(1400);
  sfx::play(sfx::C_TRACK_DIZZY);
  plan.play(A_DIZZY);
  pumpMotion(1900);
  plan.lookAt(0, 0, 1);
  pumpMotion(500);
}

// ---------------- 自检页面 ----------------
static void diagLine(int y, const char* label, const char* value, uint32_t col) {
  auto& d = M5.Display;
  d.fillRect(0, y, d.width(), 20, TFT_BLACK);
  d.setTextDatum(textdatum_t::middle_left);
  d.setTextColor(lgfx::color888(150, 158, 172));
  d.drawString(label, 10, y + 10);
  d.setTextColor(col);
  d.drawString(value, 104, y + 10);
}

static void runDiag() {
  auto& d = M5.Display;
  const uint32_t ok = lgfx::color888(124, 245, 176), bad = lgfx::color888(255, 110, 110), mid = lgfx::color888(220, 226, 236);
  d.startWrite();
  d.fillScreen(TFT_BLACK);
  d.setFont(&fonts::efontCN_16);
  d.setTextDatum(textdatum_t::middle_left);
  d.setTextColor(lgfx::color888(139, 243, 255));
  char buf[96];
  snprintf(buf, sizeof(buf), "脉冲 Pulse 自检   v%s  %s", PULSE_VERSION, boardName());
  d.drawString(buf, 10, 14);
  d.drawFastHLine(0, 28, d.width(), lgfx::color888(40, 46, 58));
  d.endWrite();
  head.requestCheck();
  sfx::play(sfx::C_EKKO_BOOT, 1.f, 1.f, true);
  // 一边显示一边动：点头、摇头
  using namespace motion;
  plan.setIdle(false);
  plan.setBase(0, 0);
  plan.lookAt(0, 0, 1);
  plan.play(A_NOD3);
  uint8_t stage = 0;
  uint32_t last = millis(), nextDraw = 0, stageAt = millis() + 1600;
  const uint32_t t0 = millis();
  bool touchWas = true;
  for (;;) {
    M5.update();
    const uint32_t n = millis();
    plan.update((n - last) * .001f);
    last = n;
    if (head.active()) head.setTarget(plan.pan(), plan.tilt());
    if (stage < 3 && n >= stageAt) {
      if (stage == 0) plan.play(A_SHAKE);
      else if (stage == 1) plan.play(A_HEY);
      else head.requestCheck();
      stage++;
      stageAt = n + 1300;
    }
    if (bodyOk) headtouch::update(n);
    sensors::update(n, 0);
    if (n >= nextDraw) {
      nextDraw = n + 300;
      d.startWrite();
      d.setFont(&fonts::efontCN_16);
      int y = 34;
      // 声音
      if (!sfx::ok()) diagLine(y, "声音", "× 喇叭没有启动", bad);
      else if (!cfg.snd) diagLine(y, "声音", "已关闭（设置 → 声音）", mid);
      else { snprintf(buf, sizeof(buf), "√ 正常，音量%s（应该听到开机声）", kLevelName[cfg.snd]); diagLine(y, "声音", buf, ok); }
      y += 22;
      // 舵机
      snprintf(buf, sizeof(buf), "%s%s", servoName(cfg.servo), head.active() ? "" : (cfg.servo ? "（没启动）" : ""));
      diagLine(y, "舵机", buf, head.active() ? mid : (cfg.servo ? bad : mid));
      y += 22;
      if (head.active() && head.type() != SERVO_PWM) {
        char a[48], b[48];
        const int8_t p0 = head.ping(0), p1 = head.ping(1);
        if (p0 < 0) snprintf(a, sizeof(a), "左右 …");
        else if (p0 == 0) snprintf(a, sizeof(a), "左右 × 没应答");
        else snprintf(a, sizeof(a), "左右 √ %d", head.rawPos(0));
        if (p1 < 0) snprintf(b, sizeof(b), "上下 …");
        else if (p1 == 0) snprintf(b, sizeof(b), "上下 × 没应答");
        else snprintf(b, sizeof(b), "上下 √ %d", head.rawPos(1));
        snprintf(buf, sizeof(buf), "%s   %s", a, b);
        diagLine(y, "", buf, (p0 == 0 || p1 == 0) ? bad : ok);
        y += 22;
        if (p0 == 0 || p1 == 0) {
          diagLine(y, "", "检查舵机线 / 电源，USB 供电不足时舵机不动", bad);
          y += 22;
        } else if (head.modeFixed()) {
          diagLine(y, "", "舵机原来在电机模式，已经切回位置模式", ok);
          y += 22;
        }
      } else if (head.active()) {
        snprintf(buf, sizeof(buf), "PWM：G%d / G%d（看头有没有动）", portDef(cfg.port).x, portDef(cfg.port).y);
        diagLine(y, "", buf, mid);
        y += 22;
      }
      snprintf(buf, sizeof(buf), "%s（动作幅度%s）", bodyOk ? "√ 官方 StackChan 机身" : "没检测到官方机身", kLevelName[cfg.mot & 3]);
      diagLine(y, "机身", buf, bodyOk ? ok : mid);
      y += 22;
      if (bodyOk) {
        if (headtouch::ok()) snprintf(buf, sizeof(buf), "√ %s（原始值 0x%02X）", headtouch::touching() ? "摸到了" : "摸一下头顶试试", headtouch::raw());
        else snprintf(buf, sizeof(buf), "× 没有应答");
        diagLine(y, "头顶触摸", buf, headtouch::ok() ? ok : bad);
        y += 22;
      }
      snprintf(buf, sizeof(buf), "%s", sensors::imuOk() ? "√（摇一摇会晕）" : "—");
      diagLine(y, "姿态传感器", buf, sensors::imuOk() ? ok : mid);
      y += 22;
      if (sensors::proxOk()) {
        snprintf(buf, sizeof(buf), "√ %d（平时 %d，手靠近会变大）", sensors::proxValue(), sensors::proxBaseline());
        diagLine(y, "接近传感器", buf, ok);
        y += 22;
      }
      snprintf(buf, sizeof(buf), "生活模式 · 关心提醒%s · 任务提醒%s · 内存 %u KB", care::levelName(cfg.care), cfg.task ? "开" : "关",
               (unsigned)(ESP.getFreeHeap() / 1024));
      diagLine(y, "", buf, mid);
      d.setTextDatum(textdatum_t::bottom_center);
      d.setTextColor(lgfx::color888(110, 118, 132));
      d.drawString("点屏幕或按键返回", d.width() / 2, d.height() - 2);
      d.endWrite();
    }
    const bool touchNow = M5.Touch.getCount() > 0 && M5.Touch.getDetail(0).isPressed();
    if (n - t0 > 600 && ((touchWas && !touchNow && n - t0 > 1500) || M5.BtnA.wasClicked() || M5.BtnB.wasClicked() || M5.BtnC.wasClicked())) break;
    if (!touchNow) touchWas = true;
    if (n - t0 > 60000) break;
    delay(10);
  }
  plan.lookAt(0, 0, 1);
}

// ---------------- 2.7 陪伴：时间 / 光线 / 电量 / 夜间安静 / 亲密度保存 ----------------
enum : uint8_t { CLK_NONE = 0, CLK_RTC, CLK_NTP, CLK_MANUAL };
static const char* const kClockSource[4] = {"none", "rtc", "ntp", "manual"};
static companion::World world;
static uint8_t clockSource = CLK_NONE;
static bool rtcSuspect = false;          // RTC 掉过电：时间不可信，直到联网对时或手动设置
static bool sntpStarted = false;
static uint32_t sntpSyncs = 0, worldAt = 0, battAt = 0, darkSince = 0;
static bool nightWas = false;
static float dispTarget = 1.f, dispF = 1.f;  // 屏幕亮度系数（自动亮度 × 夜间）
static uint32_t bondSavedAt = 0;
static bool bondEverSaved = false;
static constexpr int64_t kMaxValidEpoch = 4102444800LL;  // 2100-01-01：更晚的当作 RTC 乱码

static bool clockTrusted(int64_t t) {
  return clockSource != CLK_NONE && !rtcSuspect && t >= companion::kMinValidEpoch && t < kMaxValidEpoch;
}

static void beginClock() {
  if (M5.Rtc.isEnabled()) {
    clockSource = CLK_RTC;
    rtcSuspect = M5.Rtc.getVoltLow();  // 掉过电的 RTC 读出来的是假时间
  }
  const int64_t t = (int64_t)time(nullptr);
  if (clockTrusted(t)) {
    const auto c = companion::clockFromEpoch(t, cfg.tz);
    Serial.printf("[time] RTC 时间 %02u:%02u（UTC%+.1f）\n", c.hour, c.minute, cfg.tz / 3600.f);
  } else {
    Serial.printf("[time] 还不知道现在几点（%s）%s\n", M5.Rtc.isEnabled() ? (rtcSuspect ? "RTC 掉过电" : "RTC 没对过时") : "没有 RTC",
                  PULSE_STUDIO_VOICE ? "，联网后会自动对时" : "，串口输入 time set YYYY-MM-DD HH:MM 设置");
  }
}

// 设置系统时间（UTC 秒），同时写进 RTC（RTC 存 UTC）
static void setClockUtc(int64_t t, uint8_t source) {
  struct timeval tv;
  tv.tv_sec = (time_t)t;
  tv.tv_usec = 0;
  if (source != CLK_NTP) settimeofday(&tv, nullptr);  // 网络对时已经设好系统时间
  if (M5.Rtc.isEnabled()) {
    const time_t tt = (time_t)t;
    struct tm u;
    gmtime_r(&tt, &u);
    M5.Rtc.setDateTime(&u);
  }
  clockSource = source;
  rtcSuspect = false;
  worldAt = 0;  // 马上刷新
}

static void updateClockSync() {
#if PULSE_STUDIO_VOICE
  if (!sntpStarted && WiFi.status() == WL_CONNECTED) {
    // 系统时间保持 UTC；本地时间由 cfg.tz 换算（不改 TZ，别的模块不受影响）
    configTzTime("UTC0", "ntp.aliyun.com", "ntp.tencent.com", "pool.ntp.org");
    sntpStarted = true;
    Serial.println("[time] 已联网，开始网络对时");
  }
  if (sntpStarted && sntp_get_sync_status() == SNTP_SYNC_STATUS_COMPLETED) {
    const int64_t t = (int64_t)time(nullptr);
    if (t >= companion::kMinValidEpoch && t < kMaxValidEpoch) {
      const bool first = clockSource != CLK_NTP;
      setClockUtc(t, CLK_NTP);
      sntpSyncs++;
      if (first) {
        const auto c = companion::clockFromEpoch(t, cfg.tz);
        Serial.printf("[time] 网络对时完成：%02u:%02u（UTC%+.1f）%s\n", c.hour, c.minute, cfg.tz / 3600.f, M5.Rtc.isEnabled() ? "，已写入 RTC" : "");
      }
    }
  }
#endif
}

static float autoBrightness(float lux) {
  const float lo = log10f(PULSE_ABRT_LOW_LUX), hi = log10f(PULSE_ABRT_HIGH_LUX);
  float t = (log10f(lux > .01f ? lux : .01f) - lo) / (hi - lo);
  t = t < 0.f ? 0.f : (t > 1.f ? 1.f : t);
  return PULSE_ABRT_MIN + (1.f - PULSE_ABRT_MIN) * t;
}

static void updateWorld(uint32_t now) {
  if (worldAt && now - worldAt < 1000) return;
  worldAt = now;
  updateClockSync();
  const int64_t t = (int64_t)time(nullptr);
  world.clock = clockTrusted(t) ? companion::clockFromEpoch(t, cfg.tz) : companion::Clock();
  world.alsOk = sensors::alsOk();
  world.lux = world.alsOk ? sensors::lux() : -1.f;
  world.dark = world.alsOk && sensors::dark();
  if (world.dark) {
    if (!darkSince) darkSince = now | 1;
  } else {
    darkSince = 0;
  }
  if (!battAt || now - battAt >= 15000) {
    battAt = now | 1;
    const int32_t mv = M5.Power.getBatteryVoltage();
    const int32_t level = M5.Power.getBatteryLevel();
    world.battOk = mv >= 3000 && mv <= 4500 && level >= 0 && level <= 100;
    world.battery = world.battOk ? (int8_t)level : -1;
    world.charging = world.battOk && M5.Power.isCharging() == m5::Power_Class::is_charging;
  }
  const bool quiet = world.clock.valid ? companion::quietHours(world.clock.hour, PULSE_QUIET_START, PULSE_QUIET_END)
                                       : (darkSince && now - darkSince >= 300000);
  world.night = cfg.night == 0 && quiet;
  world.quietOn = cfg.night == 0;  // 2.8：关掉「夜间安静」= 也不提醒早点睡
  world.soundOn = cfg.snd != 0;    // 2.8：声音关了就不「叮咚」叫你，只亮灯
  if (world.night != nightWas) {
    nightWas = world.night;
    Serial.println(world.night ? "[world] 夜间安静：声音更小、屏幕更暗、更容易犯困" : "[world] 夜间安静结束");
  }
  brain::setWorld(world);
  sfx::setNightScale(world.night ? PULSE_NIGHT_VOLUME : 1.f);
  float f = cfg.abrt && world.alsOk && world.lux >= 0.f ? autoBrightness(world.lux) : 1.f;
  if (world.night) f *= PULSE_NIGHT_DIM;
  dispTarget = f;
}

static voiceportal::CompanionInfo readCompanion() {
  voiceportal::CompanionInfo info;
  const auto& a = brain::affect();
  const auto& b = brain::bond();
  info.tone = companion::toneKey(a.tone);
  info.toneName = companion::toneName(a.tone);
  info.phase = brain::phaseKey();
  info.valence = a.valence; info.arousal = a.arousal; info.energy = a.energy; info.social = a.social;
  info.level = (uint8_t)(b.level() + 1);
  info.levelName = companion::levelName(b.level());
  info.points = b.points();
  info.progress = b.level() + 1 < companion::kLevels ? b.progress() : 1.f;
  info.streak = b.data().streak;
  info.daysTogether = b.data().daysTogether;
  info.daysKnown = b.daysKnown(brain::bondToday());
  info.night = world.night;
  info.clockValid = world.clock.valid;
  if (world.clock.valid) snprintf(info.localTime, sizeof(info.localTime), "%02u:%02u", world.clock.hour % 24, world.clock.minute % 60);
  info.lux = world.alsOk ? world.lux : -1.f;
  info.battery = world.battOk ? world.battery : -1;
  info.charging = world.charging;
  // 2.8：关心提醒 + 任务提醒
  const uint32_t now = millis();
  const auto& cp = brain::carePlanner();
  info.careLevel = care::levelKey(brain::careLevel());
  info.careHere = cp.hereNow();
  info.sittingMin = cp.sittingMs(now) / 60000u;
  info.presenceTodayMin = cp.presenceTodayMin();
  info.remindersToday = cp.remindersToday();
  info.acksToday = cp.acksToday();
  uint32_t ago = care::kNever;
  info.careLast = brain::careLast(now, &ago);
  info.careLastAgoS = ago == care::kNever ? -1 : (int32_t)(ago / 1000u);
  info.careAwaiting = cp.awaiting(now) ? care::kindKey(cp.awaitingKind(now)) : "";
  const auto& box = brain::noticeInbox();
  info.notifyEnabled = brain::notifyEnabled();
  int fresh = 0;
  for (int i = 0; i < care::Inbox::kCap; i++)
    if (box.slot(i).state == care::NS_NEW) fresh++;
  info.noticeNew = (uint8_t)fresh;
  info.noticePending = (uint8_t)box.pending();
  info.noticeReceived = box.received; info.noticeAcked = box.acked; info.noticeDropped = box.dropped;
  info.noticeExpired = box.expired; info.noticeDuplicates = box.duplicates;
  if (const care::Notice* q = box.latest()) {
    info.noticeKind = care::noticeKey(q->kind);
    info.noticeState = q->state == care::NS_NEW ? "new" : (q->state == care::NS_SHOWN ? "shown" : "done");
    info.noticeTitle = q->title;
    info.noticeSource = q->source;
    info.noticeAgoS = (int32_t)((now - q->at) / 1000u);
  }
  // 2.9：一起玩
  info.lively = play::levelKey(brain::lively());
  info.playing = brain::playKey();
  info.groove = brain::grooveKey();
  info.musicEnabled = brain::musicEnabled();
  info.musicAvailable = musicMicOk;
#if PULSE_STUDIO_VOICE
  info.listening = musicMicOk && voice_audio::ambientStatus().active;
#endif
  const auto& be = brain::lastBeat();
  const uint32_t mago = brain::musicAgo(now);
  info.musicNow = mago != play::kNever && mago < 15000u && brain::musicEnabled();
  info.bpm = info.musicNow && be.music ? be.bpm : 0.f;
  info.beatConfidence = be.confidence;
  info.musicAgoS = mago == play::kNever ? -1 : (int32_t)(mago / 1000u);
  const auto ps = brain::playStats();
  info.games = ps.games; info.gameWins = ps.gameWins; info.dances = ps.dances; info.musicDances = ps.musicDances;
  info.breaths = ps.breaths; info.micro = ps.micro;
  const auto& bids = brain::bids();
  info.bidsOffered = bids.offered; info.bidsAccepted = bids.accepted; info.bidsIgnored = bids.ignored;
  info.bidsToday = bids.today(); info.bidAcceptance = bids.acceptance();
  info.peekRounds = brain::peekaboo().rounds; info.peekFound = brain::peekaboo().found;
  const auto& ml = brain::moodLog();
  if (const uint32_t today = brain::bondToday()) {
    info.moodToday = (int8_t)ml.scoreOn(today);
    info.moodEntries = (uint8_t)ml.entries(today);
    info.moodAverage = ml.average(today);
    info.moodTrend = (int8_t)ml.trend(today);
  }
  info.moodTotal = ml.data().total;
  info.talkAuto = cfg.talk;
  return info;
}

// 2.8：POST /api/notify（主循环里调用）
static uint8_t portalNotify(uint8_t kind, const char* title, const char* source, const char* id, bool* truncated) {
  return brain::notify(kind, title, source, id, truncated);
}
static bool portalNotifyEnabled() { return brain::notifyEnabled(); }

static int displayBrightness(float dt) {
  dispF += (dispTarget - dispF) * (dt * .5f < 1.f ? dt * .5f : 1.f);
  const float base = PULSE_BRIGHTNESS * eng->brightness();
  int b = (int)(base * dispF + .5f);
  const int floorB = base < PULSE_MIN_BRIGHTNESS ? (int)base : PULSE_MIN_BRIGHTNESS;
  return b < floorB ? floorB : b;
}

static void loadBond() {
  Preferences p;
  bool ok = false;
  if (p.begin("pulse_bond", true)) {
    companion::BondData d;
    if (p.getBytesLength("b") == sizeof(d) && p.getBytes("b", &d, sizeof(d)) == sizeof(d)) ok = brain::bondLoad(&d, sizeof(d));
    // 2.9：心情打卡（最近 7 天）
    play::MoodData m;
    if (p.getBytesLength("m") == sizeof(m) && p.getBytes("m", &m, sizeof(m)) == sizeof(m)) {
      if (brain::moodLoad(&m, sizeof(m))) Serial.printf("[mood] 心情打卡记录：一共 %u 次\n", (unsigned)brain::moodLog().data().total);
      else Serial.println("[mood] 心情打卡记录校验失败：从头开始记");
    }
    p.end();
  }
  const auto& b = brain::bond();
  if (ok) {
    bondEverSaved = true;
    bondSavedAt = millis();
    Serial.printf("[bond] 亲密度 Lv%u「%s」%u 点，连续 %u 天，一起有互动的日子 %u 天\n", (unsigned)b.level() + 1, companion::levelName(b.level()),
                  (unsigned)b.points(), (unsigned)b.data().streak, (unsigned)b.data().daysTogether);
  } else {
    Serial.println("[bond] 第一次见面（还没有亲密度记录）");
  }
}

static bool saveBond() {
  const auto& d = brain::bondSave();
  Preferences p;
  if (!p.begin("pulse_bond", false)) return false;
  const size_t n = p.putBytes("b", &d, sizeof(d));
  p.end();
  if (n != sizeof(d)) return false;
  brain::bondClean();
  bondEverSaved = true;
  bondSavedAt = millis();
  return true;
}

// 写 NVS 会短暂卡住 Flash：挑不在对话、不在放声音的时候写
static void maybeSaveBond(uint32_t now) {
  if (!brain::bondDirty()) return;
  if (!brain::bondUrgent() && bondEverSaved && now - bondSavedAt < 600000) return;
  if (conversation::active() || sfx::busy() || M5.Speaker.isPlaying() || voice_audio::status().recording) return;
  if (!saveBond()) {
    bondSavedAt = now;  // 写失败：10 分钟后再试
    bondEverSaved = true;
    Serial.println("[bond] 亲密度保存失败");
  }
}

// 2.9：心情打卡一天最多变几次（问了 / 回答了）：有变化就挑空闲的时候写
static uint32_t moodFailAt = 0;
static void maybeSaveMood(uint32_t now) {
  if (!brain::moodDirty()) return;
  if (moodFailAt && now - moodFailAt < 600000) return;
  if (conversation::active() || sfx::busy() || M5.Speaker.isPlaying() || voice_audio::status().recording) return;
  const auto& d = brain::moodSave();
  Preferences p;
  bool ok = false;
  if (p.begin("pulse_bond", false)) {
    ok = p.putBytes("m", &d, sizeof(d)) == sizeof(d);
    p.end();
  }
  if (ok) {
    brain::moodClean();
    moodFailAt = 0;
  } else {
    moodFailAt = now ? now : 1;  // 写失败：10 分钟后再试
    Serial.println("[mood] 心情打卡记录保存失败");
  }
}

// ---------------- 设置界面 ----------------
enum RowKind : uint8_t { R_BOND, R_CARE, R_TASK, R_LIVE, R_MUSIC, R_TALK, R_SND, R_NIGHT, R_ABRT, R_MOT, R_FACE, R_SERVO, R_PORT, R_DIR, R_LED, R_TEST, R_CAL, R_DIAG, R_SAVE };
static const int kMaxRows = 20, kRowH = 30, kTop = 34, kFoot = 22;
static bool calibrating = false;

static int buildRows(RowKind* r) {
  int n = 0;
  r[n++] = R_BOND;
  r[n++] = R_CARE;
  r[n++] = R_TASK;
  r[n++] = R_LIVE;                // 2.9
  if (musicMicOk) r[n++] = R_MUSIC;
  if (PULSE_STUDIO_VOICE) r[n++] = R_TALK;
  r[n++] = R_SND;
  r[n++] = R_NIGHT;
  if (sensors::alsOk()) r[n++] = R_ABRT;
  r[n++] = R_MOT;
  if (PULSE_FACE_FOLLOW) r[n++] = R_FACE;
  r[n++] = R_SERVO;
  if (cfg.servo != SERVO_K151 && cfg.servo != SERVO_OFF) r[n++] = R_PORT;
  r[n++] = R_DIR;
  if (bodyOk) r[n++] = R_LED;
  r[n++] = R_TEST;
  if (cfg.servo == SERVO_K151 && bodyOk) r[n++] = R_CAL;
  r[n++] = R_DIAG;
  r[n++] = R_SAVE;
  return n;
}

static int visibleRows() { return (M5.Display.height() - kTop - kFoot) / kRowH; }

static void drawSettings(int sel, int first, const char* status) {
  auto& d = M5.Display;
  const int W = d.width(), H = d.height();
  RowKind rows[kMaxRows];
  const int n = buildRows(rows), vis = visibleRows();
  d.startWrite();
  d.fillScreen(TFT_BLACK);
  d.setFont(&fonts::efontCN_16);
  d.setTextDatum(textdatum_t::middle_left);
  d.setTextColor(lgfx::color888(139, 243, 255));
  d.drawString("脉冲 Pulse · 设置", 10, 17);
  d.setTextDatum(textdatum_t::middle_right);
  d.setTextColor(lgfx::color888(90, 98, 112));
  d.drawString("v" PULSE_VERSION, W - 10, 17);
  d.drawFastHLine(0, 32, W, lgfx::color888(40, 46, 58));
  char val[64];
  for (int k = 0; k < vis && first + k < n; k++) {
    const int i = first + k, y = kTop + k * kRowH;
    const bool s = i == sel;
    if (s) d.fillRoundRect(4, y + 1, W - 12, kRowH - 2, 6, lgfx::color888(28, 44, 58));
    const char* label = "";
    val[0] = 0;
    switch (rows[i]) {
      case R_BOND: {
        label = "陪伴";
        const auto& b = brain::bond();
        const uint32_t known = b.daysKnown(brain::bondToday());
        if (known)
          snprintf(val, sizeof(val), "Lv%u %s · 第%u天", (unsigned)b.level() + 1, companion::levelName(b.level()), (unsigned)known);
        else
          snprintf(val, sizeof(val), "Lv%u %s", (unsigned)b.level() + 1, companion::levelName(b.level()));
      } break;
      case R_CARE: label = "关心提醒"; snprintf(val, sizeof(val), "%s", care::levelName(cfg.care)); break;
      case R_TASK: label = "任务提醒"; snprintf(val, sizeof(val), "%s", cfg.task ? "开（Ekko Studio）" : "关"); break;
      case R_LIVE: label = "活跃度"; snprintf(val, sizeof(val), "%s", play::levelName(cfg.live)); break;
      case R_MUSIC: label = "听歌跳舞"; snprintf(val, sizeof(val), "%s", cfg.music ? "开（本机听节拍）" : "关"); break;
      case R_TALK: label = "对话自动结束"; snprintf(val, sizeof(val), "%s", cfg.talk ? "开" : "关（一直听）"); break;
      case R_SND: label = "声音"; snprintf(val, sizeof(val), "%s", sfx::levelName(cfg.snd)); break;
      case R_NIGHT:
        label = "夜间安静";
        if (cfg.night) snprintf(val, sizeof(val), "关");
        else if (brain::world().clock.valid) snprintf(val, sizeof(val), "自动 %02d:00-%02d:00%s", PULSE_QUIET_START, PULSE_QUIET_END, brain::world().night ? " · 现在" : "");
        else snprintf(val, sizeof(val), "自动（按房间明暗）%s", brain::world().night ? " · 现在" : "");
        break;
      case R_ABRT: label = "自动亮度"; snprintf(val, sizeof(val), "%s", cfg.abrt ? "开（跟随环境光）" : "关"); break;
      case R_MOT: label = "动作幅度"; snprintf(val, sizeof(val), "%s", kLevelName[cfg.mot & 3]); break;
      case R_FACE: label = "人脸跟随"; snprintf(val, sizeof(val), "%s", cfg.face ? (facecam::status().initialized ? "开启" : "相机未就绪") : "关闭"); break;
      case R_SERVO: label = "舵机类型"; snprintf(val, sizeof(val), "%s", servoName(cfg.servo)); break;
      case R_PORT: {
        label = "接口";
        const PortDef pd = portDef(cfg.port);
        snprintf(val, sizeof(val), "%s  G%d/G%d", pd.name, pd.x, pd.y);
      } break;
      case R_DIR: label = "方向"; snprintf(val, sizeof(val), "%s", kDirName[cfg.dir & 3]); break;
      case R_LED: label = "机身灯光"; snprintf(val, sizeof(val), "%s", cfg.led ? "开" : "关"); break;
      case R_TEST: label = "测试动作"; snprintf(val, sizeof(val), "%s", cfg.servo == SERVO_OFF ? "（先选舵机类型）" : "点一下开始"); break;
      case R_CAL:
        label = calibrating ? "保存为中位" : "校准中位";
        snprintf(val, sizeof(val), "%s", calibrating ? "摆好后点这里" : "用手摆正头部");
        break;
      case R_DIAG: label = "自检"; snprintf(val, sizeof(val), "声音 / 舵机 / 触摸"); break;
      case R_SAVE: label = "保存并返回"; break;
    }
    d.setTextColor(s ? TFT_WHITE : lgfx::color888(200, 206, 216));
    d.setTextDatum(textdatum_t::middle_left);
    d.drawString(label, 14, y + kRowH / 2);
    if (val[0]) {
      d.setTextColor(s ? lgfx::color888(139, 243, 255) : lgfx::color888(140, 150, 166));
      d.setTextDatum(textdatum_t::middle_right);
      d.drawString(val, W - 18, y + kRowH / 2);
    }
  }
  if (n > vis) {  // 滚动条
    const int trackH = vis * kRowH, barH = trackH * vis / n, barY = kTop + (trackH - barH) * first / (n - vis);
    d.fillRect(W - 5, kTop, 3, trackH, lgfx::color888(30, 34, 42));
    d.fillRect(W - 5, barY, 3, barH, lgfx::color888(100, 110, 126));
  }
  d.setTextDatum(textdatum_t::bottom_center);
  d.setTextColor(lgfx::color888(110, 118, 132));
  d.drawString(status ? status : "点选一行修改，上下滑动翻页   按键：A 上 / B 确定 / C 下", W / 2, H - 2);
  d.endWrite();
}

static void calibrateRow(char* status, size_t n) {
  if (!calibrating) {
    if (head.type() != SERVO_K151) applyServo();
    if (head.calibrateStart()) {
      calibrating = true;
      snprintf(status, n, "已松开：把头摆正后再点一次");
    } else {
      snprintf(status, n, "舵机没准备好，稍后再试");
    }
    return;
  }
  int a = 0, b = 0;
  calibrating = false;
  if (head.calibrateCapture(a, b)) {
    cfg.z1 = a;
    cfg.z2 = b;
    saveSettings();
    snprintf(status, n, "已保存中位：%d / %d", a, b);
  } else {
    snprintf(status, n, "读不到舵机位置，中位没改");
  }
}

enum : uint8_t { ACT_STAY = 0, ACT_EXIT };

static uint8_t activateRow(RowKind kind, int sel, int first, char* status, size_t n) {
  status[0] = 0;
  if (calibrating && kind != R_CAL) {  // 校准到一半去点别的：先恢复扭矩
    head.calibrateCancel();
    calibrating = false;
  }
  switch (kind) {
    case R_BOND: {
      const auto& b = brain::bond();
      const auto& d = b.data();
      if (b.level() + 1 < companion::kLevels)
        snprintf(status, n, "%u点 · 升级%d%% · 连续%u天 · %s", (unsigned)b.points(), (int)(b.progress() * 100.f + .5f), (unsigned)d.streak,
                 companion::toneName(brain::affect().tone));
      else
        snprintf(status, n, "%u点 · 满级 · 连续%u天 · %s", (unsigned)b.points(), (unsigned)d.streak, companion::toneName(brain::affect().tone));
    } break;
    case R_CARE:  // 开 → 少一点 → 关 → 开
      cfg.care = cfg.care == care::L_OFF ? (uint8_t)care::L_ON : (uint8_t)(cfg.care - 1);
      brain::setCareLevel(cfg.care);
      snprintf(status, n, "%s", cfg.care == care::L_ON ? "坐久了、到饭点、很晚了都会关心你"
                                : (cfg.care == care::L_LESS ? "少提醒一点，间隔长一点" : "不主动提醒（任务提醒照常）"));
      break;
    case R_TASK:
      cfg.task = !cfg.task;
      brain::setNotifyEnabled(cfg.task);
      snprintf(status, n, "%s", cfg.task ? "Ekko Studio 任务完成会叫你、夸你" : "不接收任务提醒");
      break;
    case R_LIVE:  // 活泼 → 适中 → 安静 → 活泼
      cfg.live = cfg.live == play::LV_QUIET ? (uint8_t)play::LV_LIVELY : (uint8_t)(cfg.live - 1);
      brain::setLively(cfg.live);
      snprintf(status, n, "%s", cfg.live == play::LV_LIVELY ? "常有小反应，会主动找你玩"
                                : (cfg.live == play::LV_NORMAL ? "偶尔有小反应，少找你玩一点" : "和 2.8 一样安静；连拍照常"));
      break;
    case R_MUSIC:
      cfg.music = !cfg.music;
      brain::setMusicEnabled(cfg.music);
      snprintf(status, n, "%s", cfg.music ? "放歌时跟着跳；只在本机听节拍" : "不跳舞，也不用麦克风听歌");
      break;
    case R_TALK:
      cfg.talk = !cfg.talk;
      snprintf(status, n, "%s", cfg.talk ? "不说话 / 说再见就不听了" : "一直听，点右上角才结束");
      break;
    case R_SND:
      cfg.snd = (cfg.snd + 1) % 4;
      sfx::setLevel(cfg.snd);
      sfx::preview();
      break;
    case R_NIGHT:
      cfg.night = cfg.night ? 0 : 1;
      snprintf(status, n, "%s", cfg.night ? "夜里也和白天一样" : "夜里更安静、更暗，更容易睡着");
      break;
    case R_ABRT:
      cfg.abrt = !cfg.abrt;
      snprintf(status, n, "%s", cfg.abrt ? "屏幕亮度跟随房间明暗" : "屏幕保持固定亮度");
      break;
    case R_MOT:
      cfg.mot = (cfg.mot + 1) % 4;
      applyMotion();
      drawSettings(sel, first, cfg.mot ? "试一下：点头" : "动作已关闭：头不会动");
      if (cfg.mot) {
        plan.play(motion::A_NOD);
        pumpMotion(800);
      }
      snprintf(status, n, "%s", cfg.mot ? "幅度太大撞到东西就调小一档" : "动作已关闭：头不会动");
      break;
    case R_FACE:
      cfg.face = !cfg.face;
      pauseFaceTracking();
      snprintf(status, n, "%s", cfg.face ? "返回后自动寻找并跟随人脸" : "人脸跟随已关闭");
      break;
    case R_SERVO:
      cfg.servo = (cfg.servo + 1) % kServoTypes;
      servoUser = true;
      applyMotion();
      break;
    case R_PORT: cfg.port = (cfg.port + 1) % 3; break;
    case R_DIR: cfg.dir = (cfg.dir + 1) & 3; break;
    case R_LED:
      cfg.led = !cfg.led;
      if (!cfg.led) body::setAll(0, 0, 0);
      ledSent = -1;
      break;
    case R_TEST:
      if (cfg.servo == SERVO_OFF) { snprintf(status, n, "舵机类型是「关闭」，先选一种舵机"); break; }
      if (cfg.servo == SERVO_K151 && !bodyOk) { snprintf(status, n, "没检测到官方 StackChan 机身"); break; }
      applyServo();
      drawSettings(sel, first, "测试中：左右看 → 点头 → 摇头 → 抬头 → 画圈");
      motionTest();
      snprintf(status, n, "测试完成。方向反了就改「方向」");
      break;
    case R_CAL: calibrateRow(status, n); break;
    case R_DIAG:
      applyServo();
      runDiag();
      break;
    case R_SAVE: return ACT_EXIT;
  }
  return ACT_STAY;
}

static void runSettings() {
  stopVoice();
  faceMaintenance = true;
  pauseFaceTracking();
  plan.setIdle(false);
  plan.release(.3f);
  plan.lookAt(0, 0, .8f);
  pumpMotion(10);
  sfx::stop();
  int sel = 0, first = 0;
  char status[96] = {0};
  calibrating = false;
  drawSettings(sel, first, "松开手指");
  // 等手指 / 按键松开，避免长按直接触发第一行
  for (uint32_t t0 = millis(); millis() - t0 < 5000;) {
    M5.update();
    const bool tp = M5.Touch.getCount() > 0 && M5.Touch.getDetail(0).isPressed();
    if (!tp && !M5.BtnB.isPressed()) break;
    pumpMotion(10);
  }
  drawSettings(sel, first, nullptr);
  uint32_t lastInput = millis();
  const int H = M5.Display.height();
  uint8_t result = ACT_STAY;
  bool down = false, scrolled = false;
  int y0 = 0, first0 = 0;
  while (result == ACT_STAY) {
    M5.update();
    RowKind rows[kMaxRows];
    const int n = buildRows(rows), vis = visibleRows();
    if (sel >= n) sel = n - 1;
    const int maxFirst = n > vis ? n - vis : 0;
    bool redraw = false;
    int hit = -1;
    if (M5.BtnA.wasClicked()) { sel = (sel + n - 1) % n; redraw = true; }
    if (M5.BtnC.wasClicked()) { sel = (sel + 1) % n; redraw = true; }
    if (M5.BtnB.wasClicked()) hit = sel;
    // 触摸：点一行 = 选中并修改；上下拖 = 翻页
    const bool tp = M5.Touch.getCount() > 0 && M5.Touch.getDetail(0).isPressed();
    if (tp) {
      const auto& t = M5.Touch.getDetail(0);
      if (!down) { down = true; scrolled = false; y0 = t.y; first0 = first; }
      else {
        const int dy = t.y - y0;
        if (abs(dy) > 12) scrolled = true;
        if (scrolled) {
          int f = first0 - (dy + (dy > 0 ? kRowH / 2 : -kRowH / 2)) / kRowH;
          f = f < 0 ? 0 : (f > maxFirst ? maxFirst : f);
          if (f != first) { first = f; redraw = true; }
        }
      }
      lastInput = millis();
    } else if (down) {
      down = false;
      if (!scrolled && y0 >= kTop && y0 < kTop + vis * kRowH && y0 < H) {
        const int i = first + (y0 - kTop) / kRowH;
        if (i < n) hit = sel = i;
      }
    }
    if (hit >= 0) {
      result = activateRow(rows[hit], sel, first, status, sizeof(status));
      redraw = true;
      lastInput = millis();
    }
    // 选中的行保持在可见范围内
    const int n2 = buildRows(rows);
    if (sel >= n2) sel = n2 - 1;
    const int maxFirst2 = n2 > vis ? n2 - vis : 0;
    if (sel < first) { first = sel; redraw = true; }
    if (sel >= first + vis) { first = sel - vis + 1; redraw = true; }
    if (first > maxFirst2) { first = maxFirst2; redraw = true; }
    if (redraw && result == ACT_STAY) {
      lastInput = millis();
      drawSettings(sel, first, status[0] ? status : nullptr);
    }
    if (millis() - lastInput > 45000) result = ACT_EXIT;  // 45 秒没操作就自动保存退出
    pumpMotion(10);
  }
  if (calibrating) {
    head.calibrateCancel();
    calibrating = false;
  }
  saveSettings();
  applyServo();
  sfx::setLevel(cfg.snd);
  M5.Display.fillScreen(TFT_BLACK);
  eng->repaintOutside();
  brain::setCareLevel(cfg.care);
  brain::setNotifyEnabled(cfg.task);
  brain::setLively(cfg.live);
  brain::setMusicEnabled(cfg.music);
  faceMaintenance = false;
  lastUs = micros();
}

// ---------------- 串口命令 ----------------
static void printWrapped(const char* indent, const char* words, size_t width) {
  size_t col = 0;
  for (const char* p = words; *p;) {
    while (*p == ' ') p++;
    if (!*p) break;
    const char* e = p;
    while (*e && *e != ' ') e++;
    const size_t n = (size_t)(e - p);
    if (col == 0) { Serial.print(indent); col = strlen(indent); }
    else if (col + 1 + n > width) { Serial.println(); Serial.print(indent); col = strlen(indent); }
    else { Serial.print(' '); col++; }
    Serial.write((const uint8_t*)p, n);
    col += n;
    p = e;
  }
  if (col) Serial.println();
}

static void printHelp() {
  Serial.println(F("—— 脉冲 Pulse 串口命令（2.9 活泼版：只有生活模式）——"));
  Serial.println(F("  00–41 或中文名             切换到某个状态（带声音和动作）；list 状态列表"));
  Serial.println(F("  act <名字>                 头部动作，例如 act nod、act dizzy；acts 列出全部"));
  Serial.println(F("  play <名字>                播放音效，例如 play home_joy；clips / sounds 列出全部"));
  Serial.println(F("  poke / pet / sleep / wake  戳一下 / 摸摸 / 睡觉 / 叫醒"));
  Serial.println(F("  sound off|low|mid|high     音量；motion off|low|mid|high 动作幅度"));
  Serial.println(F("  servo off|pwm|scs|stackchan；port a|c|b；dir 0-3；led on|off"));
  Serial.println(F("  diag 自检信息；test 测试动作；help 帮助"));
  Serial.println(F("  face on|off|status         真实人脸跟随（本机检测、平滑和目标锁定；关心提醒靠它知道你在不在）"));
  Serial.println(F("  face snapshot              仅本地串口输出当前相机诊断帧"));
  Serial.println(F("  voice new                  结束旧对话，创建持久的新聊天并开启监听"));
  Serial.println(F("—— 陪伴 ——"));
  Serial.println(F("  mood / bond                现在的心情 / 亲密度（等级、点数、连续天数、纪念日）"));
  Serial.println(F("  time / time tz 8 / time set 2025-05-20 13:14   查看 / 时区 / 手动设置本地时间"));
  Serial.println(F("  night auto|off             夜间安静（22:00–07:00 更安静、更暗；关掉也就不提醒早点睡）"));
  Serial.println(F("  light 环境光；batt 电量；brightness auto|fixed 屏幕亮度跟随环境光 / 固定"));
  Serial.println(F("  preview <名字>             预览小剧场（previews 列出全部名字）"));
  Serial.println(F("—— 2.8 会关心人 + 任务提醒 ——"));
  Serial.println(F("  care                       关心提醒状态（这次坐了多久、今天提醒了几次、你回应了几次）"));
  Serial.println(F("  care on|less|off           关心提醒：开 / 少一点 / 关（起来活动、喝水、吃饭、早点睡）"));
  Serial.println(F("  notify                     任务提醒状态（收件箱）"));
  Serial.println(F("  notify on|off              任务提醒开关（关掉后 POST /api/notify 返回 409）"));
  Serial.println(F("  notify done|failed|remind|praise [标题]   模拟 Ekko Studio 送来一条（来源 serial）"));
  Serial.println(F("  ack                        「知道啦 / 收到」（和摸摸它、按一下按键一样）"));
  Serial.println(F("—— 2.9 一起玩 ——"));
  Serial.println(F("  lively [quiet|normal|lively]  活跃度：安静（和 2.8 一样）/ 适中 / 活泼；不带参数 = 状态和统计"));
  Serial.println(F("  dance / game / breathe [1-3] / stop   跳一段 / 节奏游戏 / 一起深呼吸 1–3 分钟 / 停下正在玩的"));
  Serial.println(F("  mood log|ask|clear|1-5     心情打卡：最近 7 天 / 现在就问 / 清空 / 直接记今天几分"));
  Serial.println(F("  music on|off|status        听歌跳舞（麦克风只在本机算节拍，不录音、不上传）"));
  Serial.println(F("  talk auto|off              对话自动结束（一会儿不说话 / 说再见 / 连着两次没听清就不再听）"));
  Serial.println(F("  手势：连拍 2 下 = 跳舞；连拍 3 下 = 节奏游戏；按住头顶不动 3.5 秒 = 一起深呼吸（点一下停）"));
}

static void printPreviews() {
  Serial.println(F("[preview] preview <名字> 可以预览："));
  printWrapped("  ", brain::previewNames(), 96);
}

static int levelArg(const char* v) {
  if (!strcmp(v, "off") || !strcmp(v, "0")) return 0;
  if (!strcmp(v, "low") || !strcmp(v, "1")) return 1;
  if (!strcmp(v, "mid") || !strcmp(v, "on") || !strcmp(v, "2")) return 2;
  if (!strcmp(v, "high") || !strcmp(v, "3")) return 3;
  return -1;
}

static void printDiag() {
  Serial.printf("[diag] 脉冲 Pulse v%s，%s，生活模式（%s）；关心提醒 %s，任务提醒 %s\n", PULSE_VERSION, boardName(), brain::phaseName(),
                care::levelName(brain::careLevel()), brain::notifyEnabled() ? "开" : "关");
  Serial.printf("[diag] 声音：%s，音量 %s\n", sfx::ok() ? "喇叭正常" : "喇叭没有启动", sfx::levelName(cfg.snd));
  Serial.printf("[diag] 舵机：%s（%s），动作幅度 %s，方向 %s\n", servoName(cfg.servo), head.active() ? "已启动" : "没启动", kLevelName[cfg.mot & 3],
                kDirName[cfg.dir & 3]);
  if (head.active() && head.type() != SERVO_PWM)
    Serial.printf("[diag]   左右舵机：%s（位置 %d），上下舵机：%s（位置 %d）%s\n", head.ping(0) == 1 ? "正常" : (head.ping(0) == 0 ? "没有应答" : "检测中"),
                  head.rawPos(0), head.ping(1) == 1 ? "正常" : (head.ping(1) == 0 ? "没有应答" : "检测中"), head.rawPos(1),
                  head.modeFixed() ? "，已从电机模式切回位置模式" : "");
  Serial.printf("[diag] 机身：%s；头顶触摸：%s（0x%02X）；姿态传感器：%s；接近传感器：%s（%d / 基线 %d）\n", bodyOk ? "官方 StackChan" : "没检测到",
                headtouch::ok() ? "正常" : "—", headtouch::raw(), sensors::imuOk() ? "正常" : "—", sensors::proxOk() ? "正常" : "—", sensors::proxValue(),
                sensors::proxBaseline());
  Serial.printf("[diag] 头部目标 pan %.1f° tilt %.1f°；内存 %u，PSRAM %u\n", plan.pan(), plan.tilt(), (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getFreePsram());
  {
    const auto& a = brain::affect();
    const auto& b = brain::bond();
    Serial.printf("[diag] 陪伴：心情「%s」，亲密度 Lv%u「%s」%u 点，连续 %u 天；时间 %s；夜间安静 %s%s；环境光 %s；电量 %s\n",
                  companion::toneName(a.tone), (unsigned)b.level() + 1, companion::levelName(b.level()), (unsigned)b.points(),
                  (unsigned)b.data().streak, world.clock.valid ? kClockSource[clockSource] : "未知", cfg.night ? "关" : "自动",
                  world.night ? "（现在是夜里）" : "", world.alsOk ? (world.lux >= 0.f ? "正常" : "启动中") : "—",
                  world.battOk ? (world.charging ? "充电中" : "正常") : "—");
  }
  Serial.printf("[diag] 一起玩：活跃度 %s，听歌跳舞 %s，对话自动结束 %s\n", play::levelName(brain::lively()),
                !musicMicOk ? "—（没有麦克风）" : (brain::musicEnabled() ? "开" : "关"), cfg.talk ? "开" : "关");
  head.requestCheck();
  printFaceStatus();
}

static void printMood() {
  const auto& a = brain::affect();
  Serial.printf("[mood] 基调「%s」(%s，已持续 %.0f 秒)  开心 %+.2f  兴奋 %.2f  精神 %.2f  想人陪 %.2f  亲密底色 %.2f  （%s）\n",
                companion::toneName(a.tone), companion::toneKey(a.tone), a.toneAge, a.valence, a.arousal, a.energy, a.social, a.warmth,
                brain::phaseName());
}

// 2.9：一起玩的状态和统计
static const char* playName(const char* key) {
  if (!strcmp(key, "rhythm")) return "节奏游戏";
  if (!strcmp(key, "dance")) return "跳舞";
  if (!strcmp(key, "breath")) return "一起深呼吸";
  if (!strcmp(key, "mood")) return "心情打卡";
  return "没在玩";
}
static void printMusic() {
  const uint32_t now = millis();
  if (!musicMicOk) {
    Serial.println("[music] 这台没有可用的麦克风：连拍两下会自己「啦啦啦」跳一段");
    return;
  }
  Serial.printf("[music] 听歌跳舞：%s（%s）；麦克风只在本机算节拍，不录音、不上传；夜里、聊天时、在玩别的时候不听\n",
                brain::musicEnabled() ? "开" : "关", brain::grooveKey());
  const uint32_t ago = brain::musicAgo(now);
  const auto& be = brain::lastBeat();
  if (ago != play::kNever) Serial.printf("[music] 最近一次听到在放歌：%u 秒前", (unsigned)(ago / 1000u));
  else Serial.print("[music] 开机以来还没听到在放歌");
  if (be.analyses) Serial.printf("；最近一次分析：%s，%.0f BPM，把握 %.0f%%，音量 %.0f", be.music ? "有节拍" : "没有稳定节拍", be.bpm, be.confidence * 100.f, be.level);
  Serial.println();
}
static void printPlay() {
  const auto ps = brain::playStats();
  const auto& bd = brain::bids();
  const auto& pk = brain::peekaboo();
  Serial.printf("[play] 活跃度：%s（%s）；现在：%s\n", play::levelName(brain::lively()), play::levelKey(brain::lively()), playName(brain::playKey()));
  Serial.printf("[play] 开机以来：节奏游戏 %u 局（过关 %u），跳舞 %u 次（跟着歌 %u 次），深呼吸 %u 次，看着你时的小反应 %u 次\n",
                (unsigned)ps.games, (unsigned)ps.gameWins, (unsigned)ps.dances, (unsigned)ps.musicDances, (unsigned)ps.breaths, (unsigned)ps.micro);
  Serial.printf("[play] 主动找你玩：%u 次，你接了 %u 次、没理 %u 次（今天 %u 次，最近接受率 %.0f%%）；躲猫猫 %u 轮，找到你 %u 次\n",
                (unsigned)bd.offered, (unsigned)bd.accepted, (unsigned)bd.ignored, (unsigned)bd.today(), bd.acceptance() * 100.f,
                (unsigned)pk.rounds, (unsigned)pk.found);
  printMusic();
}
static void printMoodLog() {
  const auto& ml = brain::moodLog();
  const uint32_t today = brain::bondToday();
  if (!today) {
    Serial.printf("[mood] 心情打卡：还不知道今天几号（对时后每晚 19:30–22:00 看见你时问一次）；一共打过 %u 次\n", (unsigned)ml.data().total);
    return;
  }
  const int s = ml.scoreOn(today), n = ml.entries(today);
  if (s > 0) Serial.printf("[mood] 心情打卡：今天 %d 分；最近 7 天打了 %d 次", s, n);
  else Serial.printf("[mood] 心情打卡：今天还没打；最近 7 天打了 %d 次", n);
  if (n) {
    const int t = ml.trend(today);
    Serial.printf("，平均 %.1f 分，%s", ml.average(today), t > 0 ? "在变好" : (t < 0 ? "有点往下" : "差不多"));
  }
  Serial.printf("；一共 %u 次\n[mood] 最近 7 天（旧 → 新）：", (unsigned)ml.data().total);
  for (int d = 6; d >= 0; d--) {
    const int v = today >= (uint32_t)d ? ml.scoreOn(today - (uint32_t)d) : -1;
    if (v > 0) Serial.printf("%d ", v);
    else Serial.print("· ");
  }
  Serial.println();
  if (ml.persistentLow(today)) Serial.println("[mood] 最近好几天分数都偏低。累了就歇一歇；需要的话，和信任的人聊聊");
}

static void printBond() {
  const auto& b = brain::bond();
  const auto& d = b.data();
  const uint32_t today = brain::bondToday(), known = b.daysKnown(today);
  Serial.printf("[bond] Lv%u「%s」%u 点", (unsigned)b.level() + 1, companion::levelName(b.level()), (unsigned)b.points());
  if (b.level() + 1 < companion::kLevels)
    Serial.printf("（下一级「%s」还差 %u 点，进度 %.0f%%）", companion::levelName(b.level() + 1),
                  (unsigned)(companion::levelPoints(b.level() + 1) - b.points()), b.progress() * 100.f);
  Serial.println();
  if (known) Serial.printf("[bond] 认识的第 %u 天；", (unsigned)known);
  else Serial.print("[bond] 还不知道今天几号（对时后开始记天数）；");
  Serial.printf("连续见面 %u 天（最长 %u 天），有互动的日子 %u 天\n", (unsigned)d.streak, (unsigned)d.bestStreak, (unsigned)d.daysTogether);
  Serial.printf("[bond] 一共被摸 %u 次、聊天 %u 句、见面 %u 次、开机相处 %u 分钟", (unsigned)d.touches, (unsigned)d.chats, (unsigned)d.faces,
                (unsigned)d.minutes);
  int next = -1;
  for (int i = 0; i < companion::kMilestones; i++)
    if (!(d.milestones & (1u << i))) { next = i; break; }
  if (known && next >= 0) Serial.printf("；下一个纪念日：第 %u 天", (unsigned)companion::kMilestoneDays[next]);
  Serial.println();
}

static void printCare() {
  const uint32_t now = millis();
  const auto& p = brain::carePlanner();
  uint32_t ago = care::kNever;
  brain::careLast(now, &ago);
  Serial.printf("[care] 关心提醒：%s（%s）；%s", care::levelName(brain::careLevel()), care::levelKey(brain::careLevel()),
                p.hereNow() ? "觉得你就在附近" : "现在觉得你不在");
  if (p.hereNow()) Serial.printf("，这次坐了 %u 分钟", (unsigned)(p.sittingMs(now) / 60000u));
  Serial.printf("；今天陪了它 %u 分钟，提醒 %u 次，你回应 %u 次\n", (unsigned)p.presenceTodayMin(), (unsigned)p.remindersToday(),
                (unsigned)p.acksToday());
  if (ago != care::kNever)
    Serial.printf("[care] 最近一次：%s（%u 分钟前）%s\n", care::kindName(p.lastKind()), (unsigned)(ago / 60000u),
                  p.awaiting(now) ? "，正在等你回应（摸摸它 = 知道啦）" : "");
  else
    Serial.println("[care] 开机以来还没提醒过");
  if (!world.clock.valid) Serial.println("[care] 还不知道几点：吃饭 / 早点睡先不提醒（连上 Wi-Fi 自动对时，或者 time set）");
  if (cfg.night) Serial.println("[care] 「夜间安静」关着：不提醒早点睡");
  if (!PULSE_FACE_FOLLOW || !cfg.face)
    Serial.println("[care] 人脸跟随没开：只能靠摸它 / 和它说话 / 靠近来知道你在不在（提醒会少很多）");
}

static void printNotify() {
  const uint32_t now = millis();
  const auto& box = brain::noticeInbox();
  int fresh = 0, shown = 0;
  for (int i = 0; i < care::Inbox::kCap; i++) {
    const uint8_t st = box.slot(i).state;
    if (st == care::NS_NEW) fresh++;
    else if (st == care::NS_SHOWN) shown++;
  }
  Serial.printf("[notify] 任务提醒：%s；还没演的 %d 条，演过了等你摸它的 %d 条\n",
                brain::notifyEnabled() ? "开（Ekko Studio → POST /api/notify）" : "关", fresh, shown);
  Serial.printf("[notify] 开机以来：收到 %u，演出 %u，你收到 %u，重复 %u，挤掉 %u，过期 %u\n", (unsigned)box.received,
                (unsigned)box.delivered, (unsigned)box.acked, (unsigned)box.duplicates, (unsigned)box.dropped, (unsigned)box.expired);
  if (const care::Notice* q = box.latest())
    Serial.printf("[notify] 最近一条：%s「%s」%s%s%s，%u 秒前，%s\n", care::noticeName(q->kind), q->title, q->source[0] ? "（来自 " : "",
                  q->source, q->source[0] ? "）" : "", (unsigned)((now - q->at) / 1000u),
                  q->state == care::NS_NEW ? "还没演" : (q->state == care::NS_SHOWN ? "演过了，等你摸它" : "已经处理完"));
}

static void printTime() {
  const auto& c = world.clock;
  if (c.valid) {
    static const char* const kWeek[7] = {"日", "一", "二", "三", "四", "五", "六"};
    const time_t t = time(nullptr) + cfg.tz;
    struct tm l;
    gmtime_r(&t, &l);
    Serial.printf("[time] %04d-%02d-%02d %02d:%02d 星期%s（UTC%+.1f，来源 %s，网络对时 %u 次）\n", l.tm_year + 1900, l.tm_mon + 1, l.tm_mday, l.tm_hour,
                  l.tm_min, kWeek[c.wday % 7], cfg.tz / 3600.f, kClockSource[clockSource], (unsigned)sntpSyncs);
  } else {
    Serial.printf("[time] 还不知道现在几点（时区 UTC%+.1f）。%s\n", cfg.tz / 3600.f,
                  PULSE_STUDIO_VOICE ? "连上 Wi‑Fi 后自动对时，或者 time set YYYY-MM-DD HH:MM" : "输入 time set YYYY-MM-DD HH:MM");
  }
  Serial.printf("[time] 夜间安静：%s%s\n", cfg.night ? "关" : "自动（22:00–07:00；不知道时间时按房间长时间很暗）", world.night ? "，现在是夜里" : "");
}

// 本地日期时间 → UTC 秒
static int64_t localToUtc(int y, int mo, int d, int h, int mi) {
  // days from civil（Howard Hinnant）
  y -= mo <= 2;
  const int era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = (unsigned)(y - era * 400);
  const unsigned doy = (153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  const int64_t days = (int64_t)era * 146097 + (int64_t)doe - 719468;
  return days * 86400 + h * 3600 + mi * 60 - cfg.tz;
}

static void handleLine(char* s) {
  while (*s == ' ' || *s == '\t') s++;
  for (char* e = s + strlen(s); e > s && (e[-1] == ' ' || e[-1] == '\r' || e[-1] == '\n');) *--e = 0;
  if (!*s) return;
  if (!strcmp(s, "help") || !strcmp(s, "?")) { printHelp(); return; }
  if (!strcmp(s, "rbench")) { eng->benchmark(Serial); return; }
  if (!strcmp(s, "face") || !strcmp(s, "face status")) { printFaceStatus(); return; }
  if (!strcmp(s, "face snapshot")) {
    Serial.println(!faceExport.pixels && facecam::requestSnapshot() ? "[face] snapshot requested" : "[face] snapshot unavailable");
    return;
  }
  if (!strcmp(s, "face on") || !strcmp(s, "face off")) {
    cfg.face = !strcmp(s, "face on");
    pauseFaceTracking();
    saveSettings();
    printFaceStatus();
    return;
  }
  if (!strcmp(s, "list") || !strcmp(s, "states")) {
    for (int i = 0; i < pulse::stateCount(); i++) Serial.printf("%s %s\n", pulse::stateDef(i).id, pulse::stateDef(i).name);
    return;
  }
  if (!strcmp(s, "acts")) {
    for (int i = 1; i < motion::A_COUNT; i++) Serial.printf("%s%s", motion::actName(i), i + 1 < motion::A_COUNT ? " " : "\n");
    return;
  }
  if (!strcmp(s, "clips")) {
    for (int i = 1; i < sfx::C_COUNT; i++) Serial.printf("%s%s", sfx::kClips[i].name, i + 1 < sfx::C_COUNT ? " " : "\n");
    return;
  }
  if (!strcmp(s, "diag")) { printDiag(); return; }
  if (!strcmp(s, "mood")) { printMood(); printMoodLog(); return; }
  if (!strncmp(s, "mood ", 5)) {  // 2.9 心情打卡
    const char* v = s + 5;
    if (!strcmp(v, "log")) printMoodLog();
    else if (!strcmp(v, "ask")) { if (!brain::moodAsk()) Serial.println("现在问不了（在聊天 / 在睡觉 / 在玩别的 / 还不知道日期 / 今天已经打过卡）"); }
    else if (!strcmp(v, "clear")) { brain::moodClear(); Serial.println("[mood] 心情打卡记录已清空"); }
    else if (v[0] >= '1' && v[0] <= '5' && !v[1]) {
      if (brain::moodSet((uint8_t)(v[0] - '0'))) printMoodLog();
      else Serial.println("记不了：还不知道今天几号（time set 或连上 Wi-Fi 对时）");
    } else Serial.println("用法：mood / mood log|ask|clear|1-5");
    return;
  }
  if (!strcmp(s, "lively")) { printPlay(); return; }
  if (!strncmp(s, "lively ", 7)) {
    const char* v = s + 7;
    int l = -1;
    if (!strcmp(v, "quiet") || !strcmp(v, "0") || !strcmp(v, "安静")) l = play::LV_QUIET;
    else if (!strcmp(v, "normal") || !strcmp(v, "1") || !strcmp(v, "适中")) l = play::LV_NORMAL;
    else if (!strcmp(v, "lively") || !strcmp(v, "2") || !strcmp(v, "活泼")) l = play::LV_LIVELY;
    else if (strcmp(v, "status")) { Serial.println("用法：lively quiet|normal|lively|status"); return; }
    if (l >= 0) {
      cfg.live = (uint8_t)l;
      saveSettings();
      brain::setLively(cfg.live);
    }
    printPlay();
    return;
  }
  if (!strcmp(s, "dance")) {
    if (!brain::dance()) Serial.println("现在跳不了（在聊天 / 在睡觉 / 在玩别的 / 还在开机）");
    return;
  }
  if (!strcmp(s, "game") || !strcmp(s, "game rhythm")) {
    if (!brain::rhythmStart()) Serial.println("现在玩不了（在聊天 / 在睡觉 / 夜里 / 在玩别的 / 还在开机）");
    return;
  }
  if (!strcmp(s, "breathe") || !strncmp(s, "breathe ", 8)) {
    const int m = s[7] ? atoi(s + 8) : 1;
    if (m < 1 || m > 3) { Serial.println("用法：breathe [1-3]（分钟）"); return; }
    if (!brain::breathe((uint8_t)m)) Serial.println("现在开始不了（在聊天 / 在睡觉 / 在玩别的 / 还在开机）");
    return;
  }
  if (!strcmp(s, "stop")) {
    if (!brain::stopPlaying()) Serial.println("[play] 现在没在玩");
    return;
  }
  if (!strcmp(s, "music") || !strcmp(s, "music status")) { printMusic(); return; }
  if (!strcmp(s, "music on") || !strcmp(s, "music off")) {
    cfg.music = !strcmp(s, "music on");
    saveSettings();
    brain::setMusicEnabled(cfg.music);
    printMusic();
    return;
  }
  if (!strcmp(s, "talk") || !strcmp(s, "talk auto") || !strcmp(s, "talk on") || !strcmp(s, "talk off")) {
    if (strcmp(s, "talk")) {
      cfg.talk = strcmp(s, "talk off") != 0;
      saveSettings();
    }
    Serial.printf("[voice] 对话自动结束：%s\n", cfg.talk ? "开（40 秒没开口就不听了，你在镜头前会等 2 分钟；说「再见」、连着两次没听清也会结束）"
                                                  : "关（像 2.8 一样一直听，直到点右上角）");
    return;
  }
  if (!strcmp(s, "bond")) { printBond(); return; }
  if (!strcmp(s, "time")) { printTime(); return; }
  if (!strncmp(s, "time tz ", 8)) {
    const float h = atof(s + 8);
    if (h < -12.f || h > 14.f) { Serial.println("时区范围 -12 到 14（例如 time tz 8 = 北京时间）"); return; }
    cfg.tz = (int32_t)lroundf(h * 4.f) * 900;  // 按 15 分钟取整
    saveSettings();
    worldAt = 0;
    updateWorld(millis());
    printTime();
    return;
  }
  if (!strncmp(s, "time set ", 9)) {
    int y = 0, mo = 0, d = 0, h = 0, mi = 0;
    if (sscanf(s + 9, "%d-%d-%d %d:%d", &y, &mo, &d, &h, &mi) != 5 || y < 2025 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > 31 || h < 0 ||
        h > 23 || mi < 0 || mi > 59) {
      Serial.println("格式：time set 2025-05-20 13:14（本地时间）");
      return;
    }
    setClockUtc(localToUtc(y, mo, d, h, mi), CLK_MANUAL);
    updateWorld(millis());
    printTime();
    return;
  }
  if (!strcmp(s, "night auto") || !strcmp(s, "night on") || !strcmp(s, "night off")) {
    cfg.night = !strcmp(s, "night off") ? 1 : 0;
    saveSettings();
    worldAt = 0;
    updateWorld(millis());
    printTime();
    return;
  }
  if (!strcmp(s, "light")) {
    if (!world.alsOk) Serial.println("[light] 没有环境光传感器（只有 CoreS3 有）");
    else
      Serial.printf("[light] 环境光 %.1f lux，%s；自动亮度 %s，屏幕系数 %.2f\n", world.lux, world.dark ? "房间暗" : "房间亮", cfg.abrt ? "开" : "关",
                    dispF);
    return;
  }
  if (!strcmp(s, "brightness auto") || !strcmp(s, "brightness fixed")) {
    cfg.abrt = !strcmp(s, "brightness auto");
    saveSettings();
    worldAt = 0;
    Serial.printf("brightness %s\n", cfg.abrt ? "auto" : "fixed");
    return;
  }
  if (!strcmp(s, "batt")) {
    battAt = 0;
    worldAt = 0;
    updateWorld(millis());
    if (!world.battOk) Serial.printf("[batt] 读不到电池（%d mV）\n", (int)M5.Power.getBatteryVoltage());
    else Serial.printf("[batt] 电量 %d%%（%d mV）%s\n", world.battery, (int)M5.Power.getBatteryVoltage(), world.charging ? "，充电中" : "");
    return;
  }
  if (!strcmp(s, "previews") || !strcmp(s, "preview")) { printPreviews(); return; }
  if (!strcmp(s, "celebrate") || !strcmp(s, "greet") || !strncmp(s, "preview ", 8)) {
    const char* n = !strncmp(s, "preview ", 8) ? s + 8 : s;
    if (!brain::preview(n)) Serial.println("现在演不了（在对话中 / 还在开机），或者没有这个名字。输入 previews 查看全部");
    return;
  }
  if (!strcmp(s, "care")) { printCare(); return; }
  if (!strncmp(s, "care ", 5)) {
    const char* v = s + 5;
    int l = -1;
    if (!strcmp(v, "on") || !strcmp(v, "2")) l = care::L_ON;
    else if (!strcmp(v, "less") || !strcmp(v, "low") || !strcmp(v, "1")) l = care::L_LESS;
    else if (!strcmp(v, "off") || !strcmp(v, "0")) l = care::L_OFF;
    else if (strcmp(v, "status")) { Serial.println("用法：care on|less|off|status"); return; }
    if (l >= 0) {
      cfg.care = (uint8_t)l;
      saveSettings();
      brain::setCareLevel(cfg.care);
    }
    printCare();
    return;
  }
  if (!strcmp(s, "notify")) { printNotify(); return; }
  if (!strncmp(s, "notify ", 7)) {
    const char* v = s + 7;
    if (!strcmp(v, "on") || !strcmp(v, "off")) {
      cfg.task = !strcmp(v, "on");
      saveSettings();
      brain::setNotifyEnabled(cfg.task);
      printNotify();
      return;
    }
    if (!strcmp(v, "status")) { printNotify(); return; }
    char kindArg[16] = {};
    size_t k = 0;
    while (v[k] && v[k] != ' ' && k + 1 < sizeof kindArg) { kindArg[k] = v[k]; k++; }
    const char* title = v + k;
    while (*title == ' ') title++;
    const int kind = care::parseNoticeKind(kindArg);
    if (kind < 0 || (v[k] && v[k] != ' ')) { Serial.println("用法：notify done|failed|remind|praise [标题]；notify on|off|status"); return; }
    if (!brain::notifyEnabled()) { Serial.println("[notify] 任务提醒关着（notify on 打开）"); return; }
    bool truncated = false;
    const uint8_t r = brain::notify((uint8_t)kind, title, "serial", "", &truncated);
    Serial.printf("[notify] %s%s\n", care::pushKey(r), truncated ? "（标题太长，已截断）" : "");
    return;
  }
  if (!strcmp(s, "ack")) {
    if (!brain::acknowledge()) Serial.println("[care] 现在没有在等你回应的提醒或消息");
    return;
  }
  if (!strcmp(s, "sounds")) {
    for (int i = 1; i < sfx::S_COUNT; i++) Serial.printf("%s%s", sfx::soundName(i), i + 1 < sfx::S_COUNT ? " " : "\n");
    return;
  }
  if (!strcmp(s, "test")) {
    faceMaintenance = true;
    pauseFaceTracking();
    motionTest();
    faceMaintenance = false;
    lastUs = micros();
    return;
  }
  if (!strcmp(s, "poke") || !strcmp(s, "pulse")) { brain::poke(); return; }
  if (!strcmp(s, "pet")) { brain::pet(); return; }
  if (!strcmp(s, "sleep")) { brain::sleepNow(); return; }
  if (!strcmp(s, "wake")) { brain::wakeNow(); return; }
  if ((!strncmp(s, "show", 4) && (s[4] == 0 || s[4] == ' ')) || !strncmp(s, "mode ", 5) || !strcmp(s, "auto on") ||
      !strcmp(s, "auto off") || !strcmp(s, "next") || !strcmp(s, "prev") || !strcmp(s, "n") || !strcmp(s, "p")) {
    Serial.println("从 2.8 起只保留生活模式（表演 / 轮播已经去掉）。想看小剧场：previews；想一起玩：dance / game / breathe");
    return;
  }
  if (!strncmp(s, "act ", 4)) {
    const int a = motion::findAct(s + 4);
    if (a > 0) { brain::act((uint8_t)a); Serial.printf("act %s（%.1f 秒）\n", motion::actName(a), motion::actDuration(a)); }
    else Serial.println("没有这个动作，输入 acts 查看全部");
    return;
  }
  if (!strncmp(s, "play ", 5)) {
    const int c = sfx::findClip(s + 5);
    const int sn = c > 0 ? -1 : sfx::findSound(s + 5);
    if (c > 0) { sfx::play((uint8_t)c, 1.f, 1.f, true); Serial.printf("play %s\n", sfx::kClips[c].name); }
    else if (sn > 0) { sfx::synth((uint8_t)sn, true); Serial.printf("play %s（合成音）\n", sfx::soundName((uint8_t)sn)); }
    else Serial.println("没有这个音效，输入 clips / sounds 查看全部");
    return;
  }
  if (!strncmp(s, "sound", 5) && (s[5] == 0 || s[5] == ' ')) {
    const int l = s[5] ? levelArg(s + 6) : -1;
    if (l >= 0) {
      cfg.snd = (uint8_t)l;
      saveSettings();
      sfx::setLevel(cfg.snd);
      sfx::preview();
    }
    Serial.printf("sound %s\n", sfx::levelName(cfg.snd));
    return;
  }
  if (!strncmp(s, "motion", 6) && (s[6] == 0 || s[6] == ' ')) {
    const int l = s[6] ? levelArg(s + 7) : -1;
    if (l >= 0) {
      cfg.mot = (uint8_t)l;
      saveSettings();
      applyMotion();
    }
    Serial.printf("motion %s\n", kLevelName[cfg.mot & 3]);
    return;
  }
  if (!strncmp(s, "servo ", 6)) {
    const char* v = s + 6;
    uint8_t t = SERVO_OFF;
    if (!strcmp(v, "pwm")) t = SERVO_PWM;
    else if (!strcmp(v, "scs")) t = SERVO_SCS;
    else if (!strcmp(v, "stackchan") || !strcmp(v, "k151")) t = SERVO_K151;
    if (t >= kServoTypes) { Serial.println("这块板子不支持官方 StackChan 机身（需要 CoreS3）"); return; }
    cfg.servo = t;
    servoUser = true;
    saveSettings();
    applyServo();
    return;
  }
  if (!strncmp(s, "dir ", 4)) {
    cfg.dir = (uint8_t)(atoi(s + 4) & 3);
    saveSettings();
    applyServo();
    Serial.printf("dir %s\n", kDirName[cfg.dir]);
    return;
  }
  if (!strcmp(s, "led on") || !strcmp(s, "led off")) {
    cfg.led = s[5] == 'n';
    saveSettings();
    if (!cfg.led) body::setAll(0, 0, 0);
    ledSent = -1;
    Serial.printf("led %s%s\n", cfg.led ? "on" : "off", bodyOk ? "" : "（没检测到官方机身）");
    return;
  }
  if (!strncmp(s, "port ", 5)) {
    const char v = s[5];
    cfg.port = (v == 'a' || v == 'A') ? 0 : ((v == 'b' || v == 'B') ? 2 : 1);
    saveSettings();
    applyServo();
    return;
  }
  const int idx = pulse::findState(s);
  if (idx >= 0) {
    brain::goState(atoi(pulse::stateDef(idx).id), true, true, true);
    return;
  }
  Serial.printf("未知命令：%s\n", s);
  printHelp();
}

static void handleSerial() {
  static char line[2501];
  static int len = 0;
  static bool overflow = false;
  while (Serial.available()) {
    const int ch = Serial.read();
    if (ch < 0) break;
    if (ch == '\n' || ch == '\r') {
      line[len] = 0;
      char* start=line;
      while(*start==' '||*start=='\t')++start;
      if(overflow) Serial.println("[serial] line too long; discarded");
      else if(*start && !voiceportal::handleSerialJson(start)) {
        if(!strcmp(start,"voice status")) voiceportal::handleSerialJson("{\"op\":\"voice_status\"}");
        else if(!strcmp(start,"voice setup")) voiceportal::openSetup();
        else if(!strcmp(start,"voice wake")) Serial.println(wakeVoice()?"[voice] listening":"[voice] not ready");
        else if(!strcmp(start,"voice new")) Serial.println(startNewChat()?"[voice-new] accepted":"[voice-new] not ready");
        else if(!strcmp(start,"voice stop")) stopVoice();
        else if(!strcmp(start,"screen snapshot")) requestScreenSnapshot();
        else if(!strcmp(start,"voice mic")) {
#if PULSE_STUDIO_VOICE
          stopVoice();voiceMicDiagnostic=true;voiceMicUntil=millis()+10000;
          sfx::setSuspended(true);
          voice_audio::setListening(true);
          Serial.println("[voice-mic] 10-second local-only microphone test");
#endif
        }else handleLine(start);
      }
      len = 0;
      overflow = false;
    } else if (len < (int)sizeof(line) - 1) {
      line[len++] = (char)ch;
    } else overflow = true;
  }
}

// ---------------- 官方机身：检测和灯光 ----------------
static bool tryBody() {
  bodyNextProbe = millis() + 250;
  if (!body::begin()) return false;
  bodyOk = true;
  bodyProbeUntil = 0;
  Serial.println("[body] 检测到 M5Stack 官方 StackChan 机身");
  if (!servoUser) cfg.servo = SERVO_K151;
  headtouch::begin();
  return true;
}

static void hueRGB(float h, float v, uint8_t* out) {
  h -= floorf(h);
  const float x = h * 6.f;
  const int i = (int)x;
  const float f = x - i, q = 1.f - f;
  float r = 0, g = 0, b = 0;
  switch (i % 6) {
    case 0: r = 1; g = f; break;
    case 1: r = q; g = 1; break;
    case 2: g = 1; b = f; break;
    case 3: g = q; b = 1; break;
    case 4: r = f; b = 1; break;
    default: r = 1; b = q; break;
  }
  out[0] = (uint8_t)(r * v * 255.f);
  out[1] = (uint8_t)(g * v * 255.f);
  out[2] = (uint8_t)(b * v * 255.f);
}

static void updateLeds(uint32_t now) {
  if (!bodyOk || now - lastLedMs < 50) return;
  lastLedMs = now;
  const uint8_t effect = cfg.led ? brain::ledEffect(now) : (uint8_t)brain::LE_NONE;
  const float level = PULSE_K151_LED_LEVEL * (world.night ? PULSE_NIGHT_LED : 1.f);
  if (effect == brain::LE_RAINBOW) {  // 庆祝：一圈彩虹转起来
    uint8_t px[body::kLedCount * 3];
    const float base = (now % 1800) / 1800.f;
    for (int i = 0; i < body::kLedCount; i++) hueRGB(base + (float)i / body::kLedCount, level, px + 3 * i);
    body::setLeds(px);
    ledSent = -1;  // 结束后重新同步成轮廓光颜色
    return;
  }
  uint8_t r = 0, g = 0, b = 0;
  bool listenGlow = false;
#if PULSE_STUDIO_VOICE
  // 2.9：正在等你说话 = 机身灯一圈淡蓝色慢慢起伏（你开口时更亮）
  listenGlow = voiceArmed && !voiceTurnPending && conversation::active() && conversation::phase() == conversation::Phase::Listening;
#endif
  if (cfg.led) {
    float k = level;
    if (listenGlow) {
      r = 60; g = 150; b = 255;
      const float w = .5f - .5f * cosf((float)(now % 2000u) * (6.2831853f / 2000.f));
      k *= voice_audio::status().recording ? 1.f : .3f + .35f * w;
    } else if (effect == brain::LE_BEAT || effect == brain::LE_BREATH) {
      // 2.9：跟着节拍闪 / 深呼吸（吸气变亮、呼气变暗）
      const uint32_t c = brain::ledColor();
      r = (uint8_t)(c >> 16);
      g = (uint8_t)(c >> 8);
      b = (uint8_t)c;
      k *= brain::ledLevel(now);
    } else if (effect == brain::LE_NOTICE || effect == brain::LE_CARE) {
      // 2.8：有消息没看 = 琥珀色慢慢呼吸；正在提醒 / 等你回应 = 这一种的颜色，轻轻起伏
      const uint32_t c = brain::ledColor();
      r = (uint8_t)(c >> 16);
      g = (uint8_t)(c >> 8);
      b = (uint8_t)c;
      const uint32_t period = effect == brain::LE_NOTICE ? 2400u : 1600u;
      const float w = .5f - .5f * cosf((float)(now % period) * (6.2831853f / (float)period));
      k *= effect == brain::LE_NOTICE ? .2f + .8f * w : .65f + .35f * w;
    } else {
      eng->glowRGB(r, g, b);
      if (effect == brain::LE_SLEEP) k *= .2f + .8f * (.5f - .5f * cosf((now % 5200) * (6.2831853f / 5200.f)));  // 睡觉：慢慢呼吸
    }
    r = (uint8_t)(r * k);
    g = (uint8_t)(g * k);
    b = (uint8_t)(b * k);
  }
  const int32_t c565 = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
  if (c565 == ledSent) return;
  ledSent = c565;
  body::setAll(r, g, b);
}

// 开机 3.6 秒后在屏幕顶上显示一行自检结果（声音 / 舵机 / 触摸）
static void showBootDiag() {
  char buf[64];
  int n = snprintf(buf, sizeof(buf), "声音%s", !sfx::ok() ? "×" : (cfg.snd ? "√" : "关"));
  if (!head.active()) n += snprintf(buf + n, sizeof(buf) - n, "  舵机%s", cfg.servo ? "×" : "关");
  else if (head.type() == SERVO_PWM) n += snprintf(buf + n, sizeof(buf) - n, "  舵机PWM");
  else {
    auto mark = [](int8_t p) { return p == 1 ? "√" : (p == 0 ? "×" : "?"); };
    n += snprintf(buf + n, sizeof(buf) - n, "  舵机%s%s", mark(head.ping(0)), mark(head.ping(1)));
  }
  if (bodyOk) n += snprintf(buf + n, sizeof(buf) - n, "  触摸%s", headtouch::ok() ? "√" : "×");
  if (PULSE_FACE_FOLLOW) n += snprintf(buf + n, sizeof(buf) - n, "  人脸%s", facecam::status().initialized ? (cfg.face ? "开" : "关") : "×");
  Serial.printf("[diag] %s（详细信息：串口输入 diag，或 设置 → 自检）\n", buf);
}

// ---------------- 输入 ----------------
struct TouchTrack {
  bool down = false, moved = false, held = false;
  uint32_t t0 = 0;
  int x0 = 0, y0 = 0, lx = 0, ly = 0;
  float acc = 0;
};
static TouchTrack tt;

// 2.7：生活模式里的本地触摸也记进心情和亲密度（0 点 / 1 摸 / 2 按住）；对话中由对话负责表情
static void noteLocalTouch(uint8_t gesture, uint32_t now, bool headSource = false) {
  if (!conversation::active()) brain::noteTouch(gesture, now, headSource);
  else if (voiceIdleFrom) voiceIdleFrom = now;  // 在摸它：还在陪它聊，别自动结束
}
static bool screenVoiceControl() {
#if PULSE_STUDIO_VOICE
  return tt.x0 >= M5.Display.width() - 72 && tt.y0 < 36;
#else
  return false;
#endif
}

// 返回 true = 进过设置界面（这一帧剩下的不做了）
static bool handleInput(uint32_t now) {
  const int H = M5.Display.height();
  bool pressed = false;
  int x = 0, y = 0;
  if (M5.Touch.getCount() > 0) {
    const auto& d = M5.Touch.getDetail(0);
    if (d.isPressed() && d.y >= 0 && d.y < H) {
      pressed = true;
      x = d.x;
      y = d.y;
    }
  }
  if (pressed) {
    eng->setPointer(true, (float)x, (float)y);
    sensors::quietProximity(1500);  // 手在屏幕前面：不算「有人靠近」
    if (!tt.down) {
      tt = TouchTrack();
      tt.down = true;
      tt.t0 = now;
      tt.x0 = tt.lx = x;
      tt.y0 = tt.ly = y;
    } else {
      tt.acc += hypotf((float)(x - tt.lx), (float)(y - tt.ly));
      tt.lx = x;
      tt.ly = y;
      if (!tt.moved && hypotf((float)(x - tt.x0), (float)(y - tt.y0)) > 14.f) tt.moved = true;
    }
    if (tt.moved && tt.acc >= 70.f) {  // 在脸上摸
      tt.acc = 0;
      if (!screenVoiceControl()) {
        touchController.gesture(touchinteraction::Source::Screen, touchinteraction::Gesture::Stroke, now);
        noteLocalTouch(1, now);
      }
    }
    if (!tt.moved && !tt.held && now - tt.t0 >= 800) {  // 按住不动
      tt.held = true;
      if (!screenVoiceControl()) {
        touchController.gesture(touchinteraction::Source::Screen, touchinteraction::Gesture::Hold, now);
        noteLocalTouch(2, now);
      }
    }
    if (!tt.moved && now - tt.t0 >= 3000) {  // 按住 3 秒：设置
      tt.down = false;
      eng->setPointer(false, 0, 0);
      runSettings();
      return true;
    }
  } else if (tt.down) {
    tt.down = false;
    eng->setPointer(false, 0, 0);
    if (!tt.moved && !tt.held && now - tt.t0 < 800) {
#if PULSE_STUDIO_VOICE
      if(screenVoiceControl()){
        if(voiceArmed || newChatPending || studiolink::status().conversation_changing) stopVoice();
        else wakeVoice();
      }
      else
#endif
      {
        touchController.gesture(touchinteraction::Source::Screen, touchinteraction::Gesture::Tap, now);
        noteLocalTouch(0, now);
      }
    }
  }
  if (M5.BtnB.wasHold()) { runSettings(); return true; }
  if (M5.BtnA.wasClicked()) brain::onButton(0);
  if (M5.BtnB.wasClicked()) brain::onButton(1);
  if (M5.BtnC.wasClicked()) brain::onButton(2);
  if (M5.BtnPWR.wasClicked()) brain::onButton(3);
  return false;
}

static void updateTouchInteraction(uint32_t now) {
  touchInfo.headDown = bodyOk && headtouch::touching();
  touchInfo.screenDown = tt.down && !screenVoiceControl();
  touchController.contact(touchinteraction::Source::Head, touchInfo.headDown, now);
  touchController.contact(touchinteraction::Source::Screen, touchInfo.screenDown, now);
  brain::touchContact(!conversation::active() && (touchInfo.headDown || touchInfo.screenDown), now);
  brain::headContact(!conversation::active() && touchInfo.headDown, now);  // 2.9：按住头顶不动 = 一起深呼吸
  const auto context = touchContext(now);
  const auto decision = touchController.update(now, context);
  touchdispatch::Context dispatchContext;
  dispatchContext.interaction = context;
  const auto audio = voice_audio::status();
  dispatchContext.normalListening = conversation::active() && conversation::phase() == conversation::Phase::Listening &&
                                    audio.listening && !context.recording && !context.speaking;
  dispatchContext.idleVisualAllowed = !conversation::active() && context.enabled;
  const auto priorPose = eng->pose();
  const auto result = touchDispatcher.dispatch(decision, dispatchContext, now);
  if (decision.visual == touchinteraction::Visual::Happy) ++touchInfo.happy;
  else if (decision.visual == touchinteraction::Visual::PlayfulBoundary) ++touchInfo.boundary;
  // 「摸太多」但这次没有配套语音（30 秒冷却中）：自己小声哼一下
  if (decision.visual == touchinteraction::Visual::PlayfulBoundary && result.route == touchdispatch::VisualRoute::Idle && !result.phraseQueued)
    brain::touchPout(now);
  if (result.route == touchdispatch::VisualRoute::Listening || result.route == touchdispatch::VisualRoute::Idle) {
    ++touchInfo.faceApplied;
    if (!touchBaseHeld) touchBase = priorPose;
    touchBaseHeld = true; touchBaseUntil = now + 2000;
  } else if (result.route == touchdispatch::VisualRoute::FxOnly) ++touchInfo.fxOnly;
  if (result.phraseQueued) {
    touchPhraseTicket = result.phraseTicket; touchPhraseExpiresAt = decision.phraseExpiresAt;
    ++touchInfo.phraseQueued;
  }
  if (touchBaseHeld && context.expressionOwned && !conversation::localFeedbackActive(now)) touchBaseHeld = false;
  if (touchBaseHeld && static_cast<int32_t>(now - touchBaseUntil) >= 0 && !context.recording && !context.speaking &&
      !conversation::localFeedbackActive(now)) touchBaseHeld = false;
}

// ---------------- 2.9 听歌跳舞：麦克风只在本机算节拍（不做语音检测、不存、不上传）----------------
static uint32_t musicLoudAt = 0, musicFedAt = 0, musicFedEpoch = 0;
static void updateMusic(uint32_t now) {
#if PULSE_STUDIO_VOICE
  if (!musicMicOk) return;
  const auto cues = conversation::expressionCues();
  const bool allowed = cfg.music && !voiceArmed && !newChatPending && !conversation::active() && !directorLease &&
                       !voiceMicDiagnostic && !faceMaintenance && !cues.sound_pending && !cues.sound_playing;
  if (sfx::busy() || M5.Speaker.isPlaying()) musicLoudAt = now;
  if (!allowed || !brain::musicListenWanted()) {
    voice_audio::setAmbient(false);
    return;
  }
  if (!voice_audio::ambientWanted()) {
    if (now - musicLoudAt < 150) return;  // 刚出过声：等喇叭停稳再听
    voice_audio::setAmbient(true);
  }
  const auto st = voice_audio::ambientStatus();
  if (st.updatedMs && (st.epoch != musicFedEpoch || st.updatedMs != musicFedAt)) {
    musicFedEpoch = st.epoch;
    musicFedAt = st.updatedMs;
    brain::setBeat(st.est, now);
  }
#else
  (void)now;
#endif
}

// ---------------- 主流程 ----------------
void appSetup() {
  auto mc = M5.config();
  mc.serial_baudrate = 115200;
  M5.begin(mc);
#if PULSE_FACE_FOLLOW && defined(ARDUINO_USB_CDC_ON_BOOT) && ARDUINO_USB_CDC_ON_BOOT
  // HWCDC (Arduino 2.0.17) underflows its no-progress retry counter at zero.
  // Keep a positive short timeout so a closed USB terminal cannot stall tracking.
  Serial.setTxBufferSize(4096);
  Serial.setTxTimeoutMs(1);
#endif
  M5.Display.setBrightness(PULSE_BRIGHTNESS);
  M5.Display.fillScreen(TFT_BLACK);
  M5.BtnB.setHoldThresh(1200);

  loadSettings();
  // Engine owns roughly 30KB of geometry/history arrays. Keep them in PSRAM
  // so Wi-Fi, microphone DMA and task stacks retain internal RAM.
  void* engineStorage=PULSE_STUDIO_VOICE ? ps_malloc(sizeof(pulse::Engine)) : malloc(sizeof(pulse::Engine));
  if(!engineStorage){
    M5.Display.setFont(&fonts::efontCN_16);
    M5.Display.setTextColor(TFT_RED);
    M5.Display.drawString("PSRAM不足，无法启动表情引擎",4,4);
    Serial.println("[pulse] engine PSRAM allocation failed");return;
  }
  eng = new (engineStorage) pulse::Engine();
  eng->setLabelsEnabled(false);
#if PULSE_STUDIO_VOICE
  void* eventStorage=ps_malloc(sizeof(studiolink::Event));
  void* playbackStorage=ps_malloc(sizeof(voice_audio::PlaybackRequest));
  if(eventStorage) voiceNetEvent = new (eventStorage) studiolink::Event();
  if(playbackStorage) voicePlayback = new (playbackStorage) voice_audio::PlaybackRequest();
  const bool microphoneOk=voice_audio::begin();
  // Initialize esp_netif/lwIP once before network and portal code can race
  // their first WiFi.mode() call on different cores.
  const bool wifiStackOk=WiFi.mode(WIFI_STA);
  const bool networkOk=wifiStackOk && studiolink::begin();
  voiceportal::Hooks portalHooks;
  portalHooks.wake=[]{return wakeVoice();};portalHooks.stop=stopVoice;portalHooks.armed=voiceIsArmed;
  portalHooks.renderedEmotion=renderedEmotion;portalHooks.speakerActive=voiceSpeakerActive;
  portalHooks.touchInfo=readTouchInfo;
  portalHooks.newChatPending=newChatIsPending;portalHooks.voiceNotice=currentVoiceNotice;
  portalHooks.faceTracking=readFaceTracking;
  portalHooks.companionInfo=readCompanion;
  portalHooks.notify=portalNotify;portalHooks.notifyEnabled=portalNotifyEnabled;
  const bool portalOk=voiceportal::begin(portalHooks);
  Serial.printf("[voice] microphone=%d link=%d portal=%d half_duplex=1 touch_wake=1\n",microphoneOk,networkOk,portalOk);
#endif
  if (PULSE_FACE_FOLLOW) facecam::begin();
  engineOk = eng->begin(&M5.Display);
  if (!engineOk) {
    M5.Display.setFont(&fonts::efontCN_16);
    M5.Display.setTextColor(TFT_RED);
    M5.Display.drawString("内存不足，无法创建画布", 10, 10);
    Serial.println("[pulse] canvas alloc failed");
    return;
  }
  // 官方 StackChan 机身：机身上的芯片启动可能比 CoreS3 慢，开机后 2.5 秒内会反复检测
  bodyProbeUntil = millis() + 2500;
  tryBody();
  applyServo();
  sensors::begin(boardKind() == BK_CORES3);
  sfx::begin(cfg.snd);
  brain::begin(eng, &plan);
  beginClock();
  loadBond();
  updateWorld(millis());  // 开机前先知道几点、亮不亮（开机打招呼要用）
  auto conversationHooks = brain::conversationHooks();
  conversationHooks.cancelCue = cancelDirectorCue;
  conversationHooks.acquireAudio = []() {
    // Audio-only ownership must not call brain.acquire: that clears FX and
    // changes idle/breath/head intent even when no visual command was sent.
    return engineOk && !faceMaintenance && brain::faceTrackingAllowed();
  };
  conversation::begin(conversationHooks, millis());
  brain::setCareLevel(cfg.care);
  brain::setNotifyEnabled(cfg.task);
  brain::setLively(cfg.live);  // 2.9
  brain::setMusicEnabled(cfg.music);
#if PULSE_STUDIO_VOICE
  musicMicOk = voice_audio::ok() && voice_audio::ambientOk() && boardKind() == BK_CORES3;
  if (musicMicOk) sfx::setPrePlayHook([]() { voice_audio::setAmbient(false); });  // 要出声了：先把麦克风还给喇叭
#endif
  brain::setMusicAvailable(musicMicOk);
  if (PULSE_FACE_FOLLOW) {
    facecam::setEnabled(false);
    facecam::start();
  }
  brain::boot();
  Serial.printf("脉冲 Pulse v%s 已启动（%s，生活模式；关心提醒%s，任务提醒%s；活跃度%s，听歌跳舞%s）。输入 help 查看串口命令。\n", PULSE_VERSION,
                boardName(), care::levelName(cfg.care), cfg.task ? "开" : "关", play::levelName(cfg.live),
                !musicMicOk ? "（没有麦克风）" : (cfg.music ? "开" : "关"));
  diagAt = 0;  // Explicit diag/menu commands remain available, no boot text page.
  lastUs = micros();
  fpsT0 = millis();
}

void appLoop() {
  M5.update();
  if (!engineOk) { delay(100); return; }
  handleSerial();
  publishFaceSnapshot();
  publishScreenSnapshot();
  uint32_t now = millis();
  if (handleInput(now)) return;
  updateVoice(now);
  if (!bodyOk && bodyProbeUntil && (int32_t)(now - bodyNextProbe) >= 0) {
    if ((int32_t)(now - bodyProbeUntil) < 0) {
      if (tryBody()) applyServo();
    } else {
      bodyProbeUntil = 0;
    }
  }

  const uint32_t nowUs = micros();
  float dt = (nowUs - lastUs) * 1e-6f;
  lastUs = nowUs;
  // A menu or maintenance operation resets lastUs. A genuine scheduling gap
  // stops pursuit instead of advancing a stale target by several seconds.
  if (dt > 1.f) dt = 0.f;
  if (dt < 0.f) dt = 0.f;
  now = millis();

  if (bodyOk) {
    const uint8_t ht = headtouch::update(now);
    if (ht) {
      touchController.contact(touchinteraction::Source::Head, headtouch::touching(), now);
      if (ht & headtouch::HT_SWIPE) {
        touchController.gesture(touchinteraction::Source::Head, touchinteraction::Gesture::Stroke, now);
        noteLocalTouch(1, now, true);
      }
      if (ht & headtouch::HT_HOLD) {
        touchController.gesture(touchinteraction::Source::Head, touchinteraction::Gesture::Hold, now);
        noteLocalTouch(2, now, true);
      }
      if (ht & headtouch::HT_TAP) {
#if PULSE_STUDIO_VOICE
        // 2026-11-05：摸一下头顶 = 开始聊（没在听时唤醒；已经在听时不打断）
        if (!voiceArmed) headWakeVoice();
#endif
        touchController.gesture(touchinteraction::Source::Head, touchinteraction::Gesture::Tap, now);
        noteLocalTouch(0, now, true);
      }
    }
  }
  updateTouchInteraction(now);
  const uint8_t se = sensors::update(now, plan.vigor());
  if (se) brain::onSensors(se);
  updateWorld(now);
  updateFaceTracking(dt, now);
#if PULSE_STUDIO_VOICE
  // Service fresh tracking/sample results before a display draw adds another
  // full frame of latency. Keep the earlier pump for setup/maintenance paths.
  voiceportal::update();
#endif
  brain::update(dt, now);
  updateMusic(now);

  eng->update(dt);
  (void)eng->takeEvents();  // 2.8：只有生活模式，声音由 brain 决定（轮播模式的状态音效已去掉）
  eng->draw();
  drawVoiceOverlay();

  const pulse::Pose p = eng->pose();
  plan.setBase(touchBaseHeld ? touchBase.pan : p.pan, touchBaseHeld ? touchBase.tilt : p.tilt);
  plan.update(dt);
  if (head.active()) head.setTarget(plan.pan(), plan.tilt());

  if (diagAt && (int32_t)(now - diagAt) >= 0) {
    diagAt = 0;
    showBootDiag();
  }
  const int b = displayBrightness(dt);
  if ((lastBright < 0 || abs(b - lastBright) >= 3 || (b != lastBright && b <= PULSE_MIN_BRIGHTNESS + 3)) && now - lastBrightMs >= 120) {
    M5.Display.setBrightness(b);
    lastBright = b;
    lastBrightMs = now;
  }
  updateLeds(now);
  maybeSaveBond(now);
  maybeSaveMood(now);
  fpsFrames++;
  if (now - fpsT0 >= 10000) {
    Serial.printf("[pulse] %.1f fps, draw %.1f ms, buffers %d, heap %u, psram %u, %s\n", fpsFrames * 1000.f / (now - fpsT0), eng->lastDrawMs(),
                  eng->bufferCount(), (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getFreePsram(), brain::phaseName());
    fpsT0 = now;
    fpsFrames = 0;
    eng->printProfile(Serial);
    if (PULSE_FACE_FOLLOW) printFaceStatus();
  }
}
