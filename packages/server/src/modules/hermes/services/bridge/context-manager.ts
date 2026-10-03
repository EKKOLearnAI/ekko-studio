import { AgentBridgeClient, type AgentBridgeContextOwner } from './client'
import { getAgentBridgeManager } from './manager'

export type SessionContextOwner = AgentBridgeContextOwner

export interface HermesContextManagerSettings {
  hermes: { manager: 'native' | 'bili' }
  ekko: { manager: 'native' | 'bili' }
  proxyUrl: string
  caBundlePath?: string
  allowNativeFallback: boolean
}

export interface HermesProfileWorker {
  key: string
  profile: string
  running: boolean
  pid: number | null
  endpoint: string | null
  lastUsedAt: number | null
}

export interface HermesProfileWorkerObservation {
  profile: string
  reachable: boolean
  running: boolean
  workers: HermesProfileWorker[]
  activeSessions: number | null
  runningSessions: number | null
  error?: string
}

export interface HermesProfileWorkerRestart {
  profile: string
  destroyed: number
  before: HermesProfileWorkerObservation
  after: HermesProfileWorkerObservation
}

let loadSettings: ((profile: string) => Promise<HermesContextManagerSettings>) | undefined

export function configureHermesContextManager(options: {
  loadSettings: (profile: string) => Promise<HermesContextManagerSettings>
}): void {
  loadSettings = options.loadSettings
}

export function assertBridgeContextCapabilities(response: Record<string, unknown>): void {
  const capabilities = response.context_manager_capabilities as Record<string, unknown> | undefined
  if (capabilities?.version !== 1 || capabilities.workerIsolation !== true || capabilities.stableConversationId !== true
    || capabilities.singleCompressionOwner !== true || capabilities.contextOwnerStatus !== true) {
    throw new Error('Agent bridge does not support the Studio context manager protocol; upgrade the bridge before attaching')
  }
}

async function bridgeRequest(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const manager = getAgentBridgeManager()
  await manager.ensureReady()
  return new AgentBridgeClient({ endpoint: manager.endpoint }).request(payload)
}

function normalizeWorkerProfile(profile: string): string {
  const normalized = String(profile || '').trim()
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) throw new Error('invalid worker profile')
  return normalized
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function profileSessionCount(value: unknown, profile: string): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const counts = value as Record<string, unknown>
  if (!Object.hasOwn(counts, profile)) return 0
  const count = counts[profile]
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null
}

