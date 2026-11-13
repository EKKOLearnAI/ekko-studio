import type { Context } from 'koa'
import { MEMORY_NODE_STATUSES, type MemoryNodeStatus } from '../../../../../ekko-agent/src'
import {
  deleteEkkoMemory,
  listEkkoMemory,
  updateEkkoMemory,
} from '../services/memory'

function requestedProfile(ctx: Context): string {
  return String(ctx.state?.profile?.name || 'default').trim() || 'default'
}

function errorResponse(ctx: Context, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  ctx.status = message === 'Memory not found.' ? 404 : 400
  ctx.body = { ok: false, error: message }
}

export async function list(ctx: Context): Promise<void> {
  const statusValue = String(ctx.query.status || '').trim()
  if (statusValue && !MEMORY_NODE_STATUSES.includes(statusValue as MemoryNodeStatus)) {
    ctx.status = 400
    ctx.body = { ok: false, error: 'Invalid memory status.' }
    return
  }
  try {
    const memories = await listEkkoMemory({
      profile: requestedProfile(ctx),
      query: String(ctx.query.query || ''),
      status: statusValue ? statusValue as MemoryNodeStatus : undefined,
      limit: Number(ctx.query.limit) || undefined,
      offset: Number(ctx.query.offset) || undefined,
    })
    ctx.body = { ok: true, memories }
  } catch (error) {
    errorResponse(ctx, error)
  }
}

export async function update(ctx: Context): Promise<void> {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  const expectedRevision = Number(body.expectedRevision)
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    ctx.status = 400
    ctx.body = { ok: false, error: 'expectedRevision must be a positive integer.' }
    return
  }
  const hasEditableField = typeof body.title === 'string' ||
    typeof body.content === 'string' ||
    Array.isArray(body.tags)
  const validTags = body.tags === undefined ||
    (Array.isArray(body.tags) && body.tags.every(tag => typeof tag === 'string'))
  if (!hasEditableField || !validTags) {
    ctx.status = 400
    ctx.body = { ok: false, error: 'At least one valid title, content, or tags field is required.' }
    return
  }
  try {
    const memory = await updateEkkoMemory(requestedProfile(ctx), ctx.params.id, {
      expectedRevision,
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(typeof body.content === 'string' ? { content: body.content } : {}),
      ...(Array.isArray(body.tags) ? { tags: body.tags as string[] } : {}),
    })
    ctx.body = { ok: true, memory }
  } catch (error) {
    errorResponse(ctx, error)
  }
}

export async function remove(ctx: Context): Promise<void> {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  const expectedRevision = Number(body.expectedRevision)
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    ctx.status = 400
    ctx.body = { ok: false, error: 'expectedRevision must be a positive integer.' }
    return
  }
  try {
    const memory = await deleteEkkoMemory(
      requestedProfile(ctx),
      ctx.params.id,
      expectedRevision,
    )
    ctx.body = { ok: true, memory }
  } catch (error) {
    errorResponse(ctx, error)
  }
}
