import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  deleteTtsProvider,
  fetchTtsSettings,
  saveActiveTtsProvider,
  saveTtsSettings,
  type StoredTtsProvider,
  type TtsStoredSecretsInput,
  type TtsStoredSettings,
} from '@/api/studio/tts-settings'
import {
  deleteSttProvider,
  fetchSttSettings,
  saveActiveSttProvider,
  saveSttSettings,
  type StoredSttProvider,
  type SttProvider,
  type SttStoredSecretsInput,
  type SttStoredSettings,
} from '@/api/studio/stt-settings'
import { useVoiceSettings } from '@/composables/useVoiceSettings'
import { useSttSettings } from '@/composables/useSttSettings'
import { useLocalSttModel } from '@/composables/useLocalSttModel'
import { VOICE_API_PRESETS } from '@/constants/voiceApiPresets'
import type { VoiceApiConnection, VoiceApiKind, VoiceApiProvider, VoiceApiSavePayload } from '@/types/voice-api'

function isStoredSttProvider(provider: VoiceApiProvider): provider is StoredSttProvider {
  return provider === 'local' ||
    provider === 'openai' ||
    provider === 'custom' ||
    provider === 'doubao' ||
    provider === 'groq' ||
    provider === 'mistral' ||
    provider === 'xai' ||
    provider === 'elevenlabs' ||
    provider === 'deepinfra'
}

function isStoredTtsProvider(provider: VoiceApiProvider): provider is StoredTtsProvider {
  return provider === 'edge' ||
    provider === 'openai' ||
    provider === 'custom' ||
    provider === 'mimo' ||
    provider === 'doubao' ||
    provider === 'elevenlabs' ||
    provider === 'gemini' ||
    provider === 'xai' ||
    provider === 'mistral' ||
    provider === 'minimax' ||
    provider === 'deepinfra'
}

function isSttProvider(provider: VoiceApiProvider): provider is SttProvider {
  return provider === 'browser' || isStoredSttProvider(provider)
}

function isTtsProvider(provider: VoiceApiProvider): provider is StoredTtsProvider {
  return isStoredTtsProvider(provider)
}

