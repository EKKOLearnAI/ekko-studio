import { EventEmitter } from 'events'
import { existsSync } from 'fs'
import { copyFile, mkdir, readdir, readFile, stat, statfs } from 'fs/promises'
import { spawn, type ChildProcessByStdio } from 'child_process'
import { basename, dirname, normalize, resolve } from 'path'
import { createInterface } from 'readline'
import type { Readable } from 'stream'
import { config, getDeployDir } from '../../public/config'
import { logger } from '../../public/logging'
import { isPathWithin, relativePathFromBase } from '../files/path'
import { USBEventStore } from './USBEventStore'
import type {
  USBDeviceRecord,
  USBEventRecord,
  USBFileEntry,
  USBFileStat,
  USBMonitorDeviceEvent,
  USBMonitorMessage,
  USBServiceRuntimeStatus,
  USBDiskUsage,
} from './USBDevice'

const HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000
const HISTORY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000
const MONITOR_RESTART_DELAY_MS = 3_000
const MAX_READ_SIZE_BYTES = 100 * 1024 * 1024
const MONITOR_READY_TIMEOUT_MS = 8_000

export type USBServiceOptions = {
  eventStore?: USBEventStore
  platform?: NodeJS.Platform
  deployDir?: string
  appHome?: string
  env?: NodeJS.ProcessEnv
  cleanupIntervalMs?: number
}

function makeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function envFlagEnabled(value: string | undefined, fallback = false): boolean {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (!normalized) return fallback
  return ['1', 'true', 'yes', 'on'].includes(normalized)
}

function toResponsePath(absolutePath: string, mountPoint: string): string {
  const relativePath = relativePathFromBase(absolutePath, mountPoint)
  if (relativePath == null || relativePath === '') return '/'
  return `/${relativePath.replace(/\\/g, '/')}`
}

function parseSinceMs(input: string | undefined): number {
  const trimmed = String(input || '').trim().toLowerCase()
  if (!trimmed) return HISTORY_RETENTION_MS
  const match = trimmed.match(/^(\d+)\s*([smhd])$/)
  if (!match) return HISTORY_RETENTION_MS
  const amount = Number(match[1] || 0)
  const unit = match[2]
  const multiplier = unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
  return Math.max(amount * multiplier, 0)
}

export class USBService extends EventEmitter {
  private readonly eventStore: USBEventStore
  private readonly platform: NodeJS.Platform
  private readonly deployDir: string
  private readonly appHome: string
  private readonly env: NodeJS.ProcessEnv
  private readonly cleanupIntervalMs: number
  private readonly devices = new Map<string, USBDeviceRecord>()
  private monitor: ChildProcessByStdio<null, Readable, Readable> | null = null
  private cleanupTimer: NodeJS.Timeout | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private readyTimer: NodeJS.Timeout | null = null
  private stopRequested = false
  private runtimeStatus: USBServiceRuntimeStatus

  constructor(options: USBServiceOptions = {}) {
    super()
    this.eventStore = options.eventStore || new USBEventStore()
    this.platform = options.platform || process.platform
    this.deployDir = options.deployDir || getDeployDir(options.env || process.env)
    this.appHome = options.appHome || config.appHome
    this.env = options.env || process.env
    this.cleanupIntervalMs = options.cleanupIntervalMs || HISTORY_CLEANUP_INTERVAL_MS
    this.runtimeStatus = {
      state: 'idle',
      monitorScriptPath: this.monitorScriptPath(),
      lastReadyAt: null,
      lastHeartbeatAt: null,
      lastError: null,
    }
  }

  start(): void {
    if (this.cleanupTimer == null) {
      this.cleanupTimer = setInterval(() => {
        try {
          this.pruneHistory()
        } catch (error) {
          logger.warn({ err: error }, '[usb] failed to prune history')
        }
      }, this.cleanupIntervalMs)
      this.cleanupTimer.unref?.()
    }

    this.stopRequested = false
    if (!this.shouldStartMonitor()) {
      this.runtimeStatus.state = 'unsupported'
      this.runtimeStatus.lastError = 'USB monitor only starts on Linux runtime hosts.'
      return
    }
    if (this.monitor) return

    const scriptPath = this.monitorScriptPath()
    if (!existsSync(scriptPath)) {
      this.runtimeStatus.state = 'error'
      this.runtimeStatus.lastError = `USB monitor script not found: ${scriptPath}`
      logger.warn({ scriptPath }, '[usb] monitor script not found')
      return
    }

    this.runtimeStatus.state = 'starting'
    this.runtimeStatus.lastError = null
    this.spawnMonitor(scriptPath)
  }

