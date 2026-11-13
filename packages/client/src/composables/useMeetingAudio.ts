import { meetingWebSocketUrl } from '@/utils/meeting-websocket'
import { computed, nextTick, ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMeetingStore } from '@/stores/hermes/meeting'
import type { TranscriptSentence } from '@/stores/hermes/meeting'
import { meetingASRApi } from '@/utils/meeting-asr-api'
import { meetingStorageApi } from '@/utils/meeting-storage-api'
import { useMessage } from '@/composables/useAppMessage'

export interface AsrServiceStatus {
  isRunning: boolean
  asrPort: number | null
  diarizePort: number | null
  pid: number | null
  uptime: number | null
  error: string | null
}

export interface UseMeetingAudioDeps {
  /** 录音传输模式（说话人分离开关），由 view 持有，录音启动时读取 */
  useDiarize: Ref<boolean>
  /** 节省模式（只走说话人分离，不走实时 ASR） */
  saveMode: Ref<boolean>
  /** 说话人数（0 = auto），diarize start 消息参数 */
  speakerCount: Ref<number>
  /** ASR 服务状态 / 最近一次启动错误（由 view 的 startASRService 维护） */
  asrServiceStatus: Ref<AsrServiceStatus>
  asrServiceError: Ref<string>
  /** 没有活动会议时引导新建会议 */
  openCreateModal: () => void
  /** 确保后端 ASR 服务运行（view 编排，含向导输入回退） */
  startASRService: () => Promise<boolean>
  /** ASR/Diarize WS 消息处理（view 编排，写转写状态） */
  handleWsMessage: (data: any, source?: 'asr' | 'diarize') => void
  /** 录音停止后保存会议数据 */
  saveCurrentMeeting: () => void | Promise<void>
  /** 报告面板 ref，录音停止后自动触发生成 */
  assistPanelRef: Ref<{ generateReport: (transcript: string) => void } | null>
  /** 当前转写句子（seekToSentence 定位用） */
  sentences: Ref<TranscriptSentence[]>
}

/**
 * 会议音频录制 + 播放的完整生命周期（拆分自 MeetingView.vue，行为保持一致）。
 *
 * 录制侧覆盖：麦克风可用性检查、getUserMedia + AudioContext + AudioWorklet
 * 采集管线、MediaRecorder 分块录制、关页/刷新兜底、以及 ASR/Diarize 双
 * WebSocket 的连接与关闭。转写消息的解析回调（handleWsMessage）仍由 view
 * 提供，因为句子状态机属于转写域。
 *
 * 播放侧覆盖：Audio 实例管理、播放/暂停/停止、seek（绝对时间 / 句子 / 进度条
 * 拖拽）、时长探测与当前句子高亮。
 */
