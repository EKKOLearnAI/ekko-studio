import { describe, expect, it, vi } from 'vitest'
import { authProtectedRoutes } from '../../packages/server/src/modules/studio/routes/auth'
import { requireSuperAdmin } from '../../packages/server/src/modules/studio/middleware/auth'

describe('locked-ips routes require super admin', () => {
  function stackFor(method: string, path: string): Function[] {
    const layer = authProtectedRoutes.stack.find(
      (l: any) => l.path === path && l.methods.includes(method),
    )
    if (!layer) throw new Error(`route ${method} ${path} not registered`)
    return layer.stack
  }

  it('GET /api/auth/users requires requireSuperAdmin (control, must already pass)', () => {
    const stack = stackFor('GET', '/api/auth/users')
    expect(stack).toContain(requireSuperAdmin)
  })

  it('GET /api/auth/locked-ips must require requireSuperAdmin', () => {
    const stack = stackFor('GET', '/api/auth/locked-ips')
    expect(stack).toContain(requireSuperAdmin)
  })

  it('DELETE /api/auth/locked-ips must require requireSuperAdmin', () => {
    const stack = stackFor('DELETE', '/api/auth/locked-ips')
    expect(stack).toContain(requireSuperAdmin)
  })

  it.each(['user', 'admin', undefined])('rejects role %s before invoking the lock controller', async role => {
    for (const method of ['GET', 'DELETE']) {
      const [authorize] = stackFor(method, '/api/auth/locked-ips')
      const next = vi.fn()
      const ctx: any = { state: { user: role ? { role } : undefined }, status: 200 }
      await authorize(ctx, next)
      expect(ctx.status).toBe(403)
      expect(next).not.toHaveBeenCalled()
    }
  })

  it('allows a super admin to reach the lock controller', async () => {
    for (const method of ['GET', 'DELETE']) {
      const next = vi.fn()
      await stackFor(method, '/api/auth/locked-ips')[0]({ state: { user: { role: 'super_admin' } } }, next)
      expect(next).toHaveBeenCalledOnce()
    }
  })
})
