<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { createMcuSpeechSegmenter } from '@/api/studio/mcu-interaction'
import {
  cancelLocalSttStream,
  finishLocalSttStream,
  pushLocalSttStreamChunk,
  startLocalSttStream,
  transcribeSpeech,
} from '@/api/studio/stt'
import { fetchSttSettings, type SttProviderSettingsResponse } from '@/api/studio/stt-settings'
import { isServerTtsProvider, synthesizeSpeech } from '@/api/studio/tts'
import { useBrowserSpeechRecognition } from '@/composables/useBrowserSpeechRecognition'
import { useMicRecorder } from '@/composables/useMicRecorder'
import { usePcmStreamRecorder } from '@/composables/usePcmStreamRecorder'
import { useGlobalSpeech } from '@/composables/useSpeech'
import { useSttSettings } from '@/composables/useSttSettings'
import { useVoiceSettings } from '@/composables/useVoiceSettings'
import { useChatStore, type Message } from '@/stores/hermes/chat'
import { isDesktopShell } from '@/utils/desktop-bridge'
import { isMobileDevice } from '@/utils/device'
import { hzToEdgePitch, speedToEdgeRate } from '@/utils/ttsHelpers'

type VoiceStageMode = 'idle' | 'paused' | 'listening' | 'processing' | 'thinking' | 'speaking' | 'error'
type PreparedSpeech =
  | { ok: true; audio: Blob }
  | { ok: false; error: unknown }
type VoiceSpeechSegment = {
  id: string
  audioText: string
  subtitleText: string
  generation: number
  synthesis: Promise<PreparedSpeech> | null
}
type SpeechSynthesisJob = {
  generation: number
  text: string
  resolve: (result: PreparedSpeech) => void
}
const SILENCE_COMMIT_MS = 1_500
const BACKEND_STREAM_VOICE_LEVEL = 0.035
const BACKEND_STREAM_END_SILENCE_MS = 700
const BACKEND_STREAM_MIN_SEGMENT_MS = 1_800
const BACKEND_STREAM_MAX_SEGMENT_MS = 8_000
const LOCAL_STREAM_MAX_SEGMENT_MS = 1_000
const MAX_CONCURRENT_TTS_SYNTHESIS = 5

const emit = defineEmits<{
  close: []
}>()

const { t } = useI18n()
const chatStore = useChatStore()
const sttSettings = useSttSettings()
const voiceSettings = useVoiceSettings()
const speech = useGlobalSpeech()
const browserRecognition = useBrowserSpeechRecognition({
  messages: {
    unsupported: t('chat.voiceInput.browserSpeechUnsupported'),
    failed: t('chat.voiceInput.browserSpeechFailed'),
    failedWithReason: reason => t('chat.voiceInput.browserSpeechFailedWithReason', { error: reason }),
  },
})
const micRecorder = useMicRecorder({
  messages: {
    unsupported: t('chat.voiceInput.microphoneUnsupported'),
    recordingFailed: t('chat.voiceInput.microphoneRecordingFailed'),
  },
})
const pcmStreamRecorder = usePcmStreamRecorder({
  minSegmentDurationMs: BACKEND_STREAM_MIN_SEGMENT_MS,
  speechEndSilenceMs: BACKEND_STREAM_END_SILENCE_MS,
  maxSegmentDurationMs: BACKEND_STREAM_MAX_SEGMENT_MS,
  voiceActivityThreshold: BACKEND_STREAM_VOICE_LEVEL,
  onChunk: queueBackendStreamChunk,
  messages: {
    unsupported: t('chat.voiceInput.microphoneUnsupported'),
    recordingFailed: t('chat.voiceInput.microphoneRecordingFailed'),
  },
})
const localPcmStreamRecorder = usePcmStreamRecorder({
  continuous: true,
  maxSegmentDurationMs: LOCAL_STREAM_MAX_SEGMENT_MS,
  onChunk: queueBackendStreamChunk,
  messages: {
    unsupported: t('chat.voiceInput.microphoneUnsupported'),
    recordingFailed: t('chat.voiceInput.microphoneRecordingFailed'),
  },
})

const mode = ref<VoiceStageMode>('idle')
const sessionActive = ref(false)
const submittedTranscript = ref('')
const backendStreamTranscript = ref('')
const errorMessage = ref('')
const waitingForResponse = ref(false)
const responseAudioStarted = ref(false)
const responseStartedAt = ref(0)
const audioLevel = ref(0)
const segmentAudioPlaying = ref(false)
const speechSegments = ref<VoiceSpeechSegment[]>([])
const activeSpeechSegment = ref<VoiceSpeechSegment | null>(null)
let silenceTimer: ReturnType<typeof setTimeout> | null = null
let restartTimer: ReturnType<typeof setTimeout> | null = null
let visualizerFrame: number | null = null
let visualizerStream: MediaStream | null = null
let visualizerContext: AudioContext | null = null
let visualizerOwnsStream = false
let activeSegmentAudio: HTMLAudioElement | null = null
let activeSegmentAudioUrl: string | null = null
let finishActiveSegmentAudio: (() => void) | null = null
let previousBodyOverflow = ''
let previousDocumentOverflow = ''
let responseStartMessageIndex = 0
let lastResponseAssistantId: string | null = null
let responseFinalizing = false
let playbackGeneration = 0
let ttsSegmentIndex = 0
let speechQueueRunning = false
let activeSynthesisCount = 0
let activeBackendSetting: SttProviderSettingsResponse | null = null
let backendSettingPromise: Promise<SttProviderSettingsResponse | null> | null = null
let activeCaptureMode: 'browser' | 'backend-stream' | null = null
let handlingRecognitionFailure = false
let backendStreamGeneration = 0
let backendStreamQueue: Promise<void> = Promise.resolve()
let backendStreamFailure: unknown = null
let localStreamSessionId: string | null = null
const speechQueueIdleWaiters = new Set<() => void>()
const synthesisControllers = new Set<AbortController>()
const synthesisJobs: SpeechSynthesisJob[] = []
const processedAssistantText = new Map<string, string>()
const processedToolMessageIds = new Set<string>()
const speechSegmenter = createMcuSpeechSegmenter({ emitOnSentenceEnd: true })

const currentTranscript = computed(() => {
  const liveTranscript = normalizeText([
    browserRecognition.transcript.value,
    browserRecognition.partialTranscript.value,
    backendStreamTranscript.value,
  ].filter(Boolean).join(' '))
  return liveTranscript || submittedTranscript.value
})

const isOutputPlaying = computed(() =>
  segmentAudioPlaying.value || speech.isPlaying.value || speech.isCustomPlaying.value,
)

const agentDisplayName = computed(() => {
  const session = chatStore.activeSession
  const agent = session?.agent || session?.codingAgentId || 'hermes'
  return {
    hermes: 'Hermes',
    claude: 'Claude',
    'claude-code': 'Claude',
    codex: 'Codex',
    grok: 'Grok',
    opencode: 'OpenCode',
    dsh: 'DeepSeek Harness',
    'ekko-agent': 'Ekko',
  }[agent] || agent
})
const statusLabel = computed(() => t(`realtimeVoice.status.${mode.value}`, {
  agent: agentDisplayName.value,
}))
const statusHint = computed(() => {
  return t(`realtimeVoice.hint.${mode.value}`)
})
const sessionTitle = computed(() => chatStore.activeSession?.title?.trim() || t('realtimeVoice.untitledSession'))
const displayCaption = computed(() => {
  if (errorMessage.value) return errorMessage.value
  if (mode.value === 'speaking' && activeSpeechSegment.value) {
    return activeSpeechSegment.value.subtitleText
  }
  if (
    (
      mode.value === 'listening'
      || mode.value === 'processing'
      || (mode.value === 'thinking' && !responseAudioStarted.value)
    )
    && currentTranscript.value
  ) {
    return currentTranscript.value
  }
  return statusHint.value
})
const visualEnergy = computed(() => {
  if (mode.value === 'listening') return Math.max(0.16, audioLevel.value)
  if (mode.value === 'thinking') return 0.42
  if (mode.value === 'speaking') return 0.58
  if (mode.value === 'processing') return 0.28
  return 0.1
})
const orbStyle = computed(() => ({
  '--voice-energy': visualEnergy.value.toFixed(3),
  transform: `scale(${(1 + visualEnergy.value * 0.075).toFixed(3)})`,
}))
const voiceToolCalls = computed(() => {
  if (!responseStartedAt.value) return []
  return chatStore.messages
    .slice(responseStartMessageIndex)
    .filter((message): message is Message => message.role === 'tool' && Boolean(message.toolName))
    .slice(-4)
    .reverse()
})

