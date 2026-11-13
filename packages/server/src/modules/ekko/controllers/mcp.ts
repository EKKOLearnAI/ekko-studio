import type { Context } from 'koa'
import {
  createEkkoMcpServer,
  deleteEkkoMcpServer,
  listEkkoMcpServers,
  setEkkoMcpServerEnabled,
  testEkkoMcpServer,
  updateEkkoMcpServer,
} from '../services/mcp'

function requestedProfile(ctx: Context): string {
  return String(ctx.state?.profile?.name || 'default').trim() || 'default'
}

function errorResponse(ctx: Context, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  ctx.status = /not found/i.test(message) ? 404 : 400
  ctx.body = { ok: false, error: message }
}

export async function list(ctx: Context): Promise<void> {
  try {
    ctx.body = { ok: true, servers: listEkkoMcpServers(requestedProfile(ctx)) }
  } catch (error) {
    errorResponse(ctx, error)
  }
}

export async function create(ctx: Context): Promise<void> {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  if (typeof body.name !== 'string' || !body.config) {
    ctx.status = 400
    ctx.body = { ok: false, error: 'name and config are required.' }
    return
  }
  try {
    const server = await createEkkoMcpServer(
      requestedProfile(ctx),
      body.name,
      body.config,
    )
    ctx.status = 201
    ctx.body = { ok: true, server }
  } catch (error) {
    errorResponse(ctx, error)
  }
}

export async function update(ctx: Context): Promise<void> {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  if (!body.config && typeof body.enabled !== 'boolean') {
    ctx.status = 400
    ctx.body = { ok: false, error: 'config or enabled is required.' }
    return
  }
  try {
    const server = typeof body.enabled === 'boolean'
      ? await setEkkoMcpServerEnabled(requestedProfile(ctx), ctx.params.name, body.enabled)
      : await updateEkkoMcpServer(requestedProfile(ctx), ctx.params.name, body.config)
    ctx.body = { ok: true, server }
  } catch (error) {
    errorResponse(ctx, error)
  }
}

export async function remove(ctx: Context): Promise<void> {
  try {
    await deleteEkkoMcpServer(requestedProfile(ctx), ctx.params.name)
    ctx.body = { ok: true }
  } catch (error) {
    errorResponse(ctx, error)
  }
}

export async function test(ctx: Context): Promise<void> {
  try {
    const tools = await testEkkoMcpServer(requestedProfile(ctx), ctx.params.name)
    ctx.body = { ok: true, tools }
  } catch (error) {
    errorResponse(ctx, error)
  }
}
