import { synchronizeHermesProvider } from '../public/provider-projection'
import { providerProfiles } from '../public/provider-account'
import type { Context, Next } from 'koa'
import { importAccountProviders, withProviderAccount } from '../public/provider-account'

export async function providerAccountMiddleware(ctx: Context, next: Next): Promise<void> {
  if (!ctx.state.user) return next()
  return withProviderAccount(ctx.state.user.id, async () => {
    await importAccountProviders()
    // All sources are imported before any Profile is rewritten.
    for (const profile of providerProfiles()) await synchronizeHermesProvider(profile)
    await next()
    if (ctx.status < 400 && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(ctx.method)
      && /\/(?:config(?:\/|$)|custom-model|.*-auth|copilot|model-)/.test(ctx.path)) {
      for (const profile of providerProfiles()) await synchronizeHermesProvider(profile)
    }
  }, ctx.state.profile?.name)
}
