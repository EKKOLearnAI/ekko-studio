import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { delimiter, dirname, join } from 'path'

type UpdateControllerMocks = {
  execFile: ReturnType<typeof vi.fn>
  execFileSync: ReturnType<typeof vi.fn>
  spawn: ReturnType<typeof vi.fn>
  unref: ReturnType<typeof vi.fn>
  existsSync: ReturnType<typeof vi.fn>
  readFileSync: ReturnType<typeof vi.fn>
  appendFileSync: ReturnType<typeof vi.fn>
}

type LoadUpdateControllerOptions = Partial<UpdateControllerMocks> & {
  isDocker?: boolean
}

async function loadUpdateController(overrides: LoadUpdateControllerOptions = {}) {
  const execFile = overrides.execFile ?? vi.fn((_command: string, _args: string[], _options: any, callback: any) => callback(null, '', ''))
  const execFileSync = overrides.execFileSync ?? vi.fn().mockReturnValue('updated')
  const unref = overrides.unref ?? vi.fn()
  const spawn = overrides.spawn ?? vi.fn(() => ({ unref, on: vi.fn() }))
  const existsSync = overrides.existsSync ?? vi.fn(() => true)
  const readFileSync = overrides.readFileSync ?? vi.fn(() => JSON.stringify({
    name: 'hermes-web-ui',
    version: '0.0.0',
    repository: { url: 'https://github.com/EKKOLearnAI/hermes-studio.git' },
  }))
  const appendFileSync = overrides.appendFileSync ?? vi.fn()

  vi.resetModules()
  vi.doMock('child_process', () => ({ execFile, execFileSync, spawn }))
  vi.doMock('fs', () => ({
    appendFileSync,
    closeSync: vi.fn(),
    existsSync,
    mkdirSync: vi.fn(),
    openSync: vi.fn(() => 1),
    readFileSync,
    rmSync: vi.fn(),
    writeFileSync: vi.fn(),
  }))
  vi.doMock('../../packages/server/src/modules/studio/public/runtime-environment', () => ({
    isDockerContainer: () => overrides.isDocker === true,
  }))

  const mod = await import('../../packages/server/src/bootstrap/update')
  return {
    ...mod,
    mocks: { execFile, execFileSync, spawn, unref, existsSync, readFileSync, appendFileSync },
  }
}

function createMockCtx() {
  return {
    status: 200,
    body: null as unknown,
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

function getGlobalCliScript(prefix: string, packageName = 'hermes-web-ui') {
  return process.platform === 'win32'
    ? join(prefix, 'node_modules', packageName, 'bin', 'hermes-web-ui.mjs')
    : join(prefix, 'lib', 'node_modules', packageName, 'bin', 'hermes-web-ui.mjs')
}

describe('update controller', () => {
  const originalPort = process.env.PORT
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.doUnmock('child_process')
    vi.doUnmock('fs')
    vi.doUnmock('../../packages/server/src/modules/studio/public/runtime-environment')
    vi.unstubAllGlobals()
    if (originalPort === undefined) {
      delete process.env.PORT
    } else {
      process.env.PORT = originalPort
    }
    delete process.env.HERMES_WEB_UI_PREVIEW_REPO
  })

  it.each(['ekko-studio', 'hermes-web-ui'])('updates and restarts the installed %s package through the running Node executable', async (packageName) => {
    process.env.PORT = '9129'
    const nodeBinDir = getNodeBinDir()
    const npmCli = getNpmCliPath()
    const globalPrefix = getNodePrefix()
    const cliScript = getGlobalCliScript(globalPrefix, packageName)
    const execFileSync = vi.fn((_command: string, args: string[]) => {
      if (args[1] === 'root') {
        return process.platform === 'win32'
          ? join(globalPrefix, 'node_modules')
          : join(globalPrefix, 'lib', 'node_modules')
      }
      return 'updated'
    })
    const { handleUpdate, mocks } = await loadUpdateController({ execFileSync, readFileSync: vi.fn(() => JSON.stringify({ name: packageName, version: '0.7.22' })) })
    const ctx = createMockCtx()

    await handleUpdate(ctx)

    expect(mocks.execFileSync).toHaveBeenCalledWith(
      process.execPath,
      [npmCli, 'install', '-g', `${packageName}@latest`],
      expect.objectContaining({
        encoding: 'utf-8',
        timeout: 10 * 60 * 1000,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        cwd: expect.any(String),
        env: expect.objectContaining({
          npm_node_execpath: process.execPath,
          PATH: expect.stringContaining(`${nodeBinDir}${delimiter}`),
        }),
      }),
    )
    expect(ctx.body).toEqual({ success: true, message: 'updated' })

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

  it('falls back to the default port when PORT is not set', async () => {
    delete process.env.PORT
    const { handleUpdate, mocks } = await loadUpdateController()
    const ctx = createMockCtx()

    await handleUpdate(ctx)
    await vi.runAllTimersAsync()

    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      [expect.any(String), 'restart', '--port', '8648'],
      expect.objectContaining({ detached: true, stdio: 'ignore', windowsHide: true }),
    )
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

  it('returns a 500 with stderr when installation fails', async () => {
    const execFileSync = vi.fn((_command: string, args: string[]) => {
      if (args.includes('install') && args.includes('hermes-web-ui@latest')) {
        const error = new Error('install failed') as Error & { stderr?: string }
        error.stderr = 'engine mismatch'
        throw error
      }
      return ''
    })
    const { handleUpdate, mocks } = await loadUpdateController({ execFileSync })
    const ctx = createMockCtx()

    await handleUpdate(ctx)

    expect(ctx.status).toBe(500)
    expect(ctx.body).toEqual({ success: false, message: 'engine mismatch' })
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
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

})
