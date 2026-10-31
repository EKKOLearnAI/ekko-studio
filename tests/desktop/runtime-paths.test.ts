import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockElectronApp = vi.hoisted(() => ({
  isPackaged: false,
  getAppPath: () => process.cwd(),
  getVersion: () => '0.6.11',
  getLocale: () => 'en',
}))

vi.mock('electron', () => ({
  app: mockElectronApp,
}))

const originalEnv = { ...process.env }
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-desktop-runtime-paths-'))
  tempDirs.push(dir)
  return dir
}

function createRuntime(root: string, version: string) {
  if (process.platform === 'win32') {
    mkdirSync(join(root, 'python', 'Scripts'), { recursive: true })
    mkdirSync(join(root, 'node'), { recursive: true })
    mkdirSync(join(root, 'git', 'cmd'), { recursive: true })
    writeFileSync(join(root, 'python', 'python.exe'), '')
    writeFileSync(join(root, 'python', 'Scripts', 'hermes.cmd'), '')
    writeFileSync(join(root, 'node', 'node.exe'), '')
    writeFileSync(join(root, 'git', 'cmd', 'git.exe'), '')
  } else {
    mkdirSync(join(root, 'python', 'bin'), { recursive: true })
    mkdirSync(join(root, 'node', 'bin'), { recursive: true })
    writeFileSync(join(root, 'python', 'bin', 'python3'), '')
    writeFileSync(join(root, 'python', 'bin', 'hermes'), '')
    writeFileSync(join(root, 'node', 'bin', 'node'), '')
  }
  writeFileSync(join(root, 'runtime-manifest.json'), JSON.stringify({
    schema: 1,
    platform: process.platform,
    hermesAgentVersion: version,
  }))
}

function createSourceRuntime(root: string, version: string) {
  if (process.platform === 'win32') {
    mkdirSync(join(root, 'python', 'venv', 'Scripts'), { recursive: true })
    mkdirSync(join(root, 'python', '.git'), { recursive: true })
    mkdirSync(join(root, 'node'), { recursive: true })
    mkdirSync(join(root, 'git', 'cmd'), { recursive: true })
    writeFileSync(join(root, 'python', 'venv', 'Scripts', 'python.exe'), '')
    writeFileSync(join(root, 'python', 'venv', 'Scripts', 'hermes.cmd'), '')
    writeFileSync(join(root, 'node', 'node.exe'), '')
    writeFileSync(join(root, 'git', 'cmd', 'git.exe'), '')
  } else {
    mkdirSync(join(root, 'python', 'venv', 'bin'), { recursive: true })
    mkdirSync(join(root, 'python', '.git'), { recursive: true })
    mkdirSync(join(root, 'node', 'bin'), { recursive: true })
    writeFileSync(join(root, 'python', 'venv', 'bin', 'python3'), '')
    writeFileSync(join(root, 'python', 'venv', 'bin', 'hermes'), '')
    writeFileSync(join(root, 'node', 'bin', 'node'), '')
  }
  writeFileSync(join(root, 'python', 'pyproject.toml'), '')
  writeFileSync(join(root, 'runtime-manifest.json'), JSON.stringify({
    schema: 2,
    platform: process.platform,
    hermesAgentVersion: version,
    hermesSource: {
      repository: 'https://github.com/NousResearch/hermes-agent.git',
      ref: 'v2026.7.30',
      commit: 'cc4cab2f592e60a197e796506de9168f74baf3ea',
      installMethod: 'git',
    },
  }))
}

function createRuntimeWithoutManifest(root: string) {
  if (process.platform === 'win32') {
    mkdirSync(join(root, 'python', 'Scripts'), { recursive: true })
    mkdirSync(join(root, 'node'), { recursive: true })
    mkdirSync(join(root, 'git', 'cmd'), { recursive: true })
    writeFileSync(join(root, 'python', 'python.exe'), '')
    writeFileSync(join(root, 'python', 'Scripts', 'hermes.cmd'), '')
    writeFileSync(join(root, 'node', 'node.exe'), '')
    writeFileSync(join(root, 'git', 'cmd', 'git.exe'), '')
  } else {
    mkdirSync(join(root, 'python', 'bin'), { recursive: true })
    mkdirSync(join(root, 'node', 'bin'), { recursive: true })
    writeFileSync(join(root, 'python', 'bin', 'python3'), '')
    writeFileSync(join(root, 'python', 'bin', 'hermes'), '')
    writeFileSync(join(root, 'node', 'bin', 'node'), '')
  }
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform })
}

