import { mkdir, readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { config } from '../../public/config'
import { logger } from '../../public/logging'

/**
 * Token Platform device binding state for this Hermes device.
 *
 * Two files live under the Web UI app home:
 * - `device-id`            — a stable random UUID identifying this device to the
 *                            Token Platform (`hardware_id`). Generated once and
 *                            reused so re-scanning keeps the same bound device.
 * - `device-binding.json`  — the last successful Token Platform login result
 *                            (api_key, api_base, models, display_name, ...).
 *                            Used to restore a bound session on later boots and
 *                            to surface the bound account in the UI.
 */

const DEVICE_ID_FILE = 'device-id'
const BINDING_FILE = 'device-binding.json'

export interface DeviceBinding {
  device_id: string
  api_base: string
  api_key: string
  models: string[]
  display_name: string
  username: string
  bound_at: number
  expires_at?: number
  /** Token Platform user id; used to resolve the local `tp_<id>` user on unbind. */
  profile_id?: number
}

export function deviceIdFilePath(): string {
  return join(config.appHome, DEVICE_ID_FILE)
}

export function deviceBindingFilePath(): string {
  return join(config.appHome, BINDING_FILE)
}

async function ensureAppHome(): Promise<void> {
  await mkdir(config.appHome, { recursive: true })
}

/**
 * Return the stable hardware id for this device, creating and persisting a new
 * random UUID on first call.
 */
export async function getOrCreateHardwareId(): Promise<string> {
  await ensureAppHome()
  const file = deviceIdFilePath()
  if (existsSync(file)) {
    try {
      const existing = (await readFile(file, 'utf-8')).trim()
      if (existing) return existing
    } catch (err: any) {
      logger.warn({ err }, 'Failed to read device id, regenerating')
    }
  }
  const id = randomUUID()
  await writeFile(file, id, 'utf-8')
  return id
}

export async function getHardwareId(): Promise<string | null> {
  await ensureAppHome()
  const file = deviceIdFilePath()
  if (!existsSync(file)) return null
  try {
    return (await readFile(file, 'utf-8')).trim() || null
  } catch {
    return null
  }
}

export async function loadDeviceBinding(): Promise<DeviceBinding | null> {
  const file = deviceBindingFilePath()
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(await readFile(file, 'utf-8')) as DeviceBinding
    if (!parsed?.api_key || !parsed.api_base) return null
    return parsed
  } catch (err: any) {
    logger.warn({ err }, 'Failed to parse device binding, ignoring')
    return null
  }
}

export async function saveDeviceBinding(binding: DeviceBinding): Promise<void> {
  await ensureAppHome()
  const file = deviceBindingFilePath()
  try {
    await writeFile(file, JSON.stringify(binding, null, 2) + '\n', 'utf-8')
  } catch (err: any) {
    logger.error({ err }, 'Failed to persist device binding')
  }
}

export async function clearDeviceBinding(): Promise<void> {
  const file = deviceBindingFilePath()
  if (!existsSync(file)) return
  try {
    await writeFile(file, '', 'utf-8')
  } catch (err: any) {
    logger.error({ err }, 'Failed to clear device binding')
  }
}
