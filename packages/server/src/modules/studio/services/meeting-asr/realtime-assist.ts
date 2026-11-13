import type { Server, Namespace } from 'socket.io'
import { logger } from '../../public/logging'
import { authenticateUserToken } from '../../public/auth'
import { getSceneTemplateOrDefault } from './scene-templates'
import { getActiveProfileName } from '../../public/profile-config'
import { streamAgentReport } from './agent-bridge'
import { analyzeViaDirectLLM, streamDirectLLMReport } from './direct-llm'
import { annotateTranscriptSpeakers, resolveDominantSpeaker, type AnalysisRound, type SpeechContext } from './report-parser'
export { parseAnalysisRound as parseAnalysisResponse } from './report-parser'
export type { AnalysisRound, SpeechContext, GoldenQuote, GrammarIssue, FillerWord } from './report-parser'

/** 服务端累积的演讲评价摘要：跨批次保留，注入后续提示词，供 AI 判断是否出现新的评价点。 */
interface SpeechSummary {
  highlights: string[]
  improvements: string[]
  topics: string[]
  score?: Record<string, number>
}

interface TranscriptSentence {
  speaker?: string
  text: string
  timestamp?: number
}

interface ActiveSession {
  sessionId: string
  ownerUserId: number
  sceneTemplate: string
  profile?: string
  speechContext?: SpeechContext | null
  speechSummary?: SpeechSummary
  buffer: TranscriptSentence[]
  timer: NodeJS.Timeout | null
  isAnalyzing: boolean
}

const WINDOW_SIZE = 5
const WINDOW_INTERVAL_MS = 18_000
const NAMESPACE = '/meeting-assist'

function meetingRoom(ownerUserId: number, sessionId: string): string {
  return `meeting:${ownerUserId}:${sessionId}`
}

function isMeetingSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

/**
 * Sentinel yielded by `generateReportStream` to signal "agent path failed, now
 * switching to direct LLM fallback — discard any partial content received so far".
 *
 * Streamed as an internal token only. `streamReport` translates it into an
 * SSE frame of shape `{ fallback: true }`, which the client recognizes and
 * clears its `reportMarkdown` accumulator before rendering new chunks.
 *
 * Lives at module scope so the controller (`meeting-asr.ts#streamReport`)
 * and the service generator agree on a single source of truth.
 */
export const REPORT_FALLBACK_MARKER = Symbol.for('meeting-assist.report.fallback')

function safeActiveProfileName(): string {
  try {
    return getActiveProfileName()
  } catch {
    return ''
  }
}

/**
 * Socket 房间绑定 + 会话生命周期编排（v0.8 模块化拆分后的编排层）。
 *
 * 职责边界：
 *   - 本文件：socket namespace 注册、会话 buffer/计时器、批次触发节奏、
 *     报告生成的 agent→direct-LLM fallback 编排。
 *   - agent-bridge.ts：一切经过 Hermes Agent bridge 的调用。
 *   - direct-llm.ts：一切直调 OpenAI 兼容端点的请求（含 config.json 读取）。
 *   - report-parser.ts：LLM 输出 → AnalysisRound 的解析与裁剪。
 */
class RealtimeAssistService {
  private io: Server | null = null
  private nsp: Namespace | null = null
  private sessions = new Map<string, ActiveSession>()

  init(io: Server): void {
    this.io = io
    this.nsp = io.of(NAMESPACE)

    this.nsp.use(async (socket, next) => {
      try {
        const user = await authenticateUserToken(String(socket.handshake.auth?.token || ''))
        if (user) {
          socket.data.meetingUserId = user.id
          next()
          return
        }
      } catch {
        // Reject the connection if authentication cannot be verified.
      }
      next(new Error('Authentication failed'))
    })

    this.nsp.on('connection', (socket) => {
      socket.on('join', (sessionId: unknown, acknowledge?: (ok: boolean) => void) => {
        if (!isMeetingSessionId(sessionId)) {
          if (typeof acknowledge === 'function') acknowledge(false)
          return
        }
        void Promise.resolve(socket.join(meetingRoom(socket.data.meetingUserId, sessionId)))
          .then(() => { if (typeof acknowledge === 'function') acknowledge(true) })
          .catch(() => { if (typeof acknowledge === 'function') acknowledge(false) })
      })
      socket.on('leave', (sessionId: unknown) => {
        if (isMeetingSessionId(sessionId)) void socket.leave(meetingRoom(socket.data.meetingUserId, sessionId))
      })
    })

    logger.info('[meeting-assist] namespace registered: %s', NAMESPACE)
  }

  async startSession(sessionId: string, sceneTemplate: string, profile?: string, speechContext?: SpeechContext, ownerUserId = 0): Promise<void> {
    const key = meetingRoom(ownerUserId, sessionId)
    if (this.sessions.has(key)) {
      logger.info('[meeting-assist] session %s already active, resetting buffer', sessionId)
      this.stopSession(sessionId, ownerUserId)
    }

    this.sessions.set(key, {
      sessionId,
      ownerUserId,
      sceneTemplate,
      profile,
      speechContext: speechContext || null,
      buffer: [],
      timer: null,
      isAnalyzing: false,
    })

    logger.info('[meeting-assist] session started: %s (scene: %s, profile: %s)', sessionId, sceneTemplate, profile || '(active)')
  }

