import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ restart: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/context-manager/lifecycle', () => ({ restartContextManagerWorker: mocks.restart, runContextManagerLifecycle: vi.fn() }))
import * as controller from '../../packages/server/src/modules/studio/controllers/context-manager'
beforeEach(() => vi.clearAllMocks())
it('passes only the request-scoped profile and confirmation to worker restart', async () => {
  mocks.restart.mockResolvedValue({ profile: 'research', status: 'restarted' })
  const ctx = { state: { profile: { name: 'research' } }, request: { body: { profile: 'research', confirm: true } } } as any
  await controller.restartWorker(ctx)
  expect(mocks.restart).toHaveBeenCalledWith('research', { profile: 'research', confirm: true })
  expect(ctx.body).toMatchObject({ profile: 'research', status: 'restarted' })
})