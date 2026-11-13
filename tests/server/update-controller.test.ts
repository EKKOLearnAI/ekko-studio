import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'crypto'
import { delimiter, dirname, join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { Writable } from 'stream'

const UPDATE_PACKAGE = '@quanthermes/hermes-web-ui'
const UPDATE_REGISTRY = 'https://registry.npmjs.org'
const UPDATE_CLI_BIN = 'hermes-web-ui.mjs'
const UPDATE_SCRIPT = '/opt/hermes-web-ui/scripts/update-source-deploy.sh'
const PUBLISHED_VERSION = '0.6.13'
const WINDOWS_BASH_PATH = 'C:\\Program Files\\Git\\bin\\bash.exe'

type UpdateControllerMocks = {
  execFile: ReturnType<typeof vi.fn>
  execFileSync: ReturnType<typeof vi.fn>
  spawn: ReturnType<typeof vi.fn>
  unref: ReturnType<typeof vi.fn>
  existsSync: ReturnType<typeof vi.fn>
  readFileSync: ReturnType<typeof vi.fn>
  writeFileSync: ReturnType<typeof vi.fn>
  renameSync: ReturnType<typeof vi.fn>
  unlinkSync: ReturnType<typeof vi.fn>
  appendFileSync: ReturnType<typeof vi.fn>
}

type LoadUpdateControllerOptions = Partial<UpdateControllerMocks> & {
  isDocker?: boolean
}

async function loadUpdateController(overrides: LoadUpdateControllerOptions = {}) {
  const execFile = overrides.execFile ?? vi.fn((_command: string, _args: string[], _options: any, callback: any) => callback(null, '', ''))
  const execFileSync = overrides.execFileSync ?? vi.fn((command: string, args?: string[]) => {
    if (command === 'where.exe' && (args?.[0] === 'bash' || args?.[0] === 'bash.exe')) {
      return `${WINDOWS_BASH_PATH}\r\n`
    }
    if (command === 'which' && args?.[0] === 'bash') {
      return '/bin/bash\n'
    }
    return 'updated'
  })
  const unref = overrides.unref ?? vi.fn()
  const spawn = overrides.spawn ?? vi.fn(() => ({ unref, on: vi.fn() }))
  const existsSync = overrides.existsSync ?? vi.fn(() => true)
  const readFileSync = overrides.readFileSync ?? vi.fn(() => JSON.stringify({
    name: 'hermes-web-ui',
    version: '0.0.0',
    repository: { url: 'https://github.com/EKKOLearnAI/hermes-studio.git' },
  }))
  const writeFileSync = overrides.writeFileSync ?? vi.fn()
  const renameSync = overrides.renameSync ?? vi.fn()
  const unlinkSync = overrides.unlinkSync ?? vi.fn()
  const appendFileSync = overrides.appendFileSync ?? vi.fn()

  vi.resetModules()
  vi.doMock('child_process', () => ({ execFile, execFileSync, spawn }))
  vi.doMock('fs', () => ({
    appendFileSync,
    accessSync: vi.fn(),
    constants: { W_OK: 2 },
    readdirSync: vi.fn(() => []),
    statfsSync: vi.fn(() => ({ bsize: 4096, bavail: 10_000_000 })),
    closeSync: vi.fn(),
    createWriteStream: vi.fn(() => new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
    })),
    existsSync,
    mkdirSync: vi.fn(),
    openSync: vi.fn(() => 1),
    readFileSync,
    renameSync,
    rmSync: vi.fn(),
    unlinkSync,
    writeFileSync,
  }))
  vi.doMock('../../packages/server/src/modules/studio/public/runtime-environment', () => ({
    isDockerContainer: () => overrides.isDocker === true,
  }))

  const mod = await import('../../packages/server/src/modules/studio/controllers/update')
  return {
    ...mod,
    mocks: { execFile, execFileSync, spawn, unref, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, appendFileSync },
  }
}

function createMockCtx() {
  return {
    status: 200,
    body: null as unknown,
  }
}

function createStatefulFsMocks(initialState?: unknown): Partial<UpdateControllerMocks> & { getState: () => string } {
  let stateFileContents = initialState ? JSON.stringify(initialState) : ''
  let tempStateContents = ''
  const packageJson = JSON.stringify({
    name: 'hermes-web-ui',
    version: '0.6.10',
    repository: { url: 'https://github.com/EKKOLearnAI/hermes-web-ui.git' },
  })

  return {
    existsSync: vi.fn((filePath: string) => {
      const normalized = String(filePath)
      if (normalized.endsWith('update-task-state.json')) return Boolean(stateFileContents)
      if (normalized.endsWith('update-task-state.json.tmp')) return Boolean(tempStateContents)
      return true
    }),
    readFileSync: vi.fn((filePath: string) => {
      const normalized = String(filePath)
      if (normalized.endsWith('update-task-state.json')) return stateFileContents
      if (normalized.endsWith('update-task-state.json.tmp')) return tempStateContents
      if (normalized.endsWith('package.json')) return packageJson
      return ''
    }),
    writeFileSync: vi.fn((filePath: string, content: string) => {
      if (String(filePath).endsWith('update-task-state.json.tmp')) {
        tempStateContents = String(content)
      }
    }),
    renameSync: vi.fn((fromPath: string, toPath: string) => {
      if (String(fromPath).endsWith('update-task-state.json.tmp') && String(toPath).endsWith('update-task-state.json')) {
        stateFileContents = tempStateContents
        tempStateContents = ''
      }
    }),
    unlinkSync: vi.fn((filePath: string) => {
      if (String(filePath).endsWith('update-task-state.json')) {
        stateFileContents = ''
      }
    }),
    getState: () => stateFileContents,
  }
}

function getNodeBinDir() {
  return dirname(process.execPath)
}

function getNodePrefix() {
  return process.platform === 'win32' ? getNodeBinDir() : dirname(getNodeBinDir())
}

function getNpmCliPath() {
  const prefix = getNodePrefix()
  return process.platform === 'win32'
    ? join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
}

function getGlobalCliScript(prefix: string) {
  return process.platform === 'win32'
    ? join(prefix, 'node_modules', '@quanthermes', 'hermes-web-ui', 'bin', UPDATE_CLI_BIN)
    : join(prefix, 'lib', 'node_modules', '@quanthermes', 'hermes-web-ui', 'bin', UPDATE_CLI_BIN)
}

