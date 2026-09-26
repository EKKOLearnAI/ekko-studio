import { randomUUID } from 'node:crypto'
import { noul, createJevSidecar, type JevSidecarAdapter, type JevSidecarTaskSpec } from '../../public/jev'
import { hashJevCanonical } from '../jev/sidecar-payload'
import type { JevSettings } from '../jev/settings'
import type { CleanGroupMessage, GroupRoomSummary } from './room-summary'

export type GroupSummaryReviewDecision = 'pass' | 'needs_improvement' | 'unknown'
export interface GroupSummaryRuleResult { id: string; decision: GroupSummaryReviewDecision; confidence?: number }
export interface GroupSummaryReviewRecord {
  id: string; roomId: string; sourceVersion: number; sourceSummaryHash: string; sourceAnchor: string
  sourceTurnCount: number; inputHash: string; configHash: string; status: 'completed' | 'skipped'
  decision: GroupSummaryReviewDecision; ruleResults: GroupSummaryRuleResult[]; reasonCode: string
  durationMs: number; createdAt: number; appliedRevisionVersion: number | null
}
export interface GroupSummaryReviewStorage {
  getRoom(roomId: string): any
  getRoomSummary(roomId: string): GroupRoomSummary | null
  getLatestSummaryReview(roomId: string): GroupSummaryReviewRecord | null
  applySummaryReviewOutcome(input: { record: GroupSummaryReviewRecord; revision?: {
    expected: { roomId: string; generation: number; version: number; summaryHash: string; anchor: string; turnCount: number }; nextText: string
  } }): boolean
}

export interface CommittedGroupSummary {
  previous: GroupRoomSummary
  summary: GroupRoomSummary
  messages: CleanGroupMessage[]
  profile: string
}

const RULES = [
  { id: 'missing_constraints', prompt: 'Does the candidate summary omit a hard constraint or unfinished task present in the supplied previous summary or messages?' },
  { id: 'stale_or_overstated', prompt: 'Does the candidate summary preserve an outdated conclusion, treat a proposal as a decision, or ignore a later explicit correction?' },
  { id: 'unsupported_completion', prompt: 'Does the candidate summary add an unsupported fact or present an unverified self-reported completion as verified?' },
] as const

export class GroupSummaryReviewService {
  private readonly sidecar
  constructor(
    private readonly storage: GroupSummaryReviewStorage,
    private readonly revise?: (input: CommittedGroupSummary) => Promise<string>,
    private readonly notify?: (roomId: string) => void,
  ) {
    const adapter: JevSidecarAdapter<{ record: GroupSummaryReviewRecord; revision?: { expected: { roomId: string; generation: number; version: number; summaryHash: string; anchor: string; turnCount: number }; nextText: string } }, boolean> = {
      integrationId: 'group-summary-review', policyVersion: '1', admissionCeilingMs: 30_000,
      maxJevCalls: 2, maxGenerationCalls: 1,
      parsePolicy: (settings: JevSettings) => ({ enabled: settings.groupSummaryReviewEnabled,
        budgetMs: settings.groupSummaryReviewTimeoutMs, policy: { minConfidence: settings.groupSummaryReviewMinConfidence } }),
      eligibility: () => ({ eligible: true }),
      readAuthority: async (ref, expected) => {
        const room = this.storage.getRoom(ref.object.id)
        const summary = this.storage.getRoomSummary(ref.object.id)
        if (!room || !summary) return { allowed: false, reason: 'object_deleted' }
        if ((room.summaryReviewMode || 'inherit') === 'off') return { allowed: false, reason: 'disabled' }
        const currentHash = summary.version === Number(expected.sourceKey.split(':').at(-1)) ? hashJevCanonical(summary.summary) : ''
        if (currentHash !== expected.sourceHash) return { allowed: false, reason: 'source_changed' }
        return { allowed: true }
      },
      apply: (_ref, _expected, request) => this.storage.applySummaryReviewOutcome(request),
    }
    this.sidecar = createJevSidecar({ adapters: [adapter], observe: () => undefined })
  }

