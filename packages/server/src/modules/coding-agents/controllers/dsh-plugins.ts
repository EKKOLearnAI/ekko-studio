import type { Context } from 'koa'
import { DshPluginError } from '../services/dsh/errors'
import { changeDshWebPlugins, dshPluginUi, getNativeDshPluginInventory } from '../services'

function errorResponse(ctx: Context, error: unknown) {
  ctx.status = error instanceof DshPluginError ? error.status : 500
  ctx.body = { code: error instanceof DshPluginError ? error.code : 'DSH_PLUGIN_OPERATION_FAILED',
    error: error instanceof DshPluginError ? error.message : 'Unable to access DSH plugin state' }
}
export async function inventory(ctx: Context) {
  try { ctx.body = await getNativeDshPluginInventory() } catch (error) { errorResponse(ctx, error) }
}
export async function change(ctx: Context) {
  try {
    const revision = ctx.get('If-Match')
    if (!/^"[a-f0-9]{64}"$/.test(revision)) throw new DshPluginError(400, 'DSH_SELECTION_INVALID', 'Expected the Web profile revision in If-Match')
    ctx.body = await changeDshWebPlugins(ctx.request.body, revision.slice(1, -1))
  } catch (error) { errorResponse(ctx, error) }
}
export async function openUi(ctx: Context) {
  try { ctx.body = await dshPluginUi.create(ctx.get('Authorization').replace(/^Bearer /, '')) } catch (error) { errorResponse(ctx, error) }
}
export async function closeUi(ctx: Context) {
  dshPluginUi.remove(ctx.params.id, ctx.get('Authorization').replace(/^Bearer /, ''))
  ctx.status = 204
}
