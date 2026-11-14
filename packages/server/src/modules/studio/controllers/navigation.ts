import type { Context } from 'koa'
import { getUserNavigation, updateUserNavigation, NavigationValidationError } from '../services/navigation'

export function getNavigation(ctx: Context) {
  if (!ctx.state.user || ctx.state.sessionShare) { ctx.status = 401; ctx.body = { error: 'Studio login required' }; return }
  ctx.body = getUserNavigation(ctx.state.user.id)
}

export function updateNavigation(ctx: Context) {
  if (!ctx.state.user || ctx.state.sessionShare) { ctx.status = 401; ctx.body = { error: 'Studio login required' }; return }
  try { ctx.body = updateUserNavigation(ctx.state.user.id, ctx.request.body) }
  catch (error) {
    if (!(error instanceof NavigationValidationError)) throw error
    ctx.status = 400
    ctx.body = { error: error.message }
  }
}
