import axios from 'axios'
import { getActiveProfileName } from '../services/profiles/profile'
import { gatewayAutostartDisabledByEnv, restartGatewayForProfile } from '../services/gateway/autostart'
import { saveEnvValueForProfile } from '../../studio/public/profile-config'
import { normalizeGatewayAutoStartConfig, readAppConfig } from '../../studio/public/app-config'

const ILINK_BASE = 'https://ilinkai.weixin.qq.com'

function requestedProfile(ctx: any): string {
  return ctx.state?.profile?.name || getActiveProfileName() || 'default'
}

async function gatewayAutoRestartAllowed(): Promise<boolean> {
  if (gatewayAutostartDisabledByEnv()) return false
  return normalizeGatewayAutoStartConfig((await readAppConfig()).gatewayAutoStart).enabled === true
}

export async function getQrcode(ctx: any) {
  try {
    const res = await axios.get(`${ILINK_BASE}/ilink/bot/get_bot_qrcode`, { params: { bot_type: 3 }, timeout: 15000 })
    const data = res.data
    if (!data || !data.qrcode) { ctx.status = 500; ctx.body = { error: 'Failed to get QR code' }; return }
    ctx.body = { qrcode: data.qrcode, qrcode_url: data.qrcode_img_content }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message || 'Failed to connect to iLink API' }
  }
}

export async function pollStatus(ctx: any) {
  const qrcode = ctx.query.qrcode as string
  if (!qrcode) { ctx.status = 400; ctx.body = { error: 'Missing qrcode parameter' }; return }
  try {
    const res = await axios.get(`${ILINK_BASE}/ilink/bot/get_qrcode_status`, { params: { qrcode }, timeout: 35000 })
    const data = res.data
    const status = data?.status || 'wait'
    if (status === 'confirmed') {
      ctx.body = { status: 'confirmed', account_id: data.ilink_bot_id, token: data.bot_token, base_url: data.baseurl }
    } else {
      ctx.body = { status }
    }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message || 'Failed to poll QR status' }
  }
}

export async function save(ctx: any) {
  const { account_id, token, base_url } = ctx.request.body as { account_id: string; token: string; base_url?: string }
  if (!account_id || !token) { ctx.status = 400; ctx.body = { error: 'Missing account_id or token' }; return }
  try {
    const profile = requestedProfile(ctx)
    const entries: Record<string, string> = { WEIXIN_ACCOUNT_ID: account_id, WEIXIN_TOKEN: token }
    if (base_url) entries.WEIXIN_BASE_URL = base_url
    for (const [key, val] of Object.entries(entries)) {
      await saveEnvValueForProfile(profile, key, val)
    }
    if (await gatewayAutoRestartAllowed()) await restartGatewayForProfile(profile)
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
}
