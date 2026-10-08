import type { Context } from 'koa'
import { getUserWorkspaceDirectories, saveUserWorkspaceDirectory } from '../services/workspace/directories'

function account(ctx: Context): number | null {
  const id = ctx.state.user?.id
  if (typeof id === 'number' && Number.isInteger(id) && id > 0) return id
  ctx.status = 401
  ctx.body = { error: 'Unauthorized' }
  return null
}

export async function list(ctx: Context) {
  const id = account(ctx)
  if (id) ctx.body = getUserWorkspaceDirectories(id)
}

function save(ctx: Context, favoriteRequired: boolean) {
  const id = account(ctx)
  if (!id) return
  const { path, favorite } = (ctx.request.body || {}) as { path?: unknown; favorite?: unknown }
  if (typeof path !== 'string' || !path.trim() || path.length > 4096 || path.includes('\0')
    || (favoriteRequired && typeof favorite !== 'boolean')) {
    ctx.status = 400
    ctx.body = { error: 'A directory path and, for favorites, a boolean favorite are required' }
    return
  }
  ctx.body = saveUserWorkspaceDirectory(id, path, favoriteRequired ? favorite as boolean : undefined)
}

export async function record(ctx: Context) { save(ctx, false) }
export async function setFavorite(ctx: Context) { save(ctx, true) }
