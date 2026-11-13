import { ref, watch } from 'vue'
import { fetchTtsSettings, type FetchTtsSettingsResponse } from '@/api/studio/tts-settings'
import { getActiveProfileName, getStoredUserId, hasApiKey } from '@/api/client'
import { DOUBAO_TTS_2_RESOURCE_ID, DOUBAO_TTS_DEFAULT_VOICE } from '@/constants/doubaoTtsVoices'

export type TtsProvider =
  | 'webspeech'
  | 'openai'
  | 'custom'
  | 'edge'
  | 'mimo'
  | 'doubao'
  | 'elevenlabs'
  | 'gemini'
  | 'xai'
  | 'mistral'
  | 'minimax'
  | 'deepinfra'
export type MimoAuthMode = 'api-key' | 'bearer' | 'both'

export interface VoiceSettingsData {
  provider: TtsProvider

  // WebSpeech
  webspeechVoice: string

  // OpenAI
  openaiApiKey: string
  openaiBaseUrl: string
  openaiModel: string
  openaiVoice: string

  // Custom endpoint (OpenAI-compatible)
  customUrl: string
  customApiKey: string

  // Edge TTS
  edgeUrl: string
  edgeVoice: string
  edgeRate: number    // 语速倍率 0.5~2.0，1.0 = 正常
  edgePitchHz: number // 音调偏移 Hz，-20~20，0 = 正常

  // MiMo TTS
  mimoApiKey: string
  mimoAuthMode: MimoAuthMode
  mimoBaseUrl: string
  mimoModel: string            // 'mimo-v2.5-tts' | 'mimo-v2.5-tts-voicedesign' | 'mimo-v2.5-tts-voiceclone'
  mimoVoice: string            // 预置音色 ID
  mimoVoiceDesignDesc: string  // 音色设计描述文本
  mimoVoiceCloneDataUri: string // 音色复刻参考音频 data URI
  mimoVoiceCloneFileName: string
  mimoVoiceCloneFormat: 'mp3' | 'wav'
  mimoStylePrompt: string      // 风格指令

  // Doubao TTS
  doubaoApiKey: string
  doubaoBaseUrl: string
  doubaoModel: string
  doubaoVoice: string
  doubaoStylePrompt: string
  doubaoSpeed: string
}

const STORAGE_KEY = 'hermes-tts-settings-v2'

function migrateOldKeys() {
  const oldKey = 'hermes-tts-settings'
  try {
    const old = localStorage.getItem(oldKey)
    if (old) {
      const parsed = JSON.parse(old)
      // Old 'custom' provider maps to new 'custom'
      // Old 'gptsovits' provider maps to new 'custom'
      if (parsed.provider === 'gptsovits') {
        parsed.provider = 'custom'
        // old gptsovitsUrl -> customUrl
        if (parsed.gptsovitsUrl && !parsed.customUrl) {
          parsed.customUrl = parsed.gptsovitsUrl
        }
      }
      // Store as new format
      const data = { ...DEFAULT, ...parsed }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
      localStorage.removeItem(oldKey)
    }
  } catch { /* ignore */ }
}

const DEFAULT: VoiceSettingsData = {
  provider: 'webspeech',

  webspeechVoice: '',

  openaiApiKey: '',
  openaiBaseUrl: '',
  openaiModel: 'tts-1',
  openaiVoice: 'alloy',

  customUrl: '',
  customApiKey: '',

  edgeUrl: '',
  edgeVoice: 'zh-CN-XiaoxiaoNeural',
  edgeRate: 1.0,
  edgePitchHz: 0,

  mimoApiKey: '',
  mimoAuthMode: 'bearer',
  mimoBaseUrl: 'https://api.xiaomimimo.com/v1',
  mimoModel: 'mimo-v2.5-tts',
  mimoVoice: '冰糖',
  mimoVoiceDesignDesc: '',
  mimoVoiceCloneDataUri: '',
  mimoVoiceCloneFileName: '',
  mimoVoiceCloneFormat: 'wav',
  mimoStylePrompt: '',

  doubaoApiKey: '',
  doubaoBaseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
  doubaoModel: DOUBAO_TTS_2_RESOURCE_ID,
  doubaoVoice: DOUBAO_TTS_DEFAULT_VOICE,
  doubaoStylePrompt: '',
  doubaoSpeed: '1',
}