function normalizeText(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function toolDetail(message: Message) {
  const value = message.toolStatus === 'running'
    ? (message.toolPreview ?? message.toolArgs)
    : (message.toolResult ?? message.toolPreview)
  if (value == null) return ''
  let text = typeof value === 'string' ? value : ''
  if (!text) {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  text = normalizeText(text)
  return text.length > 180 ? `${text.slice(0, 177)}...` : text
}

function browserCaptureLanguage() {
  return sttSettings.openaiLanguage.value.trim() || sttSettings.customLanguage.value.trim() || ''
}

function browserCaptureContinuous() {
  return !isMobileDevice()
}

function shouldUseBackendStream(setting: SttProviderSettingsResponse | null) {
  return Boolean(setting && (setting.provider === 'local' || isDesktopShell() || isMobileDevice()))
}

function clearTimers() {
  if (silenceTimer) clearTimeout(silenceTimer)
  if (restartTimer) clearTimeout(restartTimer)
  silenceTimer = null
  restartTimer = null
}

function stopPreparedSegmentAudio() {
  const finish = finishActiveSegmentAudio
  finishActiveSegmentAudio = null
  if (activeSegmentAudio) {
    activeSegmentAudio.pause()
    activeSegmentAudio.src = ''
    activeSegmentAudio = null
  }
  if (activeSegmentAudioUrl) {
    URL.revokeObjectURL(activeSegmentAudioUrl)
    activeSegmentAudioUrl = null
  }
  segmentAudioPlaying.value = false
  activeSpeechSegment.value = null
  finish?.()
}

function abortSpeechSynthesis() {
  for (const controller of synthesisControllers) controller.abort()
  synthesisControllers.clear()
  const error = new DOMException('Speech synthesis cancelled', 'AbortError')
  while (synthesisJobs.length > 0) synthesisJobs.shift()?.resolve({ ok: false, error })
}

function currentSynthesisRequest(text: string, signal: AbortSignal) {
  if (voiceSettings.provider.value === 'openai' && voiceSettings.openaiBaseUrl.value) {
    return synthesizeSpeech({
      provider: 'openai',
      text,
      signal,
      options: {
        baseUrl: voiceSettings.openaiBaseUrl.value,
        apiKey: voiceSettings.openaiApiKey.value,
        model: voiceSettings.openaiModel.value,
        voice: voiceSettings.openaiVoice.value,
      },
    })
  }
  if (voiceSettings.provider.value === 'custom' && voiceSettings.customUrl.value) {
    return synthesizeSpeech({
      provider: 'custom',
      text,
      signal,
      options: {
        baseUrl: voiceSettings.customUrl.value,
        apiKey: voiceSettings.customApiKey.value || undefined,
      },
    })
  }
  if (voiceSettings.provider.value === 'edge') {
    return synthesizeSpeech({
      provider: 'edge',
      text,
      signal,
      options: {
        baseUrl: voiceSettings.edgeUrl.value || '/api/tts/proxy',
        voice: voiceSettings.edgeVoice.value,
        rate: speedToEdgeRate(voiceSettings.edgeRate.value),
        pitch: hzToEdgePitch(voiceSettings.edgePitchHz.value),
      },
    })
  }
  if (voiceSettings.provider.value === 'mimo') {
    return synthesizeSpeech({
      provider: 'mimo',
      text,
      signal,
      options: {
        baseUrl: voiceSettings.mimoBaseUrl.value,
        apiKey: voiceSettings.mimoApiKey.value || undefined,
        authMode: voiceSettings.mimoAuthMode.value,
        model: voiceSettings.mimoModel.value,
        voiceMode: voiceSettings.mimoModel.value === 'mimo-v2.5-tts-voicedesign'
          ? 'voiceDesign'
          : voiceSettings.mimoModel.value === 'mimo-v2.5-tts-voiceclone' ? 'voiceClone' : 'preset',
        voice: voiceSettings.mimoVoice.value,
        voiceDesignDesc: voiceSettings.mimoVoiceDesignDesc.value || undefined,
        voiceCloneDataUri: voiceSettings.mimoVoiceCloneDataUri.value || undefined,
        voiceCloneFormat: voiceSettings.mimoVoiceCloneFormat.value,
        stylePrompt: voiceSettings.mimoStylePrompt.value || undefined,
      },
    })
  }
  if (voiceSettings.provider.value === 'doubao') {
    return synthesizeSpeech({
      provider: 'doubao',
      text,
      signal,
      options: {
        baseUrl: voiceSettings.doubaoBaseUrl.value,
        model: voiceSettings.doubaoModel.value,
        voice: voiceSettings.doubaoVoice.value,
        stylePrompt: voiceSettings.doubaoStylePrompt.value || undefined,
        speed: voiceSettings.doubaoSpeed.value || undefined,
      },
    })
  }
  if (isServerTtsProvider(voiceSettings.provider.value)) {
    const provider = voiceSettings.provider.value
    // 实时语音不走 useSpeech.applyTtsPreset，克隆参考音频需在此单独注入
    const cloneUri = provider === 'openrouter'
      ? voiceSettings.openrouterVoiceCloneDataUri.value
      : ''
    return synthesizeSpeech({
      provider,
      text,
      signal,
      ...(cloneUri ? { options: { voiceCloneDataUri: cloneUri } } : {}),
    })
  }
  return null
}

function pumpSpeechSynthesis() {
  while (activeSynthesisCount < MAX_CONCURRENT_TTS_SYNTHESIS && synthesisJobs.length > 0) {
    const job = synthesisJobs.shift()
    if (!job) break
    if (job.generation !== playbackGeneration) {
      job.resolve({ ok: false, error: new DOMException('Stale speech segment', 'AbortError') })
      continue
    }

    const controller = new AbortController()
    const request = currentSynthesisRequest(job.text, controller.signal)
    if (!request) {
      job.resolve({ ok: false, error: new Error('Browser speech does not require synthesis') })
      continue
    }

    activeSynthesisCount += 1
    synthesisControllers.add(controller)
    void request
      .then(({ audio }) => job.resolve({ ok: true, audio }))
      .catch(error => job.resolve({ ok: false, error }))
      .finally(() => {
        activeSynthesisCount -= 1
        synthesisControllers.delete(controller)
        pumpSpeechSynthesis()
      })
  }
}

function prepareSpeechSegment(text: string, generation: number) {
  if (
    voiceSettings.provider.value === 'webspeech'
    || (voiceSettings.provider.value === 'openai' && !voiceSettings.openaiBaseUrl.value)
    || (voiceSettings.provider.value === 'custom' && !voiceSettings.customUrl.value)
  ) return null
  return new Promise<PreparedSpeech>((resolve) => {
    synthesisJobs.push({ generation, text, resolve })
    pumpSpeechSynthesis()
  })
}

function resetResponseSpeechState() {
  playbackGeneration += 1
  abortSpeechSynthesis()
  stopPreparedSegmentAudio()
  speechSegments.value = []
  activeSpeechSegment.value = null
  responseStartMessageIndex = chatStore.messages.length
  lastResponseAssistantId = null
  responseFinalizing = false
  responseAudioStarted.value = false
  ttsSegmentIndex = 0
  processedAssistantText.clear()
  processedToolMessageIds.clear()
  speechSegmenter.reset()
}

function stopVisualizer() {
  if (visualizerFrame !== null) cancelAnimationFrame(visualizerFrame)
  visualizerFrame = null
  if (visualizerOwnsStream) {
    for (const track of visualizerStream?.getTracks() || []) track.stop()
  }
  visualizerStream = null
  visualizerOwnsStream = false
  if (visualizerContext) void visualizerContext.close().catch(() => undefined)
  visualizerContext = null
  audioLevel.value = 0
}

async function startVisualizer(sourceStream?: MediaStream | null) {
  stopVisualizer()
  if (typeof AudioContext === 'undefined') return
  if (!sourceStream && !navigator.mediaDevices?.getUserMedia) return
  try {
    const ownsStream = !sourceStream
    const stream = sourceStream || await navigator.mediaDevices.getUserMedia({ audio: true })
    if (mode.value !== 'listening') {
      if (ownsStream) {
        for (const track of stream.getTracks()) track.stop()
      }
      return
    }
    const context = new AudioContext()
    const analyser = context.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.72
    context.createMediaStreamSource(stream).connect(analyser)
    const samples = new Uint8Array(analyser.frequencyBinCount)
    visualizerStream = stream
    visualizerOwnsStream = ownsStream
    visualizerContext = context

    const updateLevel = () => {
      analyser.getByteFrequencyData(samples)
      let total = 0
      for (let index = 0; index < samples.length; index += 1) total += samples[index]
      const nextLevel = Math.min(1, total / samples.length / 96)
      audioLevel.value += (nextLevel - audioLevel.value) * 0.34
      visualizerFrame = requestAnimationFrame(updateLevel)
    }
    updateLevel()
  } catch {
    // Voice capture remains usable even when the decorative analyser is unavailable.
  }
}

async function loadActiveBackendSetting() {
  if (backendSettingPromise) return backendSettingPromise

  backendSettingPromise = fetchSttSettings()
    .then((response) => {
      const provider = response.activeProvider
      if (!provider || provider === 'browser') return null
      return response.providers.find(row => row.provider === provider && (provider === 'local' || row.secrets?.apiKey === '[stored]')) || null
    })
    .catch(() => null)

  return backendSettingPromise
}

function setError(cause: unknown) {
  if (isNoSpeechError(cause)) {
    errorMessage.value = ''
    if (mode.value !== 'listening') mode.value = 'idle'
    return
  }
  errorMessage.value = cause instanceof Error ? cause.message : String(cause)
  mode.value = 'error'
}

function isNoSpeechError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause)
  return /no[_ -]?speech|no speech detected/i.test(message)
}