  async stop(): Promise<void> {
    this.stopRequested = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    const child = this.monitor
    this.monitor = null
    if (child && child.exitCode == null && !child.killed) {
      await new Promise<void>((resolveStop) => {
        child.once('exit', () => resolveStop())
        child.kill('SIGTERM')
        setTimeout(() => resolveStop(), 1500).unref?.()
      })
    }
    this.runtimeStatus.state = 'stopped'
  }

  status(): USBServiceRuntimeStatus {
    return { ...this.runtimeStatus }
  }

  listDevices(): USBDeviceRecord[] {
    return [...this.devices.values()].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
  }

  getDevice(uuid: string): USBDeviceRecord | undefined {
    return this.devices.get(uuid)
  }

  listHistory(since = '24h'): USBEventRecord[] {
    const windowMs = parseSinceMs(since)
    return this.eventStore.listSince(Date.now() - windowMs)
  }

  async listFiles(uuid: string, relativePath = '/'): Promise<USBFileEntry[]> {
    const { resolvedPath, mountPoint } = this.resolveDevicePath(uuid, relativePath)
    const dirEntries = await readdir(resolvedPath, { withFileTypes: true })
    const results = await Promise.all(dirEntries.map(async (entry) => {
      const fullPath = resolve(resolvedPath, entry.name)
      const entryStat = await stat(fullPath)
      return {
        name: entry.name,
        path: toResponsePath(fullPath, mountPoint),
        isDir: entryStat.isDirectory(),
        size: entryStat.size,
        modTime: entryStat.mtime.toISOString(),
      } satisfies USBFileEntry
    }))
    return results.sort((left, right) => {
      if (left.isDir !== right.isDir) return left.isDir ? -1 : 1
      return left.name.localeCompare(right.name)
    })
  }

  async statPath(uuid: string, relativePath: string): Promise<USBFileStat> {
    const { resolvedPath, mountPoint } = this.resolveDevicePath(uuid, relativePath)
    const entryStat = await stat(resolvedPath)
    return {
      name: basename(resolvedPath),
      path: toResponsePath(resolvedPath, mountPoint),
      isDir: entryStat.isDirectory(),
      size: entryStat.size,
      modTime: entryStat.mtime.toISOString(),
    }
  }

  async readFile(uuid: string, relativePath: string): Promise<Buffer> {
    const { resolvedPath } = this.resolveDevicePath(uuid, relativePath)
    const fileStat = await stat(resolvedPath)
    if (!fileStat.isFile()) {
      throw makeError('not_found', 'Not a file')
    }
    if (fileStat.size > MAX_READ_SIZE_BYTES) {
      throw makeError('file_too_large', `File exceeds ${MAX_READ_SIZE_BYTES} bytes`)
    }
    return readFile(resolvedPath)
  }

  async diskUsage(uuid: string): Promise<USBDiskUsage> {
    const device = this.requireMountedDevice(uuid)
    const fsStats = await statfs(device.mountPoint)
    const totalBytes = Number(fsStats.blocks) * Number(fsStats.bsize)
    const freeBytes = Number(fsStats.bavail) * Number(fsStats.bsize)
    return {
      totalBytes: Number.isFinite(totalBytes) ? totalBytes : null,
      freeBytes: Number.isFinite(freeBytes) ? freeBytes : null,
      usedBytes: Number.isFinite(totalBytes - freeBytes) ? totalBytes - freeBytes : null,
    }
  }

