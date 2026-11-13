import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inspectAppUserToken } from '../../public/auth'
import { config } from '../../public/config'
import { getAppRelayDeviceIdentity } from '../../public/system-info'
import type { PushActor } from '../../repositories/run-push-store'

export async function authenticatedPushActor(token: unknown): Promise<PushActor | null> {
  if (typeof token !== 'string' || !token) return null
  const app = await inspectAppUserToken(token)
  if (!app) return null
  if (app.status !== 'active' || !app.user || !app.deviceCode) throw new Error('push_device_authentication_failed')
  return { userId: app.user.id, deviceId: app.deviceCode,
    studioDeviceId: (await getAppRelayDeviceIdentity()).device_id }
}

export function encryptPushSecret(token: string): string {
  const file = join(config.appHome, '.push-token-key')
  mkdirSync(config.appHome, { recursive: true })
  let key: Buffer
  try { key = readFileSync(file) }
  catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
    try { writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 }) }
    catch (createError: any) { if (createError?.code !== 'EEXIST') throw createError }
    key = readFileSync(file)
  }
  if (key.length !== 32) throw new Error('push_token_key_invalid')
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.')
}

/** Optional notification data must never prevent admission of the actual run. */
export function prepareRunPushSnapshot(actor: PushActor, value: unknown): string | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const body = value as Record<string, unknown>
    if (body.schema_version !== 1 || !actor.studioDeviceId || body.studio_device_id !== actor.studioDeviceId
      || body.installation_ref !== actor.deviceId || !['ios', 'android'].includes(String(body.platform))) return null
    const appId = typeof body.app_id === 'string' ? body.app_id : ''
    const grantId = typeof body.grant_id === 'string' ? body.grant_id : ''
    const token = typeof body.push_token === 'string' ? body.push_token : ''
    const apnsToken = typeof body.apns_token === 'string' ? body.apns_token.trim().toLowerCase() : ''
    const environment = body.platform === 'ios' ? body.apns_environment : ''
    if (!/^[a-zA-Z0-9._-]{1,255}$/.test(appId) || !/^[a-zA-Z0-9-]{1,64}$/.test(grantId)
      || !/^push_[A-Za-z0-9_-]{43}$/.test(token) || !Number.isSafeInteger(body.cloud_user_id) || Number(body.cloud_user_id) <= 0) return null
    if (body.platform === 'ios' && (!['development', 'production'].includes(String(environment))
      || !/^[0-9a-f]{32,512}$/.test(apnsToken) || apnsToken.length % 2)) return null
    return encryptPushSecret(JSON.stringify({ schema_version: 1, studio_device_id: actor.studioDeviceId,
      installation_ref: actor.deviceId, platform: body.platform, app_id: appId,
      cloud_user_id: body.cloud_user_id, grant_id: grantId, push_token: token,
      apns_environment: environment, apns_token: body.platform === 'ios' ? apnsToken : '' }))
  } catch { return null }
}