function resetBackendStream() {
  backendStreamGeneration += 1
  backendStreamQueue = Promise.resolve()
  backendStreamFailure = null
  backendStreamTranscript.value = ''
}

function activeBackendStreamRecorder() {
  return activeBackendSetting?.provider === 'local' ? localPcmStreamRecorder : pcmStreamRecorder
}

async function cancelActiveLocalStream() {
  const sessionId = localStreamSessionId
  localStreamSessionId = null
  if (!sessionId) return
  await cancelLocalSttStream(sessionId).catch(() => undefined)
}

function queueBackendStreamChunk(audio: Blob) {
  const setting = activeBackendSetting
  const generation = backendStreamGeneration
  const localSessionId = setting?.provider === 'local' ? localStreamSessionId : null
  if (!setting || audio.size <= 44) return backendStreamQueue

  const settings = setting.settings
  backendStreamQueue = backendStreamQueue.then(async () => {
    if (generation !== backendStreamGeneration) return
    try {
      const result = setting.provider === 'local'
        ? await pushLocalSttStreamChunk(localSessionId || '', audio)
        : await transcribeSpeech({
            audio,
            provider: setting.provider,
            language: typeof settings.language === 'string' ? settings.language : undefined,
            prompt: typeof settings.prompt === 'string' ? settings.prompt : undefined,
          })
      if (generation !== backendStreamGeneration) return
      const text = normalizeText(result.text)
      if (setting.provider === 'local') {
        backendStreamTranscript.value = text
      } else if (text) {
        backendStreamTranscript.value = normalizeText(`${backendStreamTranscript.value} ${text}`)
      }
    } catch (cause) {
      if (generation !== backendStreamGeneration || isNoSpeechError(cause)) return
      backendStreamFailure = cause
      throw cause
    }
  }).catch((cause) => {
    if (generation !== backendStreamGeneration || isNoSpeechError(cause)) return
    backendStreamFailure = cause
    activeBackendStreamRecorder().cancel()
    void cancelActiveLocalStream()
    activeCaptureMode = null
    stopVisualizer()
    setError(cause)
  })

  return backendStreamQueue
}

async function startBackendStreamCapture() {
  resetBackendStream()
  if (activeBackendSetting?.provider === 'local') {
    const generation = backendStreamGeneration
    const session = await startLocalSttStream()
    if (generation !== backendStreamGeneration) {
      await cancelLocalSttStream(session.sessionId).catch(() => undefined)
      return
    }
    localStreamSessionId = session.sessionId
  }

  activeCaptureMode = 'backend-stream'
  const recorder = activeBackendStreamRecorder()
  try {
    await recorder.start()
  } catch (cause) {
    await cancelActiveLocalStream()
    throw cause
  }
  mode.value = 'listening'
  void startVisualizer(recorder.stream.value)
}

async function startCapture() {
  clearTimers()
  if (!chatStore.activeSessionId) {
    setError(t('realtimeVoice.sessionMissing'))
    return
  }
  if (chatStore.isSessionLive(chatStore.activeSessionId)) {
    mode.value = 'thinking'
    return
  }

  speech.stop(true)
  browserRecognition.clearError()
  errorMessage.value = ''
  submittedTranscript.value = ''
  backendStreamTranscript.value = ''
  activeSpeechSegment.value = null
  responseStartedAt.value = 0
  sessionActive.value = true
  activeBackendSetting = await loadActiveBackendSetting()

  if ((isDesktopShell() || isMobileDevice()) && !activeBackendSetting) {
    activeCaptureMode = null
    setError(t('realtimeVoice.backendStreamRequired'))
    return
  }

  const backendStream = shouldUseBackendStream(activeBackendSetting)
  activeCaptureMode = backendStream ? 'backend-stream' : 'browser'

  try {
    if (backendStream) {
      await startBackendStreamCapture()
      return
    }
    if (activeBackendSetting) {
      try {
        await micRecorder.start()
      } catch {
        activeBackendSetting = null
      }
    }

    await browserRecognition.start({
      language: browserCaptureLanguage(),
      continuous: browserCaptureContinuous(),
    })
    mode.value = 'listening'
    void startVisualizer(micRecorder.stream.value)
  } catch (cause) {
    activeCaptureMode = null
    micRecorder.cancel()
    pcmStreamRecorder.cancel()
    localPcmStreamRecorder.cancel()
    void cancelActiveLocalStream()
    setError(cause)
  }
}

async function submitTranscript(value: string) {
  const transcript = normalizeText(value)
  submittedTranscript.value = transcript
  if (!transcript) {
    stopVisualizer()
    mode.value = 'idle'
    return
  }

  speech.stop(true)
  resetResponseSpeechState()
  responseStartedAt.value = Date.now()
  waitingForResponse.value = true
  mode.value = 'thinking'
  await chatStore.sendMessage(transcript)
}

async function transcribeBackendCapture(audio: Blob, setting: SttProviderSettingsResponse) {
  if (audio.size <= 0) {
    mode.value = 'idle'
    return
  }

  clearTimers()
  mode.value = 'processing'

  try {
    const settings = setting.settings
    const result = await transcribeSpeech({
      audio,
      provider: setting.provider,
      language: typeof settings.language === 'string' ? settings.language : undefined,
      prompt: typeof settings.prompt === 'string' ? settings.prompt : undefined,
    })
    await submitTranscript(result.text)
  } catch (cause) {
    if (isNoSpeechError(cause)) {
      errorMessage.value = ''
      activeCaptureMode = null
      stopVisualizer()
      mode.value = 'idle'
      scheduleRestart()
      return
    }
    setError(cause)
  }
}

async function handleRecognitionFailure() {
  if (!sessionActive.value || activeCaptureMode !== 'browser' || handlingRecognitionFailure || !browserRecognition.error.value) return
  handlingRecognitionFailure = true
  clearTimers()

  try {
    if (browserRecognition.errorCode.value === 'no-speech') {
      browserRecognition.clearError()
      if (mode.value === 'processing' && !waitingForResponse.value) mode.value = 'listening'
      scheduleBrowserRecognitionRestart()
      return
    }

    mode.value = 'processing'
    if (browserRecognition.errorCode.value === 'network' && activeBackendSetting) {
      const audio = await micRecorder.stop()
      stopVisualizer()
      activeCaptureMode = null
      if (audio.size <= 0) {
        setError(browserRecognition.error.value)
        return
      }
      await transcribeBackendCapture(audio, activeBackendSetting)
      return
    }

    micRecorder.cancel()
    stopVisualizer()
    activeCaptureMode = null
    setError(browserRecognition.errorCode.value === 'network'
      ? t('realtimeVoice.networkUnavailableNoFallback')
      : browserRecognition.error.value)
  } catch (cause) {
    micRecorder.cancel()
    stopVisualizer()
    activeCaptureMode = null
    setError(cause)
  } finally {
    handlingRecognitionFailure = false
  }
}

async function stopCapture(manual = false) {
  if (mode.value !== 'listening') return
  clearTimers()
  mode.value = 'processing'

  if (activeCaptureMode === 'backend-stream' && activeBackendSetting) {
    const recorder = activeBackendStreamRecorder()
    try {
      const finalChunk = await recorder.stop()
      stopVisualizer()
      if (finalChunk) queueBackendStreamChunk(finalChunk)
      await backendStreamQueue
      if (backendStreamFailure) return
      if (activeBackendSetting.provider === 'local') {
        const sessionId = localStreamSessionId
        localStreamSessionId = null
        if (!sessionId) throw new Error('Local STT stream session is not active')
        const result = await finishLocalSttStream(sessionId)
        backendStreamTranscript.value = normalizeText(result.text) || backendStreamTranscript.value
      }
      activeCaptureMode = null
      if (!backendStreamTranscript.value) {
        mode.value = manual ? 'paused' : 'idle'
        if (!manual) scheduleRestart()
        return
      }
      await submitTranscript(backendStreamTranscript.value)
    } catch (cause) {
      if (isNoSpeechError(cause)) {
        activeCaptureMode = null
        stopVisualizer()
        mode.value = manual ? 'paused' : 'idle'
        if (!manual) scheduleRestart()
        return
      }
      activeCaptureMode = null
      recorder.cancel()
      await cancelActiveLocalStream()
      stopVisualizer()
      setError(cause)
    }
    return
  }

  let transcript = ''

  try {
    transcript = await browserRecognition.stop()
  } catch (cause) {
    if (browserRecognition.error.value) {
      void handleRecognitionFailure()
    } else {
      setError(cause)
    }
    return
  }

  if (micRecorder.state.value.status !== 'idle') {
    await micRecorder.stop().catch(() => undefined)
  }
  activeCaptureMode = null
  stopVisualizer()
  if (!normalizeText(transcript)) {
    mode.value = manual ? 'paused' : 'idle'
    if (!manual) scheduleRestart()
    return
  }
  await submitTranscript(transcript)
}