function sanitize(data: VoiceSettingsData): VoiceSettingsData {
  // Clear old Edge TTS adapter URLs — now uses internal node-edge-tts
  if (data.edgeUrl && data.edgeUrl !== '') {
    data.edgeUrl = ''
  }
  if (data.mimoAuthMode !== 'api-key' && data.mimoAuthMode !== 'bearer' && data.mimoAuthMode !== 'both') {
    data.mimoAuthMode = DEFAULT.mimoAuthMode
  }
  if (data.mimoVoiceCloneFormat !== 'mp3' && data.mimoVoiceCloneFormat !== 'wav') {
    data.mimoVoiceCloneFormat = DEFAULT.mimoVoiceCloneFormat
  }
  return data
}

function load(): VoiceSettingsData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return sanitize({ ...DEFAULT, ...JSON.parse(raw) })
  } catch { /* ignore */ }
  return { ...DEFAULT }
}

// Run migration once on import
migrateOldKeys()

let serverSettingsLoadedContext: string | null = null
let serverSettingsPromise: Promise<void> | null = null
let serverSettingsPromiseContext: string | null = null
let serverSettingsGeneration = 0

function serverSettingsContext(): string | null {
  if (!hasApiKey()) return null
  const user = getStoredUserId() ?? 'authenticated'
  const profile = getActiveProfileName()?.trim() || 'default'
  return `${user}:${profile}`
}

function applyServerTtsSettings(response: FetchTtsSettingsResponse) {
  if (response.activeProvider) {
    provider.value = response.activeProvider
  }
  const doubao = response.providers.find(row => row.provider === 'doubao')
  doubaoSpeed.value = doubao?.settings.speed?.trim() || DEFAULT.doubaoSpeed
}

export async function loadServerTtsSettings(force = false): Promise<void> {
  const context = serverSettingsContext()
  if (!context) return
  if (serverSettingsLoadedContext === context && !force) return
  if (serverSettingsPromise && serverSettingsPromiseContext === context && !force) {
    return serverSettingsPromise
  }

  const generation = ++serverSettingsGeneration
  const promise = fetchTtsSettings()
    .then(response => {
      if (generation !== serverSettingsGeneration || serverSettingsContext() !== context) return
      applyServerTtsSettings(response)
      serverSettingsLoadedContext = context
    })
    .finally(() => {
      if (serverSettingsPromise === promise) {
        serverSettingsPromise = null
        serverSettingsPromiseContext = null
      }
    })

  serverSettingsPromise = promise
  serverSettingsPromiseContext = context
  return promise
}

// ── Reactive state ──
const provider = ref<TtsProvider>(load().provider)

// WebSpeech
const webspeechVoice = ref<string>(load().webspeechVoice)

// OpenAI
const openaiApiKey = ref<string>(load().openaiApiKey)
const openaiBaseUrl = ref<string>(load().openaiBaseUrl)
const openaiModel = ref<string>(load().openaiModel)
const openaiVoice = ref<string>(load().openaiVoice)

// Custom
const customUrl = ref<string>(load().customUrl)
const customApiKey = ref<string>(load().customApiKey)

// Edge TTS
const edgeUrl = ref<string>(load().edgeUrl)
const edgeVoice = ref<string>(load().edgeVoice)
const edgeRate = ref<number>(load().edgeRate)
const edgePitchHz = ref<number>(load().edgePitchHz)

// MiMo TTS
const mimoApiKey = ref<string>(load().mimoApiKey)
const mimoAuthMode = ref<MimoAuthMode>(load().mimoAuthMode)
const mimoBaseUrl = ref<string>(load().mimoBaseUrl)
const mimoModel = ref<string>(load().mimoModel)
const mimoVoice = ref<string>(load().mimoVoice)
const mimoVoiceDesignDesc = ref<string>(load().mimoVoiceDesignDesc)
const mimoVoiceCloneDataUri = ref<string>(load().mimoVoiceCloneDataUri)
const mimoVoiceCloneFileName = ref<string>(load().mimoVoiceCloneFileName)
const mimoVoiceCloneFormat = ref<'mp3' | 'wav'>(load().mimoVoiceCloneFormat)
const mimoStylePrompt = ref<string>(load().mimoStylePrompt)

