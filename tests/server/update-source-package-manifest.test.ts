import { afterEach, describe, expect, it, vi } from 'vitest'

function createUpdateConfig() {
  return {
    enabled: true,
    strategy: 'source-deploy' as const,
    includeAgentUpgrade: false,
    packageName: '',
    registry: '',
    sourceLabel: 'Fallback Source',
    distTag: 'latest',
    cliBin: '',
    script: '/opt/hermes-web-ui/scripts/update-source-deploy.sh',
    runnerService: 'hermes-web-ui-update.service',
    runnerRequestFile: '/tmp/runner-request.json',
    channel: 'stable',
    manifestUrl: '',
    manifestUrls: [],
    manifestBaseUrl: '',
    packageType: 'source-deploy' as const,
    installerScript: '',
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

describe('source-deploy manifest client', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('parses source URLs ordered with OSS first then GitHub fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      url: 'https://updates.example.com/stable/latest.json',
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({
        version: '1.2.7',
        channel: 'stable',
        sourceLabel: 'OSS Release',
        packageType: 'source-deploy',
        artifactFormat: 'tar.gz',
        sourceUrl: 'https://oss.example.com/sources/v1.2.7/source.tar.gz',
        sourceUrls: [
          'https://oss.example.com/sources/v1.2.7/source.tar.gz',
          'https://github.com/EKKOLearnAI/hermes-studio/releases/download/v1.2.7/source.tar.gz',
        ],
        sourceSha256: 'b'.repeat(64),
        releasedAt: '2026-07-01T00:00:00Z',
        minCurrentVersion: '1.2.0',
        sourceRepoUrl: 'https://github.com/EKKOLearnAI/hermes-studio',
        sourceSize: 12345,
      }))),
    }))

    const { fetchSourcePackageManifest } = await import('../../packages/server/src/modules/studio/services/update/manifest-client')

    const result = await fetchSourcePackageManifest({
      ...createUpdateConfig(),
      manifestUrl: 'https://updates.example.com/stable/latest.json',
    })

    expect(result.version).toBe('1.2.7')
    expect(result.sourceUrl).toBe('https://oss.example.com/sources/v1.2.7/source.tar.gz')
    expect(result.sourceUrls).toEqual([
      'https://oss.example.com/sources/v1.2.7/source.tar.gz',
      'https://github.com/EKKOLearnAI/hermes-studio/releases/download/v1.2.7/source.tar.gz',
    ])
    expect(result.sourceSha256).toBe('b'.repeat(64))
    expect(result.sourceRepoUrl).toBe('https://github.com/EKKOLearnAI/hermes-studio')
    expect(result.sourceSize).toBe(12345)
  })

  it('accepts a single sourceUrl field without sourceUrls', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      url: 'https://updates.example.com/stable/latest.json',
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({
        version: '1.2.8',
        channel: 'stable',
        sourceLabel: 'OSS Release',
        packageType: 'source-deploy',
        artifactFormat: 'tar.gz',
        sourceUrl: 'https://oss.example.com/sources/v1.2.8/source.tar.gz',
        sourceSha256: 'c'.repeat(64),
        releasedAt: '2026-07-02T00:00:00Z',
        minCurrentVersion: '1.2.0',
      }))),
    }))

    const { fetchSourcePackageManifest } = await import('../../packages/server/src/modules/studio/services/update/manifest-client')

    const result = await fetchSourcePackageManifest({
      ...createUpdateConfig(),
      manifestUrl: 'https://updates.example.com/stable/latest.json',
    })

    expect(result.sourceUrl).toBe('https://oss.example.com/sources/v1.2.8/source.tar.gz')
    expect(result.sourceUrls).toBeUndefined()
    expect(result.sourceRepoUrl).toBeUndefined()
  })

  it('rejects source-deploy manifests with packageType other than source-deploy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      url: 'https://updates.example.com/stable/latest.json',
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({
        version: '1.2.9',
        channel: 'stable',
        sourceLabel: 'Wrong Type',
        packageType: 'device-package',
        artifactFormat: 'tar.gz',
        sourceUrl: 'https://oss.example.com/source.tar.gz',
        sourceSha256: 'd'.repeat(64),
        releasedAt: '2026-07-03T00:00:00Z',
        minCurrentVersion: '1.2.0',
      }))),
    }))

    const { fetchSourcePackageManifest } = await import('../../packages/server/src/modules/studio/services/update/manifest-client')

    await expect(fetchSourcePackageManifest({
      ...createUpdateConfig(),
      manifestUrl: 'https://updates.example.com/stable/latest.json',
    })).rejects.toMatchObject({
      code: 'update_manifest_invalid',
      message: expect.stringMatching(/packageType must be "source-deploy"/),
    })
  })

  it('rejects manifest missing sourceSha256', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      url: 'https://updates.example.com/stable/latest.json',
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({
        version: '1.3.0',
        channel: 'stable',
        sourceLabel: 'Broken',
        packageType: 'source-deploy',
        artifactFormat: 'tar.gz',
        sourceUrl: 'https://oss.example.com/source.tar.gz',
        releasedAt: '2026-07-04T00:00:00Z',
        minCurrentVersion: '1.2.0',
      }))),
    }))

    const { fetchSourcePackageManifest } = await import('../../packages/server/src/modules/studio/services/update/manifest-client')

    await expect(fetchSourcePackageManifest({
      ...createUpdateConfig(),
      manifestUrl: 'https://updates.example.com/stable/latest.json',
    })).rejects.toMatchObject({
      code: 'update_manifest_invalid',
      message: expect.stringMatching(/sourceSha256/),
    })
  })

  it('rejects manifest with malformed sourceSha256', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      url: 'https://updates.example.com/stable/latest.json',
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({
        version: '1.3.1',
        channel: 'stable',
        sourceLabel: 'Broken',
        packageType: 'source-deploy',
        artifactFormat: 'tar.gz',
        sourceUrl: 'https://oss.example.com/source.tar.gz',
        sourceSha256: 'not-a-hex-string',
        releasedAt: '2026-07-05T00:00:00Z',
        minCurrentVersion: '1.2.0',
      }))),
    }))

    const { fetchSourcePackageManifest } = await import('../../packages/server/src/modules/studio/services/update/manifest-client')

    await expect(fetchSourcePackageManifest({
      ...createUpdateConfig(),
      manifestUrl: 'https://updates.example.com/stable/latest.json',
    })).rejects.toMatchObject({
      code: 'update_manifest_invalid',
      message: expect.stringMatching(/64 character hex/),
    })
  })

  it('injects source URLs and sha256 into the runner environment via buildSourceDeployEnv', async () => {
    const { buildSourceDeployEnv } = await import('../../packages/server/src/modules/studio/services/update/strategies/source-deploy')

    const env = buildSourceDeployEnv(
      createUpdateConfig(),
      { PATH: '/usr/bin' },
      '1.3.2',
      {
        deployDir: '/opt/hermes-web-ui',
        webUiHome: '/var/lib/hermes-web-ui',
        uploadDir: '/var/lib/hermes-web-ui/uploads',
        hermesHome: '',
      },
      'task-1',
      {
        version: '1.3.2',
        channel: 'stable',
        sourceLabel: 'OSS Release',
        packageType: 'source-deploy',
        manifestUrl: 'https://updates.example.com/stable/latest.json',
        artifactFormat: 'tar.gz',
        sourceUrl: 'https://oss.example.com/sources/v1.3.2/source.tar.gz',
        sourceUrls: [
          'https://oss.example.com/sources/v1.3.2/source.tar.gz',
          'https://github.com/EKKOLearnAI/hermes-studio/releases/download/v1.3.2/source.tar.gz',
        ],
        sourceSha256: 'e'.repeat(64),
        releasedAt: '2026-07-06T00:00:00Z',
        minCurrentVersion: '1.2.0',
        notesUrl: '',
        sourceRepoUrl: 'https://github.com/EKKOLearnAI/hermes-studio',
        sourceSize: 4096,
        healthcheckUrl: 'http://127.0.0.1:6060/health',
      },
    )

    expect(env.HERMES_WEB_UI_UPDATE_SOURCE_PACKAGE_URL).toBe('https://oss.example.com/sources/v1.3.2/source.tar.gz')
    expect(env.HERMES_WEB_UI_UPDATE_SOURCE_PACKAGE_URLS).toBe(JSON.stringify([
      'https://oss.example.com/sources/v1.3.2/source.tar.gz',
      'https://github.com/EKKOLearnAI/hermes-studio/releases/download/v1.3.2/source.tar.gz',
    ]))
    expect(env.HERMES_WEB_UI_UPDATE_SOURCE_PACKAGE_SHA256).toBe('e'.repeat(64))
    expect(env.HERMES_WEB_UI_UPDATE_SOURCE_REPO_URL).toBe('https://github.com/EKKOLearnAI/hermes-studio')
    expect(env.HERMES_WEB_UI_UPDATE_HEALTHCHECK_URL).toBe('http://127.0.0.1:6060/health')
  })

  it('produces empty source fields when no manifest is supplied (legacy path)', async () => {
    const { buildSourceDeployEnv } = await import('../../packages/server/src/modules/studio/services/update/strategies/source-deploy')

    const env = buildSourceDeployEnv(
      createUpdateConfig(),
      { PATH: '/usr/bin' },
      '1.3.3',
      {
        deployDir: '/opt/hermes-web-ui',
        webUiHome: '/var/lib/hermes-web-ui',
        uploadDir: '/var/lib/hermes-web-ui/uploads',
        hermesHome: '',
      },
      'task-2',
    )

    expect(env.HERMES_WEB_UI_UPDATE_SOURCE_PACKAGE_URL).toBe('')
    expect(env.HERMES_WEB_UI_UPDATE_SOURCE_PACKAGE_URLS).toBe('[]')
    expect(env.HERMES_WEB_UI_UPDATE_SOURCE_PACKAGE_SHA256).toBe('')
    expect(env.HERMES_WEB_UI_UPDATE_SOURCE_REPO_URL).toBe('')
  })

  it('accepts a source-deploy manifest without an environment block (backwards compatible)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      url: 'https://updates.example.com/stable/latest.json',
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({
        version: '1.3.10',
        channel: 'stable',
        sourceLabel: 'No Environment',
        packageType: 'source-deploy',
        artifactFormat: 'tar.gz',
        sourceUrl: 'https://oss.example.com/sources/v1.3.10/source.tar.gz',
        sourceSha256: 'a'.repeat(64),
        releasedAt: '2026-08-10T00:00:00Z',
        minCurrentVersion: '1.2.0',
      }))),
    }))

    const { fetchSourcePackageManifest } = await import('../../packages/server/src/modules/studio/services/update/manifest-client')

    const result = await fetchSourcePackageManifest({
      ...createUpdateConfig(),
      manifestUrl: 'https://updates.example.com/stable/latest.json',
    })

    expect(result.environment).toBeUndefined()
    expect(result.version).toBe('1.3.10')
  })

  it('accepts a source-deploy manifest with a full environment block', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      url: 'https://updates.example.com/stable/latest.json',
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({
        version: '1.3.11',
        channel: 'stable',
        sourceLabel: 'With Environment',
        packageType: 'source-deploy',
        artifactFormat: 'tar.gz',
        sourceUrl: 'https://oss.example.com/sources/v1.3.11/source.tar.gz',
        sourceSha256: 'b'.repeat(64),
        releasedAt: '2026-08-11T00:00:00Z',
        minCurrentVersion: '1.2.0',
        environment: {
          requiredNodeRange: '>=23.0.0',
          requiredSystemFiles: [
            { path: 'scripts/install-device-package.sh', kind: 'executable' },
          ],
        },
      }))),
    }))

    const { fetchSourcePackageManifest } = await import('../../packages/server/src/modules/studio/services/update/manifest-client')

    const result = await fetchSourcePackageManifest({
      ...createUpdateConfig(),
      manifestUrl: 'https://updates.example.com/stable/latest.json',
    })

    expect(result.environment).toEqual({
      requiredNodeRange: '>=23.0.0',
      requiredSystemFiles: [
        { path: 'scripts/install-device-package.sh', kind: 'executable' },
      ],
    })
  })

  it('blocks updates when current version is below manifest minCurrentVersion', async () => {
    const { assertSourcePackageCompatibility } = await import('../../packages/server/src/modules/studio/services/update/strategies/source-package')

    expect(() => assertSourcePackageCompatibility({
      version: '1.4.0',
      channel: 'stable',
      sourceLabel: 'OSS Release',
      packageType: 'source-deploy',
      manifestUrl: 'https://updates.example.com/stable/latest.json',
      artifactFormat: 'tar.gz',
      sourceUrl: 'https://oss.example.com/source.tar.gz',
      sourceSha256: 'f'.repeat(64),
      releasedAt: '2026-07-07T00:00:00Z',
      minCurrentVersion: '1.3.0',
      notesUrl: '',
      sourceSize: 4096,
      healthcheckUrl: 'http://127.0.0.1:6060/health',
    }, '1.2.9')).toThrowError(/minimum supported update version/)
  })
})