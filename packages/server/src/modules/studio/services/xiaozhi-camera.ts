import { timingSafeEqual, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { getWebUiHome } from '../public/config'
import { readXiaozhiConfig } from './xiaozhi-provisioning'
import { describeXiaozhiFrame } from './xiaozhi-vision'

const photoDir = () => join(getWebUiHome(), 'devices', 'xiaozhi', 'photos')
export const validPhotoId = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)
export async function authorizeCameraUpload(deviceId: string, token: string) {
  const config = await readXiaozhiConfig()
  if (!config || ![config.deviceId, ...(config.deviceIds || [])].some(id => id.toLowerCase() === deviceId.toLowerCase())) return false
  const expected = Buffer.from(config.deviceToken), actual = Buffer.from(token)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
export async function saveCameraPhoto(jpeg: Buffer, deviceId: string) {
  if (jpeg.length < 4 || jpeg.length > 3 * 1024 * 1024 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg.at(-2) !== 0xff || jpeg.at(-1) !== 0xd9) throw new Error('Invalid camera JPEG')
  const metadata = await sharp(jpeg, { limitInputPixels: 4_000_000 }).metadata()
  if (metadata.format !== 'jpeg' || !metadata.width || !metadata.height) throw new Error('Invalid camera JPEG')
  const id = randomUUID(), directory = photoDir()
  await mkdir(directory, { recursive: true })
  const photo = { id, deviceId, width: metadata.width, height: metadata.height, createdAt: new Date().toISOString(), url: `/api/studio/xiaozhi/photos/${id}` }
  await writeFile(join(directory, `${id}.jpg`), jpeg, { mode: 0o600 })
  await writeFile(join(directory, `${id}.json`), JSON.stringify(photo), { mode: 0o600 })
  return photo
}
export async function readCameraPhoto(id: string) {
  if (!validPhotoId(id)) return null
  try { return await readFile(join(photoDir(), `${id}.jpg`)) } catch { return null }
}
export async function analyzeCameraPhoto(id: string, deviceId: string, question: string) {
  if (!validPhotoId(id)) throw new Error('Invalid camera photo')
  const metadata = JSON.parse(await readFile(join(photoDir(), `${id}.json`), 'utf8'))
  if (String(metadata.deviceId).toLowerCase() !== deviceId.toLowerCase()) throw new Error('Camera photo belongs to another device')
  const photo = await readCameraPhoto(id)
  if (!photo) throw new Error('Camera photo not found')
  return { id, analysis: await describeXiaozhiFrame(photo, question) }
}
export async function captureXiaozhiPhoto() {
  const config = await readXiaozhiConfig()
  if (!config?.gatewayMcpToken) throw new Error('Camera gateway is not configured')
  const rpc = async (method: string, params?: object) => {
    const response = await fetch('http://127.0.0.1:8766/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.gatewayMcpToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(25_000), redirect: 'error',
    })
    if (!response.ok) throw new Error('Camera gateway unavailable')
    const message = await response.json() as any
    if (message.error || message.result?.isError) throw new Error(message.error?.message || message.result?.content?.[0]?.text || 'Camera capture failed')
    return message.result
  }
  const prefix = `device_${config.deviceId.toLowerCase().replace(/[^a-z0-9]+/g, '_')}__`
  const listing = await rpc('tools/list')
  const tool = listing?.tools?.find((entry: any) => entry.name === `${prefix}self_camera_take_photo`)
  if (!tool) throw new Error('Camera device offline. Connect Wi-Fi and wake XiaoZhi first.')
  const result = await rpc('tools/call', { name: tool.name, arguments: { question: '拍摄一张照片并保存到本机。' } })
  const photo = JSON.parse(result?.content?.[0]?.text || '{}')
  if (!validPhotoId(photo.id || '')) throw new Error('Camera did not return a saved photo')
  return photo
}
