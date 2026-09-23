import { createIncomingWebhook, enableIncomingWebhooks, listIncomingWebhooks, removeIncomingWebhook, setIncomingWebhookEnabled } from '../services/incoming-webhooks'
import { getActiveProfileName } from '../services/profiles/profile'

function profile(ctx: any): string {
  return ctx.state?.profile?.name || getActiveProfileName() || 'default'
}

function fail(ctx: any, error: unknown): void {
  ctx.status = 400
  ctx.body = { error: error instanceof Error ? error.message : String(error) }
}

export async function list(ctx: any) {
  try { ctx.body = await listIncomingWebhooks(profile(ctx)) } catch (error) { fail(ctx, error) }
}

export async function enable(ctx: any) {
  try { ctx.body = { success: true, runtime: await enableIncomingWebhooks(profile(ctx)) } } catch (error) { fail(ctx, error) }
}

export async function create(ctx: any) {
  try { ctx.body = { subscription: await createIncomingWebhook(profile(ctx), ctx.request.body || {}) } } catch (error) { fail(ctx, error) }
}

export async function toggle(ctx: any) {
  try {
    await setIncomingWebhookEnabled(profile(ctx), decodeURIComponent(ctx.params.name), ctx.request.body?.enabled === true)
    ctx.body = { success: true }
  } catch (error) { fail(ctx, error) }
}

export async function remove(ctx: any) {
  try {
    await removeIncomingWebhook(profile(ctx), decodeURIComponent(ctx.params.name))
    ctx.body = { success: true }
  } catch (error) { fail(ctx, error) }
}
