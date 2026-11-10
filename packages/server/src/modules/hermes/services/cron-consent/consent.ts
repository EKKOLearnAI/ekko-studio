import { randomUUID } from 'crypto'
import type { AuthenticatedUser, RequestCredentialKind } from '../../../studio/public/auth'
import { consentAccountAllowed, consentSessionView } from '../../../studio/public/cron-consent'
import { authorizeNoticeDestination } from '../../../studio/public/cron-session-bindings'
import {
  CronBindingError,
  executeAgentBinding,
  prepareAgentBinding,
  type AgentBindingPlan,
} from '../cron-session-bindings/bind'
import {
  defaultCronRunner,
  EnrollmentError,
  executeAdoption,
  executeNewEnrollment,
  prepareAdoption,
  prepareNewEnrollment,
  type AdoptionDeps,
  type AdoptionPlan,
  type HermesCronRunner,
  type NewEnrollmentPlan,
} from '../script-reports/enrollment'

/**
 * Common admission for model-initiated cron result delivery into a Studio session.
 *
 * A runtime credential may only REQUEST: it names a server-created authority (a live turn context,
 * or a context the user prepared while logged in) and an operation, which is validated and frozen.
 * Only the same account, with an interactive login credential, can approve or deny it; approval
 * executes exactly the frozen plan through the existing executors. State is in memory only: a
 * restart drops every prepared and pending entry (fails closed).
 *
 * Boundary: the ordinary runtime credential is account-wide by existing architecture. Any valid
 * context of the same account (another session or profile it can use) can therefore be named; the
 * request then visibly targets that context's session and still needs that account's login approval.
 * This is not cryptographic isolation between one account's sessions.
 *
 * Cross-session delivery: an optional `target_session_id` names another session of the same account
 * and profile. The context stays the origin authority (its session shows the card and holds the
 * request); the target is frozen separately and must be attributed to the requesting account.
 */

export const CONSENT_TTL_MS = 10 * 60_000
const MAX_PENDING_PER_SESSION = 5
const MAX_PREPARED_PER_SESSION = 3
const MAX_ENTRIES = 500
const PROMPT_PREVIEW_CHARS = 1000
/** Fields that would let a caller choose the destination; the authority decides it. */
const DESTINATION_OVERRIDES = ['session_id', 'sessionId', 'expected_session_generation', 'session_generation', 'account_id', 'user_id']
/** Credentials that may ask; approval always requires `login`. */
const REQUEST_CREDENTIALS: ReadonlySet<RequestCredentialKind> = new Set(['model_run', 'login'])

export class ConsentError extends Error {
  constructor(readonly status: number, readonly code: string, readonly detail?: string) {
    super(code)
  }
}

export type ConsentKind = 'script_report_enrollment' | 'cron_session_binding'

export interface ConsentAuthority {
  accountId: number
  profile: string
  sessionId: string
  generation: string
  contextKind: 'turn' | 'prepared'
}

type ConsentOperation =
  | { kind: 'script_report_enrollment'; plan: NewEnrollmentPlan | AdoptionPlan }
  | { kind: 'cron_session_binding'; plan: AgentBindingPlan }

interface PreparedContext {
  id: string
  authority: ConsentAuthority
  expiresAt: number
}

/** A frozen delivery session other than the origin; it never holds the request. */
interface ConsentTarget {
  sessionId: string
  generation: string
}

interface PendingConsent {
  id: string
  authority: ConsentAuthority
  /** Null: results go to the origin session (the same-session contract). */
  target: ConsentTarget | null
  operation: ConsentOperation
  display: Record<string, unknown>
  createdAt: number
  expiresAt: number
}

