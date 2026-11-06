import { afterEach, expect, it, vi } from 'vitest'

const external = vi.hoisted(() => ({ exec: vi.fn(), readFile: vi.fn() }))
vi.mock('child_process', () => ({ execFile: Object.assign(() => {}, { [Symbol.for('nodejs.util.promisify.custom')]: external.exec }) }))
vi.mock('fs/promises', () => ({ readFile: external.readFile }))
import { resolveCopilotOAuthToken, resolveCopilotOAuthTokenWithSource } from '../../packages/server/src/modules/hermes/services/providers/copilot-models'

afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks() })

it('uses the profile credential ahead of an inherited login', async () => {
  vi.stubEnv('COPILOT_GITHUB_TOKEN', 'other-profile-token')
  expect(await resolveCopilotOAuthToken('COPILOT_GITHUB_TOKEN=own-profile-token')).toBe('own-profile-token')
})

it('does not expose a server process login to a named profile', async () => {
  vi.stubEnv('COPILOT_GITHUB_TOKEN', 'server-token')
  expect(await resolveCopilotOAuthToken('', false)).toBe('')
  expect(external.exec).not.toHaveBeenCalled()
})

it('detects an external login for explicit Add while keeping it out of the runtime model catalog', async () => {
  for (const key of ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) vi.stubEnv(key, '')
  external.readFile.mockResolvedValue(JSON.stringify({ github: { oauth_token: 'ghu_external' } }))
  expect(await resolveCopilotOAuthTokenWithSource('')).toEqual({ token: 'ghu_external', source: 'apps-json' })
  expect(await resolveCopilotOAuthToken('')).toBe('')
})
