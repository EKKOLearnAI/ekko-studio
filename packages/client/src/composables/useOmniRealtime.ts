/**
 * Omni-Realtime client composable.
 *
 * Wraps the `/ws/omni-realtime` WebSocket exposed by the meeting backend
 * (which itself proxies DashScope's `qwen3.8-omni-flash-realtime` model
 * via the `OmniRealtimeConversation` SDK) and handles:
 *
 *   - Audio capture: microphone → Float32 → resample to 24 kHz → Int16 PCM →
 *     binary WebSocket frames.
 *   - Audio playback: binary WebSocket frames (raw PCM16 @ 24 kHz) → scheduled
 *     into a Web Audio buffer that plays through the default output device.
 *   - Conversation transcript rendering via server-emitted JSON events.
 *
 * The DashScope audio format on the wire is fixed at 24 kHz / 16-bit / mono —
 * matching `omni_realtime_proxy.SAMPLE_RATE`. We resample on both ends so
 * that the user-facing AudioContext can run at whatever rate the browser
 * picked (typically 44.1 / 48 kHz).
 */

import { ref, shallowRef, computed, onUnmounted, watch } from 'vue'
import { meetingWebSocketUrl } from '@/utils/meeting-websocket'
import {
  MAX_MALFORMED_CALL_STREAK,
  missingRequiredArgs,
  normalizeToolArguments,
  parseToolArgsJson,
} from '@/utils/omni-tool-call-guard'

export type OmniRealtimePhase =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'listening'   // server VAD says user is speaking
  | 'speaking'    // AI is streaming audio back
  | 'error'
  | 'closed'

export interface OmniDialogTurn {
  /** 'user' for mic input, 'assistant' for AI responses. */
  role: 'user' | 'assistant'
  /** Final transcript text (post-ASR for user, post-LLM for assistant). */
  text: string
  /** Streaming build-up of the current turn (cleared on commit). */
  partial: string
  /** Epoch ms of when this turn started. */
  timestamp: number
}

/**
 * One committed user turn's raw mic audio (16 kHz mono PCM16 — the same
 * samples streamed upstream), surfaced via `onUserTurnAudio` so consumers
 * (e.g. 口语对练报告) can keep per-turn recordings for offline multimodal
 * analysis without duplicating the capture graph.
 */
export interface OmniUserTurnAudio {
  /** Raw PCM16 mono samples at 16 kHz (see INPUT_SAMPLE_RATE). */
  pcm16: Int16Array
  /** Transcript of the committed user turn this segment belongs to. */
  text: string
  /** 1-based index of the user turn in the session transcript. */
  index: number
}

/**
 * One completed function-calling invocation by the realtime model. The UI
 * surfaces these on the right-side tool-call panel and the parent stage
 * persists them to the chat session so the history survives a page reload.
 */
export interface OmniDialogToolCall {
  /** DashScope call id, used to dedupe across server events. */
  callId: string
  name: string
  argsJson: string
  /** Final textual output sent back to the model (already clipped). */
  output: string
  /** Execution status from the model's perspective. */
  status: 'running' | 'done' | 'error'
  /** Epoch ms when the call started; duration is computed on completion. */
  startedAt: number
  finishedAt?: number
}

export interface UseOmniRealtimeOptions {
  /** Push-to-talk release handler — UI fires this to commit audio & request reply. */
  onTurnCommitted?: (text: string) => void
  onError?: (message: string) => void
  /**
   * Hands-free mode: mic audio streams continuously (server VAD owns turn
   * detection) instead of waiting for push-to-talk gating.
   */
  handsFree?: boolean
  /**
   * Auto barge-in: when the server VAD hears the user while the assistant is
   * still talking, stop local playback and cancel the in-flight response.
   */
  autoBargeIn?: boolean
  /**
   * Function-calling tools (OpenAI-Realtime flat format) sent with the start
   * frame; the proxy writes them into session.update.
   */
  tools?: Array<Record<string, unknown> | { type: 'function'; name: string; description: string; parameters: unknown }>
  /**
   * Client-side executor for model-initiated function calls. The returned
   * string is sent back upstream as the tool output.
   */
  onToolCall?: (name: string, argsJson: string) => Promise<string> | string
  /**
   * Optional per-user-turn mic-audio hook. Fired once per committed user
   * turn (when `user_transcript` lands) with the raw 16 kHz PCM16 samples
   * that were streamed upstream while the server VAD held the turn open.
   * Consumers own the buffer lifetime.
   */
  onUserTurnAudio?: (segment: OmniUserTurnAudio) => void
}

/**
 * Same wire constants as `omni_realtime_proxy.py`. Hard-coded rather than
 * fetched at runtime so the client doesn't need an extra handshake round-trip.
 *
 * Per the Qwen-Omni-Realtime docs the input sample_rate defaults to 16 kHz
 * and the output defaults to 24 kHz. Both must match the `audio.input.format`
 * / `audio.output.format` sent in `session.update` upstream, otherwise the
 * upstream decodes the input audio at the wrong rate (Qwen3.8 will refuse
 * mismatched audio with `input_audio_format_mismatch`).
 */
const INPUT_SAMPLE_RATE = 16_000
const OUTPUT_SAMPLE_RATE = 24_000

/**
 * Local barge-in: the upstream server VAD takes 100–300 ms to emit
 * `listening`, during which the AI audio keeps playing and the user
 * perceives the interrupt as broken. To make the response feel real-time we
 * additionally trigger `maybeBargeIn` directly off the local mic input
 * peak — once it crosses this threshold we stop AI audio immediately and
 * send the upstream cancel in parallel.
 *
 * AEC is enabled in `getUserMedia`, so the residual echo from the AI's own
 * playback sits well below this value during normal speaker volume; normal
 * speech comfortably exceeds it. Raise this number if you see echo-driven
 * self-interrupt loops on a particular platform; lower it if the user has
 * to speak loudly before the AI yields.
 */
const LOCAL_BARGE_IN_THRESHOLD = 0.12
/**
 * Sustained-voice floor on the exponentially-smoothed RMS (see the analyser
 * tick). Lowering the peak threshold above makes barge-in feel faster, but a
 * peak alone also fires on single transients (a click, one loud echo frame).
 * Speech sustains energy across frames, so requiring the smoothed RMS to
 * stay above this floor filters transients while keeping real speech
 * responsive. Raise it if echo still sneaks through on loud speaker setups.
 */
const LOCAL_BARGE_IN_RMS_FLOOR = 0.035
/**
 * Debounce window after a local barge-in so a single loud echo frame
 * doesn't trigger a second interrupt while the AI is still tearing down.
 */
