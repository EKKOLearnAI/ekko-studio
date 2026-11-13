import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UpdateError } from '../../packages/server/src/modules/studio/services/update/errors'
import {
  assertDevicePackageCompatibility,
  assertInstallerScriptCompatible,
  buildDevicePackageInstallCommand,
  buildDevicePackageInstallEnv,
  buildDevicePackageReconcileCommand,
  buildDevicePackageReconcileEnv,
  downloadAndVerifyDevicePackage,
} from '../../packages/server/src/modules/studio/services/update/strategies/device-package'
import type { DevicePackageManifest, UpdateConfig } from '../../packages/server/src/modules/studio/services/update/types'

function createUpdateConfig(overrides: Partial<UpdateConfig> = {}): UpdateConfig {
  return {
    enabled: true,
    strategy: 'device-package',
    includeAgentUpgrade: false,
    packageName: '',
    registry: '',
    sourceLabel: 'Device Manifest',
    distTag: 'latest',
    cliBin: '',
    script: '',
    channel: 'stable',
    manifestUrl: 'https://updates.example.com/stable/manifest.json',
    manifestUrls: [],
    manifestBaseUrl: '',
    packageType: 'device-package',
    installerScript: '/opt/hermes-web-ui/scripts/install-device-package.sh',
    stagingDir: join(tmpdir(), 'hermes-web-ui-tests', 'staging'),
    backupDir: join(tmpdir(), 'hermes-web-ui-tests', 'backups'),
    healthcheckUrl: 'http://127.0.0.1:6060/health',
    stateFile: join(tmpdir(), 'hermes-web-ui-tests', 'update-state.json'),
    logDir: join(tmpdir(), 'hermes-web-ui-tests', 'logs'),
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
    ...overrides,
  }
}

function createManifest(overrides: Partial<DevicePackageManifest> = {}): DevicePackageManifest {
  return {
    version: '0.6.13',
    channel: 'stable',
    sourceLabel: 'Device Manifest',
    packageType: 'device-package',
    manifestUrl: 'https://updates.example.com/stable/manifest.json',
    artifactFormat: 'tar.gz',
    packageUrl: 'https://updates.example.com/releases/v0.6.13/hermes-web-ui-device-v0.6.13.tar.gz',
    packageUrls: undefined,
    sha256: 'a'.repeat(64),
    releasedAt: '2026-06-09T00:00:00Z',
    compatibleNodeRange: `>=${process.versions.node}`,
    minCurrentVersion: '0.6.10',
    notesUrl: '',
    size: 0,
    healthcheckUrl: 'http://127.0.0.1:6060/health',
    ...overrides,
  }
}

function createFetchBinaryResponse(buffer: Buffer, overrides: {
  ok?: boolean
  status?: number
  url?: string
  contentLength?: number | string
} = {}) {
  return {
    ok: overrides.ok ?? true,
    status: overrides.status ?? 200,
    url: overrides.url ?? 'https://updates.example.com/releases/v0.6.13/hermes-web-ui-device-v0.6.13.tar.gz',
    headers: {
      get(name: string) {
        if (name.toLowerCase() !== 'content-length') return null
        const value = overrides.contentLength
        return value == null ? null : String(value)
      },
    },
    arrayBuffer: async () => buffer,
  }
}

