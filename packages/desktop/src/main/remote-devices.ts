import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeRemoteServerUrl, requireRemoteServerRootUrl, REMOTE_SERVER_SETTINGS_NAME, REMOTE_SERVER_URL_ENV } from './remote-server'

export interface DesktopRemoteDevice {
  id: string
  name: string
  serverUrl: string
}

export interface DesktopRemoteDevicesState {
  devices: DesktopRemoteDevice[]
  activeDeviceId: string | null
  activeServerUrl: string | null
}

interface Settings {
  serverUrl: string | null
  devices: DesktopRemoteDevice[]
}

interface Options {
  home: string
  activeServerUrl: string | null
  env: NodeJS.ProcessEnv
  checkReady: (url: string) => Promise<void>
  restart: () => boolean
}

function fail(code: string): never {
  throw new Error(`REMOTE_DEVICE_${code}`)
}

// Desktop-owned state: never store this list or local credentials on a remote server.
export class DesktopRemoteDevices {
  private readonly file: string
  private settings: Settings
  private switching = false

  constructor(private readonly options: Options) {
    this.file = join(options.home, REMOTE_SERVER_SETTINGS_NAME)
    this.settings = this.read()
    // Import the legacy single URL and the current environment override, so both
    // remain available after the first switch back to the local device.
    for (const url of [this.settings.serverUrl, options.activeServerUrl]) {
      if (url && !this.settings.devices.some(device => device.serverUrl === url)) {
        this.settings.devices.push({ id: randomUUID(), name: new URL(url).host, serverUrl: url })
      }
    }
  }

  private read(): Settings {
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { serverUrl: null, devices: [] }
      return fail('LOAD_FAILED')
    }
    try {
      const data = JSON.parse(raw)
      if (!data || typeof data !== 'object' || Array.isArray(data)) return fail('LOAD_FAILED')
      const devices: DesktopRemoteDevice[] = []
      if (data.devices !== undefined && !Array.isArray(data.devices)) return fail('LOAD_FAILED')
      for (const device of data.devices || []) {
        const serverUrl = normalizeRemoteServerUrl(device?.serverUrl)
        if (!serverUrl || typeof device.id !== 'string' || !device.id
          || typeof device.name !== 'string' || !device.name.trim()
          || devices.some(row => row.id === device.id || row.serverUrl === serverUrl)) return fail('LOAD_FAILED')
        devices.push({ id: device.id, name: device.name, serverUrl })
      }
      return { devices, serverUrl: normalizeRemoteServerUrl(data.serverUrl) }
    } catch {
      return fail('LOAD_FAILED')
    }
  }

  private persist(settings: Settings): void {
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.file)
      this.settings = settings
    } catch {
      return fail('SAVE_FAILED')
    } finally {
      try { rmSync(temporary, { force: true }) } catch { /* preserve the original persistence error */ }
    }
  }

  state(): DesktopRemoteDevicesState {
    return {
      devices: this.settings.devices.map(device => ({ ...device })),
      activeDeviceId: this.settings.devices.find(device => device.serverUrl === this.options.activeServerUrl)?.id ?? null,
      activeServerUrl: this.options.activeServerUrl,
    }
  }

  add(input: unknown): DesktopRemoteDevicesState {
    if (this.switching) return fail('BUSY')
    const value = input as Partial<DesktopRemoteDevice> | null
    const name = typeof value?.name === 'string' ? value.name.trim() : ''
    if (!name || name.length > 80) return fail('INVALID_NAME')
    const serverUrl = normalizeRemoteServerUrl(value?.serverUrl)
    if (!serverUrl || serverUrl.length > 2048) return fail('INVALID_URL')
    const parsed = new URL(value!.serverUrl!)
    if (parsed.username || parsed.password) return fail('INVALID_URL')
    requireRemoteServerRootUrl(serverUrl)
    if (this.settings.devices.some(device => device.serverUrl === serverUrl)) return fail('DUPLICATE')
    if (this.settings.devices.length >= 50) return fail('LIMIT')
    this.persist({ ...this.settings, devices: [...this.settings.devices, { id: randomUUID(), name, serverUrl }] })
    return this.state()
  }

  remove(id: unknown): DesktopRemoteDevicesState {
    if (this.switching) return fail('BUSY')
    const device = this.settings.devices.find(row => row.id === id)
    if (!device) return fail('NOT_FOUND')
    if (device.serverUrl === this.options.activeServerUrl) return fail('ACTIVE')
    const devices = this.settings.devices.filter(row => row !== device)
    this.persist({ devices, serverUrl: this.settings.serverUrl === device.serverUrl ? null : this.settings.serverUrl })
    return this.state()
  }

  async switchTo(id: unknown): Promise<void> {
    if (this.switching) return fail('BUSY')
    const device = id === null ? null : this.settings.devices.find(row => row.id === id)
    if (device === undefined) return fail('NOT_FOUND')
    const serverUrl = device?.serverUrl ?? null
    if (serverUrl === this.options.activeServerUrl) return
    if (serverUrl) requireRemoteServerRootUrl(serverUrl)
    this.switching = true
    try {
      if (serverUrl) {
        try { await this.options.checkReady(serverUrl) } catch { return fail('UNREACHABLE') }
      }
      const previous = this.settings
      const envOverride = this.options.env[REMOTE_SERVER_URL_ENV]
      this.persist({ ...this.settings, serverUrl })
      // A one-off environment launch must not pin the next UI-requested restart
      // to the old server. Fresh automated launches can still override the file.
      delete this.options.env[REMOTE_SERVER_URL_ENV]
      try {
        if (!this.options.restart()) return fail('RESTART_FAILED')
      } catch (error) {
        if (envOverride !== undefined) this.options.env[REMOTE_SERVER_URL_ENV] = envOverride
        this.persist(previous)
        throw error
      }
    } catch (error) {
      this.switching = false
      throw error
    }
  }
}
