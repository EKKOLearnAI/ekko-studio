import { createHash, randomBytes } from 'node:crypto'

const REMOTE_WORKSPACE_GRANT_TTL_MS = 165_000
const MAX_ACTIVE_REMOTE_WORKSPACE_GRANTS = 1_000
const MAX_REMOTE_WORKSPACE_REQUESTS_PER_RUN = 200

export type RemoteWorkspaceGrantAgentSnapshot = {
  name: string
  agent: 'hermes' | 'ekko' | 'codex' | 'claude' | 'pi' | 'grok' | 'opencode' | 'dsh' | 'cursor'
  agentMode: 'scoped' | 'global'
  profile: string
  provider: string
  model: string
  description: string
  avatar: string
  ownerMemberId: string
}

export type RemoteWorkspaceGrant = {
  runId: string
  roomId: string
  agentId: string
  workspace: string
  access: 'read-write'
  expiresAt: number
  agentSnapshot?: RemoteWorkspaceGrantAgentSnapshot
}

const grants = new Map<string, RemoteWorkspaceGrant>()
const grantDigestsByRun = new Map<string, Set<string>>()
const grantRequestCounts = new Map<string, number>()
const activeOperationCountsByRun = new Map<string, number>()
const operationDrainWaitersByRun = new Map<string, Set<() => void>>()

function digestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function removeDigest(digest: string, grant: RemoteWorkspaceGrant): void {
  grants.delete(digest)
  grantRequestCounts.delete(digest)
  const runDigests = grantDigestsByRun.get(grant.runId)
  runDigests?.delete(digest)
  if (!runDigests?.size) grantDigestsByRun.delete(grant.runId)
}

function pruneExpired(now = Date.now()): void {
  for (const [digest, grant] of grants) {
    if (grant.expiresAt <= now) removeDigest(digest, grant)
  }
}

export function issueRemoteWorkspaceGrant(input: {
  runId: string
  roomId: string
  agentId: string
  workspace: string
  agentSnapshot?: RemoteWorkspaceGrantAgentSnapshot
  now?: number
}): { token: string; grant: RemoteWorkspaceGrant } {
  const now = input.now ?? Date.now()
  pruneExpired(now)
  if (grants.size >= MAX_ACTIVE_REMOTE_WORKSPACE_GRANTS) {
    throw new Error('Too many active remote workspace grants')
  }
  const token = randomBytes(32).toString('base64url')
  const digest = digestToken(token)
  const grant: RemoteWorkspaceGrant = {
    runId: input.runId,
    roomId: input.roomId,
    agentId: input.agentId,
    workspace: input.workspace,
    access: 'read-write',
    expiresAt: now + REMOTE_WORKSPACE_GRANT_TTL_MS,
    ...(input.agentSnapshot ? { agentSnapshot: { ...input.agentSnapshot } } : {}),
  }
  grants.set(digest, grant)
  grantRequestCounts.set(digest, 0)
  const runDigests = grantDigestsByRun.get(grant.runId) || new Set<string>()
  runDigests.add(digest)
  grantDigestsByRun.set(grant.runId, runDigests)
  return { token, grant }
}

export function authenticateRemoteWorkspaceGrant(token: string, now = Date.now()): RemoteWorkspaceGrant | null {
  if (!/^[a-zA-Z0-9_-]{43}$/.test(token)) return null
  const digest = digestToken(token)
  const grant = grants.get(digest)
  if (!grant) return null
  if (grant.expiresAt <= now) {
    removeDigest(digest, grant)
    return null
  }
  const requestCount = grantRequestCounts.get(digest) || 0
  if (requestCount >= MAX_REMOTE_WORKSPACE_REQUESTS_PER_RUN) {
    removeDigest(digest, grant)
    return null
  }
  grantRequestCounts.set(digest, requestCount + 1)
  return { ...grant }
}

export function beginRemoteWorkspaceGrantOperation(
  token: string,
  now = Date.now(),
): { grant: RemoteWorkspaceGrant; finish: () => void } | null {
  const grant = authenticateRemoteWorkspaceGrant(token, now)
  if (!grant) return null
  activeOperationCountsByRun.set(
    grant.runId,
    (activeOperationCountsByRun.get(grant.runId) || 0) + 1,
  )
  let finished = false
  return {
    grant,
    finish: () => {
      if (finished) return
      finished = true
      const remaining = Math.max(0, (activeOperationCountsByRun.get(grant.runId) || 1) - 1)
      if (remaining > 0) {
        activeOperationCountsByRun.set(grant.runId, remaining)
        return
      }
      activeOperationCountsByRun.delete(grant.runId)
      const waiters = operationDrainWaitersByRun.get(grant.runId)
      operationDrainWaitersByRun.delete(grant.runId)
      for (const resolve of waiters || []) resolve()
    },
  }
}

export function waitForRemoteWorkspaceGrantOperations(runId: string): Promise<void> {
  if (!activeOperationCountsByRun.get(runId)) return Promise.resolve()
  return new Promise((resolve) => {
    const waiters = operationDrainWaitersByRun.get(runId) || new Set<() => void>()
    waiters.add(resolve)
    operationDrainWaitersByRun.set(runId, waiters)
  })
}

export function revokeRemoteWorkspaceGrantsForRun(runId: string): void {
  const digests = grantDigestsByRun.get(runId)
  if (!digests) return
  for (const digest of digests) {
    const grant = grants.get(digest)
    if (grant) {
      grants.delete(digest)
      grantRequestCounts.delete(digest)
    }
  }
  grantDigestsByRun.delete(runId)
}

export function resetRemoteWorkspaceGrantsForTest(): void {
  grants.clear()
  grantDigestsByRun.clear()
  grantRequestCounts.clear()
  activeOperationCountsByRun.clear()
  for (const waiters of operationDrainWaitersByRun.values()) {
    for (const resolve of waiters) resolve()
  }
  operationDrainWaitersByRun.clear()
}
