import type { Context } from 'koa'
import {
  ContextManagerError,
  getContextManagerSettings,
  saveContextManagerSettings,
} from '../services/context-manager/settings'
import { getContextManagerHealth } from '../services/context-manager/health'
import { restartContextManagerWorker, runContextManagerLifecycle } from '../services/context-manager/lifecycle'

async function respond(ctx: Context, action: (profile: string) => Promise<unknown>): Promise<void> {
  const profile = ctx.state.profile?.name
  if (!profile) {
    ctx.status = 400
    ctx.body = { error: 'Profile is required', code: 'context_manager_invalid_request' }
    return
  }
  try {
    ctx.body = await action(profile)
  } catch (error) {
    ctx.status = error instanceof ContextManagerError ? error.status : 500
    ctx.body = {
      error: error instanceof ContextManagerError ? error.message : 'Context manager operation failed',
      code: error instanceof ContextManagerError ? error.code : 'context_manager_failed',
    }
  }
}

export async function getSettings(ctx: Context): Promise<void> {
  await respond(ctx, getContextManagerSettings)
}

export async function updateSettings(ctx: Context): Promise<void> {
  await respond(ctx, profile => saveContextManagerSettings(profile, ctx.request.body))
}

export async function health(ctx: Context): Promise<void> {
  await respond(ctx, getContextManagerHealth)
}

export async function restartWorker(ctx: Context): Promise<void> {
  await respond(ctx, profile => restartContextManagerWorker(profile, ctx.request.body))
}

export async function lifecycle(ctx: Context): Promise<void> {
  await respond(ctx, profile => {
    const manager = ctx.request.body?.manager
    return runContextManagerLifecycle(profile, manager, ctx.params.action)
  })
}