const LOCAL_BARGE_IN_DEBOUNCE_MS = 800

/**
 * Local barge-in is stricter while the assistant's own audio is actually
 * coming out of the speakers. On platforms where AEC is weak or unavailable
 * (some Linux browser/audio stacks) the residual echo of the AI voice can
 * otherwise cross the mic threshold for a few frames and self-interrupt
 * playback mid-sentence — the "一段语音没播完就停了" symptom. While output is
 * playing we require a longer sustained-voice streak and a higher peak.
 */
const LOCAL_BARGE_IN_PEAK_DURING_OUTPUT = 0.16
const LOCAL_BARGE_IN_STREAK_DURING_OUTPUT = 6

/**
 * After the client returns a function-call result (`tool_result`), DashScope
 * immediately starts a follow-up response (the model's continuation of the
 * same turn). If that `response_started` arrives while the previous response's
 * audio is still draining through the speakers we must NOT cut it — the model
 * frequently splits one spoken sentence around a tool call (e.g. 口语对练:
 * 先说一句点评，再调用 submit_practice_feedback，然后继续提问), and cutting
 * the tail makes the user hear a half-finished sentence. Responses inside
 * this window after our own tool_result are treated as continuations and are
 * allowed to queue behind the still-playing audio (`nextPlayTime` chaining).
 */
const TOOL_CONTINUATION_WINDOW_MS = 2000

/**
 * Resample a Float32 buffer from `sourceSampleRate` to `targetSampleRate`
 * using linear interpolation. Quality is adequate for speech-to-text
 * purposes; the upstream model itself does the heavy lifting on features.
 */
function resampleLinear(input: Float32Array, sourceSampleRate: number, targetSampleRate: number): Float32Array {
  if (sourceSampleRate === targetSampleRate) return input
  const ratio = sourceSampleRate / targetSampleRate
  const outLength = Math.max(1, Math.round(input.length / ratio))
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i += 1) {
    const srcIdx = i * ratio
    const lo = Math.floor(srcIdx)
    const hi = Math.min(input.length - 1, lo + 1)
    const frac = srcIdx - lo
    out[i] = (input[lo] ?? 0) * (1 - frac) + (input[hi] ?? 0) * frac
  }
  return out
}

function float32ToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0))
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
  }
  return out
}

function int16ToFloat32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i += 1) {
    out[i] = (pcm[i] ?? 0) / (pcm[i]! < 0 ? 0x8000 : 0x7fff)
  }
  return out
}