describe('device package strategy', () => {
  let tempRoot = ''

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true })
      tempRoot = ''
    }
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

  it('rejects when the current version is below minCurrentVersion', () => {
    const manifest = createManifest({ minCurrentVersion: '0.6.12' })

    expect(() => assertDevicePackageCompatibility(manifest, '0.6.10')).toThrow(UpdateError)
    expect(() => assertDevicePackageCompatibility(manifest, '0.6.10')).toThrow(/minimum supported update version/)
  })

  it('rejects when the Node.js version is incompatible with the declared range', () => {
    const manifest = createManifest({ compatibleNodeRange: '>999.0.0' })

    expect(() => assertDevicePackageCompatibility(manifest, '0.6.13')).toThrow(UpdateError)
    expect(() => assertDevicePackageCompatibility(manifest, '0.6.13')).toThrow(/requires Node\.js/)
  })

  it('allows runtimes that satisfy the declared Node.js range', () => {
    const currentMajor = Number.parseInt(process.versions.node.split('.')[0] || '0', 10)
    const manifest = createManifest({ compatibleNodeRange: `>=${currentMajor}.0.0` })

    expect(() => assertDevicePackageCompatibility(manifest, '0.6.13')).not.toThrow()
  })

  it('downloads the package and validates the checksum', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'hermes-web-ui-device-package-'))
    const packageBuffer = Buffer.from('device package bytes')
    const sha256 = createHash('sha256').update(packageBuffer).digest('hex')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createFetchBinaryResponse(packageBuffer)))

    const result = await downloadAndVerifyDevicePackage(
      createUpdateConfig({ stagingDir: join(tempRoot, 'staging') }),
      createManifest({ sha256 }),
    )

    expect(readFileSync(result.artifactPath)).toEqual(packageBuffer)
  })

  it('fails when the downloaded checksum does not match the manifest', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'hermes-web-ui-device-package-'))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createFetchBinaryResponse(Buffer.from('wrong content'))))

    await expect(downloadAndVerifyDevicePackage(
      createUpdateConfig({ stagingDir: join(tempRoot, 'staging') }),
      createManifest({ sha256: 'f'.repeat(64) }),
    )).rejects.toMatchObject({
      code: 'update_sha256_mismatch',
    })
  })

  it('cleans the staged artifact when checksum validation fails', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'hermes-web-ui-device-package-'))
    const stagingDir = join(tempRoot, 'staging')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createFetchBinaryResponse(Buffer.from('wrong content'))))

    await expect(downloadAndVerifyDevicePackage(
      createUpdateConfig({ stagingDir }),
      createManifest({ sha256: 'f'.repeat(64) }),
    )).rejects.toMatchObject({
      code: 'update_sha256_mismatch',
    })

    expect(existsSync(join(stagingDir, 'device-package-0.6.13', 'hermes-web-ui-device-v0.6.13.tar.gz'))).toBe(false)
  })

  it('falls back to node-http when fetch fails during package download', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'hermes-web-ui-device-package-'))
    const packageBuffer = Buffer.from('device package via fallback')
    const sha256 = createHash('sha256').update(packageBuffer).digest('hex')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))

    await withHttpServer((_, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      res.end(packageBuffer)
    }, async (baseUrl) => {
      const result = await downloadAndVerifyDevicePackage(
        createUpdateConfig({ stagingDir: join(tempRoot, 'staging') }),
        createManifest({
          packageUrl: `${baseUrl}/device-package.tar.gz`,
          sha256,
        }),
      )

      expect(readFileSync(result.artifactPath)).toEqual(packageBuffer)
    })
  })

  it('tries the next package source when the primary URL fails', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'hermes-web-ui-device-package-'))
    const packageBuffer = Buffer.from('device package via fallback source list')
    const sha256 = createHash('sha256').update(packageBuffer).digest('hex')
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { code: 'ETIMEDOUT' }))
      .mockResolvedValueOnce(createFetchBinaryResponse(packageBuffer, {
        url: 'https://github.com/example/device-package.tar.gz',
      }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await downloadAndVerifyDevicePackage(
      createUpdateConfig({ stagingDir: join(tempRoot, 'staging') }),
      createManifest({
        packageUrl: 'https://oss.example.com/device-package.tar.gz',
        packageUrls: [
          'https://oss.example.com/device-package.tar.gz',
          'https://github.com/example/device-package.tar.gz',
        ],
        sha256,
      }),
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(readFileSync(result.artifactPath)).toEqual(packageBuffer)
  })

  it('tries the next package source when the primary payload fails checksum validation', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'hermes-web-ui-device-package-'))
    const packageBuffer = Buffer.from('device package via validated fallback source list')
    const sha256 = createHash('sha256').update(packageBuffer).digest('hex')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createFetchBinaryResponse(Buffer.from('corrupted package bytes'), {
        url: 'https://oss.example.com/device-package.tar.gz',
      }))
      .mockResolvedValueOnce(createFetchBinaryResponse(packageBuffer, {
        url: 'https://github.com/example/device-package.tar.gz',
      }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await downloadAndVerifyDevicePackage(
      createUpdateConfig({ stagingDir: join(tempRoot, 'staging') }),
      createManifest({
        packageUrl: 'https://oss.example.com/device-package.tar.gz',
        packageUrls: [
          'https://oss.example.com/device-package.tar.gz',
          'https://github.com/example/device-package.tar.gz',
        ],
        sha256,
      }),
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(readFileSync(result.artifactPath)).toEqual(packageBuffer)
  })

  it('returns a structured package fetch failure when both transports fail', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'hermes-web-ui-device-package-'))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { code: 'ETIMEDOUT' })))

    await expect(downloadAndVerifyDevicePackage(
      createUpdateConfig({ stagingDir: join(tempRoot, 'staging') }),
      createManifest({ packageUrl: 'http://127.0.0.1:1/device-package.tar.gz' }),
    )).rejects.toMatchObject({
      code: 'update_package_fetch_failed',
      details: expect.objectContaining({
        packageUrl: 'http://127.0.0.1:1/device-package.tar.gz',
        packageUrls: ['http://127.0.0.1:1/device-package.tar.gz'],
        failures: expect.arrayContaining([
          expect.objectContaining({
            packageUrl: 'http://127.0.0.1:1/device-package.tar.gz',
          }),
        ]),
      }),
    })
  })

  it('retries transient package download failures before succeeding', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'hermes-web-ui-device-package-'))
    const packageBuffer = Buffer.from('device package after retries')
    const sha256 = createHash('sha256').update(packageBuffer).digest('hex')
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { code: 'ETIMEDOUT' }))
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' }))
      .mockResolvedValue(createFetchBinaryResponse(packageBuffer))
    vi.stubGlobal('fetch', fetchMock)

    const result = await downloadAndVerifyDevicePackage(
      createUpdateConfig({
        stagingDir: join(tempRoot, 'staging'),
        downloadRetries: 2,
        downloadRetryDelayMs: 1,
      }),
      createManifest({ sha256 }),
    )

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(readFileSync(result.artifactPath)).toEqual(packageBuffer)
  })

  it('fails when the downloaded size mismatches the manifest and cleans the partial artifact', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'hermes-web-ui-device-package-'))
    const stagingDir = join(tempRoot, 'staging')
    const packageBuffer = Buffer.from('device package bytes with wrong size')
    const sha256 = createHash('sha256').update(packageBuffer).digest('hex')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createFetchBinaryResponse(packageBuffer, {
      contentLength: packageBuffer.length + 10,
    })))

    await expect(downloadAndVerifyDevicePackage(
      createUpdateConfig({ stagingDir }),
      createManifest({
        sha256,
        size: packageBuffer.length,
      }),
    )).rejects.toMatchObject({
      code: 'update_download_failed',
      details: expect.objectContaining({
        reason: 'content_length_mismatch',
      }),
    })

    expect(existsSync(join(stagingDir, 'device-package-0.6.13', 'hermes-web-ui-device-v0.6.13.tar.gz'))).toBe(false)
  })

  it('builds installer command through a discovered bash executable on Linux', () => {
    const manifest = createManifest()
    const update = createUpdateConfig()
    const artifactPath = '/tmp/hermes-web-ui-device-v0.6.13.tar.gz'

    expect(buildDevicePackageInstallCommand(
      update.installerScript,
      manifest,
      artifactPath,
      () => '/bin/bash',
    )).toEqual({
      command: '/bin/bash',
      args: [update.installerScript, '--package', artifactPath, '--version', manifest.version],
    })
  })

  it('builds installer command through a discovered bash executable on Windows', () => {
    const manifest = createManifest()
    const update = createUpdateConfig()
    const artifactPath = '/tmp/hermes-web-ui-device-v0.6.13.tar.gz'

    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')

    expect(buildDevicePackageInstallCommand(
      update.installerScript,
      manifest,
      artifactPath,
      () => 'C:\\Program Files\\Git\\bin\\bash.exe',
    )).toEqual({
      command: 'C:\\Program Files\\Git\\bin\\bash.exe',
      args: [update.installerScript, '--package', artifactPath, '--version', manifest.version],
    })
  })

  it('fails with UpdateError when bash is unavailable', () => {
    const manifest = createManifest()
    const update = createUpdateConfig()
    const artifactPath = '/tmp/hermes-web-ui-device-v0.6.13.tar.gz'

    expect(() => buildDevicePackageInstallCommand(
      update.installerScript,
      manifest,
      artifactPath,
      () => undefined,
    )).toThrow(UpdateError)
    expect(() => buildDevicePackageInstallCommand(
      update.installerScript,
      manifest,
      artifactPath,
      () => undefined,
    )).toThrow(/requires bash, but no bash executable was found in PATH/)
  })

  it('builds installer env for the device package workflow', () => {
    const manifest = createManifest()
    const update = createUpdateConfig()
    const artifactPath = '/tmp/hermes-web-ui-device-v0.6.13.tar.gz'

    expect(buildDevicePackageInstallEnv(
      update,
      { PATH: process.env.PATH || '' },
      manifest,
      artifactPath,
      {
        deployDir: '/opt/hermes-web-ui',
        webUiHome: '/home/hermesui/.hermes-web-ui',
        uploadDir: '/home/hermesui/.hermes-web-ui/upload',
        hermesHome: '/opt/hermes-web-ui/hermes_data',
      },
      'task-123',
    )).toEqual(expect.objectContaining({
      APP_USER: 'hermesui',
      DEPLOY_DIR: '/opt/hermes-web-ui',
      HERMES_WEB_UI_UPDATE_PACKAGE_ARCHIVE: artifactPath,
      HERMES_WEB_UI_UPDATE_EXPECTED_SHA256: manifest.sha256,
      HERMES_WEB_UI_UPDATE_AUTO_INSTALL_DEPENDENCIES: 'true',
      HERMES_WEB_UI_UPDATE_INCLUDE_AGENT_UPGRADE: 'false',
      HERMES_WEB_UI_UPDATE_INSTALLER_SCRIPT_PATH: 'scripts/install-device-package.sh',
      HERMES_WEB_UI_UPDATE_INSTALLER_SCRIPT_SHA256: '',
    }))
  })

  it('forwards the declared installer script fingerprint through the env', () => {
    const manifest = createManifest({
      installerScriptPath: 'scripts/install-device-package.sh',
      installerScriptSha256: 'f'.repeat(64),
    })

    const env = buildDevicePackageInstallEnv(
      createUpdateConfig(),
      {},
      manifest,
      '/tmp/hermes-web-ui-device-v0.6.13.tar.gz',
      {
        deployDir: '/opt/hermes-web-ui',
        webUiHome: '/home/hermesui/.hermes-web-ui',
        uploadDir: '/home/hermesui/.hermes-web-ui/upload',
        hermesHome: '/opt/hermes-web-ui/hermes_data',
      },
      'task-456',
    )

    expect(env.HERMES_WEB_UI_UPDATE_INSTALLER_SCRIPT_PATH).toBe('scripts/install-device-package.sh')
    expect(env.HERMES_WEB_UI_UPDATE_INSTALLER_SCRIPT_SHA256).toBe('f'.repeat(64))
  })
})

