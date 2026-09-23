import type { Context } from 'koa'
import { evaluateJev, parseJevRequest, testJev } from '../services/jev/client'
import { deleteJevSettings, getJevSettings, JevError, saveJevSettings } from '../services/jev/settings'

async function respond(ctx: Context, action: (profile: string) => Promise<unknown>) {
  const profile = ctx.state.profile?.name
  if (!profile) { ctx.status = 400; ctx.body = { error: 'Profile is required' }; return }
  try {
    ctx.body = await action(profile)
  } catch (error) {
    ctx.status = error instanceof JevError ? error.status : 500
    ctx.body = { error: error instanceof JevError ? error.message : 'JEV settings operation failed' }
  }
}

export async function getSettings(ctx: Context) { await respond(ctx, getJevSettings) }
export async function saveSettings(ctx: Context) { await respond(ctx, profile => saveJevSettings(profile, ctx.request.body)) }
export async function deleteSettings(ctx: Context) { await respond(ctx, deleteJevSettings) }
export async function testConnection(ctx: Context) { await respond(ctx, testJev) }
export async function evaluate(ctx: Context) { await respond(ctx, profile => evaluateJev(profile, parseJevRequest(ctx.request.body))) }
