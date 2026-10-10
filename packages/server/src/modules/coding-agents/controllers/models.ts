import type { Context } from 'koa'
import { getCodingAgentModels } from '../services'

export async function models(ctx: Context) {
  const agent = ctx.query.agent
  const refresh = ctx.query.refresh
  if ((agent !== undefined && (typeof agent !== 'string' || !agent))
    || (refresh !== undefined && refresh !== 'true' && refresh !== 'false')) {
    ctx.status = 400
    ctx.body = { error: 'Expected an agent identifier and refresh=true or refresh=false' }
    return
  }
  try {
    ctx.set('Cache-Control', 'no-store')
    ctx.body = await getCodingAgentModels({ agent, refresh: refresh === 'true' })
  } catch (error: any) {
    ctx.status = error.status === 400 ? 400 : 500
    ctx.body = { error: error.status === 400 ? 'Unknown coding agent' : 'Unable to discover coding agent models' }
  }
}
