import type { Context } from 'koa'
import { McuBindingError, mcuDeviceCode, mcuExpectedRevision, type McuBindingKind, type McuBindingOwner } from '../contracts/mcu-session-bindings'
import { readMcuBinding, writeMcuBinding } from '../services/devices/mcu-session-bindings'

function owner(ctx: Context, deviceCode: unknown): McuBindingOwner {
  const userId = ctx.state.user?.id
  if (!Number.isSafeInteger(userId) || Number(userId) <= 0 || ctx.state.sessionShare) throw new McuBindingError('Unauthorized', 403, 'mcu_owner_unavailable')
  // A BOT reference can select its model Profile in generic middleware. Device
  // ownership stays in the authenticated plugin request's explicit Profile.
  return { userId: Number(userId), profile: ctx.get('x-hermes-profile') || ctx.state.profile?.name || 'default', deviceCode: mcuDeviceCode(deviceCode) }
}
function body(ctx: Context, allowed: string[]): Record<string, unknown> {
  const input = ctx.request.body
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) {
    throw new McuBindingError('Invalid binding fields', 400, 'mcu_binding_input_invalid')
  }
  return input as Record<string, unknown>
}
async function respond(ctx: Context, action: () => Promise<unknown>) {
  try { ctx.body = await action() }
  catch (error) {
    if (!(error instanceof McuBindingError)) throw error
    ctx.status = error.status; ctx.body = { error: error.message, code: error.code }
  }
}
export async function getMcuSessionBinding(ctx: Context) {
  await respond(ctx, () => readMcuBinding(owner(ctx, ctx.query.device_code)))
}
export async function putMcuSessionBinding(ctx: Context) {
  await respond(ctx, async () => {
    const input = body(ctx, ['device_code', 'session_id', 'kind', 'expected_revision'])
    if (typeof input.session_id !== 'string' || !input.session_id.trim() || input.session_id.length > 256
      || input.kind !== 'chat' && input.kind !== 'bot') throw new McuBindingError('Select a valid conversation and kind', 400, 'mcu_binding_input_invalid')
    return writeMcuBinding(owner(ctx, input.device_code), mcuExpectedRevision(input.expected_revision),
      { sessionId: input.session_id.trim(), kind: input.kind as McuBindingKind })
  })
}
export async function deleteMcuSessionBinding(ctx: Context) {
  await respond(ctx, async () => {
    const input = body(ctx, ['device_code', 'expected_revision'])
    return writeMcuBinding(owner(ctx, input.device_code), mcuExpectedRevision(input.expected_revision), null)
  })
}
