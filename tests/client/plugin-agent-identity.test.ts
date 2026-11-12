import { afterEach, expect, it, vi } from 'vitest'
import { computed } from 'vue'
vi.mock('../../packages/client/src/api/client', () => ({ request: vi.fn() }))
import { syncPluginAgentOptions } from '../../packages/client/src/utils/agent-options'
import { chatSessionAgentAvatar } from '../../packages/client/src/utils/chat-agent-avatar'
import { defaultGroupAgentAvatar, groupMessageAgent } from '../../packages/client/src/utils/group-agent-avatar'
import { sessionAgentFields, isExternalCodingAgentSession, isHermesSession } from '../../packages/client/src/utils/hermes/session-agent'
import { personTaskIdentity } from '../../packages/client/src/utils/person-task-identity'
import { loadNewChatFormPreferences } from '../../packages/client/src/utils/new-chat-form-preferences'
import { canScopedCodingAgentUseProvider, usesServerManagedProviderAuth } from '../../packages/client/src/utils/codingAgentProviders'

const id = 'plugin:omp/omp' as const, icon = 'data:image/png;base64,aWNvbg=='
afterEach(() => { syncPluginAgentOptions([]); vi.unstubAllGlobals() })
function register() {
  syncPluginAgentOptions([{ id, name: 'Oh My Pi', icon, origin: 'plugin', vendor: 'Stencil Labs', description: '', modes: ['global', 'scoped'], surfaces: ['chat', 'group-chat', 'workflow'], actions: { settings: true, checkUpdate: true, upgrade: true }, status: { installed: true, version: '18' } }])
}
it('uses registered identity for new-chat cards, restored conversations, groups and Bot execution tasks', () => {
  register()
  expect(chatSessionAgentAvatar({ codingAgentId: id })).toEqual({ label: 'Oh My Pi', src: icon })
  const fields = sessionAgentFields({ agent: id, agent_mode: 'global', source: 'coding_agent' } as any)
  expect(fields).toMatchObject({ agent: id, codingAgentId: id, codingAgentMode: 'global' })
  expect(chatSessionAgentAvatar(fields)).toEqual({ label: 'Oh My Pi', src: icon })
  expect(isExternalCodingAgentSession({ agent: id })).toBe(true)
  expect(isHermesSession({ agent: id })).toBe(false)
  expect(defaultGroupAgentAvatar(id)).toEqual({ type: 'image', dataUrl: icon })
  const historical = groupMessageAgent({ senderType: 'agent', senderId: 'old', senderAgentType: id } as any, [])!
  expect(historical.agent).toBe(id)
  const identity = personTaskIdentity({ selection_json: JSON.stringify({ runtime: id, agentName: '开发者' }) })
  expect(identity).toMatchObject({ name: '开发者', avatar: { label: 'Oh My Pi', src: icon } })
})
it('updates reactive identities after discovery and never labels an unavailable plugin as Claude or Hermes', () => {
  const avatar = computed(() => chatSessionAgentAvatar({ source: 'coding_agent', agent: id }))
  const fallback = avatar.value.src
  expect(avatar.value.label).toBe(id)
  expect(fallback).toMatch(/^data:image\/svg\+xml/)
  expect(decodeURIComponent(fallback.split(',').slice(1).join(','))).toContain('>P</text>')
  register()
  expect(avatar.value).toEqual({ label: 'Oh My Pi', src: icon })
  syncPluginAgentOptions([])
  expect(avatar.value).toEqual({ label: id, src: fallback })
  expect(defaultGroupAgentAvatar(id)).toEqual({ type: 'image', dataUrl: fallback })
  expect(personTaskIdentity({ selection_json: JSON.stringify({ runtime: id }) }).avatar?.src).toBe(fallback)
  expect(chatSessionAgentAvatar({ agent: 'plugin:other/worker' }).src).not.toBe(fallback)
})
it('preserves a saved plugin and its native model while the registry is still loading', () => {
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ agent: id, mode: 'global', nativeModels: { [id]: { model: 'custom/example', reasoningEffort: 'high' } } }), setItem() {} })
  vi.stubGlobal('sessionStorage', { getItem: () => null })
  expect(loadNewChatFormPreferences(1)).toMatchObject({ agent: id, mode: 'global', nativeModels: { [id]: { model: 'custom/example', reasoningEffort: 'high' } } })
})
it('uses Studio credentials for plugin scoped models while retaining native CLI provider restrictions', () => {
  expect(usesServerManagedProviderAuth(id, 'custom:fixture')).toBe(true)
  expect(usesServerManagedProviderAuth(id, 'openai-codex')).toBe(true)
  expect(canScopedCodingAgentUseProvider(id, 'openai-codex')).toBe(true)
  expect(canScopedCodingAgentUseProvider('codex', 'openai-codex')).toBe(false)
  expect(usesServerManagedProviderAuth('codex', 'custom:fixture')).toBe(false)
})
