import type { Context } from 'koa'
import { listUserProfiles } from '../../studio/public/users'
import { listProfileNamesFromDisk } from '../services/profiles/profile'
import { getApiRelayUsage } from '../services/providers/api-relay-usage'

export async function getRelayUsage(ctx: Context): Promise<void> {
  const user = ctx.state.user
  if (!user) {
    ctx.status = 401
    ctx.body = { error: 'Authentication required' }
    return
  }
  const allowed = user.role === 'super_admin' ? null : new Set(listUserProfiles(user.id).map(item => item.profile_name))
  const profiles = listProfileNamesFromDisk().filter(profile => !allowed || allowed.has(profile))
  ctx.set('Cache-Control', 'no-store')
  try { ctx.body = await getApiRelayUsage(profiles) } catch {
    ctx.status = 500
    ctx.body = { error: 'Unable to read API relay configuration', code: 'API_RELAY_CONFIG_FAILED' }
  }
}