function stringSetting(settings: object, key: string): string {
  const value = (settings as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

export function useVoiceApiConnections() {
  const { t } = useI18n()
  const connections = ref<VoiceApiConnection[]>([])
  const loading = ref(false)
  const vs = useVoiceSettings()
  const stt = useSttSettings()
  const localStt = useLocalSttModel()
  const activeTtsProvider = ref<StoredTtsProvider>(vs.provider.value === 'webspeech' ? 'edge' : vs.provider.value)
  const activeSttProvider = ref<SttProvider>(stt.provider.value)

  const activeTtsId = computed(() => `tts-${activeTtsProvider.value}`)
  const activeSttId = computed(() => `stt-${activeSttProvider.value}`)

  const ttsConnections = computed(() => connections.value.filter(c => c.kind === 'tts'))
  const sttConnections = computed(() => connections.value.filter(c => c.kind === 'stt'))
  const activeTtsConnection = computed(() => ttsConnections.value.find(c => c.id === activeTtsId.value) || ttsConnections.value[0] || null)
  const activeSttConnection = computed(() => sttConnections.value.find(c => c.id === activeSttId.value) || sttConnections.value[0] || null)
  const ttsConnectionOptions = computed(() => ttsConnections.value.map(c => ({ label: c.label, value: c.id })))
  const sttConnectionOptions = computed(() => sttConnections.value.map(c => ({
    label: c.label,
    value: c.id,
    disabled: c.provider === 'local' && !c.available,
  })))
  const localSttConnection = computed(() => sttConnections.value.find(c => c.provider === 'local') || null)
  const configurableSttConnections = computed(() => sttConnections.value.filter(c => c.provider !== 'local'))

  function applyTtsConnectionToLegacyState(connection: VoiceApiConnection) {
    if (!isTtsProvider(connection.provider)) return
    vs.setProvider(connection.provider)
    const settings = connection.settings

    if (connection.provider === 'edge') {
      vs.setEdgeVoice(stringSetting(settings, 'voice') || connection.voice || vs.edgeVoice.value)
      const rate = Number(settings.rate)
      const pitch = Number(settings.pitch)
      if (Number.isFinite(rate)) vs.setEdgeRate(rate)
      if (Number.isFinite(pitch)) vs.setEdgePitchHz(pitch)
      return
    }

    if (connection.provider === 'openai') {
      vs.setOpenaiBaseUrl(connection.baseUrl || stringSetting(settings, 'baseUrl'))
      vs.setOpenaiModel(connection.model || stringSetting(settings, 'model') || vs.openaiModel.value)
      vs.setOpenaiVoice(connection.voice || stringSetting(settings, 'voice') || vs.openaiVoice.value)
      return
    }

    if (connection.provider === 'custom') {
      vs.setCustomUrl(connection.baseUrl || stringSetting(settings, 'baseUrl'))
      return
    }

    if (connection.provider === 'mimo') {
      vs.setMimoBaseUrl(connection.baseUrl || stringSetting(settings, 'baseUrl') || vs.mimoBaseUrl.value)
      vs.setMimoModel(connection.model || stringSetting(settings, 'model') || vs.mimoModel.value)
      vs.setMimoVoice(connection.voice || stringSetting(settings, 'voice') || vs.mimoVoice.value)
      vs.setMimoStylePrompt(stringSetting(settings, 'stylePrompt'))
      vs.setMimoVoiceDesignDesc(stringSetting(settings, 'voiceDesignDesc'))
      const cloneFormat = stringSetting(settings, 'voiceCloneFormat')
      if (cloneFormat === 'mp3' || cloneFormat === 'wav') vs.setMimoVoiceCloneFormat(cloneFormat)
      return
    }

    if (connection.provider === 'doubao') {
      vs.setDoubaoBaseUrl(connection.baseUrl || stringSetting(settings, 'baseUrl') || vs.doubaoBaseUrl.value)
      vs.setDoubaoModel(connection.model || stringSetting(settings, 'model') || vs.doubaoModel.value)
      vs.setDoubaoVoice(connection.voice || stringSetting(settings, 'voice') || vs.doubaoVoice.value)
      vs.setDoubaoStylePrompt(stringSetting(settings, 'stylePrompt'))
      vs.setDoubaoSpeed(stringSetting(settings, 'speed').trim() || '1')
    }
  }

  function applySttConnectionToLegacyState(connection: VoiceApiConnection) {
    if (!isSttProvider(connection.provider)) return
    stt.setProvider(connection.provider)
    const settings = connection.settings

    if (connection.provider === 'openai') {
      stt.setOpenaiModel(connection.model || stringSetting(settings, 'model') || stt.openaiModel.value)
      stt.setOpenaiLanguage(stringSetting(settings, 'language'))
      stt.setOpenaiPrompt(stringSetting(settings, 'prompt'))
      return
    }

    if (connection.provider === 'custom') {
      stt.setCustomBaseUrl(connection.baseUrl || stringSetting(settings, 'baseUrl'))
      stt.setCustomModel(connection.model || stringSetting(settings, 'model') || stt.customModel.value)
      stt.setCustomLanguage(stringSetting(settings, 'language'))
      stt.setCustomPrompt(stringSetting(settings, 'prompt'))
    }
  }

  function makeTtsConnection(provider: StoredTtsProvider, settings: TtsStoredSettings, hasSecret: boolean): VoiceApiConnection {
    const preset = VOICE_API_PRESETS.find(pr => pr.kind === 'tts' && pr.provider === provider && (pr.baseUrl === settings.baseUrl || !pr.baseUrl))
    return {
      id: `tts-${provider}`,
      kind: 'tts',
      provider,
      label: preset?.labelKey ? t(preset.labelKey) : preset?.label || `${provider} TTS`,
      baseUrl: settings.baseUrl,
      model: settings.model,
      voice: settings.voice,
      settings: settings as Record<string, unknown>,
      hasSecret,
      active: activeTtsId.value === `tts-${provider}`,
    }
  }

  function makeSttConnection(provider: StoredSttProvider, settings: SttStoredSettings, hasSecret: boolean): VoiceApiConnection {
    const preset = VOICE_API_PRESETS.find(pr =>
      pr.kind === 'stt' &&
      (pr.provider === provider || (provider === 'custom' && !!pr.baseUrl && pr.baseUrl === settings.baseUrl)) &&
      (pr.baseUrl === settings.baseUrl || !pr.baseUrl),
    )
    return {
      id: `stt-${provider}`,
      kind: 'stt',
      provider,
      label: preset?.labelKey ? t(preset.labelKey) : preset?.label || `${provider} STT`,
      baseUrl: settings.baseUrl,
      model: settings.model,
      settings: settings as Record<string, unknown>,
      hasSecret,
      active: activeSttId.value === `stt-${provider}`,
    }
  }

  async function refresh() {
    loading.value = true
    try {
      await stt.loadServerSttSettings(true)
      const [ttsData, sttData, localStatus] = await Promise.all([
        fetchTtsSettings(),
        fetchSttSettings(),
        localStt.refresh().catch(() => null),
      ])
      if (ttsData.activeProvider && isTtsProvider(ttsData.activeProvider)) {
        activeTtsProvider.value = ttsData.activeProvider
        vs.setProvider(ttsData.activeProvider)
      }
      if (sttData.activeProvider && isSttProvider(sttData.activeProvider)) {
        activeSttProvider.value = sttData.activeProvider
        stt.setProvider(sttData.activeProvider)
      }

      const newConnections: VoiceApiConnection[] = [
        {
          id: 'tts-edge',
          kind: 'tts',
          provider: 'edge',
          label: t('settings.voice.presetEdgeTtsLabel'),
          isBuiltin: true,
          hasSecret: false,
          active: activeTtsId.value === 'tts-edge',
          settings: {
            voice: vs.edgeVoice.value,
            rate: vs.edgeRate.value,
            pitch: vs.edgePitchHz.value,
          },
          voice: vs.edgeVoice.value,
        },
        {
          id: 'stt-local',
          kind: 'stt',
          provider: 'local',
          label: t('settings.voice.localSttModelTitle'),
          isBuiltin: true,
          hasSecret: false,
          active: activeSttId.value === 'stt-local',
          available: localStatus?.usable === true,
          model: localStatus?.id,
          settings: {},
        },
        {
          id: 'stt-browser',
          kind: 'stt',
          provider: 'browser',
          label: t('settings.voice.presetBrowserSttLabel'),
          isBuiltin: true,
          hasSecret: false,
          active: activeSttId.value === 'stt-browser',
          settings: {},
        },
      ]

      for (const row of ttsData.providers) {
        const connection = makeTtsConnection(row.provider, row.settings, row.secrets?.apiKey === '[stored]')
        const existingBuiltIn = newConnections.find(c => c.id === connection.id)
        if (existingBuiltIn) {
          Object.assign(existingBuiltIn, connection, { isBuiltin: existingBuiltIn.isBuiltin })
        } else {
          newConnections.push(connection)
        }
      }

      for (const row of sttData.providers) {
        const connection = makeSttConnection(row.provider, row.settings, row.secrets?.apiKey === '[stored]')
        const existingBuiltIn = newConnections.find(c => c.id === connection.id)
        if (existingBuiltIn) {
          Object.assign(existingBuiltIn, connection, {
            isBuiltin: true,
            available: connection.provider === 'local' ? localStatus?.usable === true : existingBuiltIn.available,
          })
        } else {
          newConnections.push(connection)
        }
      }

      connections.value = newConnections.map(connection => ({
        ...connection,
        active: connection.kind === 'tts'
          ? connection.id === activeTtsId.value
          : connection.id === activeSttId.value,
      }))
    } finally {
      loading.value = false
    }
  }

  async function setActiveConnection(kind: VoiceApiKind, id: string) {
    const connection = connections.value.find(c => c.kind === kind && c.id === id)
    if (!connection) return
    if (connection.provider === 'local' && !connection.available) {
      throw new Error(t('settings.voice.localSttModelUnavailable'))
    }

    if (kind === 'tts') {
      if (isTtsProvider(connection.provider)) {
        const provider = await saveActiveTtsProvider(connection.provider)
        activeTtsProvider.value = provider
        applyTtsConnectionToLegacyState(connection)
      }
    } else {
      if (isSttProvider(connection.provider)) {
        const provider = await saveActiveSttProvider(connection.provider)
        activeSttProvider.value = provider
        applySttConnectionToLegacyState(connection)
      }
    }

    connections.value = connections.value.map(c => ({
      ...c,
      active: c.kind === kind ? c.id === id : c.active,
    }))
  }

  async function saveConnection(kind: VoiceApiKind, provider: VoiceApiProvider, payload: VoiceApiSavePayload) {
    if (kind === 'tts') {
      if (!isStoredTtsProvider(provider)) throw new Error(`Unsupported TTS provider: ${String(provider)}`)
      const settings = { ...(payload.settings || {}) }
      const hasCloneDataUri = Object.prototype.hasOwnProperty.call(settings, 'voiceCloneDataUri')
      const hasCloneFileName = Object.prototype.hasOwnProperty.call(settings, 'voiceCloneFileName')
      const cloneDataUri = settings.voiceCloneDataUri
      const cloneFileName = settings.voiceCloneFileName
      delete settings.voiceCloneDataUri
      delete settings.voiceCloneFileName
      const res = await saveTtsSettings(provider, {
        settings: settings as TtsStoredSettings,
        secrets: payload.secrets as TtsStoredSecretsInput | undefined,
        activeProvider: provider,
      })
      await refresh()
      await setActiveConnection('tts', `tts-${provider}`)
      if (provider === 'mimo') {
        if (hasCloneDataUri && typeof cloneDataUri === 'string') vs.setMimoVoiceCloneDataUri(cloneDataUri)
        if (hasCloneFileName && typeof cloneFileName === 'string') vs.setMimoVoiceCloneFileName(cloneFileName)
      }
      return res
    }

    if (provider === 'browser') {
      const activeProvider = await saveActiveSttProvider('browser')
      activeSttProvider.value = activeProvider
      stt.setProvider('browser')
      await refresh()
      return null
    }

    if (!isStoredSttProvider(provider)) throw new Error(`Unsupported STT provider: ${String(provider)}`)
    const res = await saveSttSettings(provider, {
      settings: payload.settings as SttStoredSettings | undefined,
      secrets: payload.secrets as SttStoredSecretsInput | undefined,
      activeProvider: provider,
    })
    await refresh()
    await setActiveConnection('stt', `stt-${provider}`)
    return res
  }

  async function deleteSecret(kind: VoiceApiKind, provider: VoiceApiProvider) {
    if (kind === 'tts') {
      if (!isStoredTtsProvider(provider) || provider === 'edge') return
      await deleteTtsProvider(provider)
    } else {
      if (!isStoredSttProvider(provider)) return
      await deleteSttProvider(provider)
    }
    await refresh()
  }

  return {
    connections,
    ttsConnections,
    sttConnections,
    activeTtsId,
    activeSttId,
    activeTtsConnection,
    activeSttConnection,
    ttsConnectionOptions,
    sttConnectionOptions,
    localSttConnection,
    configurableSttConnections,
    loading,
    refresh,
    setActiveConnection,
    saveConnection,
    deleteSecret,
  }
}