/** Observe only workers owned by one validated Hermes profile. */
export async function observeHermesProfileWorker(profile: string): Promise<HermesProfileWorkerObservation> {
  const normalized = normalizeWorkerProfile(profile)
  try {
    const response = await bridgeRequest({ action: 'ping' })
    assertBridgeContextCapabilities(response)
    const details = asRecord(response.worker_details)
    const workers = Object.entries(details)
      .map(([key, value]) => {
        const detail = asRecord(value)
        return {
          key,
          profile: String(detail.profile || ''),
          running: detail.running === true,
          pid: asNullableNumber(detail.pid),
          endpoint: typeof detail.endpoint === 'string' ? detail.endpoint : null,
          lastUsedAt: asNullableNumber(detail.last_used_at),
        }
      })
      .filter(worker => worker.profile === normalized)
    return {
      profile: normalized,
      reachable: true,
      running: workers.some(worker => worker.running),
      workers,
      activeSessions: profileSessionCount(response.sessions_by_profile, normalized),
      runningSessions: profileSessionCount(response.running_sessions_by_profile, normalized),
    }
  } catch (error) {
    return {
      profile: normalized,
      reachable: false,
      running: false,
      workers: [],
      activeSessions: null,
      runningSessions: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Restart one profile worker and wait for its replacement to answer ping.
 * The caller must reject this operation while any Studio session for the
 * profile is running; this facade also verifies broker counts, while the
 * broker atomically rejects destruction if a run starts after observation.
 */
export async function restartHermesProfileWorker(profile: string): Promise<HermesProfileWorkerRestart> {
  const normalized = normalizeWorkerProfile(profile)
  const before = await observeHermesProfileWorker(normalized)
  if (!before.reachable) throw new Error(before.error || 'Agent bridge broker is not reachable')
  if (before.runningSessions === null || before.activeSessions === null) {
    throw new Error('Cannot verify running sessions before restarting the Hermes worker')
  }
  if (before.runningSessions > 0) {
    throw Object.assign(new Error('Wait for running sessions to finish before restarting'), { code: 'context_manager_sessions_running' })
  }
  const destroyedResponse = await bridgeRequest({ action: 'destroy_profile', profile: normalized })
  const destroyed = typeof destroyedResponse.destroyed === 'number' ? destroyedResponse.destroyed : 0
  const workerPing = await bridgeRequest({ action: 'worker_ping', profile: normalized })
  assertBridgeContextCapabilities(workerPing)
  const after = await observeHermesProfileWorker(normalized)
  if (!after.reachable || !after.running) throw new Error(after.error || `Hermes profile worker '${normalized}' did not restart`)
  return { profile: normalized, destroyed, before, after }
}

export async function resolveSessionContextOwner(
  sessionId: string,
  profile: string,
  family: 'hermes' | 'ekko',
): Promise<SessionContextOwner> {
  if (!loadSettings) throw new Error('Hermes context manager settings loader is not configured')
  const settings = await loadSettings(profile)
  const selectedManager = settings[family].manager
  if (family === 'ekko') {
    return { manager: selectedManager, owner: selectedManager, selectedManager, independentPlugin: false, conversationId: sessionId,
      allowNativeFallback: settings.allowNativeFallback, ...(selectedManager === 'bili' ? { proxyUrl: settings.proxyUrl } : {}) }
  }
  const response = await bridgeRequest({ action: 'context_manager_status', session_id: sessionId, profile,
    context_manager: { manager: selectedManager, proxyUrl: settings.proxyUrl, allowNativeFallback: settings.allowNativeFallback, conversationId: sessionId,
      ...(selectedManager === 'bili' && settings.caBundlePath ? { caBundlePath: settings.caBundlePath } : {}) } })
  const owner = response.context_manager as SessionContextOwner | undefined
  if (!owner || owner.conversationId !== sessionId) throw new Error('Context manager returned a different conversation identity')
  if (!['native', 'bili'].includes(owner.manager) || owner.owner !== owner.manager || owner.selectedManager !== selectedManager
    || owner.allowNativeFallback !== settings.allowNativeFallback
    || (selectedManager === 'bili' && (owner.manager !== 'bili' || !owner.proxyUrl
      || new URL(owner.proxyUrl).origin !== new URL(settings.proxyUrl).origin
      || (settings.caBundlePath !== undefined && owner.caBundlePath !== settings.caBundlePath)))) {
    throw new Error('Context manager ownership could not be verified')
  }
  return owner
}

async function publicRequest(origin: string, path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = new URL(origin)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('bili proxy URL must be an HTTP(S) origin')
  }
  const response = await fetch(new URL(path, url), {
    method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) throw new Error(`bili public protocol failed: HTTP ${response.status}`)
  const value = await response.json() as Record<string, unknown>
  if (value?.ok !== true) throw new Error('bili public protocol returned an unsuccessful response')
  return value
}

export async function compactBiliConversation(
  sessionId: string,
  profile: string,
  owner: SessionContextOwner,
  family: 'hermes' | 'ekko' = 'hermes',
): Promise<Record<string, unknown>> {
  if (owner.manager !== 'bili' || owner.conversationId !== sessionId) throw new Error('bili compact requires the exact session-owned conversation')
  if (family === 'hermes') {
    const result = await bridgeRequest({ action: 'context_compact', session_id: sessionId, profile })
    const status = result.status as Record<string, unknown> | undefined
    if (result.manager !== 'bili' || result.conversationId !== sessionId || status?.conversationId !== sessionId || status.fallback === true) {
      throw new Error('bili compact did not verify the exact conversation identity')
    }
    return result
  }
  if (!owner.proxyUrl) throw new Error('bili compact requires a public proxy origin')
  const manifest = await publicRequest(owner.proxyUrl, '/__bili/plugin/manifest')
  const tools = (manifest.tools as { anthropic?: Array<{ name: string; input_schema?: { required?: unknown[] } }> } | undefined)?.anthropic
  const compact = tools?.find(tool => tool.name === 'compact')
  if (!Number.isInteger(manifest.protocolVersion) || Number(manifest.protocolVersion) < 1
    || !Array.isArray(manifest.toolNames) || !manifest.toolNames.includes('compact') || !compact?.input_schema || compact.input_schema.required?.length) {
    throw new Error('bili has no public session compact tool; use its compression tools with explicit arguments')
  }
  const result = await publicRequest(owner.proxyUrl, '/__bili/plugin/tool', { conversationId: sessionId, tool: 'compact', args: {} })
  let payload = result.result
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload) } catch { /* Public tools may return plain text. */ }
  }
  if (payload && typeof payload === 'object' && ('error' in payload || ('ok' in payload && payload.ok === false))) {
    throw new Error('bili public compact tool failed')
  }
  const status = await publicRequest(owner.proxyUrl, `/__bili/plugin/status?conversationId=${encodeURIComponent(sessionId)}`)
  if ((result.conversationId !== undefined && result.conversationId !== sessionId) || status.conversationId !== sessionId || status.fallback === true) {
    throw new Error('bili compact did not verify the exact conversation identity')
  }
  return { manager: 'bili', conversationId: sessionId, result, status }
}