  /** 更新会话的演讲评分上下文（计时记录、每日一词等），后续分析批次会带上最新数据。 */
  updateSpeechContext(sessionId: string, speechContext: SpeechContext, ownerUserId = 0): void {
    const session = this.sessions.get(meetingRoom(ownerUserId, sessionId))
    if (!session) return
    session.speechContext = speechContext
  }

  /** 立即触发一次分析（忽略窗口大小/间隔计时），供"开始分析"按钮使用。 */
  flushNow(sessionId: string, ownerUserId = 0): void {
    const session = this.sessions.get(meetingRoom(ownerUserId, sessionId))
    if (!session) return
    void this.flush(session)
  }

  stopAllSessions(): void {
    for (const session of this.sessions.values()) this.stopSession(session.sessionId, session.ownerUserId)
    this.io = null
    this.nsp = null
  }

  stopSession(sessionId: string, ownerUserId = 0): void {
    const session = this.sessions.get(meetingRoom(ownerUserId, sessionId))
    if (!session) return

    if (session.timer) {
      clearTimeout(session.timer)
      session.timer = null
    }
    session.buffer = []
    this.sessions.delete(meetingRoom(ownerUserId, sessionId))
    logger.info('[meeting-assist] session stopped: %s', sessionId)
  }

  pushSentence(sessionId: string, sentence: TranscriptSentence, ownerUserId = 0): void {
    const session = this.sessions.get(meetingRoom(ownerUserId, sessionId))
    if (!session) return

    session.buffer.push(sentence)

    // Flush when buffer reaches window size
    if (session.buffer.length >= WINDOW_SIZE) {
      void this.flush(session)
      return
    }

    // Otherwise set/reset interval timer
    if (!session.timer) {
      session.timer = setTimeout(() => {
        session.timer = null
        void this.flush(session)
      }, WINDOW_INTERVAL_MS)
    }
  }

  private async flush(session: ActiveSession): Promise<void> {
    if (session.isAnalyzing) return
    if (session.buffer.length === 0) return

    if (session.timer) {
      clearTimeout(session.timer)
      session.timer = null
    }

    const sentences = session.buffer.splice(0)
    session.isAnalyzing = true

    // Notify clients that analysis is in progress
    this.nsp?.to(meetingRoom(session.ownerUserId, session.sessionId)).emit('analyzing', true)

    try {
      const round = await this.analyzeBatch(sentences, session.sceneTemplate, session.profile, session.speechContext, session.speechSummary)
      if (round) {
        // 演讲评分场景：把本轮新增的亮点/改进点/主题/评分累积进会话摘要，供下一批提示词使用
        this.accumulateSpeechSummary(session, round)
        this.nsp?.to(meetingRoom(session.ownerUserId, session.sessionId)).emit('analysis', round)
      }
    } catch (err) {
      logger.error(err, '[meeting-assist] analysis failed for session %s', session.sessionId)
      this.nsp?.to(meetingRoom(session.ownerUserId, session.sessionId)).emit('error', String(err))
    } finally {
      session.isAnalyzing = false
      this.nsp?.to(meetingRoom(session.ownerUserId, session.sessionId)).emit('analyzing', false)
    }
  }

  /** 将本轮演讲评分的新增内容合并进会话摘要（去重），供后续批次判断"是否出现新的评价点"。 */
  private accumulateSpeechSummary(session: ActiveSession, round: AnalysisRound): void {
    if (session.sceneTemplate !== 'speech') return
    const summary = session.speechSummary || { highlights: [], improvements: [], topics: [] }
    const pushUnique = (list: string[] | undefined, target: string[]) => {
      for (const item of list || []) {
        const s = item?.trim()
        if (s && !target.includes(s)) target.push(s)
      }
    }
    pushUnique(round.highlights, summary.highlights)
    pushUnique(round.improvements, summary.improvements)
    pushUnique(round.topics, summary.topics)
    if (round.score && Object.keys(round.score).length > 0) {
      summary.score = round.score
    }
    session.speechSummary = summary
  }

