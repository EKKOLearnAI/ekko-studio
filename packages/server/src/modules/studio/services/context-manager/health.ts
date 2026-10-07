import { ContextManagerError, getContextManagerSettings, profileKey, type ContextManagerSettings } from './settings'
import { getContextManagerLifecycleState, type ContextManagerLifecycleState } from './lifecycle'
import { getContextManagerWorkerState, type ContextManagerWorkerState } from '../../public/context-manager-worker'

export interface ContextManagerHealthObservation {
  endpoint: string
  available: boolean
  statusCode: number | null
  data?: unknown
  error?: string
  errorCode?: string
}
export interface ContextManagerHealth {
  profile: string
  settings: ContextManagerSettings
  healthy: boolean
  runtimeVersion: string | null
  observations: { manifest: ContextManagerHealthObservation; status: ContextManagerHealthObservation }
  compatibility: 'compatible' | 'incompatible' | 'unverified'
  compatibilityIssues: string[]
  worker: ContextManagerWorkerState
  lifecycle: ContextManagerLifecycleState
}

const requiredTools = ['compress', 'decompress', 'search_context', 'acp_status', 'acp_cache']
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
export function checkContextManagerManifest(value: unknown): string[] {
  const manifest = record(value)
  const issues: string[] = []
  if (manifest.ok !== true || manifest.proxy !== 'billion-context' || manifest.protocolVersion !== 1) issues.push('protocol')
  const names = Array.isArray(manifest.toolNames) ? manifest.toolNames : []
  const tools = record(manifest.tools).openai
  const schemas = Array.isArray(tools) ? tools : []
  for (const name of requiredTools) {
    if (!names.includes(name) || !schemas.some(tool => {
      const schema = record(tool)
      const fn = record(schema.function)
      return schema.type === 'function' && fn.name === name && record(fn.parameters).type === 'object'
    })) issues.push(`tool:${name}`)
  }
  const fork = record(record(manifest.capabilities).fork)
  if (fork.protocolVersion !== 1 || fork.endpoint !== '/__bili/plugin/fork' || fork.snapshotEndpoint !== '/__bili/plugin/snapshot') issues.push('fork')
  return issues
}

async function probe(proxyUrl: string, path: string): Promise<ContextManagerHealthObservation> {
  const endpoint = new URL(path, proxyUrl).toString()
  const result: ContextManagerHealthObservation = { endpoint, available: false, statusCode: null }
  try {
    // Redirects must not escape the loopback-origin policy.
    const response = await fetch(endpoint, { redirect: 'error', signal: AbortSignal.timeout(1500) })
    result.statusCode = response.status
    if (!response.ok) { result.error = `HTTP ${response.status}`; result.errorCode = 'context_manager_probe_http'; return result }
    const text = await readBoundedResponse(response)
    result.data = JSON.parse(text)
    result.available = true
  } catch (error) {
    const code = error instanceof ContextManagerError ? error.code : error instanceof SyntaxError ? 'context_manager_probe_invalid'
      : error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'context_manager_probe_timeout' : 'context_manager_probe_failed'
    result.errorCode = code
    result.error = ({ context_manager_probe_invalid: 'Proxy returned an invalid health response', context_manager_probe_large: 'Proxy health response exceeds the size limit',
      context_manager_probe_timeout: 'Proxy health request timed out', context_manager_probe_failed: 'Cannot reach the proxy health endpoint' } as Record<string, string>)[code]
  }
  return result
}

async function readBoundedResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) throw new ContextManagerError('Empty health response', 503, 'context_manager_probe_invalid')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 256 * 1024) throw new ContextManagerError('Health response exceeds size limit', 503, 'context_manager_probe_large')
      chunks.push(value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally { await reader.cancel().catch(() => {}) }
}

export async function getContextManagerHealth(profile: string): Promise<ContextManagerHealth> {
  const normalized = profileKey(profile)
  const settings = await getContextManagerSettings(normalized)
  const [manifest, status, lifecycle, worker] = await Promise.all([
    probe(settings.proxyUrl, '/__bili/plugin/manifest'),
    probe(settings.proxyUrl, '/__bili/status'),
    getContextManagerLifecycleState(normalized),
    getContextManagerWorkerState(normalized),
  ])
  const issues = manifest.available ? checkContextManagerManifest(manifest.data) : []
  const reportedVersion = record(status.data).version
  const runtimeVersion = status.available && typeof reportedVersion === 'string' && reportedVersion.trim() ? reportedVersion : null
  return {
    profile: normalized, settings,
    healthy: manifest.available && runtimeVersion !== null,
    runtimeVersion,
    observations: { manifest, status },
    compatibility: !manifest.available ? 'unverified' : issues.length ? 'incompatible' : 'compatible',
    compatibilityIssues: issues,
    worker, lifecycle,
  }
}