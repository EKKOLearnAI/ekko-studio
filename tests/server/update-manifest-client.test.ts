import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('update manifest client', () => {
  function createUpdateConfig() {
    return {
      enabled: true,
      strategy: 'device-package' as const,
      includeAgentUpgrade: false,
      packageName: '',
      registry: '',
      sourceLabel: 'Fallback Source',
      distTag: 'latest',
      cliBin: '',
      script: '',
      channel: 'stable',
      manifestUrl: '',
      manifestUrls: [],
      manifestBaseUrl: '',
      packageType: 'device-package' as const,
      installerScript: '/opt/hermes-web-ui/scripts/install-device-package.sh',
      stagingDir: '/tmp/staging',
      backupDir: '/tmp/backups',
      healthcheckUrl: 'http://127.0.0.1:6060/health',
      stateFile: '/tmp/update-state.json',
      logDir: '/tmp/update-logs',
      manifestTimeoutMs: 100,
      packageTimeoutMs: 100,
      downloadRetries: 0,
      downloadRetryDelayMs: 1,
      healthcheckTimeoutMs: 2_000,
      healthcheckIntervalMs: 2_000,
      healthcheckRetries: 15,
      healthcheckInitialDelayMs: 5_000,
      autoInstallDependencies: true,
      minFreeSpaceBytes: 1024,
    }
  }

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  async function withHttpServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
    run: (baseUrl: string) => Promise<void>,
  ): Promise<void> {
    const server = createServer(handler)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`
    try {
      await run(baseUrl)
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
    }
  }

  it('builds a channel manifest URL from the configured base URL', async () => {
    const { buildManifestUrl } = await import('../../packages/server/src/modules/studio/services/update/manifest-client')
    expect(buildManifestUrl('https://updates.example.com/releases/', 'stable')).toBe(
      'https://updates.example.com/releases/stable/latest.json',
    )
  })

  it('uses an explicit manifest URL when provided', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      url: 'https://updates.example.com/custom.json',
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({
        version: '1.2.3',
        channel: 'beta',
        sourceLabel: 'Internal Manifest',
        packageType: 'device-package',
      }))),
    }))
    const { fetchManifestUpdateInfo } = await import('../../packages/server/src/modules/studio/services/update/manifest-client')

    const result = await fetchManifestUpdateInfo({
      ...createUpdateConfig(),
      manifestUrl: 'https://updates.example.com/custom.json',
    })

    expect(result).toEqual({
      version: '1.2.3',
      channel: 'beta',
      sourceLabel: 'Internal Manifest',
      packageType: 'device-package',
      manifestUrl: 'https://updates.example.com/custom.json',
    })
  })

  it('falls back to the next configured manifest URL when the first source fails', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { code: 'ETIMEDOUT' }))
      .mockResolvedValueOnce({
        ok: true,
        url: 'https://oss.example.com/releases/stable/latest.json',
        arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({
          version: '1.2.3',
          channel: 'stable',
          sourceLabel: 'OSS Manifest',
          packageType: 'device-package',
        }))),
      })
    vi.stubGlobal('fetch', fetchMock)
    const { fetchManifestUpdateInfo } = await import('../../packages/server/src/modules/studio/services/update/manifest-client')

    const result = await fetchManifestUpdateInfo({
      ...createUpdateConfig(),
      manifestUrls: [
        'https://raw.example.com/releases/stable/latest.json',
        'https://oss.example.com/releases/stable/latest.json',
      ],
    })

    expect(result).toEqual({
      version: '1.2.3',
      channel: 'stable',
      sourceLabel: 'OSS Manifest',
      packageType: 'device-package',
      manifestUrl: 'https://oss.example.com/releases/stable/latest.json',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('falls back to configured metadata when optional manifest fields are missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      url: 'https://updates.example.com/releases/stable/latest.json',
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({
        version: '1.2.4',
      }))),
    }))
    const { resolveManifestCheckResult } = await import('../../packages/server/src/modules/studio/services/update/manifest-client')

    const result = await resolveManifestCheckResult({
      ...createUpdateConfig(),
      sourceLabel: 'Manifest Host',
      manifestBaseUrl: 'https://updates.example.com/releases',
    })

    expect(result).toEqual({
      latestVersion: '1.2.4',
      sourceLabel: 'Manifest Host',
      channel: 'stable',
      packageType: 'device-package',
      strategy: 'device-package',
      detectionSource: 'manifest',
    })
  })

  it('throws when the manifest omits a version', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      url: 'https://updates.example.com/custom.json',
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({ sourceLabel: 'Broken' }))),
    }))
    const { fetchManifestUpdateInfo } = await import('../../packages/server/src/modules/studio/services/update/manifest-client')

    await expect(fetchManifestUpdateInfo({
      ...createUpdateConfig(),
      manifestUrl: 'https://updates.example.com/custom.json',
    })).rejects.toThrow(/version field/)
  })

  it('validates required execution fields for device package manifests', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      url: 'https://updates.example.com/custom.json',
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({
        version: '1.2.5',
        channel: 'stable',
        sourceLabel: 'Internal Manifest',
        packageType: 'device-package',
        artifactFormat: 'tar.gz',
        packageUrl: 'https://updates.example.com/releases/v1.2.5/hermes-web-ui-device-v1.2.5.tar.gz',
        packageUrls: [
          'https://oss.example.com/releases/v1.2.5/hermes-web-ui-device-v1.2.5.tar.gz',
          'https://updates.example.com/releases/v1.2.5/hermes-web-ui-device-v1.2.5.tar.gz',
        ],
        sha256: 'a'.repeat(64),
        releasedAt: '2026-06-09T00:00:00Z',
        compatibleNodeRange: '>=23.0.0',
        minCurrentVersion: '1.2.0',
      }))),
    }))
    const { fetchDevicePackageManifest } = await import('../../packages/server/src/modules/studio/services/update/manifest-client')

    const result = await fetchDevicePackageManifest({
      ...createUpdateConfig(),
      manifestUrl: 'https://updates.example.com/custom.json',
    })

    expect(result.packageUrl).toContain('hermes-web-ui-device-v1.2.5.tar.gz')
    expect(result.packageUrls).toEqual([
      'https://oss.example.com/releases/v1.2.5/hermes-web-ui-device-v1.2.5.tar.gz',
      'https://updates.example.com/releases/v1.2.5/hermes-web-ui-device-v1.2.5.tar.gz',
    ])
    expect(result.artifactFormat).toBe('tar.gz')
    expect(result.compatibleNodeRange).toBe('>=23.0.0')
  })

  it('falls back to node-http when fetch fails for manifest requests', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))

    await withHttpServer((_, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        version: '1.2.6',
        channel: 'stable',
        sourceLabel: 'Fallback Manifest',
        packageType: 'device-package',
      }))
    }, async (baseUrl) => {
      const { fetchManifestUpdateInfo } = await import('../../packages/server/src/modules/studio/services/update/manifest-client')

      const result = await fetchManifestUpdateInfo({
        ...createUpdateConfig(),
        manifestUrl: `${baseUrl}/stable/latest.json`,
      })

      expect(result).toEqual({
        version: '1.2.6',
        channel: 'stable',
        sourceLabel: 'Fallback Manifest',
        packageType: 'device-package',
        manifestUrl: `${baseUrl}/stable/latest.json`,
      })
    })
  })

  it('surfaces a structured manifest fetch failure when both transports fail', async () => {
    // Isolate the manifest cache: phase (a) falls back to the last cached
    // manifest when every URL fails, so a cache seeded by an earlier test
    // in this worker would otherwise be served instead of the rejection.
    const { mkdtempSync, rmSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const savedHome = { HERMES_WEB_UI_HOME: process.env.HERMES_WEB_UI_HOME, HERMES_WEBUI_STATE_DIR: process.env.HERMES_WEBUI_STATE_DIR }
    const isolatedHome = mkdtempSync(join(tmpdir(), 'manifest-client-'))
    process.env.HERMES_WEB_UI_HOME = isolatedHome
    process.env.HERMES_WEBUI_STATE_DIR = isolatedHome

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { code: 'ETIMEDOUT' })))
    const { fetchManifestUpdateInfo } = await import('../../packages/server/src/modules/studio/services/update/manifest-client')

    try {
      await expect(fetchManifestUpdateInfo({
        ...createUpdateConfig(),
        manifestUrl: 'http://127.0.0.1:1/stable/latest.json',
      })).rejects.toMatchObject({
        code: 'update_manifest_fetch_failed',
        details: expect.objectContaining({
          manifestUrls: ['http://127.0.0.1:1/stable/latest.json'],
          failures: expect.arrayContaining([
            expect.objectContaining({
              manifestUrl: 'http://127.0.0.1:1/stable/latest.json',
            }),
          ]),
        }),
      })
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true })
      process.env.HERMES_WEB_UI_HOME = savedHome.HERMES_WEB_UI_HOME
      process.env.HERMES_WEBUI_STATE_DIR = savedHome.HERMES_WEBUI_STATE_DIR
    }
  })

  it('serves the persisted cache when every manifest URL fails (phase a offline fallback)', async () => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const savedHome = { HERMES_WEB_UI_HOME: process.env.HERMES_WEB_UI_HOME, HERMES_WEBUI_STATE_DIR: process.env.HERMES_WEBUI_STATE_DIR }
    const isolatedHome = mkdtempSync(join(tmpdir(), 'manifest-client-cache-'))
    process.env.HERMES_WEB_UI_HOME = isolatedHome
    process.env.HERMES_WEBUI_STATE_DIR = isolatedHome

    const cacheDir = join(isolatedHome, 'updates', 'cache')
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(join(cacheDir, 'manifest-stable.json'), JSON.stringify({
      schema: 1,
      cachedAt: new Date().toISOString(),
      channel: 'stable',
      manifestUrl: 'http://127.0.0.1:1/stable/latest.json',
      payload: {
        version: '1.2.6',
        channel: 'stable',
        sourceLabel: 'Fallback Manifest',
        packageType: 'device-package',
        artifactFormat: 'tar.gz',
      },
    }))

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { code: 'ETIMEDOUT' })))
    const { fetchManifestUpdateInfo } = await import('../../packages/server/src/modules/studio/services/update/manifest-client')

    try {
      const result = await fetchManifestUpdateInfo({
        ...createUpdateConfig(),
        manifestUrl: 'http://127.0.0.1:1/stable/latest.json',
      })
      // The cached manifest keeps the device visible while offline; the
      // staleness itself is surfaced through /api/update/identity.
      expect(result).toEqual({
        version: '1.2.6',
        channel: 'stable',
        sourceLabel: 'Fallback Manifest',
        packageType: 'device-package',
        manifestUrl: 'http://127.0.0.1:1/stable/latest.json',
      })
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true })
      delete process.env.HERMES_WEB_UI_HOME
      delete process.env.HERMES_WEBUI_STATE_DIR
    }
  })

  it('rejects invalid manifest channels before building the latest.json URL', async () => {
    const { buildManifestUrl } = await import('../../packages/server/src/modules/studio/services/update/manifest-client')

    expect(() => buildManifestUrl('https://updates.example.com/releases/', 'beta/canary')).toThrow(
      /Invalid update channel/,
    )
  })

  it('accepts a device-package manifest without an environment block (backwards compatible)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      url: 'https://updates.example.com/releases/stable/latest.json',
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({
        version: '1.2.10',
        channel: 'stable',
        sourceLabel: 'No Environment',
        packageType: 'device-package',
        artifactFormat: 'tar.gz',
        packageUrl: 'https://updates.example.com/releases/v1.2.10/hermes-web-ui-device-v1.2.10.tar.gz',
        sha256: 'a'.repeat(64),
        releasedAt: '2026-08-01T00:00:00Z',
        compatibleNodeRange: '>=23.0.0',
        minCurrentVersion: '1.2.0',
      }))),
    }))
    const { fetchDevicePackageManifest } = await import('../../packages/server/src/modules/studio/services/update/manifest-client')

    const result = await fetchDevicePackageManifest({
      ...createUpdateConfig(),
      manifestUrl: 'https://updates.example.com/releases/stable/latest.json',
    })

    expect(result.environment).toBeUndefined()
    expect(result.version).toBe('1.2.10')
  })

  it('accepts a device-package manifest with a full environment block', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      url: 'https://updates.example.com/releases/stable/latest.json',
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({
        version: '1.2.11',
        channel: 'stable',
        sourceLabel: 'With Environment',
        packageType: 'device-package',
        artifactFormat: 'tar.gz',
        packageUrl: 'https://updates.example.com/releases/v1.2.11/hermes-web-ui-device-v1.2.11.tar.gz',
        sha256: 'b'.repeat(64),
        releasedAt: '2026-08-02T00:00:00Z',
        compatibleNodeRange: '>=23.0.0',
        minCurrentVersion: '1.2.0',
        environment: {
          requiredNodeRange: '>=23.0.0 <25.0.0',
          requiredHermesAgentRange: '>=0.16.0',
          requiredSystemFiles: [
            { path: 'scripts/install-device-package.sh', kind: 'executable' },
            { path: 'scripts/hermes-web-ui-update-runner.sh', kind: 'executable' },
          ],
        },
      }))),
    }))
    const { fetchDevicePackageManifest } = await import('../../packages/server/src/modules/studio/services/update/manifest-client')

    const result = await fetchDevicePackageManifest({
      ...createUpdateConfig(),
      manifestUrl: 'https://updates.example.com/releases/stable/latest.json',
    })

    expect(result.environment).toEqual({
      requiredNodeRange: '>=23.0.0 <25.0.0',
      requiredHermesAgentRange: '>=0.16.0',
      requiredSystemFiles: [
        { path: 'scripts/install-device-package.sh', kind: 'executable' },
        { path: 'scripts/hermes-web-ui-update-runner.sh', kind: 'executable' },
      ],
    })
  })

  it('drops unknown subfields inside the environment block', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      url: 'https://updates.example.com/releases/stable/latest.json',
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({
        version: '1.2.12',
        channel: 'stable',
        sourceLabel: 'Unknown Environment Fields',
        packageType: 'device-package',
        artifactFormat: 'tar.gz',
        packageUrl: 'https://updates.example.com/releases/v1.2.12/hermes-web-ui-device-v1.2.12.tar.gz',
        sha256: 'c'.repeat(64),
        releasedAt: '2026-08-03T00:00:00Z',
        compatibleNodeRange: '>=23.0.0',
        minCurrentVersion: '1.2.0',
        environment: {
          requiredNodeRange: '>=23.0.0',
          unexpectedField: 'should be dropped',
          requiredSystemFiles: [
            { path: 'scripts/install-device-package.sh', kind: 'executable', garbage: 'drop me' },
            { path: 'scripts/legacy.sh', kind: 'invalid-kind' },
            { path: '', kind: 'present' },
          ],
        },
      }))),
    }))
    const { fetchDevicePackageManifest } = await import('../../packages/server/src/modules/studio/services/update/manifest-client')

    const result = await fetchDevicePackageManifest({
      ...createUpdateConfig(),
      manifestUrl: 'https://updates.example.com/releases/stable/latest.json',
    })

    expect(result.environment?.requiredNodeRange).toBe('>=23.0.0')
    expect((result.environment as Record<string, unknown>).unexpectedField).toBeUndefined()
    expect(result.environment?.requiredSystemFiles).toEqual([
      { path: 'scripts/install-device-package.sh', kind: 'executable' },
      { path: 'scripts/legacy.sh', kind: 'present' },
    ])
  })

  it('returns undefined environment when the block is malformed (non-object)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      url: 'https://updates.example.com/releases/stable/latest.json',
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({
        version: '1.2.13',
        channel: 'stable',
        sourceLabel: 'Malformed Environment',
        packageType: 'device-package',
        artifactFormat: 'tar.gz',
        packageUrl: 'https://updates.example.com/releases/v1.2.13/hermes-web-ui-device-v1.2.13.tar.gz',
        sha256: 'd'.repeat(64),
        releasedAt: '2026-08-04T00:00:00Z',
        compatibleNodeRange: '>=23.0.0',
        minCurrentVersion: '1.2.0',
        environment: 'not-an-object',
      }))),
    }))
    const { fetchDevicePackageManifest } = await import('../../packages/server/src/modules/studio/services/update/manifest-client')

    const result = await fetchDevicePackageManifest({
      ...createUpdateConfig(),
      manifestUrl: 'https://updates.example.com/releases/stable/latest.json',
    })

    expect(result.environment).toBeUndefined()
  })
})

describe('manifest_pinned_stale guard (task-12 update hardening)', () => {
  const cfg = {
    enabled: true,
    strategy: 'source-deploy' as const,
    packageName: '',
    registry: '',
    sourceLabel: 'Channel',
    distTag: 'latest',
    cliBin: '',
    script: '',
    channel: 'stable',
    manifestUrl: '',
    manifestUrls: [] as string[],
    manifestBaseUrl: '',
    packageType: 'source-deploy' as const,
    installerScript: '',
    stagingDir: '/tmp/staging',
    backupDir: '/tmp/backups',
    healthcheckUrl: 'http://127.0.0.1:6060/health',
    stateFile: '/tmp/u.json',
    logDir: '/tmp/logs',
    manifestTimeoutMs: 100,
    packageTimeoutMs: 100,
    downloadRetries: 0,
    downloadRetryDelayMs: 1,
    healthcheckTimeoutMs: 2000,
    healthcheckIntervalMs: 2000,
    healthcheckRetries: 1,
    healthcheckInitialDelayMs: 0,
    autoInstallDependencies: true,
    minFreeSpaceBytes: 1024,
  }

  function urlKeyedFetch(map: Record<string, string | null>) {
    return vi.fn(async (u: string) => {
      const val = map[String(u)]
      if (val === null) throw new Error('network down')
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(JSON.stringify({ version: val })) }
    })
  }

  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

  it('isPinnedManifestUrl classifies version/candidate paths', async () => {
    const { isPinnedManifestUrl } = await import('../../packages/server/src/modules/studio/services/update/manifest-client')
    expect(isPinnedManifestUrl('https://x/releases/v0.8.6/manifest.json')).toBe(true)
    expect(isPinnedManifestUrl('https://x/candidates/stable/0.8.6.json')).toBe(true)
    expect(isPinnedManifestUrl('https://x/releases/stable/latest.json')).toBe(false)
  })

  it('prefers the newer channel tip and records the warning when a candidate is pinned', async () => {
    vi.stubGlobal('fetch', urlKeyedFetch({
      'https://raw.example/candidates/stable/0.8.6.json': '0.8.6',
      'https://raw.example/releases/stable/latest.json': '0.8.8',
    }))
    const { resolveManifestCheckResultGuarded } = await import('../../packages/server/src/modules/studio/services/update/manifest-client')
    const result = await resolveManifestCheckResultGuarded({
      ...cfg,
      manifestUrls: ['https://raw.example/candidates/stable/0.8.6.json'],
      manifestBaseUrl: 'https://raw.example/releases',
    })
    expect(result.latestVersion).toBe('0.8.8')
    expect(result.warnings).toContain('manifest_pinned_stale')
    expect(result.pinnedManifestUrl).toContain('candidates')
    expect(result.effectiveManifestUrl).toContain('releases/stable/latest.json')
  })

  it('keeps the pinned result and emits no warning when the channel tip is unreachable', async () => {
    vi.stubGlobal('fetch', urlKeyedFetch({
      'https://raw.example/candidates/stable/0.8.6.json': '0.8.6',
      'https://raw.example/releases/stable/latest.json': null,
    }))
    const { resolveManifestCheckResultGuarded } = await import('../../packages/server/src/modules/studio/services/update/manifest-client')
    const result = await resolveManifestCheckResultGuarded({
      ...cfg,
      manifestUrls: ['https://raw.example/candidates/stable/0.8.6.json'],
      manifestBaseUrl: 'https://raw.example/releases',
    })
    expect(result.latestVersion).toBe('0.8.6')
    expect(result.warnings ?? []).toEqual([])
  })

  it('does not warn when the primary source already IS the channel tip', async () => {
    vi.stubGlobal('fetch', urlKeyedFetch({
      'https://raw.example/releases/stable/latest.json': '0.8.8',
    }))
    const { resolveManifestCheckResultGuarded } = await import('../../packages/server/src/modules/studio/services/update/manifest-client')
    const result = await resolveManifestCheckResultGuarded({
      ...cfg,
      manifestBaseUrl: 'https://raw.example/releases',
    })
    expect(result.latestVersion).toBe('0.8.8')
    expect(result.warnings ?? []).toEqual([])
  })
})
