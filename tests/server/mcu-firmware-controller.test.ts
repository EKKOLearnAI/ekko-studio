import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalCwd = process.cwd()
let tempRoot = ''

beforeEach(async () => {
  vi.resetModules()
  tempRoot = ''
})

afterEach(async () => {
  process.chdir(originalCwd)
  vi.unstubAllEnvs()
  vi.resetModules()
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
})

describe('MCU firmware controller', () => {
  describe.each(['development', 'production'] as const)('%s firmware downloads', environment => {
    it.each(['v1', 'v2'] as const)('serves matching %s manifest and firmware bytes', async version => {
      tempRoot = await makeTempRoot()
      process.chdir(tempRoot)
      vi.stubEnv('NODE_ENV', environment)

      const firmware = Buffer.from(`${environment}-${version}`)
      const firmwareDir = environment === 'production'
        ? `dist/mcu/${version}`
        : `packages/mcu/esp32-c3/${version}/.pio/build/esp32-c3-devkitm-1`
      await mkdir(path.join(tempRoot, firmwareDir), { recursive: true })
      await writeFile(path.join(tempRoot, firmwareDir, 'firmware.bin'), firmware)
      const ctrl = await import('../../packages/server/src/modules/studio/controllers/mcu-firmware')
      const manifestCtx = makeCtx({ version })
      const downloadCtx = makeCtx({ version })

      await ctrl.manifest(manifestCtx)
      await ctrl.download(downloadCtx)

      const sha256 = createHash('sha256').update(firmware).digest('hex')
      const md5 = createHash('md5').update(firmware).digest('hex')
      expect(manifestCtx.status).toBe(200)
      expect(manifestCtx.body).toMatchObject({
        channel: environment,
        firmwareVersion: version,
        url: `/api/studio/mcu/firmware/${version}/firmware.bin`,
        size: firmware.length,
        sha256,
        md5,
      })
      expect(downloadCtx.status).toBe(200)
      expect(downloadCtx.set).toHaveBeenCalledWith('X-MCU-Firmware-Version', version)
      expect(downloadCtx.set).toHaveBeenCalledWith('Content-Length', String(firmware.length))
      expect(downloadCtx.set).toHaveBeenCalledWith('X-Firmware-SHA256', sha256)
      expect(downloadCtx.set).toHaveBeenCalledWith('X-Firmware-MD5', md5)
      const chunks: Buffer[] = []
      for await (const chunk of downloadCtx.body) chunks.push(chunk)
      expect(Buffer.concat(chunks)).toEqual(firmware)
    })
  })

  it('keeps legacy downloads on v1 with the original dist fallback', async () => {
    tempRoot = await makeTempRoot()
    process.chdir(tempRoot)
    vi.stubEnv('NODE_ENV', 'production')

    const firmware = Buffer.from('legacy-v1-fallback')
    await writeFile(path.join(tempRoot, 'dist/mcu/firmware.bin'), firmware)
    await writeFile(path.join(tempRoot, 'dist/mcu/v2/firmware.bin'), Buffer.from('v2-only'))
    const ctrl = await import('../../packages/server/src/modules/studio/controllers/mcu-firmware')
    const manifestCtx = makeCtx({ version: 'v2' })
    const downloadCtx = makeCtx({ version: 'v2' })

    await ctrl.legacyManifest(manifestCtx)
    await ctrl.legacyDownload(downloadCtx)

    expect(manifestCtx.status).toBe(200)
    expect(manifestCtx.body).toMatchObject({
      firmwareVersion: 'v1',
      url: '/api/studio/mcu/firmware/v1/firmware.bin',
      sha256: createHash('sha256').update(firmware).digest('hex'),
    })
    expect(downloadCtx.status).toBe(200)
    expect(downloadCtx.set).toHaveBeenCalledWith('X-Legacy-Firmware-Route', '/api/studio/mcu/firmware.bin')
    expect(downloadCtx.set).toHaveBeenCalledWith('X-MCU-Firmware-Version', 'v1')
    const chunks: Buffer[] = []
    for await (const chunk of downloadCtx.body) chunks.push(chunk)
    expect(Buffer.concat(chunks)).toEqual(firmware)
  })

  it('serves a version-isolated v1 manifest', async () => {
    tempRoot = await makeTempRoot()
    process.chdir(tempRoot)
    vi.stubEnv('NODE_ENV', 'production')

    const firmware = Buffer.from('firmware-v1')
    await writeFile(path.join(tempRoot, 'dist/mcu/v1/firmware.bin'), firmware)
    const ctrl = await import('../../packages/server/src/modules/studio/controllers/mcu-firmware')
    const ctx = makeCtx({ version: 'v1' })

    await ctrl.manifest(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(ctx.body).toMatchObject({
      updateAvailable: true,
      target: 'hstudio-esp32-c3',
      channel: 'production',
      firmwareVersion: 'v1',
      size: firmware.length,
      sha256: createHash('sha256').update(firmware).digest('hex'),
      md5: createHash('md5').update(firmware).digest('hex'),
      url: '/api/studio/mcu/firmware/v1/firmware.bin',
    })
  })

  it('keeps the unversioned manifest pinned to v1 for already-shipped devices', async () => {
    tempRoot = await makeTempRoot()
    process.chdir(tempRoot)
    vi.stubEnv('NODE_ENV', 'production')

    const firmware = Buffer.from('legacy-device-v1')
    await writeFile(path.join(tempRoot, 'dist/mcu/v1/firmware.bin'), firmware)
    const ctrl = await import('../../packages/server/src/modules/studio/controllers/mcu-firmware')
    const ctx = makeCtx({})

    await ctrl.legacyManifest(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toMatchObject({
      updateAvailable: true,
      firmwareVersion: 'v1',
      url: '/api/studio/mcu/firmware/v1/firmware.bin',
      md5: createHash('md5').update(firmware).digest('hex'),
    })
  })

  it('serves v2 from its isolated firmware directory', async () => {
    tempRoot = await makeTempRoot()
    process.chdir(tempRoot)
    vi.stubEnv('NODE_ENV', 'production')

    const firmware = Buffer.from('firmware-v2')
    await writeFile(path.join(tempRoot, 'dist/mcu/v2/firmware.bin'), firmware)
    const ctrl = await import('../../packages/server/src/modules/studio/controllers/mcu-firmware')
    const ctx = makeCtx({ version: 'v2' })

    await ctrl.manifest(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toMatchObject({
      updateAvailable: true,
      firmwareVersion: 'v2',
      size: firmware.length,
      md5: createHash('md5').update(firmware).digest('hex'),
      url: '/api/studio/mcu/firmware/v2/firmware.bin',
    })
  })

  it('rejects unsupported firmware versions', async () => {
    tempRoot = await makeTempRoot()
    process.chdir(tempRoot)
    vi.stubEnv('NODE_ENV', 'production')

    const ctrl = await import('../../packages/server/src/modules/studio/controllers/mcu-firmware')
    const ctx = makeCtx({ version: 'v3' })

    await ctrl.manifest(ctx)

    expect(ctx.status).toBe(404)
    expect(ctx.body).toEqual({
      updateAvailable: false,
      error: 'unsupported mcu firmware version',
    })
  })
})

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcu-firmware-'))
  await mkdir(path.join(root, 'dist/mcu/v1'), { recursive: true })
  await mkdir(path.join(root, 'dist/mcu/v2'), { recursive: true })
  return root
}

function makeCtx(params: Record<string, unknown>) {
  return {
    params,
    status: 200,
    body: null as unknown,
    set: vi.fn(),
  } as any
}