export function useMeetingAudio(deps: UseMeetingAudioDeps) {
  const meetingStore = useMeetingStore()
  const { t } = useI18n()
  const message = useMessage()

  // --- 配置 ---
  // WebSocket goes through the Node server proxy (/ws/asr, /ws/diarize) so the
  // browser uses the same origin (wss://host:6060) — no Mixed Content, no
  // self-signed cert issues. The proxy forwards plaintext to the Python backend.
  const ASR_URL = '/ws/asr'
  const DIARIZE_URL = '/ws/diarize'

  // --- 录音会话状态 ---
  const isRecording = ref(false)
  const isConnecting = ref(false)
  const statusText = ref('')
  const errorMessage = ref('')

  // --- WebSocket & Audio ---
  let ws: WebSocket | null = null
  let diarizeWs: WebSocket | null = null  // 说话人分离专用WebSocket
  let audioContext: AudioContext | null = null
  let mediaStream: MediaStream | null = null
  const analyser = ref<AnalyserNode | null>(null)

  // --- ASR WebSocket 重连机制 ---
  // 区分用户主动停止（stopRecording）与异常断开（网络/Python 进程崩溃）
  let cleanStop = false
  let reconnectAttempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  const MAX_RECONNECT_ATTEMPTS = 3
  const RECONNECT_BASE_DELAY_MS = 2000

  // --- 音频录制 ---
  let mediaRecorder: MediaRecorder | null = null
  const audioChunks = ref<Blob[]>([])
  const recordingStartTime = ref(0)
  const audioBlob = ref<Blob | null>(null)
  const audioUrl = ref('')
  const isPlaying = ref(false)
  const playbackTime = ref(0)
  const playbackDuration = ref(0)

  watch(audioUrl, (url) => {
    if (url) {
      const tempAudio = new Audio(url)
      tempAudio.onloadedmetadata = () => {
        if (isFinite(tempAudio.duration)) {
          playbackDuration.value = tempAudio.duration
        } else {
          tempAudio.currentTime = 1e10
          tempAudio.ondurationchange = () => {
            if (isFinite(tempAudio.duration)) {
              playbackDuration.value = tempAudio.duration
              tempAudio.ondurationchange = null
            }
          }
        }
      }
    } else {
      playbackDuration.value = 0
    }
  })

  // --- 录音中关页/刷新兜底：把内存里的音频块落库到 IndexedDB ---
  // 音频只在 stopRecording 一次性正式落库，但用户在录音中直接刷新或关闭页面时，
  // 组件不会走 onUnmounted（浏览器通常跳过 beforeunload 之后的清理），此时内存中的
  // audioChunks 会全部丢失。这里用 pagehide/beforeunload 把尚未落库的块写成
  // IndexedDB 备份——注意 IndexedDB 事务在页面卸载进程中是非阻塞的，即便耗时也能完成写入。
  //
  // 不再监听 unload：嵌入到 iframe / in-app browser 容器时 Permissions-Policy 会拒绝
  // 'unload' 事件，浏览器只打违规日志并不会调用回调，所以 unload 监听是个无效冗余；
  // pagehide 在 SPA 切页 / 移动端 / 嵌入容器里都会触发，覆盖更全。
  let beforeUnloadHandlerAttached = false
  // 注册与移除必须使用同一个函数引用；removeEventListener 对不同的引用（哪怕是
  // 相同代码的另一个闭包）不生效，会导致监听器随每次录音残留累积。
  let unloadBackupHandler: (() => void) | null = null

  function attachBeforeUnloadAudioBackup() {
    if (beforeUnloadHandlerAttached) return
    beforeUnloadHandlerAttached = true

    const backup = () => {
      const sessionId = meetingStore.activeSessionId
      if (!isRecording.value || !sessionId || audioChunks.value.length === 0) return
      try {
        const blob = new Blob(audioChunks.value, { type: 'audio/webm' })
        meetingStore.saveAudioData(sessionId, blob)
      } catch (err) {
        console.error('[meeting] Failed to backup audio on unload:', err)
      }
    }

    unloadBackupHandler = backup
    window.addEventListener('beforeunload', backup)
    window.addEventListener('pagehide', backup)
  }

  function detachBeforeUnloadAudioBackup() {
    if (!beforeUnloadHandlerAttached || !unloadBackupHandler) return
    beforeUnloadHandlerAttached = false
    window.removeEventListener('beforeunload', unloadBackupHandler)
    window.removeEventListener('pagehide', unloadBackupHandler)
    unloadBackupHandler = null
  }

  // --- 麦克风检测（仅做浏览器兼容性检查，不阻断 getUserMedia） ---
  async function checkMicrophoneAvailability(): Promise<{ available: boolean; reason?: string }> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      // 某些浏览器在 HTTP 非安全上下文中直接隐藏 navigator.mediaDevices，
      // 此时应提示 HTTPS 访问而非"浏览器不支持"，给用户一条可操作的路径。
      if (typeof window !== 'undefined' && !window.isSecureContext) {
        return { available: false, reason: 'micInsecureContext' }
      }
      return { available: false, reason: 'micUnsupported' }
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const hasAudioInput = devices.some(d => d.kind === 'audioinput')
      if (hasAudioInput) return { available: true }
    } catch {
      // enumerateDevices 失败不阻断，让 getUserMedia 自己处理
    }

    // enumerateDevices 在 HTTP 局域网 IP 下可能返回空数组
    // 不做硬阻断，继续走 getUserMedia，让浏览器弹出权限请求或抛出 NotFoundError
    return { available: true }
  }

  // --- ASR WebSocket 重连 ---
  // 清理旧的重连定时器
  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  // 尝试重连 ASR WebSocket（音频管线保持运行，仅重建 socket）
  async function tryReconnectASR() {
    if (cleanStop || !isRecording.value) return
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.warn('[meeting] ASR reconnect: max attempts reached, stopping recording')
      stopRecording()
      return
    }

    reconnectAttempts++
    const delay = RECONNECT_BASE_DELAY_MS * reconnectAttempts
    console.log(`[meeting] ASR reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms...`)
    statusText.value = t('meeting.reconnecting')

    reconnectTimer = setTimeout(async () => {
      if (cleanStop || !isRecording.value) return

      try {
        // 先确保服务端 ASR 进程仍在运行（可能因崩溃而不可用）
        const started = await deps.startASRService()
        if (!started) {
          console.warn('[meeting] ASR reconnect: startASRService failed, will retry')
          // 继续重试，不立即放弃
          tryReconnectASR()
          return
        }

        // 创建新的 ASR WebSocket
        ws = new WebSocket(meetingWebSocketUrl(ASR_URL))

        ws.onopen = () => {
          console.log('[meeting] ASR WebSocket reconnected')
          reconnectAttempts = 0 // 重连成功，重置计数
          ws?.send(JSON.stringify({ type: 'start' }))
        }

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data)
            deps.handleWsMessage(data, 'asr')
          } catch (e) {
            console.error('Failed to parse ASR WS message:', e)
          }
        }

        ws.onerror = (error) => {
          console.error('[meeting] ASR reconnect WebSocket error:', error)
          // onclose 会紧跟 onerror 触发，由 onclose 统一处理重试
        }

        ws.onclose = () => {
          console.log('[meeting] ASR reconnect WebSocket closed')
          // 仍在录音中 → 继续尝试重连
          if (!cleanStop && isRecording.value) {
            tryReconnectASR()
          }
        }
      } catch (err) {
        console.error('[meeting] ASR reconnect failed:', err)
        tryReconnectASR()
      }
    }, delay)
  }

  // --- 音频处理 ---
  async function startRecording() {
    // 没有活动会议时，先引导用户新建会议
    if (!meetingStore.activeSessionId) {
      deps.openCreateModal()
      return
    }

    try {
      errorMessage.value = ''
      isConnecting.value = true
      statusText.value = t('meeting.connecting')
      cleanStop = false
      reconnectAttempts = 0
      clearReconnectTimer()

      // 第 1 阶段：麦克风检测
      const micCheck = await checkMicrophoneAvailability()
      if (!micCheck.available) {
        errorMessage.value = t(`meeting.${micCheck.reason}`)
        isConnecting.value = false
        return
      }

      // 检查并启动 ASR 服务（服务已运行时也会调用，确保 OSS 配置变更后重启进程）
      statusText.value = t('meeting.startingASRService')
      console.log('[meeting] Ensuring ASR service is running with current config...')
      const started = await deps.startASRService()
      if (!started) {
        const errorMsg = deps.asrServiceError.value || t('meeting.asrServiceStartError')
        console.error('[meeting] Failed to start ASR service:', errorMsg)
        errorMessage.value = errorMsg
        isConnecting.value = false
        return
      }
      console.log('[meeting] ASR service ready, ports:', deps.asrServiceStatus.value.asrPort, deps.asrServiceStatus.value.diarizePort)

      // 等待服务完全就绪并验证
      statusText.value = t('meeting.connecting')
      await new Promise(resolve => setTimeout(resolve, 2000))

      // 验证服务是否真的启动了
      try {
        const healthCheck = await meetingASRApi.healthCheck()
        console.log('[meeting] ASR service health check:', healthCheck)
        if (healthCheck.status !== 'ok') {
          throw new Error('ASR service health check failed')
        }
      } catch (err) {
        console.error('[meeting] ASR service health check failed:', err)
        errorMessage.value = t('meeting.asrServiceStartError')
        isConnecting.value = false
        return
      }

      // 获取麦克风权限。
      // 注意：sampleRate 和 channelCount 不在此处约束（精确约束会触发 NotReadableError），
      // 而是在下游 worklet handler 中做重采样到 16kHz / 转 Int16。
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: { ideal: false },
          noiseSuppression: { ideal: false },
          autoGainControl: { ideal: false },
        },
      })

      // 创建音频上下文
      audioContext = new AudioContext({ sampleRate: 16000 })

      // 如果采样率不是16000，需要重采样
      if (audioContext.sampleRate !== 16000) {
        console.log(`Browser sample rate: ${audioContext.sampleRate}, will resample to 16000`)
      }

      const source = audioContext.createMediaStreamSource(mediaStream)

      // 创建分析节点用于可视化
      analyser.value = audioContext.createAnalyser()
      analyser.value.fftSize = 256

      // AudioWorklet 替代 deprecated ScriptProcessorNode，跑在 audio 线程不抢主线程。
      // JS 副本在 public/audio/pcm-worklet.js（源文件 src/audio/pcm-worklet.ts）。
      await audioContext.audioWorklet.addModule('/audio/pcm-worklet.js')
      const pcmNode = new AudioWorkletNode(audioContext, 'pcm-processor')
      source.connect(analyser.value)
      analyser.value.connect(pcmNode)
      // 注意：worklet node 不能 connect 到 destination（会回声）。仅做 passthrough 处理。

      // 开始录制音频用于保存。timeslice=1000ms 切分，避免长会议占满内存。
      audioChunks.value = []
      recordingStartTime.value = Date.now()
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm' })
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunks.value.push(e.data)
        }
      }
      mediaRecorder.start(1000) // 每秒收集一次数据

      // 录音开始后，挂载关页/刷新兜底（把内存音频块落库到 IndexedDB）
      attachBeforeUnloadAudioBackup()

      // 根据模式决定连接哪些 WebSocket
      const isSaveMode = deps.useDiarize.value && deps.saveMode.value

      if (isSaveMode) {
        // 节省模式：只连接 Diarize WebSocket，不走实时ASR
        console.log('[meeting] Save mode: only connecting to Diarize WebSocket:', DIARIZE_URL)
        diarizeWs = new WebSocket(meetingWebSocketUrl(DIARIZE_URL))

        diarizeWs.onopen = () => {
          console.log('Diarize WebSocket connected (save mode)')
          isConnecting.value = false
          isRecording.value = true
          statusText.value = t('meeting.recording')
          diarizeWs?.send(JSON.stringify({
            type: 'start',
            sample_rate: 16000,
            speaker_count: deps.speakerCount.value || 'auto'
          }))
        }

        diarizeWs.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data)
            deps.handleWsMessage(data, 'diarize')
          } catch (e) {
            console.error('Failed to parse Diarize WS message:', e)
          }
        }

        diarizeWs.onerror = (error) => {
          console.error('Diarize WebSocket error (save mode):', error)
          // onclose 会紧跟 onerror 触发，由 onclose 统一处理
        }

        diarizeWs.onclose = () => {
          console.log('Diarize WebSocket closed (save mode)')
          if (!cleanStop && isRecording.value) {
            // 保存模式下仅 Diarize，无 ASR 重连逻辑——直接停止录音
            // （Diarize 服务崩溃通常需要人工介入）
            stopRecording()
          }
        }

        // 音频统一由下方共享的 AudioWorklet handler 发送
      } else if (deps.useDiarize.value) {
        // 启用说话人分离的正常模式：连接 ASR + Diarize 两个 WebSocket
        console.log('[meeting] Diarize mode: connecting to both ASR and Diarize WebSockets')

        // 连接 ASR WebSocket (实时转写)
        console.log('[meeting] Connecting to ASR WebSocket:', ASR_URL)
        ws = new WebSocket(meetingWebSocketUrl(ASR_URL))

        ws.onopen = () => {
          console.log('ASR WebSocket connected')
          isConnecting.value = false
          isRecording.value = true
          statusText.value = t('meeting.recording')
          // Per-session provider override: route audio to DashScope (default)
          // or MiniMax based on the active session's asrProvider field.
          const startPayload: Record<string, unknown> = { type: 'start' }
          const provider = meetingStore.activeSession?.asrProvider
          if (provider === 'minimax') startPayload.provider = 'minimax'
          ws?.send(JSON.stringify(startPayload))
        }

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data)
            deps.handleWsMessage(data, 'asr')
          } catch (e) {
            console.error('Failed to parse ASR WS message:', e)
          }
        }

        ws.onerror = (error) => {
          console.error('ASR WebSocket error:', error)
          // onclose 会紧跟 onerror 触发，由 onclose 统一处理重连
        }

        ws.onclose = () => {
          console.log('ASR WebSocket closed')
          if (!cleanStop && isRecording.value) {
            // 非用户主动停止 → 尝试重连
            tryReconnectASR()
          }
        }

        // 同时连接 Diarize WebSocket (说话人分离)
        console.log('[meeting] Connecting to Diarize WebSocket:', DIARIZE_URL)
        diarizeWs = new WebSocket(meetingWebSocketUrl(DIARIZE_URL))

        diarizeWs.onopen = () => {
          console.log('Diarize WebSocket connected')
          diarizeWs?.send(JSON.stringify({
            type: 'start',
            sample_rate: 16000,
            speaker_count: deps.speakerCount.value || 'auto'
          }))
        }

        diarizeWs.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data)
            deps.handleWsMessage(data, 'diarize')
          } catch (e) {
            console.error('Failed to parse Diarize WS message:', e)
          }
        }

        diarizeWs.onerror = (error) => {
          console.error('Diarize WebSocket error:', error)
        }

        diarizeWs.onclose = () => {
          console.log('Diarize WebSocket closed')
        }

        // 音频由下方共享的 AudioWorklet handler 同时发给 ASR 和 Diarize
      } else {
        // 仅 ASR 模式：只连接 ASR WebSocket（不启用说话人分离）
        console.log('[meeting] ASR only mode: connecting to ASR WebSocket only')

        const asrUrl = ASR_URL
        console.log('[meeting] Connecting to ASR WebSocket:', asrUrl)
        ws = new WebSocket(meetingWebSocketUrl(asrUrl))

        ws.onopen = () => {
          console.log('ASR WebSocket connected')
          isConnecting.value = false
          isRecording.value = true
          statusText.value = t('meeting.recording')
          const startPayload: Record<string, unknown> = { type: 'start' }
          const provider = meetingStore.activeSession?.asrProvider
          if (provider === 'minimax') startPayload.provider = 'minimax'
          ws?.send(JSON.stringify(startPayload))
        }

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data)
            deps.handleWsMessage(data, 'asr')
          } catch (e) {
            console.error('Failed to parse ASR WS message:', e)
          }
        }

        ws.onerror = (error) => {
          console.error('ASR WebSocket error:', error)
          // onclose 会紧跟 onerror 触发，由 onclose 统一处理重连
        }

        ws.onclose = () => {
          console.log('ASR WebSocket closed')
          if (!cleanStop && isRecording.value) {
            // 非用户主动停止 → 尝试重连
            tryReconnectASR()
          }
        }
      }

      // 处理音频数据：通过 AudioWorklet 接收 Float32 buffer，主线程 resample + Int16 转换，
      // 再分发给当前已打开的 socket（ASR / Diarize）
      pcmNode.port.onmessage = (event: MessageEvent<{ samples: Float32Array; sourceSampleRate: number }>) => {
        const wsOpen = !!ws && ws.readyState === WebSocket.OPEN
        const diarizeOpen = !!diarizeWs && diarizeWs.readyState === WebSocket.OPEN
        if (!wsOpen && !diarizeOpen) return
        const { samples, sourceSampleRate } = event.data

        // 重采样到 16000 Hz（如果需要）
        let resampledData: Float32Array
        if (sourceSampleRate !== 16000) {
          const ratio = sourceSampleRate / 16000
          const newLength = Math.round(samples.length / ratio)
          resampledData = new Float32Array(newLength)
          for (let i = 0; i < newLength; i++) {
            resampledData[i] = samples[Math.round(i * ratio)]
          }
        } else {
          resampledData = samples
        }

        // 转换为 Int16 PCM
        const int16Data = new Int16Array(resampledData.length)
        for (let i = 0; i < resampledData.length; i++) {
          const s = Math.max(-1, Math.min(1, resampledData[i]))
          int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
        }

        if (wsOpen) ws!.send(int16Data.buffer)
        if (diarizeOpen) diarizeWs!.send(int16Data.buffer)
      }

      // 声浪可视化由 WaveformCanvas 组件监听 analyser 自动起停，无需手动调用。

    } catch (error: any) {
      console.error('[meeting] Failed to start recording:', error)

      // 启动中途失败（如 worklet addModule 被 CSP 拦截、WS 建连异常）时，
      // 已获取的麦克风流与 AudioContext 必须回收，否则麦克风指示灯常亮、
      // 设备被占用，且重试会叠加分配新的流。
      try {
        mediaRecorder?.state !== 'inactive' && mediaRecorder?.stop()
      } catch { /* best effort */ }
      mediaRecorder = null
      try {
        mediaStream?.getTracks().forEach(track => track.stop())
      } catch { /* best effort */ }
      mediaStream = null
      try {
        audioContext?.close().catch(() => { /* best effort */ })
      } catch { /* best effort */ }
      audioContext = null
      analyser.value = null
      try { ws?.close() } catch { /* best effort */ }
      ws = null
      try { diarizeWs?.close() } catch { /* best effort */ }
      diarizeWs = null
      clearReconnectTimer()

      // 按 DOMException.name 区分错误类型
      switch (error.name) {
        case 'NotFoundError':
          errorMessage.value = t('meeting.micNotFound')
          break
        case 'NotAllowedError':
          errorMessage.value = window.isSecureContext
            ? t('meeting.micPermissionDenied')
            : t('meeting.micInsecureContext')
          break
        case 'NotReadableError':
          errorMessage.value = t('meeting.micPermissionDenied')
          break
        default:
          errorMessage.value = error.message || t('meeting.microphoneError')
      }
      isConnecting.value = false
    }
  }

  async function stopRecording() {
    cleanStop = true
    clearReconnectTimer()
    reconnectAttempts = 0
    isRecording.value = false
    isConnecting.value = false
    statusText.value = ''

    // 声浪可视化由 WaveformCanvas 监听 analyser 自动停止，这里只清空引用。
    analyser.value = null

    // 停止媒体录制器
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop()
    }
    mediaRecorder = null

    // 录音结束，移除关页/刷新兜底监听（正式落库由下方 saveAudioData 完成）
    detachBeforeUnloadAudioBackup()

    // 先捕获 socket 引用再置空成员变量：下方 500ms 延迟关闭读的是捕获的引用，
    // 若直接读 ws/diarizeWs，此时已被置空，close() 会变成 no-op，socket 半开残留。
    const closingAsrWs = ws
    const closingDiarizeWs = diarizeWs

    // 发送停止消息给 ASR（ASR 已在录音过程中流式返回结果，500ms 后安全关闭）
    if (closingAsrWs && closingAsrWs.readyState === WebSocket.OPEN) {
      closingAsrWs.send(JSON.stringify({ type: 'stop' }))
      setTimeout(() => closingAsrWs.close(), 500)
    }
    ws = null

    // 发送停止消息给 Diarize
    if (closingDiarizeWs && closingDiarizeWs.readyState === WebSocket.OPEN) {
      closingDiarizeWs.send(JSON.stringify({ type: 'stop' }))
      setTimeout(() => closingDiarizeWs.close(), 500)
    }
    diarizeWs = null

    // 停止音频 + 关闭 worklet
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop())
      mediaStream = null
    }
    if (audioContext) {
      audioContext.close().catch(() => { /* best effort */ })
      audioContext = null
    }
    analyser.value = null

    // 保存音频（会议结束一次性落库）。录音期间 audioChunks 只累积在内存，
    // MediaRecorder 每 1000ms 切一块，这里统一合成整段 webm 落库：
    //  - 服务器：优先写，失败时 IndexedDB 仍兜底保留本机数据
    //  - IndexedDB：直接存 Blob，作为离线备份
    if (audioChunks.value.length > 0 && meetingStore.activeSessionId) {
      audioBlob.value = new Blob(audioChunks.value, { type: 'audio/webm' })
      audioUrl.value = URL.createObjectURL(audioBlob.value)

      const meetingId = meetingStore.activeSessionId
      const meeting = meetingStore.activeSession

      // 先落会议数据（含 transcript），再上传音频，两件事互相隔离
      deps.saveCurrentMeeting()

      // 上传音频到服务器（失败不阻断 IndexedDB 本地备份）
      await meetingStorageApi
        .uploadAudio(meetingId, audioBlob.value)
        .then(() => console.log('Audio saved to server'))
        .catch(err => {
          console.error('Failed to save audio to server:', err)
          message.error(t('meeting.errorUploadAudioFailed'))
        })

      // 保存到 IndexedDB 作为本机备份（直接存 Blob，避免 base64 编码 33% 膨胀）
      try {
        await meetingStore.saveAudioData(meetingId, audioBlob.value)
      } catch (err) {
        console.error('Failed to save audio to IndexedDB:', err)
      }

      // 完成落库后，清空内存引用让 GC 回收，避免大会议残留内存
      audioChunks.value = []
      if (meeting) {
        meetingStore.updateSession(meetingId, { audioDuration: meeting.audioDuration })
      }
    }

    // 录音停止后自动触发报告生成
    const session = meetingStore.activeSession
    if (session && session.sentences.length > 0 && deps.assistPanelRef.value) {
      const transcript = session.sentences
        .map(s => `${s.speaker ? `[${s.speaker}] ` : ''}${s.text}`)
        .join('\n')
      deps.assistPanelRef.value.generateReport(transcript)
    }
  }

  // --- 音频播放 ---
  const audioElement = ref<HTMLAudioElement | null>(null)

  function playAudio() {
    if (!audioUrl.value) return

    // 如果已经有 Audio 实例，直接继续播放
    if (audioElement.value) {
      audioElement.value.play()
      isPlaying.value = true
      return
    }

    audioElement.value = new Audio(audioUrl.value)
    audioElement.value.play()
    isPlaying.value = true

    audioElement.value.ontimeupdate = () => {
      if (!audioElement.value) return
      playbackTime.value = audioElement.value.currentTime

      // 检查是否到达句子结束时间
      if (playEndAt.value !== null && audioElement.value.currentTime >= playEndAt.value) {
        audioElement.value.pause()
        isPlaying.value = false
        playEndAt.value = null
        return
      }

      // 根据播放时间高亮对应的字幕
      highlightCurrentSentence(audioElement.value.currentTime)
    }

    audioElement.value.onended = () => {
      isPlaying.value = false
      playbackTime.value = 0
      audioElement.value = null
      highlightedSentenceIndex.value = -1
      playEndAt.value = null
    }

    audioElement.value.onloadedmetadata = () => {
      if (audioElement.value && isFinite(audioElement.value.duration)) {
        playbackDuration.value = audioElement.value.duration
      }
    }
  }

  function pauseAudio() {
    if (audioElement.value) {
      audioElement.value.pause()
      isPlaying.value = false
    }
  }

  function togglePlayPause() {
    if (isPlaying.value) {
      pauseAudio()
    } else {
      playAudio()
    }
  }

  function stopAudio() {
    if (audioElement.value) {
      audioElement.value.pause()
      audioElement.value.currentTime = 0
      audioElement.value = null
    }
    isPlaying.value = false
    playbackTime.value = 0
    highlightedSentenceIndex.value = -1
    playEndAt.value = null
  }

  function seekTo(seconds: number) {
    if (!audioElement.value) return
    audioElement.value.currentTime = Math.max(0, Math.min(seconds, playbackDuration.value))
    playbackTime.value = audioElement.value.currentTime
  }

  // 播放到指定句子结束时停止
  const playEndAt = ref<number | null>(null)

  function seekToSentence(index: number) {
    const sentence = deps.sentences.value[index]
    if (!sentence?.startTime || !audioUrl.value) return
    // startTime 是毫秒，需要转换为秒
    const startTimeSec = sentence.startTime / 1000
    const endTimeSec = sentence.endTime ? sentence.endTime / 1000 : null

    // 设置结束时间
    playEndAt.value = endTimeSec

    seekTo(startTimeSec)
    if (!isPlaying.value) {
      playAudio()
    }
  }

  // --- 进度条 ---
  const isDraggingProgress = ref(false)

  const progressPercent = computed(() => {
    if (playbackDuration.value <= 0) return 0
    return (playbackTime.value / playbackDuration.value) * 100
  })

  function seekToPosition(event: MouseEvent) {
    const target = event.currentTarget as HTMLElement
    const rect = target.getBoundingClientRect()
    const percent = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    const time = percent * playbackDuration.value
    playEndAt.value = null  // 用户手动拖拽时取消句子结束限制
    seekTo(time)
  }

  function startProgressDrag(event: MouseEvent) {
    isDraggingProgress.value = true
    playEndAt.value = null  // 用户手动拖拽时取消句子结束限制
    seekToPosition(event)
    document.addEventListener('mousemove', onProgressDrag)
    document.addEventListener('mouseup', stopProgressDrag)
  }

  function onProgressDrag(event: MouseEvent) {
    if (!isDraggingProgress.value) return
    const target = document.querySelector('.progress-track') as HTMLElement
    if (!target) return
    const rect = target.getBoundingClientRect()
    const percent = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    const time = percent * playbackDuration.value
    seekTo(time)
  }

  function stopProgressDrag() {
    isDraggingProgress.value = false
    document.removeEventListener('mousemove', onProgressDrag)
    document.removeEventListener('mouseup', stopProgressDrag)
  }

  // 高亮当前播放的字幕
  const highlightedSentenceIndex = ref(-1)

  function highlightCurrentSentence(currentTimeSec: number) {
    const session = meetingStore.activeSession
    if (!session || session.sentences.length === 0) return

    const currentTimeMs = currentTimeSec * 1000

    // 使用 startTime 匹配（相对于音频开始的时间）
    for (let i = session.sentences.length - 1; i >= 0; i--) {
      const sentence = session.sentences[i]
      if (sentence.startTime && sentence.startTime <= currentTimeMs) {
        if (highlightedSentenceIndex.value !== i) {
          highlightedSentenceIndex.value = i

          // 自动滚动到当前字幕
          nextTick(() => {
            const element = document.querySelector(`.sentence-item[data-index="${i}"]`)
            if (element) {
              element.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }
          })
        }
        break
      }
    }
  }

  return {
    // 录音会话状态
    isRecording,
    isConnecting,
    statusText,
    errorMessage,
    // 采集/录制
    analyser,
    audioChunks,
    recordingStartTime,
    audioBlob,
    audioUrl,
    checkMicrophoneAvailability,
    attachBeforeUnloadAudioBackup,
    detachBeforeUnloadAudioBackup,
    startRecording,
    stopRecording,
    // 播放
    isPlaying,
    playbackTime,
    playbackDuration,
    playEndAt,
    isDraggingProgress,
    progressPercent,
    highlightedSentenceIndex,
    playAudio,
    pauseAudio,
    togglePlayPause,
    stopAudio,
    seekTo,
    seekToSentence,
    seekToPosition,
    startProgressDrag,
    onProgressDrag,
    stopProgressDrag,
    highlightCurrentSentence,
  }
}