  schedule(input: CommittedGroupSummary): void {
    const room = this.storage.getRoom(input.summary.roomId)
    if (!room || (room.summaryReviewMode || 'inherit') === 'off') return
    const sourceHash = hashJevCanonical(input.summary.summary)
    const state = { previous_summary: input.previous.summary, new_messages: input.messages.map(message => ({ ...message })), candidate_summary: input.summary.summary }
    const inputHash = hashJevCanonical({ version: 1, roomId: input.summary.roomId, sourceVersion: input.summary.version, state })
    const sourceKey = `group-summary:${input.summary.roomId}:${input.summary.version}`
    const task: JevSidecarTaskSpec<{ record: GroupSummaryReviewRecord; revision?: { expected: { roomId: string; generation: number; version: number; summaryHash: string; anchor: string; turnCount: number }; nextText: string } }, boolean> = {
      integrationId: 'group-summary-review', sourceKey, attemptId: inputHash, createdAt: Date.now(), input: state,
      identity: { actor: { type: 'room-owner', id: String(room.ownerAuthUserId || 'local') },
        authority: { type: 'room-profile', id: String(room.evaluationProfile || room.summaryProfile || input.profile) },
        profile: String(room.evaluationProfile || room.summaryProfile || input.profile), object: { type: 'group-room', id: input.summary.roomId } },
      expected: { sourceKey: `${sourceKey}:${input.summary.version}`, sourceHash },
      run: async ctx => {
        const snapshot = await ctx.snapshot(); if (snapshot.kind !== 'completed') return
        const questions = Object.fromEntries(RULES.map(rule => [rule.id, noul(rule.prompt)]))
        const evaluated = await ctx.evaluate(snapshot.value, { state, questions }, task.expected)
        if (evaluated.kind !== 'completed') return
        const threshold = Number(snapshot.value.policy.minConfidence || 0.8)
        const ruleResults: GroupSummaryRuleResult[] = RULES.map(rule => {
          const answer = evaluated.value.answers[rule.id]
          const confidence = answer?.type === 'noul' && typeof answer.noul === 'number' ? answer.noul : undefined
          return { id: rule.id, decision: confidence === undefined ? 'unknown' : confidence >= threshold ? 'needs_improvement' : 'pass', ...(confidence === undefined ? {} : { confidence }) }
        })
        let decision: GroupSummaryReviewDecision = ruleResults.some(item => item.decision === 'needs_improvement') ? 'needs_improvement'
          : ruleResults.some(item => item.decision === 'unknown') ? 'unknown' : 'pass'
        let revision: { expected: { roomId: string; generation: number; version: number; summaryHash: string; anchor: string; turnCount: number }; nextText: string } | undefined
        if (decision === 'needs_improvement' && Number(room.summaryRevisionEnabled || 0) === 1 && this.revise) {
          try {
            const revised = (await this.revise(input)).trim()
            if (revised && revised !== input.summary.summary.trim()) {
              const reevaluated = await ctx.evaluate(snapshot.value, { state: { ...state, candidate_summary: revised }, questions }, task.expected, 'reevaluate')
              if (reevaluated.kind === 'completed') {
                const revisionPasses = RULES.every(rule => {
                  const answer = reevaluated.value.answers[rule.id]
                  return answer?.type === 'noul' && typeof answer.noul === 'number' && answer.noul < threshold
                })
                if (revisionPasses) revision = { expected: { roomId: input.summary.roomId,
                  generation: Number(room.summaryGeneration || 0), version: input.summary.version, summaryHash: sourceHash,
                  anchor: input.summary.summaryThroughMessageId, turnCount: input.summary.summarizedTurnCount }, nextText: revised }
              }
            }
          } catch { /* optional revision preserves S0 */ }
        }
        const record: GroupSummaryReviewRecord = { id: randomUUID(), roomId: input.summary.roomId,
          sourceVersion: input.summary.version, sourceSummaryHash: sourceHash, sourceAnchor: input.summary.summaryThroughMessageId,
          sourceTurnCount: input.summary.summarizedTurnCount, inputHash, configHash: snapshot.value.configHash,
          status: 'completed', decision, ruleResults, reasonCode: '', durationMs: 0, createdAt: Date.now(),
          appliedRevisionVersion: revision ? input.summary.version + 1 : null }
        const stored = await ctx.apply(task.expected, { record, ...(revision ? { revision } : {}) })
        if (stored.kind === 'completed' && stored.value === true) this.notify?.(input.summary.roomId)
      },
    }
    this.sidecar.trySchedule(task)
  }
}
