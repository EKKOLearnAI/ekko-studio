// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest'
import { createApp } from 'vue'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createI18n } from 'vue-i18n'
import { BUILTIN_PLUGINS, installClientPlugins, isPluginEnabled, writePluginEnabledMap, readPluginEnabledMap } from '../../packages/client/src/plugins'
import { _resetForTesting } from '../../packages/client/src/plugins/registry'
import { loadLocaleMessages } from '../../packages/client/src/i18n/messages'
import router from '../../packages/client/src/router'
import { meetingASRApi } from '../../packages/client/src/utils/meeting-asr-api'
import { meetingStorageApi } from '../../packages/client/src/utils/meeting-storage-api'

vi.mock('socket.io-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('socket.io-client')>()
  return { ...original, io: vi.fn(original.io) }
})

beforeEach(() => { localStorage.clear(); _resetForTesting(); vi.restoreAllMocks(); vi.stubGlobal('__APP_VERSION__', '0.8.21') })
afterEach(() => { vi.unstubAllGlobals() })

function setup() {
  const app = createApp({ render: () => null })
  const router = createRouter({ history: createMemoryHistory(), routes: [] })
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: { core: 'Core interface' } } })
  return { app, router, i18n }
}

describe('local capabilities on the Studio client', () => {
  it('keeps local core routes while removing expert-center routes', () => {
    for (const name of ['hermes.meeting', 'hermes.usb', 'hermes.devices', 'hermes.clientPlugins', 'studio.plugins', 'hermes.skills']) expect(router.hasRoute(name)).toBe(true)
    expect(router.hasRoute('hermes.experts')).toBe(false)
    expect(router.hasRoute('hermes.expertDetail')).toBe(false)
    expect(router.getRoutes().some(route => route.path.startsWith('/hermes/experts'))).toBe(false)
  })

  it('keeps every local built-in disabled on a fresh install', async () => {
    const state = setup()
    const installed = await installClientPlugins(state.app, state.router, state.i18n, BUILTIN_PLUGINS)
    expect(installed.installedIds).toEqual([])
    expect(installed.sidebarItems).toEqual([])
    expect(BUILTIN_PLUGINS.every(registration => !isPluginEnabled(registration.plugin.id, registration.enabledByDefault))).toBe(true)
    localStorage.setItem('hermes.plugins.enabled', '{broken')
    expect(readPluginEnabledMap()).toEqual({})
  })

  it('requires Scanner for grading and registers enabled local routes', async () => {
    writePluginEnabledMap({ 'paper-grading': true })
    const first = setup()
    await installClientPlugins(first.app, first.router, first.i18n, BUILTIN_PLUGINS)
    expect(first.router.hasRoute('plugin-paper-grading.grading')).toBe(false)
    _resetForTesting()
    writePluginEnabledMap({ scanner: true, 'paper-grading': true, knowledge: true })
    const state = setup()
    const installed = await installClientPlugins(state.app, state.router, state.i18n, BUILTIN_PLUGINS)
    expect(installed.installedIds).toEqual(['scanner', 'paper-grading', 'knowledge'])
    for (const route of ['plugin-scanner.scanner', 'plugin-paper-grading.grading', 'plugin-paper-grading.grading-batch', 'plugin-knowledge.vaults']) expect(state.router.hasRoute(route)).toBe(true)
    // Registering extension text must not make an unloaded core locale look loaded.
    expect(state.i18n.global.availableLocales).toEqual(['en'])
    const turkish = await loadLocaleMessages('tr')
    expect(turkish.studioPlugins.title).toBeTruthy()
    expect(turkish.scanner.page.title).toBe('Scanner')
  })

  it('uses canonical local endpoints with the selected server and profile', async () => {
    localStorage.setItem('hermes_api_key', 'fixture-token')
    localStorage.setItem('hermes_server_url', 'https://device.example/studio')
    localStorage.setItem('hermes_active_profile_name', 'work')
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { headers: { 'Content-Type': 'application/json' } }))
    await meetingASRApi.getStatus()
    expect(fetch).toHaveBeenLastCalledWith('https://device.example/studio/api/studio/meeting-asr/status', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer fixture-token', 'X-Hermes-Profile': 'work' }) }))
    fetch.mockResolvedValue(new Response(JSON.stringify({ meetings: ['meeting-1'] })))
    expect(await meetingStorageApi.listMeetings()).toEqual(['meeting-1'])
    expect(fetch).toHaveBeenLastCalledWith('https://device.example/studio/api/studio/meeting-storage', expect.objectContaining({ headers: expect.objectContaining({ 'X-Hermes-Profile': 'work' }) }))
  })
})

