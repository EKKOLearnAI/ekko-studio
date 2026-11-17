import type { Context, Next } from 'koa'
import { gatewayProtocol, gatewayToken, modelGatewayAdapters } from '../public/model-gateway-adapters'
import { withProviderAccount } from '../public/provider-account'
import { findUserById, userCanAccessProfile } from '../public/users'
import { toAuthenticatedUser } from './auth'
import { restoreStudioModelTarget } from '../public/model-target-store'

/** Run-scoped model credentials authenticate only inference, never management. */
export async function modelGatewayMiddleware(ctx: Context, next: Next): Promise<void> {
  // Read-only compatibility for previously generated CLI configuration files.
  const path = ctx.path.replace(/^\/api\/(?:codex-proxy|claude-code-proxy)\/[^/]+(?=\/)/, '/api/ekko-studio/models')
  const protocol = ctx.method === 'POST' ? gatewayProtocol(path) : undefined
  const listing = ctx.method === 'GET' && path === '/api/ekko-studio/models/v1/models'
  if (!protocol && !listing) return next()
  const binding = await restoreStudioModelTarget(gatewayToken(ctx))
  if (!binding) return next()
  const user = findUserById(binding.userId)
  if (user?.status !== 'active' || (user.role !== 'super_admin' && !userCanAccessProfile(user.id, binding.profile))) { ctx.status = 403; ctx.body = { error: 'Model credential owner is unavailable' }; return }
  ctx.state.user = toAuthenticatedUser(user)
  ctx.state.profile = { name: binding.profile }
  if (listing) {
    ctx.body = { object: 'list', data: [{ id: binding.model, object: 'model', owned_by: 'ekkostudio', type: 'model', display_name: binding.model, created_at: '1970-01-01T00:00:00Z' }], has_more: false, first_id: binding.model, last_id: binding.model }
    return
  }
  await withProviderAccount(binding.userId, () => modelGatewayAdapters().handle(protocol!, ctx), binding.profile)
}
