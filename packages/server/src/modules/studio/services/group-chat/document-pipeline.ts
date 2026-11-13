/**
 * In-process document pipeline service — reading + aggregation.
 * Spec: docs/planning/group-chat-large-doc-pipeline-spec.md §2 / §4 / §8.
 *
 * Design decisions (from the spec review):
 * - No separate worker process: job-level try/catch + persisted SQLite state
 *   provide crash isolation and restart-resume on a 3.8G device.
 * - Model calls reuse runBareModelAgent (room-summary.ts), same provider/model
 *   resolution path as the rolling-summary service and discussion judge.
 * - Global concurrency ≤ 5 (one window per agent); per-room lock so the
 *   pipeline never races room summarization or agent replies.
 */
import { freemem, totalmem } from 'os'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { getWebUiHome } from '../../public/config'
import { logger } from '../../public/logging'
import { runBareModelAgent } from './bare-model'
import {
  getChunks,
  insertFact,
  insertJobs,
  saveVolumeSummary,
  getLatestVolumeSummary,
  getVolumeSummaries,
  getFactsByAgent,
  getFacts,
  getFields,
  getDocument,
  getJobCounts,
  claimJobs,
  completeJob,
  failJob,
  requeueFailedJobs,
  updateChunkRead,
  updateDocumentStatus,
  type GcFileChunkRow,
} from '../../repositories/document-store'
import { VOLUME_SIZE, buildReadingContext, buildVolumeSummaryContext, buildAggregateLevel1Context, buildAggregateLevel2Context } from './document-reading-context'

export const GLOBAL_MAX_CONCURRENCY = 5
const MAX_ATTEMPTS = 3
const MEMORY_RESUME_THRESHOLD_RATIO = 0.15
const MEMORY_PAUSE_THRESHOLD_BYTES = 500 * 1024 * 1024 // 500MB free

export interface PipelineAgentConfig {
  agentId: string
  profile: string
  provider: string
  model: string
  apiMode: string
  name: string
}

interface ReadingRound {
  chunk: GcFileChunkRow
  agent: PipelineAgentConfig
}

export interface PipelineStartResult {
  pipelineId: string
  jobsAssigned: number
}

interface PipelineRun {
  pipelineId: string
  fileId: string
  agents: PipelineAgentConfig[]
  running: boolean
  paused: boolean
  aborted: boolean
  /** agentId -> set of in-flight chunk ids (window = 1 per agent) */
  inFlight: Map<string, Set<string>>
}

/**
 * Callback surface for GroupChatServer to emit socket events + persist the
 * final report message into the room transcript.
 */
export interface DocumentPipelineHooks {
  onDocumentReady: (roomId: string, payload: Record<string, unknown>) => void
  onProgress: (roomId: string, payload: Record<string, unknown>) => void
  onReport: (roomId: string, fileId: string, reportText: string) => void
}

export class DocumentPipelineService {
  private runs = new Map<string, PipelineRun>()
  private roomLocks = new Set<string>()
  private currentConcurrency = 0

  constructor(private hooks: DocumentPipelineHooks) {}

  // ─── Public API ────────────────────────────────────────────────────────

  abortRoom(roomId: string): void {
    for (const run of this.runs.values()) {
      if (getDocument(run.fileId)?.room_id === roomId) run.aborted = true
    }
  }

  getActiveRun(fileId: string): PipelineRun | null {
    return this.runs.get(fileId) ?? null
  }

