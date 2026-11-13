import type { Context } from 'koa'
import { bridgeMcpAction } from '../services/mcp/bridge-actions'

function getProfile(ctx: Context): string | undefined {
  return (ctx.state as any)?.profile?.name || undefined
}

/** Validate server name: non-empty, no control chars, no path separators */
function isValidServerName(name: string): boolean {
  if (!name || name.trim().length === 0) return false
  if (name.length > 128) return false
  // Reject path separators and control characters
  if (/[/\\\x00-\x1f]/.test(name)) return false
  return true
}

export async function listServers(ctx: Context) {
  try {
    ctx.body = await bridgeMcpAction('mcp_list', {}, getProfile(ctx))
  } catch (err: any) {
    ctx.status = 503
    ctx.body = { error: err.message || 'MCP bridge not available' }
  }
}

export async function addServer(ctx: Context) {
  try {
    const { name, config } = (ctx.request.body || {}) as Record<string, unknown>
    if (typeof name !== 'string' || !isValidServerName(name)) {
      ctx.status = 400
      ctx.body = { error: 'Valid server name is required' }
      return
    }
    if (!config || typeof config !== 'object') {
      ctx.status = 400
      ctx.body = { error: 'config object is required' }
      return
    }
    ctx.body = await bridgeMcpAction('mcp_server_add', { name: name.trim(), config }, getProfile(ctx))
  } catch (err: any) {
    ctx.status = 503
    ctx.body = { error: err.message || 'Failed to add MCP server' }
  }
}

export async function updateServer(ctx: Context) {
  try {
    const name = ctx.params.name as string
    const { config } = (ctx.request.body || {}) as Record<string, unknown>
    if (!name || !isValidServerName(name)) {
      ctx.status = 400
      ctx.body = { error: 'Valid server name is required' }
      return
    }
    if (!config || typeof config !== 'object') {
      ctx.status = 400
      ctx.body = { error: 'config object is required' }
      return
    }
    ctx.body = await bridgeMcpAction('mcp_server_update', { name, config }, getProfile(ctx))
  } catch (err: any) {
    ctx.status = 503
    ctx.body = { error: err.message || 'Failed to update MCP server' }
  }
}

export async function removeServer(ctx: Context) {
  try {
    const name = ctx.params.name as string
    if (!name || !isValidServerName(name)) {
      ctx.status = 400
      ctx.body = { error: 'Valid server name is required' }
      return
    }
    ctx.body = await bridgeMcpAction('mcp_server_remove', { name }, getProfile(ctx))
  } catch (err: any) {
    ctx.status = 503
    ctx.body = { error: err.message || 'Failed to remove MCP server' }
  }
}

export async function testServer(ctx: Context) {
  try {
    const name = ctx.params.name as string
    if (!name || !isValidServerName(name)) {
      ctx.status = 400
      ctx.body = { error: 'Valid server name is required' }
      return
    }
    ctx.body = await bridgeMcpAction('mcp_server_test', { name }, getProfile(ctx))
  } catch (err: any) {
    ctx.status = 503
    ctx.body = { error: err.message || 'Failed to test MCP server' }
  }
}

export async function listTools(ctx: Context) {
  try {
    const server = ctx.query.server as string | undefined
    const raw = ctx.query.raw === '1' || ctx.query.raw === 'true'
    const payload: Record<string, any> = {}
    if (server) payload.server = server
    if (raw) payload.raw = true
    ctx.body = await bridgeMcpAction('mcp_tools_list', payload, getProfile(ctx))
  } catch (err: any) {
    ctx.status = 503
    ctx.body = { error: err.message || 'MCP bridge not available' }
  }
}

export async function reloadMcp(ctx: Context) {
  try {
    const server = ctx.query.server as string | undefined
    const payload = server ? { server } : {}
    ctx.body = await bridgeMcpAction('mcp_reload', payload, getProfile(ctx))
  } catch (err: any) {
    ctx.status = 503
    ctx.body = { error: err.message || 'Failed to reload MCP' }
  }
}