describe('preserved local workflows', () => {
  it('keeps discussion uploads and control on Studio APIs', async () => {
    const { startDiscussion, uploadGroupDocument } = await import('../../packages/client/src/api/studio/group-chat')
    localStorage.setItem('hermes_api_key', 'fixture')
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ discussion: { id: 'd1' } })))
    await startDiscussion('room-1', { goal: 'Compare plans', minRounds: 2 })
    expect(fetch).toHaveBeenLastCalledWith('/api/studio/group-chat/rooms/room-1/discussion', expect.objectContaining({ method: 'POST', body: JSON.stringify({ goal: 'Compare plans', minRounds: 2 }) }))
    fetch.mockResolvedValue(new Response(JSON.stringify({ fileId: 'file-1', name: 'notes.md' })))
    await uploadGroupDocument('room-1', new File(['notes'], 'notes.md', { type: 'text/markdown' }))
    expect(fetch).toHaveBeenLastCalledWith('/api/studio/group-chat/rooms/room-1/documents', expect.objectContaining({ method: 'POST', body: expect.any(FormData) }))
  })

  it('keeps late document lists out of the newly selected room', async () => {
    const { createPinia, setActivePinia } = await import('pinia')
    const { nextTick } = await import('vue')
    const { useGroupChatStore } = await import('../../packages/client/src/stores/hermes/group-chat')
    setActivePinia(createPinia())
    let completeOld!: (response: Response) => void
    const oldResponse = new Promise<Response>(resolve => { completeOld = resolve })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (String(input).endsWith('/old/documents')) return oldResponse
      if (String(input).endsWith('/new/documents')) return Response.json({ documents: [{ fileId: 'new-doc' }] })
      return Response.json({ discussion: null })
    })
    const store = useGroupChatStore()
    store.currentRoomId = 'old'
    await nextTick()
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/old/documents'))).toBe(true)
    store.currentRoomId = 'new'
    await nextTick()
    await vi.waitFor(() => expect([...store.documentStates.keys()]).toEqual(['new-doc']))
    completeOld(Response.json({ documents: [{ fileId: 'old-doc' }] }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect([...store.documentStates.keys()]).toEqual(['new-doc'])
  })

  it('repairs device identity by restamping instead of launching an update', async () => {
    const { createPinia, setActivePinia } = await import('pinia')
    const { useAppStore } = await import('../../packages/client/src/stores/hermes/app')
    setActivePinia(createPinia())
    let identityVersion = '0.8.20'
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/health')) return new Response(JSON.stringify({ status: 'ok', webui_version: '0.8.21', webui_update_enabled: true, webui_update_strategy: 'source-deploy' }))
      if (path.endsWith('/identity/repair')) { expect(init?.method).toBe('POST'); identityVersion = '0.8.21'; return new Response(JSON.stringify({ success: true })) }
      if (path.endsWith('/identity')) return new Response(JSON.stringify({ success: true, installed: true, identity: { version: identityVersion } }))
      return new Response(JSON.stringify({ enabled: true, preflight: {}, runtime: {}, supports: {} }))
    })
    const store = useAppStore()
    await store.checkConnection()
    await store.refreshUpdateIdentity()
    expect(store.identityDrift).toBe(true)
    expect(await store.repairUpdateIdentity()).toBe(true)
    expect(store.identityDrift).toBe(false)
    expect(fetch.mock.calls.filter(([url, init]) => init?.method === 'POST').map(([url]) => String(url))).toEqual(['/api/studio/update/identity/repair'])
  })
})

test('meeting WebSockets carry auth without losing the remote deployment prefix', async () => {
  const { meetingWebSocketUrl } = await import('../../packages/client/src/utils/meeting-websocket')
  localStorage.setItem('hermes_server_url', 'https://device.example/studio')
  localStorage.setItem('hermes_api_key', 'session token')
  expect(meetingWebSocketUrl('/ws/asr')).toBe('wss://device.example/studio/ws/asr?token=session+token')
  expect(meetingWebSocketUrl('/ws/diarize')).toBe('wss://device.example/studio/ws/diarize?token=session+token')
  expect(meetingWebSocketUrl('/ws/omni-realtime')).toBe('wss://device.example/studio/ws/omni-realtime?token=session+token')
})

test('USB subscriptions separate the Socket.IO namespace from the server prefix', async () => {
  const { io } = await import('socket.io-client')
  const connect = vi.mocked(io)
  const socket = { on: vi.fn(), disconnect: vi.fn() }
  connect.mockReturnValue(socket as unknown as ReturnType<typeof io>)
  localStorage.setItem('hermes_server_url', 'https://device.example/studio')
  localStorage.setItem('hermes_api_key', 'fixture')
  const { onUSBReady, disconnectUSBSocket } = await import('../../packages/client/src/api/studio/usb-socket')
  try {
    onUSBReady(() => {})
    expect(connect).toHaveBeenLastCalledWith('https://device.example/usb', expect.objectContaining({
      path: '/studio/socket.io', auth: { token: 'fixture' },
    }))
  } finally { disconnectUSBSocket() }
})