describe('assertInstallerScriptCompatible', () => {
  let tmpRoot: string
  let deployDir: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'hwui-installer-spy-'))
    deployDir = join(tmpRoot, 'deploy')
    mkdirSync(deployDir, { recursive: true })
    mkdirSync(join(deployDir, 'scripts'), { recursive: true })
    writeFileSync(join(deployDir, 'scripts', 'install-device-package.sh'), '#!/usr/bin/env bash\n')
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('is a no-op when the manifest does not declare a fingerprint', () => {
    expect(() => assertInstallerScriptCompatible(deployDir, createManifest())).not.toThrow()
  })

  it('passes when the on-disk installer matches the manifest fingerprint', () => {
    const scriptPath = join(deployDir, 'scripts', 'install-device-package.sh')
    const sha = createHash('sha256').update(readFileSync(scriptPath)).digest('hex')
    const manifest = createManifest({ installerScriptSha256: sha })

    expect(() => assertInstallerScriptCompatible(deployDir, manifest)).not.toThrow()
  })

  it('throws update_installer_script_stale when the fingerprint mismatches', () => {
    const manifest = createManifest({ installerScriptSha256: 'a'.repeat(64) })

    try {
      assertInstallerScriptCompatible(deployDir, manifest)
      throw new Error('expected assertInstallerScriptCompatible to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(UpdateError)
      expect((err as UpdateError).code).toBe('update_installer_script_stale')
      expect((err as UpdateError).status).toBe(409)
      expect((err as UpdateError).details).toMatchObject({
        deployDir,
        installerScriptPath: 'scripts/install-device-package.sh',
        expectedSha256: 'a'.repeat(64),
      })
    }
  })

  it('throws update_installer_script_missing when the script does not exist on disk', () => {
    rmSync(join(deployDir, 'scripts', 'install-device-package.sh'))
    const manifest = createManifest({ installerScriptSha256: 'b'.repeat(64) })

    try {
      assertInstallerScriptCompatible(deployDir, manifest)
      throw new Error('expected assertInstallerScriptCompatible to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(UpdateError)
      expect((err as UpdateError).code).toBe('update_installer_script_missing')
    }
  })

  it('honours a custom relativePath declared by the manifest', () => {
    const custom = join(deployDir, 'scripts', 'custom-installer.sh')
    writeFileSync(custom, 'echo custom\n')
    const sha = createHash('sha256').update(readFileSync(custom)).digest('hex')

    expect(() => assertInstallerScriptCompatible(
      deployDir,
      createManifest({ installerScriptPath: 'scripts/custom-installer.sh', installerScriptSha256: sha }),
    )).not.toThrow()

    try {
      assertInstallerScriptCompatible(
        deployDir,
        createManifest({ installerScriptPath: 'scripts/custom-installer.sh', installerScriptSha256: 'c'.repeat(64) }),
      )
      throw new Error('expected to throw')
    } catch (err) {
      expect((err as UpdateError).code).toBe('update_installer_script_stale')
      expect((err as UpdateError).details).toMatchObject({
        installerScriptPath: 'scripts/custom-installer.sh',
      })
    }
  })

  describe('reconcile environment builder', () => {
    it('builds the reconcile env with --reconcile-env-only flag', () => {
      const cmd = buildDevicePackageReconcileCommand(
        '/opt/hermes-web-ui/scripts/install-device-package.sh',
        createManifest({ version: '0.7.21' }),
        () => '/bin/bash',
      )
      expect(cmd.command).toBe('/bin/bash')
      expect(cmd.args).toEqual([
        '/opt/hermes-web-ui/scripts/install-device-package.sh',
        '--reconcile-env-only',
        '--version', '0.7.21',
      ])
    })

    it('forwards MANIFEST_ENV_JSON in reconcile env when manifest has environment block', () => {
      const env = buildDevicePackageReconcileEnv(
        createUpdateConfig(),
        { PATH: '/usr/bin' },
        createManifest({
          version: '0.7.22',
          environment: {
            requiredNodeRange: '>=23.0.0',
            requiredSystemFiles: [
              { path: 'scripts/install-device-package.sh', kind: 'executable' },
            ],
          },
        }),
        {
          deployDir: '/opt/hermes-web-ui',
          webUiHome: '/var/lib/hermes-web-ui',
          uploadDir: '/var/lib/hermes-web-ui/uploads',
          hermesHome: '',
        },
        'task-reconcile',
      )
      expect(env.HERMES_WEB_UI_UPDATE_VERSION).toBe('0.7.22')
      expect(env.HERMES_WEB_UI_UPDATE_TASK_ID).toBe('task-reconcile')
      expect(env.HERMES_WEB_UI_STATE_DIR).toBe('/var/lib/hermes-web-ui')
      expect(env.HERMES_WEB_UI_UPDATE_AUTO_INSTALL_DEPENDENCIES).toBe('false')
      expect(env.HERMES_WEB_UI_UPDATE_INCLUDE_AGENT_UPGRADE).toBe('false')
      expect(env.HERMES_WEB_UI_UPDATE_PACKAGE_ARCHIVE).toBeUndefined()
      const parsed = JSON.parse(env.HERMES_WEB_UI_UPDATE_MANIFEST_ENV_JSON)
      expect(parsed.requiredNodeRange).toBe('>=23.0.0')
      expect(parsed.requiredSystemFiles[0]).toEqual({
        path: 'scripts/install-device-package.sh',
        kind: 'executable',
      })
    })

    it('emits empty MANIFEST_ENV_JSON object when manifest has no environment block', () => {
      const env = buildDevicePackageReconcileEnv(
        createUpdateConfig(),
        { PATH: '/usr/bin' },
        createManifest({ version: '0.7.23' }),
        {
          deployDir: '/opt/hermes-web-ui',
          webUiHome: '/var/lib/hermes-web-ui',
          uploadDir: '/var/lib/hermes-web-ui/uploads',
          hermesHome: '',
        },
        'task-empty',
      )
      expect(env.HERMES_WEB_UI_UPDATE_MANIFEST_ENV_JSON).toBe('{}')
    })

    it('does NOT include MANIFEST_ENV_JSON in normal install env', () => {
      const env = buildDevicePackageInstallEnv(
        createUpdateConfig(),
        { PATH: '/usr/bin' },
        createManifest({
          version: '0.7.24',
          environment: {
            requiredNodeRange: '>=23.0.0',
          },
        }),
        '/tmp/art.tar.gz',
        {
          deployDir: '/opt/hermes-web-ui',
          webUiHome: '/var/lib/hermes-web-ui',
          uploadDir: '/var/lib/hermes-web-ui/uploads',
          hermesHome: '',
        },
        'task-install',
      )
      expect(env.HERMES_WEB_UI_UPDATE_MANIFEST_ENV_JSON).toBeUndefined()
    })
  })
})
