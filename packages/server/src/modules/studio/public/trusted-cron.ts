import { randomUUID } from 'crypto'
import { readTrustedCronPolicy, writeTrustedCronPolicy, type TrustedCronPolicy } from '../repositories/trusted-cron-policy-store'
import { runMcpCredentials } from '../services/auth/run-mcp-credentials'
import { consentAccountAllowed, consentSessionView } from './cron-consent'
import { studioInstanceId } from './session-notifications'

export type { TrustedCronPolicy }

export function trustedCronPolicy(accountId: number, profile: string): TrustedCronPolicy {
  return readTrustedCronPolicy(studioInstanceId(), accountId, profile)
}

export function updateTrustedCronPolicy(accountId: number, profile: string, enabled: boolean, expectedRevision: number) {
  return writeTrustedCronPolicy(studioInstanceId(), accountId, profile, enabled, expectedRevision)
}

/** Authority captured under `epoch` still holds: the same enabled epoch and current account access. */
export function trustedCronPolicyCurrent(accountId: number, profile: string, epoch: string): boolean {
  const policy = trustedCronPolicy(accountId, profile)
  return policy.enabled && policy.epoch === epoch && consentAccountAllowed(accountId, profile)
}

/** Why the account may not automate Cron for this session now, or null. Unattributed sessions keep their owner. */
export function trustedCronSessionRefusal(accountId: number, profile: string, sessionId: string): { status: number; code: string } | null {
  if (!consentAccountAllowed(accountId, profile)) return { status: 403, code: 'profile_access_denied' }
  const view = consentSessionView(sessionId)
  if (!view || view.profile !== profile) return { status: 404, code: 'session_not_found' }
  if (view.ownerAccount !== null && view.ownerAccount !== accountId) return { status: 403, code: 'session_account_mismatch' }
  return null
}

/**
 * Issue the admission authority for one execution in one session (a live chat turn or a dispatch),
 * bound to the account, profile, session generation and enabled policy epoch. Null when the policy
 * is off or the session is not the account's to automate.
 */
export function issueTrustedCronCapability(input: {
  accountId: number; profile: string; sessionId: string; isActive: () => boolean; contextId?: string; singleUse?: boolean
}): string | null {
  const policy = trustedCronPolicy(input.accountId, input.profile)
  if (!policy.enabled || !policy.epoch || trustedCronSessionRefusal(input.accountId, input.profile, input.sessionId)) return null
  const generation = consentSessionView(input.sessionId)!.generation
  return runMcpCredentials.issueCronAdmission({
    sessionId: input.sessionId, contextId: input.contextId || `cron-dispatch:${randomUUID()}`, profile: input.profile,
    agentId: 'cron-admission', isActive: input.isActive,
    cron: { accountId: input.accountId, generation, epoch: policy.epoch, singleUse: input.singleUse === true },
  })
}

export function claimTrustedCronCapability(token: string): boolean {
  return runMcpCredentials.claimCronAdmission(token)
}

export function revokeTrustedCronCapability(sessionId: string, contextId: string): void {
  runMcpCredentials.revoke(sessionId, contextId)
}