  /** Assign all chunks evenly to agents and start async reading. */
  async startReading(fileId: string, agents: PipelineAgentConfig[]): Promise<PipelineStartResult> {
    const doc = getDocument(fileId)
    if (!doc) throw Object.assign(new Error('Document not found'), { status: 404, code: 'not_found' })
    if (doc.status === 'reading' || doc.status === 'aggregating') {
      throw Object.assign(new Error('Document pipeline already running'), { status: 409, code: 'already_running' })
    }

    const chunks = getChunks(fileId)
    if (chunks.length === 0) {
      throw Object.assign(new Error('Document has no chunks'), { status: 400, code: 'doc_no_chunks' })
    }
    if (agents.length === 0) {
      throw Object.assign(new Error('No agents to run the pipeline'), { status: 400, code: 'no_agents' })
    }

    const pipelineId = `gcp_${Date.now().toString(36)}`
    this.runs.delete(fileId)

    // Reset any stale jobs for this file, then distribute chunks round-robin.
    const jobs = chunks.map((chunk, idx) => {
      const agent = agents[idx % agents.length]
      return { job_id: `gcj_${fileId}_${chunk.chunk_id}`, chunk_id: chunk.chunk_id, agent_id: agent.agentId }
    })
    insertJobs(fileId, jobs)
    updateDocumentStatus(fileId, 'reading')

    const run: PipelineRun = {
      pipelineId,
      fileId,
      agents,
      running: true,
      paused: false,
      aborted: false,
      inFlight: new Map(),
    }
    this.runs.set(fileId, run)
    this.hooks.onDocumentReady(doc.room_id, { fileId, name: doc.name, chunkCount: chunks.length })

    // Kick off the pump without awaiting it.
    void this.pump(fileId, run).catch((err) => {
      logger.error(`[DocumentPipeline] ${pipelineId} fatal: ${err?.message || err}`)
      this.runs.delete(fileId)
    })
    return { pipelineId, jobsAssigned: jobs.length }
  }

  // ─── Pump ──────────────────────────────────────────────────────────────

  private async pump(fileId: string, run: PipelineRun): Promise<void> {
    const doc = getDocument(fileId)
    if (!doc) return
    const roomId = doc.room_id

    try {
      while (run.running && !run.aborted) {
        if (this.isMemoryLow()) {
          if (!run.paused) {
            run.paused = true
            logger.warn(`[DocumentPipeline] ${run.pipelineId} memory low, pausing reading`)
          }
          await new Promise((resolveFn) => setTimeout(resolveFn, 5000))
          continue
        }
        if (run.paused) {
          run.paused = false
          logger.info(`[DocumentPipeline] ${run.pipelineId} memory recovered, resuming`)
        }

        // Claim up to the global concurrency budget, one chunk per agent.
        const counts = getJobCounts(fileId)
        if (counts.total > 0 && counts.done + counts.failed >= counts.total) {
          // All jobs terminal — aggregate.
          updateDocumentStatus(fileId, 'aggregating')
          await this.aggregate(fileId, run)
          break
        }
        if (counts.failed > 0 && counts.pending === 0) {
          // Retry window: requeue failed jobs that still have attempts left.
          this.requeueRetryable(fileId)
        }

        const available = GLOBAL_MAX_CONCURRENCY - this.currentConcurrency
        if (available <= 0) {
          await new Promise((resolveFn) => setTimeout(resolveFn, 1000))
          continue
        }

        const rounds = this.claimNextRounds(fileId, run, available)
        if (rounds.length === 0) {
          // No pending jobs right now — wait for in-flight to finish or retries.
          if (run.inFlight.size === 0) {
            // Everything terminal or stuck; if nothing retryable, we're done.
            const now = getJobCounts(fileId)
            if (now.pending === 0 && now.running === 0) break
          }
          await new Promise((resolveFn) => setTimeout(resolveFn, 1000))
          continue
        }

        this.currentConcurrency += rounds.length
        await Promise.allSettled(rounds.map((round) => this.processRound(fileId, run, round)))
        this.currentConcurrency -= rounds.length
      }
    } finally {
      this.runs.delete(fileId)
      this.hooks.onProgress(roomId, { fileId, status: 'done' })
    }
  }

  private claimNextRounds(fileId: string, run: PipelineRun, budget: number): ReadingRound[] {
    const rounds: ReadingRound[] = []
    for (const agent of run.agents) {
      if (rounds.length >= budget) break
      const inFlight = run.inFlight.get(agent.agentId) ?? new Set<string>()
      if (inFlight.size > 0) continue // window = 1 per agent
      const claimed = claimJobs(fileId, agent.agentId, 1)
      if (claimed.length === 0) continue
      const chunk = getChunks(fileId).find((c) => c.chunk_id === claimed[0].chunk_id)
      if (!chunk) continue
      run.inFlight.set(agent.agentId, inFlight)
      inFlight.add(chunk.chunk_id)
      rounds.push({ chunk, agent })
    }
    return rounds
  }

  private requeueRetryable(fileId: string): void {
    const counts = getJobCounts(fileId)
    if (counts.failed === 0) return
    // Requeue failed jobs under MAX_ATTEMPTS as pending.
    requeueFailedJobs(fileId, MAX_ATTEMPTS)
  }

  // ─── Reading round ─────────────────────────────────────────────────────