  async copyFileToWorkspace(
    uuid: string,
    relativePath: string,
    workspace: string,
    destinationRelativePath?: string,
  ): Promise<{ workspacePath: string, relativeWorkspacePath: string, size: number }> {
    const { resolvedPath, mountPoint } = this.resolveDevicePath(uuid, relativePath)
    const fileStat = await stat(resolvedPath)
    if (!fileStat.isFile()) {
      throw makeError('not_found', 'Not a file')
    }

    const workspaceRoot = resolve(String(workspace || '').trim())
    if (!workspaceRoot) {
      throw makeError('invalid_workspace', 'Workspace path is required')
    }

    const defaultRelativePath = ['usb-imports', uuid, toResponsePath(resolvedPath, mountPoint).replace(/^\/+/, '')]
      .filter(Boolean)
      .join('/')
    const targetRelativePath = this.normalizeWorkspaceRelativePath(destinationRelativePath, defaultRelativePath)
    const targetAbsolutePath = resolve(workspaceRoot, ...targetRelativePath.split('/'))
    if (targetAbsolutePath !== workspaceRoot && !isPathWithin(targetAbsolutePath, workspaceRoot)) {
      throw makeError('invalid_path', 'Invalid workspace destination path')
    }

    await mkdir(dirname(targetAbsolutePath), { recursive: true })
    await copyFile(resolvedPath, targetAbsolutePath)
    return {
      workspacePath: targetAbsolutePath,
      relativeWorkspacePath: targetRelativePath,
      size: fileStat.size,
    }
  }

  ingestMonitorMessage(message: USBMonitorMessage): void {
    if (message.type === 'ready') {
      this.clearReadyTimer()
      this.runtimeStatus.state = 'running'
      this.runtimeStatus.lastReadyAt = message.ts
      for (const event of message.existing_devices || []) {
        this.applyDeviceEvent(event, false)
      }
      this.emit('ready', {
        ts: message.ts,
        existingDevices: this.listDevices(),
        runtime: this.status(),
      })
      return
    }
    if (message.type === 'heartbeat') {
      this.clearReadyTimer()
      this.runtimeStatus.lastHeartbeatAt = message.ts
      if (this.runtimeStatus.state !== 'unsupported') this.runtimeStatus.state = 'running'
      this.emit('heartbeat', {
        ts: message.ts,
        deviceCount: this.listDevices().length,
        runtime: this.status(),
      })
      return
    }
    this.applyDeviceEvent(message, true)
  }

  private shouldStartMonitor(): boolean {
    if (envFlagEnabled(this.env.USB_MONITOR_DISABLED, false)) return false
    if (envFlagEnabled(this.env.USB_MONITOR_FORCE_START, false)) return true
    return this.platform === 'linux'
  }

  private monitorScriptPath(): string {
    return resolve(this.deployDir, 'hermes_data', 'bots', 'usb', 'usb_monitor.py')
  }

  private pythonBin(): string {
    return String(this.env.USB_MONITOR_PYTHON_BIN || '').trim() || 'python3'
  }

  private spawnMonitor(scriptPath: string): void {
    try {
      const child = spawn(this.pythonBin(), [scriptPath], {
        cwd: this.deployDir,
        env: {
          ...this.env,
          HERMES_WEB_UI_HOME: this.appHome,
          HERMES_WEBUI_STATE_DIR: this.appHome,
          PYTHONUNBUFFERED: '1',
          USB_USE_SUDO: this.env.USB_USE_SUDO ?? '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.monitor = child
      this.armReadyTimer()

      const stdout = createInterface({ input: child.stdout })
      stdout.on('line', (line) => this.handleMonitorLine(line))

      const stderr = createInterface({ input: child.stderr })
      stderr.on('line', (line) => {
        const trimmed = line.trim()
        if (!trimmed) return
        this.runtimeStatus.lastError = trimmed
        logger.warn({ line: trimmed }, '[usb] monitor stderr')
      })

      child.once('error', (error) => {
        this.monitor = null
        this.clearReadyTimer()
        this.runtimeStatus.state = 'error'
        this.runtimeStatus.lastError = error instanceof Error ? error.message : String(error)
        logger.warn({ err: error }, '[usb] monitor process error')
        this.scheduleRestart()
      })

      child.once('exit', (code, signal) => {
        this.monitor = null
        this.clearReadyTimer()
        if (this.stopRequested) return
        this.runtimeStatus.state = 'error'
        this.runtimeStatus.lastError = `USB monitor exited (code=${String(code)} signal=${String(signal)})`
        logger.warn({ code, signal }, '[usb] monitor exited')
        this.scheduleRestart()
      })
    } catch (error) {
      this.runtimeStatus.state = 'error'
      this.runtimeStatus.lastError = error instanceof Error ? error.message : String(error)
      logger.warn({ err: error }, '[usb] failed to spawn monitor')
      this.scheduleRestart()
    }
  }

  private scheduleRestart(): void {
    if (this.stopRequested || this.restartTimer || !this.shouldStartMonitor()) return
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.stopRequested) this.start()
    }, MONITOR_RESTART_DELAY_MS)
    this.restartTimer.unref?.()
  }

