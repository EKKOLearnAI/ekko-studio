// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ttsApiMock = vi.hoisted(() => ({
  deleteTtsProvider: vi.fn(),
  fetchTtsSettings: vi.fn(),
  saveActiveTtsProvider: vi.fn(),
  saveTtsSettings: vi.fn(),
}))

const sttApiMock = vi.hoisted(() => ({
  deleteSttProvider: vi.fn(),
  fetchSttSettings: vi.fn(),
  saveActiveSttProvider: vi.fn(),
  saveSttSettings: vi.fn(),
}))

const voiceSettingsMock = vi.hoisted(() => {
  const state = {
    provider: { value: 'mimo' },
    customUrl: { value: '' },
    customVoice: { value: 'alloy' },
    edgeVoice: { value: 'zh-CN-XiaoxiaoNeural' },
    edgeRate: { value: 1 },
    edgePitchHz: { value: 0 },
    mimoBaseUrl: { value: 'https://api.xiaomimimo.com/v1' },
    mimoModel: { value: 'mimo-v2.5-tts' },
    mimoVoice: { value: '冰糖' },
    mimoVoiceCloneDataUri: { value: '' },
    mimoVoiceCloneFileName: { value: '' },
    mimoVoiceCloneFormat: { value: 'wav' },
  }
  return {
    ...state,
    setProvider: vi.fn((value: string) => { state.provider.value = value }),
    setCustomUrl: vi.fn((value: string) => { state.customUrl.value = value }),
    setCustomVoice: vi.fn((value: string) => { state.customVoice.value = value }),
    setMimoBaseUrl: vi.fn(),
    setMimoModel: vi.fn(),
    setMimoVoice: vi.fn(),
    setMimoStylePrompt: vi.fn(),
    setMimoVoiceDesignDesc: vi.fn(),
    setMimoVoiceCloneDataUri: vi.fn((value: string) => { state.mimoVoiceCloneDataUri.value = value }),
    setMimoVoiceCloneFileName: vi.fn((value: string) => { state.mimoVoiceCloneFileName.value = value }),
    setMimoVoiceCloneFormat: vi.fn((value: string) => { state.mimoVoiceCloneFormat.value = value }),
  }
})

vi.mock('@/api/studio/tts-settings', () => ttsApiMock)
vi.mock('@/api/studio/stt-settings', () => sttApiMock)
vi.mock('@/composables/useVoiceSettings', () => ({ useVoiceSettings: () => voiceSettingsMock }))
vi.mock('@/composables/useSttSettings', () => ({
  useSttSettings: () => ({
    provider: { value: 'browser' },
    loadServerSttSettings: vi.fn(),
    setProvider: vi.fn(),
  }),
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

import { useVoiceApiConnections } from '@/composables/useVoiceApiConnections'

describe('useVoiceApiConnections MiMo voice clone', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    voiceSettingsMock.mimoVoiceCloneDataUri.value = ''
    voiceSettingsMock.mimoVoiceCloneFileName.value = ''
    voiceSettingsMock.mimoVoiceCloneFormat.value = 'wav'
    ttsApiMock.saveTtsSettings.mockResolvedValue({})
    ttsApiMock.saveActiveTtsProvider.mockResolvedValue('mimo')
    ttsApiMock.fetchTtsSettings.mockResolvedValue({
      activeProvider: 'mimo',
      providers: [{
        provider: 'mimo',
        settings: {
          model: 'mimo-v2.5-tts-voiceclone',
          voiceMode: 'voiceClone',
          voiceCloneFormat: 'mp3',
        },
        secrets: { apiKey: '[stored]' },
        updatedAt: 1,
      }],
    })
    sttApiMock.fetchSttSettings.mockResolvedValue({ activeProvider: 'browser', providers: [] })
  })

  it('keeps clone audio client-side while saving the remaining settings', async () => {
    const connections = useVoiceApiConnections()
    const dataUri = 'data:audio/mp3;base64,ZmFrZQ=='

    await connections.saveConnection('tts', 'mimo', {
      settings: {
        model: 'mimo-v2.5-tts-voiceclone',
        voiceMode: 'voiceClone',
        voiceCloneFormat: 'mp3',
        voiceCloneDataUri: dataUri,
        voiceCloneFileName: 'sample.mp3',
      },
    })

    expect(ttsApiMock.saveTtsSettings).toHaveBeenCalledWith('mimo', {
      settings: {
        model: 'mimo-v2.5-tts-voiceclone',
        voiceMode: 'voiceClone',
        voiceCloneFormat: 'mp3',
      },
      secrets: undefined,
      activeProvider: 'mimo',
    })
    expect(voiceSettingsMock.setMimoVoiceCloneDataUri).toHaveBeenCalledWith(dataUri)
    expect(voiceSettingsMock.setMimoVoiceCloneFileName).toHaveBeenCalledWith('sample.mp3')
    expect(voiceSettingsMock.setMimoVoiceCloneFormat).toHaveBeenCalledWith('mp3')
  })

  it('applies a saved custom TTS voice to legacy playback state', async () => {
    ttsApiMock.saveActiveTtsProvider.mockResolvedValue('custom')
    ttsApiMock.fetchTtsSettings.mockResolvedValue({
      activeProvider: 'custom',
      providers: [{
        provider: 'custom',
        settings: {
          baseUrl: 'https://api.groq.com/openai/v1',
          model: 'playai-tts',
          voice: 'Fritz-PlayAI',
        },
        secrets: { apiKey: '[stored]' },
        updatedAt: 1,
      }],
    })

    const connections = useVoiceApiConnections()
    await connections.refresh()
    await connections.setActiveConnection('tts', 'tts-custom')

    expect(voiceSettingsMock.setCustomUrl).toHaveBeenCalledWith('https://api.groq.com/openai/v1')
    expect(voiceSettingsMock.setCustomVoice).toHaveBeenCalledWith('Fritz-PlayAI')
  })
})
