// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { NSelect, NSwitch } from 'naive-ui'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn().mockResolvedValue({}))
vi.mock('@/api/client', () => ({ request }))
import * as api from '@/api/studio/context-manager'

describe('context manager API profile headers', () => {
  it('pins every request to the explicitly selected profile', async () => {
    await api.getContextManagerSettings('research')
    await api.saveContextManagerSettings('research', { hermes: { manager: 'bili' }, allowNativeFallback: false })
    await api.getContextManagerHealth('research')
    await api.runContextManagerLifecycle('research', 'ekko', 'start')
    expect(request.mock.calls).toHaveLength(4)
    for (const [, options] of request.mock.calls) expect(options.headers).toEqual({ 'X-Hermes-Profile': 'research' })
    expect(request.mock.calls[1][1].body).toBe(JSON.stringify({ hermes: { manager: 'bili' }, allowNativeFallback: false }))
    expect(request.mock.calls[3]).toEqual(['/api/studio/context-manager/lifecycle/start', { method: 'POST', headers: { 'X-Hermes-Profile': 'research' }, body: JSON.stringify({ manager: 'ekko' }) }])
  })
  it('rejects missing profiles without dispatch', () => {
    request.mockClear()
    expect(() => api.getContextManagerHealth(' ')).toThrow('Profile is required')
    expect(request).not.toHaveBeenCalled()
  })
})

const mocks = vi.hoisted(() => ({ get: vi.fn(), health: vi.fn(), save: vi.fn(), lifecycle: vi.fn() }))
const profiles = reactive({ activeProfileName: 'default' })
vi.mock('@/stores/hermes/profiles', () => ({ useProfilesStore: () => profiles }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<typeof import('naive-ui')>('naive-ui')
  return { ...actual, useMessage: () => ({ success: vi.fn(), error: vi.fn() }) }
})
import ContextManagerSettings from '@/components/hermes/settings/ContextManagerSettings.vue'

