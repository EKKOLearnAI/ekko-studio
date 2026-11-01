import { beforeEach, expect, it, vi } from 'vitest'

const runAndWait = vi.hoisted(() => vi.fn(async () => ({ ok: true, output: 'Done' })))
const getRunInfo = vi.hoisted(() => vi.fn())
const stop = vi.hoisted(() => vi.fn())
vi.mock('../../packages/server/src/modules/studio/public/chat-run', () => ({ getChatRunServer: () => ({ runAndWait, waitForRunTermination: vi.fn(async () => {}) }) }))
vi.mock('../../packages/server/src/bootstrap/person-chat-agent', () => ({ createPersonAgent: vi.fn() }))
vi.mock('../../packages/ekko-agent/src', () => ({ AgentRuntime: vi.fn(), AgentToolRegistry: vi.fn(), createModelClient: vi.fn(), resolveModelProviderConfigs: vi.fn(), countTextTokens: vi.fn() }))
vi.mock('../../packages/server/src/modules/ekko/services/provider-runtime', () => ({ createEkkoAuthorizedProviderFetch: vi.fn(), resolveEkkoProviderRuntimeConfig: vi.fn() }))
vi.mock('../../packages/server/src/modules/coding-agents/services', () => ({ getCodingAgentModels: vi.fn() }))
vi.mock('../../packages/server/src/modules/coding-agents/services/runtime/run-manager', () => ({ codingAgentRunManager: { getRunInfo, stop } }))
vi.mock('../../packages/server/src/modules/hermes/controllers/models', () => ({ getAvailableModelConfigForProfile: vi.fn() }))
beforeEach(() => { vi.resetModules(); vi.clearAllMocks() })

it.each([true, false])('uses the selected directory for native task execution and replaces a stale runtime (changed=%s)', async changed => {
  getRunInfo.mockReturnValue({ workspaceDir: changed ? '/workspace/old' : '/workspace/selected' })
  await import('../../packages/server/src/bootstrap/person-runtime-adapter')
  const { personRuntime } = await import('../../packages/server/src/modules/studio/public/person-runtime')
  await personRuntime().execute({ user: { id: 1, role: 'super_admin', username: 'user', profiles: ['default'] },
    selection: { runtime: 'codex', mode: 'global', profile: 'default', provider: '', model: '' },
    sessionId: 'person-task-existing', workspace: '/workspace/selected', prompt: 'Continue', signal: new AbortController().signal, onEvent: vi.fn() })
  expect(stop).toHaveBeenCalledTimes(changed ? 1 : 0)
  if (changed) expect(stop).toHaveBeenCalledWith('person-task-existing', { reportClosed: false })
  expect(runAndWait).toHaveBeenCalledWith(expect.objectContaining({ session_id: 'person-task-existing', workspace: '/workspace/selected' }), expect.anything())
})
