import { isCodingAgentApiMode, type ChatCodingAgentId, type CodingAgentApiMode } from '@/api/coding-agents'
import { AGENT_OPTIONS } from './agent-options'
import { DEFAULT_REASONING_EFFORTS } from './model-reasoning-effort'

export interface NewChatFormPreferences {
  agent: 'hermes' | ChatCodingAgentId
  mode: 'scoped' | 'global'
  profile: string
  provider: string
  model: string
  customModel: boolean
  apiMode: CodingAgentApiMode
  reasoningEffort: string
  workspace: string
  categoryId: number | null
  agentPreset?: string
  baseUrl: string
  apiKey: string
  nativeModels?: Record<string, { model: string; reasoningEffort: string }>
}

const memory = new Map<string, NewChatFormPreferences>()
const storageKey = (account: number | null) => `hermes_new_chat_form_v1:${account ?? 'authenticated'}`
const stringValue = (value: unknown) => typeof value === 'string' ? value : ''

export function loadNewChatFormPreferences(account: number | null): NewChatFormPreferences | null {
  const key = storageKey(account)
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return memory.get(key) || null
    const saved = JSON.parse(raw)
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null
    const agent = AGENT_OPTIONS.find(option => option.value === saved.agent)?.value || AGENT_OPTIONS[0].value
    const nativeModels = Object.fromEntries(AGENT_OPTIONS.filter(option => option.value !== 'hermes' && option.value !== 'ekko-agent')
      .flatMap(option => {
        const selection = saved.nativeModels?.[option.value]
        return selection && typeof selection === 'object' ? [[option.value, {
          model: stringValue(selection.model),
          reasoningEffort: stringValue(selection.reasoningEffort),
        }]] : []
      }))
    const form: NewChatFormPreferences = {
      agent, mode: saved.mode === 'global' ? 'global' : 'scoped',
      profile: stringValue(saved.profile) || 'default',
      provider: stringValue(saved.provider), model: stringValue(saved.model),
      customModel: saved.customModel === true,
      apiMode: isCodingAgentApiMode(saved.apiMode) ? saved.apiMode : 'chat_completions',
      reasoningEffort: DEFAULT_REASONING_EFFORTS.includes(saved.reasoningEffort) ? saved.reasoningEffort : '',
      workspace: stringValue(saved.workspace),
      categoryId: Number.isSafeInteger(saved.categoryId) && saved.categoryId > 0 ? saved.categoryId : null,
      agentPreset: stringValue(saved.agentPreset) || undefined,
      baseUrl: stringValue(saved.baseUrl), apiKey: '',
      ...(saved.nativeModels ? { nativeModels } : {}),
    }
    try {
      const credential = JSON.parse(sessionStorage.getItem(`${key}:credential`) || 'null')
      if (credential?.profile === form.profile && credential?.provider === form.provider) {
        form.apiKey = stringValue(credential.apiKey)
      }
    } catch { /* Session storage may be unavailable. */ }
    return form
  } catch {
    return memory.get(key) || null
  }
}

export function saveNewChatFormPreferences(account: number | null, form: NewChatFormPreferences) {
  const key = storageKey(account)
  memory.set(key, { ...form })
  const { apiKey, ...preferences } = form
  try { localStorage.setItem(key, JSON.stringify(preferences)) } catch { /* Keep the in-memory preference. */ }
  try {
    if (apiKey) sessionStorage.setItem(`${key}:credential`, JSON.stringify({ profile: form.profile, provider: form.provider, apiKey }))
    else sessionStorage.removeItem(`${key}:credential`)
  } catch { /* Keep manually entered credentials in memory. */ }
}
