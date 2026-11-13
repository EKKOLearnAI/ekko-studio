import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { saveAudioChunks, loadAudioChunks, deleteAudioChunks } from '@/utils/audio-db'
import { meetingStorageApi } from '@/utils/meeting-storage-api'

export interface MeetingSession {
  id: string
  title: string
  /** 是否由 AI 自动命名（首次分析/最终报告时置 true）。用户手动命名的会议保持 false，AI 永不覆盖。 */
  titleAutoNamed?: boolean
  createdAt: number
  updatedAt: number
  useDiarize: boolean
  sentences: TranscriptSentence[]
  analysisResult: AnalysisResult | null
  htmlContent: string
  speakerMap: Record<string, string>
  speakers: SpeakerEntry[]
  status: 'idle' | 'recording' | 'paused' | 'completed'
  // ASR 模型配置
  asrModel?: string  // 'paraformer-v2' | 'fun-asr' | 'fun-asr-mtl'
  /**
   * ASR provider for the meeting — `'dashscope'` (default) or `'minimax'`.
   * Recorded on the session so the user does not have to re-select the
   * provider after a reload; the backend uses this to route audio to the
   * right upstream API.
   */
  asrProvider?: 'dashscope' | 'minimax'
  // 分析模型配置
  analysisMode: 'hermes' | 'custom'
  hermesProfile?: string
  customProvider?: string
  customModel?: string
  // 场景模板（实时辅助）
  sceneTemplate: string
  // AI 实时分析记录（持久化）
  analysisRounds: AnalysisRoundRecord[]
  // 分析触发配置
  analysisTriggerMode: 'sentences' | 'time' | 'both'
  analysisIntervalSentences: number
  analysisIntervalSeconds: number
  // 音频时长（音频数据存 IndexedDB）
  audioDuration: number
  // Agent 交互相关
  agentSessionId?: string
  agentMessages: AgentMessage[]
  agentStatus: 'idle' | 'connecting' | 'running' | 'completed' | 'error'
  agentConfig: AgentConfig
  // 演讲评分场景（sceneTemplate === 'speech'）专属状态
  speechEval?: SpeechEvalState
}

export interface SpeechTimerRecord {
  label: string      // 环节/演讲者名称（"开场介绍/燕灵"，"/"前为环节、后为演讲者）
  durationSec: number // 实际用时（秒）
  overtimeSec: number // 超时秒数（未超时为 0）
  timestamp: number
  /** 本段起点墙钟（上一条记录时刻或开始走表时刻）；旧数据缺省，由区间工具回推 */
  startTs?: number
  /** 记录类型：segment=演讲环节，transition=串场；旧数据缺省（按标签前缀识别） */
  kind?: 'segment' | 'transition'
}

export interface SpeechEvalState {
  // 计时员（Timer）设置
  timerDurationSec: number  // 单环节标准时长
  yellowAtSec: number       // 黄牌触发（剩余秒数）
  redAtSec: number          // 红牌触发（剩余秒数）
  timerRecords: SpeechTimerRecord[]
  // 赘语记录员（Ah-Counter）
  fillerWords: Record<string, number>
  // 语法官（Grammarian）
  wordOfTheDay: string
  wotdUsedCount: number
  goodPhrases: string[]
  grammarNotes: string[]
  // 肢体语言与台风（手动观察记录：AI 看不到画面，由人工补充，报告据此点评）
  bodyNotes: string[]
  // 计时声音提醒（黄牌/红牌/时间到 语音播报）
  voiceAlert: boolean
}

export interface AgentConfig {
  agentType: 'hermes' | 'claude-code' | 'codex'
  profile?: string
  provider?: string
  model?: string
  codingAgentMode?: 'scoped' | 'global'
}

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  timestamp: number
  toolName?: string
  toolCallId?: string
  toolStatus?: 'running' | 'done' | 'error'
  toolArgs?: any
  toolResult?: any
  toolDuration?: number
  toolPreview?: string
  reasoning?: string
  status?: 'sending' | 'sent' | 'error'
  _expanded?: boolean
}

export interface TranscriptSentence {
  text: string
  timestamp: number
  startTime?: number
  endTime?: number
  speaker?: string
  speakerId?: string
}

export interface AnalysisRoundRecord {
  id: string
  context: string
  priority: 'normal' | 'attention' | 'urgent'
  keyPoint: string
  analysis: string
  timestamp: number
}

