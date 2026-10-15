import { describe, expect, it } from 'vitest'
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
})
