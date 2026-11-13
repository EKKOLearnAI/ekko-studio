import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
const state = vi.hoisted(() => ({ describe: vi.fn().mockResolvedValue('画面中有一个红色物体。'), directory: '', config: { deviceId: '68:ee:8f:5d:a6:9c', deviceIds: ['98:a3:16:f3:0f:68'], deviceToken: 'camera-secret', gatewayMcpToken: 'mcp-secret' } }))
vi.mock('../../packages/server/src/modules/studio/services/xiaozhi-vision', () => ({ describeXiaozhiFrame: state.describe }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ getWebUiHome: () => state.directory }))
vi.mock('../../packages/server/src/modules/studio/services/xiaozhi-provisioning', () => ({ readXiaozhiConfig: async () => state.config }))
import { analyzeCameraPhoto, authorizeCameraUpload, captureXiaozhiPhoto, readCameraPhoto, saveCameraPhoto } from '../../packages/server/src/modules/studio/services/xiaozhi-camera'
import { uploadCameraPhoto } from '../../packages/server/src/modules/studio/controllers/xiaozhi-camera'
describe('XiaoZhi camera', () => {
  beforeEach(async () => { state.directory = await mkdtemp(join(tmpdir(), 'xiaozhi-camera-')) })
  afterEach(async () => { vi.unstubAllGlobals(); await rm(state.directory, { recursive: true, force: true }) })
  it('requires both the configured device and its bearer token', async () => {
    expect(await authorizeCameraUpload(state.config.deviceId, 'camera-secret')).toBe(true)
    expect(await authorizeCameraUpload('unknown', 'camera-secret')).toBe(false)
    expect(await authorizeCameraUpload(state.config.deviceId, 'wrong')).toBe(false)
  })
  it('stores real JPEGs and rejects malformed data and path traversal', async () => {
    const jpeg = await sharp({ create: { width: 32, height: 24, channels: 3, background: 'red' } }).jpeg().toBuffer()
    const photo = await saveCameraPhoto(jpeg, state.config.deviceId)
    expect(photo.width).toBe(32); expect(photo.height).toBe(24)
    expect(await readCameraPhoto(photo.id)).toEqual(jpeg)
    expect(await readCameraPhoto('../../secret')).toBeNull()
    await expect(saveCameraPhoto(Buffer.from('not jpeg'), state.config.deviceId)).rejects.toThrow()
  })
  it('accepts the firmware chunked multipart upload without altering image bytes', async () => {
    const jpeg = await sharp({ create: { width: 16, height: 12, channels: 3, background: 'blue' } }).jpeg().toBuffer()
    const raw = Buffer.concat([Buffer.from('--cam\r\nContent-Disposition: form-data; name="question"\r\n\r\nphoto\r\n--cam\r\nContent-Disposition: form-data; name="file"; filename="camera.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'), jpeg, Buffer.from('\r\n--cam--\r\n')])
    const headers: Record<string, string> = { 'device-id': state.config.deviceId, authorization: 'Bearer camera-secret', 'content-type': 'multipart/form-data; boundary=cam' }
    const ctx: any = { set: vi.fn(), get: (name: string) => headers[name] || '', req: (async function* () { for (let offset=0; offset<raw.length; offset+=79) yield raw.subarray(offset, offset+79) })() }
    await uploadCameraPhoto(ctx)
    expect(ctx.body.width).toBe(16); expect(await readCameraPhoto(ctx.body.id)).toEqual(jpeg)
  })
  it('routes camera calls to the configured new device rather than another camera', async () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ result: { tools: [{ name: 'device_other__self_camera_take_photo' }, { name: 'device_68_ee_8f_5d_a6_9c__self_camera_take_photo' }] } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: { content: [{ type: 'text', text: JSON.stringify({ id }) }] } }) })
    vi.stubGlobal('fetch', fetch)
    expect((await captureXiaozhiPhoto()).id).toBe(id)
    expect(JSON.parse(fetch.mock.calls[1][1].body).params.name).toBe('device_68_ee_8f_5d_a6_9c__self_camera_take_photo')
  })
  it('reports an offline camera instead of reporting a successful capture', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: { tools: [] } }) }))
    await expect(captureXiaozhiPhoto()).rejects.toThrow('offline')
  })
  it('analyzes actual JPEG bytes only for their owning device', async () => {
    const jpeg = await sharp({ create: { width: 16, height: 12, channels: 3, background: 'red' } }).jpeg().toBuffer()
    const photo = await saveCameraPhoto(jpeg, state.config.deviceId)
    await expect(analyzeCameraPhoto(photo.id, 'other-device', '是什么？')).rejects.toThrow('another device')
    expect((await analyzeCameraPhoto(photo.id, state.config.deviceId, '是什么？')).analysis).toContain('红色')
    expect(state.describe).toHaveBeenCalledWith(jpeg, '是什么？')
  })
})
