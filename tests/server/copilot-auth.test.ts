import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ active: 'first', prepare: vi.fn(), writeApp: vi.fn(), invalidate: vi.fn(), device: vi.fn(), poll: vi.fn() }))
vi.mock('../../packages/server/src/modules/hermes/services/providers/copilot-device-flow', () => ({ startDeviceFlow: mocks.device, pollDeviceFlow: mocks.poll }))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({ saveEnvValueForProfile: vi.fn(), updateConfigYamlForProfile: vi.fn() }))
vi.mock('../../packages/server/src/modules/hermes/services/providers/copilot-models', () => ({ invalidateAllCaches: vi.fn(), resolveCopilotOAuthTokenWithSource: vi.fn() }))
vi.mock('../../packages/server/src/modules/hermes/services/profiles/profile', () => ({ getActiveProfileName: () => mocks.active, getProfileDir: (name: string) => `/profiles/${name}` }))
vi.mock('../../packages/server/src/modules/hermes/services/bridge/manager', () => ({ resolveAgentBridgeCommand: (options: {hermesHome: string}) => ({command:'/python',argsPrefix:[],hermesHome:options.hermesHome}) }))
vi.mock('../../packages/server/src/modules/hermes/services/providers/copilot-runtime', () => ({ prepareCopilotRuntime: mocks.prepare }))
vi.mock('../../packages/server/src/modules/studio/public/provider-runtime', () => ({ invalidateProviderRuntime: mocks.invalidate }))
vi.mock('../../packages/server/src/modules/studio/public/app-config', () => ({ readAppConfig: vi.fn(), writeAppConfig: mocks.writeApp }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: {info:vi.fn(),error:vi.fn()} }))
vi.mock('../../packages/server/src/modules/hermes/services/models/model-section', () => ({ preservedModelKeys: vi.fn() }))

import { start, poll, enable } from '../../packages/server/src/modules/hermes/controllers/copilot-auth'

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  mocks.active = 'first'
  mocks.prepare.mockResolvedValue(undefined)
  mocks.device.mockResolvedValue({device_code:'fixture-device',user_code:'fixture-code',verification_uri:'https://example.invalid/login',expires_in:300,interval:1})
  mocks.poll.mockResolvedValue({kind:'success',access_token:'ghu_login_fixture'})
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

it('completes an OAuth login in the profile that started it after the active profile changes', async () => {
  const ctx = {state:{},body:null} as any
  await start(ctx)
  const id = ctx.body.session_id
  mocks.active = 'second'
  await vi.advanceTimersByTimeAsync(1000)
  expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({hermesHome:'/profiles/first'}), {token:'ghu_login_fixture',enableDisabled:true})
  expect(mocks.invalidate).toHaveBeenCalledWith('first','copilot')
  const status = {params:{sessionId:id},body:null} as any
  await poll(status)
  expect(status.body.status).toBe('approved')
})

it('does not mark a provider enabled when its required plugin could not be prepared', async () => {
  mocks.prepare.mockRejectedValueOnce(new Error('plugin unavailable'))
  const ctx = {state:{profile:{name:'work'}},body:null} as any
  await enable(ctx)
  expect(ctx.status).toBe(500)
  expect(ctx.body.error).toBe('plugin unavailable')
  expect(mocks.writeApp).not.toHaveBeenCalled()
  expect(mocks.invalidate).not.toHaveBeenCalled()
})
