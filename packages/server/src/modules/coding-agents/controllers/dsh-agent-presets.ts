import type { Context } from 'koa'
import { dshAgentPresets } from '../services'
import { DshPluginError } from '../services/dsh/errors'

async function respond(ctx: Context, operation: () => Promise<unknown>) {
  try { ctx.body = await operation() }
  catch (error) {
    ctx.status = error instanceof DshPluginError ? error.status : 500
    ctx.body = { code: error instanceof DshPluginError ? error.code : 'DSH_PRESET_OPERATION_FAILED', error: error instanceof DshPluginError ? error.message : 'Unable to access DSH presets' }
  }
}
export const choices = (ctx: Context) => respond(ctx, () => dshAgentPresets.choices())
export const list = (ctx: Context) => respond(ctx, () => dshAgentPresets.list())
export const read = (ctx: Context) => respond(ctx, () => dshAgentPresets.read(ctx.params.presetId))
export const copy = (ctx: Context) => respond(ctx, () => dshAgentPresets.copy(ctx.request.body))
export const remove = (ctx: Context) => respond(ctx, () => dshAgentPresets.remove(ctx.params.presetId))
export const makeDefault = (ctx: Context) => respond(ctx, () => dshAgentPresets.makeDefault(ctx.params.presetId))
export const openLocation = (ctx: Context) => respond(ctx, () => dshAgentPresets.openLocation(ctx.params.presetId))
