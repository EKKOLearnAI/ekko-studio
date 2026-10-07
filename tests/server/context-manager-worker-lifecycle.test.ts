import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ home: '', state: vi.fn(), restart: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { get appHome() { return mocks.home } } }))
import { configureContextManagerWorker } from '../../packages/server/src/modules/studio/public/context-manager-worker'
beforeEach(async () => {
  vi.clearAllMocks()
  mocks.home = await mkdtemp(join(tmpdir(), 'worker-lifecycle-'))
  configureContextManagerWorker({ getState: mocks.state, restart: mocks.restart })
  mocks.state.mockResolvedValue({ profile: 'research', status: 'running', pids: [100], activeSessions: 2, runningSessions: 1 })
})
afterEach(async () => { await rm(mocks.home, { recursive: true, force: true }) })

it.each([null, undefined, -1, NaN])('rejects unknown or invalid running counts (%s)', async runningSessions => {
  mocks.state.mockResolvedValue({ profile: 'research', status: 'unknown', pids: [], activeSessions: null, runningSessions })
  const { restartContextManagerWorker } = await import('../../packages/server/src/modules/studio/services/context-manager/lifecycle')
  await expect(restartContextManagerWorker('research', { profile: 'research', confirm: true })).rejects.toMatchObject({ code: 'context_manager_worker_unavailable' })
  expect(mocks.restart).not.toHaveBeenCalled()
})

it('rejects a worker observation belonging to a different profile', async () => {
  mocks.state.mockResolvedValue({ profile: 'default', status: 'running', pids: [100], activeSessions: 0, runningSessions: 0 })
  const { restartContextManagerWorker } = await import('../../packages/server/src/modules/studio/services/context-manager/lifecycle')
  await expect(restartContextManagerWorker('research', { profile: 'research', confirm: true })).rejects.toMatchObject({ code: 'context_manager_worker_unavailable' })
  expect(mocks.restart).not.toHaveBeenCalled()
})

it('refuses a working profile even when the caller confirms restart', async () => {
  const { restartContextManagerWorker } = await import('../../packages/server/src/modules/studio/services/context-manager/lifecycle')
  await expect(restartContextManagerWorker('research', { profile: 'research', confirm: true })).rejects.toMatchObject({ status: 409, code: 'context_manager_sessions_running' })
  expect(mocks.restart).not.toHaveBeenCalled()
})

it('rejects cross-profile confirmation before contacting the worker', async () => {
  const { restartContextManagerWorker } = await import('../../packages/server/src/modules/studio/services/context-manager/lifecycle')
  await expect(restartContextManagerWorker('research', { profile: 'default', confirm: true })).rejects.toMatchObject({ status: 409, code: 'context_manager_profile_changed' })
  expect(mocks.state).not.toHaveBeenCalled()
  expect(mocks.restart).not.toHaveBeenCalled()
})

it('requires explicit confirmation of idle loaded session impact', async () => {
  mocks.state.mockResolvedValue({ profile: 'research', status: 'running', pids: [100], activeSessions: 2, runningSessions: 0 })
  const { restartContextManagerWorker } = await import('../../packages/server/src/modules/studio/services/context-manager/lifecycle')
  await expect(restartContextManagerWorker('research', { profile: 'research', confirm: false })).rejects.toMatchObject({ status: 409, code: 'context_manager_confirmation_required' })
  expect(mocks.restart).not.toHaveBeenCalled()
})

it('restarts only the requested profile and returns independently observed replacement PIDs', async () => {
  const before = { profile: 'research', status: 'running', pids: [100], activeSessions: 2, runningSessions: 0 }
  const after = { ...before, pids: [200], activeSessions: 0 }
  mocks.state.mockResolvedValueOnce(before).mockResolvedValue(after)
  mocks.restart.mockResolvedValue(before)
  const { restartContextManagerWorker } = await import('../../packages/server/src/modules/studio/services/context-manager/lifecycle')
  expect(await restartContextManagerWorker('research', { profile: 'research', confirm: true })).toEqual({ profile: 'research', status: 'restarted', worker: after })
  expect(mocks.restart).toHaveBeenCalledWith('research')
  expect(mocks.state.mock.calls).toEqual([['research'], ['research']])
})