import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
let workspace: string

const runAndWait = vi.hoisted(() => vi.fn(async () => ({ ok: true, output: 'Done' })))
const getRunInfo = vi.hoisted(() => vi.fn())
const stop = vi.hoisted(() => vi.fn())
vi.mock('../../packages/server/src/modules/studio/public/chat-run', () => ({ getChatRunServer: () => ({ runAndWait }) }))
vi.mock('../../packages/server/src/bootstrap/person-chat-agent', () => ({ createPersonAgent: vi.fn() }))
vi.mock('../../packages/ekko-agent/src', () => ({ AgentRuntime: vi.fn(), AgentToolRegistry: vi.fn(), createModelClient: vi.fn(), resolveModelProviderConfigs: vi.fn(), countTextTokens: vi.fn() }))
vi.mock('../../packages/server/src/modules/ekko/services/provider-runtime', () => ({ createEkkoAuthorizedProviderFetch: vi.fn(), resolveEkkoProviderRuntimeConfig: vi.fn() }))
vi.mock('../../packages/server/src/modules/coding-agents/services', () => ({ getCodingAgentModels: vi.fn() }))
vi.mock('../../packages/server/src/modules/coding-agents/services/runtime/run-manager', () => ({ codingAgentRunManager: { getRunInfo, stop } }))
vi.mock('../../packages/server/src/modules/hermes/controllers/models', () => ({ getAvailableModelConfigForProfile: vi.fn() }))
beforeEach(() => { workspace = realpathSync(mkdtempSync(join(tmpdir(), 'person-runtime-workspace-'))); vi.resetModules(); vi.clearAllMocks() })

afterEach(() => rmSync(workspace, { recursive: true, force: true }))

it.each([
  [true, 2], [false, 2], [true, -1], [false, -1],
])('uses the selected directory and run limit for native task execution (changed=%s, minutes=%s)', async (changed, taskTimeoutMinutes) => {
  getRunInfo.mockReturnValue({ workspaceDir: changed ? join(workspace, 'old') : workspace })
  await import('../../packages/server/src/bootstrap/person-runtime-adapter')
  const { personRuntime } = await import('../../packages/server/src/modules/studio/public/person-runtime')
  await personRuntime().execute({ user: { id: 1, role: 'super_admin', username: 'user', profiles: ['default'] },
    selection: { runtime: 'codex', mode: 'global', profile: 'default', provider: '', model: '' },
    taskTimeoutMinutes, sessionId: 'person-task-existing', workspace, prompt: 'Continue', signal: new AbortController().signal, onEvent: vi.fn() })
  expect(stop).toHaveBeenCalledTimes(changed ? 1 : 0)
  if (changed) expect(stop).toHaveBeenCalledWith('person-task-existing', { reportClosed: false })
  expect(runAndWait).toHaveBeenCalledWith(expect.objectContaining({ session_id: 'person-task-existing', workspace }), expect.anything())
  const [request, options] = runAndWait.mock.lastCall!
  expect(request.instructions).toContain(`Effective workspace: ${workspace}`)
  expect(request.instructions).toContain('never switch to another directory')
  if (taskTimeoutMinutes === -1) expect(options).not.toHaveProperty('timeoutMs')
  else expect(options.timeoutMs).toBe(taskTimeoutMinutes * 60_000)
})