// Doubao TTS
const doubaoApiKey = ref<string>(load().doubaoApiKey)
const doubaoBaseUrl = ref<string>(load().doubaoBaseUrl)
const doubaoModel = ref<string>(load().doubaoModel)
const doubaoVoice = ref<string>(load().doubaoVoice)
const doubaoStylePrompt = ref<string>(load().doubaoStylePrompt)
const doubaoSpeed = ref<string>(load().doubaoSpeed)

// Auto-persist on change
watch(
  [provider, webspeechVoice, openaiApiKey, openaiBaseUrl, openaiModel, openaiVoice,
   customUrl, customApiKey, edgeUrl, edgeVoice, edgeRate, edgePitchHz,
   mimoApiKey, mimoAuthMode, mimoBaseUrl, mimoModel, mimoVoice, mimoVoiceDesignDesc,
   mimoVoiceCloneDataUri, mimoVoiceCloneFileName, mimoVoiceCloneFormat, mimoStylePrompt,
   doubaoApiKey, doubaoBaseUrl, doubaoModel, doubaoVoice, doubaoStylePrompt, doubaoSpeed],
  () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        provider: provider.value,
        webspeechVoice: webspeechVoice.value,
        openaiApiKey: openaiApiKey.value,
        openaiBaseUrl: openaiBaseUrl.value,
        openaiModel: openaiModel.value,
        openaiVoice: openaiVoice.value,
        customUrl: customUrl.value,
        customApiKey: customApiKey.value,
        edgeUrl: edgeUrl.value,
        edgeVoice: edgeVoice.value,
        edgeRate: edgeRate.value,
        edgePitchHz: edgePitchHz.value,
        mimoApiKey: mimoApiKey.value,
        mimoAuthMode: mimoAuthMode.value,
        mimoBaseUrl: mimoBaseUrl.value,
        mimoModel: mimoModel.value,
        mimoVoice: mimoVoice.value,
        mimoVoiceDesignDesc: mimoVoiceDesignDesc.value,
        mimoVoiceCloneDataUri: mimoVoiceCloneDataUri.value,
        mimoVoiceCloneFileName: mimoVoiceCloneFileName.value,
        mimoVoiceCloneFormat: mimoVoiceCloneFormat.value,
        mimoStylePrompt: mimoStylePrompt.value,
        doubaoApiKey: doubaoApiKey.value,
        doubaoBaseUrl: doubaoBaseUrl.value,
        doubaoModel: doubaoModel.value,
        doubaoVoice: doubaoVoice.value,
        doubaoStylePrompt: doubaoStylePrompt.value,
        doubaoSpeed: doubaoSpeed.value,
      }))
    } catch (err) {
      console.warn('[useVoiceSettings] Failed to persist voice settings:', err)
    }
  },
)