  private armReadyTimer(): void {
    this.clearReadyTimer()
    this.readyTimer = setTimeout(() => {
      if (this.runtimeStatus.state !== 'starting') return
      this.runtimeStatus.lastError = `USB monitor did not emit ready within ${MONITOR_READY_TIMEOUT_MS}ms`
      logger.warn({ scriptPath: this.runtimeStatus.monitorScriptPath }, '[usb] monitor ready timeout')
    }, MONITOR_READY_TIMEOUT_MS)
    this.readyTimer.unref?.()
  }

  private clearReadyTimer(): void {
    if (!this.readyTimer) return
    clearTimeout(this.readyTimer)
    this.readyTimer = null
  }

  private handleMonitorLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      const payload = JSON.parse(trimmed) as USBMonitorMessage
      this.ingestMonitorMessage(payload)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.runtimeStatus.lastError = `Invalid USB monitor payload: ${message}`
      logger.warn({ line: trimmed, err: error }, '[usb] failed to parse monitor payload')
    }
  }

  private applyDeviceEvent(event: USBMonitorDeviceEvent, persistHistory: boolean): void {
    const uuid = String(event.uuid || '').trim()
    if (!uuid) return
    if (event.action === 'remove') {
      this.devices.delete(uuid)
    } else {
      this.devices.set(uuid, {
        uuid,
        deviceNode: String(event.device_node || ''),
        mountPoint: String(event.mount_point || ''),
        fsType: event.fs_type == null ? null : String(event.fs_type),
        label: event.label == null ? null : String(event.label),
        vendor: event.vendor == null ? null : String(event.vendor),
        model: event.model == null ? null : String(event.model),
        serial: event.serial == null ? null : String(event.serial),
        sizeBytes: event.size_bytes == null ? null : Number(event.size_bytes),
        status: event.status === 'mount_failed' ? 'mount_failed' : 'mounted',
        error: event.error == null ? null : String(event.error),
        ts: event.ts,
      })
    }
    if (persistHistory) {
      const stored = this.eventStore.persist(event)
      this.emit('device_event', stored)
    }
  }

  private pruneHistory(): number {
    return this.eventStore.deleteBefore(Date.now() - HISTORY_RETENTION_MS)
  }

  private requireMountedDevice(uuid: string): USBDeviceRecord {
    const device = this.devices.get(uuid)
    if (!device || device.status !== 'mounted' || !device.mountPoint) {
      throw makeError('not_found', 'USB device not found')
    }
    return device
  }

  private resolveDevicePath(uuid: string, inputPath: string): { resolvedPath: string, mountPoint: string } {
    const device = this.requireMountedDevice(uuid)
    const rawPath = String(inputPath || '/').replace(/\\/g, '/')
    if (rawPath.split('/').some(segment => segment === '..')) {
      throw makeError('invalid_path', 'Invalid file path')
    }
    const normalizedPath = normalize(rawPath).replace(/\\/g, '/')
    const targetPath = normalizedPath === '/' || normalizedPath === '.'
      ? device.mountPoint
      : resolve(device.mountPoint, normalizedPath.startsWith('/') ? `.${normalizedPath}` : normalizedPath)
    if (!isPathWithin(targetPath, device.mountPoint)) {
      throw makeError('invalid_path', 'Path traversal detected')
    }
    return { resolvedPath: targetPath, mountPoint: device.mountPoint }
  }

  private normalizeWorkspaceRelativePath(inputPath: string | undefined, fallbackPath: string): string {
    const rawPath = String(inputPath || fallbackPath || '').replace(/\\/g, '/').trim()
    const normalizedPath = rawPath.replace(/^\/+/, '')
    if (!normalizedPath) {
      throw makeError('invalid_path', 'Invalid workspace destination path')
    }
    if (normalizedPath.split('/').some(segment => segment === '..')) {
      throw makeError('invalid_path', 'Invalid workspace destination path')
    }
    return normalizedPath
  }
}