export interface ConsentDeps {
  /** Live turn context → its session and the account that started the turn. Throws when invalid. */
  turnAuthority: (contextId: string, profile: string) => { sessionId: string; accountId: number }
  /** Content-free refresh hint for the session's clients. */
  publish: (sessionId: string) => void
  /** The real issuer of the ordinary MCP runtime credential for this account and profile. */
  issueRuntimeCredential: (user: AuthenticatedUser, profile: string) => Promise<void>
  runner?: HermesCronRunner
  adoption?: Omit<AdoptionDeps, 'runner'>
}

const sameSession = (a: ConsentAuthority, b: ConsentAuthority) =>
  a.accountId === b.accountId && a.profile === b.profile && a.sessionId === b.sessionId

export class CronConsentStore {
  private readonly prepared = new Map<string, PreparedContext>()
  private readonly pending = new Map<string, PendingConsent>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  private sweep(): void {
    const now = this.now()
    for (const [id, entry] of this.prepared) if (entry.expiresAt <= now) this.prepared.delete(id)
    for (const [id, entry] of this.pending) if (entry.expiresAt <= now) this.pending.delete(id)
  }

  private assertCapacity(authority: ConsentAuthority, phase: 'prepared' | 'pending'): void {
    this.sweep()
    if (this.prepared.size + this.pending.size >= MAX_ENTRIES) throw new ConsentError(429, 'consent_capacity')
    const entries: Array<{ authority: ConsentAuthority }> = [...(phase === 'prepared' ? this.prepared : this.pending).values()]
    const limit = phase === 'prepared' ? MAX_PREPARED_PER_SESSION : MAX_PENDING_PER_SESSION
    if (entries.filter(entry => sameSession(entry.authority, authority)).length >= limit) throw new ConsentError(429, 'consent_capacity')
  }

  /** One live setup context per account and session: a new one replaces any unused earlier one. */
  prepare(authority: ConsentAuthority): PreparedContext {
    for (const [id, entry] of this.prepared) if (sameSession(entry.authority, authority)) this.prepared.delete(id)
    this.assertCapacity(authority, 'prepared')
    const entry = { id: randomUUID(), authority, expiresAt: this.now() + CONSENT_TTL_MS }
    this.prepared.set(entry.id, entry)
    return entry
  }

  /** A live prepared context; never consumed by a lookup. */
  peekPrepared(id: string): PreparedContext | undefined {
    this.sweep()
    return this.prepared.get(id)
  }

  /** Synchronously moves a prepared context into the pending phase with its frozen operation. */
  addPending(authority: ConsentAuthority, target: ConsentTarget | null, operation: ConsentOperation, display: Record<string, unknown>, preparedId?: string): PendingConsent {
    this.assertCapacity(authority, 'pending')
    if (preparedId && !this.prepared.delete(preparedId)) throw new ConsentError(409, 'context_unavailable')
    const now = this.now()
    const entry = { id: randomUUID(), authority, target, operation, display, createdAt: now, expiresAt: now + CONSENT_TTL_MS }
    this.pending.set(entry.id, entry)
    return entry
  }

