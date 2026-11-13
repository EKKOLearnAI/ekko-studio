import { ref, computed, onUnmounted } from 'vue'
import { parseThinking } from '@/utils/thinking-parser'
import {
  generateSpeech,
  playAudioBlob,
  synthesizeSpeech,
  type TtsProviderId,
} from '@/api/studio/tts'

export interface SpeechOptions {
  lang?: string      // 语言 'zh-CN', 'en-US' 等
  voiceName?: string // 指定 WebSpeech 音色名称
}

export interface OpenaiTtsOptions {
  baseUrl?: string
  apiKey?: string
  model?: string
  voice?: string
  rate?: string   // Edge TTS rate format, e.g. "+20%"
  pitch?: string  // Edge TTS pitch format, e.g. "-8Hz"
  speed?: string | number
  stylePrompt?: string
  provider?: Exclude<TtsProviderId, 'mimo'>
}

export interface MimoTtsOptions {
  baseUrl: string
  apiKey?: string
  authMode?: 'api-key' | 'bearer' | 'both'
  model: string
  voice?: string              // preset voice ID (preset mode)
  voiceMode?: 'preset' | 'voiceDesign' | 'voiceClone'
  voiceDesignDesc?: string    // voice design description text (voice design mode)
  voiceCloneDataUri?: string  // reference audio data URI (voice clone mode)
  voiceCloneFormat?: 'mp3' | 'wav'
  stylePrompt?: string        // natural language style instruction
}

export interface SpeechState {
  isPlaying: boolean
  isPaused: boolean
  currentMessageId: string | null
  progress: number  // 当前进度（字符数）
  engine: 'none' | 'tts' | 'browser'  // 当前使用的引擎
}

interface SpeechQueueItem {
  messageId: string
  content: string
  options: SpeechOptions
}

type PreparedProfileSpeech =
  | { ok: true; audio: Blob }
  | { ok: false; error: unknown }

interface ProfileSpeechQueueItem {
  messageId: string
  content: string
  profile: string
  generation: number
  synthesis: Promise<PreparedProfileSpeech>
}

interface ProfileSpeechSynthesisJob {
  text: string
  profile: string
  generation: number
  resolve: (result: PreparedProfileSpeech) => void
}

const MAX_CONCURRENT_PROFILE_TTS_SYNTHESIS = 5

/**
 * 语音播放 Composable
 * 优先后端 TTS（Edge → Google），失败降级浏览器 speechSynthesis
 */
