import { listHermesPlugins, setHermesPluginEnabled } from '../services/plugins/plugins'

export async function list(ctx: any) {
  try {
    ctx.body = await listHermesPlugins(ctx.state?.profile?.name)
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message || 'Failed to discover Hermes plugins' }
  }
}

export async function enable(ctx: any) {
  await setPluginEnabled(ctx, true)
}

export async function disable(ctx: any) {
  await setPluginEnabled(ctx, false)
}

async function setPluginEnabled(ctx: any, enabled: boolean) {
  try {
    const key = String(ctx.params?.key || '').trim()
    if (!key) {
      ctx.status = 400
      ctx.body = { error: 'Plugin key is required' }
      return
    }
    ctx.body = await setHermesPluginEnabled(ctx.state?.profile?.name, key, enabled)
  } catch (err: any) {
    const message = err.message || 'Failed to update Hermes plugin'
    ctx.status = message.includes('not found') ? 404 : message.includes('cannot be managed') ? 400 : 500
    ctx.body = { error: message }
  }
}