describe('update controller', () => {
  const originalPort = process.env.PORT
  const originalUpdateEnabled = process.env.WEBUI_UPDATE_ENABLED
  const originalUpdatePackage = process.env.WEBUI_UPDATE_PACKAGE
  const originalUpdateRegistry = process.env.WEBUI_UPDATE_REGISTRY
  const originalUpdateCliBin = process.env.WEBUI_UPDATE_CLI_BIN
  const originalUpdateStrategy = process.env.WEBUI_UPDATE_STRATEGY
  const originalUpdateScript = process.env.WEBUI_UPDATE_SCRIPT
  const originalWebUiHome = process.env.HERMES_WEB_UI_HOME
  const originalWebUiStateDir = process.env.HERMES_WEBUI_STATE_DIR
  const originalUploadDir = process.env.UPLOAD_DIR
  const originalHermesHome = process.env.HERMES_HOME
  const originalHermesHomeDir = process.env.HERMES_HOME_DIR
  const originalUpdateManifestUrl = process.env.WEBUI_UPDATE_MANIFEST_URL
  const originalUpdateManifestBaseUrl = process.env.WEBUI_UPDATE_MANIFEST_BASE_URL
  const originalUpdateInstallerScript = process.env.WEBUI_UPDATE_INSTALLER_SCRIPT
  const originalUpdateRunnerService = process.env.WEBUI_UPDATE_RUNNER_SERVICE
  const originalUpdateRunnerRequestFile = process.env.WEBUI_UPDATE_RUNNER_REQUEST_FILE
  const originalUpdatePackageType = process.env.WEBUI_UPDATE_PACKAGE_TYPE
  const originalUpdateChannel = process.env.WEBUI_UPDATE_CHANNEL
  const originalUpdateManifestTimeoutMs = process.env.WEBUI_UPDATE_MANIFEST_TIMEOUT_MS
  const originalUpdatePackageTimeoutMs = process.env.WEBUI_UPDATE_PACKAGE_TIMEOUT_MS
  const originalUpdateDownloadRetries = process.env.WEBUI_UPDATE_DOWNLOAD_RETRIES
  const originalUpdateDownloadRetryDelayMs = process.env.WEBUI_UPDATE_DOWNLOAD_RETRY_DELAY_MS
  const originalIncludeAgentUpgrade = process.env.WEBUI_UPDATE_INCLUDE_AGENT_UPGRADE
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    process.env.WEBUI_UPDATE_ENABLED = 'true'
    process.env.WEBUI_UPDATE_PACKAGE = UPDATE_PACKAGE
    process.env.WEBUI_UPDATE_REGISTRY = UPDATE_REGISTRY
    process.env.WEBUI_UPDATE_CLI_BIN = UPDATE_CLI_BIN
    delete process.env.WEBUI_UPDATE_STRATEGY
    delete process.env.WEBUI_UPDATE_SCRIPT
    // Own writable state home per test: deleting the env vars makes config
    // fall back to homedir(), which is NOT writable on CI runners — the
    // Linux-only writable preflight then rejects every handleUpdate with
    // update_dangerous_layout 409 (20-test cascade). See
    // packages/server/src/modules/studio/services/update/preflight.ts.
    process.env.HERMES_WEB_UI_HOME = mkdtempSync(join(tmpdir(), 'update-controller-home-'))
    process.env.HERMES_WEBUI_STATE_DIR = process.env.HERMES_WEB_UI_HOME
    delete process.env.UPLOAD_DIR
    delete process.env.HERMES_HOME
    delete process.env.HERMES_HOME_DIR
    delete process.env.WEBUI_UPDATE_MANIFEST_URL
    delete process.env.WEBUI_UPDATE_MANIFEST_BASE_URL
    delete process.env.WEBUI_UPDATE_INSTALLER_SCRIPT
    delete process.env.WEBUI_UPDATE_RUNNER_SERVICE
    delete process.env.WEBUI_UPDATE_RUNNER_REQUEST_FILE
    delete process.env.WEBUI_UPDATE_PACKAGE_TYPE
    delete process.env.WEBUI_UPDATE_CHANNEL
    delete process.env.WEBUI_UPDATE_MANIFEST_TIMEOUT_MS
    delete process.env.WEBUI_UPDATE_PACKAGE_TIMEOUT_MS
    delete process.env.WEBUI_UPDATE_DOWNLOAD_RETRIES
    delete process.env.WEBUI_UPDATE_DOWNLOAD_RETRY_DELAY_MS
    delete process.env.WEBUI_UPDATE_INCLUDE_AGENT_UPGRADE
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        version: PUBLISHED_VERSION,
        'dist-tags': { latest: PUBLISHED_VERSION },
      }),
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    if (typeof process.env.HERMES_WEB_UI_HOME === 'string' && process.env.HERMES_WEB_UI_HOME.includes('update-controller-home-')) {
      rmSync(process.env.HERMES_WEB_UI_HOME, { recursive: true, force: true })
    }
    vi.doUnmock('child_process')
    vi.doUnmock('fs')
    vi.doUnmock('../../packages/server/src/modules/studio/public/runtime-environment')
    vi.unstubAllGlobals()
    if (originalPort === undefined) {
      delete process.env.PORT
    } else {
      process.env.PORT = originalPort
    }
    if (originalUpdateEnabled === undefined) delete process.env.WEBUI_UPDATE_ENABLED
    else process.env.WEBUI_UPDATE_ENABLED = originalUpdateEnabled
    if (originalUpdatePackage === undefined) delete process.env.WEBUI_UPDATE_PACKAGE
    else process.env.WEBUI_UPDATE_PACKAGE = originalUpdatePackage
    if (originalUpdateRegistry === undefined) delete process.env.WEBUI_UPDATE_REGISTRY
    else process.env.WEBUI_UPDATE_REGISTRY = originalUpdateRegistry
    if (originalUpdateCliBin === undefined) delete process.env.WEBUI_UPDATE_CLI_BIN
    else process.env.WEBUI_UPDATE_CLI_BIN = originalUpdateCliBin
    if (originalUpdateStrategy === undefined) delete process.env.WEBUI_UPDATE_STRATEGY
    else process.env.WEBUI_UPDATE_STRATEGY = originalUpdateStrategy
    if (originalUpdateScript === undefined) delete process.env.WEBUI_UPDATE_SCRIPT
    else process.env.WEBUI_UPDATE_SCRIPT = originalUpdateScript
    if (originalWebUiHome === undefined) delete process.env.HERMES_WEB_UI_HOME
    else process.env.HERMES_WEB_UI_HOME = originalWebUiHome
    if (originalWebUiStateDir === undefined) delete process.env.HERMES_WEBUI_STATE_DIR
    else process.env.HERMES_WEBUI_STATE_DIR = originalWebUiStateDir
    if (originalUploadDir === undefined) delete process.env.UPLOAD_DIR
    else process.env.UPLOAD_DIR = originalUploadDir
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (originalHermesHomeDir === undefined) delete process.env.HERMES_HOME_DIR
    else process.env.HERMES_HOME_DIR = originalHermesHomeDir
    if (originalUpdateManifestUrl === undefined) delete process.env.WEBUI_UPDATE_MANIFEST_URL
    else process.env.WEBUI_UPDATE_MANIFEST_URL = originalUpdateManifestUrl
    if (originalUpdateManifestBaseUrl === undefined) delete process.env.WEBUI_UPDATE_MANIFEST_BASE_URL
    else process.env.WEBUI_UPDATE_MANIFEST_BASE_URL = originalUpdateManifestBaseUrl
    if (originalUpdateInstallerScript === undefined) delete process.env.WEBUI_UPDATE_INSTALLER_SCRIPT
    else process.env.WEBUI_UPDATE_INSTALLER_SCRIPT = originalUpdateInstallerScript
    if (originalUpdateRunnerService === undefined) delete process.env.WEBUI_UPDATE_RUNNER_SERVICE
    else process.env.WEBUI_UPDATE_RUNNER_SERVICE = originalUpdateRunnerService
    if (originalUpdateRunnerRequestFile === undefined) delete process.env.WEBUI_UPDATE_RUNNER_REQUEST_FILE
    else process.env.WEBUI_UPDATE_RUNNER_REQUEST_FILE = originalUpdateRunnerRequestFile
    if (originalUpdatePackageType === undefined) delete process.env.WEBUI_UPDATE_PACKAGE_TYPE
    else process.env.WEBUI_UPDATE_PACKAGE_TYPE = originalUpdatePackageType
    if (originalUpdateChannel === undefined) delete process.env.WEBUI_UPDATE_CHANNEL
    else process.env.WEBUI_UPDATE_CHANNEL = originalUpdateChannel
    if (originalUpdateManifestTimeoutMs === undefined) delete process.env.WEBUI_UPDATE_MANIFEST_TIMEOUT_MS
    else process.env.WEBUI_UPDATE_MANIFEST_TIMEOUT_MS = originalUpdateManifestTimeoutMs
    if (originalUpdatePackageTimeoutMs === undefined) delete process.env.WEBUI_UPDATE_PACKAGE_TIMEOUT_MS
    else process.env.WEBUI_UPDATE_PACKAGE_TIMEOUT_MS = originalUpdatePackageTimeoutMs
    if (originalUpdateDownloadRetries === undefined) delete process.env.WEBUI_UPDATE_DOWNLOAD_RETRIES
    else process.env.WEBUI_UPDATE_DOWNLOAD_RETRIES = originalUpdateDownloadRetries
    if (originalUpdateDownloadRetryDelayMs === undefined) delete process.env.WEBUI_UPDATE_DOWNLOAD_RETRY_DELAY_MS
    else process.env.WEBUI_UPDATE_DOWNLOAD_RETRY_DELAY_MS = originalUpdateDownloadRetryDelayMs
    if (originalIncludeAgentUpgrade === undefined) delete process.env.WEBUI_UPDATE_INCLUDE_AGENT_UPGRADE
    else process.env.WEBUI_UPDATE_INCLUDE_AGENT_UPGRADE = originalIncludeAgentUpgrade
    delete process.env.HERMES_WEB_UI_PREVIEW_REPO
  })

  it('updates and restarts through the running Node executable, not PATH shims', async () => {
    process.env.PORT = '9129'
    const nodeBinDir = getNodeBinDir()
    const npmCli = getNpmCliPath()
    const globalPrefix = getNodePrefix()
    const cliScript = getGlobalCliScript(globalPrefix)
    const execFileSync = vi.fn((_command: string, args: string[]) => {
      if (args[1] === 'root') {
        return process.platform === 'win32'
          ? join(globalPrefix, 'node_modules')
          : join(globalPrefix, 'lib', 'node_modules')
      }
      return 'updated'
    })
    const { handleUpdate, mocks } = await loadUpdateController({ execFileSync })
    const ctx = createMockCtx()

    await handleUpdate(ctx)

    expect(mocks.execFile).toHaveBeenCalled()
    const execFileCalls = mocks.execFile.mock.calls
    expect(execFileCalls.length).toBeGreaterThan(0)
    const installCall = execFileCalls.find(
      (call: any[]) =>
        call[0] === process.execPath
        && Array.isArray(call[1])
        && call[1][1] === 'install'
        && call[1][2] === '-g'
        && call[1][3] === `${UPDATE_PACKAGE}@${PUBLISHED_VERSION}`,
    )
    expect(installCall).toBeDefined()
    const installOptions = installCall![2]
    expect(installOptions.encoding).toBe('utf-8')
    expect(installOptions.timeout).toBe(10 * 60 * 1000)
    expect(installOptions.windowsHide).toBe(true)
    // npm_node_execpath is set lower-case by getCurrentNodeEnv() but Windows
    // child_process normalises env keys, so accept either casing.
    expect(installOptions.env.npm_node_execpath).toBe(process.execPath)
    expect(typeof installOptions.env.PATH).toBe('string')
    expect(installOptions.env.PATH).toContain(nodeBinDir)
    expect(typeof installCall![3]).toBe('function')
    expect(ctx.body).toEqual(expect.objectContaining({
      success: true,
      message: 'hermes-web-ui updated successfully',
      status: 'running',
      stage: 'restarting',
      taskId: expect.any(String),
    }))

    await vi.runAllTimersAsync()

    expect(mocks.execFileSync).toHaveBeenCalledWith(
      process.execPath,
      [npmCli, 'root', '-g'],
      expect.objectContaining({
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        cwd: expect.any(String),
        env: expect.objectContaining({ npm_node_execpath: process.execPath }),
      }),
    )
    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      [cliScript, 'restart', '--port', '9129'],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: expect.objectContaining({ npm_node_execpath: process.execPath }),
      }),
    )
    expect(mocks.unref).toHaveBeenCalledOnce()
  })

  it('keeps update requests responsive while an update is pending before task persistence', async () => {
    let resolveRegistryFetch: ((value: {
      ok: boolean
      json: () => Promise<{ version: string; 'dist-tags': { latest: string } }>
    }) => void) | null = null
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => new AbortController().signal)
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => {
      resolveRegistryFetch = resolve
    })))
    const npmCli = getNpmCliPath()
    const { handleUpdate, mocks } = await loadUpdateController()
    const first = createMockCtx()
    const second = createMockCtx()

    const firstUpdate = handleUpdate(first)
    await Promise.resolve()
    await handleUpdate(second)

    expect(resolveRegistryFetch).toBeTypeOf('function')
    expect(second.status).toBe(409)
    expect(second.body).toEqual(expect.objectContaining({
      success: false,
      code: 'update_already_in_progress',
      message: `${UPDATE_PACKAGE} update is already in progress`,
    }))
    expect(mocks.execFileSync).not.toHaveBeenCalledWith(
      process.execPath,
      [npmCli, 'install', '-g', `${UPDATE_PACKAGE}@${PUBLISHED_VERSION}`, '--registry', UPDATE_REGISTRY, '--ignore-scripts', '--no-audit', '--no-fund'],
      expect.any(Object),
    )

    resolveRegistryFetch?.({
      ok: true,
      json: async () => ({
        version: PUBLISHED_VERSION,
        'dist-tags': { latest: PUBLISHED_VERSION },
      }),
    })
    await firstUpdate

    expect(first.body).toEqual(expect.objectContaining({
      success: true,
      status: 'running',
      stage: 'restarting',
      taskId: expect.any(String),
    }))
  })

  it('falls back to the default port when PORT is not set', async () => {
    delete process.env.PORT
    const { handleUpdate, mocks } = await loadUpdateController()
    const ctx = createMockCtx()

    await handleUpdate(ctx)
    await vi.runAllTimersAsync()

    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      [expect.any(String), 'restart', '--port', '6060'],
      expect.objectContaining({ detached: true, stdio: 'ignore', windowsHide: true }),
    )
  })

  it('rejects updates when the update source is not fully configured', async () => {
    delete process.env.WEBUI_UPDATE_REGISTRY
    const { handleUpdate, mocks } = await loadUpdateController()
    const ctx = createMockCtx()

    await handleUpdate(ctx)

    expect(ctx.status).toBe(500)
    expect(ctx.body).toEqual({
      success: false,
      code: 'update_execution_misconfigured',
      message: 'Update source is not fully configured. Set WEBUI_UPDATE_PACKAGE, WEBUI_UPDATE_REGISTRY, and WEBUI_UPDATE_CLI_BIN.',
    })
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('requires WEBUI_UPDATE_SCRIPT for source deployment updates', async () => {
    process.env.WEBUI_UPDATE_STRATEGY = 'source-deploy'
    delete process.env.WEBUI_UPDATE_SCRIPT
    const { handleUpdate, mocks } = await loadUpdateController()
    const ctx = createMockCtx()

    await handleUpdate(ctx)

    expect(ctx.status).toBe(500)
    expect(ctx.body).toEqual({
      success: false,
      message: 'Update source is not fully configured. Set WEBUI_UPDATE_PACKAGE, WEBUI_UPDATE_REGISTRY, WEBUI_UPDATE_SCRIPT, and WEBUI_UPDATE_RUNNER_SERVICE.',
    })
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  // Branded builds always configure manifest base URL, installer script and
  // runner service defaults, so the "execution not configured" guard can never
  // fire for device-package updates. Keep the test as documentation only.
  it.skip('requires device package execution settings for device-package updates', async () => {
    process.env.WEBUI_UPDATE_STRATEGY = 'device-package'
    process.env.WEBUI_UPDATE_PACKAGE_TYPE = 'device-package'
    process.env.WEBUI_UPDATE_CHANNEL = 'stable'
    delete process.env.WEBUI_UPDATE_MANIFEST_URL
    delete process.env.WEBUI_UPDATE_MANIFEST_BASE_URL
    const { handleUpdate, mocks } = await loadUpdateController()
    const ctx = createMockCtx()

    await handleUpdate(ctx)

    expect(ctx.status).toBe(500)
    expect(ctx.body).toEqual({
      success: false,
      message: 'Update source is not fully configured. Set WEBUI_UPDATE_MANIFEST_URL or WEBUI_UPDATE_MANIFEST_BASE_URL, WEBUI_UPDATE_INSTALLER_SCRIPT, and WEBUI_UPDATE_RUNNER_SERVICE.',
    })
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('starts the device package installer after manifest download and checksum verification', async () => {
    process.env.WEBUI_UPDATE_STRATEGY = 'device-package'
    process.env.WEBUI_UPDATE_MANIFEST_URL = 'https://updates.example.com/stable/manifest.json'
    process.env.WEBUI_UPDATE_INSTALLER_SCRIPT = '/opt/hermes-web-ui/scripts/install-device-package.sh'
    process.env.WEBUI_UPDATE_PACKAGE_TYPE = 'device-package'
    process.env.WEBUI_UPDATE_CHANNEL = 'stable'
    const packageBuffer = Buffer.from('device package archive bytes')
    const sha256 = createHash('sha256').update(packageBuffer).digest('hex')
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        url: 'https://updates.example.com/stable/manifest.json',
        arrayBuffer: async () => Buffer.from(JSON.stringify({
          version: PUBLISHED_VERSION,
          channel: 'stable',
          sourceLabel: 'Device Manifest',
          packageType: 'device-package',
          artifactFormat: 'tar.gz',
          packageUrl: 'https://updates.example.com/releases/v0.6.13/hermes-web-ui-device-v0.6.13.tar.gz',
          sha256,
          releasedAt: '2026-06-09T00:00:00Z',
          compatibleNodeRange: `>=${process.versions.node}`,
          minCurrentVersion: '0.6.10',
        })),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        url: 'https://updates.example.com/releases/v0.6.13/hermes-web-ui-device-v0.6.13.tar.gz',
        arrayBuffer: async () => packageBuffer,
      }))
    const readFileSync = vi.fn((filePath: string) => {
      if (String(filePath).endsWith('.tar.gz')) return packageBuffer
      return JSON.stringify({
        name: 'hermes-web-ui',
        version: '0.6.10',
        repository: { url: 'https://github.com/EKKOLearnAI/hermes-web-ui.git' },
      })
    })
    const { handleUpdate, updateStatus, mocks } = await loadUpdateController({ readFileSync })
    const ctx = createMockCtx()
    const statusCtx = createMockCtx()

    await handleUpdate(ctx)
    for (let index = 0; index < 30 && mocks.spawn.mock.calls.length === 0; index += 1) {
      await updateStatus(statusCtx)
      await Promise.resolve()
    }

    expect(ctx.body).toEqual(expect.objectContaining({
      success: true,
      status: 'running',
      stage: 'starting',
      taskId: expect.any(String),
      currentTask: expect.objectContaining({
        strategy: 'device-package',
        stage: 'starting',
        targetVersion: PUBLISHED_VERSION,
      }),
    }))
    const requestCall = mocks.writeFileSync.mock.calls.find(call => String(call[0]).endsWith('update-runner-request.json'))
    expect(requestCall).toBeDefined()
    expect(JSON.parse(String(requestCall?.[1]))).toEqual(expect.objectContaining({
      strategy: 'device-package',
      env: expect.objectContaining({
        HERMES_WEB_UI_UPDATE_TASK_ID: expect.any(String),
        HERMES_WEB_UI_UPDATE_VERSION: PUBLISHED_VERSION,
        HERMES_WEB_UI_UPDATE_EXPECTED_SHA256: sha256,
        HERMES_WEB_UI_UPDATE_INCLUDE_AGENT_UPGRADE: 'false',
      }),
    }))
    expect(mocks.spawn).toHaveBeenCalledWith(
      'sudo',
      ['-n', 'systemctl', 'start', 'hermes-web-ui-update.service'],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: expect.objectContaining({ npm_node_execpath: process.execPath }),
      }),
    )
    expect(mocks.execFile).not.toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(['install', '-g', `${UPDATE_PACKAGE}@${PUBLISHED_VERSION}`]),
      expect.anything(),
      expect.any(Function),
    )
  })

  it('refuses the device package update when the on-disk installer does not match the manifest fingerprint', async () => {
    process.env.WEBUI_UPDATE_STRATEGY = 'device-package'
    process.env.WEBUI_UPDATE_MANIFEST_URL = 'https://updates.example.com/stable/manifest.json'
    process.env.WEBUI_UPDATE_INSTALLER_SCRIPT = '/opt/hermes-web-ui/scripts/install-device-package.sh'
    process.env.WEBUI_UPDATE_PACKAGE_TYPE = 'device-package'
    process.env.WEBUI_UPDATE_CHANNEL = 'stable'

    const onDiskScript = '#!/usr/bin/env bash\necho old\n'
    const onDiskSha = createHash('sha256').update(onDiskScript).digest('hex')
    const manifestSha = 'f'.repeat(64)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://updates.example.com/stable/manifest.json',
      arrayBuffer: async () => Buffer.from(JSON.stringify({
        version: PUBLISHED_VERSION,
        channel: 'stable',
        sourceLabel: 'Device Manifest',
        packageType: 'device-package',
        artifactFormat: 'tar.gz',
        packageUrl: 'https://updates.example.com/releases/v0.6.13/hermes-web-ui-device-v0.6.13.tar.gz',
        sha256: 'a'.repeat(64),
        releasedAt: '2026-06-09T00:00:00Z',
        compatibleNodeRange: `>=${process.versions.node}`,
        minCurrentVersion: '0.6.10',
        installerScriptPath: 'scripts/install-device-package.sh',
        installerScriptSha256: manifestSha,
      })),
    }))

    const readFileSync = vi.fn((filePath: string) => {
      if (String(filePath).endsWith('package.json')) {
        return JSON.stringify({
          name: 'hermes-web-ui',
          version: '0.6.10',
          repository: { url: 'https://github.com/EKKOLearnAI/hermes-web-ui.git' },
        })
      }
      if (String(filePath).endsWith('install-device-package.sh')) {
        return onDiskScript
      }
      return ''
    })
    const { handleUpdate, updateStatus, mocks } = await loadUpdateController({ readFileSync })
    const ctx = createMockCtx()
    const statusCtx = createMockCtx()

    await handleUpdate(ctx)
    for (let index = 0; index < 10; index += 1) {
      await updateStatus(statusCtx)
      await Promise.resolve()
    }

    expect(ctx.body).toEqual(expect.objectContaining({
      success: false,
      message: expect.stringContaining('install script is out of date'),
    }))
    expect(ctx.status).toBe(409)
    expect(mocks.spawn).not.toHaveBeenCalledWith(
      'sudo',
      expect.arrayContaining(['systemctl', 'start', 'hermes-web-ui-update.service']),
      expect.anything(),
    )

    const requestCall = mocks.writeFileSync.mock.calls.find(call => String(call[0]).endsWith('update-runner-request.json'))
    expect(requestCall).toBeUndefined()

    expect(onDiskSha).not.toBe(manifestSha)
  })

  it('fails the source deployment task when the managed update service cannot be started', async () => {
    process.env.WEBUI_UPDATE_STRATEGY = 'source-deploy'
    process.env.WEBUI_UPDATE_SCRIPT = UPDATE_SCRIPT
    // Branded builds always have a default manifest base URL, so the
    // source-deploy flow performs a manifest lookup first. Provide a valid
    // source-deploy manifest response to keep the flow offline.
    const sourceSha256 = createHash('sha256').update('source archive bytes').digest('hex')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://updates.example.com/stable/latest.json',
      arrayBuffer: async () => Buffer.from(JSON.stringify({
        version: PUBLISHED_VERSION,
        channel: 'stable',
        sourceLabel: 'Source Manifest',
        packageType: 'source-deploy',
        artifactFormat: 'tar.gz',
        sourceUrl: 'https://updates.example.com/releases/v0.6.13/hermes-web-ui-source-v0.6.13.tar.gz',
        sourceSha256,
        releasedAt: '2026-06-09T00:00:00Z',
        compatibleNodeRange: `>=${process.versions.node}`,
        minCurrentVersion: '0.6.10',
      })),
    }))
    const fsMocks = createStatefulFsMocks()
    const spawn = vi.fn(() => { throw new Error('sudo unavailable') })
    const { handleUpdate, updateStatus, mocks } = await loadUpdateController({ ...fsMocks, spawn })
    const ctx = createMockCtx()
    const statusCtx = createMockCtx()

    await handleUpdate(ctx)
    vi.runAllTimers()
    await updateStatus(statusCtx)

    expect(mocks.spawn).toHaveBeenCalled()
    expect(statusCtx.body).toEqual({
      currentTask: null,
      lastTask: expect.objectContaining({
        status: 'failed',
        stage: 'failed',
        error: 'sudo unavailable',
      }),
      webui_version: '0.6.10',
      webui_latest: '',
      webui_update_available: false,
    })
  })

  it('keeps the device package task running when the detached launcher exits after handing off to runtime', async () => {
    process.env.WEBUI_UPDATE_STRATEGY = 'device-package'
    process.env.WEBUI_UPDATE_MANIFEST_URL = 'https://updates.example.com/stable/manifest.json'
    process.env.WEBUI_UPDATE_INSTALLER_SCRIPT = '/opt/hermes-web-ui/scripts/install-device-package.sh'
    process.env.WEBUI_UPDATE_PACKAGE_TYPE = 'device-package'
    process.env.WEBUI_UPDATE_CHANNEL = 'stable'
    const handlers = new Map<string, (...args: any[]) => void>()
    const fsMocks = createStatefulFsMocks()
    const unref = vi.fn()
    const updateChild = {
      unref,
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers.set(event, handler)
        return updateChild
      }),
    }
    const spawn = vi.fn(() => updateChild)
    const packageBuffer = Buffer.from('device package archive bytes')
    const sha256 = createHash('sha256').update(packageBuffer).digest('hex')
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        url: 'https://updates.example.com/stable/manifest.json',
        arrayBuffer: async () => Buffer.from(JSON.stringify({
          version: PUBLISHED_VERSION,
          channel: 'stable',
          sourceLabel: 'Device Manifest',
          packageType: 'device-package',
          artifactFormat: 'tar.gz',
          packageUrl: 'https://updates.example.com/releases/v0.6.13/hermes-web-ui-device-v0.6.13.tar.gz',
          sha256,
          releasedAt: '2026-06-09T00:00:00Z',
          compatibleNodeRange: `>=${process.versions.node}`,
          minCurrentVersion: '0.6.10',
        })),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        url: 'https://updates.example.com/releases/v0.6.13/hermes-web-ui-device-v0.6.13.tar.gz',
        arrayBuffer: async () => packageBuffer,
      }))
    const readFileSync = vi.fn((filePath: string) => {
      if (String(filePath).endsWith('update-task-state.json')) {
        return fsMocks.readFileSync!(filePath)
      }
      if (String(filePath).endsWith('.tar.gz')) return packageBuffer
      if (String(filePath).endsWith('package.json')) {
        return fsMocks.readFileSync!(filePath)
      }
      return ''
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { handleUpdate, updateStatus } = await loadUpdateController({ ...fsMocks, spawn, unref, readFileSync })
    const ctx = createMockCtx()
    const statusCtx = createMockCtx()

    await handleUpdate(ctx)
    handlers.get('exit')?.(null, 'SIGINT')
    await updateStatus(statusCtx)

    expect(statusCtx.body).toEqual({
      currentTask: expect.objectContaining({
        strategy: 'device-package',
        status: 'running',
        stage: 'starting',
        owner: 'runtime',
        targetVersion: PUBLISHED_VERSION,
      }),
      lastTask: null,
      webui_version: '0.6.10',
      webui_latest: '',
      webui_update_available: false,
    })
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('keeps the source deployment task running when the detached launcher exits after handing off to runtime', async () => {
    process.env.WEBUI_UPDATE_STRATEGY = 'source-deploy'
    process.env.WEBUI_UPDATE_SCRIPT = UPDATE_SCRIPT
    const handlers = new Map<string, (...args: any[]) => void>()
    const fsMocks = createStatefulFsMocks()
    const unref = vi.fn()
    const updateChild = {
      unref,
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers.set(event, handler)
        return updateChild
      }),
    }
    const spawn = vi.fn(() => updateChild)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { handleUpdate, updateStatus } = await loadUpdateController({ ...fsMocks, spawn, unref })
    const ctx = createMockCtx()
    const statusCtx = createMockCtx()

    await handleUpdate(ctx)
    handlers.get('exit')?.(null, 'SIGINT')
    await updateStatus(statusCtx)

    expect(ctx.body).toEqual(expect.objectContaining({
      success: true,
      status: 'running',
      stage: 'starting',
    }))
    expect(statusCtx.body).toEqual({
      currentTask: expect.objectContaining({
        strategy: 'source-deploy',
        status: 'running',
        stage: 'starting',
        targetVersion: PUBLISHED_VERSION,
      }),
      lastTask: null,
      webui_version: '0.6.10',
      webui_latest: '',
      webui_update_available: false,
    })
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('fails the source deployment task when the detached runner exits with a fatal signal', async () => {
    process.env.WEBUI_UPDATE_STRATEGY = 'source-deploy'
    process.env.WEBUI_UPDATE_SCRIPT = UPDATE_SCRIPT
    const handlers = new Map<string, (...args: any[]) => void>()
    const fsMocks = createStatefulFsMocks()
    const unref = vi.fn()
    const updateChild = {
      unref,
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers.set(event, handler)
        return updateChild
      }),
    }
    const spawn = vi.fn(() => updateChild)
    const { handleUpdate, updateStatus } = await loadUpdateController({ ...fsMocks, spawn, unref })
    const ctx = createMockCtx()
    const statusCtx = createMockCtx()

    await handleUpdate(ctx)
    handlers.get('exit')?.(null, 'SIGSEGV')
    await updateStatus(statusCtx)

    expect(statusCtx.body).toEqual({
      currentTask: null,
      lastTask: expect.objectContaining({
        status: 'failed',
        stage: 'failed',
        error: 'managed source deployment update service exited before replacing server: code=null signal=SIGSEGV',
      }),
      webui_version: '0.6.10',
      webui_latest: '',
      webui_update_available: false,
    })
  })

  it('survives 10 managed source deployment handoffs without misclassifying launcher exit as success or failure', async () => {
    process.env.WEBUI_UPDATE_STRATEGY = 'source-deploy'
    process.env.WEBUI_UPDATE_SCRIPT = UPDATE_SCRIPT

    for (let round = 0; round < 10; round += 1) {
      const handlers = new Map<string, (...args: any[]) => void>()
      const fsMocks = createStatefulFsMocks()
      const unref = vi.fn()
      const updateChild = {
        unref,
        on: vi.fn((event: string, handler: (...args: any[]) => void) => {
          handlers.set(event, handler)
          return updateChild
        }),
      }
      const spawn = vi.fn(() => updateChild)
      const { handleUpdate, updateStatus } = await loadUpdateController({ ...fsMocks, spawn, unref })
      const ctx = createMockCtx()
      const statusCtx = createMockCtx()

      await handleUpdate(ctx)
      handlers.get('exit')?.(0, null)
      await updateStatus(statusCtx)

      expect(ctx.body).toEqual(expect.objectContaining({
        success: true,
        status: 'running',
        stage: 'starting',
      }))
      expect(statusCtx.body).toEqual({
        currentTask: expect.objectContaining({
          strategy: 'source-deploy',
          owner: 'runtime',
          status: 'running',
          stage: 'starting',
          targetVersion: PUBLISHED_VERSION,
        }),
        lastTask: null,
        webui_version: '0.6.10',
        webui_latest: '',
        webui_update_available: false,
      })
    }
  })

  it('blocks updates when protected web-ui data would be inside the deploy directory', async () => {
    process.env.HERMES_WEB_UI_HOME = './state'
    const { handleUpdate, mocks } = await loadUpdateController()
    const ctx = createMockCtx()

    await handleUpdate(ctx)

    expect(ctx.status).toBe(409)
    expect(ctx.body).toEqual(expect.objectContaining({
      success: false,
      code: 'update_dangerous_layout',
    }))
    expect(String((ctx.body as any).message)).toContain('Web UI data directory is inside the deploy directory')
    expect(mocks.execFileSync).not.toHaveBeenCalled()
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('returns update task status for the active task', async () => {
    process.env.WEBUI_UPDATE_STRATEGY = 'source-deploy'
    process.env.WEBUI_UPDATE_SCRIPT = UPDATE_SCRIPT
    const fsMocks = createStatefulFsMocks()
    const { handleUpdate, updateStatus } = await loadUpdateController(fsMocks)
    const ctx = createMockCtx()
    const statusCtx = createMockCtx()

    await handleUpdate(ctx)
    await updateStatus(statusCtx)

    expect(statusCtx.body).toEqual({
      currentTask: expect.objectContaining({
        id: expect.any(String),
        strategy: 'source-deploy',
        status: 'running',
        stage: 'starting',
        targetVersion: PUBLISHED_VERSION,
      }),
      lastTask: null,
      webui_version: '0.6.10',
      webui_latest: '',
      webui_update_available: false,
    })
  })

  it('returns update capabilities with preflight details', async () => {
    process.env.WEBUI_UPDATE_STRATEGY = 'device-package'
    process.env.WEBUI_UPDATE_MANIFEST_URL = 'https://updates.example.com/stable/manifest.json'
    process.env.WEBUI_UPDATE_INSTALLER_SCRIPT = '/opt/hermes-web-ui/scripts/install-device-package.sh'
    process.env.WEBUI_UPDATE_PACKAGE_TYPE = 'device-package'
    process.env.WEBUI_UPDATE_CHANNEL = 'stable'
    process.env.WEBUI_UPDATE_MIN_FREE_SPACE_BYTES = '1024'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://updates.example.com/stable/manifest.json',
      arrayBuffer: async () => Buffer.from(JSON.stringify({
        version: PUBLISHED_VERSION,
        channel: 'stable',
        sourceLabel: 'Device Manifest',
        packageType: 'device-package',
      })),
    }))
    const { updateCapabilities } = await loadUpdateController()
    const ctx = createMockCtx()

    await updateCapabilities(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual(expect.objectContaining({
      enabled: true,
      strategy: 'device-package',
      packageType: 'device-package',
      sourceLabel: 'Device Manifest',
      channel: 'stable',
      latestVersion: PUBLISHED_VERSION,
      supports: expect.objectContaining({
        fullPackage: true,
        deltaPackage: false,
        resumableDownload: false,
        checksumVerification: true,
        rollback: true,
      }),
      runtime: expect.objectContaining({
        autoInstallDependencies: true,
        includeAgentUpgrade: false,
      }),
      preflight: expect.objectContaining({
        strategy: 'device-package',
        riskLevel: expect.any(String),
      }),
    }))
  })

  it('loads the persisted update task state from disk when serving status', async () => {
    const persistedState = {
      currentTask: null,
      lastTask: {
        id: 'update-persisted',
        strategy: 'device-package',
        owner: 'controller',
        status: 'failed',
        stage: 'rolled_back',
        message: 'Device package update failed and was rolled back',
        targetVersion: '0.6.13',
        warning: '',
        error: 'health check failed',
        logPath: '/tmp/hermes-update.log',
        rollbackMessage: 'Restored previous deploy from backup',
        healthcheckUrl: 'http://127.0.0.1:6060/health',
        heartbeatAt: '2026-06-09T00:00:00.000Z',
        startedAt: '2026-06-09T00:00:00.000Z',
        finishedAt: '2026-06-09T00:05:00.000Z',
      },
    }
    const existsSync = vi.fn((filePath: string) => String(filePath).endsWith('update-task-state.json'))
    const readFileSync = vi.fn((filePath: string) => {
      if (String(filePath).endsWith('update-task-state.json')) {
        return JSON.stringify(persistedState)
      }
      return ''
    })
    const { updateStatus } = await loadUpdateController({ existsSync, readFileSync })
    const ctx = createMockCtx()

    await updateStatus(ctx)

    expect(ctx.body).toEqual(expect.objectContaining({
      currentTask: persistedState.currentTask,
      lastTask: persistedState.lastTask,
    }))
  })

  it('keeps a runtime-owned running task active when serving status', async () => {
    const fsMocks = createStatefulFsMocks({
      currentTask: {
        id: 'update-running',
        strategy: 'device-package',
        status: 'running',
        stage: 'downloading',
        message: 'Downloading device package 0.6.17',
        targetVersion: '0.6.17',
        warning: '',
        error: '',
        logPath: '',
        rollbackMessage: '',
        healthcheckUrl: 'http://127.0.0.1:6060/health',
        owner: 'runtime',
        heartbeatAt: '2099-06-11T14:35:00.000Z',
        startedAt: '2026-06-11T14:34:00.000Z',
        finishedAt: null,
      },
      lastTask: null,
    })
    const { updateStatus } = await loadUpdateController(fsMocks)
    const ctx = createMockCtx()

    await updateStatus(ctx)

    expect(ctx.body).toEqual({
      currentTask: expect.objectContaining({
        id: 'update-running',
        status: 'running',
        stage: 'downloading',
        targetVersion: '0.6.17',
        owner: 'runtime',
      }),
      lastTask: null,
      webui_version: '0.6.10',
      webui_latest: '',
      webui_update_available: false,
    })
  })

  it('allows a new update request after recovering a persisted running task', async () => {
    process.env.WEBUI_UPDATE_STRATEGY = 'source-deploy'
    process.env.WEBUI_UPDATE_SCRIPT = UPDATE_SCRIPT
    const fsMocks = createStatefulFsMocks({
      currentTask: {
        id: 'update-running',
        strategy: 'device-package',
        status: 'running',
        stage: 'downloading',
        message: 'Downloading device package 0.6.17',
        targetVersion: '0.6.17',
        warning: '',
        error: '',
        logPath: '',
        rollbackMessage: '',
        healthcheckUrl: '',
        startedAt: '2026-06-11T14:34:00.000Z',
        finishedAt: null,
      },
      lastTask: null,
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { handleUpdate } = await loadUpdateController(fsMocks)
    const ctx = createMockCtx()

    await handleUpdate(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual(expect.objectContaining({
      success: true,
      status: 'running',
      stage: 'starting',
      taskId: expect.any(String),
    }))
    warnSpy.mockRestore()
  })

  it('clears recovered interrupted update history through the safe endpoint', async () => {
    const fsMocks = createStatefulFsMocks({
      currentTask: {
        id: 'update-running',
        strategy: 'device-package',
        status: 'running',
        stage: 'downloading',
        message: 'Downloading device package 0.6.17',
        targetVersion: '0.6.17',
        warning: '',
        error: '',
        logPath: '',
        rollbackMessage: '',
        healthcheckUrl: '',
        startedAt: '2026-06-11T14:34:00.000Z',
        finishedAt: null,
      },
      lastTask: null,
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { clearStaleUpdateStatus, updateStatus } = await loadUpdateController(fsMocks)
    const clearCtx = createMockCtx()
    const statusCtx = createMockCtx()

    await clearStaleUpdateStatus(clearCtx)
    await updateStatus(statusCtx)

    expect(clearCtx.body).toEqual({
      success: true,
      clearedTaskId: 'update-running',
      message: 'Recovered interrupted update task state was cleared.',
      currentTask: null,
      lastTask: null,
      webui_version: undefined,
      webui_latest: undefined,
      webui_update_available: undefined,
    })
    expect(statusCtx.body).toEqual({
      currentTask: null,
      lastTask: null,
      webui_version: '0.6.10',
      webui_latest: '',
      webui_update_available: false,
    })
    warnSpy.mockRestore()
  })

  it('clears a stale finished failed update through the safe endpoint', async () => {
    const fsMocks = createStatefulFsMocks({
      currentTask: null,
      lastTask: {
        id: 'update-failed',
        strategy: 'source-deploy',
        status: 'failed',
        stage: 'failed',
        message: 'Failed to start source deployment update 0.6.29.',
        targetVersion: '0.6.29',
        warning: '',
        error: 'managed source deployment update service exited before replacing server: code=null signal=SIGINT',
        logPath: '',
        rollbackMessage: '',
        healthcheckUrl: '',
        startedAt: '2026-07-01T00:00:00.000Z',
        finishedAt: '2026-07-01T00:10:00.000Z',
      },
    })
    const { clearStaleUpdateStatus, updateStatus } = await loadUpdateController(fsMocks)
    const clearCtx = createMockCtx()
    const statusCtx = createMockCtx()

    await clearStaleUpdateStatus(clearCtx)
    await updateStatus(statusCtx)

    expect(clearCtx.body).toEqual({
      success: true,
      clearedTaskId: 'update-failed',
      message: 'Finished update task state was cleared.',
      currentTask: null,
      lastTask: null,
      webui_version: undefined,
      webui_latest: undefined,
      webui_update_available: undefined,
    })
    expect(statusCtx.body).toEqual({
      currentTask: null,
      lastTask: null,
      webui_version: '0.6.10',
      webui_latest: '',
      webui_update_available: false,
    })
  })

  it('does not log a restart error when the restart helper exits successfully', async () => {
    const handlers = new Map<string, (...args: any[]) => void>()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const unref = vi.fn()
    const restart = {
      unref,
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers.set(event, handler)
        return restart
      }),
    }
    const spawn = vi.fn(() => restart)
    const { handleUpdate } = await loadUpdateController({ spawn, unref })
    const ctx = createMockCtx()

    await handleUpdate(ctx)
    await vi.runAllTimersAsync()
    handlers.get('exit')?.(0, null)

    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('treats SIGINT from the restart helper as a successful handoff', async () => {
    const handlers = new Map<string, (...args: any[]) => void>()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fsMocks = createStatefulFsMocks()
    const unref = vi.fn()
    const restart = {
      unref,
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers.set(event, handler)
        return restart
      }),
    }
    const spawn = vi.fn(() => restart)
    const { handleUpdate, updateStatus } = await loadUpdateController({ ...fsMocks, spawn, unref })
    const ctx = createMockCtx()
    const statusCtx = createMockCtx()

    await handleUpdate(ctx)
    await vi.runAllTimersAsync()
    handlers.get('exit')?.(null, 'SIGINT')
    await updateStatus(statusCtx)

    expect(statusCtx.body).toEqual({
      currentTask: expect.objectContaining({
        status: 'running',
        stage: 'restarting',
        message: `Restarting Hermes Web UI after updating to ${PUBLISHED_VERSION}.`,
      }),
      lastTask: null,
      webui_version: '0.6.10',
      webui_latest: '',
      webui_update_available: false,
    })
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('returns a 500 with stderr when installation fails', async () => {
    const execFile = vi.fn((_command: string, args: string[], _options: any, callback: any) => {
      if (args.includes('install') && args.includes(`${UPDATE_PACKAGE}@${PUBLISHED_VERSION}`)) {
        const error = new Error('install failed') as Error & { stderr?: string }
        error.stderr = 'engine mismatch'
        callback(error, '', 'engine mismatch')
        return
      }
      callback(null, '', '')
    })
    const { handleUpdate, mocks } = await loadUpdateController({ execFile })
    const ctx = createMockCtx()

    await handleUpdate(ctx)

    expect(ctx.status).toBe(500)
    expect(ctx.body).toEqual({ success: false, message: 'engine mismatch' })
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('stores the failed task result when installation fails', async () => {
    const fsMocks = createStatefulFsMocks()
    const execFile = vi.fn((_command: string, args: string[], _options: any, callback: any) => {
      if (args.includes('install') && args.includes(`${UPDATE_PACKAGE}@${PUBLISHED_VERSION}`)) {
        const error = new Error('install failed') as Error & { stderr?: string }
        error.stderr = 'engine mismatch'
        callback(error, '', 'engine mismatch')
        return
      }
      callback(null, '', '')
    })
    const { handleUpdate, updateStatus } = await loadUpdateController({ execFile, ...fsMocks })
    const ctx = createMockCtx()
    const statusCtx = createMockCtx()

    await handleUpdate(ctx)
    await updateStatus(statusCtx)

    expect(statusCtx.body).toEqual({
      currentTask: null,
      lastTask: expect.objectContaining({
        status: 'failed',
        stage: 'failed',
        error: 'engine mismatch',
      }),
      webui_version: '0.6.10',
      webui_latest: '',
      webui_update_available: false,
    })
  })

  it('fails the device package task when the managed update service cannot be started', async () => {
    process.env.WEBUI_UPDATE_STRATEGY = 'device-package'
    process.env.WEBUI_UPDATE_MANIFEST_URL = 'https://updates.example.com/stable/manifest.json'
    process.env.WEBUI_UPDATE_INSTALLER_SCRIPT = '/opt/hermes-web-ui/scripts/install-device-package.sh'
    process.env.WEBUI_UPDATE_PACKAGE_TYPE = 'device-package'
    process.env.WEBUI_UPDATE_CHANNEL = 'stable'
    const fsMocks = createStatefulFsMocks()
    const packageBuffer = Buffer.from('device package archive bytes')
    const sha256 = createHash('sha256').update(packageBuffer).digest('hex')
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        url: 'https://updates.example.com/stable/manifest.json',
        arrayBuffer: async () => Buffer.from(JSON.stringify({
          version: PUBLISHED_VERSION,
          channel: 'stable',
          sourceLabel: 'Device Manifest',
          packageType: 'device-package',
          artifactFormat: 'tar.gz',
          packageUrl: 'https://updates.example.com/releases/v0.6.13/hermes-web-ui-device-v0.6.13.tar.gz',
          sha256,
          releasedAt: '2026-06-09T00:00:00Z',
          compatibleNodeRange: `>=${process.versions.node}`,
          minCurrentVersion: '0.6.10',
        })),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        url: 'https://updates.example.com/releases/v0.6.13/hermes-web-ui-device-v0.6.13.tar.gz',
        arrayBuffer: async () => packageBuffer,
      }))
    const readFileSync = vi.fn((filePath: string) => {
      if (String(filePath).endsWith('update-task-state.json')) {
        return fsMocks.readFileSync!(filePath)
      }
      if (String(filePath).endsWith('.tar.gz')) return packageBuffer
      return JSON.stringify({
        name: 'hermes-web-ui',
        version: '0.6.10',
        repository: { url: 'https://github.com/EKKOLearnAI/hermes-web-ui.git' },
      })
    })
    const spawn = vi.fn(() => { throw new Error('sudo unavailable') })
    const { handleUpdate, updateStatus, mocks } = await loadUpdateController({ ...fsMocks, spawn, readFileSync })
    const ctx = createMockCtx()
    const statusCtx = createMockCtx()

    await handleUpdate(ctx)
    for (let index = 0; index < 20; index += 1) {
      await updateStatus(statusCtx)
      if ((statusCtx.body as any)?.lastTask) break
      await Promise.resolve()
    }

    expect(mocks.spawn).toHaveBeenCalled()
    expect(statusCtx.body).toEqual({
      currentTask: null,
      lastTask: expect.objectContaining({
        status: 'failed',
        stage: 'failed',
        error: 'sudo unavailable',
      }),
      webui_version: '0.6.10',
      webui_latest: '',
      webui_update_available: false,
    })
  })

  it('stores network error details when device package download fails before installer start', async () => {
    process.env.WEBUI_UPDATE_STRATEGY = 'device-package'
    process.env.WEBUI_UPDATE_MANIFEST_URL = 'https://updates.example.com/stable/manifest.json'
    process.env.WEBUI_UPDATE_INSTALLER_SCRIPT = '/opt/hermes-web-ui/scripts/install-device-package.sh'
    process.env.WEBUI_UPDATE_PACKAGE_TYPE = 'device-package'
    process.env.WEBUI_UPDATE_CHANNEL = 'stable'
    process.env.WEBUI_UPDATE_MANIFEST_TIMEOUT_MS = '100'
    process.env.WEBUI_UPDATE_PACKAGE_TIMEOUT_MS = '100'
    process.env.WEBUI_UPDATE_DOWNLOAD_RETRIES = '1'
    process.env.WEBUI_UPDATE_DOWNLOAD_RETRY_DELAY_MS = '1'
    const fsMocks = createStatefulFsMocks()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        url: 'https://updates.example.com/stable/manifest.json',
        arrayBuffer: async () => Buffer.from(JSON.stringify({
          version: PUBLISHED_VERSION,
          channel: 'stable',
          sourceLabel: 'Device Manifest',
          packageType: 'device-package',
          artifactFormat: 'tar.gz',
          packageUrl: 'not a valid url',
          sha256: 'a'.repeat(64),
          releasedAt: '2026-06-09T00:00:00Z',
          compatibleNodeRange: `>=${process.versions.node}`,
          minCurrentVersion: '0.6.10',
        })),
      })
      .mockRejectedValue(Object.assign(new TypeError('fetch failed'), { code: 'ETIMEDOUT' })))
    const { handleUpdate, updateStatus, mocks } = await loadUpdateController(fsMocks)
    const ctx = createMockCtx()
    const statusCtx = createMockCtx()

    const updatePromise = handleUpdate(ctx)
    await vi.runAllTimersAsync()
    await updatePromise
    for (let index = 0; index < 20; index += 1) {
      await updateStatus(statusCtx)
      if ((statusCtx.body as any)?.lastTask) break
      await Promise.resolve()
    }

    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(statusCtx.body).toEqual({
      currentTask: null,
      lastTask: expect.objectContaining({
        status: 'failed',
        stage: 'failed',
        message: 'Failed to download device package 0.6.13 from not a valid url.',
        error: expect.stringContaining('"code":"ETIMEDOUT"'),
      }),
      webui_version: '0.6.10',
      webui_latest: '',
      webui_update_available: false,
    })
    expect((statusCtx.body as any).lastTask.error).toContain('"attempts":2')
  })

  it('rejects in-container npm updates with Docker recreation guidance', async () => {
    const { handleUpdate, mocks } = await loadUpdateController({ isDocker: true })
    const ctx = createMockCtx()

    await handleUpdate(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({
      success: false,
      code: 'docker_environment',
      message: expect.stringContaining('docker compose pull'),
    })
    expect(mocks.execFileSync).not.toHaveBeenCalled()
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('loads preview tags through async git with a short timeout', async () => {
    process.env.HERMES_WEB_UI_PREVIEW_REPO = 'https://github.com/EKKOLearnAI/hermes-studio'
    const execFile = vi.fn((_command: string, _args: string[], _options: any, callback: any) => {
      callback(null, [
        'ghi789\trefs/tags/v0.6.9',
        'jkl012\trefs/tags/v0.6.10-beta',
        'abc123\trefs/tags/v0.6.6',
        'def456\trefs/tags/v0.6.10',
        'mno345\trefs/tags/v0.6.28',
        'pqr678\trefs/tags/v0.6.6-linux-desktop-fixes-test-20260530200253',
        'stu901\trefs/tags/0.6.29',
        'vwx234\trefs/tags/v0.6.27',
        'yz0567\trefs/tags/v0.6.26',
        'bcd890\trefs/tags/v0.6.25',
        'efg123\trefs/tags/v0.6.24',
        'hij456\trefs/tags/v0.6.23',
      ].join('\n'), '')
    })
    const execFileSync = vi.fn(() => 'git version 2.0.0')
    const { previewTags, mocks } = await loadUpdateController({ execFile, execFileSync })
    const ctx = createMockCtx()

    await previewTags(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual({
      tags: [
        { name: 'main', sha: '' },
        { name: 'v0.6.28', sha: 'mno345' },
        { name: 'v0.6.27', sha: 'vwx234' },
        { name: 'v0.6.26', sha: 'yz0567' },
        { name: 'v0.6.25', sha: 'bcd890' },
        { name: 'v0.6.24', sha: 'efg123' },
        { name: 'v0.6.23', sha: 'hij456' },
        { name: 'v0.6.10', sha: 'def456' },
        { name: 'v0.6.10-beta', sha: 'jkl012' },
      ],
    })
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['ls-remote', '--tags', '--refs', 'https://github.com/EKKOLearnAI/hermes-studio.git'],
      expect.objectContaining({ timeout: 8000 }),
      expect.any(Function),
    )
  })

  it('falls back to GitHub API when async git tag loading fails', async () => {
    process.env.HERMES_WEB_UI_PREVIEW_REPO = 'https://github.com/EKKOLearnAI/hermes-studio'
    const execFile = vi.fn((_command: string, _args: string[], _options: any, callback: any) => {
      callback(new Error('git timeout'), '', '')
    })
    const execFileSync = vi.fn(() => 'git version 2.0.0')
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [
        { name: 'v0.6.9', commit: { sha: 'ghi789' } },
        { name: 'v0.6.6', commit: { sha: 'abc123' } },
        { name: 'v0.6.10-beta', commit: { sha: 'jkl012' } },
        { name: 'v0.6.28', commit: { sha: 'mno345' } },
        { name: 'v0.6.10', commit: { sha: 'def456' } },
        { name: 'v0.6.6-linux-desktop-fixes-test-20260530200253', commit: { sha: 'pqr678' } },
        { name: '0.6.29', commit: { sha: 'stu901' } },
        { name: 'v0.6.27', commit: { sha: 'vwx234' } },
        { name: 'v0.6.26', commit: { sha: 'yz0567' } },
        { name: 'v0.6.25', commit: { sha: 'bcd890' } },
        { name: 'v0.6.24', commit: { sha: 'efg123' } },
        { name: 'v0.6.23', commit: { sha: 'hij456' } },
      ],
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { previewTags } = await loadUpdateController({ execFile, execFileSync })
    const ctx = createMockCtx()

    await previewTags(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual({
      tags: [
        { name: 'main', sha: '' },
        { name: 'v0.6.28', sha: 'mno345' },
        { name: 'v0.6.27', sha: 'vwx234' },
        { name: 'v0.6.26', sha: 'yz0567' },
        { name: 'v0.6.25', sha: 'bcd890' },
        { name: 'v0.6.24', sha: 'efg123' },
        { name: 'v0.6.23', sha: 'hij456' },
        { name: 'v0.6.10', sha: 'def456' },
        { name: 'v0.6.10-beta', sha: 'jkl012' },
      ],
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/EKKOLearnAI/hermes-studio/tags?per_page=100',
      expect.objectContaining({
        headers: { 'User-Agent': 'hermes-web-ui-preview' },
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it('runs preview npm install through async execFile', async () => {
    const npmCli = getNpmCliPath()
    const execFile = vi.fn((_command: string, _args: string[], _options: any, callback: any) => {
      callback(null, 'installed', '')
    })
    const execFileSync = vi.fn(() => '')
    const { installPreview, mocks } = await loadUpdateController({ execFile, execFileSync })
    const ctx = createMockCtx()

    await installPreview(ctx)

    expect(ctx.status).toBe(202)
    expect((ctx.body as any).success).toBe(true)
    expect((ctx.body as any).accepted).toBe(true)
    expect((ctx.body as any).active_action).toBe('install')
    expect(mocks.execFile).toHaveBeenCalledWith(
      process.execPath,
      [npmCli, 'install', '--include=dev', '--ignore-scripts'],
      expect.objectContaining({
        timeout: 15 * 60 * 1000,
        cwd: expect.any(String),
      }),
      expect.any(Function),
    )
    expect(mocks.execFileSync).not.toHaveBeenCalledWith(
      process.execPath,
      [npmCli, 'install', '--include=dev', '--ignore-scripts'],
      expect.any(Object),
    )
  })

  it('returns noop when reconcile endpoint is hit but manifest has no environment block', async () => {
    process.env.WEBUI_UPDATE_STRATEGY = 'device-package'
    process.env.WEBUI_UPDATE_MANIFEST_URL = 'https://updates.example.com/stable/manifest.json'
    process.env.WEBUI_UPDATE_INSTALLER_SCRIPT = '/opt/hermes-web-ui/scripts/install-device-package.sh'
    process.env.WEBUI_UPDATE_PACKAGE_TYPE = 'device-package'
    process.env.WEBUI_UPDATE_CHANNEL = 'stable'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://updates.example.com/stable/manifest.json',
      arrayBuffer: async () => Buffer.from(JSON.stringify({
        version: PUBLISHED_VERSION,
        channel: 'stable',
        sourceLabel: 'Device Manifest',
        packageType: 'device-package',
        artifactFormat: 'tar.gz',
        packageUrl: 'https://updates.example.com/releases/v0.6.13/hermes-web-ui-device-v0.6.13.tar.gz',
        sha256: 'a'.repeat(64),
        releasedAt: '2026-06-09T00:00:00Z',
        compatibleNodeRange: `>=${process.versions.node}`,
        minCurrentVersion: '0.6.10',
      })),
    }))
    const { reconcileUpdate } = await loadUpdateController()
    const ctx = createMockCtx()
    await reconcileUpdate(ctx)
    expect(ctx.body).toEqual(expect.objectContaining({
      success: true,
      status: 'noop',
    }))
  })

  it('creates a reconciling_env task and launches the installer with --reconcile-env-only', async () => {
    process.env.WEBUI_UPDATE_STRATEGY = 'device-package'
    process.env.WEBUI_UPDATE_MANIFEST_URL = 'https://updates.example.com/stable/manifest.json'
    process.env.WEBUI_UPDATE_INSTALLER_SCRIPT = '/opt/hermes-web-ui/scripts/install-device-package.sh'
    process.env.WEBUI_UPDATE_PACKAGE_TYPE = 'device-package'
    process.env.WEBUI_UPDATE_CHANNEL = 'stable'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://updates.example.com/stable/manifest.json',
      arrayBuffer: async () => Buffer.from(JSON.stringify({
        version: PUBLISHED_VERSION,
        channel: 'stable',
        sourceLabel: 'Device Manifest',
        packageType: 'device-package',
        artifactFormat: 'tar.gz',
        packageUrl: 'https://updates.example.com/releases/v0.6.13/hermes-web-ui-device-v0.6.13.tar.gz',
        sha256: 'b'.repeat(64),
        releasedAt: '2026-06-09T00:00:00Z',
        compatibleNodeRange: `>=${process.versions.node}`,
        minCurrentVersion: '0.6.10',
        environment: {
          requiredNodeRange: `>=${process.versions.node}`,
          requiredSystemFiles: [
            { path: 'scripts/install-device-package.sh', kind: 'executable' },
          ],
        },
      })),
    }))
    const { reconcileUpdate, mocks } = await loadUpdateController()
    const ctx = createMockCtx()

    await reconcileUpdate(ctx)

    expect(ctx.body).toEqual(expect.objectContaining({
      success: true,
      status: 'running',
      taskId: expect.any(String),
      latestVersion: PUBLISHED_VERSION,
    }))
    const requestCall = mocks.writeFileSync.mock.calls.find(call => String(call[0]).endsWith('update-runner-request.json'))
    expect(requestCall).toBeDefined()
    const parsed = JSON.parse(String(requestCall?.[1]))
    expect(parsed.strategy).toBe('device-package')
    expect(parsed.env.HERMES_WEB_UI_UPDATE_VERSION).toBe(PUBLISHED_VERSION)
    expect(parsed.env.HERMES_WEB_UI_UPDATE_INCLUDE_AGENT_UPGRADE).toBe('false')
    expect(parsed.env.HERMES_WEB_UI_UPDATE_AUTO_INSTALL_DEPENDENCIES).toBe('false')
    const manifestEnv = JSON.parse(parsed.env.HERMES_WEB_UI_UPDATE_MANIFEST_ENV_JSON)
    expect(manifestEnv.requiredNodeRange).toBe(`>=${process.versions.node}`)
    expect(mocks.spawn).toHaveBeenCalledWith(
      'sudo',
      ['-n', 'systemctl', 'start', 'hermes-web-ui-update.service'],
      expect.objectContaining({ detached: true }),
    )
  })

  it('refuses reconcile when strategy is not device-package', async () => {
    process.env.WEBUI_UPDATE_STRATEGY = 'npm-package'
    process.env.WEBUI_UPDATE_MANIFEST_URL = ''
    process.env.WEBUI_UPDATE_PACKAGE = 'hermes-web-ui'
    const { reconcileUpdate } = await loadUpdateController()
    const ctx = createMockCtx()
    await reconcileUpdate(ctx)
    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual(expect.objectContaining({
      success: false,
      code: 'update_strategy_unsupported',
    }))
  })

})

async function loadUpdateControllerWithEnvironment(overrides: {
  state?: any
  manifest?: any
  manifestFetchError?: Error
  runEnvironmentCheck?: () => Promise<any>
} = {}) {
  const execFile = vi.fn((_command: string, _args: string[], _options: any, callback: any) => callback(null, '', ''))
  const execFileSync = vi.fn(() => 'updated')
  const unref = vi.fn()
  const spawn = vi.fn(() => ({ unref, on: vi.fn() }))
  const existsSync = vi.fn(() => true)
  const readFileSync = vi.fn(() => JSON.stringify({
    name: 'hermes-web-ui',
    version: '0.0.0',
    repository: { url: 'https://github.com/EKKOLearnAI/hermes-studio.git' },
  }))
  const writeFileSync = vi.fn()
  const renameSync = vi.fn()
  const unlinkSync = vi.fn()
  const appendFileSync = vi.fn()

  vi.resetModules()
  vi.doMock('child_process', () => ({ execFile, execFileSync, spawn }))
  vi.doMock('fs', () => ({
    appendFileSync,
    accessSync: vi.fn(),
    constants: { W_OK: 2 },
    readdirSync: vi.fn(() => []),
    statfsSync: vi.fn(() => ({ bsize: 4096, bavail: 10_000_000 })),
    closeSync: vi.fn(),
    createWriteStream: vi.fn(() => new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
    })),
    existsSync,
    mkdirSync: vi.fn(),
    openSync: vi.fn(() => 1),
    readFileSync,
    renameSync,
    rmSync: vi.fn(),
    unlinkSync,
    writeFileSync,
  }))
  vi.doMock('../../packages/server/src/modules/studio/public/runtime-environment', () => ({
    isDockerContainer: () => false,
  }))

  const state = overrides.state ?? null
  const manifest = overrides.manifest ?? null

  vi.doMock('../../packages/server/src/modules/studio/services/update/reconcile', () => ({
    assertEnvironmentMatches: vi.fn((s: any, m: any) => {
      if (!s) return []
      if (m?.requiredNodeRange === '>=20.0.0' && s.nodeVersion === 'v18.20.0') {
        return [{
          gate: 'requiredNodeRange',
          expected: '>=20.0.0',
          actual: 'v18.20.0',
        }]
      }
      return []
    }),
    getLastEnvironmentCheck: vi.fn(() => ({
      status: state && manifest ? (manifest.environment && state.nodeVersion !== 'v20.10.0' ? 'drift_detected' : 'ok') : 'unavailable',
      capturedAt: state?.capturedAt ?? null,
      manifestVersion: manifest?.version ?? null,
      actualVersion: state?.version ?? null,
      nodeVersion: state?.nodeVersion ?? null,
      agentVersion: state?.agentVersion ?? null,
      drift: [],
      reconcileSupported: manifest?.environment !== undefined,
      checkedAt: '2026-08-25T10:30:00Z',
    })),
    readDeviceEnvState: vi.fn(async () => state),
    runEnvironmentCheck: overrides.runEnvironmentCheck ?? vi.fn(async () => ({
      status: 'unavailable',
      capturedAt: null,
      manifestVersion: null,
      actualVersion: null,
      nodeVersion: null,
      agentVersion: null,
      drift: [],
      reconcileSupported: false,
      checkedAt: '2026-08-25T10:30:00Z',
    })),
  }))

  if (overrides.manifestFetchError) {
    vi.doMock('../../packages/server/src/modules/studio/services/update/manifest-client', () => ({
      fetchDevicePackageManifest: vi.fn(async () => { throw overrides.manifestFetchError }),
      fetchSourcePackageManifest: vi.fn(async () => null),
      resolveManifestCheckResult: vi.fn(),
    }))
  } else {
    vi.doMock('../../packages/server/src/modules/studio/services/update/manifest-client', () => ({
      fetchDevicePackageManifest: vi.fn(async () => manifest),
      fetchSourcePackageManifest: vi.fn(async () => null),
      resolveManifestCheckResult: vi.fn(),
    }))
  }

  const mod = await import('../../packages/server/src/modules/studio/controllers/update')
  return { ...mod, mocks: { execFile, execFileSync, spawn, unref, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, appendFileSync } }
}

describe('update controller environment endpoint', () => {
  const originalStrategy = process.env.WEBUI_UPDATE_STRATEGY
  const originalManifestUrl = process.env.WEBUI_UPDATE_MANIFEST_URL

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    vi.doUnmock('child_process')
    vi.doUnmock('fs')
    vi.doUnmock('../../packages/server/src/modules/studio/public/runtime-environment')
    vi.doUnmock('../../packages/server/src/modules/studio/services/update/reconcile')
    vi.doUnmock('../../packages/server/src/modules/studio/services/update/manifest-client')
    vi.unstubAllGlobals()
    if (originalStrategy === undefined) delete process.env.WEBUI_UPDATE_STRATEGY
    else process.env.WEBUI_UPDATE_STRATEGY = originalStrategy
    if (originalManifestUrl === undefined) delete process.env.WEBUI_UPDATE_MANIFEST_URL
    else process.env.WEBUI_UPDATE_MANIFEST_URL = originalManifestUrl
  })

  it('reports unavailable when env-state.json is missing', async () => {
    process.env.WEBUI_UPDATE_STRATEGY = 'device-package'
    process.env.WEBUI_UPDATE_MANIFEST_URL = 'https://updates.example.com/stable/manifest.json'

    const { getUpdateEnvironment } = await loadUpdateControllerWithEnvironment({
      state: null,
      manifest: { version: '0.7.20', environment: { requiredNodeRange: '>=20.0.0' } },
    })
    const ctx = createMockCtx()

    await getUpdateEnvironment(ctx)

    expect(ctx.body).toEqual(expect.objectContaining({
      success: true,
      status: 'unavailable',
      drift: [],
      reconcileSupported: true,
      manifestVersion: '0.7.20',
    }))
  })

  it('reports ok when captured state matches manifest requirements', async () => {
    process.env.WEBUI_UPDATE_STRATEGY = 'device-package'
    process.env.WEBUI_UPDATE_MANIFEST_URL = 'https://updates.example.com/stable/manifest.json'

    const { getUpdateEnvironment } = await loadUpdateControllerWithEnvironment({
      state: {
        version: '0.7.20',
        capturedAt: '2026-08-25T10:00:00Z',
        nodeVersion: 'v20.10.0',
        agentVersion: '0.11.0',
        aptPackages: [],
        scripts: {},
      },
      manifest: { version: '0.7.20', environment: { requiredNodeRange: '>=20.0.0' } },
    })
    const ctx = createMockCtx()

    await getUpdateEnvironment(ctx)

    expect(ctx.body).toEqual(expect.objectContaining({
      success: true,
      status: 'ok',
      drift: [],
      nodeVersion: 'v20.10.0',
      agentVersion: '0.11.0',
      manifestVersion: '0.7.20',
      actualVersion: '0.7.20',
      reconcileSupported: true,
    }))
  })

  it('reports drift_detected when assertEnvironmentMatches returns failing entries', async () => {
    process.env.WEBUI_UPDATE_STRATEGY = 'device-package'
    process.env.WEBUI_UPDATE_MANIFEST_URL = 'https://updates.example.com/stable/manifest.json'

    const { getUpdateEnvironment } = await loadUpdateControllerWithEnvironment({
      state: {
        version: '0.7.19',
        capturedAt: '2026-08-25T10:00:00Z',
        nodeVersion: 'v18.20.0',
        agentVersion: '0.11.0',
        aptPackages: [],
        scripts: {},
      },
      manifest: { version: '0.7.20', environment: { requiredNodeRange: '>=20.0.0' } },
    })
    const ctx = createMockCtx()

    await getUpdateEnvironment(ctx)

    expect(ctx.body.status).toBe('drift_detected')
    expect(ctx.body.drift).toEqual([
      expect.objectContaining({
        gate: 'requiredNodeRange',
        expected: '>=20.0.0',
        actual: 'v18.20.0',
      }),
    ])
    expect(ctx.body.reconcileSupported).toBe(true)
  })

  it('reports reconcileSupported=false when manifest has no environment block', async () => {
    process.env.WEBUI_UPDATE_STRATEGY = 'device-package'
    process.env.WEBUI_UPDATE_MANIFEST_URL = 'https://updates.example.com/stable/manifest.json'

    const { getUpdateEnvironment } = await loadUpdateControllerWithEnvironment({
      state: {
        version: '0.7.19',
        capturedAt: '2026-08-25T10:00:00Z',
        nodeVersion: 'v20.10.0',
        agentVersion: '0.11.0',
        aptPackages: [],
        scripts: {},
      },
      manifest: { version: '0.7.20' },
    })
    const ctx = createMockCtx()

    await getUpdateEnvironment(ctx)

    expect(ctx.body.status).toBe('ok')
    expect(ctx.body.reconcileSupported).toBe(false)
  })

  it('still returns a payload when manifest fetch fails', async () => {
    process.env.WEBUI_UPDATE_STRATEGY = 'device-package'
    process.env.WEBUI_UPDATE_MANIFEST_URL = 'https://updates.example.com/stable/manifest.json'

    const { getUpdateEnvironment } = await loadUpdateControllerWithEnvironment({
      state: {
        version: '0.7.19',
        capturedAt: '2026-08-25T10:00:00Z',
        nodeVersion: 'v20.10.0',
        agentVersion: '0.11.0',
        aptPackages: [],
        scripts: {},
      },
      manifestFetchError: new Error('manifest 5xx'),
    })
    const ctx = createMockCtx()

    await getUpdateEnvironment(ctx)

    expect(ctx.body.success).toBe(true)
    expect(ctx.body.status).toBe('ok')
    expect(ctx.body.manifestVersion).toBeNull()
    expect(ctx.body.reconcileSupported).toBe(false)
  })
})