  list(accountId: number, profile: string, sessionId: string): PendingConsent[] {
    this.sweep()
    return [...this.pending.values()]
      .filter(entry => entry.authority.accountId === accountId && entry.authority.profile === profile && entry.authority.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * One decision per request: only the owning account can consume it, and the entry leaves the store
   * synchronously, before any asynchronous effect. A wrong account never consumes it.
   */
  take(id: string, accountId: number, profile: string): PendingConsent | 'not_found' | 'expired' {
    const entry = this.pending.get(id)
    if (!entry || entry.authority.accountId !== accountId || entry.authority.profile !== profile) return 'not_found'
    this.pending.delete(id)
    return entry.expiresAt <= this.now() ? 'expired' : entry
  }

  discard(id: string): void {
    this.pending.delete(id)
  }

  clear(): void {
    this.prepared.clear()
    this.pending.clear()
  }
}

export const cronConsentStore = new CronConsentStore()

/**
 * Current destination policy for a consent authority: active account with profile access, the
 * session still exists in the profile as a supported target with the frozen generation, and a
 * session attributed to a Studio account belongs to this account. An unattributed session is allowed
 * for the authenticated actor; its ownership is not changed.
 */
function consentDestinationVerdict(authority: ConsentAuthority): { status: number; code: string } | null {
  if (!consentAccountAllowed(authority.accountId, authority.profile)) return { status: 403, code: 'profile_access_denied' }
  const view = consentSessionView(authority.sessionId)
  if (!view || view.profile !== authority.profile) return { status: 404, code: 'session_not_found' }
  if (view.ownerAccount !== null && view.ownerAccount !== authority.accountId) return { status: 403, code: 'session_account_mismatch' }
  const verdict = authorizeNoticeDestination(authority.accountId, authority.profile, authority.sessionId, authority.generation)
  if (verdict === 'unsupported') return { status: 422, code: 'unsupported_notification_target' }
  if (verdict === 'generation_mismatch') return { status: 409, code: 'session_generation_mismatch' }
  if (verdict !== 'ok') return { status: 403, code: 'profile_access_denied' }
  return null
}

function assertConsentDestination(authority: ConsentAuthority): void {
  const refused = consentDestinationVerdict(authority)
  if (refused) throw new ConsentError(refused.status, refused.code)
}

/**
 * An explicit other target must be a session of the origin's profile attributed to the same account
 * (an unattributed session is not this account's), then pass the ordinary destination policy.
 */
function targetVerdict(authority: ConsentAuthority, target: ConsentTarget): { status: number; code: string } | null {
  const view = consentSessionView(target.sessionId)
  if (!view || view.profile !== authority.profile) return { status: 404, code: 'target_session_not_found' }
  if (view.ownerAccount === null) return { status: 403, code: 'target_session_unattributed' }
  if (view.ownerAccount !== authority.accountId) return { status: 403, code: 'target_session_account_mismatch' }
  return consentDestinationVerdict({ ...authority, sessionId: target.sessionId, generation: target.generation })
}

/** Both the origin (which holds the request) and any explicit target must still authorize. */
function pendingVerdict(entry: Pick<PendingConsent, 'authority' | 'target'>): { status: number; code: string } | null {
  return consentDestinationVerdict(entry.authority) ?? (entry.target ? targetVerdict(entry.authority, entry.target) : null)
}

function resolveTarget(authority: ConsentAuthority, value: unknown): ConsentTarget | null {
  if (value === undefined) return null
  const sessionId = text(value, 'target_session', 200)
  // Naming the origin itself keeps the same-session contract.
  if (sessionId === authority.sessionId) return null
  const target = { sessionId, generation: consentSessionView(sessionId)?.generation ?? '' }
  const refused = targetVerdict(authority, target)
  if (refused) throw new ConsentError(refused.status, refused.code)
  return target
}

function text(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ConsentError(400, `invalid_${field}`)
  return value.trim()
}

/** POST /consent-contexts: a login user opens a model-free setup context for one selected session. */
export async function prepareConsentContext(deps: ConsentDeps, store: CronConsentStore, user: AuthenticatedUser,
  input: Record<string, unknown>): Promise<{ context_id: string; profile: string; session_id: string; expires_at: number }> {
  const profile = text(input.profile, 'profile', 128)
  const sessionId = text(input.session_id, 'session', 200)
  const view = consentSessionView(sessionId)
  if (!view || view.profile !== profile) throw new ConsentError(404, 'session_not_found')
  const authority: ConsentAuthority = { accountId: user.id, profile, sessionId, generation: view.generation, contextKind: 'prepared' }
  assertConsentDestination(authority)
  const entry = store.prepare(authority)
  // The ordinary issuer: the MCP process reads its usual profile credential, nothing is copied.
  await deps.issueRuntimeCredential(user, profile)
  return { context_id: entry.id, profile, session_id: sessionId, expires_at: entry.expiresAt }
}

function resolveAuthority(deps: ConsentDeps, store: CronConsentStore, user: AuthenticatedUser, profile: string, contextId: string):
  { authority: ConsentAuthority; preparedId?: string } {
  const prepared = store.peekPrepared(contextId)
  if (prepared) {
    if (prepared.authority.profile !== profile) throw new ConsentError(409, 'context_unavailable')
    if (prepared.authority.accountId !== user.id) throw new ConsentError(403, 'context_account_mismatch')
    return { authority: prepared.authority, preparedId: prepared.id }
  }
  let turn: { sessionId: string; accountId: number }
  try {
    turn = deps.turnAuthority(contextId, profile)
  } catch {
    throw new ConsentError(409, 'context_unavailable')
  }
  if (turn.accountId !== user.id) throw new ConsentError(403, 'context_account_mismatch')
  const view = consentSessionView(turn.sessionId)
  if (!view || view.profile !== profile) throw new ConsentError(404, 'session_not_found')
  return { authority: { accountId: user.id, profile, sessionId: turn.sessionId, generation: view.generation, contextKind: 'turn' } }
}

function sessionTitle(sessionId: string): string | null {
  return consentSessionView(sessionId)?.title ?? null
}

function freezeOperation(profile: string, input: Record<string, unknown>): { operation: ConsentOperation; display: Record<string, unknown> } {
  const kind = input.kind
  if (kind === 'script_report_enrollment') {
    const mode = input.mode === undefined ? 'new' : input.mode
    if (mode === 'existing') {
      const plan = prepareAdoption(profile, String(input.job_id ?? ''))
      return {
        operation: { kind, plan },
        display: {
          kind, mode, action: 'modify_job', job_id: plan.jobId, name: plan.name, schedule: plan.schedule,
          script: plan.target.relative, script_kind: plan.target.kind, script_sha256: plan.target.sha256,
          workdir: plan.workdir, interpreter: plan.interpreter, resume: plan.resume,
        },
      }
    }
    if (mode !== 'new') throw new ConsentError(400, 'invalid_mode')
    const plan = prepareNewEnrollment({
      profile, name: String(input.name ?? ''), schedule: String(input.schedule ?? ''), script: String(input.script ?? ''),
      workdir: input.workdir as string | null | undefined, interpreter: input.interpreter as string | null | undefined,
      paused: input.paused === true,
    })
    return {
      operation: { kind, plan },
      display: {
        kind, mode, action: 'create_job', name: plan.name, schedule: plan.schedule,
        script: plan.target.relative, script_kind: plan.target.kind, script_sha256: plan.target.sha256,
        workdir: plan.workdir, interpreter: plan.interpreter, resume: !plan.paused,
      },
    }
  }
  if (kind === 'cron_session_binding') {
    const plan = prepareAgentBinding(profile, String(input.job_id ?? ''))
    return {
      operation: { kind, plan },
      display: {
        kind, mode: 'existing', action: 'subscribe_job', job_id: plan.jobId, name: plan.name, schedule: plan.schedule,
        prompt: plan.prompt.slice(0, PROMPT_PREVIEW_CHARS), prompt_truncated: plan.prompt.length > PROMPT_PREVIEW_CHARS,
        prior_binding: plan.prior ? { session_id: plan.prior.session_id, session_title: sessionTitle(plan.prior.session_id) } : null,
      },
    }
  }
  throw new ConsentError(400, 'invalid_kind')
}

/** POST /consent-requests: a runtime (or login) credential proposes one frozen operation. */
export function requestConsent(deps: ConsentDeps, store: CronConsentStore, user: AuthenticatedUser,
  credential: RequestCredentialKind | undefined, input: Record<string, unknown>) {
  if (!credential || !REQUEST_CREDENTIALS.has(credential)) throw new ConsentError(403, 'credential_not_permitted')
  if (DESTINATION_OVERRIDES.some(key => input[key] !== undefined)) throw new ConsentError(400, 'destination_override_refused')
  const profile = text(input.profile, 'profile', 128)
  const contextId = text(input.context_id, 'context', 200)
  const { authority, preparedId } = resolveAuthority(deps, store, user, profile, contextId)
  assertConsentDestination(authority)
  const target = resolveTarget(authority, input.target_session_id)
  const { operation, display } = freezeOperation(profile, input)
  const entry = store.addPending(authority, target, operation, {
    ...display, profile, session_id: authority.sessionId, session_title: sessionTitle(authority.sessionId),
    context_kind: authority.contextKind, requested_via: credential,
  }, preparedId)
  deps.publish(authority.sessionId)
  return {
    request_id: entry.id, kind: operation.kind, status: 'pending_user_consent' as const, session_id: authority.sessionId,
    ...(target ? { target_session_id: target.sessionId } : {}), expires_at: entry.expiresAt,
  }
}

/** GET /consent-requests: the login account's pending requests for one session, still valid now. */
export function listConsents(store: CronConsentStore, user: AuthenticatedUser, profile: string, sessionId: string) {
  return store.list(user.id, profile, sessionId).flatMap(entry => {
    // A reset/deleted session or lost access invalidates the request instead of showing it.
    if (pendingVerdict(entry)) {
      store.discard(entry.id)
      return []
    }
    // Sessions are shown with their current titles; identity is the frozen session id.
    const target = entry.target
      ? { target: { session_id: entry.target.sessionId, profile: entry.authority.profile, title: sessionTitle(entry.target.sessionId) } }
      : {}
    return [{ id: entry.id, created_at: entry.createdAt, expires_at: entry.expiresAt, ...entry.display,
      session_title: sessionTitle(entry.authority.sessionId), ...target }]
  })
}

/** POST /consent-requests/:id/{approve,deny}: login only; executes only the frozen plan. */
export async function decideConsent(deps: ConsentDeps, store: CronConsentStore, user: AuthenticatedUser, id: string,
  profile: string, decision: 'approve' | 'deny'): Promise<Record<string, unknown>> {
  const entry = store.take(id, user.id, profile)
  if (entry === 'not_found') throw new ConsentError(404, 'consent_not_found')
  if (entry === 'expired') throw new ConsentError(410, 'consent_expired')
  deps.publish(entry.authority.sessionId)
  if (decision === 'deny') return { status: 'denied', request_id: entry.id }
  const { authority, operation } = entry
  const refusedNow = pendingVerdict(entry)
  if (refusedNow) throw new ConsentError(refusedNow.status, refusedNow.code)
  const { sessionId, generation } = entry.target ?? authority
  const destination = { userId: authority.accountId, profile: authority.profile, sessionId, expectedGeneration: generation }
  if (operation.kind === 'cron_session_binding') {
    const binding = await executeAgentBinding(operation.plan, {
      userId: authority.accountId, sessionId, generation,
      recheck: () => {
        const refused = pendingVerdict(entry)
        if (refused) throw new CronBindingError(refused.status, refused.code)
      },
    })
    return { status: 'approved', request_id: entry.id, kind: operation.kind, binding }
  }
  const recheck = () => {
    const refused = pendingVerdict(entry)
    if (refused) throw new EnrollmentError(refused.status, refused.code)
  }
  const runner = deps.runner || defaultCronRunner
  const result = operation.plan.mode === 'existing'
    ? await executeAdoption(operation.plan, { ...destination, recheck }, { ...deps.adoption, runner })
    : await executeNewEnrollment(operation.plan, { ...destination, recheck }, runner)
  return {
    status: 'approved', request_id: entry.id, kind: operation.kind, mode: operation.plan.mode,
    binding: { ...result.binding, identity_kind: 'wrapper_invocation' }, job: result.job, resumed: result.resumed,
    ...(result.nativeState ? { native_state: result.nativeState } : {}),
  }
}

