import type { Questions, SystemOneRequest, SystemOneResult } from '@typesafe-ai/sdk'
import type { JevSettings } from './settings'

export type JevSidecarStage = 'evaluate' | 'revision_generate' | 'reevaluate' | 'apply'
export type JevSidecarReason =
  | 'disabled' | 'not_configured' | 'settings_unavailable' | 'configuration_changed'
  | 'queue_full' | 'queue_unavailable' | 'storage_unavailable' | 'storage_busy'
  | 'object_deleted' | 'profile_access_revoked' | 'requester_access_revoked'
  | 'requester_unverifiable' | 'authorization_unavailable' | 'source_changed' | 'superseded'
  | 'input_too_large' | 'invalid_input' | 'deadline_exceeded' | 'caller_cancelled'
  | 'provider_timeout' | 'provider_rate_limited' | 'provider_auth_failed' | 'provider_error'
  | 'invalid_result' | 'low_confidence' | 'insufficient_evidence' | 'no_candidates'
  | 'not_eligible' | 'no_match' | 'cas_conflict' | 'record_write_failed'

export interface JevSidecarDiagnostic {
  integrationId: string
  attemptId: string
  sourceKey: string
  stage: JevSidecarStage
  durationMs: number
  reason?: JevSidecarReason
  inputBytes?: number
  configHash?: string
}

export type JevSidecarOutcome<T> =
  | { kind: 'completed'; value: T; diagnostic: JevSidecarDiagnostic }
  | { kind: 'skipped'; reason: JevSidecarReason; terminal: boolean; diagnostic: JevSidecarDiagnostic }
  | { kind: 'cancelled'; reason: 'caller_cancelled'; terminal: true; diagnostic: JevSidecarDiagnostic }

export interface VerifiedActorRef { type: string; id: string }
export interface ProfileAuthorityRef { type: string; id: string }
export interface SourceIdentityRef { type: string; id: string }
export interface JevSidecarIdentityRef {
  actor: VerifiedActorRef
  authority: ProfileAuthorityRef
  profile: string
  object: SourceIdentityRef
}

export interface JevAuthorityExpectation {
  sourceKey: string
  sourceHash: string
  authorizationHash?: string
  candidateHash?: string
  policyHash?: string
  stageInputHash?: string
}

export type JevAuthorityDecision =
  | { allowed: true }
  | { allowed: false; reason: Extract<JevSidecarReason,
      'disabled' | 'settings_unavailable' | 'authorization_unavailable' | 'profile_access_revoked'
      | 'requester_access_revoked' | 'requester_unverifiable' | 'object_deleted' | 'source_changed' | 'superseded'> }

export interface JevSidecarPolicySnapshot {
  enabled: boolean
  budgetMs: number
  policy: Record<string, unknown>
}

export interface JevSidecarAdapter<ApplyRequest = unknown, ApplyResult = unknown> {
  integrationId: string
  policyVersion: string
  admissionCeilingMs: number
  maxJevCalls: number
  maxGenerationCalls: number
  parsePolicy(settings: Readonly<JevSettings>): JevSidecarPolicySnapshot
  eligibility(input: unknown): { eligible: true } | { eligible: false; reason: JevSidecarReason }
  readAuthority(
    ref: JevSidecarIdentityRef,
    expected: JevAuthorityExpectation,
    stage: JevSidecarStage,
    signal: AbortSignal,
  ): Promise<JevAuthorityDecision>
  apply?(ref: JevSidecarIdentityRef, expected: JevAuthorityExpectation, request: ApplyRequest): ApplyResult
}

export interface JevSnapshotHandle {
  readonly integrationId: string
  readonly configHash: string
  readonly policyVersion: string
  readonly policy: Readonly<Record<string, unknown>>
}

export type TrustedJevRequest<Q extends Questions = Questions> = SystemOneRequest<Q>
export type ValidatedJevResult<Q extends Questions = Questions> = SystemOneResult<Q>

export interface JevSidecarTaskContext<ApplyRequest = unknown, ApplyResult = unknown> {
  snapshot(): Promise<JevSidecarOutcome<JevSnapshotHandle>>
  evaluate<Q extends Questions>(
    handle: JevSnapshotHandle,
    request: TrustedJevRequest<Q>,
    expected: JevAuthorityExpectation,
    stage?: 'evaluate' | 'reevaluate',
  ): Promise<JevSidecarOutcome<ValidatedJevResult<Q>>>
  apply(
    expected: JevAuthorityExpectation,
    request: ApplyRequest,
  ): Promise<JevSidecarOutcome<ApplyResult>>
}

export interface JevSidecarTaskSpec<ApplyRequest = unknown, ApplyResult = unknown> {
  integrationId: string
  identity: JevSidecarIdentityRef
  expected: JevAuthorityExpectation
  sourceKey: string
  attemptId: string
  createdAt: number
  parentDeadlineAt?: number
  signal?: AbortSignal
  input: unknown
  run(ctx: JevSidecarTaskContext<ApplyRequest, ApplyResult>): Promise<void>
}

export type JevScheduleReceipt =
  | { status: 'accepted' }
  | { status: 'duplicate' }
  | { status: 'skipped'; reason: JevSidecarReason }

export interface JevSidecarStatus {
  queued: number
  logicalActive: number
  physicalReads: number
  physicalRequests: number
  closed: boolean
}
