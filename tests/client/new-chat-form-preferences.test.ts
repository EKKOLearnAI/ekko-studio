// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadNewChatFormPreferences, saveNewChatFormPreferences, type NewChatFormPreferences } from '../../packages/client/src/utils/new-chat-form-preferences'

const form: NewChatFormPreferences = {
  agent: 'dsh', mode: 'scoped', profile: 'research', provider: 'manual', model: 'chosen-model', customModel: false,
  apiMode: 'anthropic_messages', reasoningEffort: 'high', workspace: '/workspace/project', categoryId: 12,
  agentPreset: 'minimal', baseUrl: 'https://example.invalid', apiKey: 'manual-credential',
}

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks() })

describe('new-chat form preferences', () => {
  it('retains all form choices per account and keeps manually entered credentials out of persistent storage', () => {
    saveNewChatFormPreferences(101, form)
    expect(loadNewChatFormPreferences(101)).toEqual(form)
    expect(loadNewChatFormPreferences(102)).toBeNull()
    expect(localStorage.getItem('hermes_new_chat_form_v1:101')).not.toContain('manual-credential')
    sessionStorage.clear()
    expect(loadNewChatFormPreferences(101)).toEqual({ ...form, apiKey: '' })
  })

  it('does not reuse a credential for another provider or profile', () => {
    saveNewChatFormPreferences(103, form)
    localStorage.setItem('hermes_new_chat_form_v1:103', JSON.stringify({ ...form, provider: 'other', apiKey: 'persistent-secret' }))
    expect(loadNewChatFormPreferences(103)?.apiKey).toBe('')
    localStorage.setItem('hermes_new_chat_form_v1:103', JSON.stringify({ ...form, profile: 'default' }))
    expect(loadNewChatFormPreferences(103)?.apiKey).toBe('')
  })

  it('rejects corrupt data and normalizes invalid options', () => {
    localStorage.setItem('hermes_new_chat_form_v1:104', '{broken')
    expect(loadNewChatFormPreferences(104)).toBeNull()
    localStorage.setItem('hermes_new_chat_form_v1:104', JSON.stringify({ ...form, agent: 'unknown', mode: 'invalid', apiMode: 'invalid', categoryId: -1, reasoningEffort: 'invalid' }))
    expect(loadNewChatFormPreferences(104)).toMatchObject({ agent: 'ekko-agent', mode: 'scoped', apiMode: 'chat_completions', categoryId: null, reasoningEffort: '' })
  })

  it('continues to work when browser storage rejects writes', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable') })
    saveNewChatFormPreferences(105, form)
    expect(loadNewChatFormPreferences(105)).toEqual(form)
  })
})