export function useOmniRealtime(options: UseOmniRealtimeOptions = {}) {
  const phase = ref<OmniRealtimePhase>('idle')
  const errorMessage = ref('')
  /** Sorted transcript of completed turns (user + assistant). */
  const turns = ref<OmniDialogTurn[]>([])
  /** Per-role live build-up, cleared whenever the upstream emits a *done* event. */
  const liveUserText = ref('')
  const liveAssistantText = ref('')
  /** Name of the function call currently being executed (empty otherwise). */
  const activeTool = ref('')
  /** History of every function-calling invocation in this session, in order. */
  const toolCalls = ref<OmniDialogToolCall[]>([])

  const isReady = computed(() => phase.value === 'ready' || phase.value === 'listening' || phase.value === 'speaking')
  const isPushing = shallowRef(false)

  // --- internals ---------------------------------------------------------

  let ws: WebSocket | null = null
  /** 当前会话的工具集：默认取初始化 options.tools；连接前可按技能用 setTools 覆盖。 */
  let sessionTools: NonNullable<UseOmniRealtimeOptions['tools']> = options.tools ?? []
  let audioContext: AudioContext | null = null
  let micStream: MediaStream | null = null
  let micSource: MediaStreamAudioSourceNode | null = null
  let workletNode: AudioWorkletNode | null = null
  let analyser: AnalyserNode | null = null
  let inputLevelRaf: number | null = null
  const inputLevel = ref(0)
  /** Timestamp of the last locally-triggered barge-in (used for debounce). */
  let lastLocalBargeInAt = 0
  /** When the last tool_result was sent upstream (tool-turn audio diagnostics). */
  let lastToolResultAt = 0
  /**
   * Per-session malformed-call loop breaker (see utils/omni-tool-call-guard):
   * when the SAME tool keeps arriving with the SAME missing-required-argument
   * payload (the `query_hermes_agent {} → question 必填 → 重试` storm), we stop
   * executing after `MAX_MALFORMED_CALL_STREAK` consecutive identical
   * occurrences and return an explicit "stop retrying" directive instead —
   * every cycle otherwise starts a fresh response whose audio chops the
   * previous one, which the user hears as "发声一直在被打断".
   */
  let malformedCallSig = ''
  let malformedCallStreak = 0
  /** Consecutive frames the mic peak has stayed above the barge-in threshold. */
  let bargeInStreak = 0
  /**
   * Exponentially-smoothed RMS of the mic input (EMA, alpha 0.3). Speech
   * sustains energy across frames while transients don't, so the smoothed
   * value gates the barge-in streak against single-frame false triggers.
   */
  let rmsSmoothed = 0
  /**
   * True while the user has the mic explicitly muted (hands-free 闭麦). A mute
   * is stronger than just clearing `isPushing`: it also disables the mic source
   * tracks (see `applyMicMuteState`), so the capture graph emits silence — the
   * input level reads 0 and no voice activity can drive a local barge-in or be
   * streamed upstream while the user is muted.
   */
  let micMuted = false

  // --- 同会话文本提问（口语对练收尾总评等：复用本 WS 的已看/已听上下文）---
  interface TextAskRequest {
    resolve: (text: string) => void
    reject: (err: Error) => void
    collected: string
    timer: number
  }
  let activeTextAsk: TextAskRequest | null = null

  // --- per-user-turn mic capture (optional recording for offline analysis) ---
  /** True while the server VAD holds the user's turn open (audio belongs to it). */
  let capturingUserAudio = false
  /** Raw 16 kHz PCM16 chunks accumulated since the turn opened. */
  let userAudioChunks: Int16Array[] = []
  /** Count of committed user turns (1-based index handed to the hook). */
  let userTurnCount = 0

  // --- playback queue ----------------------------------------------------
  // AI audio arrives as a stream of binary PCM16 frames; we keep appending
  // to the AudioBuffer of the next "slot" and when the current slot finishes
  // we move to the next. This avoids per-chunk glitches (no decodeAudioData
  // round-trip) at the cost of a single fixed latency (~chunk size).

  let playbackCtx: AudioContext | null = null
  let masterGain: GainNode | null = null
  /**
   * Parallel analyser tap on the playback graph (masterGain → analyser, no
   * connection to destination) so the UI visualizer can render the AI's
   * actual output energy. Zero impact on the audio path.
   *
   * Exposed as a shallowRef so the OmniVisualizer can attach() to the
   * same node and read raw frequency data for the perimeter waveform
   * (32 bands around a circle). Vue doesn't need to deep-track an
   * AnalyserNode — shallowRef is enough.
   */
  const outputAnalyser = shallowRef<AnalyserNode | null>(null)
  let outputLevelBuf: Uint8Array<ArrayBuffer> | null = null
  let outputLevelRaf: number | null = null
  /** Smoothed AI playback level (0-1), sampled from the analyser tap. */
  const outputLevel = ref(0)
  let pendingSamples: Float32Array | null = null
  let pendingLength = 0
  /** All scheduled-but-not-yet-ended playback sources; cleared on barge-in. */
  const scheduledSources = new Set<AudioBufferSourceNode>()
  /**
   * Reactive count of sources that have been scheduled but not yet finished
   * playing. Exposed as `isOutputPlaying` so the UI can tell the difference
   * between "phase flipped back to ready" (upstream done sending audio) and
   * "all queued audio has actually finished playing through the speakers".
   */
  const playingSourceCount = ref(0)
  const isOutputPlaying = computed(() => playingSourceCount.value > 0)
  let nextPlayTime = 0
  /**
   * True between sending `{type:"cancel"}` upstream and the upstream
   * confirming the response is finished (`response.done` /
   * `response.cancelled`). During that window any binary audio frame that
   * arrives belongs to the *cancelled* response — if we let it through,
   * `flushPendingToSlot()` schedules a fresh `AudioBufferSourceNode` and
   * the user hears the tail of the old audio overlap with the new reply.
   * We drop those frames here and resume normal playback on the
   * confirmation event.
   */
  let droppingAssistantAudio = false

  /**
   * Once the last queued audio source finishes playing through the
   * speakers, the assistant's subtitle text is no longer useful — clear it
   * so the caption falls through to the next state. Without this watch,
   * `commitAssistantTurn` clears `liveAssistantText` on the upstream
   * `transcript` event, which fires well before the audio actually drains,
   * so the user sees the subtitles vanish mid-playback.
   */
  watch(isOutputPlaying, (playing) => {
    if (!playing) {
      liveAssistantText.value = ''
    }
  })

  /**
   * Lazily build a playback AudioContext and resume it. We do this inside the
   * user gesture that opened the session so the first binary frame can play
   * without a `NotAllowedError` from the browser autoplay policy. Returns
   * `null` when Web Audio is unavailable (e.g. SSR / unsupported browser) —
   * callers must then drop the audio silently.
   */
  async function ensurePlaybackContext(): Promise<AudioContext | null> {
    if (playbackCtx) return playbackCtx
    const Ctor = window.AudioContext
      || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    playbackCtx = new Ctor()
    // All assistant sources route through this gain node rather than
    // straight to `destination`, so barge-in can mute the playback graph
    // instantly with a single `gain.value = 0` — far more reliable than
    // calling `src.stop()` on every queued source and waiting for the
    // audio destination to drain its render-quantum buffer.
    masterGain = playbackCtx.createGain()
    masterGain.gain.value = 1
    masterGain.connect(playbackCtx.destination)
    // Analyser tap for the visualizer: parallel branch off masterGain (not in
    // series), so the audible routing above is untouched. Exposed via the
    // shallow ref so OmniVisualizer can read frequency data for the
    // perimeter waveform without owning the AnalyserNode itself.
    const analyserNode = playbackCtx.createAnalyser()
    analyserNode.fftSize = 256
    outputAnalyser.value = analyserNode
    outputLevelBuf = new Uint8Array(new ArrayBuffer(analyserNode.fftSize))
    masterGain.connect(analyserNode)
    startOutputLevelLoop()
    if (playbackCtx.state === 'suspended') {
      try { await playbackCtx.resume() } catch { /* ignore — will be surfaced on play() */ }
    }
    return playbackCtx
  }

  /**
   * Sample the playback analyser each frame into `outputLevel` (RMS with
   * headroom scaling so normal TTS loudness reads ~0.3-0.8 on the visual).
   * Runs while the playback context exists; a silent graph simply reads 0.
   */
  function startOutputLevelLoop(): void {
    if (outputLevelRaf !== null) return
    const tick = (): void => {
      const analyserNode = outputAnalyser.value
      if (!analyserNode || !playbackCtx || !outputLevelBuf) {
        outputLevelRaf = null
        return
      }
      analyserNode.getByteTimeDomainData(outputLevelBuf)
      let sumSquares = 0
      for (let i = 0; i < outputLevelBuf.length; i += 1) {
        const v = ((outputLevelBuf[i] ?? 128) - 128) / 128
        sumSquares += v * v
      }
      // EMA（起音 0.35 / 收音 0.1）：TTS 逐音节的 RMS 起伏直接透传会让
      // 可视化逐帧抽搐，消费端拿到的是平滑后的呼吸电平。
      const raw = Math.min(1, Math.sqrt(sumSquares / outputLevelBuf.length) * 2.5)
      outputLevel.value += (raw - outputLevel.value) * (raw > outputLevel.value ? 0.35 : 0.1)
      outputLevelRaf = requestAnimationFrame(tick)
    }
    outputLevelRaf = requestAnimationFrame(tick)
  }

  function stopOutputLevelLoop(): void {
    if (outputLevelRaf !== null) {
      cancelAnimationFrame(outputLevelRaf)
      outputLevelRaf = null
    }
    outputLevel.value = 0
  }

  function flushPendingToSlot(): void {
    if (!playbackCtx) return
    if (!pendingSamples || pendingLength === 0) return
    const buf = playbackCtx.createBuffer(1, pendingLength, OUTPUT_SAMPLE_RATE)
    // slice() (not subarray()) so the copied view is ArrayBuffer-backed —
    // copyToChannel requires Float32Array<ArrayBuffer> on TS 5.7+ typed arrays.
    buf.copyToChannel(pendingSamples.slice(0, pendingLength), 0, 0)
    const src = playbackCtx.createBufferSource()
    src.buffer = buf
    src.connect(masterGain ?? playbackCtx.destination)
    // Restore master gain to 1 in case a previous barge-in muted it.
    if (masterGain) {
      masterGain.gain.cancelScheduledValues(playbackCtx.currentTime)
      masterGain.gain.setValueAtTime(1, playbackCtx.currentTime)
    }
    const t = Math.max(playbackCtx.currentTime, nextPlayTime)
    src.start(t)
    nextPlayTime = t + buf.duration
    scheduledSources.add(src)
    playingSourceCount.value += 1
    src.onended = () => {
      if (scheduledSources.delete(src)) {
        playingSourceCount.value = Math.max(0, playingSourceCount.value - 1)
      }
    }
    pendingSamples = null
    pendingLength = 0
  }

  function appendPcmChunk(pcm16: Int16Array): void {
    const samples = int16ToFloat32(pcm16)
    if (!pendingSamples || pendingSamples.length < pendingLength + samples.length) {
      const grown = new Float32Array(Math.max(pendingLength + samples.length, pendingSamples?.length ?? 0, pendingLength + samples.length))
      if (pendingSamples) grown.set(pendingSamples.subarray(0, pendingLength))
      pendingSamples = grown
    }
    pendingSamples.set(samples, pendingLength)
    pendingLength += samples.length
  }

  function stopPlayback(): void {
    // Mute the entire playback graph first — this is the only way to get
    // an audible "instant silence" the moment the user barges in. Just
    // calling `src.stop()` on each scheduled source leaves the speaker
    // output buffer draining for one render quantum (~3 ms at 48 kHz) which
    // compounds to ~50–100 ms of perceptible old-audio tail across a
    // long-ish reply. Setting `masterGain.gain.value = 0` cuts the signal
    // path immediately; `flushPendingToSlot` resets it back to 1 on the
    // next turn's first chunk.
    if (masterGain && playbackCtx) {
      masterGain.gain.cancelScheduledValues(playbackCtx.currentTime)
      masterGain.gain.setValueAtTime(0, playbackCtx.currentTime)
    }
    for (const src of scheduledSources) {
      try { src.stop() } catch { /* already stopped */ }
    }
    scheduledSources.clear()
    // Reset the count immediately; the `onended` handlers from `src.stop()`
    // will fire and find an empty set (the `delete` returns false), so they
    // won't double-decrement.
    playingSourceCount.value = 0
    pendingSamples = null
    pendingLength = 0
    nextPlayTime = 0
  }

  // --- transcript handling ----------------------------------------------

  /**
   * Barge-in: the user started speaking while the assistant was still
   * talking. Drop queued/playing assistant audio and cancel the upstream
   * response so the model can listen and re-answer.
   */
  function maybeBargeIn(): void {
    if (!options.autoBargeIn) return
    // A muted mic must never interrupt the assistant. `setMicStreaming(false)`
    // silences the capture graph, but this guard also covers stray analyser
    // frames already in the buffer and server VAD events for audio buffered
    // just before the mute — the user is still listening to the reply and did
    // not intend to take the turn.
    if (!isPushing.value) return
    // `phase` flips back to 'ready' the moment upstream emits `response_done`,
    // which is well before the last queued buffer finishes playing through
    // the speakers. Gating on `phase === 'speaking'` alone therefore misses
    // the user speaking during that tail-drain window — the most common
    // interrupt moment — and the AI keeps talking over them. Barge-in must
    // also fire whenever audio is *actually* playing (`isOutputPlaying`).
    if (!isOutputPlaying.value && phase.value !== 'speaking') return
    stopPlayback()
    // A cancelled response never emits a final `transcript` event, so drop
    // the partial build-up instead of leaving it dangling.
    liveAssistantText.value = ''
    // During the tail-drain window the upstream response has already fully
    // drained — there is nothing left to cancel, and `response.cancel` with
    // no active response can surface an upstream error. Silence the local
    // playback graph only; the user's turn will create a fresh response.
    if (phase.value !== 'speaking') return
    droppingAssistantAudio = true
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'cancel' })) } catch { /* ignore */ }
    }
  }

  function commitUserTurn(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    userTurnCount += 1
    // A fresh user utterance resets the malformed-call loop breaker: whatever
    // the model retried belongs to the previous intent, not this one.
    malformedCallSig = ''
    malformedCallStreak = 0
    // Hand the captured mic samples to the consumer (report recording) with
    // the transcript it belongs to; buffer lifecycle belongs to the consumer.
    flushUserAudioSegment(trimmed)
    turns.value.push({ role: 'user', text: trimmed, partial: '', timestamp: Date.now() })
    liveUserText.value = ''
    options.onTurnCommitted?.(trimmed)
  }

  /**
   * Deliver the mic samples captured since the VAD opened this user's turn
   * (see `capturingUserAudio`) to `options.onUserTurnAudio`. Called when the
   * committed transcript arrives — the audio itself ended at `speech_stopped`,
   * so the small lag only affects association with the text, not fidelity.
   */
  function flushUserAudioSegment(text: string): void {
    if (!options.onUserTurnAudio) {
      userAudioChunks = []
      capturingUserAudio = false
      return
    }
    if (userAudioChunks.length === 0) {
      capturingUserAudio = false
      return
    }
    let total = 0
    for (const chunk of userAudioChunks) total += chunk.length
    const merged = new Int16Array(total)
    let offset = 0
    for (const chunk of userAudioChunks) {
      merged.set(chunk, offset)
      offset += chunk.length
    }
    userAudioChunks = []
    capturingUserAudio = false
    try {
      options.onUserTurnAudio({ pcm16: merged, text, index: userTurnCount })
    } catch {
      // A throwing consumer must never break the voice session.
    }
  }

  function commitAssistantTurn(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    turns.value.push({ role: 'assistant', text: trimmed, partial: '', timestamp: Date.now() })
    // Note: `liveAssistantText` is intentionally NOT cleared here — the
    // final transcript arrives BEFORE the audio drains, and we want the
    // caption to keep showing the subtitles until playback actually ends.
    // The `watch(isOutputPlaying, ...)` above clears it once the last
    // scheduled source finishes playing through the speakers.
  }

  /** Execute a model-initiated function call locally and return the output upstream. */
  async function handleFunctionCall(msg: { [k: string]: unknown }): Promise<void> {
    const callId = String(msg.call_id ?? '')
    const name = String(msg.name ?? '')
    if (!callId || !name) return
    // DashScope 的 Omni-Realtime 兼容层偶尔把 arguments 以对象而非 JSON 字符串
    // 下发（见 utils/omni-tool-call-guard 说明）。对象必须重新字符串化，否则
    // 这里会退化成 '{}' —— 模型明明给了 question，客户端却当成空参调用执行，
    // 报「question 必填」后模型重试同一调用 → query_hermes_agent {} 风暴。
    const argsJson = normalizeToolArguments(msg.arguments)
    const startedAt = Date.now()
    const parsedArgs = parseToolArgsJson(argsJson)
    const missing = parsedArgs ? missingRequiredArgs(sessionTools, name, parsedArgs) : []
    const malformed = missing.length > 0
    if (malformed) {
      // 记录“同一签名”的坏参数调用次数；换了参数或换了工具即重置。
      const sig = `${name}|${argsJson}`
      malformedCallStreak = malformedCallSig === sig ? malformedCallStreak + 1 : 1
      malformedCallSig = sig
    } else {
      // 参数齐全的调用是健康路径，清掉此前的坏调用计数（新意图）。
      malformedCallSig = ''
      malformedCallStreak = 0
    }

    let output: string
    let status: OmniDialogToolCall['status'] = 'done'
    let executed = false
    if (!options.onToolCall) {
      output = JSON.stringify({ error: '该会话未配置工具执行器' })
      status = 'error'
    } else if (malformed && malformedCallStreak >= MAX_MALFORMED_CALL_STREAK) {
      // 同一坏参数连续 ≥N 次：判定无效重试循环。不再执行（执行只会返回同样的
      // 错误并继续刺激模型重试），回一个明确的停止指令，让模型改为口头向用户
      // 说明 / 确认，或带着完整参数重新提问。
      output = JSON.stringify({
        error: `工具「${name}」连续 ${malformedCallStreak} 次收到缺少必填参数`
          + `（${missing.join('、')}）的调用，判定为无效重试循环，已停止执行。`
          + '请不要再调用本工具，直接口语回应：要么向用户说明无法执行，'
          + '要么先向用户确认要执行的具体内容，再一次性给出完整参数提问。',
      })
      status = 'error'
    } else {
      executed = true
      activeTool.value = name
      toolCalls.value = [...toolCalls.value, {
        callId, name, argsJson, output: '', status: 'running', startedAt,
      }]
      try {
        output = await options.onToolCall(name, argsJson)
      } catch (cause) {
        output = JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) })
        status = 'error'
      } finally {
        activeTool.value = ''
      }
    }

    const finishedAt = Date.now()
    // Dedupe by callId: DashScope occasionally emits the same call twice
    // (once via conversation.item.created, once via
    // response.function_call_arguments.done — see translate_event in the
    // Python proxy). Replace the matching running row in-place so the UI
    // shows a single completed card per call.
    toolCalls.value = toolCalls.value.map(entry =>
      entry.callId === callId
        ? { ...entry, output, status, finishedAt }
        : entry,
    )
    // A loop-breaking (non-executed) reply still needs a row so the UI shows
    // what happened; executed rows already pushed one above.
    if (!executed) {
      toolCalls.value = [...toolCalls.value, {
        callId, name, argsJson, output, status, startedAt, finishedAt,
      }]
    }

    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify({ type: 'tool_result', call_id: callId, output }))
      lastToolResultAt = Date.now()
      console.debug(`[omni-realtime] tool_result sent call_id=${callId} name=${name}`)
    } catch { /* ignore — the socket is closing */ }
  }

  function handleServerEvent(msg: { type: string; [k: string]: unknown }): void {
    switch (msg.type) {
      case 'ready':
        phase.value = 'ready'
        break
      case 'listening':
        maybeBargeIn()
        phase.value = 'listening'
        // VAD opened the user's turn: start collecting the mic samples being
        // streamed upstream so the consumer can attach them to the transcript.
        if (options.onUserTurnAudio && !capturingUserAudio) {
          capturingUserAudio = true
          userAudioChunks = []
        }
        break
      case 'speech_stopped':
        // back to ready — server VAD has closed the user's turn. The user's
        // audio itself ends here; keep the collected chunks until the
        // committed transcript (`user_transcript`) arrives so the recording
        // can be paired with its text.
        capturingUserAudio = false
        phase.value = phase.value === 'speaking' ? 'speaking' : 'ready'
        break
      case 'response_started': {
        // Diagnostics for the "no audio after a tool call" symptom: log how
        // long after sending tool_result the follow-up response began, so we
        // can tell "model never answered" from "audio got dropped downstream".
        const toolContinuation = lastToolResultAt > 0
          && Date.now() - lastToolResultAt < TOOL_CONTINUATION_WINDOW_MS
        if (lastToolResultAt > 0) {
          console.debug(`[omni-realtime] response_started after tool_result (+${Date.now() - lastToolResultAt}ms)`)
          lastToolResultAt = 0
        }
        phase.value = 'speaking'
        // A new response is beginning upstream. When it is the model's
        // continuation right after OUR tool_result (口语对练点评/追问跨工具调用),
        // any audio still playing or queued is the FIRST HALF of the same
        // spoken turn — cutting it would truncate the sentence. Skip the cut
        // and let `flushPendingToSlot` chain the new chunks behind
        // `nextPlayTime` so the utterance plays out continuously. Otherwise
        // (fresh response after a user turn) cut the previous response's
        // tail so audio stays aligned with the subtitles.
        if (!toolContinuation) {
          stopPlayback()
        }
        // Start the new turn with a clean caption either way — the committed
        // bubble for the previous turn already shows its final text while the
        // tail drains.
        liveAssistantText.value = ''
        break
      }
      case 'response_done':
        flushPendingToSlot()
        phase.value = 'ready'
        // The cancelled response has fully drained upstream — any binary
        // audio frame from now on belongs to the next turn.
        droppingAssistantAudio = false
        break
      case 'user_transcript': {
        const text = String(msg.text ?? '')
        if (text.trim()) {
          commitUserTurn(text)
        } else {
          // Empty commit: nothing to attach — drop the pending capture.
          userAudioChunks = []
          capturingUserAudio = false
        }
        break
      }
      case 'transcript_delta':
        liveAssistantText.value = (liveAssistantText.value || '') + String(msg.text ?? '')
        if (activeTextAsk) activeTextAsk.collected += String(msg.text ?? '')
        break
      case 'transcript':
        commitAssistantTurn(String(msg.text ?? ''))
        // 收尾总评等文本提问：模型说完即结算（转写已入 turns，报告会引用）。
        if (activeTextAsk) {
          const ask = activeTextAsk
          activeTextAsk = null
          window.clearTimeout(ask.timer)
          const finalText = (String(msg.text ?? '') || ask.collected).trim()
          ask.resolve(finalText)
        }
        break
      case 'function_call':
        void handleFunctionCall(msg)
        break
      case 'error': {
        const m = String(msg.message ?? 'unknown error')
        errorMessage.value = m
        phase.value = 'error'
        if (activeTextAsk) {
          const ask = activeTextAsk
          activeTextAsk = null
          window.clearTimeout(ask.timer)
          ask.reject(new Error(m))
        }
        options.onError?.(m)
        break
      }
      case 'stopped':
        phase.value = 'closed'
        break
      case 'pong':
        break
      default:
        break
    }
  }

  // --- capture -----------------------------------------------------------

  /**
   * Pre-arm the playback AudioContext inside the user gesture that started the
   * session. Browsers' autoplay policy only lets an AudioContext created
   * *within* a user activation run (or be resumed); `ws.onopen` fires well
   * after the click (the meeting backend may still be starting up), so arming
   * the context only there leaves AI audio silent until some later interaction
   * unlocks the page. Call this synchronously from the stage's start handler.
   */
  async function prearmPlayback(): Promise<void> {
    await ensurePlaybackContext()
  }

  async function ensureCaptureContext(): Promise<AudioContext> {
    if (audioContext) return audioContext
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    audioContext = new Ctor({ sampleRate: 48000 })
    // The worklet source rate is whatever AudioContext picked; we resample
    // to 24 kHz in the message handler below.
    await audioContext.audioWorklet.addModule('/audio/pcm-worklet.js')
    return audioContext
  }

  async function startCapture(): Promise<void> {
    if (micStream) return
    const ctx = await ensureCaptureContext()
    if (ctx.state === 'suspended') await ctx.resume()

    // Browser-level acoustic echo cancellation MUST stay on: the assistant's
    // TTS audio is played through `playbackCtx.destination` (the system
    // speakers) right next to the mic, and without AEC the upstream VAD
    // hears that echo as a new user turn, triggers a `listening` event,
    // and we cancel our own playback in a self-interrupting loop.
    // We deliberately keep NS / AGC off so the Omni model still gets raw
    // input for downstream processing — AEC is the only constraint we need.
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: { ideal: false },
        autoGainControl: { ideal: false },
      },
    })
    // Honour a mute requested while getUserMedia was still resolving —
    // otherwise the tracks come up live and a muted user briefly sees the
    // input level move or could trip a stale barge-in streak.
    applyMicMuteState()

    micSource = ctx.createMediaStreamSource(micStream)
    analyser = ctx.createAnalyser()
    analyser.fftSize = 256

    workletNode = new AudioWorkletNode(ctx, 'pcm-processor')
    micSource.connect(analyser)
    analyser.connect(workletNode)
    // do NOT connect to destination — would echo.

    workletNode.port.onmessage = (event: MessageEvent<{ samples: Float32Array; sourceSampleRate: number }>) => {
      if (!ws || ws.readyState !== WebSocket.OPEN || !isPushing.value) return
      const { samples, sourceSampleRate } = event.data
      const resampled = resampleLinear(samples, sourceSampleRate, INPUT_SAMPLE_RATE)
      const int16 = float32ToInt16(resampled)
      // Keep a private copy for the per-user-turn recording hook (the send
      // below must not alias the buffer we retain).
      if (capturingUserAudio) userAudioChunks.push(int16.slice())
      // int16.buffer types as ArrayBufferLike (SharedArrayBuffer possible on
      // generic typed arrays); WebSocket.send only accepts ArrayBuffer, and we
      // always allocate fresh buffers here, so the cast is safe.
      ws.send(int16.buffer as ArrayBuffer)
    }

    // visual feedback: peak/RMS blend with EMA smoothing on the peak channel.
    //
    // Without smoothing `inputLevel` carried raw peaks (one spike per click,
    // AEC-residual echo during AI playback). The visualizer then drove its
    // twinkle frequency and radial position off this raw signal — every
    // residual echo frame moved the starfield, producing the "鬼畜" jitter.
    // Blending peak with the already-smoothed RMS and running an EMA gives
    // a signal that still spikes on real speech (RMS rises during sustained
    // voice) but rejects single-frame transients.
    const buf = new Uint8Array(analyser.frequencyBinCount)
    const tick = (): void => {
      if (!analyser) return
      analyser.getByteTimeDomainData(buf)
      let peak = 0
      let sumSquares = 0
      for (let i = 0; i < buf.length; i += 1) {
        const v = ((buf[i] ?? 128) - 128) / 128
        const a = Math.abs(v)
        if (a > peak) peak = a
        sumSquares += v * v
      }
      // Smoothed RMS (EMA): speech sustains energy across frames, transients
      // (clicks, one loud echo frame) don't move it much. Used below as a
      // sustained-voice gate so the streak can't fire on a single spike.
      rmsSmoothed = rmsSmoothed * 0.7 + Math.sqrt(sumSquares / buf.length) * 0.3
      // Visual-level blend: 0.4 peak + 0.6 RMS-smoothed, then EMA. Keeps
      // punch for hard consonants (plosives, taps) while removing the
      // single-frame echo spikes that caused the visualizer to twitch.
      const blended = peak * 0.4 + rmsSmoothed * 0.6
      inputLevel.value += (blended - inputLevel.value) * (blended > inputLevel.value ? 0.35 : 0.1)
      // Client-side barge-in: the upstream server VAD takes 100–300 ms to
      // emit `listening`, during which the AI audio keeps playing and the
      // user perceives the interrupt as "broken". Trigger `maybeBargeIn`
      // directly off the local mic input peak so the response feels
      // real-time. AEC is enabled above so the residual echo after the
      // AI's own playback is well below `LOCAL_BARGE_IN_THRESHOLD`; the
      // smoothed-RMS floor additionally rejects one-off transients, and the
      // streak still requires several consecutive qualifying frames
      // (hysteresis) so a single loud echo frame can't start a
      // self-interrupt loop.
      const outputActive = isOutputPlaying.value || phase.value === 'speaking'
      // While the assistant is audible, demand a longer sustained streak and
      // a higher peak before believing the user — on platforms without a
      // working AEC the AI's own voice leaks into the mic, and without this
      // tightening a coach sentence would self-interrupt ("语音没播完就停").
      const bargeInThreshold = outputActive ? LOCAL_BARGE_IN_PEAK_DURING_OUTPUT : LOCAL_BARGE_IN_THRESHOLD
      const bargeInStreakNeeded = outputActive ? LOCAL_BARGE_IN_STREAK_DURING_OUTPUT : 3
      if (peak >= bargeInThreshold && rmsSmoothed >= LOCAL_BARGE_IN_RMS_FLOOR) {
        bargeInStreak += 1
      } else {
        bargeInStreak = 0
      }
      if (
        bargeInStreak >= bargeInStreakNeeded
        && options.autoBargeIn
        // Same tail-drain caveat as `maybeBargeIn`: `phase` is already
        // 'ready' while the last queued buffer still plays, so the local
        // peak must also gate on real playback, not just phase.
        && outputActive
        && performance.now() - lastLocalBargeInAt > LOCAL_BARGE_IN_DEBOUNCE_MS
      ) {
        lastLocalBargeInAt = performance.now()
        bargeInStreak = 0
        maybeBargeIn()
      }
      inputLevelRaf = requestAnimationFrame(tick)
    }
    inputLevelRaf = requestAnimationFrame(tick)
  }

  function stopCapture(): void {
    if (inputLevelRaf !== null) {
      cancelAnimationFrame(inputLevelRaf)
      inputLevelRaf = null
    }
    if (workletNode) {
      try { workletNode.disconnect() } catch { /* ignore */ }
      workletNode = null
    }
    if (micSource) {
      try { micSource.disconnect() } catch { /* ignore */ }
      micSource = null
    }
    if (analyser) {
      try { analyser.disconnect() } catch { /* ignore */ }
      analyser = null
    }
    if (micStream) {
      micStream.getTracks().forEach(t => t.stop())
      micStream = null
    }
    if (audioContext) {
      audioContext.close().catch(() => { /* ignore */ })
      audioContext = null
    }
    inputLevel.value = 0
    // Reset client-side barge-in state so a fresh capture session starts
    // with a clean slate (and so a loud echo tail across a stop/start
    // cycle can't fire a spurious interrupt).
    bargeInStreak = 0
    lastLocalBargeInAt = 0
    rmsSmoothed = 0
    // Drop any half-open per-turn recording (no transcript will ever arrive
    // to flush it).
    capturingUserAudio = false
    userAudioChunks = []
  }

  // --- lifecycle ---------------------------------------------------------

  async function connect(opts: {
    model?: string
    voice?: string
    instructions?: string
    /** 本次会话的工具集；缺省用 useOmniRealtime 初始化时的 tools（按技能生成）。 */
    tools?: NonNullable<UseOmniRealtimeOptions['tools']>
  } = {}): Promise<void> {
    if (ws) return
    phase.value = 'connecting'
    errorMessage.value = ''
    turns.value = []
    liveUserText.value = ''
    liveAssistantText.value = ''
    activeTool.value = ''
    toolCalls.value = []
    // Reset client-side barge-in bookkeeping for the new session.
    bargeInStreak = 0
    lastLocalBargeInAt = 0
    rmsSmoothed = 0
    droppingAssistantAudio = false
    lastToolResultAt = 0
    malformedCallSig = ''
    malformedCallStreak = 0
    capturingUserAudio = false
    userAudioChunks = []
    userTurnCount = 0
    // A fresh session starts unmuted; the mute toggle is session-scoped.
    micMuted = false

    const url = meetingWebSocketUrl('/ws/omni-realtime')
    ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      // Hands-free: stream mic audio as soon as the capture worklet is up;
      // the server VAD decides when a turn starts/ends. If the user muted
      // while the backend was still starting, respect that here instead of
      // forcing the feed back on.
      if (options.handsFree) isPushing.value = !micMuted
      // Pre-arm the playback AudioContext inside this user-gesture tick so the
      // first binary frame can be scheduled without an autoplay rejection.
      void ensurePlaybackContext()
      try {
        startCapture().catch(err => {
          errorMessage.value = String((err as Error).message ?? err)
          phase.value = 'error'
          options.onError?.(errorMessage.value)
        })
      } catch (err) {
        errorMessage.value = String((err as Error).message ?? err)
        phase.value = 'error'
      }
      ws?.send(JSON.stringify({
        type: 'start',
        model: opts.model,
        voice: opts.voice,
        instructions: opts.instructions,
        tools: opts.tools ?? sessionTools,
      }))
    }

    ws.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        // Drop the tail of any cancelled response: upstream keeps emitting
        // audio deltas for a few frames after `response.cancel` lands, and
        // without this guard the user hears the old reply overlap the new
        // one (the freshly-flushed source starts immediately rather than
        // waiting behind the now-stopped-but-still-decoding tail).
        if (droppingAssistantAudio) return
        // Tool-turn audio diagnostics: confirm audio really arrived after a
        // tool_result (helps tell "model never answered" from "audio dropped").
        if (lastToolResultAt > 0) {
          console.debug(`[omni-realtime] audio frame after tool_result (+${Date.now() - lastToolResultAt}ms)`)
          lastToolResultAt = 0
        }
        const view = new Int16Array(event.data)
        appendPcmChunk(view)
        // Flush every chunk so the user hears the model as it streams rather
        // than a single buffered blast after `response_done` — the queue
        // (`nextPlayTime` + `scheduledSources`) chains slots back-to-back.
        flushPendingToSlot()
        return
      }
      try {
        const msg = JSON.parse(event.data)
        handleServerEvent(msg)
      } catch (err) {
        console.warn('[omni-realtime] failed to parse event', err)
      }
    }

    ws.onerror = () => {
      // The browser doesn't expose the actual error; surface a generic one.
      errorMessage.value = 'Realtime session error'
      phase.value = 'error'
      options.onError?.(errorMessage.value)
    }

    ws.onclose = () => {
      if (activeTextAsk) {
        const ask = activeTextAsk
        activeTextAsk = null
        window.clearTimeout(ask.timer)
        ask.reject(new Error('realtime session closed'))
      }
      stopCapture()
      stopPlayback()
      stopOutputLevelLoop()
      outputAnalyser.value = null
      outputLevelBuf = null
      if (playbackCtx) {
        playbackCtx.close().catch(() => { /* ignore */ })
        playbackCtx = null
      }
      masterGain = null
      ws = null
      if (phase.value !== 'error') phase.value = 'closed'
    }
  }

  function disconnect(): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'stop' })) } catch { /* ignore */ }
    }
    setTimeout(() => {
      if (ws) {
        try { ws.close() } catch { /* ignore */ }
        ws = null
      }
    }, 100)
    isPushing.value = false
    stopCapture()
    stopPlayback()
    stopOutputLevelLoop()
    outputAnalyser.value = null
    outputLevelBuf = null
    if (playbackCtx) {
      playbackCtx.close().catch(() => { /* ignore */ })
      playbackCtx = null
    }
    masterGain = null
    phase.value = 'closed'
  }

  /**
   * Graceful session end: stop pushing the mic and let whatever the model is
   * currently saying drain through the speakers before tearing the socket
   * down. Used by timed practice auto-finish so the coach's last sentence is
   * heard in full instead of being cut mid-word by `disconnect()`.
   *
   * Frames that are still streaming when the queue empties keep scheduling
   * (the socket stays open and `flushPendingToSlot` runs per chunk), and the
   * wait loop below only resolves once nothing is queued or the timeout hits.
   */
  async function stopGracefully(timeoutMs = 8000): Promise<void> {
    if (!ws) {
      disconnect()
      return
    }
    isPushing.value = false
    stopCapture()
    flushPendingToSlot()
    const deadline = Date.now() + timeoutMs
    while (isOutputPlaying.value && Date.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 120))
    }
    disconnect()
  }

  /**
   * 只排空不断开：停止推流并等当前 AI 句子放完（socket 保持打开）。
   * 用于同会话收尾总评前，确保上一段语音不与被注入的回复重叠。
   */
  async function drainOutput(timeoutMs = 8000): Promise<void> {
    if (!ws) return
    isPushing.value = false
    stopCapture()
    flushPendingToSlot()
    const deadline = Date.now() + timeoutMs
    while ((isOutputPlaying.value || phase.value === 'speaking') && Date.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 120))
    }
  }

  /**
   * 同会话文本提问（复用本 WS 的已看/已听上下文，不另开离线窗口）：
   * 闭麦排空后注入 `{"type":"text","text":...}`，收集模型随后的语音转写
   * （教练口头收尾总评），resolve 完整文本；超时/错误/断连 reject。
   * 转写会照常进入 turns（会话与报告引用同源）。
   */
  async function askText(text: string, options: { timeoutMs?: number } = {}): Promise<string> {
    const prompt = (text || '').trim()
    if (!prompt) return ''
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('realtime session is not connected')
    }
    await drainOutput(8000)
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('realtime session closed while draining output')
    }
    isPushing.value = false
    setMicStreaming(false)
    const timeoutMs = options.timeoutMs ?? 90_000
    return new Promise<string>((resolve, reject) => {
      const request: TextAskRequest = {
        resolve,
        reject,
        collected: '',
        timer: 0,
      }
      request.timer = window.setTimeout(() => {
        if (activeTextAsk === request) activeTextAsk = null
        reject(new Error('closing review timed out'))
      }, timeoutMs)
      activeTextAsk = request
      try {
        ws?.send(JSON.stringify({ type: 'text', text: prompt }))
      } catch (cause) {
        if (activeTextAsk === request) activeTextAsk = null
        window.clearTimeout(request.timer)
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      }
    })
  }

  /** Begin streaming mic audio upstream. */
  function pushStart(): void {
    isPushing.value = true
  }

  /** Stop streaming mic audio and ask the model to reply. */
  function pushStop(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      isPushing.value = false
      return
    }
    isPushing.value = false
    try { ws.send(JSON.stringify({ type: 'commit' })) } catch { /* ignore */ }
  }

  /**
   * Toggle the upstream mic feed without committing a turn (hands-free mute).
   * Unlike `pushStop`, no `commit` control frame is sent.
   *
   * Mute is applied at the capture source, not just to the WS feed: the mic
   * tracks are disabled (`track.enabled = false`) so the capture graph emits
   * silence. A muted user therefore produces no input-level movement, cannot
   * stream audio upstream, and cannot trigger a barge-in — the assistant
   * keeps talking undisturbed until unmute.
   */
  function setMicStreaming(active: boolean): void {
    micMuted = !active
    isPushing.value = active
    applyMicMuteState()
    if (active) {
      // Fresh stream after a mute: clear local barge-in bookkeeping so the
      // first frames of the new stream can't ride a stale streak.
      bargeInStreak = 0
      lastLocalBargeInAt = 0
      rmsSmoothed = 0
    } else {
      // Kill the visual input level immediately instead of letting the EMA
      // decay, and drop any half-open per-user-turn recording — no further
      // samples will arrive to complete it.
      inputLevel.value = 0
      capturingUserAudio = false
      userAudioChunks = []
    }
  }

  /** Reflect the current mute state onto the live mic source tracks. */
  function applyMicMuteState(): void {
    if (!micStream) return
    for (const track of micStream.getAudioTracks()) {
      try { track.enabled = !micMuted } catch { /* ignore */ }
    }
  }

  /** 会话连接前按技能覆盖工具集（口语对练按技能动态生成评分工具与工作台子集）。 */
  function setTools(tools: NonNullable<UseOmniRealtimeOptions['tools']>): void {
    sessionTools = tools
  }

  /** Stop assistant playback and cancel the in-flight response (manual barge-in). */
  function interrupt(): void {
    stopPlayback()
    // Clear the live subtitle text synchronously so the bubble layer
    // reflows once, in this tick. Without this, the watcher on
    // `isOutputPlaying` (cleared inside `stopPlayback()`) fires in a
    // separate Vue flush and the bubble-stack recomputes twice in one
    // interrupt — that double recompute is the visible "chat log
    // jumps" flicker. The watcher still serves the natural-playback
    // finish path; this is the manual-cancel companion.
    liveAssistantText.value = ''
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try { ws.send(JSON.stringify({ type: 'cancel' })) } catch { /* ignore */ }
  }

  /**
   * Send one JPEG camera frame to the model.
   *
   * Accepts either a full `data:image/jpeg;base64,...` data URL (what
   * `canvas.toDataURL` produces) or raw base64 — the server strips the
   * prefix before forwarding as `input_image_buffer.append`. Frames are
   * dropped silently while the socket is not open.
   *
   * DashScope constraints: JPG/JPEG only, ≤256 KB base64, ~1 fps
   * recommended, and audio must already be streaming (hands-free capture
   * starts on `ws.onopen`, so this holds for this app).
   */
  function sendImage(image: string): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN || !image) return false
    const payload = image.startsWith('data:') ? image.slice(image.indexOf(',') + 1) : image
    if (!payload || payload.length > 256 * 1024 || ws.bufferedAmount > 512 * 1024) return false
    try {
      ws.send(JSON.stringify({ type: 'image', image: payload }))
      return true
    } catch { return false }
  }

  function abortResponse(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try { ws.send(JSON.stringify({ type: 'cancel' })) } catch { /* ignore */ }
  }

  function clearHistory(): void {
    turns.value = []
    liveUserText.value = ''
    liveAssistantText.value = ''
    toolCalls.value = []
  }

  onUnmounted(() => {
    disconnect()
  })

  return {
    phase,
    errorMessage,
    turns,
    liveUserText,
    liveAssistantText,
    activeTool,
    toolCalls,
    inputLevel,
    outputLevel,
    /** Shallow ref to the playback AnalyserNode — OmniVisualizer
     *  attach()es to it on mount so the perimeter waveform reflects
     *  real spectrum data, not just smoothed level. */
    outputAnalyser,
    isPushing,
    isReady,
    isOutputPlaying,
    prearmPlayback,
    connect,
    disconnect,
    stopGracefully,
    drainOutput,
    askText,
    setTools,
    pushStart,
    pushStop,
    setMicStreaming,
    interrupt,
    abortResponse,
    clearHistory,
    sendImage,
  }
}

export type OmniRealtime = ReturnType<typeof useOmniRealtime>
