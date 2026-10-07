import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const home = vi.hoisted(() => ({ value: '' }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { get appHome() { return home.value } } }))
const manifest = {
  ok: true, proxy: 'billion-context', protocolVersion: 1, version: '0.1.181',
  toolNames: ['compress', 'decompress', 'search_context', 'acp_status', 'acp_cache'],
  tools: { openai: ['compress', 'decompress', 'search_context', 'acp_status', 'acp_cache'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object' } } })) },
  capabilities: { fork: { protocolVersion: 1, endpoint: '/__bili/plugin/fork', snapshotEndpoint: '/__bili/plugin/snapshot' } },
}
let server: Server
let requests: string[]
let responseManifest: unknown
let statusCode: number

beforeEach(async () => {
  home.value = await mkdtemp(join(tmpdir(), 'context-health-'))
  requests = []
  responseManifest = structuredClone(manifest)
  statusCode = 200
  server = createServer((req, res) => {
    requests.push(req.url!)
    res.writeHead(statusCode, { 'content-type': 'application/json' })
    res.end(JSON.stringify(req.url === '/__bili/plugin/manifest' ? responseManifest : { version: '0.1.181' }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { saveContextManagerSettings } = await import('../../packages/server/src/modules/studio/services/context-manager/settings')
  await saveContextManagerSettings('test', { proxyUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` })
})
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(home.value, { recursive: true, force: true })
})

describe('context manager public health', () => {
  it('observes the profile Hermes worker independently of public proxy health', async () => {
    const { configureContextManagerWorker } = await import('../../packages/server/src/modules/studio/public/context-manager-worker')
    configureContextManagerWorker({ getState: async profile => ({ profile, status: 'running', pids: [4321], activeSessions: 3, runningSessions: 0 }), restart: vi.fn() })
    const { getContextManagerHealth } = await import('../../packages/server/src/modules/studio/services/context-manager/health')
    expect((await getContextManagerHealth('test')).worker).toMatchObject({ profile: 'test', status: 'running', pids: [4321], activeSessions: 3 })
    configureContextManagerWorker({ getState: async profile => ({ profile, status: 'unknown', pids: [], activeSessions: null, runningSessions: null }), restart: vi.fn() })
  })
  it('checks actual public paths and validates protocol, tools and fork without calling session APIs', async () => {
    const { getContextManagerHealth } = await import('../../packages/server/src/modules/studio/services/context-manager/health')
    const health = await getContextManagerHealth('test')
    expect(requests.sort()).toEqual(['/__bili/plugin/manifest', '/__bili/status'])
    expect(health).toMatchObject({ healthy: true, runtimeVersion: '0.1.181', compatibility: 'compatible', worker: { status: 'unknown' }, lifecycle: { installed: false, version: null, management: 'external' } })
  })
  it.each([
    { ...manifest, protocolVersion: 2 },
    { ...manifest, toolNames: ['compress'] },
    { ...manifest, tools: { openai: [] } },
    { ...manifest, capabilities: {} },
    { ...manifest, capabilities: { fork: { protocolVersion: 1, endpoint: 'https://evil.test/fork' } } },
  ])('rejects incompatible manifests', async value => {
    responseManifest = value
    const { getContextManagerHealth } = await import('../../packages/server/src/modules/studio/services/context-manager/health')
    expect((await getContextManagerHealth('test')).compatibility).toBe('incompatible')
  })
  it('reports unavailable endpoints without treating them as compatible', async () => {
    statusCode = 503
    const { getContextManagerHealth } = await import('../../packages/server/src/modules/studio/services/context-manager/health')
    expect(await getContextManagerHealth('test')).toMatchObject({ healthy: false, runtimeVersion: null, compatibility: 'unverified',
      observations: { manifest: { error: 'HTTP 503', errorCode: 'context_manager_probe_http', statusCode: 503 } } })
  })
  it('does not expose arbitrary fetch exception text in health errors', async () => {
    const original = globalThis.fetch
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('token=secret-value at /private/.env'))
    try {
      const { getContextManagerHealth } = await import('../../packages/server/src/modules/studio/services/context-manager/health')
      const value = await getContextManagerHealth('test')
      expect(value.observations.manifest).toMatchObject({ errorCode: 'context_manager_probe_failed', error: 'Cannot reach the proxy health endpoint' })
      expect(JSON.stringify(value.observations)).not.toMatch(/secret-value|private|\.env/)
    } finally { globalThis.fetch = original }
  })
})