async function stopActiveTurn() {
  clearTimers()
  browserRecognition.cancel()
  micRecorder.cancel()
  pcmStreamRecorder.cancel()
  localPcmStreamRecorder.cancel()
  backendStreamGeneration += 1
  void cancelActiveLocalStream()
  activeCaptureMode = null
  stopVisualizer()
  waitingForResponse.value = false
  resetResponseSpeechState()
  speech.stop(true)
  await chatStore.stopStreaming()
  mode.value = 'idle'
}

async function toggleCapture() {
  if (mode.value === 'listening') {
    await stopCapture(true)
    return
  }
  if (mode.value === 'thinking' || mode.value === 'speaking') {
    await stopActiveTurn()
    return
  }
  await startCapture()
}

function scheduleRestart(delay = 420) {
  if (!sessionActive.value) return
  if (restartTimer) clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    restartTimer = null
    if (sessionActive.value && mode.value !== 'listening' && !waitingForResponse.value) {
      void startCapture()
    }
  }, delay)
}

function scheduleBrowserRecognitionRestart(delay = 420) {
  if (!sessionActive.value || activeCaptureMode !== 'browser') return
  if (restartTimer) clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    restartTimer = null
    if (!sessionActive.value || activeCaptureMode !== 'browser') return
    browserRecognition.clearError()
    void browserRecognition.start({
      language: browserCaptureLanguage(),
      continuous: browserCaptureContinuous(),
    }).catch((cause) => {
      activeCaptureMode = null
      micRecorder.cancel()
      stopVisualizer()
      setError(cause)
    })
  }, delay)
}

function scheduleSilenceCommit() {
  if (silenceTimer) clearTimeout(silenceTimer)
  silenceTimer = setTimeout(() => {
    silenceTimer = null
    if (mode.value === 'listening') void stopCapture(false)
  }, SILENCE_COMMIT_MS)
}

function waitForSpeechPlayback(generation: number) {
  if (!isOutputPlaying.value || generation !== playbackGeneration) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      stopWatching()
      resolve()
    }
    const stopWatching = watch(isOutputPlaying, playing => {
      if (!playing || generation !== playbackGeneration) finish()
    })
    const timeout = setTimeout(finish, 300_000)
  })
}

async function playPreparedSpeech(segment: VoiceSpeechSegment, audioBlob: Blob) {
  const url = URL.createObjectURL(audioBlob)
  const audio = new Audio(url)
  activeSegmentAudio = audio
  activeSegmentAudioUrl = url

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      audio.onended = null
      audio.onerror = null
      if (activeSegmentAudio === audio) activeSegmentAudio = null
      if (activeSegmentAudioUrl === url) activeSegmentAudioUrl = null
      if (finishActiveSegmentAudio === stop) finishActiveSegmentAudio = null
      URL.revokeObjectURL(url)
      segmentAudioPlaying.value = false
      if (activeSpeechSegment.value?.id === segment.id) activeSpeechSegment.value = null
      if (error) reject(error)
      else resolve()
    }
    const stop = () => finish()
    finishActiveSegmentAudio = stop
    audio.onended = () => finish()
    audio.onerror = () => finish(new Error('TTS audio playback failed'))

    void audio.play()
      .then(() => {
        if (segment.generation !== playbackGeneration || !sessionActive.value) {
          audio.pause()
          finish()
          return
        }
        segmentAudioPlaying.value = true
        activeSpeechSegment.value = segment
        responseAudioStarted.value = true
        mode.value = 'speaking'
      })
      .catch(finish)
  })
}

async function playSpeechSegment(segment: VoiceSpeechSegment) {
  const { id, audioText, generation } = segment
  if (!audioText || generation !== playbackGeneration || !sessionActive.value) return
  try {
    if (segment.synthesis) {
      const prepared = await segment.synthesis
      if (generation !== playbackGeneration || !sessionActive.value) return
      if (!prepared.ok) throw prepared.error
      await playPreparedSpeech(segment, prepared.audio)
    } else if (speech.isSupported.value) {
      const text = speech.extractReadableText(audioText)
      speech.speakViaBrowser(id, text, {
        voiceName: voiceSettings.webspeechVoice.value || undefined,
      })
      activeSpeechSegment.value = segment
      responseAudioStarted.value = true
      mode.value = 'speaking'
      await waitForSpeechPlayback(generation)
    } else {
      if (generation === playbackGeneration && waitingForResponse.value) mode.value = 'thinking'
      return
    }
    if (generation !== playbackGeneration || !sessionActive.value) return
    if (activeSpeechSegment.value?.id === segment.id) activeSpeechSegment.value = null
    if (waitingForResponse.value) mode.value = 'thinking'
  } catch (cause) {
    if (activeSpeechSegment.value?.id === segment.id) activeSpeechSegment.value = null
    if (generation === playbackGeneration) setError(cause)
  }
}

function resolveSpeechQueueIdle() {
  if (speechQueueRunning || speechSegments.value.length > 0) return
  for (const resolve of speechQueueIdleWaiters) resolve()
  speechQueueIdleWaiters.clear()
}

function waitForSpeechQueueIdle() {
  if (!speechQueueRunning && speechSegments.value.length === 0) return Promise.resolve()
  return new Promise<void>(resolve => speechQueueIdleWaiters.add(resolve))
}

async function drainSpeechSegments() {
  if (speechQueueRunning) return
  speechQueueRunning = true
  try {
    while (speechSegments.value.length > 0) {
      const segment = speechSegments.value.shift()
      if (!segment || segment.generation !== playbackGeneration) continue
      await playSpeechSegment(segment)
    }
  } finally {
    speechQueueRunning = false
    if (speechSegments.value.length > 0) {
      void drainSpeechSegments()
    } else {
      resolveSpeechQueueIdle()
    }
  }
}

function enqueueSpeechSegment(text: string, assistantId = 'assistant') {
  if (!text) return
  const generation = playbackGeneration
  speechSegments.value.push({
    id: `${assistantId}:voice:${++ttsSegmentIndex}`,
    audioText: text,
    subtitleText: text,
    generation,
    synthesis: prepareSpeechSegment(text, generation),
  })
  void drainSpeechSegments()
}

function flushSpeechSegmenter(assistantId = lastResponseAssistantId || 'assistant') {
  const segment = speechSegmenter.flush()
  if (segment) enqueueSpeechSegment(segment, assistantId)
}

function processResponseMessages() {
  const responseMessages = chatStore.messages.slice(responseStartMessageIndex)
  for (const message of responseMessages) {
    if (message.role === 'assistant') {
      const content = message.content || ''
      const previous = processedAssistantText.get(message.id) || ''
      processedAssistantText.set(message.id, content)

      if (!content.startsWith(previous)) continue
      const delta = content.slice(previous.length)
      if (!delta) continue
      if (lastResponseAssistantId && lastResponseAssistantId !== message.id) {
        flushSpeechSegmenter(lastResponseAssistantId)
      }
      lastResponseAssistantId = message.id
      for (const segment of speechSegmenter.pushDelta(delta)) {
        enqueueSpeechSegment(segment, message.id)
      }
      continue
    }

    if (message.role === 'tool' && !processedToolMessageIds.has(message.id)) {
      processedToolMessageIds.add(message.id)
      flushSpeechSegmenter()
    }
  }
}

function finishResponseIfReady() {
  if (!waitingForResponse.value) return
  processResponseMessages()
  if (chatStore.isStreaming || responseFinalizing) return
  const responseMessages = chatStore.messages.slice(responseStartMessageIndex)
  const response = [...responseMessages].reverse().find(message =>
    message.role === 'assistant' && Boolean(message.content.trim()),
  )
  if (!response) {
    const failure = [...responseMessages].reverse().find(message =>
      message.timestamp >= responseStartedAt.value
        && (message.role === 'system' || message.systemType === 'error'),
    )
    if (failure) {
      waitingForResponse.value = false
      setError(failure.content)
    }
    return
  }

  responseFinalizing = true
  flushSpeechSegmenter(response.id)
  const generation = playbackGeneration
  void waitForSpeechQueueIdle().finally(() => {
    if (generation !== playbackGeneration || !sessionActive.value) return
    waitingForResponse.value = false
    if (mode.value !== 'error') {
      mode.value = activeCaptureMode === 'browser' ? 'listening' : 'idle'
    }
    if (activeCaptureMode === null) scheduleRestart()
  })
}

function closeStage() {
  sessionActive.value = false
  waitingForResponse.value = false
  playbackGeneration += 1
  speechSegments.value = []
  activeSpeechSegment.value = null
  abortSpeechSynthesis()
  stopPreparedSegmentAudio()
  clearTimers()
  browserRecognition.cancel()
  micRecorder.cancel()
  pcmStreamRecorder.cancel()
  localPcmStreamRecorder.cancel()
  backendStreamGeneration += 1
  void cancelActiveLocalStream()
  activeCaptureMode = null
  stopVisualizer()
  speech.stop(true)
  emit('close')
}

