import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  consumer: undefined as undefined | ((event: any) => Promise<void>),
  manager: { restore: vi.fn(), dispatch: vi.fn(), close: vi.fn() },
  users: [
    { id: 1, username: 'installer', role: 'super_admin', status: 'active', profiles: ['default'] },
    { id: 2, username: 'worker', role: 'admin', status: 'active', profiles: ['work'] },
    { id: 3, username: 'disabled', role: 'admin', status: 'disabled', profiles: ['work'] },
    { id: 4, username: 'unassigned', role: 'admin', status: 'active', profiles: ['personal'] },
  ],
}))
vi.mock('../../packages/server/src/modules/studio/services/plugins/manager', () => ({ PluginManager: vi.fn(function () { return mocks.manager }) }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { appHome: '/unused-plugin-host-fixture' } }))
vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({ issueModelRunJwt: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { info: vi.fn() } }))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
  listUsers: () => mocks.users, findUserById: (id: number) => mocks.users.find(user => user.id === id),
  userCanAccessProfile: (id: number, profile: string) => mocks.users.find(user => user.id === id)?.profiles.includes(profile),
  getDefaultProfileForUser: () => 'default',
}))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({ getSession: () => undefined }))
vi.mock('../../packages/server/src/modules/studio/services/webhooks/business-events', () => ({ businessEvents: { subscribe: (_name: string, consumer: typeof mocks.consumer) => { mocks.consumer = consumer; return () => { mocks.consumer = undefined } } } }))
vi.mock('../../packages/server/src/modules/studio/services/webhooks/app-events', () => ({
  canReceiveAppEvent: (user: any, event: any) => event.payload.recipients.includes(user.id),
  appEventEnvelope: (event: any) => ({ type: event.type, safe: true }),
}))
import { startPluginHost, stopPluginHost } from '../../packages/server/src/modules/studio/services/plugins/host'

afterEach(async () => { await stopPluginHost(); vi.clearAllMocks() })
it('delivers global plugin events under each eligible recipient, independently of the installation account and Profile', async () => {
  await startPluginHost('http://127.0.0.1:1')
  expect(mocks.manager.restore).toHaveBeenCalledTimes(1)
  await mocks.consumer!({ id: 'event', type: 'workflow.run.completed', occurred_at: '2026-11-11T01:00:00Z', profile: 'work', source: 'workflow', subject: { run_id: 'run' }, payload: { recipients: [2, 3, 4], secret: 'not an envelope field' } })
  expect(mocks.manager.dispatch).toHaveBeenCalledTimes(1)
  expect(mocks.manager.dispatch).toHaveBeenCalledWith(expect.objectContaining({
    identity: { userId: 2, profile: 'work', runId: 'run', sessionId: undefined, surface: 'workflow' },
    data: { type: 'workflow.run.completed', safe: true },
  }))
})
