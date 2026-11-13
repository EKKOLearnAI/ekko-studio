import { EventEmitter } from 'events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { resolve } from 'path'
import { PassThrough } from 'stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('usb service', () => {
  let db: any = null
  let tempRoot = ''

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    tempRoot = mkdtempSync(resolve(tmpdir(), 'hermes-usb-service-'))
  })

  afterEach(() => {
    db?.close()
    db = null
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = ''
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('stays unsupported on non-linux hosts instead of crashing bootstrap', async () => {
    const { USBService } = await import('../../packages/server/src/modules/studio/services/usb/USBService')
    const service = new USBService({
      platform: 'win32',
      deployDir: tempRoot,
      appHome: tempRoot,
      env: {},
      cleanupIntervalMs: 60_000,
    })

    service.start()

    expect(service.status().state).toBe('unsupported')
    await service.stop()
  })

  it('tracks mounted devices, persists history, and blocks path traversal', async () => {
    const mountPoint = resolve(tempRoot, 'mnt', 'usb', '1234-ABCD')
    mkdirSync(resolve(mountPoint, 'docs'), { recursive: true })
    writeFileSync(resolve(mountPoint, 'hello.txt'), 'hello usb', 'utf-8')
    writeFileSync(resolve(mountPoint, 'docs', 'nested.txt'), 'nested usb', 'utf-8')

    const { USBService } = await import('../../packages/server/src/modules/studio/services/usb/USBService')
    const service = new USBService({
      platform: 'linux',
      deployDir: tempRoot,
      appHome: tempRoot,
      env: { USB_MONITOR_DISABLED: '1' },
      cleanupIntervalMs: 60_000,
    })

    service.ingestMonitorMessage({
      type: 'device_event',
      action: 'add',
      uuid: '1234-ABCD',
      device_node: '/dev/sdb1',
      mount_point: mountPoint,
      fs_type: 'vfat',
      label: 'KINGSTON',
      status: 'mounted',
      // Keep timestamps relative to the current time so the 24h history
      // window filter stays valid regardless of when the suite runs.
      ts: new Date(Date.now() - 5 * 60_000).toISOString(),
    })

    expect(service.listDevices()).toHaveLength(1)
    expect(service.listHistory('24h')).toHaveLength(1)

    const entries = await service.listFiles('1234-ABCD', '/')
    expect(entries.map(entry => entry.name)).toEqual(['docs', 'hello.txt'])

    const fileStat = await service.statPath('1234-ABCD', '/hello.txt')
    expect(fileStat.isDir).toBe(false)
    expect(fileStat.path).toBe('/hello.txt')

    const content = await service.readFile('1234-ABCD', '/hello.txt')
    expect(content.toString('utf-8')).toBe('hello usb')

    await expect(service.readFile('1234-ABCD', '/../secret.txt')).rejects.toMatchObject({
      code: 'invalid_path',
    })

    service.ingestMonitorMessage({
      type: 'device_event',
      action: 'remove',
      uuid: '1234-ABCD',
      device_node: '/dev/sdb1',
      label: 'KINGSTON',
      status: 'removed',
      ts: new Date(Date.now() - 4 * 60_000).toISOString(),
    })

    expect(service.listDevices()).toHaveLength(0)
    expect(service.listHistory('24h')).toHaveLength(2)
    await service.stop()
  })

  it('copies a USB file into the workspace while keeping the target inside workspace root', async () => {
    const mountPoint = resolve(tempRoot, 'mnt', 'usb', '1234-ABCD')
    const workspace = resolve(tempRoot, 'workspace')
    mkdirSync(resolve(mountPoint, 'docs'), { recursive: true })
    mkdirSync(workspace, { recursive: true })
    writeFileSync(resolve(mountPoint, 'docs', 'nested.txt'), 'nested usb', 'utf-8')

    const { USBService } = await import('../../packages/server/src/modules/studio/services/usb/USBService')
    const service = new USBService({
      platform: 'linux',
      deployDir: tempRoot,
      appHome: tempRoot,
      env: { USB_MONITOR_DISABLED: '1' },
      cleanupIntervalMs: 60_000,
    })

    service.ingestMonitorMessage({
      type: 'device_event',
      action: 'add',
      uuid: '1234-ABCD',
      device_node: '/dev/sdb1',
      mount_point: mountPoint,
      fs_type: 'vfat',
      label: 'KINGSTON',
      status: 'mounted',
      ts: new Date(Date.now() - 5 * 60_000).toISOString(),
    })

    const copied = await service.copyFileToWorkspace('1234-ABCD', '/docs/nested.txt', workspace)
    expect(copied.relativeWorkspacePath).toBe('usb-imports/1234-ABCD/docs/nested.txt')
    expect(copied.workspacePath).toBe(resolve(workspace, 'usb-imports', '1234-ABCD', 'docs', 'nested.txt'))
    expect(copied.size).toBe(10)
    expect(readFileSync(copied.workspacePath, 'utf-8')).toBe('nested usb')
    await expect(service.copyFileToWorkspace('1234-ABCD', '/docs/nested.txt', workspace, '../escape.txt')).rejects.toMatchObject({
      code: 'invalid_path',
    })

    await service.stop()
  })

  it('injects explicit USB monitor runtime env when spawning the python monitor', async () => {
    const monitorDir = resolve(tempRoot, 'hermes_data', 'bots', 'usb')
    mkdirSync(monitorDir, { recursive: true })
    writeFileSync(resolve(monitorDir, 'usb_monitor.py'), 'print("usb monitor")\n', 'utf-8')

    const spawnMock = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough
        stderr: PassThrough
        exitCode: number | null
        killed: boolean
        kill: ReturnType<typeof vi.fn>
      }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.exitCode = null
      child.killed = false
      child.kill = vi.fn(() => {
        child.killed = true
        child.exitCode = 0
        child.emit('exit', 0, null)
        return true
      })
      return child
    })

    vi.doMock('child_process', async () => {
      const actual = await vi.importActual<typeof import('child_process')>('child_process')
      return {
        ...actual,
        spawn: spawnMock,
      }
    })

    const { USBService } = await import('../../packages/server/src/modules/studio/services/usb/USBService')
    const service = new USBService({
      platform: 'linux',
      deployDir: tempRoot,
      appHome: tempRoot,
      env: {
        USB_MONITOR_PYTHON_BIN: 'python3',
      },
      cleanupIntervalMs: 60_000,
    })

    service.start()

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const spawnOptions = spawnMock.mock.calls[0]?.[2]
    expect(spawnOptions?.env?.PYTHONUNBUFFERED).toBe('1')
    expect(spawnOptions?.env?.USB_USE_SUDO).toBe('1')
    expect(spawnOptions?.env?.HERMES_WEB_UI_HOME).toBe(tempRoot)
    expect(spawnOptions?.env?.HERMES_WEBUI_STATE_DIR).toBe(tempRoot)

    await service.stop()
  })
})