export function useSpeech() {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined
  const availableVoices = ref<SpeechSynthesisVoice[]>([])
  const state = ref<SpeechState>({
    isPlaying: false,
    isPaused: false,
    currentMessageId: null,
    progress: 0,
    engine: 'none',
  })

  let utterance: SpeechSynthesisUtterance | null = null
  let currentAudio: HTMLAudioElement | null = null
  let playbackToken = 0
  const speechQueue: SpeechQueueItem[] = []
  const profileSpeechQueue: ProfileSpeechQueueItem[] = []
  const queuedProfileMessageIds = new Set<string>()
  const profileSynthesisControllers = new Set<AbortController>()
  const profileSynthesisJobs: ProfileSpeechSynthesisJob[] = []
  const activeProfileSynthesisProfiles = new Set<string>()
  let activeProfileSynthesisCount = 0
  let profilePlaybackGeneration = 0
  let profileQueueRunning = false
  let finishActiveProfileAudio: (() => void) | null = null

  // 自定义 TTS（OpenAI / Custom / Edge）播放状态
  const isCustomPlaying = ref(false)
  const isCustomPaused = ref(false)
  const currentCustomMessageId = ref<string | null>(null)

  // 加载可用语音列表
  function loadVoices() {
    try {
      availableVoices.value = typeof synth?.getVoices === 'function' ? synth.getVoices() : []
    } catch {
      availableVoices.value = []
    }
  }

  if (typeof synth?.addEventListener === 'function') {
    synth.addEventListener('voiceschanged', loadVoices)
  }
  loadVoices()

  /**
   * 从文本中提取纯文本内容，过滤代码块、thinking 标签等
   */
  function extractReadableText(content: string): string {
    if (!content) return ''

    let text = parseThinking(content, { streaming: false }).body

    // 移除代码块
    text = text.replace(/```[\s\S]*?```/g, '')
    text = text.replace(/`[^`]+`/g, '')

    // 移除 HTML 标签
    text = text.replace(/<[^>]+>/g, '')

    text = text.replace(/[^\p{L}\p{N}\s.。!?;,，。！？；：、""''（）【】《》+\-%:\/=~\n一-鿿㐀-䶿]/gu, '')

    text = text.replace(/\s+/g, ' ').trim()

    return text
  }

  const isSupported = computed(() => {
    return Boolean(
      typeof window !== 'undefined' &&
      window.speechSynthesis &&
      typeof window.speechSynthesis.speak === 'function' &&
      typeof window.SpeechSynthesisUtterance === 'function',
    )
  })

  function getDefaultVoice(): SpeechSynthesisVoice | null {
    const voices = availableVoices.value
    if (voices.length === 0) return null

    const zhVoice = voices.find(v => v.lang.startsWith('zh'))
    if (zhVoice) return zhVoice

    const enVoice = voices.find(v => v.lang.startsWith('en'))
    if (enVoice) return enVoice

    return voices[0]
  }

  function stop(clearQueue = true) {
    playbackToken += 1
    if (clearQueue) {
      profilePlaybackGeneration += 1
      abortProfileSpeechSynthesis()
      speechQueue.length = 0
      profileSpeechQueue.length = 0
      queuedProfileMessageIds.clear()
    }
    cancelActiveProfileAudio()
    // Stop TTS audio
    if (currentAudio) {
      currentAudio.pause()
      currentAudio.src = ''
      currentAudio = null
    }
    currentTtsAbort?.abort()
    currentTtsAbort = null
    stopCustomAudioPlayback()
    clearCustomPlaybackState()
    // Stop browser speech
    if (synth && (synth.speaking || synth.pending || synth.paused) && typeof synth.cancel === 'function') {
      synth.cancel()
    }
    utterance = null
    state.value = {
      isPlaying: false,
      isPaused: false,
      currentMessageId: null,
      progress: 0,
      engine: 'none',
    }
    if (!clearQueue) {
      scheduleNextProfileSpeech()
    }
  }

  // ─── TTS Engine (server-side) ───────────────────────────────

  async function speakViaTts(messageId: string, text: string, options: SpeechOptions, token: number) {
    // Set playing state immediately so UI shows breathing animation right away
    state.value.isPlaying = true
    state.value.isPaused = false
    state.value.currentMessageId = messageId
    state.value.progress = 0
    state.value.engine = 'tts'

    try {
      const lang = options.lang || 'zh-CN'

      const { audio } = await generateSpeech({ text, lang })

      if (token !== playbackToken) return

      currentAudio = playAudioBlob(audio)

      currentAudio.onended = () => {
        if (token !== playbackToken) return
        state.value.isPlaying = false
        state.value.isPaused = false
        state.value.currentMessageId = null
        state.value.progress = text.length
        state.value.engine = 'none'
        currentAudio = null
        if (speechQueue.length > 0) {
          setTimeout(playNextQueuedSpeech, 0)
        }
        scheduleNextProfileSpeech()
      }

      currentAudio.onerror = () => {
        if (token !== playbackToken) return
        // TTS playback failed, fallback to browser
        console.warn('[useSpeech] TTS audio playback error, falling back to browser')
        speakViaBrowser(messageId, text, options, token)
      }
    } catch (err) {
      if (token !== playbackToken) return
      console.warn('[useSpeech] TTS API failed, falling back to browser:', err)
      speakViaBrowser(messageId, text, options, token)
    }
  }

  // ─── Browser Engine (Web Speech API) ────────────────────────

  function speakViaBrowser(messageId: string, text: string, options: SpeechOptions, token?: number) {
    token = token || ++playbackToken
    if (!isSupported.value || !synth) {
      state.value = {
        isPlaying: false,
        isPaused: false,
        currentMessageId: null,
        progress: 0,
        engine: 'none',
      }
      scheduleNextProfileSpeech()
      return
    }
    utterance = new window.SpeechSynthesisUtterance(text)
    const activeUtterance = utterance

    utterance.rate = 1
    utterance.pitch = 1
    utterance.volume = 1

    // 使用指定的音色（如果有），否则用默认
    if (options.voiceName) {
      const voice = availableVoices.value.find(v => v.name === options.voiceName)
      if (voice) {
        utterance.voice = voice
      }
    }
    if (!utterance.voice) {
      utterance.voice = getDefaultVoice()
    }

    if (options.lang) {
      utterance.lang = options.lang
    } else if (utterance.voice) {
      utterance.lang = utterance.voice.lang
    }

    state.value.engine = 'browser'
    state.value.isPlaying = true
    state.value.isPaused = false
    state.value.currentMessageId = messageId
    state.value.progress = 0

    utterance.onboundary = (event) => {
      if (token !== playbackToken || utterance !== activeUtterance) return
      if (event.name === 'word') {
        state.value.progress = event.charIndex
      }
    }

    utterance.onend = () => {
      if (token !== playbackToken || utterance !== activeUtterance) return
      state.value.isPlaying = false
      state.value.isPaused = false
      state.value.currentMessageId = null
      state.value.progress = text.length
      state.value.engine = 'none'
      utterance = null
      if (speechQueue.length > 0) {
        setTimeout(playNextQueuedSpeech, 0)
      }
      scheduleNextProfileSpeech()
    }

    utterance.onerror = () => {
      if (token !== playbackToken || utterance !== activeUtterance) return
      state.value.isPlaying = false
      state.value.isPaused = false
      state.value.currentMessageId = null
      state.value.engine = 'none'
      utterance = null
      if (speechQueue.length > 0) {
        setTimeout(playNextQueuedSpeech, 0)
      }
      scheduleNextProfileSpeech()
    }

    synth.speak(utterance)
  }

  // ─── OpenAI-compatible / unified custom TTS Engine ───────────

  type OpenaiCompatibleProviderId = Exclude<TtsProviderId, 'mimo'>

  let customAudio: HTMLAudioElement | null = null
  let customAudioUrl: string | null = null
  let currentTtsAbort: AbortController | null = null

  function isAbortError(err: unknown): boolean {
    return err instanceof Error && err.name === 'AbortError'
  }

  function clearCustomPlaybackState() {
    isCustomPlaying.value = false
    isCustomPaused.value = false
    currentCustomMessageId.value = null
  }

  function revokeCustomAudioUrl() {
    if (!customAudioUrl) return
    URL.revokeObjectURL(customAudioUrl)
    customAudioUrl = null
  }

  function stopCustomAudioPlayback() {
    if (customAudio) {
      customAudio.pause()
      customAudio.src = ''
      customAudio = null
    }
    revokeCustomAudioUrl()
  }

  function resolveOpenaiProvider(opts: OpenaiTtsOptions): OpenaiCompatibleProviderId {
    if (opts.provider) {
      return opts.provider
    }
    if (opts.baseUrl?.startsWith('/api/tts/proxy')) {
      return 'edge'
    }
    if (opts.model) {
      return 'openai'
    }
    return 'custom'
  }

  function attachCustomAudioHandlers(
    audio: HTMLAudioElement,
    token: number,
    errorMessage: string,
    onSettled?: () => void,
  ) {
    audio.onended = () => {
      if (token !== playbackToken) {
        onSettled?.()
        return
      }
      stopCustomAudioPlayback()
      clearCustomPlaybackState()
      onSettled?.()
      if (speechQueue.length > 0) {
        setTimeout(playNextQueuedSpeech, 0)
      }
      scheduleNextProfileSpeech()
    }

    audio.onerror = () => {
      if (token !== playbackToken) {
        onSettled?.()
        return
      }
      stopCustomAudioPlayback()
      console.warn(errorMessage)
      clearCustomPlaybackState()
      onSettled?.()
      if (speechQueue.length > 0) {
        setTimeout(playNextQueuedSpeech, 0)
      }
      scheduleNextProfileSpeech()
    }
  }

  async function playUnifiedCustomTts(
    messageId: string,
    text: string,
    provider: TtsProviderId | undefined,
    options: Record<string, unknown>,
    token: number,
    playbackErrorMessage: string,
    profile?: string,
    onSettled?: () => void,
  ) {
    currentTtsAbort?.abort()
    cancelActiveProfileAudio()
    stopCustomAudioPlayback()

    isCustomPlaying.value = true
    isCustomPaused.value = false
    currentCustomMessageId.value = messageId

    const abortController = new AbortController()
    currentTtsAbort = abortController

    try {
      const { audio } = await synthesizeSpeech({
        provider,
        profile,
        text,
        options,
        signal: abortController.signal,
      })

      if (token !== playbackToken) {
        onSettled?.()
        return
      }

      customAudioUrl = URL.createObjectURL(audio)
      const nextAudio = new Audio(customAudioUrl)
      customAudio = nextAudio
      attachCustomAudioHandlers(nextAudio, token, playbackErrorMessage, onSettled)
      await nextAudio.play()
    } catch (err) {
      if (token !== playbackToken) {
        onSettled?.()
        return
      }
      stopCustomAudioPlayback()
      clearCustomPlaybackState()
      onSettled?.()
      if (speechQueue.length > 0) {
        setTimeout(playNextQueuedSpeech, 0)
      }
      scheduleNextProfileSpeech()
      if (isAbortError(err)) {
        return
      }
      throw err
    } finally {
      if (currentTtsAbort === abortController) {
        currentTtsAbort = null
      }
    }
  }

  function hasActivePlayback() {
    return state.value.isPlaying ||
      state.value.isPaused ||
      isCustomPlaying.value ||
      isCustomPaused.value
  }

  function cancelActiveProfileAudio() {
    const finish = finishActiveProfileAudio
    finishActiveProfileAudio = null
    finish?.()
  }

  function abortProfileSpeechSynthesis() {
    for (const controller of profileSynthesisControllers) controller.abort()
    profileSynthesisControllers.clear()
    const error = new DOMException('Profile speech synthesis cancelled', 'AbortError')
    while (profileSynthesisJobs.length > 0) {
      profileSynthesisJobs.shift()?.resolve({ ok: false, error })
    }
  }

  function pumpProfileSpeechSynthesis() {
    while (
      activeProfileSynthesisCount < MAX_CONCURRENT_PROFILE_TTS_SYNTHESIS &&
      profileSynthesisJobs.length > 0
    ) {
      const jobIndex = profileSynthesisJobs.findIndex(job =>
        job.generation !== profilePlaybackGeneration ||
        !activeProfileSynthesisProfiles.has(job.profile)
      )
      if (jobIndex < 0) break
      const [job] = profileSynthesisJobs.splice(jobIndex, 1)
      if (!job) break
      if (job.generation !== profilePlaybackGeneration) {
        job.resolve({
          ok: false,
          error: new DOMException('Stale Profile speech synthesis', 'AbortError'),
        })
        continue
      }

      const controller = new AbortController()
      activeProfileSynthesisCount += 1
      activeProfileSynthesisProfiles.add(job.profile)
      profileSynthesisControllers.add(controller)
      void synthesizeSpeech({
        profile: job.profile,
        text: job.text,
        signal: controller.signal,
      })
        .then(({ audio }) => job.resolve({ ok: true, audio }))
        .catch(error => job.resolve({ ok: false, error }))
        .finally(() => {
          activeProfileSynthesisCount -= 1
          activeProfileSynthesisProfiles.delete(job.profile)
          profileSynthesisControllers.delete(controller)
          pumpProfileSpeechSynthesis()
        })
    }
  }

  function prepareProfileSpeech(
    text: string,
    profile: string,
    generation: number,
  ): Promise<PreparedProfileSpeech> {
    return new Promise((resolve) => {
      profileSynthesisJobs.push({ text, profile, generation, resolve })
      pumpProfileSpeechSynthesis()
    })
  }

  function playPreparedProfileSpeech(item: ProfileSpeechQueueItem, audioBlob: Blob) {
    const token = ++playbackToken
    const url = URL.createObjectURL(audioBlob)
    const audio = new Audio(url)
    customAudio = audio
    customAudioUrl = url
    isCustomPlaying.value = true
    isCustomPaused.value = false
    currentCustomMessageId.value = item.messageId

    return new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: unknown) => {
        if (settled) return
        settled = true
        audio.onended = null
        audio.onerror = null
        if (customAudio === audio) customAudio = null
        if (customAudioUrl === url) customAudioUrl = null
        if (finishActiveProfileAudio === cancel) finishActiveProfileAudio = null
        URL.revokeObjectURL(url)
        if (
          token === playbackToken &&
          currentCustomMessageId.value === item.messageId
        ) {
          clearCustomPlaybackState()
        }
        if (error) reject(error)
        else resolve()
      }
      const cancel = () => {
        audio.pause()
        audio.src = ''
        finish()
      }
      finishActiveProfileAudio = cancel
      audio.onended = () => finish()
      audio.onerror = () => finish(new Error('Profile TTS audio playback failed'))
      void audio.play().catch(finish)
    })
  }

  function scheduleNextProfileSpeech() {
    setTimeout(() => {
      void drainProfileSpeechQueue()
    }, 0)
  }

  async function drainProfileSpeechQueue() {
    if (profileQueueRunning || hasActivePlayback()) return
    profileQueueRunning = true
    try {
      while (profileSpeechQueue.length > 0) {
        const next = profileSpeechQueue.shift()
        if (!next) continue
        const prepared = await next.synthesis
        if (next.generation !== profilePlaybackGeneration) {
          queuedProfileMessageIds.delete(next.messageId)
          continue
        }
        if (hasActivePlayback()) {
          profileSpeechQueue.unshift(next)
          return
        }
        if (!prepared.ok) {
          queuedProfileMessageIds.delete(next.messageId)
          if (!isAbortError(prepared.error)) {
            console.warn('[useSpeech] Profile TTS autoplay failed:', prepared.error)
          }
          continue
        }

        try {
          await playPreparedProfileSpeech(next, prepared.audio)
        } catch (error) {
          console.warn('[useSpeech] Profile TTS autoplay failed:', error)
        } finally {
          queuedProfileMessageIds.delete(next.messageId)
        }
      }
    } finally {
      profileQueueRunning = false
      if (profileSpeechQueue.length > 0) scheduleNextProfileSpeech()
    }
  }

  function enqueueProfileSpeech(messageId: string, content: string, profile: string) {
    const normalizedProfile = profile.trim()
    const text = extractReadableText(content)
    if (!normalizedProfile || !text) return
    if (
      queuedProfileMessageIds.has(messageId) ||
      currentCustomMessageId.value === messageId
    ) {
      return
    }

    const generation = profilePlaybackGeneration
    const item = {
      messageId,
      content,
      profile: normalizedProfile,
      generation,
      synthesis: prepareProfileSpeech(text, normalizedProfile, generation),
    }
    queuedProfileMessageIds.add(messageId)
    profileSpeechQueue.push(item)
    void drainProfileSpeechQueue()
  }

  async function profilePlay(
    messageId: string,
    content: string,
    profile: string,
  ) {
    const text = extractReadableText(content)
    const normalizedProfile = profile.trim()
    if (!text || !normalizedProfile) return

    const token = ++playbackToken
    await playUnifiedCustomTts(
      messageId,
      text,
      undefined,
      {},
      token,
      '[useSpeech] Profile TTS audio playback error',
      normalizedProfile,
    )
  }

  function profileToggle(messageId: string, content: string, profile: string) {
    if (currentCustomMessageId.value === messageId && isCustomPlaying.value) {
      if (isCustomPaused.value) {
        resumeCustomAudio()
      } else {
        pauseCustomAudio()
      }
    } else {
      stop(false)
      startCustomPlayback(profilePlay(messageId, content, profile))
    }
  }

  async function openaiPlay(
    messageId: string,
    content: string,
    opts: OpenaiTtsOptions,
  ) {
    const text = extractReadableText(content)
    if (!text) return

    const token = ++playbackToken
    const provider = resolveOpenaiProvider(opts)
    const { provider: _provider, ...providerOptions } = opts

    await playUnifiedCustomTts(
      messageId,
      text,
      provider,
      providerOptions as unknown as Record<string, unknown>,
      token,
      '[useSpeech] Custom TTS audio playback error',
    )
  }

  function resumeCustomAudio() {
    if (!customAudio) {
      clearCustomPlaybackState()
      return
    }

    customAudio.play()
      .then(() => {
        isCustomPaused.value = false
      })
      .catch((err) => {
        console.warn('[useSpeech] Custom TTS audio resume failed:', err)
        isCustomPaused.value = true
      })
  }

  function pauseCustomAudio() {
    if (!isCustomPlaying.value || isCustomPaused.value) return false
    if (!customAudio) {
      // Synthesis is still pending; pausing should interrupt instead of letting
      // audio start later while the UI already shows a paused state.
      stop(false)
      return true
    }
    customAudio.pause()
    isCustomPaused.value = true
    return true
  }

  function startCustomPlayback(promise: Promise<void>) {
    void promise.catch(() => {
      // openaiPlay/mimoPlay already clear state; inline card UI handles failures.
      // Toggle callers are fire-and-forget UI actions; do not leak unhandled rejections.
    })
  }

  function openaiToggle(messageId: string, content: string, opts: OpenaiTtsOptions) {
    if (currentCustomMessageId.value === messageId && isCustomPlaying.value) {
      if (isCustomPaused.value) {
        resumeCustomAudio()
      } else {
        pauseCustomAudio()
      }
    } else {
      stop(false)
      startCustomPlayback(openaiPlay(messageId, content, opts))
    }
  }

  // ─── MiMo TTS Engine ──────────────────────────────────────────

  async function mimoPlay(
    messageId: string,
    content: string,
    opts: MimoTtsOptions,
  ) {
    const text = extractReadableText(content)
    if (!text) return

    const token = ++playbackToken

    await playUnifiedCustomTts(
      messageId,
      text,
      'mimo',
      opts as unknown as Record<string, unknown>,
      token,
      '[useSpeech] MiMo TTS audio playback error',
    )
  }

  function mimoToggle(messageId: string, content: string, opts: MimoTtsOptions) {
    if (currentCustomMessageId.value === messageId && isCustomPlaying.value) {
      if (isCustomPaused.value) {
        resumeCustomAudio()
      } else {
        pauseCustomAudio()
      }
    } else {
      stop(false)
      startCustomPlayback(mimoPlay(messageId, content, opts))
    }
  }

  // ─── Unified speak ──────────────────────────────────────────

  function speak(messageId: string, text: string, options: SpeechOptions = {}) {
    const token = ++playbackToken

    // Try server-side TTS first, fallback to browser
    speakViaTts(messageId, text, options, token)
  }

  function playNextQueuedSpeech() {
    if (hasActivePlayback()) return
    const next = speechQueue.shift()
    if (!next) return

    const text = extractReadableText(next.content)
    if (!text) {
      setTimeout(playNextQueuedSpeech, 0)
      return
    }

    speak(next.messageId, text, next.options)
  }

  function play(messageId: string, content: string, options: SpeechOptions = {}) {
    // If playing other message, stop first
    if (state.value.currentMessageId && state.value.currentMessageId !== messageId) {
      stop()
    }

    // Toggle play/pause for same message
    if (state.value.currentMessageId === messageId) {
      if (state.value.isPaused) {
        resume()
      } else if (state.value.isPlaying) {
        pause()
      }
      return
    }

    const text = extractReadableText(content)
    if (!text) return

    stop()
    speak(messageId, text, options)
  }

  function toggleBrowser(messageId: string, content: string, options: SpeechOptions = {}) {
    if (state.value.currentMessageId && state.value.currentMessageId !== messageId) {
      stop(false)
    }

    if (state.value.currentMessageId === messageId) {
      if (state.value.isPaused) {
        resume()
      } else if (state.value.isPlaying) {
        pause()
      }
      return
    }

    const text = extractReadableText(content)
    if (!text) return

    stop(false)
    speakViaBrowser(messageId, text, options)
  }

  function enqueue(messageId: string, content: string, options: SpeechOptions = {}) {
    if (!extractReadableText(content)) return
    speechQueue.push({ messageId, content, options })
    playNextQueuedSpeech()
  }

  function pause() {
    if (pauseCustomAudio()) return
    if (state.value.engine === 'tts' && currentAudio) {
      currentAudio.pause()
      state.value.isPaused = true
    } else if (state.value.engine === 'browser' && !state.value.isPaused && typeof synth?.pause === 'function') {
      synth.pause()
      state.value.isPaused = true
    }
  }

  function resume() {
    if (isCustomPlaying.value && isCustomPaused.value) {
      resumeCustomAudio()
      return
    }
    if (state.value.isPaused) {
      if (state.value.engine === 'tts' && currentAudio) {
        currentAudio.play()
      } else if (typeof synth?.resume === 'function') {
        synth.resume()
      }
      state.value.isPaused = false
    }
  }

  function toggle(messageId: string, content: string, options: SpeechOptions = {}) {
    if (state.value.currentMessageId === messageId && state.value.isPlaying) {
      if (state.value.isPaused) {
        resume()
      } else {
        pause()
      }
    } else {
      play(messageId, content, options)
    }
  }

  onUnmounted(() => {
    stop()
    if (typeof synth?.removeEventListener === 'function') {
      synth.removeEventListener('voiceschanged', loadVoices)
    }
  })

  return {
    isSupported,
    availableVoices,
    isPlaying: computed(() => state.value.isPlaying),
    isPaused: computed(() => state.value.isPaused),
    currentMessageId: computed(() => state.value.currentMessageId),
    progress: computed(() => state.value.progress),
    engine: computed(() => state.value.engine),

    // Custom TTS state
    isCustomPlaying,
    isCustomPaused,
    currentCustomMessageId,

    play,
    pause,
    resume,
    stop,
    toggle,
    toggleBrowser,
    enqueue,
    enqueueProfileSpeech,
    getDefaultVoice,
    extractReadableText,

    // OpenAI-compatible TTS
    openaiPlay,
    openaiToggle,

    // MiMo TTS
    mimoPlay,
    mimoToggle,

    // Profile-aware TTS
    profilePlay,
    profileToggle,

    // Browser WebSpeech (直接调用避免 Rolldown 树摇)
    speakViaBrowser,
  }
}

let globalSpeech: ReturnType<typeof useSpeech> | null = null

export function useGlobalSpeech() {
  if (!globalSpeech) {
    globalSpeech = useSpeech()
  }
  return globalSpeech
}
