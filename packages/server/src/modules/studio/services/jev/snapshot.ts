import { timingSafeEqual } from 'node:crypto'
import { hashJevCanonical } from './sidecar-payload'
import type { JevSidecarAdapter, JevSidecarPolicySnapshot, JevSnapshotHandle } from './sidecar-contract'
import type { JevCredentialSettings } from './settings'

interface SnapshotSecret {
  profile: string
  apiKey: string
  baseUrl: string
  model: string
  providerTimeoutMs: number
  policy: JevSidecarPolicySnapshot
}

class SnapshotHandle implements JevSnapshotHandle {
  constructor(
    readonly integrationId: string,
    readonly configHash: string,
    readonly policyVersion: string,
    readonly policy: Readonly<Record<string, unknown>>,
  ) {}
  toJSON(): never { throw new TypeError('JEV snapshot handles cannot be serialized.') }
}

const secrets = new WeakMap<object, SnapshotSecret>()

export function createSidecarSnapshot(
  profile: string,
  settings: JevCredentialSettings,
  adapter: JevSidecarAdapter<any, any>,
): JevSnapshotHandle | null {
  const { apiKey: _apiKey, ...nonSecret } = settings
  const policy = adapter.parsePolicy({ ...nonSecret, hasApiKey: Boolean(settings.apiKey) })
  if (!policy.enabled || !settings.apiKey) return null
  if (!Number.isInteger(policy.budgetMs) || policy.budgetMs < 100 || policy.budgetMs > adapter.admissionCeilingMs) {
    throw new TypeError('Invalid JEV sidecar policy budget.')
  }
  const configHash = hashJevCanonical({
    schemaVersion: 1,
    integrationId: adapter.integrationId,
    policyVersion: adapter.policyVersion,
    baseUrl: settings.baseUrl,
    model: settings.model,
    providerTimeoutMs: settings.timeoutMs,
    policy: policy.policy,
  })
  const handle = new SnapshotHandle(adapter.integrationId, configHash, adapter.policyVersion, Object.freeze(structuredClone(policy.policy)))
  secrets.set(handle, { profile, apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model,
    providerTimeoutMs: settings.timeoutMs, policy: { ...policy, policy: structuredClone(policy.policy) } })
  return Object.freeze(handle)
}

export function sidecarSnapshotSecret(handle: JevSnapshotHandle, integrationId: string): SnapshotSecret | null {
  if (!(handle instanceof SnapshotHandle) || handle.integrationId !== integrationId) return null
  return secrets.get(handle) ?? null
}

export function snapshotMatchesCurrent(handle: JevSnapshotHandle, integrationId: string, current: JevCredentialSettings): boolean {
  const secret = sidecarSnapshotSecret(handle, integrationId)
  if (!secret || !current.apiKey) return false
  const left = Buffer.from(secret.apiKey)
  const right = Buffer.from(current.apiKey)
  return left.length === right.length && timingSafeEqual(left, right)
    && secret.baseUrl === current.baseUrl && secret.model === current.model
}

export function destroySidecarSnapshot(handle: JevSnapshotHandle): void { secrets.delete(handle as object) }