export function useVoiceSettings() {
  return {
    provider,
    webspeechVoice,
    openaiApiKey,
    openaiBaseUrl,
    openaiModel,
    openaiVoice,
    customUrl,
    customApiKey,
    edgeUrl,
    edgeVoice,
    edgeRate,
    edgePitchHz,
    mimoApiKey,
    mimoAuthMode,
    mimoBaseUrl,
    mimoModel,
    mimoVoice,
    mimoVoiceDesignDesc,
    mimoVoiceCloneDataUri,
    mimoVoiceCloneFileName,
    mimoVoiceCloneFormat,
    mimoStylePrompt,
    doubaoApiKey,
    doubaoBaseUrl,
    doubaoModel,
    doubaoVoice,
    doubaoStylePrompt,
    doubaoSpeed,

    loadServerTtsSettings,

    setProvider(v: TtsProvider) { provider.value = v },
    setWebSpeechVoice(v: string) { webspeechVoice.value = v },
    setOpenaiApiKey(v: string) { openaiApiKey.value = v },
    setOpenaiBaseUrl(v: string) { openaiBaseUrl.value = v },
    setOpenaiModel(v: string) { openaiModel.value = v },
    setOpenaiVoice(v: string) { openaiVoice.value = v },
    setCustomUrl(v: string) { customUrl.value = v },
    setCustomApiKey(v: string) { customApiKey.value = v },
    setEdgeUrl(v: string) { edgeUrl.value = v },
    setEdgeVoice(v: string) { edgeVoice.value = v },
    setEdgeRate(v: number) { edgeRate.value = v },
    setEdgePitchHz(v: number) { edgePitchHz.value = v },
    setMimoApiKey(v: string) { mimoApiKey.value = v },
    setMimoAuthMode(v: MimoAuthMode) { mimoAuthMode.value = v },
    setMimoBaseUrl(v: string) { mimoBaseUrl.value = v },
    setMimoModel(v: string) { mimoModel.value = v },
    setMimoVoice(v: string) { mimoVoice.value = v },
    setMimoVoiceDesignDesc(v: string) { mimoVoiceDesignDesc.value = v },
    setMimoVoiceCloneDataUri(v: string) { mimoVoiceCloneDataUri.value = v },
    setMimoVoiceCloneFileName(v: string) { mimoVoiceCloneFileName.value = v },
    setMimoVoiceCloneFormat(v: 'mp3' | 'wav') { mimoVoiceCloneFormat.value = v },
    setMimoStylePrompt(v: string) { mimoStylePrompt.value = v },
    setDoubaoApiKey(v: string) { doubaoApiKey.value = v },
    setDoubaoBaseUrl(v: string) { doubaoBaseUrl.value = v },
    setDoubaoModel(v: string) { doubaoModel.value = v },
    setDoubaoVoice(v: string) { doubaoVoice.value = v },
    setDoubaoStylePrompt(v: string) { doubaoStylePrompt.value = v },
    setDoubaoSpeed(v: string) { doubaoSpeed.value = v },

    reset() {
      provider.value = DEFAULT.provider
      webspeechVoice.value = DEFAULT.webspeechVoice
      openaiApiKey.value = DEFAULT.openaiApiKey
      openaiBaseUrl.value = DEFAULT.openaiBaseUrl
      openaiModel.value = DEFAULT.openaiModel
      openaiVoice.value = DEFAULT.openaiVoice
      customUrl.value = DEFAULT.customUrl
      customApiKey.value = DEFAULT.customApiKey
      edgeUrl.value = DEFAULT.edgeUrl
      edgeVoice.value = DEFAULT.edgeVoice
      edgeRate.value = DEFAULT.edgeRate
      edgePitchHz.value = DEFAULT.edgePitchHz
      mimoApiKey.value = DEFAULT.mimoApiKey
      mimoAuthMode.value = DEFAULT.mimoAuthMode
      mimoBaseUrl.value = DEFAULT.mimoBaseUrl
      mimoModel.value = DEFAULT.mimoModel
      mimoVoice.value = DEFAULT.mimoVoice
      mimoVoiceDesignDesc.value = DEFAULT.mimoVoiceDesignDesc
      mimoVoiceCloneDataUri.value = DEFAULT.mimoVoiceCloneDataUri
      mimoVoiceCloneFileName.value = DEFAULT.mimoVoiceCloneFileName
      mimoVoiceCloneFormat.value = DEFAULT.mimoVoiceCloneFormat
      mimoStylePrompt.value = DEFAULT.mimoStylePrompt
      doubaoApiKey.value = DEFAULT.doubaoApiKey
      doubaoBaseUrl.value = DEFAULT.doubaoBaseUrl
      doubaoModel.value = DEFAULT.doubaoModel
      doubaoVoice.value = DEFAULT.doubaoVoice
      doubaoStylePrompt.value = DEFAULT.doubaoStylePrompt
      doubaoSpeed.value = DEFAULT.doubaoSpeed
    },
  }
}