describe('desktop runtime paths', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
    const resourcesPath = tempDir()
    process.resourcesPath = resourcesPath
    process.env.HERMES_WEB_UI_HOME = tempDir()
    mockElectronApp.isPackaged = false
    mockElectronApp.getAppPath = () => process.cwd()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
    vi.resetModules()
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each(['linux', 'darwin', 'win32'] as const)('resolves the %s app icon in development and packaged builds', async (platform) => {
    setPlatform(platform)
    const { desktopIcon } = await import('../../packages/desktop/src/main/paths')
    const appPath = tempDir()
    mockElectronApp.getAppPath = () => appPath
    const filename = platform === 'linux' ? 'iconLinux.png' : 'icon.png'

    expect(desktopIcon()).toBe(join(appPath, 'build', filename))
    mockElectronApp.isPackaged = true
    expect(desktopIcon()).toBe(join(process.resourcesPath, 'build', filename))
  })

  it('uses the downloaded runtime in packaged builds even when stale install resources exist', async () => {
    mkdirSync(join(process.resourcesPath, 'python'), { recursive: true })
    mkdirSync(join(process.resourcesPath, 'node'), { recursive: true })
    mkdirSync(join(process.resourcesPath, 'git'), { recursive: true })

    const { resolveRuntimeResourceDir } = await import('../../packages/desktop/src/main/runtime-paths')
    const runtimeRoot = tempDir()

    expect(resolveRuntimeResourceDir('python', true, process.resourcesPath, runtimeRoot)).toBe(join(runtimeRoot, 'python'))
    expect(resolveRuntimeResourceDir('node', true, process.resourcesPath, runtimeRoot)).toBe(join(runtimeRoot, 'node'))
    expect(resolveRuntimeResourceDir('git', true, process.resourcesPath, runtimeRoot)).toBe(join(runtimeRoot, 'git'))
  })

  it('uses app resources for development runtime paths', async () => {
    const appPath = tempDir()
    const { resolveRuntimeResourceDir, runtimePlatformKey } = await import('../../packages/desktop/src/main/runtime-paths')
    const runtimeRoot = tempDir()

    expect(resolveRuntimeResourceDir('python', false, appPath, runtimeRoot)).toBe(join(appPath, 'resources', 'python', runtimePlatformKey()))
    expect(resolveRuntimeResourceDir('node', false, appPath, runtimeRoot)).toBe(join(appPath, 'resources', 'node', runtimePlatformKey()))
    expect(resolveRuntimeResourceDir('git', false, appPath, runtimeRoot)).toBe(join(appPath, 'resources', 'git', runtimePlatformKey()))
  })

  it('uses explicit runtime override for development runtime paths', async () => {
    const runtimeRoot = tempDir()
    process.env.HERMES_DESKTOP_RUNTIME_DIR = runtimeRoot
    createRuntime(runtimeRoot, '0.17.0')

    const { pythonDir, nodeDir, gitDir } = await import('../../packages/desktop/src/main/paths')

    expect(pythonDir()).toBe(join(runtimeRoot, 'python'))
    expect(nodeDir()).toBe(join(runtimeRoot, 'node'))
    expect(gitDir()).toBe(join(runtimeRoot, 'git'))
  })

  it('uses active-version.json paths for startup while keeping the current target runtime path', async () => {
    const homeDir = tempDir()
    const appPath = tempDir()
    const runtimeDir = tempDir()
    const storageRoot = tempDir()
    const webUiDir = join(storageRoot, 'webui', '0.6.10')
    const staleAbsoluteWebUiDir = tempDir()
    process.env.HERMES_WEB_UI_HOME = homeDir
    mockElectronApp.getAppPath = () => appPath

    const { runtimePlatformKey } = await import('../../packages/desktop/src/main/runtime-paths')
    createRuntime(runtimeDir, '0.15.1')
    mkdirSync(join(webUiDir, 'dist', 'server'), { recursive: true })
    writeFileSync(join(webUiDir, 'dist', 'server', 'index.js'), '')
    mkdirSync(join(homeDir, 'desktop-runtime'), { recursive: true })
    writeFileSync(join(homeDir, 'desktop-runtime', 'active-version.json'), JSON.stringify({
      schema: 1,
      hermesRuntimeVersion: '0.15.1',
      webUiVersion: '0.6.10',
      runtimeDirectory: runtimeDir,
      runtimeRootDirectory: storageRoot,
      webUiDirectory: staleAbsoluteWebUiDir,
      platform: runtimePlatformKey(),
    }))

    const { desktopRuntimeDir, targetDesktopRuntimeDir, webuiDir } = await import('../../packages/desktop/src/main/paths')

    expect(desktopRuntimeDir()).toBe(runtimeDir)
    expect(webuiDir()).toBe(webUiDir)
    expect(targetDesktopRuntimeDir()).toBe(join(storageRoot, 'hermes', '0.22.5', runtimePlatformKey()))
  })

  it('falls back to the bundled Web UI when the active Web UI directory is incomplete', async () => {
    const homeDir = tempDir()
    const activeWebUiDir = join(homeDir, 'webui', '0.6.26')
    const bundledWebUiDir = join(process.resourcesPath, 'webui')
    process.env.HERMES_WEB_UI_HOME = homeDir
    mockElectronApp.isPackaged = true

    const { runtimePlatformKey } = await import('../../packages/desktop/src/main/runtime-paths')
    mkdirSync(activeWebUiDir, { recursive: true })
    mkdirSync(join(bundledWebUiDir, 'dist', 'server'), { recursive: true })
    writeFileSync(join(bundledWebUiDir, 'dist', 'server', 'index.js'), '')
    mkdirSync(join(homeDir, 'desktop-runtime'), { recursive: true })
    writeFileSync(join(homeDir, 'desktop-runtime', 'active-version.json'), JSON.stringify({
      schema: 1,
      webUiVersion: '0.6.26',
      webUiDirectory: activeWebUiDir,
      platform: runtimePlatformKey(),
    }))

    const { webuiDir, webuiServerEntry } = await import('../../packages/desktop/src/main/paths')

    expect(webuiDir()).toBe(bundledWebUiDir)
    expect(webuiServerEntry()).toBe(join(bundledWebUiDir, 'dist', 'server', 'index.js'))
    const active = JSON.parse(readFileSync(join(homeDir, 'desktop-runtime', 'active-version.json'), 'utf-8'))
    expect(active.webUiDirectory).toBeUndefined()
    expect(active.webUiVersion).toBeUndefined()
  })

  it('does not scan or delete Web UI versions from the legacy directory', async () => {
    const homeDir = tempDir()
    const appPath = tempDir()
    const legacyWebUiDir = join(homeDir, 'webui', '0.6.22')
    const currentWebUiDir = join(homeDir, 'webui', '0.6.23')
    process.env.HERMES_WEB_UI_HOME = homeDir
    mockElectronApp.getAppPath = () => appPath

    const { runtimePlatformKey } = await import('../../packages/desktop/src/main/runtime-paths')
    mkdirSync(join(legacyWebUiDir, 'dist', 'server'), { recursive: true })
    writeFileSync(join(legacyWebUiDir, 'package.json'), JSON.stringify({ version: '0.6.22' }))
    writeFileSync(join(legacyWebUiDir, 'dist', 'server', 'index.js'), '')
    mkdirSync(currentWebUiDir, { recursive: true })
    writeFileSync(join(currentWebUiDir, 'package.json'), JSON.stringify({ version: '0.6.23' }))
    mkdirSync(join(homeDir, 'desktop-runtime'), { recursive: true })
    writeFileSync(join(homeDir, 'desktop-runtime', 'active-version.json'), JSON.stringify({
      schema: 1,
      webUiVersion: '0.6.22',
      webUiDirectory: legacyWebUiDir,
      platform: runtimePlatformKey(),
    }))

    const { webuiDir } = await import('../../packages/desktop/src/main/paths')

    expect(webuiDir()).not.toBe(legacyWebUiDir)
    expect(existsSync(legacyWebUiDir)).toBe(true)
    expect(existsSync(currentWebUiDir)).toBe(true)
  })

  it('falls back to the newest installed runtime when the active runtime was deleted', async () => {
    const homeDir = tempDir()
    const deletedRuntimeDir = join(homeDir, 'desktop-runtime', 'hermes', '0.15.2', 'missing')
    process.env.HERMES_WEB_UI_HOME = homeDir

    const { runtimePlatformKey } = await import('../../packages/desktop/src/main/runtime-paths')
    const platformKey = runtimePlatformKey()
    const runtime015 = join(homeDir, 'desktop-runtime', 'hermes', '0.15.2', platformKey)
    const runtime016 = join(homeDir, 'desktop-runtime', 'hermes', '0.16.0', platformKey)
    createRuntime(runtime015, '0.15.2')
    createRuntime(runtime016, '0.16.0')

    mkdirSync(join(homeDir, 'desktop-runtime'), { recursive: true })
    writeFileSync(join(homeDir, 'desktop-runtime', 'active-version.json'), JSON.stringify({
      schema: 1,
      hermesRuntimeVersion: '0.15.2',
      runtimeDirectory: deletedRuntimeDir,
      platform: platformKey,
    }))

    const { desktopRuntimeDir } = await import('../../packages/desktop/src/main/paths')

    expect(desktopRuntimeDir()).toBe(runtime016)
  })

  it('records why an incomplete selected Windows Runtime fell back', async () => {
    setPlatform('win32')
    const homeDir = tempDir()
    process.env.HERMES_WEB_UI_HOME = homeDir

    const { runtimePlatformKey } = await import('../../packages/desktop/src/main/runtime-paths')
    const platformKey = runtimePlatformKey()
    const fallbackRuntime = join(homeDir, 'desktop-runtime', 'hermes', '0.19.0', platformKey)
    const selectedRuntime = join(homeDir, 'desktop-runtime', 'hermes', '0.20.0', platformKey)
    const activeVersionPath = join(homeDir, 'desktop-runtime', 'active-version.json')
    createRuntime(fallbackRuntime, '0.19.0')
    createSourceRuntime(selectedRuntime, '0.20.0')
    rmSync(join(selectedRuntime, 'node', 'node.exe'))
    writeFileSync(activeVersionPath, JSON.stringify({
      schema: 1,
      hermesRuntimeVersion: '0.20.0',
      runtimeDirectory: selectedRuntime,
      platform: platformKey,
    }))

    const { desktopRuntimeDir } = await import('../../packages/desktop/src/main/paths')

    expect(desktopRuntimeDir()).toBe(fallbackRuntime)
    const active = JSON.parse(readFileSync(activeVersionPath, 'utf-8'))
    expect(active.runtimeDirectory).toBe(selectedRuntime)
    expect(active.runtimeActivationError).toContain('0.20.0')
    expect(active.runtimeActivationError).toMatch(/node[\\/]node\.exe/)
    expect(active.runtimeActivationError).toContain(fallbackRuntime)
  })

  it('keeps using the active local runtime even when the packaged runtime version is newer', async () => {
    const homeDir = tempDir()
    process.env.HERMES_WEB_UI_HOME = homeDir
    process.env.HERMES_DESKTOP_RUNTIME_RELEASE_TAG = 'hermes-0.16.0-runtime'
    mockElectronApp.isPackaged = true

    const { runtimePlatformKey } = await import('../../packages/desktop/src/main/runtime-paths')
    const platformKey = runtimePlatformKey()
    const runtime015 = join(homeDir, 'desktop-runtime', 'hermes', '0.15.2', platformKey)
    const runtime016 = join(homeDir, 'desktop-runtime', 'hermes', '0.16.0', platformKey)
    createRuntime(runtime015, '0.15.2')
    createRuntime(runtime016, '0.16.0')

    mkdirSync(join(homeDir, 'desktop-runtime'), { recursive: true })
    writeFileSync(join(homeDir, 'desktop-runtime', 'active-version.json'), JSON.stringify({
      schema: 1,
      hermesRuntimeVersion: '0.15.2',
      runtimeDirectory: runtime015,
      platform: platformKey,
    }))

    const { desktopRuntimeDir, targetDesktopRuntimeDir } = await import('../../packages/desktop/src/main/paths')

    expect(desktopRuntimeDir()).toBe(runtime015)
    expect(targetDesktopRuntimeDir()).toBe(runtime016)
  })

  it('uses installed runtime directories under desktop-runtime/hermes when executable files are present', async () => {
    const homeDir = tempDir()
    process.env.HERMES_WEB_UI_HOME = homeDir

    const { runtimePlatformKey } = await import('../../packages/desktop/src/main/runtime-paths')
    const runtimeDir = join(homeDir, 'desktop-runtime', 'hermes', '0.15.2', runtimePlatformKey())
    const targetRuntimeDir = join(homeDir, 'desktop-runtime', 'hermes', '0.22.5', runtimePlatformKey())
    createRuntimeWithoutManifest(runtimeDir)

    const { desktopRuntimeDir, targetDesktopRuntimeDir } = await import('../../packages/desktop/src/main/paths')

    expect(desktopRuntimeDir()).toBe(runtimeDir)
    expect(targetDesktopRuntimeDir()).toBe(targetRuntimeDir)
  })

  it('prefers the relocatable hermes.cmd Windows runtime entry point', async () => {
    setPlatform('win32')
    const homeDir = tempDir()
    process.env.HERMES_WEB_UI_HOME = homeDir
    mockElectronApp.isPackaged = true

    const { runtimePlatformKey } = await import('../../packages/desktop/src/main/runtime-paths')
    const runtimeDir = join(homeDir, 'desktop-runtime', 'hermes', '0.15.2', runtimePlatformKey())
    createRuntime(runtimeDir, '0.15.2')

    const { desktopRuntimeDir, hermesBin } = await import('../../packages/desktop/src/main/paths')

    expect(desktopRuntimeDir()).toBe(runtimeDir)
    expect(hermesBin()).toBe(join(runtimeDir, 'python', 'Scripts', 'hermes.cmd'))
    expect(existsSync(join(runtimeDir, 'python', 'Scripts', 'hermes.exe'))).toBe(false)
  })

  it('recognizes the local hermes.exe regenerated by a Windows CLI update', async () => {
    setPlatform('win32')
    const homeDir = tempDir()
    process.env.HERMES_WEB_UI_HOME = homeDir
    mockElectronApp.isPackaged = true

    const { runtimePlatformKey } = await import('../../packages/desktop/src/main/runtime-paths')
    const runtimeDir = join(homeDir, 'desktop-runtime', 'hermes', '0.19.1', runtimePlatformKey())
    createSourceRuntime(runtimeDir, '0.19.1')
    rmSync(join(runtimeDir, 'python', 'venv', 'Scripts', 'hermes.cmd'))
    writeFileSync(join(runtimeDir, 'python', 'venv', 'Scripts', 'hermes.exe'), '')

    const { desktopRuntimeDir, hermesBin } = await import('../../packages/desktop/src/main/paths')

    expect(desktopRuntimeDir()).toBe(runtimeDir)
    expect(hermesBin()).toBe(join(runtimeDir, 'python', 'venv', 'Scripts', 'hermes.exe'))
  })

  it('keeps the Hermes Git checkout separate from its bundled venv', async () => {
    const runtimeRoot = tempDir()
    process.env.HERMES_DESKTOP_RUNTIME_DIR = runtimeRoot
    createSourceRuntime(runtimeRoot, '0.19.1')

    const {
      bundledPython,
      hermesBin,
      pythonDir,
      pythonEnvironmentDir,
    } = await import('../../packages/desktop/src/main/paths')

    expect(pythonDir()).toBe(join(runtimeRoot, 'python'))
    expect(pythonEnvironmentDir()).toBe(join(runtimeRoot, 'python', 'venv'))
    expect(bundledPython()).toBe(process.platform === 'win32'
      ? join(runtimeRoot, 'python', 'venv', 'Scripts', 'python.exe')
      : join(runtimeRoot, 'python', 'venv', 'bin', 'python3'))
    expect(hermesBin()).toBe(process.platform === 'win32'
      ? join(runtimeRoot, 'python', 'venv', 'Scripts', 'hermes.cmd')
      : join(runtimeRoot, 'python', 'venv', 'bin', 'hermes'))
  })
})