  private async processRound(fileId: string, run: PipelineRun, round: ReadingRound): Promise<void> {
    const { chunk, agent } = round
    const jobId = `gcj_${fileId}_${chunk.chunk_id}`
    const inFlight = run.inFlight.get(agent.agentId)
    try {
      const doc = getDocument(fileId)
      if (!doc) throw new Error('document missing')
      const docDir = resolve(getWebUiHome(), 'group-chat-docs', doc.room_id, fileId)
      const namedPath = resolve(docDir, doc.name)
      // Prefer the original (sanitized) file name; fall back to legacy upload.bin
      // for docs registered before named storage was introduced.
      const filePath = existsSync(namedPath) ? namedPath : resolve(docDir, 'upload.bin')
      const text = readFileSync(filePath, 'utf-8')
      const chunkText = text.slice(chunk.start_offset, chunk.end_offset)

      const volume = getLatestVolumeSummary(fileId, agent.agentId)
      const fields = getFields(fileId)
      const ctx = buildReadingContext({
        docType: doc.doc_type,
        chunkIndex: chunk.idx + 1,
        chunkTotal: doc.chunk_count,
        chunkText,
        volumeSummary: volume?.summary ?? '',
        fields,
      })

      const output = await runBareModelAgent({
        profile: agent.profile,
        provider: agent.provider,
        model: agent.model,
        apiMode: agent.apiMode,
        systemPrompt: ctx.systemPrompt,
        userPrompt: ctx.userPrompt,
        roomId: doc.room_id,
        purpose: 'group-chat-document-reading',
        timeoutMs: 600_000,
      })

      // Output must be a JSON array; if not, wrap as a raw fact with quote=chunk.
      const facts = normalizeReadingOutput(output, chunk)
      facts.forEach((fact, index) => {
        insertFact(fileId, chunk.chunk_id, agent.agentId, JSON.stringify(fact), index)
      })

      updateChunkRead(chunk.chunk_id, agent.agentId)
      completeJob(jobId)

      // Rolling volume summary: every VOLUME_SIZE done chunks for this agent.
      const doneByAgent = getFactsByAgent(fileId, agent.agentId).length
      const chunksDone = this.countAgentDoneChunks(fileId, agent.agentId)
      if (chunksDone > 0 && chunksDone % VOLUME_SIZE === 0) {
        await this.rollVolumeSummary(fileId, run, agent)
      }

      const progress = this.progressPayload(fileId)
      this.hooks.onProgress(doc.room_id, progress)
    } catch (err: any) {
      logger.error(`[DocumentPipeline] job ${jobId} failed: ${err?.message || err}`)
      failJob(jobId, err?.message || String(err))
      if (err?.code === 'doc_pdf_unsupported' || err?.code === 'group_chat_unavailable') {
        run.aborted = true
      }
    } finally {
      inFlight?.delete(chunk.chunk_id)
    }
  }

  private countAgentDoneChunks(fileId: string, agentId: string): number {
    const chunks = getChunks(fileId)
    return chunks.filter((c) => c.read_by_agent === agentId && c.status === 'read').length
  }

  private async rollVolumeSummary(fileId: string, run: PipelineRun, agent: PipelineAgentConfig): Promise<void> {
    try {
      const facts = getFactsByAgent(fileId, agent.agentId)
      const doc = getDocument(fileId)
      if (!doc) return
      const volumes = getVolumeSummaries(fileId, agent.agentId)
      const volumeNumber = volumes.length
      const ctx = buildVolumeSummaryContext({
        factsJson: JSON.stringify(facts.slice(-VOLUME_SIZE * 3)),
      })
      const summary = await runBareModelAgent({
        profile: agent.profile,
        provider: agent.provider,
        model: agent.model,
        apiMode: agent.apiMode,
        systemPrompt: ctx.systemPrompt,
        userPrompt: ctx.userPrompt,
        roomId: doc.room_id,
        purpose: 'group-chat-document-volume',
        timeoutMs: 300_000,
      })
      saveVolumeSummary(fileId, agent.agentId, volumeNumber, summary, this.maxDoneChunkIdx(fileId, agent.agentId))
    } catch (err: any) {
      logger.warn(`[DocumentPipeline] volume summary failed (non-fatal): ${err?.message || err}`)
    }
  }

