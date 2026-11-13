import { afterEach, describe, expect, it, vi } from 'vitest'

const cache = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/studio/services/update/update-check-cache', () => cache)
vi.mock('../../packages/server/src/modules/studio/services/update/package-info', () => ({
  getLocalWebUiVersion: () => '1.0.0',
}))

async function loadHealth() {
  vi.stubEnv('WEBUI_UPDATE_ENABLED', 'true')
  vi.stubEnv('WEBUI_UPDATE_STRATEGY', 'source-deploy')
  vi.stubEnv('WEBUI_UPDATE_PACKAGE_TYPE', 'source-deploy')
  vi.stubEnv('WEBUI_UPDATE_SCRIPT', '/opt/webui/scripts/update-orchestrator.sh')
  const { StudioHealthService } = await import('../../packages/server/src/modules/studio/services/health')
  return new StudioHealthService({
    platform: 'hermes-agent',
    getPrimaryAgentVersion: async () => 'Hermes Agent 0.23.0',
    getPrimaryAgentBridgeHealth: async () => ({ status: 'ready', reachable: true }),
    isDockerContainer: () => false,
  })
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('independent update health reporting', () => {
  it('uses the independent channel result for the update badge and pin warning', async () => {
    cache.getSnapshot.mockReturnValue({ result: {
      latestVersion: '1.1.0',
      sourceLabel: 'Device releases',
      channel: 'stable',
      packageType: 'source-deploy',
      warnings: ['manifest_pinned_stale'],
      pinnedManifestUrl: 'https://updates.example/candidates/stable/1.0.0.json',
      effectiveManifestUrl: 'https://updates.example/releases/stable/latest.json',
    }, remoteError: '' })
    const health = await loadHealth()
    expect(await health.snapshot()).toMatchObject({
      webui_version: '1.0.0',
      webui_latest: '1.1.0',
      webui_update_enabled: true,
      webui_update_available: true,
      webui_update_source_label: 'Device releases',
      webui_update_strategy: 'source-deploy',
      webui_update_warnings: ['manifest_pinned_stale'],
    })
  })

  it('does not consult npm when manifest checking fails', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    cache.refresh.mockResolvedValue({ result: null, remoteError: 'manifest unavailable' })
    cache.getSnapshot.mockReturnValue({ result: null, remoteError: 'manifest unavailable' })
    const health = await loadHealth()
    await health.checkLatestVersion()
    expect(cache.refresh).toHaveBeenCalledWith(true)
    expect(fetch).not.toHaveBeenCalled()
    expect(await health.snapshot()).toMatchObject({ webui_latest: '', webui_update_available: false })
  })
})