  private async analyzeBatch(
    sentences: TranscriptSentence[],
    sceneTemplateId: string,
    profile?: string,
    speechContext?: SpeechContext | null,
    speechSummary?: SpeechSummary,
  ): Promise<AnalysisRound | null> {
    const template = getSceneTemplateOrDefault(sceneTemplateId)
    // 转写句子按环节-演讲者时间线标注真实姓名（替换"说话人1"等声纹名），
    // 让 LLM 的赘语/金句/语法归属与计时员记录的环节/演讲者一致。
    const annotated = annotateTranscriptSpeakers(sentences, speechContext?.speakerTimeline)
    const transcriptText = annotated
      .map(s => `${s.speaker ? `[${s.speaker}] ` : ''}${s.text}`)
      .join('\n')

    const resolvedProfile = (profile || safeActiveProfileName() || 'default').trim() || 'default'

    // 实时提示始终走直调 LLM 快速路径（~3s），不走 Agent。
    // Agent + MCP 工具查询仅用于报告生成（需要真实法条/数据核实的深度分析）。
    // 演讲评分场景：speechSummary（已累积亮点/改进点/主题/评分）随批次注入提示词。
    const round = await analyzeViaDirectLLM(transcriptText, template, resolvedProfile, speechContext, speechSummary)
    if (round) {
      // 主导演讲者由批次内已标注句子确定性推导（非 LLM 输出）：
      // 多演讲者场景客户端据此把评分/亮点/提升点按演讲者分组。
      const dominant = resolveDominantSpeaker(annotated)
      if (dominant) round.speaker = dominant
    }
    return round
  }

  /**
   * Generate final report using streaming. Returns an async generator of text chunks.
   *
   * 优先经过 Hermes Agent，这样可以复用用户为该 profile 训练好的系统提示词、技能与记忆；
   * 当 bridge 不可用或尚未产出任何内容时，自动回退到直调 LLM，用户无感知。
   */
  async *generateReportStream(sessionId: string, transcript: string, sceneTemplateId: string, profile?: string): AsyncGenerator<string | typeof REPORT_FALLBACK_MARKER> {
    const template = getSceneTemplateOrDefault(sceneTemplateId)
    const resolvedProfile = (profile || safeActiveProfileName() || 'default').trim() || 'default'

    let yieldedAny = false
    let partialFromAgent = ''
    let agentError: unknown = null
    logger.info('[meeting-assist] generateReportStream start: session=%s template=%s profile=%s transcript_len=%d',
      sessionId, template.id, resolvedProfile, transcript.length)
    try {
      for await (const chunk of streamAgentReport(sessionId, transcript, template, resolvedProfile)) {
        yieldedAny = true
        partialFromAgent += chunk
        yield chunk
      }
      logger.info('[meeting-assist] agent path completed cleanly: %d chars', partialFromAgent.length)
      return
    } catch (err) {
      agentError = err
      const reason = err instanceof Error ? err.message : String(err)
      if (yieldedAny) {
        // A+C 方案：agent 已流出部分内容但中途失败（典型：provider SSE 中断）。
        // 之前的行为：直接抛错 → 用户看到错误报告 → 必须重录。
        // 现在的行为：放弃已流出部分，强制回退到 direct LLM 重新生成整份报告。
        // 风险：理论上"半截 agent 输出 + 完整 LLM 输出"会让 markdown 不一致，但
        // （a）前端 UI 的 reportMarkdown.value 在收到 fallback 标记后会被清空，
        // （b）用户拿到一份完整报告 > 用户看到错误。
        // 见 streamReport + MeetingAgentPanel 对应处理。
        logger.warn(
          '[meeting-assist] agent path produced %d chars then failed mid-stream (%s); discarding partial and falling back to direct LLM',
          partialFromAgent.length, reason,
        )
      } else {
        logger.warn('[meeting-assist] agent report path unavailable, falling back to direct LLM: %s', reason)
      }
    }

    // 这里有两种情形：
    //   (1) agent 从未 yield（yieldedAny=false）→ 直接走 fallback
    //   (2) agent yield 过部分内容又失败 → 仍走 fallback，但需要告诉前端清空旧内容
    //
    // 设计：在 yield 一个特殊 "fallback marker" 之后才让 LLM chunks 流出。
    // 用一个不可能与 LLM 输出混淆的格式：流控制用单独的 sentinel 字段。
    // 详见 streamReport controller，它会把 sentinel 翻译成 SSE 帧 { fallback: true }。
    yield REPORT_FALLBACK_MARKER
    logger.info('[meeting-assist] falling back to direct LLM path')
    try {
      let fallbackYielded = 0
      for await (const chunk of streamDirectLLMReport(transcript, template, resolvedProfile)) {
        fallbackYielded++
        yield chunk
      }
      logger.info('[meeting-assist] direct LLM path completed: %d chars', fallbackYielded)
      if (fallbackYielded === 0) {
        // fallback 路径也返回空内容（典型：provider 也抽风）。
        // 抛出与 agent 同样的错误，让上游 catch 写出 error 帧。
        throw agentError instanceof Error
          ? agentError
          : new Error('Direct LLM fallback produced no output')
      }
    } catch (fallbackErr) {
      const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
      logger.warn('[meeting-assist] direct LLM path failed: %s', fallbackMsg)
      // fallback 也失败：合并两次错误信息，原始 agent 错误在前（更接近根因）。
      const agentMsg = agentError instanceof Error ? agentError.message : String(agentError)
      const merged = new Error(`agent: ${agentMsg} | fallback: ${fallbackMsg}`)
      merged.name = 'ReportStreamBothFailed'
      throw merged
    }
  }
}

export const realtimeAssistService = new RealtimeAssistService()