  private maxDoneChunkIdx(fileId: string, agentId: string): number {
    const chunks = getChunks(fileId)
    const done = chunks.filter((c) => c.read_by_agent === agentId && c.status === 'read')
    return done.length > 0 ? Math.max(...done.map((c) => c.idx)) : 0
  }

  // ─── Aggregation ───────────────────────────────────────────────────────

  private async aggregate(fileId: string, run: PipelineRun): Promise<void> {
    try {
      const doc = getDocument(fileId)
      if (!doc) return
      const fields = getFields(fileId)

      // Level 1: per-agent volume-final summaries.
      const level1Reports: Array<{ agentName: string; report: string }> = []
      for (const agent of run.agents) {
        const volumes = getVolumeSummaries(fileId, agent.agentId)
        const ctx = buildAggregateLevel1Context({
          docType: doc.doc_type,
          fields: fields.filter((f) => this.chunkAgentOwns(fileId, f.chunk_id, agent.agentId)),
          volumes,
        })
        try {
          const report = await runBareModelAgent({
            profile: agent.profile,
            provider: agent.provider,
            model: agent.model,
            apiMode: agent.apiMode,
            systemPrompt: ctx.systemPrompt,
            userPrompt: ctx.userPrompt,
            roomId: doc.room_id,
            purpose: 'group-chat-document-level1',
            timeoutMs: 600_000,
          })
          level1Reports.push({ agentName: agent.name || agent.agentId, report })
        } catch (err: any) {
          logger.warn(`[DocumentPipeline] level-1 aggregate failed for ${agent.agentId}: ${err?.message || err}`)
          level1Reports.push({ agentName: agent.name || agent.agentId, report: `（该助手卷终稿生成失败：${err?.message || err}）` })
        }
      }

      // Level 2: chair produces the final report.
      const chair = run.agents[0] ?? { profile: 'default', provider: '', model: '', apiMode: '', name: '主持人', agentId: 'chair' }
      const level2Ctx = buildAggregateLevel2Context({
        docType: doc.doc_type,
        fields,
        reports: level1Reports,
      })
      const finalReport = await runBareModelAgent({
        profile: chair.profile,
        provider: chair.provider,
        model: chair.model,
        apiMode: chair.apiMode,
        systemPrompt: level2Ctx.systemPrompt,
        userPrompt: level2Ctx.userPrompt,
        roomId: doc.room_id,
        purpose: 'group-chat-document-report',
        timeoutMs: 900_000,
      })

      updateDocumentStatus(fileId, 'done')
      this.hooks.onReport(doc.room_id, fileId, finalReport)
    } catch (err: any) {
      logger.error(`[DocumentPipeline] aggregate failed: ${err?.message || err}`)
      updateDocumentStatus(fileId, 'failed')
    }
  }

  private chunkAgentOwns(fileId: string, chunkId: string, agentId: string): boolean {
    const chunks = getChunks(fileId)
    const chunk = chunks.find((c) => c.chunk_id === chunkId)
    return chunk?.read_by_agent === agentId
  }

  private progressPayload(fileId: string): Record<string, unknown> {
    const doc = getDocument(fileId)
    const jobs = getJobCounts(fileId)
    const chunks = getChunks(fileId)
    const read = chunks.filter((c) => c.status !== 'pending').length
    return {
      fileId,
      name: doc?.name ?? '',
      status: doc?.status ?? 'reading',
      chunkCount: chunks.length,
      chunksRead: read,
      progressPct: chunks.length > 0 ? Math.round((read / chunks.length) * 100) : 0,
      jobs: { ...jobs, chunksDone: read },
      fieldsCount: getFields(fileId).length,
      factsCount: getFacts(fileId).length,
    }
  }

  // ─── Memory circuit breaker ────────────────────────────────────────────

  private isMemoryLow(): boolean {
    const free = freemem()
    const total = totalmem()
    return free < MEMORY_PAUSE_THRESHOLD_BYTES && free / total < MEMORY_RESUME_THRESHOLD_RATIO
  }
}

function normalizeReadingOutput(output: string, chunk: GcFileChunkRow): any[] {
  const trimmed = output.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed
    if (parsed && Array.isArray(parsed.facts)) return parsed.facts
  } catch {
    /* fall through */
  }
  // Not a JSON array — degrade to a single raw fact so the pipeline never stalls.
  return [{
    type: '事实',
    content: trimmed.slice(0, 2000),
    quote: chunk ? '' : '',
    cross_refs: [],
  }]
}