export interface AudioChunk {
  // Binary audio data stored as a Blob (not base64). Storing a Blob directly
  // in IndexedDB avoids the 33% size penalty of base64 encoding and skips
  // an extra atob/btoa round-trip on every save/load.
  blob: Blob
  timestamp: number
  duration: number
}

export interface AnalysisResult {
  meeting_type?: string
  summary?: string
  key_points?: string[]
  action_items?: string[] | Array<{ task: string; assignee?: string; deadline?: string }>
  topics?: string[]
  people_mentioned?: string[]
  feedback?: { positive?: string[]; negative?: string[] }
  decisions?: string[]
  risks?: string[]
  learnings?: string[]
  relationships?: Array<{
    source: string
    target: string
    relation: string
  }>
  timestamp?: number
  html_content?: string
}

export interface ASRConfig {
  dashscopeApiKey: string
  paraformerWsUrl: string
  paraformerModel: string
  sampleRate: number
  languageHints: string
  // Optional LLM analysis config (used when starting analysis on a transcript)
  llmApiKey: string
  llmBaseUrl: string
  llmModel: string
  // Optional OSS config (speaker diarization chunk-based flow)
  ossBucket: string
  ossAccessKeyId: string
  ossAccessKeySecret: string
  ossEndpoint: string
  ossPathPrefix: string
  // Optional MiniMax ASR provider config (https://platform.minimax.cn/docs/api-reference/speech-to-text).
  // When `asrProvider === 'minimax'`, the meeting ASR backend will route
  // audio through the MiniMax Speech-to-Text REST API instead of DashScope.
  asrProvider: 'dashscope' | 'minimax'
  minimaxApiKey: string
  minimaxAsrModel: string
  minimaxBaseUrl: string
}

export interface SpeakerEntry {
  id: string
  displayName: string
}

const STORAGE_KEY = 'hermes.meeting.sessions'
const ASR_CONFIG_KEY = 'hermes.meeting.asrConfig'