watch(currentTranscript, (value) => {
  if (mode.value !== 'listening' || activeCaptureMode !== 'browser' || !value) return
  scheduleSilenceCommit()
})
watch(() => pcmStreamRecorder.level.value, (value) => {
  if (
    mode.value !== 'listening'
    || activeCaptureMode !== 'backend-stream'
    || !pcmStreamRecorder.hasSpeech.value
    || value < BACKEND_STREAM_VOICE_LEVEL
  ) return
  scheduleSilenceCommit()
})
watch(() => localPcmStreamRecorder.level.value, (value) => {
  if (
    mode.value !== 'listening'
    || activeCaptureMode !== 'backend-stream'
    || activeBackendSetting?.provider !== 'local'
    || !localPcmStreamRecorder.hasSpeech.value
    || value < BACKEND_STREAM_VOICE_LEVEL
  ) return
  scheduleSilenceCommit()
})
watch(() => browserRecognition.error.value, () => {
  void handleRecognitionFailure()
})

watch(
  () => chatStore.messages.map(message => `${message.id}:${message.isStreaming ? 1 : 0}:${message.content.length}`).join('|'),
  finishResponseIfReady,
)
watch(() => chatStore.isStreaming, finishResponseIfReady)
onMounted(() => {
  previousBodyOverflow = document.body.style.overflow
  previousDocumentOverflow = document.documentElement.style.overflow
  document.body.style.overflow = 'hidden'
  document.documentElement.style.overflow = 'hidden'
  sessionActive.value = true
  restartTimer = setTimeout(() => {
    restartTimer = null
    void loadActiveBackendSetting().then((setting) => {
      if (!sessionActive.value) return
      activeBackendSetting = setting
      void startCapture()
    })
  }, 180)
})

onBeforeUnmount(() => {
  sessionActive.value = false
  playbackGeneration += 1
  speechSegments.value = []
  activeSpeechSegment.value = null
  abortSpeechSynthesis()
  stopPreparedSegmentAudio()
  clearTimers()
  browserRecognition.cancel()
  micRecorder.cancel()
  pcmStreamRecorder.cancel()
  localPcmStreamRecorder.cancel()
  backendStreamGeneration += 1
  void cancelActiveLocalStream()
  activeCaptureMode = null
  stopVisualizer()
  speech.stop(true)
  document.body.style.overflow = previousBodyOverflow
  document.documentElement.style.overflow = previousDocumentOverflow
})
</script>

<template>
  <section
    class="voice-stage dark"
    :class="[`voice-stage--${mode}`, { 'voice-stage--with-tools': voiceToolCalls.length > 0 }]"
    role="dialog"
    aria-modal="true"
    :aria-label="t('realtimeVoice.title')"
    data-testid="realtime-voice-stage"
  >
    <div class="voice-stage__wash voice-stage__wash--top" aria-hidden="true" />
    <div class="voice-stage__wash voice-stage__wash--bottom" aria-hidden="true" />

    <header class="voice-stage__header">
      <button class="voice-stage__back" type="button" :aria-label="t('realtimeVoice.back')" @click="closeStage">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
      </button>
      <div class="voice-stage__identity">
        <strong>{{ sessionTitle }}</strong>
        <span>{{ agentDisplayName }}</span>
      </div>
      <span class="voice-stage__header-spacer" />
    </header>

    <main class="voice-stage__main">
      <section class="voice-stage__interaction">
        <button
        class="voice-stage__bloom"
        type="button"
        :style="orbStyle"
        :aria-label="statusLabel"
        :aria-pressed="mode === 'listening'"
        data-testid="realtime-voice-toggle"
        @click="toggleCapture"
        >
          <svg viewBox="0 0 420 420" role="presentation" aria-hidden="true">
          <defs>
            <radialGradient id="voice-bloom-cyan" cx="35%" cy="30%" r="75%">
              <stop class="voice-stage__stop voice-stage__stop--light" offset="0%" />
              <stop class="voice-stage__stop voice-stage__stop--cyan" offset="42%" />
              <stop class="voice-stage__stop voice-stage__stop--blue" offset="100%" />
            </radialGradient>
            <radialGradient id="voice-bloom-violet" cx="66%" cy="72%" r="70%">
              <stop class="voice-stage__stop voice-stage__stop--rose" offset="0%" />
              <stop class="voice-stage__stop voice-stage__stop--violet" offset="58%" />
              <stop offset="100%" stop-color="#4427b8" stop-opacity="0" />
            </radialGradient>
            <filter id="voice-bloom-warp" x="-35%" y="-35%" width="170%" height="170%">
              <feTurbulence type="fractalNoise" baseFrequency=".009 .014" numOctaves="2" seed="8" result="noise">
                <animate attributeName="baseFrequency" dur="9s" values=".009 .014;.014 .009;.009 .014" repeatCount="indefinite" />
              </feTurbulence>
              <feDisplacementMap in="SourceGraphic" in2="noise" scale="34" xChannelSelector="R" yChannelSelector="B" />
            </filter>
            <filter id="voice-bloom-blur" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="24" />
            </filter>
          </defs>
          <circle class="voice-stage__bloom-haze" cx="210" cy="210" r="128" fill="url(#voice-bloom-cyan)" filter="url(#voice-bloom-blur)" />
          <g class="voice-stage__bloom-body" filter="url(#voice-bloom-warp)">
            <circle cx="210" cy="210" r="112" fill="url(#voice-bloom-cyan)" />
            <circle class="voice-stage__bloom-color" cx="226" cy="224" r="104" fill="url(#voice-bloom-violet)" />
            <ellipse class="voice-stage__bloom-shine" cx="174" cy="162" rx="56" ry="42" fill="#ffffff" opacity=".22" />
          </g>
          </svg>
        </button>

        <div class="voice-stage__status" aria-live="polite">
          <i />
          <span>{{ statusLabel }}</span>
        </div>

        <p
          class="voice-stage__caption"
          aria-live="polite"
          aria-atomic="true"
          data-testid="realtime-voice-caption"
        >{{ displayCaption }}</p>

        <div
          v-if="voiceToolCalls.length"
          class="voice-stage__tools"
          aria-live="polite"
          data-testid="realtime-voice-tool-calls"
        >
          <article
            v-for="tool in voiceToolCalls"
            :key="tool.id"
            class="voice-stage__tool"
            :class="`voice-stage__tool--${tool.toolStatus || 'running'}`"
          >
            <span class="voice-stage__tool-state" aria-hidden="true">
              <span v-if="tool.toolStatus === 'running'" class="voice-stage__tool-spinner" />
              <svg v-else-if="tool.toolStatus === 'error'" viewBox="0 0 20 20">
                <path d="m6.5 6.5 7 7m0-7-7 7" />
              </svg>
              <svg v-else viewBox="0 0 20 20">
                <path d="m5.5 10.2 2.8 2.8 6.2-6.2" />
              </svg>
            </span>
            <span class="voice-stage__tool-copy">
              <strong>{{ tool.toolName }}</strong>
              <span v-if="toolDetail(tool)">{{ toolDetail(tool) }}</span>
            </span>
            <time v-if="tool.toolDuration !== undefined">{{ tool.toolDuration.toFixed(1) }}s</time>
          </article>
        </div>
      </section>
    </main>

  </section>
</template>

