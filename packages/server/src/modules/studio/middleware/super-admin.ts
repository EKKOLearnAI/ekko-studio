import type { Context, Next } from 'koa'

export type SuperAdminMiddleware = (ctx: Context, next: Next) => Promise<void>

let configuredMiddleware: SuperAdminMiddleware | null = null

export function configureSuperAdminMiddleware(middleware: SuperAdminMiddleware): void {
  configuredMiddleware = middleware
}

export async function requireSuperAdmin(ctx: Context, next: Next): Promise<void> {
  if (!configuredMiddleware) throw new Error('Studio super-admin middleware has not been configured')
  await configuredMiddleware(ctx, next)
}
