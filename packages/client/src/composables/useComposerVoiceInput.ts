import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMicRecorder } from '@/composables/useMicRecorder'
import { usePcmStreamRecorder } from '@/composables/usePcmStreamRecorder'
import { useGlobalSpeech } from '@/composables/useSpeech'
import { useVoiceDialogue } from '@/composables/useVoiceDialogue'
import { useSttSettings } from '@/composables/useSttSettings'
import { useBrowserSpeechRecognition } from '@/composables/useBrowserSpeechRecognition'
import {
  cancelLocalSttStream,
  finishLocalSttStream,
  pushLocalSttStreamChunk,
  startLocalSttStream,
  transcribeSpeech,
} from '@/api/studio/stt'
import { fetchSttSettings, type StoredSttProvider } from '@/api/studio/stt-settings'
import { isDesktopShell } from '@/utils/desktop-bridge'
import { isMobileDevice } from '@/utils/device'

export function normalizeComposerVoiceTranscript(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

export function useComposerVoiceInput(options: {
  insertTranscript: (text: string) => void | Promise<void>
}) {
  const { t } = useI18n()
  const speech = useGlobalSpeech()
  const micRecorder = useMicRecorder({
    messages: {
      unsupported: t('chat.voiceInput.microphoneUnsupported'),
      recordingFailed: t('chat.voiceInput.microphoneRecordingFailed'),
    },
  })
  const pcmRecorder = usePcmStreamRecorder({
    voiceActivityThreshold: 0.02,
    messages: {
      unsupported: t('chat.voiceInput.microphoneUnsupported'),
      recordingFailed: t('chat.voiceInput.microphoneRecordingFailed'),
    },
  })
  const localPcmRecorder = usePcmStreamRecorder({
    continuous: true,
    maxSegmentDurationMs: 1_000,
    onChunk: queueLocalStreamChunk,
    messages: {
      unsupported: t('chat.voiceInput.microphoneUnsupported'),
      recordingFailed: t('chat.voiceInput.microphoneRecordingFailed'),
    },
  })
  const sttSettings = useSttSettings()
  const browserRecognition = useBrowserSpeechRecognition({
    messages: {
      unsupported: t('chat.voiceInput.browserSpeechUnsupported'),
      failed: t('chat.voiceInput.browserSpeechFailed'),
      failedWithReason: reason => t('chat.voiceInput.browserSpeechFailedWithReason', { error: reason }),
    },
  })
  const activeCaptureMode = ref<'browser' | 'backend' | 'pcm' | 'local' | null>(null)
  const captureStartError = ref<Error | null>(null)
  const localStreamTranscript = ref('')
  const localStreamError = ref<Error | null>(null)
  let localStreamSessionId: string | null = null
  let localStreamGeneration = 0
  let localStreamQueue: Promise<void> = Promise.resolve()
  let localStreamFailure: unknown = null

  function backendTranscribeOptions(): {
    provider: StoredSttProvider
    language?: string
    prompt?: string
  } {
    if (isDesktopShell() && sttSettings.provider.value === 'browser') {
      throw new Error(t('chat.voiceInput.backendSttRequired'))
    }
    if (sttSettings.provider.value === 'custom') {
      return {
        provider: 'custom',
        language: sttSettings.customLanguage.value.trim() || undefined,
        prompt: sttSettings.customPrompt.value.trim() || undefined,
      }
    }
    if (sttSettings.provider.value === 'doubao') return { provider: 'doubao' }
    if (sttSettings.provider.value !== 'browser') return { provider: sttSettings.provider.value }
    return {
      provider: 'openai',
      language: sttSettings.openaiLanguage.value.trim() || undefined,
      prompt: sttSettings.openaiPrompt.value.trim() || undefined,
    }
  }

  function browserCaptureLanguage() {
    return sttSettings.openaiLanguage.value.trim() || sttSettings.customLanguage.value.trim() || ''
  }

  const dialogue = useVoiceDialogue({
    transcribe: async (audio) => transcribeSpeech({ audio, ...backendTranscribeOptions() }),
    sendMessage: options.insertTranscript,
    stopOutputAudio: () => speech.stop(true),
  })

  const transcript = computed(() => {
    if (activeCaptureMode.value === 'local' && dialogue.status.value === 'capturing') {
      return localStreamTranscript.value
    }
    if (activeCaptureMode.value !== 'browser' || dialogue.status.value !== 'capturing') {
      return dialogue.transcript.value
    }
    return normalizeComposerVoiceTranscript([
      browserRecognition.transcript.value,
      browserRecognition.partialTranscript.value,
    ].filter(Boolean).join(' '))
  })

  const error = computed(() =>
    dialogue.error.value?.message
    ?? captureStartError.value?.message
    ?? localStreamError.value?.message
    ?? ((sttSettings.provider.value === 'browser' || activeCaptureMode.value === 'browser')
      ? browserRecognition.error.value?.message
      : null)
    ?? localPcmRecorder.error.value?.message
    ?? pcmRecorder.error.value?.message
    ?? micRecorder.state.value.error?.message
    ?? null,
  )

  function resetLocalStreamCapture() {
    localStreamGeneration += 1
    localStreamQueue = Promise.resolve()
    localStreamFailure = null
    localStreamTranscript.value = ''
    localStreamError.value = null
  }

  async function cancelActiveLocalStreamCapture() {
    const sessionId = localStreamSessionId
    localStreamSessionId = null
    if (sessionId) await cancelLocalSttStream(sessionId).catch(() => undefined)
  }

  function failLocalStreamCapture(cause: unknown, generation: number) {
    if (generation !== localStreamGeneration) return
    localStreamFailure = cause
    localStreamError.value = cause instanceof Error ? cause : new Error(String(cause))
    localPcmRecorder.cancel()
    activeCaptureMode.value = null
    const captureId = dialogue.activeCaptureId.value
    localStreamGeneration += 1
    void cancelActiveLocalStreamCapture()
    dialogue.cancelCapture(captureId)
  }

  function queueLocalStreamChunk(audio: Blob) {
    const generation = localStreamGeneration
    const sessionId = localStreamSessionId
    if (!sessionId || audio.size <= 44) return localStreamQueue
    localStreamQueue = localStreamQueue.then(async () => {
      if (generation !== localStreamGeneration) return
      const result = await pushLocalSttStreamChunk(sessionId, audio)
      if (generation !== localStreamGeneration) return
      localStreamTranscript.value = normalizeComposerVoiceTranscript(result.text)
    }).catch(cause => failLocalStreamCapture(cause, generation))
    return localStreamQueue
  }

  async function start() {
    browserRecognition.clearError()
    captureStartError.value = null
    localStreamError.value = null
    const { captureId } = await dialogue.beginCapture()
    try {
      if (isDesktopShell()) {
        const settings = await fetchSttSettings()
        if (dialogue.activeCaptureId.value !== captureId) return
        const provider = settings.activeProvider
        if (
          !provider || provider === 'browser'
          || (provider !== 'local' && !settings.providers.find(row => row.provider === provider)?.secrets.apiKey)
        ) {
          throw new Error(t('chat.voiceInput.backendSttRequired'))
        }
        sttSettings.applyServerSttSettings(settings, true)
      }
      const useBrowserProvider = sttSettings.provider.value === 'browser'
      const useLocalProvider = sttSettings.provider.value === 'local'
      const usePcmCapture = !useBrowserProvider && !useLocalProvider && (isDesktopShell() || isMobileDevice())
      activeCaptureMode.value = useBrowserProvider
        ? 'browser'
        : useLocalProvider ? 'local' : usePcmCapture ? 'pcm' : 'backend'
      if (useBrowserProvider) {
        await browserRecognition.start({ language: browserCaptureLanguage() })
        return
      }
      if (useLocalProvider) {
        resetLocalStreamCapture()
        const generation = localStreamGeneration
        const session = await startLocalSttStream()
        if (
          generation !== localStreamGeneration
          || activeCaptureMode.value !== 'local'
          || dialogue.activeCaptureId.value !== captureId
        ) {
          await cancelLocalSttStream(session.sessionId).catch(() => undefined)
          return
        }
        localStreamSessionId = session.sessionId
        await localPcmRecorder.start()
        return
      }
      if (usePcmCapture) await pcmRecorder.start()
      else await micRecorder.start()
    } catch (cause) {
      if (dialogue.activeCaptureId.value !== captureId) return
      captureStartError.value = cause instanceof Error ? cause : new Error(String(cause))
      if (activeCaptureMode.value === 'local') {
        localStreamError.value = cause instanceof Error ? cause : new Error(String(cause))
        localStreamGeneration += 1
        localPcmRecorder.cancel()
        await cancelActiveLocalStreamCapture()
      }
      activeCaptureMode.value = null
      dialogue.cancelCapture(captureId)
    }
  }

  async function stop() {
    const captureId = dialogue.activeCaptureId.value
    if (!captureId) return
    if (!activeCaptureMode.value) {
      dialogue.cancelCapture(captureId)
      return
    }
    if (activeCaptureMode.value === 'browser') {
      let text: string
      try {
        text = await browserRecognition.stop()
      } catch {
        text = browserRecognition.transcript.value
      }
      if (dialogue.activeCaptureId.value !== captureId || activeCaptureMode.value !== 'browser') return
      activeCaptureMode.value = null
      try {
        await dialogue.commitTranscript(captureId, text)
      } catch {
        // useVoiceDialogue owns the visible error state.
      }
      return
    }
    if (activeCaptureMode.value === 'local') {
      const generation = localStreamGeneration
      const sessionId = localStreamSessionId
      if (!sessionId || localPcmRecorder.status.value === 'requesting') {
        localStreamGeneration += 1
        localPcmRecorder.cancel()
        activeCaptureMode.value = null
        await cancelActiveLocalStreamCapture()
        dialogue.cancelCapture(captureId)
        return
      }
      try {
        const finalChunk = await localPcmRecorder.stop()
        if (finalChunk) queueLocalStreamChunk(finalChunk)
        await localStreamQueue
        if (generation !== localStreamGeneration) return
        if (localStreamFailure) throw localStreamFailure
        localStreamSessionId = null
        const result = await finishLocalSttStream(sessionId)
        if (generation !== localStreamGeneration) return
        localStreamTranscript.value = normalizeComposerVoiceTranscript(result.text) || localStreamTranscript.value
        activeCaptureMode.value = null
        await dialogue.commitTranscript(captureId, localStreamTranscript.value)
        localStreamTranscript.value = ''
      } catch (cause) {
        if (generation !== localStreamGeneration) return
        localStreamError.value = cause instanceof Error ? cause : new Error(String(cause))
        localStreamGeneration += 1
        localPcmRecorder.cancel()
        activeCaptureMode.value = null
        await cancelActiveLocalStreamCapture()
        dialogue.cancelCapture(captureId)
      }
      return
    }
    const usePcmCapture = activeCaptureMode.value === 'pcm'
    const captureStatus = usePcmCapture ? pcmRecorder.status.value : micRecorder.state.value.status
    if (captureStatus === 'requesting') {
      if (usePcmCapture) pcmRecorder.cancel()
      else micRecorder.cancel()
      activeCaptureMode.value = null
      dialogue.cancelCapture(captureId)
      return
    }
    let audio: Blob | null
    try {
      audio = usePcmCapture ? await pcmRecorder.stop() : await micRecorder.stop()
    } catch {
      activeCaptureMode.value = null
      dialogue.cancelCapture(captureId)
      return
    }
    activeCaptureMode.value = null
    if (!audio || audio.size <= 0) {
      dialogue.cancelCapture(captureId)
      return
    }
    try {
      await dialogue.transcribeAndSend(captureId, audio)
    } catch {
      // useVoiceDialogue owns the visible error state.
    }
  }

  watch(browserRecognition.error, cause => {
    if (cause && activeCaptureMode.value === 'browser' && dialogue.status.value === 'capturing') {
      void stop()
    }
  })

  function cancel() {
    if (activeCaptureMode.value === 'browser') browserRecognition.cancel()
    else if (activeCaptureMode.value === 'local') {
      localStreamGeneration += 1
      localPcmRecorder.cancel()
      void cancelActiveLocalStreamCapture()
      localStreamTranscript.value = ''
      localStreamError.value = null
    } else if (activeCaptureMode.value === 'pcm') pcmRecorder.cancel()
    else micRecorder.cancel()
    activeCaptureMode.value = null
    dialogue.cancelCapture()
  }

  onUnmounted(() => cancel())

  return {
    dialogue,
    transcript,
    error,
    activeCaptureMode,
    start,
    stop,
    cancel,
  }
}
