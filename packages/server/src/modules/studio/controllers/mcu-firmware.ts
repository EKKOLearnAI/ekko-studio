import type { Context } from 'koa'
import { createReadStream } from 'fs'
import { stat, readFile } from 'fs/promises'
import { createHash } from 'crypto'
import { resolve } from 'path'

interface FirmwareInfo {
  path: string
  channel: 'development' | 'production'
  firmwareVersion: FirmwareVersion
  size: number
  sha256: string
  md5: string
}

type FirmwareVersion = 'v1' | 'v2'
type FirmwareContext = Context & { params?: Record<string, unknown> }

const DEFAULT_FIRMWARE_VERSION: FirmwareVersion = 'v1'
const SUPPORTED_FIRMWARE_VERSIONS = new Set<string>(['v1', 'v2'] satisfies FirmwareVersion[])
const LEGACY_FIRMWARE_ROUTE = '/api/studio/mcu/firmware.bin'
const LEGACY_DIST_FIRMWARE_PATH = resolve(process.cwd(), 'dist', 'mcu', 'firmware.bin')
const DIST_FIRMWARE_PATHS: Record<FirmwareVersion, string> = {
  v1: resolve(process.cwd(), 'dist', 'mcu', 'v1', 'firmware.bin'),
  v2: resolve(process.cwd(), 'dist', 'mcu', 'v2', 'firmware.bin'),
}
const DEV_FIRMWARE_PATHS: Record<FirmwareVersion, string> = {
  v1: resolve(process.cwd(), 'packages/mcu/esp32-c3/v1/.pio/build/esp32-c3-devkitm-1/firmware.bin'),
  v2: resolve(process.cwd(), 'packages/mcu/esp32-c3/v2/.pio/build/esp32-c3-devkitm-1/firmware.bin'),
}

function firmwareVersionFromContext(ctx: Context): FirmwareVersion | null {
  const version = String((ctx as FirmwareContext).params?.version || DEFAULT_FIRMWARE_VERSION)
  return SUPPORTED_FIRMWARE_VERSIONS.has(version) ? version as FirmwareVersion : null
}

function firmwareRoute(version: FirmwareVersion): string {
  return `/api/studio/mcu/firmware/${version}/firmware.bin`
}

function firmwareSource(version: FirmwareVersion): Pick<FirmwareInfo, 'path' | 'channel'> {
  if (process.env.NODE_ENV === 'production') {
    return { path: DIST_FIRMWARE_PATHS[version], channel: 'production' }
  }
  return { path: DEV_FIRMWARE_PATHS[version], channel: 'development' }
}

async function findFirmware(version: FirmwareVersion): Promise<FirmwareInfo | null> {
  const source = firmwareSource(version)
  const fallbackPath = process.env.NODE_ENV === 'production' && version === DEFAULT_FIRMWARE_VERSION
    ? LEGACY_DIST_FIRMWARE_PATH
    : ''
  const paths = [source.path, fallbackPath].filter(Boolean)

  for (const filePath of paths) {
    const firmware = await readFirmwareInfo(filePath, source.channel, version)
    if (firmware) return firmware
  }

  return null
}

async function readFirmwareInfo(
  filePath: string,
  channel: FirmwareInfo['channel'],
  firmwareVersion: FirmwareVersion,
): Promise<FirmwareInfo | null> {
  try {
    const info = await stat(filePath)
    if (!info.isFile()) {
      return null
    }
    const data = await readFile(filePath)
    return {
      path: filePath,
      channel,
      firmwareVersion,
      size: info.size,
      sha256: createHash('sha256').update(data).digest('hex'),
      md5: createHash('md5').update(data).digest('hex'),
    }
  } catch {
    return null
  }
}

export async function manifest(ctx: Context) {
  const version = firmwareVersionFromContext(ctx)
  if (!version) {
    ctx.status = 404
    ctx.body = { updateAvailable: false, error: 'unsupported mcu firmware version' }
    return
  }

  const firmware = await findFirmware(version)
  if (!firmware) {
    ctx.status = 404
    ctx.body = { updateAvailable: false, error: 'mcu firmware not found' }
    return
  }

  ctx.set('Cache-Control', 'no-store')
  ctx.body = {
    updateAvailable: true,
    target: 'hstudio-esp32-c3',
    channel: firmware.channel,
    firmwareVersion: firmware.firmwareVersion,
    version: firmware.sha256.slice(0, 12),
    size: firmware.size,
    sha256: firmware.sha256,
    md5: firmware.md5,
    url: firmwareRoute(firmware.firmwareVersion),
  }
}

export async function download(ctx: Context) {
  const version = firmwareVersionFromContext(ctx)
  if (!version) {
    ctx.status = 404
    ctx.body = { error: 'unsupported mcu firmware version' }
    return
  }

  const firmware = await findFirmware(version)
  if (!firmware) {
    ctx.status = 404
    ctx.body = { error: 'mcu firmware not found' }
    return
  }

  ctx.set('Content-Type', 'application/octet-stream')
  ctx.set('Content-Length', String(firmware.size))
  ctx.set('Cache-Control', 'no-store')
  ctx.set('X-Firmware-Version', firmware.sha256.slice(0, 12))
  ctx.set('X-MCU-Firmware-Version', firmware.firmwareVersion)
  ctx.set('X-Firmware-SHA256', firmware.sha256)
  ctx.set('X-Firmware-MD5', firmware.md5)
  ctx.body = createReadStream(firmware.path)
}

export async function legacyManifest(ctx: Context) {
  // Already-shipped devices do not identify a firmware family and still poll
  // the unversioned route. Keep that route pinned to v1 so future firmware
  // families cannot be installed onto unversioned hardware by accident.
  const firmwareCtx = ctx as FirmwareContext
  firmwareCtx.params = { ...firmwareCtx.params, version: DEFAULT_FIRMWARE_VERSION }
  return manifest(ctx)
}

export async function legacyDownload(ctx: Context) {
  // Compatibility download path for the same unversioned v1 bootstrap channel.
  const firmwareCtx = ctx as FirmwareContext
  firmwareCtx.params = { ...firmwareCtx.params, version: DEFAULT_FIRMWARE_VERSION }
  ctx.set('X-Legacy-Firmware-Route', LEGACY_FIRMWARE_ROUTE)
  return download(ctx)
}
