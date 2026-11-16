import { serveModelGateway } from '../services/model-api/gateway'
import type { ModelGatewayProtocol } from '../public/model-gateway-adapters'
import { manageModelApiCloudLink } from '../services/model-api/cloud-link'
import type { Context } from 'koa'
import { listProfileNamesFromDisk } from '../public/provider-config'
import { listApiModels } from '../services/model-api/service'
import { ModelApiError, modelApiErrorBody } from '../services/model-api/errors'
import { listModelApiKeys, revokeModelApiKey } from '../services/model-api/keys'
import { createAccountModelApiKey, editAccountModelApiKey } from '../services/model-api/key-management'

function profilesForRequest(ctx: Context): string[] {
  const user = ctx.state.user
  if (!user) throw new ModelApiError('Authentication is required.', 401)
  if (ctx.state.modelGateway) return [ctx.state.modelGateway.profile]
  // The API is account-wide. UI-selected or caller-supplied Profile headers
  // must not alter its directory or credential routing.
  return [...new Set(listProfileNamesFromDisk())]
    .filter(profile => user.role === 'super_admin' || user.profiles?.includes(profile))
    .sort((a, b) => a === 'default' ? -1 : b === 'default' ? 1 : a < b ? -1 : a > b ? 1 : 0)
}

export async function modelApiModels(ctx: Context) {
  ctx.set('Cache-Control', 'no-store')
  try { ctx.body = await listApiModels(profilesForRequest(ctx), ctx.state.modelApiKey?.models) }
  catch (error) { const result = modelApiErrorBody(error); ctx.status = result.status; ctx.body = result.body }
}

async function manageKeys(ctx: Context, operation: (userId: number) => unknown) {
  ctx.set('Cache-Control', 'no-store')
  try {
    if (!ctx.state.user) throw new ModelApiError('Studio login is required.', 401)
    ctx.body = await operation(ctx.state.user.id)
  } catch (error) { const result = modelApiErrorBody(error); ctx.status = result.status; ctx.body = result.body }
}
export async function modelApiKeys(ctx: Context) {
  await manageKeys(ctx, userId => ({ keys: listModelApiKeys(userId) }))
}
export async function modelApiCreateKey(ctx: Context) {
  await manageKeys(ctx, async userId => {
    const result = await createAccountModelApiKey(userId, ctx.request.body, profilesForRequest(ctx))
    ctx.status = 201
    return result
  })
}
export async function modelApiEditKey(ctx: Context) {
  await manageKeys(ctx, userId => editAccountModelApiKey(userId, ctx.params.id, ctx.request.body, profilesForRequest(ctx)))
}
export async function modelApiRevokeKey(ctx: Context) {
  await manageKeys(ctx, userId => {
    if (!revokeModelApiKey(userId, ctx.params.id)) throw new ModelApiError('API key not found.', 404)
    return { success: true }
  })
}

async function inference(ctx: Context, protocol: ModelGatewayProtocol) {
  try { await serveModelGateway(ctx, protocol, profilesForRequest(ctx)) }
  catch (error) {
    const result = modelApiErrorBody(error)
    ctx.status = result.status
    const message = result.body.error.message
    ctx.body = protocol === 'anthropic_messages' ? { type: 'error', error: { type: result.status === 429 ? 'rate_limit_error' : result.status < 500 ? 'invalid_request_error' : 'api_error', message } }
      : protocol === 'gemini_contents' ? { error: { code: result.status, status: result.status === 404 ? 'NOT_FOUND' : result.status < 500 ? 'INVALID_ARGUMENT' : 'UNAVAILABLE', message } } : result.body
  }
}
export const modelApiResponses = (ctx: Context) => inference(ctx, 'codex_responses')
export const modelApiChatCompletions = (ctx: Context) => inference(ctx, 'chat_completions')
export const modelApiMessages = (ctx: Context) => inference(ctx, 'anthropic_messages')
export const modelApiGemini = (ctx: Context) => inference(ctx, 'gemini_contents')

export async function modelApiCloudLink(ctx: Context) {
  await manageKeys(ctx, userId => manageModelApiCloudLink(userId,
    ctx.method === 'DELETE' ? 'revoke' : ctx.method === 'POST' ? ctx.request.body?.rotate === true ? 'rotate' : 'create' : 'get'))
}