function generateId(): string {
  return `meeting-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function loadSessions(): MeetingSession[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const sessions = JSON.parse(saved) as MeetingSession[]
      // 兼容旧数据：补全 speakers / analysisRounds 字段，移除 audioChunks
      return sessions.map(s => ({
        ...s,
        speakers: s.speakers || [],
        analysisRounds: s.analysisRounds || [],
        audioChunks: undefined,
        asrProvider: s.asrProvider === 'minimax' ? 'minimax' : 'dashscope',
      }))
    }
  } catch {}
  return []
}

function saveSessions(sessions: MeetingSession[], protectId?: string | null) {
  try {
    // 不保存 audioChunks（已移除）和 speakers 到 localStorage
    const toSave = sessions.map(({ ...rest }) => rest)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave))
  } catch (e: any) {
    // localStorage quota exceeded (~5MB). Trim transcript sentences from the
    // oldest non-active sessions until we fit. Silent failure was previously
    // masking new sessions never being persisted.
    if (e?.name === 'QuotaExceededError' || /quota/i.test(String(e?.message))) {
      console.warn('[meeting] localStorage quota exceeded; archiving oldest sessions')
      archiveOldSessions(sessions, protectId)
    } else {
      console.warn('[meeting] Failed to save sessions to localStorage:', e)
    }
  }
}

/**
 * Trim oldest sessions' transcript sentences (keep metadata + latest N
 * sentences) so the JSON fits in localStorage. Audio + sentences are still
 * recoverable from IndexedDB / server if user wants them back.
 *
 * protectId（当前活跃会话）不参与截断：录音期间活跃会话的 sentences 是
 * 正在累积/展示的业务数据，截断会直接丢掉现场转写。注意不能用 session.status
 * 判断——录音期间没有任何代码把 status 置为 'recording'（只有停止时的
 * saveCurrentMeeting 会写入，且那时 isRecording 已复位）。
 */
function archiveOldSessions(sessions: MeetingSession[], protectId?: string | null) {
  const sorted = [...sessions].sort((a, b) => a.updatedAt - b.updatedAt)
  let changed = false
  for (const s of sorted) {
    if (protectId && s.id === protectId) continue
    if (s.sentences.length > 50) {
      s.sentences = s.sentences.slice(-50)
      changed = true
    }
  }
  if (changed) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions))
    } catch {
      // Still too big — nuke the oldest session entirely.
      const oldest = sorted[0]
      const next = sessions.filter(s => s.id !== oldest.id)
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
        deleteAudioChunks(oldest.id).catch(err => console.warn('[meeting] deleteAudioChunks failed:', err))
        console.warn('[meeting] Dropped oldest session to recover quota:', oldest.id)
      } catch {
        // Last resort: clear everything. User can rebuild from server.
        localStorage.removeItem(STORAGE_KEY)
        console.error('[meeting] Cleared all sessions; localStorage unrecoverable')
      }
    }
  }
}

function loadASRConfig(): ASRConfig {
  try {
    const saved = localStorage.getItem(ASR_CONFIG_KEY)
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<ASRConfig>
      // Backfill defaults for fields added after first deploy so existing
      // users don't see broken wizard fields on upgrade.
      return {
        dashscopeApiKey: parsed.dashscopeApiKey || '',
        paraformerWsUrl: parsed.paraformerWsUrl || 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
        paraformerModel: parsed.paraformerModel || 'paraformer-realtime-v2',
        sampleRate: parsed.sampleRate || 16000,
        languageHints: parsed.languageHints || 'zh,en',
        llmApiKey: parsed.llmApiKey || '',
        llmBaseUrl: parsed.llmBaseUrl || 'https://api.deepseek.com',
        llmModel: parsed.llmModel || 'deepseek-chat',
        ossBucket: parsed.ossBucket || '',
        ossAccessKeyId: parsed.ossAccessKeyId || '',
        ossAccessKeySecret: parsed.ossAccessKeySecret || '',
        ossEndpoint: parsed.ossEndpoint || 'oss-cn-beijing.aliyuncs.com',
        ossPathPrefix: parsed.ossPathPrefix || 'meeting-asr-uploads/',
        asrProvider: parsed.asrProvider === 'minimax' ? 'minimax' : 'dashscope',
        minimaxApiKey: parsed.minimaxApiKey || '',
        minimaxAsrModel: parsed.minimaxAsrModel || 'asr-1.0',
        minimaxBaseUrl: parsed.minimaxBaseUrl || 'https://api.minimaxi.com',
      }
    }
  } catch {}
  return {
    dashscopeApiKey: '',
    paraformerWsUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
    paraformerModel: 'paraformer-realtime-v2',
    sampleRate: 16000,
    languageHints: 'zh,en',
    llmApiKey: '',
    llmBaseUrl: 'https://api.deepseek.com',
    llmModel: 'deepseek-chat',
    ossBucket: '',
    ossAccessKeyId: '',
    ossAccessKeySecret: '',
    ossEndpoint: 'oss-cn-beijing.aliyuncs.com',
    ossPathPrefix: 'meeting-asr-uploads/',
    asrProvider: 'dashscope',
    minimaxApiKey: '',
    minimaxAsrModel: 'asr-1.0',
    minimaxBaseUrl: 'https://api.minimaxi.com',
  }
}

function saveASRConfig(config: ASRConfig) {
  try {
    localStorage.setItem(ASR_CONFIG_KEY, JSON.stringify(config))
  } catch {}
}

export const useMeetingStore = defineStore('meeting', () => {
  const sessions = ref<MeetingSession[]>(loadSessions())
  const activeSessionId = ref<string | null>(null)

  const activeSession = computed(() => {
    if (!activeSessionId.value) return null
    return sessions.value.find(s => s.id === activeSessionId.value) || null
  })

  const sortedSessions = computed(() => {
    return [...sessions.value].sort((a, b) => b.updatedAt - a.updatedAt)
  })

  function createSession(options?: {
    title?: string
    asrModel?: string
    /**
     * ASR provider for the meeting. `'dashscope'` (default) uses Paraformer /
     * Fun-ASR over DashScope; `'minimax'` routes through the MiniMax
     * Speech-to-Text REST API. Stored on the session so a reload can resume
     * with the same provider — UI never re-prompts for this once a session
     * is started.
     */
    asrProvider?: 'dashscope' | 'minimax'
    analysisMode?: 'hermes' | 'custom'
    hermesProfile?: string
    customProvider?: string
    customModel?: string
    agentConfig?: AgentConfig
    sceneTemplate?: string
  }): MeetingSession {
    const now = Date.now()
    const session: MeetingSession = {
      id: generateId(),
      title: options?.title || `会议 ${new Date().toLocaleString('zh-CN')}`,
      createdAt: now,
      updatedAt: now,
      useDiarize: false,
      sentences: [],
      analysisResult: null,
      htmlContent: '',
      speakerMap: {},
      speakers: [],
      status: 'idle',
      asrModel: options?.asrModel || 'paraformer-v2',
      asrProvider: options?.asrProvider || 'dashscope',
      analysisMode: options?.analysisMode || 'hermes',
      hermesProfile: options?.hermesProfile,
      customProvider: options?.customProvider,
      customModel: options?.customModel,
      sceneTemplate: options?.sceneTemplate || 'general',
      analysisRounds: [],
      analysisTriggerMode: 'sentences',
      analysisIntervalSentences: 10,
      analysisIntervalSeconds: 60,
      audioDuration: 0,
      agentMessages: [],
      agentStatus: 'idle',
      agentConfig: options?.agentConfig || { agentType: 'hermes', profile: 'default' },
    }
    sessions.value.unshift(session)
    activeSessionId.value = session.id
    saveSessions(sessions.value, activeSessionId.value)
    return session
  }

  function updateSession(id: string, updates: Partial<MeetingSession>) {
    const index = sessions.value.findIndex(s => s.id === id)
    if (index === -1) return
    sessions.value[index] = {
      ...sessions.value[index],
      ...updates,
      updatedAt: Date.now(),
    }
    saveSessions(sessions.value, activeSessionId.value)
  }

  function deleteSession(id: string) {
    sessions.value = sessions.value.filter(s => s.id !== id)
    if (activeSessionId.value === id) {
      activeSessionId.value = sessions.value[0]?.id || null
    }
    saveSessions(sessions.value, activeSessionId.value)
    // 清理 IndexedDB 音频数据
    deleteAudioChunks(id).catch(err => console.warn('[meeting] deleteAudioChunks failed:', err))
  }

  function setActiveSession(id: string) {
    activeSessionId.value = id
  }

  function addSentence(sessionId: string, sentence: string | TranscriptSentence) {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    const newSentence: TranscriptSentence = typeof sentence === 'string'
      ? { text: sentence, timestamp: Date.now() }
      : sentence
    session.sentences.push(newSentence)
    session.updatedAt = Date.now()
    saveSessions(sessions.value, activeSessionId.value)
  }

  function updateSentence(sessionId: string, sentence: TranscriptSentence) {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    const index = session.sentences.findIndex(s => 
      s.startTime === sentence.startTime && 
      s.endTime === sentence.endTime &&
      s.text === sentence.text
    )
    if (index !== -1) {
      session.sentences[index] = { ...session.sentences[index], ...sentence }
      session.updatedAt = Date.now()
      saveSessions(sessions.value, activeSessionId.value)
    }
  }

  function updateAnalysis(sessionId: string, result: AnalysisResult) {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    session.analysisResult = result
    session.updatedAt = Date.now()
    saveSessions(sessions.value, activeSessionId.value)
  }

  function updateHtmlContent(sessionId: string, html: string) {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    session.htmlContent = html
    session.updatedAt = Date.now()
    saveSessions(sessions.value, activeSessionId.value)
  }

  function updateSpeakerMap(sessionId: string, speakerMap: Record<string, string>) {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    session.speakerMap = speakerMap
    session.updatedAt = Date.now()
    saveSessions(sessions.value, activeSessionId.value)
  }

  function updateStatus(sessionId: string, status: MeetingSession['status']) {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    session.status = status
    session.updatedAt = Date.now()
    saveSessions(sessions.value, activeSessionId.value)
  }

  function clearSession(sessionId: string) {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    session.sentences = []
    session.analysisResult = null
    session.htmlContent = ''
    session.speakerMap = {}
    session.speakers = []
    session.status = 'idle'
    session.audioDuration = 0
    session.updatedAt = Date.now()
    saveSessions(sessions.value, activeSessionId.value)
    // 清理 IndexedDB 音频数据
    deleteAudioChunks(sessionId).catch(err => console.warn('[meeting] deleteAudioChunks failed:', err))
  }

  // --- 音频 IndexedDB 操作 ---
  // 音频不实时落库：录音期间的 MediaRecorder 块只累积在 MeetingView 的
  // 内存 audioChunks 里，会议结束（stopRecording）时才一次性写入 IndexedDB
  // 并上传到服务端。这里只有读出和整段写入，没有逐块写入路径。

  async function saveAudioData(sessionId: string, blob: Blob) {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    // Direct path: caller (stopRecording) has the combined audio blob from
    // MediaRecorder. Wrap in a single-chunk array so the existing IDB schema
    // works without changes.
    await saveAudioChunks(sessionId, [
      { blob, timestamp: Date.now(), duration: session.audioDuration },
    ])
    saveSessions(sessions.value, activeSessionId.value)
  }

  async function getAudioBlob(sessionId: string): Promise<Blob | null> {
    const chunks = await loadAudioChunks(sessionId)
    if (chunks.length === 0) return null

    // Chunks stored as native Blobs — concatenate without re-decoding.
    // The Blob constructor accepts Blob[] directly and produces a single Blob
    // with the same content type, no base64 round-trip needed.
    return new Blob(chunks.map(c => c.blob), { type: chunks[0].blob.type || 'audio/webm' })
  }

  // --- 说话人管理 ---

  function renameSpeaker(sessionId: string, speakerId: string, displayName: string) {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return

    // 更新 speakers 列表
    const existing = session.speakers.find(s => String(s.id) === String(speakerId))
    if (existing) {
      existing.displayName = displayName
    } else {
      session.speakers.push({ id: speakerId, displayName })
    }

    // 同步更新 speakerMap
    session.speakerMap[speakerId] = displayName

    // 更新所有使用该 speakerId 的句子的 speaker 字段
    for (const sentence of session.sentences) {
      if (String(sentence.speakerId) === String(speakerId)) {
        sentence.speaker = displayName
      }
    }

    session.updatedAt = Date.now()
    saveSessions(sessions.value, activeSessionId.value)
  }

  function getSpeakerDisplayName(session: MeetingSession, speakerId: string): string {
    const entry = session.speakers.find(s => String(s.id) === String(speakerId))
    return entry?.displayName || speakerId
  }

  // ASR 配置
  const asrConfig = ref<ASRConfig>(loadASRConfig())

  const hasASRConfig = computed(() => {
    return !!asrConfig.value.dashscopeApiKey
  })

  const hasLLMConfig = computed(() => {
    return !!asrConfig.value.llmApiKey
  })

  function updateASRConfig(config: Partial<ASRConfig>) {
    asrConfig.value = { ...asrConfig.value, ...config }
    saveASRConfig(asrConfig.value)
  }

  // --- 服务端会议同步 (触摸屏设备端创建的会议) ---
  // 触摸屏 (keli) 把会议写入服务端 /api/studio/meeting-storage, Web UI 本地
  // localStorage 列表看不到这些会议; 这里把服务端会议合并进列表,
  // 让会议模式能直接点开查看触摸屏上启动的对话内容。
  async function syncSessionsFromServer(): Promise<void> {
    try {
      const ids = await meetingStorageApi.listMeetings()
      let added = 0
      for (const id of ids) {
        if (sessions.value.some(s => s.id === id)) continue
        const data = await meetingStorageApi.getMeeting(id)
        if (!data) continue
        const now = Date.now()
        sessions.value.push({
          id: data.id,
          title: data.title || '会议',
          createdAt: data.createdAt || now,
          updatedAt: data.updatedAt || now,
          useDiarize: !!data.useDiarize,
          sentences: data.sentences || [],
          analysisResult: data.analysisResult || null,
          htmlContent: data.htmlContent || '',
          speakerMap: data.speakerMap || {},
          speakers: data.speakers || [],
          status: data.status || 'completed',
          analysisMode: data.analysisMode || 'hermes',
          hermesProfile: data.hermesProfile,
          customProvider: data.customProvider,
          customModel: data.customModel,
          sceneTemplate: 'general',
          analysisRounds: [],
          analysisTriggerMode: 'sentences',
          analysisIntervalSentences: 10,
          analysisIntervalSeconds: 60,
          audioDuration: data.audioDuration || 0,
          agentMessages: [],
          agentStatus: 'idle',
          agentConfig: { agentType: 'hermes', profile: data.hermesProfile || 'default' },
        })
        added += 1
      }
      if (added > 0) {
        saveSessions(sessions.value, activeSessionId.value)
        console.log(`[meeting] 已从服务端同步 ${added} 个会议`)
      }
    } catch (err) {
      console.error('[meeting] 同步服务端会议失败:', err)
    }
  }

  return {
    sessions,
    activeSessionId,
    activeSession,
    sortedSessions,
    asrConfig,
    hasASRConfig,
    hasLLMConfig,
    createSession,
    updateSession,
    deleteSession,
    setActiveSession,
    addSentence,
    updateSentence,
    updateAnalysis,
    updateHtmlContent,
    updateSpeakerMap,
    updateStatus,
    clearSession,
    saveAudioData,
    getAudioBlob,
    renameSpeaker,
    getSpeakerDisplayName,
    updateASRConfig,
    syncSessionsFromServer,
  }
})
