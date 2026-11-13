import type { Context } from 'koa'
import { getActiveProfileName } from '../services/profiles/profile'
import {
  approvePendingWrite,
  getPendingWriteReview,
  listPendingWrites,
  rejectPendingWrite,
} from '../services/write-gate/write-gate'

function requestedProfile(ctx: Context): string {
  return ctx.state?.profile?.name || getActiveProfileName() || 'default'
}

function pendingParams(ctx: Context): { subsystem: string; id: string } {
  return {
    subsystem: String(ctx.params.subsystem || ''),
    id: String(ctx.params.id || ''),
  }
}

function handleError(ctx: Context, err: any) {
  const message = err?.stderr || err?.message || String(err)
  if (/Invalid write gate subsystem|Invalid pending write id/i.test(message)) {
    ctx.status = 400
  } else if (/No pending .* write with id/i.test(message)) {
    ctx.status = 404
  } else if (/write approval is not supported/i.test(message)) {
    ctx.status = 409
  } else {
    ctx.status = 500
  }
  ctx.body = { error: message.trim() }
}

export async function list(ctx: Context) {
  try {
    ctx.body = await listPendingWrites(requestedProfile(ctx))
  } catch (err: any) {
    handleError(ctx, err)
  }
}

export async function diff(ctx: Context) {
  try {
    const { subsystem, id } = pendingParams(ctx)
    const review = await getPendingWriteReview(requestedProfile(ctx), subsystem, id)
    ctx.body = {
      diff: review.diff,
      review,
    }
  } catch (err: any) {
    handleError(ctx, err)
  }
}

export async function approve(ctx: Context) {
  try {
    const { subsystem, id } = pendingParams(ctx)
    ctx.body = await approvePendingWrite(requestedProfile(ctx), subsystem, id)
  } catch (err: any) {
    handleError(ctx, err)
  }
}

export async function reject(ctx: Context) {
  try {
    const { subsystem, id } = pendingParams(ctx)
    ctx.body = await rejectPendingWrite(requestedProfile(ctx), subsystem, id)
  } catch (err: any) {
    handleError(ctx, err)
  }
}