<style scoped>
.voice-stage {
  --voice-accent: #70f4ff;
  --voice-accent-2: #806dff;
  position: relative;
  isolation: isolate;
  min-height: 100dvh;
  overflow: hidden;
  color: #f4fbff;
  background:
    radial-gradient(circle at 50% 43%, rgba(73, 103, 255, 0.14), transparent 32%),
    linear-gradient(145deg, #05070d 0%, #080d19 48%, #04060c 100%);
}

.voice-stage__grid {
  position: absolute;
  inset: 0;
  z-index: -3;
  opacity: 0.21;
  background-image:
    linear-gradient(rgba(118, 201, 255, 0.08) 1px, transparent 1px),
    linear-gradient(90deg, rgba(118, 201, 255, 0.08) 1px, transparent 1px);
  background-size: 56px 56px;
  mask-image: radial-gradient(circle at center, black, transparent 78%);
}

.voice-stage__glow {
  position: absolute;
  z-index: -2;
  width: 34rem;
  height: 34rem;
  border-radius: 50%;
  filter: blur(100px);
  opacity: 0.13;
}

.voice-stage__glow--left { left: -20rem; top: 16%; background: #2ee9ff; }
.voice-stage__glow--right { right: -22rem; bottom: -8rem; background: #795cff; }

.voice-stage__header {
  position: relative;
  z-index: 4;
  height: 76px;
  padding: env(safe-area-inset-top, 0) clamp(18px, 4vw, 56px) 0;
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
  border-bottom: 1px solid rgba(154, 215, 255, 0.1);
  background: rgba(3, 7, 14, 0.42);
  backdrop-filter: blur(22px);
}

.voice-stage__back,
.voice-stage__orb,
.voice-stage__primary-control {
  border: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.voice-stage__back {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(171, 224, 255, 0.14);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.035);
}

.voice-stage__back:hover { background: rgba(112, 244, 255, 0.09); border-color: rgba(112, 244, 255, 0.34); }
.voice-stage__back svg { width: 20px; fill: none; stroke: currentColor; stroke-width: 1.7; }

.voice-stage__identity { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.voice-stage__identity strong { overflow: hidden; font-size: 14px; font-weight: 560; text-overflow: ellipsis; white-space: nowrap; }
.voice-stage__eyebrow { color: rgba(183, 224, 247, 0.54); font-size: 9px; letter-spacing: 0.24em; text-transform: uppercase; }

.voice-stage__connection {
  display: flex;
  align-items: center;
  gap: 9px;
  color: rgba(200, 235, 250, 0.67);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.voice-stage__signal { display: flex; align-items: end; gap: 2px; height: 10px; }
.voice-stage__signal i { width: 2px; border-radius: 2px; background: var(--voice-accent); box-shadow: 0 0 7px var(--voice-accent); }
.voice-stage__signal i:nth-child(1) { height: 4px; opacity: 0.55; }
.voice-stage__signal i:nth-child(2) { height: 7px; opacity: 0.75; }
.voice-stage__signal i:nth-child(3) { height: 10px; }

.voice-stage__main {
  width: min(980px, calc(100% - 32px));
  min-height: calc(100dvh - 168px);
  margin: 0 auto;
  padding: 22px 0 126px;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.voice-stage__provider-row { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
.voice-stage__provider-row > span {
  padding: 6px 10px;
  border: 1px solid rgba(166, 219, 255, 0.11);
  border-radius: 999px;
  color: rgba(187, 222, 241, 0.58);
  background: rgba(9, 19, 33, 0.52);
  font-size: 9px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.voice-stage__provider-row .voice-stage__preview { color: rgba(130, 245, 255, 0.78); border-color: rgba(112, 244, 255, 0.18); }
.voice-stage__dot { display: inline-block; width: 4px; height: 4px; margin-inline-end: 5px; border-radius: 50%; background: var(--voice-accent); box-shadow: 0 0 7px var(--voice-accent); }

.voice-stage__orb-wrap { position: relative; width: min(330px, 68vw); aspect-ratio: 1; margin-top: clamp(24px, 5vh, 58px); display: grid; place-items: center; }
.voice-stage__orbit { position: absolute; border-radius: 50%; border: 1px solid rgba(123, 235, 255, 0.13); }
.voice-stage__orbit--outer { inset: 0; border-style: dashed; animation: voice-orbit 34s linear infinite; }
.voice-stage__orbit--inner { inset: 15%; border-color: rgba(139, 116, 255, 0.18); animation: voice-orbit 24s linear infinite reverse; }

.voice-stage__orb {
  position: relative;
  width: 49%;
  aspect-ratio: 1;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background:
    radial-gradient(circle at 34% 28%, rgba(255,255,255,0.7), transparent 8%),
    radial-gradient(circle at 48% 45%, #6cf5ff 0%, #3968e8 44%, #2b1d73 72%, #080c18 100%);
  box-shadow:
    0 0 0 1px rgba(161, 247, 255, 0.34),
    0 0 42px rgba(67, 207, 255, 0.32),
    0 0 110px rgba(76, 87, 255, 0.25),
    inset -18px -22px 35px rgba(9, 7, 51, 0.42);
  transition: transform 0.3s ease, filter 0.3s ease;
}
.voice-stage__orb:hover { transform: scale(1.035); filter: brightness(1.08); }
.voice-stage__orb:focus-visible { outline: 2px solid #fff; outline-offset: 7px; }
.voice-stage__core { width: 42%; aspect-ratio: 1; display: grid; place-items: center; border-radius: 50%; color: #eaffff; background: rgba(3, 9, 29, 0.35); backdrop-filter: blur(8px); box-shadow: inset 0 0 20px rgba(255,255,255,0.08); }
.voice-stage__core svg { width: 52%; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.voice-stage--thinking .voice-stage__core svg { animation: voice-orbit 1.15s linear infinite; }

.voice-stage__orb-wrap.active .voice-stage__orb { animation: voice-breathe 2.1s ease-in-out infinite; }
.voice-stage--listening .voice-stage__orb { background: radial-gradient(circle at 34% 28%, #fff, transparent 7%), radial-gradient(circle at 48% 45%, #6affde 0%, #239acc 42%, #2c277f 72%, #080c18 100%); }
.voice-stage--error .voice-stage__orb { filter: saturate(0.35); }

/* Organic voice field */
.voice-stage__orb-wrap {
  width: min(410px, 82vw);
  margin-top: clamp(18px, 3.5vh, 38px);
  transition: transform 100ms linear;
}

.voice-stage__aura {
  position: absolute;
  inset: 11%;
  border-radius: 46% 54% 58% 42% / 52% 42% 58% 48%;
  pointer-events: none;
  mix-blend-mode: screen;
  filter: blur(2px);
}

.voice-stage__aura--one {
  inset: 7%;
  border: 1px solid rgba(100, 244, 255, 0.22);
  box-shadow: inset 0 0 34px rgba(87, 227, 255, 0.07), 0 0 35px rgba(70, 221, 255, 0.08);
  animation: voice-morph 7.5s ease-in-out infinite, voice-orbit 24s linear infinite;
}

.voice-stage__aura--two {
  inset: 15%;
  border: 1px solid rgba(142, 115, 255, 0.2);
  animation: voice-morph-alt 6.2s ease-in-out infinite, voice-orbit 18s linear infinite reverse;
}

.voice-stage__aura--three {
  inset: 23%;
  background: radial-gradient(circle, transparent 54%, rgba(102, 236, 255, 0.08) 68%, transparent 72%);
  filter: blur(10px);
  animation: voice-morph 5.4s ease-in-out infinite reverse;
}

.voice-stage__particles { position: absolute; inset: 50%; pointer-events: none; }
.voice-stage__particles i {
  position: absolute;
  width: 3px;
  height: 3px;
  margin: -1.5px;
  border-radius: 50%;
  background: #bafcff;
  box-shadow: 0 0 7px #64eaff;
  opacity: 0.18;
  transform: rotate(var(--particle-angle)) translateX(var(--particle-distance));
  animation: voice-particle 9s linear infinite;
}
.voice-stage__orb-wrap.active .voice-stage__particles i { opacity: 0.56; animation-duration: 5.4s; }

.voice-stage__orb {
  width: 58%;
  overflow: hidden;
  isolation: isolate;
  background: radial-gradient(circle at 52% 48%, rgba(15, 25, 59, 0.68), rgba(3, 7, 22, 0.96) 72%);
  box-shadow:
    0 0 0 1px rgba(168, 249, 255, 0.34),
    0 0 48px rgba(58, 218, 255, 0.25),
    0 0 130px rgba(86, 67, 255, 0.2),
    inset 0 0 48px rgba(67, 217, 255, 0.12);
}

.voice-stage__liquid {
  position: absolute;
  z-index: -1;
  width: 112%;
  height: 112%;
  left: -18%;
  top: 16%;
  border-radius: 38% 62% 55% 45% / 51% 44% 56% 49%;
  filter: blur(12px);
  opacity: 0.78;
  animation: voice-liquid 6s ease-in-out infinite;
}
.voice-stage__liquid--cyan { background: radial-gradient(circle at 40% 36%, #99ffff, #23d9ed 38%, transparent 71%); }
.voice-stage__liquid--violet { left: 20%; top: -24%; background: radial-gradient(circle at 45% 55%, #9c7dff, #4142d9 38%, transparent 70%); animation-duration: 7.4s; animation-direction: reverse; }
.voice-stage__liquid--white { width: 70%; height: 70%; left: 2%; top: -8%; opacity: 0.48; background: radial-gradient(circle, #f5ffff, transparent 68%); animation-duration: 4.8s; }

.voice-stage__membrane {
  position: absolute;
  inset: 5%;
  border-radius: inherit;
  border: 1px solid rgba(234, 255, 255, 0.19);
  background: radial-gradient(circle at 34% 24%, rgba(255,255,255,0.34), transparent 13%);
  box-shadow: inset -24px -28px 40px rgba(12, 7, 73, 0.28);
  animation: voice-morph-alt 5.6s ease-in-out infinite;
}
.voice-stage__core { position: relative; z-index: 2; width: 34%; background: rgba(2, 8, 25, 0.22); }

.voice-stage--idle .voice-stage__orb { animation: voice-float 4.5s ease-in-out infinite; }
.voice-stage--listening .voice-stage__orb {
  background: radial-gradient(circle at 52% 48%, rgba(8, 38, 50, 0.68), rgba(3, 8, 22, 0.96) 72%);
  box-shadow: 0 0 0 1px rgba(157,255,238,.42), 0 0 64px rgba(52,255,218,.34), 0 0 150px rgba(49,123,255,.24), inset 0 0 55px rgba(73,255,224,.14);
}
.voice-stage--thinking .voice-stage__liquid--cyan { background: radial-gradient(circle at 40% 36%, #8beeff, #4168f5 40%, transparent 72%); }
.voice-stage--thinking .voice-stage__liquid--violet { background: radial-gradient(circle at 45% 55%, #d071ff, #642dde 40%, transparent 72%); }
.voice-stage--speaking .voice-stage__aura--one,
.voice-stage--speaking .voice-stage__aura--two { animation-duration: 2.7s, 12s; }

.voice-stage__spectrum {
  position: absolute;
  left: 9%;
  right: 9%;
  bottom: 4%;
  height: 68px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  pointer-events: none;
  mask-image: linear-gradient(90deg, transparent, #000 13%, #000 87%, transparent);
}
.voice-stage__spectrum i {
  width: 2px;
  min-height: 4px;
  max-height: 62px;
  border-radius: 999px;
  background: linear-gradient(to top, rgba(105, 105, 255, 0.18), #8cfaff, rgba(255,255,255,0.88));
  transform: scaleY(0.28);
  transition: height 90ms linear, opacity 180ms ease;
}
.voice-stage__orb-wrap.active .voice-stage__spectrum i { animation: voice-spectrum 900ms ease-in-out infinite; }

.voice-stage__waves { position: absolute; inset: -3%; display: flex; align-items: center; justify-content: center; gap: 4px; pointer-events: none; transform: rotate(90deg); opacity: 0.55; mask-image: linear-gradient(90deg, transparent, black 18%, black 82%, transparent); }
.voice-stage__waves i { width: 2px; height: 7%; border-radius: 3px; background: linear-gradient(#80fbff, #746eff); transform: scaleY(0.45); }
.voice-stage__orb-wrap.active .voice-stage__waves i { animation-name: voice-wave; animation-duration: 1.1s; animation-timing-function: ease-in-out; animation-iteration-count: infinite; }

.voice-stage__status { margin-top: 14px; text-align: center; }
.voice-stage__status-line { display: flex; align-items: center; justify-content: center; gap: 9px; }
.voice-stage__status-line i { width: 5px; height: 5px; border-radius: 50%; background: var(--voice-accent); box-shadow: 0 0 10px var(--voice-accent); animation: voice-pulse 1.5s ease-in-out infinite; }
.voice-stage__status strong { font-size: 12px; font-weight: 650; letter-spacing: 0.18em; text-transform: uppercase; }
.voice-stage__status p { margin: 7px 0 0; color: rgba(187, 220, 239, 0.48); font-size: 12px; }
.voice-stage--error .voice-stage__status-line i { background: #ff698b; box-shadow: 0 0 10px #ff698b; }

.voice-stage__transcript { width: min(680px, 100%); min-height: 72px; margin-top: 24px; padding: 14px 18px; text-align: center; border-top: 1px solid rgba(142, 218, 255, 0.12); border-bottom: 1px solid rgba(142, 218, 255, 0.07); background: linear-gradient(90deg, transparent, rgba(91, 167, 255, 0.035), transparent); }
.voice-stage__transcript > span { color: rgba(152, 219, 244, 0.45); font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase; }
.voice-stage__transcript p { margin: 8px 0 0; color: rgba(237, 251, 255, 0.92); font-size: clamp(15px, 2vw, 18px); line-height: 1.55; }
.voice-stage__transcript .voice-stage__transcript-empty { color: rgba(191, 221, 236, 0.31); font-size: 13px; }

.voice-stage__history { width: min(760px, 100%); margin-top: 18px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.voice-stage__history article { min-width: 0; padding: 10px 12px; border: 1px solid rgba(155, 215, 255, 0.08); border-radius: 10px; background: rgba(6, 13, 24, 0.42); }
.voice-stage__history article > span { color: rgba(142, 219, 244, 0.46); font-size: 8px; letter-spacing: 0.16em; }
.voice-stage__history article p { margin: 5px 0 0; overflow: hidden; color: rgba(215, 235, 245, 0.67); font-size: 11px; line-height: 1.45; text-overflow: ellipsis; white-space: nowrap; }
.voice-stage__history .voice-stage__turn--assistant { border-color: rgba(124, 107, 255, 0.13); }

.voice-stage__primary-control { min-width: 132px; height: 54px; padding: 0 24px; border-radius: 15px; color: #06131c; background: linear-gradient(110deg, #74f5ff, #8ea7ff); box-shadow: 0 0 30px rgba(93, 218, 255, 0.18); font-size: 12px; font-weight: 700; letter-spacing: 0.04em; }
.voice-stage__primary-control:hover { filter: brightness(1.08); }

@keyframes voice-orbit { to { transform: rotate(360deg); } }
@keyframes voice-breathe { 50% { transform: scale(1.045); box-shadow: 0 0 0 1px rgba(161,247,255,.45), 0 0 58px rgba(67,207,255,.42), 0 0 135px rgba(76,87,255,.32), inset -18px -22px 35px rgba(9,7,51,.42); } }
@keyframes voice-wave { 0%, 100% { transform: scaleY(.35); opacity: .34; } 50% { transform: scaleY(1.45); opacity: .92; } }
@keyframes voice-pulse { 50% { opacity: .38; transform: scale(.72); } }
@keyframes voice-morph { 0%, 100% { border-radius: 46% 54% 58% 42% / 52% 42% 58% 48%; transform: scale(0.98); } 50% { border-radius: 58% 42% 44% 56% / 43% 58% 42% 57%; transform: scale(1.035); } }
@keyframes voice-morph-alt { 0%, 100% { border-radius: 58% 42% 48% 52% / 44% 55% 45% 56%; transform: rotate(-3deg); } 50% { border-radius: 42% 58% 61% 39% / 59% 42% 58% 41%; transform: rotate(5deg); } }
@keyframes voice-liquid { 0%, 100% { transform: translate3d(-3%, 4%, 0) rotate(-8deg) scale(1); border-radius: 38% 62% 55% 45% / 51% 44% 56% 49%; } 50% { transform: translate3d(8%, -6%, 0) rotate(12deg) scale(1.12); border-radius: 59% 41% 38% 62% / 43% 59% 41% 57%; } }
@keyframes voice-particle { from { transform: rotate(var(--particle-angle)) translateX(var(--particle-distance)) scale(.55); } 50% { opacity: .72; } to { transform: rotate(calc(var(--particle-angle) + 360deg)) translateX(var(--particle-distance)) scale(1.15); } }
@keyframes voice-spectrum { 0%, 100% { transform: scaleY(.25); } 50% { transform: scaleY(1); } }
@keyframes voice-float { 0%, 100% { transform: translateY(0) scale(1); } 50% { transform: translateY(-9px) scale(1.018); } }

@media (max-width: 640px) {
  .voice-stage__header { height: 68px; grid-template-columns: 40px minmax(0, 1fr) auto; padding-inline: 14px; }
  .voice-stage__connection span:last-child { display: none; }
  .voice-stage__main { min-height: calc(100dvh - 150px); padding-top: 16px; padding-bottom: 116px; }
  .voice-stage__provider-row > span:nth-child(2) { display: none; }
  .voice-stage__orb-wrap { margin-top: 22px; }
  .voice-stage__history { grid-template-columns: 1fr; }
  .voice-stage__history article:nth-child(-n + 2) { display: none; }
  .voice-stage__primary-control { flex: 1; min-width: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .voice-stage *, .voice-stage *::before, .voice-stage *::after { animation-duration: 1ms !important; animation-iteration-count: 1 !important; }
}

/* Minimal call surface inspired by current voice-first products. */
.voice-stage {
  --voice-ink: rgba(248, 249, 255, 0.94);
  min-height: 100dvh;
  color: var(--voice-ink);
  background: #0d0e13;
}

.voice-stage__wash {
  position: absolute;
  z-index: -1;
  width: 70vw;
  height: 70vw;
  max-width: 900px;
  max-height: 900px;
  border-radius: 50%;
  filter: blur(120px);
  pointer-events: none;
  opacity: 0.16;
}
.voice-stage__wash--top { top: -52vw; left: 50%; transform: translateX(-50%); background: #8b7dff; }
.voice-stage__wash--bottom { right: -40vw; bottom: -55vw; background: #4f91ff; opacity: 0.1; }

.voice-stage__header {
  height: auto;
  min-height: 76px;
  padding: max(18px, env(safe-area-inset-top, 0px)) clamp(18px, 4vw, 48px) 10px;
  grid-template-columns: 44px minmax(0, 1fr) 44px;
  border: 0;
  background: transparent;
  backdrop-filter: none;
}
.voice-stage__back {
  width: 42px;
  height: 42px;
  border-color: rgba(255, 255, 255, 0.09);
  border-radius: 999px;
  color: rgba(255, 255, 255, 0.78);
  background: rgba(255, 255, 255, 0.055);
}
.voice-stage__back:hover { color: #fff; border-color: rgba(255, 255, 255, 0.18); background: rgba(255, 255, 255, 0.09); }
.voice-stage__identity { align-items: center; gap: 3px; text-align: center; }
.voice-stage__identity strong { max-width: 52vw; font-size: 14px; font-weight: 580; }
.voice-stage__identity span { color: rgba(236, 238, 255, 0.42); font-size: 11px; }
.voice-stage__header-spacer { width: 42px; height: 42px; }

.voice-stage__main {
  width: min(860px, calc(100% - 32px));
  min-height: calc(100dvh - 76px);
  margin: 0 auto;
  padding: 0 0 150px;
  justify-content: center;
}

.voice-stage__bloom {
  appearance: none;
  width: min(470px, 84vw);
  aspect-ratio: 1;
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  cursor: pointer;
  transition: transform 100ms linear, filter 260ms ease;
  will-change: transform;
}
.voice-stage__bloom:focus-visible { outline: 2px solid rgba(255,255,255,.8); outline-offset: -42px; border-radius: 50%; }
.voice-stage__bloom svg { width: 100%; height: 100%; overflow: visible; animation: voice-cloud-float 6s ease-in-out infinite; }
.voice-stage__bloom-body { transform-origin: 210px 210px; animation: voice-cloud-breathe 4.8s ease-in-out infinite; }
.voice-stage__bloom-color { transform-origin: 210px 210px; animation: voice-cloud-color 7s ease-in-out infinite; mix-blend-mode: screen; }
.voice-stage__bloom-shine { transform-origin: 210px 210px; animation: voice-cloud-shine 5.5s ease-in-out infinite; }
.voice-stage__bloom-haze { opacity: 0.34; transform-origin: 210px 210px; animation: voice-cloud-haze 4.8s ease-in-out infinite; }

.voice-stage__stop { transition: stop-color 600ms ease; }
.voice-stage__stop--light { stop-color: #fbf8ff; }
.voice-stage__stop--cyan { stop-color: #a9d8ff; }
.voice-stage__stop--blue { stop-color: #6872db; }
.voice-stage__stop--rose { stop-color: #e8b6ff; }
.voice-stage__stop--violet { stop-color: #7253dc; }

.voice-stage--listening .voice-stage__stop--cyan { stop-color: #8eece6; }
.voice-stage--listening .voice-stage__stop--blue { stop-color: #438fdd; }
.voice-stage--listening .voice-stage__stop--rose { stop-color: #b8f4e9; }
.voice-stage--listening .voice-stage__stop--violet { stop-color: #6677e7; }
.voice-stage--listening .voice-stage__bloom-body { animation-duration: 2.7s; }
.voice-stage--listening .voice-stage__bloom-haze { opacity: 0.5; }

.voice-stage--thinking .voice-stage__stop--cyan { stop-color: #b1bfff; }
.voice-stage--thinking .voice-stage__stop--blue { stop-color: #6c4adf; }
.voice-stage--thinking .voice-stage__stop--rose { stop-color: #f0a9dc; }
.voice-stage--thinking .voice-stage__stop--violet { stop-color: #8f43c7; }
.voice-stage--thinking .voice-stage__bloom-body { animation: voice-cloud-think 5.6s linear infinite; }

.voice-stage--speaking .voice-stage__stop--cyan { stop-color: #93c7ff; }
.voice-stage--speaking .voice-stage__stop--blue { stop-color: #5264e6; }
.voice-stage--speaking .voice-stage__stop--rose { stop-color: #ffb5d8; }
.voice-stage--speaking .voice-stage__bloom-body { animation-duration: 1.35s; }
.voice-stage--speaking .voice-stage__bloom-haze { animation-duration: 1.35s; opacity: 0.56; }
.voice-stage--error .voice-stage__bloom { filter: saturate(0.25); }

.voice-stage__status {
  margin-top: -44px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: rgba(244, 246, 255, 0.62);
  text-align: center;
}
.voice-stage__status i { width: 6px; height: 6px; border-radius: 50%; background: #9ceee9; box-shadow: 0 0 12px rgba(126, 240, 232, 0.58); animation: voice-soft-pulse 1.8s ease-in-out infinite; }
.voice-stage__status span { font-size: 13px; font-weight: 500; }
.voice-stage--thinking .voice-stage__status i { background: #b598ff; box-shadow: 0 0 12px rgba(181, 152, 255, 0.55); }
.voice-stage--error .voice-stage__status i { background: #ff849c; box-shadow: 0 0 12px rgba(255, 94, 128, 0.5); }

.voice-stage__caption {
  width: min(720px, 92vw);
  min-height: 58px;
  margin: 16px 0 0;
  display: -webkit-box;
  overflow: hidden;
  color: rgba(247, 248, 255, 0.88);
  font-size: clamp(14px, 1.7vw, 18px);
  font-weight: 430;
  line-height: 1.55;
  text-align: center;
  text-wrap: pretty;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
}

@keyframes voice-cloud-float { 0%, 100% { transform: translateY(2px) rotate(-1deg); } 50% { transform: translateY(-9px) rotate(1.5deg); } }
@keyframes voice-cloud-breathe { 0%, 100% { transform: scale(.94) rotate(-2deg); } 50% { transform: scale(1.045) rotate(2deg); } }
@keyframes voice-cloud-color { 0%, 100% { transform: translate(-10px, 7px) scale(.96); opacity: .76; } 50% { transform: translate(10px, -8px) scale(1.08); opacity: .96; } }
@keyframes voice-cloud-shine { 0%, 100% { transform: translate(-5px, -2px) scale(.82); opacity: .14; } 50% { transform: translate(10px, 7px) scale(1.1); opacity: .28; } }
@keyframes voice-cloud-haze { 0%, 100% { transform: scale(.92); } 50% { transform: scale(1.16); } }
@keyframes voice-cloud-think { to { transform: rotate(360deg) scale(.98); } }
@keyframes voice-soft-pulse { 50% { opacity: .35; transform: scale(.72); } }

@media (max-width: 640px) {
  .voice-stage__header { min-height: 68px; padding-inline: 14px; grid-template-columns: 42px minmax(0, 1fr) 42px; }
  .voice-stage__identity strong { max-width: 58vw; }
  .voice-stage__main { min-height: calc(100dvh - 68px); padding-bottom: 136px; }
  .voice-stage__bloom { width: min(430px, 96vw); }
  .voice-stage__status { margin-top: -54px; }
  .voice-stage__caption { margin-top: 14px; font-size: 14px; }
}

/* Full-viewport dialog layout. */
.voice-stage {
  position: fixed;
  inset: 0;
  z-index: 5000;
  width: 100vw;
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
  overscroll-behavior: none;
  scrollbar-width: none;
}

.voice-stage::-webkit-scrollbar {
  display: none;
}

.voice-stage__header {
  position: relative;
  z-index: 3;
}

.voice-stage__main {
  box-sizing: border-box;
  width: min(900px, 100%);
  height: calc(100dvh - 76px);
  min-height: 0;
  padding: 8px clamp(18px, 3vw, 44px) 24px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.voice-stage__interaction {
  width: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.voice-stage__interaction .voice-stage__bloom {
  width: min(470px, 74vw);
}

.voice-stage--with-tools .voice-stage__interaction .voice-stage__bloom {
  width: min(390px, 48vh, 68vw);
}

.voice-stage__tools {
  width: min(620px, 88vw);
  max-height: 150px;
  margin-top: 14px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.voice-stage__tool {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  padding: 8px 12px;
  border: 1px solid rgba(255, 255, 255, 0.075);
  border-radius: 13px;
  color: rgba(239, 243, 255, 0.68);
  background: rgba(255, 255, 255, 0.045);
  backdrop-filter: blur(16px);
}

.voice-stage__tool-state {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: #9ceee9;
  background: rgba(125, 235, 226, 0.09);
}

.voice-stage__tool-state svg {
  width: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.voice-stage__tool-spinner {
  width: 10px;
  height: 10px;
  box-sizing: border-box;
  border: 1.5px solid rgba(156, 238, 233, 0.28);
  border-top-color: #9ceee9;
  border-radius: 50%;
  animation: voice-orbit 800ms linear infinite;
}

.voice-stage__tool-copy {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.voice-stage__tool-copy strong {
  flex: 0 0 auto;
  color: rgba(247, 249, 255, 0.88);
  font-size: 11px;
  font-weight: 620;
}

.voice-stage__tool-copy > span {
  min-width: 0;
  overflow: hidden;
  color: rgba(225, 230, 244, 0.42);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.voice-stage__tool time {
  color: rgba(225, 230, 244, 0.3);
  font-size: 9px;
}

.voice-stage__tool--error .voice-stage__tool-state {
  color: #ff849c;
  background: rgba(255, 105, 137, 0.1);
}

@media (max-width: 900px) {
  .voice-stage__main {
    height: calc(100dvh - 68px);
    padding: 0 12px 20px;
  }

  .voice-stage__interaction .voice-stage__bloom {
    width: min(390px, 86vw);
  }

  .voice-stage--with-tools .voice-stage__interaction .voice-stage__bloom {
    width: min(300px, 38vh, 72vw);
  }

  .voice-stage__interaction .voice-stage__status {
    margin-top: -62px;
  }

  .voice-stage__interaction .voice-stage__caption {
    min-height: 40px;
    margin-top: 10px;
    font-size: 13px;
    -webkit-line-clamp: 4;
  }

  .voice-stage__tools {
    width: min(560px, 92vw);
    max-height: 112px;
    margin-top: 8px;
  }
}
</style>
