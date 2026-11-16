import { afterEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ user: 1, token: 'ghu_one' }))
vi.mock('../../packages/server/src/modules/studio/public/provider-config', () => ({ providerEnv: async () => `COPILOT_GITHUB_TOKEN=${fixture.token}\n` }))
vi.mock('../../packages/server/src/modules/studio/public/provider-account', () => ({ providerAccountId: () => fixture.user }))
import { resolveCopilotCredentials } from '../../packages/server/src/modules/studio/services/providers/copilot-credentials'

afterEach(() => vi.unstubAllGlobals())
it('exchanges GitHub OAuth credentials once, isolates accounts and forces refresh on recovery', async () => {
  fixture.user = 1
  fixture.token = 'ghu_one'
  const fetcher = vi.fn().mockImplementation(async () => Response.json({ token: `inference_${fetcher.mock.calls.length}`, expires_at: Date.now() / 1000 + 3600 }))
  vi.stubGlobal('fetch', fetcher)
  const [first, shared] = await Promise.all([resolveCopilotCredentials({ profile: 'default' }), resolveCopilotCredentials({ profile: 'work' })])
  expect(first.apiKey).toBe('inference_1')
  expect(shared.apiKey).toBe(first.apiKey)
  expect(fetcher).toHaveBeenCalledOnce()
  expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('token ghu_one')
  fixture.user = 2
  expect((await resolveCopilotCredentials({ profile: 'default' })).apiKey).toBe('inference_2')
  expect((await resolveCopilotCredentials({ profile: 'default', forceRefresh: true })).apiKey).toBe('inference_3')
  fixture.token = ''
  await expect(resolveCopilotCredentials({ profile: 'default' })).rejects.toThrow('login is required')
})