const defaults = { hermes: { manager: 'native' }, ekko: { manager: 'native' }, proxyUrl: 'http://127.0.0.1:8787', allowNativeFallback: false }
function health(management = 'none') {
  return { settings: defaults, healthy: management !== 'none', runtimeVersion: management === 'none' ? null : '0.1.182', compatibility: 'compatible', compatibilityIssues: [], worker: { status: 'unknown' }, lifecycle: { supported: true, installed: true, version: '0.1.181', running: management !== 'none', management, configFile: '/studio/config.json' } }
}
function wrapper() {
  return mount(ContextManagerSettings, { global: { stubs: {
    'n-select': { props: ['value'], emits: ['update:value'], template: '<button class="manager" @click="$emit(\'update:value\', \'bili\')">{{ value }}</button>' },
    NInput: { props: ['value'], emits: ['update:value'], template: '<input :value="value" @input="$emit(\'update:value\', $event.target.value)" />' },
    NSwitch: { props: ['value'], emits: ['update:value'], template: '<button class="fallback" :aria-checked="value" @click="$emit(\'update:value\', !value)" />' },
    NButton: { props: ['disabled'], emits: ['click'], template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>' },
    Modal: { props: ['show'], template: '<div v-if="show" role="dialog"><slot /></div>' },
    NSpin: { template: '<div><slot /></div>' }, NTag: { template: '<span><slot /></span>' }, NAlert: { template: '<div role="alert"><slot /></div>' },
  } } })
}
beforeEach(() => {
  vi.clearAllMocks()
  profiles.activeProfileName = 'default'
  mocks.get.mockResolvedValue(structuredClone(defaults))
  mocks.health.mockResolvedValue(health())
  mocks.save.mockImplementation(async (_profile, value) => structuredClone(value))
  mocks.lifecycle.mockResolvedValue({ lifecycle: health().lifecycle })
  request.mockImplementation((url, options) => {
    const profile = options.headers['X-Hermes-Profile']
    if (url.endsWith('/health')) return mocks.health(profile)
    if (url.includes('/lifecycle/')) return mocks.lifecycle(profile, JSON.parse(options.body).manager, url.split('/').at(-1))
    return options.method === 'PUT' ? mocks.save(profile, JSON.parse(options.body)) : mocks.get(profile)
  })
})
describe('context manager settings UI', () => {
  it('shows public-proxy incompatibility and safe health diagnostics separately from the worker', async () => {
    mocks.health.mockResolvedValue({ ...health('external'), compatibility: 'incompatible', compatibilityIssues: ['fork', 'tool:compress'],
      observations: { manifest: { error: 'token=private-token at /private/.env', errorCode: 'context_manager_probe_failed', statusCode: null }, status: { error: 'HTTP 503', errorCode: 'context_manager_probe_http', statusCode: 503 } },
      worker: { status: 'unknown', error: { code: 'context_manager_worker_unavailable', message: 'token=secret-worker' } } })
    const view = wrapper()
    await flushPromises()
    expect(view.text()).toContain('contextManager.incompatible')
    expect(view.text()).toContain('contextManager.issues.fork')
    expect(view.text()).toContain('contextManager.issues.tool')
    expect(view.text()).toContain('context_manager_probe_failed')
    expect(view.text()).toContain('context_manager_worker_unavailable')
    expect(view.text()).not.toMatch(/private-token|secret-worker|\/private|\.env/)
    view.unmount()
  })
  it('blocks working or unknown worker counts and cancels confirmation when the profile changes', async () => {
    const worker = { status: 'running', profile: 'default', pids: [100], activeSessions: 2, runningSessions: 1 }
    mocks.health.mockResolvedValue({ ...health('external'), worker })
    const view = wrapper()
    await flushPromises()
    expect(view.get('[data-action="restart-worker"]').attributes('disabled')).toBeDefined()
    worker.runningSessions = 0
    await view.get('[data-action="refresh"]').trigger('click')
    await flushPromises()
    await view.get('[data-action="restart-worker"]').trigger('click')
    profiles.activeProfileName = 'research'
    await flushPromises()
    expect(view.find('[data-action="confirm-restart"]').exists()).toBe(false)
    expect(request.mock.calls.filter(([url]) => url.endsWith('/worker/restart'))).toHaveLength(0)
    view.unmount()
  })
  it('requires profile-pinned confirmation before restarting a worker', async () => {
    mocks.health.mockResolvedValue({ ...health('external'), worker: { status: 'running', profile: 'default', pids: [100], activeSessions: 2, runningSessions: 0 } })
    const view = wrapper()
    await flushPromises()
    await view.get('[data-action="restart-worker"]').trigger('click')
    expect(request.mock.calls.filter(([url]) => url.endsWith('/worker/restart'))).toHaveLength(0)
    expect(view.text()).toContain('contextManager.restartImpact')
    await view.get('[data-action="confirm-restart"]').trigger('click')
    await flushPromises()
    expect(request.mock.calls.find(([url]) => url.endsWith('/worker/restart'))).toEqual(['/api/studio/context-manager/worker/restart', { method: 'POST', headers: { 'X-Hermes-Profile': 'default' }, body: JSON.stringify({ profile: 'default', confirm: true }) }])
    view.unmount()
  })
  it('retains concrete error code without exposing credentials or local paths', async () => {
    mocks.save.mockRejectedValue(Object.assign(new Error('API Error 409: token=secret-value at /private/home/.env Authorization: Bearer abc123'), { code: 'context_manager_sessions_running' }))
    const view = wrapper()
    await flushPromises()
    await view.get('[data-action="save"]').trigger('click')
    await flushPromises()
    expect(view.text()).toContain('context_manager_sessions_running')
    expect(view.text()).not.toMatch(/secret-value|abc123|\/private\/home|\.env/)
    view.unmount()
  })
  it('saves independent backends and explicit fallback then reloads health', async () => {
    const view = wrapper()
    await flushPromises()
    view.findAllComponents(NSelect)[0].vm.$emit('update:value', 'bili')
    view.findComponent(NSwitch).vm.$emit('update:value', true)
    await flushPromises()
    await view.get('[data-action="save"]').trigger('click')
    await flushPromises()
    expect(mocks.save).toHaveBeenCalledWith('default', { ...defaults, hermes: { manager: 'bili' }, allowNativeFallback: true })
    expect(mocks.health).toHaveBeenCalledTimes(2)
    view.unmount()
  })
  it('disables destructive lifecycle controls for external processes', async () => {
    mocks.health.mockResolvedValue(health('external'))
    const view = wrapper()
    await flushPromises()
    expect(view.text()).toContain('contextManager.external')
    for (const action of ['start', 'stop', 'upgrade']) expect(view.get(`[data-action="${action}"]`).attributes('disabled')).toBeDefined()
    expect(view.text()).toContain('contextManager.unknown')
    expect(view.text()).toContain('0.1.181')
    expect(view.text()).toContain('0.1.182')
    view.unmount()
  })
  it('dispatches lifecycle actions for the active profile and refreshes observed health', async () => {
    const view = wrapper()
    await flushPromises()
    expect(view.get('[data-action="start"]').attributes('disabled')).toBeUndefined()
    await view.get('[data-action="start"]').trigger('click')
    await flushPromises()
    expect(mocks.lifecycle).toHaveBeenCalledWith('default', 'hermes', 'start')
    expect(mocks.health).toHaveBeenCalledTimes(2)
    view.unmount()
  })
  it('ignores a late settings response from the previous profile', async () => {
    let resolveOld!: (value: unknown) => void
    mocks.get.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve })).mockResolvedValue({ ...defaults, ekko: { manager: 'bili' } })
    const view = wrapper()
    await flushPromises()
    profiles.activeProfileName = 'research'
    await flushPromises()
    resolveOld({ ...defaults, hermes: { manager: 'bili' } })
    await flushPromises()
    expect(view.findAllComponents(NSelect).map(el => el.props('value'))).toEqual(['native', 'bili'])
    expect(mocks.get).toHaveBeenCalledWith('research')
    view.unmount()
  })
  it('does not enable saves when initial loading fails', async () => {
    mocks.get.mockRejectedValue(new Error('offline'))
    const view = wrapper()
    await flushPromises()
    expect(view.get('[data-action="save"]').attributes('disabled')).toBeDefined()
    expect(view.find('[role="alert"]').exists()).toBe(true)
    view.unmount()
  })
})