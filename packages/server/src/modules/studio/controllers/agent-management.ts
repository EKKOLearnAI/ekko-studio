import type { Context } from 'koa'
import { StudioError } from '../contracts/plugins'
import { body, executionScope, respond } from './studio-plugins'
import { getStudioPluginRuntime } from '../services/plugins/runtime'

function operations() {
  const service = getStudioPluginRuntime().coordinator.managementOperations
  if (!service) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Interactive management is unavailable')
  return service
}
export const startAgentLogin = (ctx: Context) => respond(ctx, () => {
  const input = body(ctx, ['revision', 'idempotencyKey', 'profile'])
  return getStudioPluginRuntime().coordinator.startLogin(executionScope(ctx), ctx.params.id, input.revision as number, input.idempotencyKey as string)
})
export const startAgentInstall = (ctx: Context) => respond(ctx, () => {
  const input = body(ctx, ['revision', 'idempotencyKey', 'profile'])
  return getStudioPluginRuntime().coordinator.startInstall(executionScope(ctx), ctx.params.id, input.revision as number, input.idempotencyKey as string)
})
export const listAgentManagementOperations = (ctx: Context) => respond(ctx, () => operations().list(executionScope(ctx), ctx.params.id))
export const getAgentManagementOperation = (ctx: Context) => respond(ctx, () => operations().get(executionScope(ctx), ctx.params.id))
export const getAgentManagementOutput = (ctx: Context) => respond(ctx, () => {
  const after = ctx.query.after ?? '0'
  if (typeof after !== 'string' || !/^\d{1,16}$/.test(after)) throw new StudioError('INVALID_ARGUMENT', 'Invalid terminal cursor')
  return operations().output(executionScope(ctx), ctx.params.id, Number(after))
})
export const sendAgentManagementInput = (ctx: Context) => respond(ctx, async () => {
  const value = body(ctx, ['sequence', 'text', 'profile'])
  await operations().input(executionScope(ctx), ctx.params.id, value.sequence as number, value.text as string)
  return { accepted: true }
})
export const resizeAgentManagementTerminal = (ctx: Context) => respond(ctx, async () => {
  const { profile: _profile, ...value } = body(ctx, ['cols', 'rows', 'profile'])
  await operations().resize(executionScope(ctx), ctx.params.id, value)
  return { accepted: true }
})
export const cancelAgentManagementOperation = (ctx: Context) => respond(ctx, () => {
  body(ctx, ['profile'])
  return operations().cancel(executionScope(ctx), ctx.params.id)
})
