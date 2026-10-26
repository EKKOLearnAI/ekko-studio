import { claimCloudUsageReceipt } from '../services/model-api/cloud-usage'
import { manageModelApiCloudLink } from '../services/model-api/cloud-link'
import { Readable } from 'node:stream'
import type { Context } from 'koa'
import { listProfileNamesFromDisk } from '../public/profile-config'
import { listApiModels, prepareModelResponse } from '../services/model-api/service'
import { ModelApiError, modelApiErrorBody } from '../services/model-api/errors'
import { listModelApiKeys, revokeModelApiKey } from '../services/model-api/keys'
import { createAccountModelApiKey, editAccountModelApiKey } from '../services/model-api/key-management'

function profilesForRequest(ctx: Context): string[] {
  const user = ctx.state.user
  if (!user) throw new ModelApiError('Authentication is required.', 401)
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

export async function modelApiResponses(ctx: Context) {
  const abort = new AbortController()
  const onClose = () => { if (!ctx.res.writableEnded) abort.abort() }
  ctx.res.once('close', onClose)
  let streaming = false
  try {
    const request = await prepareModelResponse({
      onUsage: claimCloudUsageReceipt(ctx.get('x-studio-cloud-usage'), ctx.state.user?.id, ctx.state.modelApiKey?.id),
      profiles: profilesForRequest(ctx), accountId: ctx.state.user ? String(ctx.state.user.id) : undefined,
      allowedModels: ctx.state.modelApiKey?.models,
      apiKeyId: ctx.state.modelApiKey?.id,
      body: ctx.request.body, signal: abort.signal,
    })
    ctx.set('x-request-id', request.id)
    if (!request.stream) { ctx.body = await request.create(); return }
    ctx.set('Content-Type', 'text/event-stream; charset=utf-8')
    ctx.set('Cache-Control', 'no-cache')
    ctx.set('X-Accel-Buffering', 'no')
    streaming = true
    ctx.body = Readable.from((async function* () {
      try {
        for await (const event of request.events()) yield `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
      } finally {
        abort.abort()
        ctx.res.off('close', onClose)
      }
    })())
  } catch (error) {
    const result = modelApiErrorBody(error)
    ctx.status = result.status; ctx.body = result.body
  } finally {
    if (!streaming) ctx.res.off('close', onClose)
  }
}

export async function modelApiCloudLink(ctx: Context) {
  await manageKeys(ctx, userId => manageModelApiCloudLink(userId,
    ctx.method === 'DELETE' ? 'revoke' : ctx.method === 'POST' ? ctx.request.body?.rotate === true ? 'rotate' : 'create' : 'get'))
}
