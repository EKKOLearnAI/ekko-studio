import { ref, watch } from 'vue'
import { fetchSttSettings } from '@/api/studio/stt-settings'
import type {
  FetchSttSettingsResponse,
  SttProvider,
  SttProviderSettingsResponse,
} from '@/api/studio/stt-settings'

interface SttSettingsData {
  provider: SttProvider
  openaiModel: string
  openaiLanguage: string
  openaiPrompt: string
  customBaseUrl: string
  customModel: string
  customLanguage: string
  customPrompt: string
}

const STORAGE_KEY = 'hermes-stt-settings-v1'

function browserSttAvailable(): boolean {
  if (typeof window === 'undefined') return false
  const browserWindow = window as Window & {
    SpeechRecognition?: unknown
    webkitSpeechRecognition?: unknown
  }
  return typeof browserWindow.SpeechRecognition !== 'undefined'
    || typeof browserWindow.webkitSpeechRecognition !== 'undefined'
}

function defaultProvider(): SttProvider {
  return browserSttAvailable() ? 'browser' : 'openai'
}

const DEFAULT: SttSettingsData = {
  provider: defaultProvider(),
  openaiModel: 'gpt-4o-transcribe',
  openaiLanguage: '',
  openaiPrompt: '',
  customBaseUrl: '',
  customModel: 'gpt-4o-transcribe',
  customLanguage: '',
  customPrompt: '',
}

function sanitize(data: Partial<SttSettingsData>): SttSettingsData {
  const provider = data.provider === 'browser' ||
    data.provider === 'local' ||
    data.provider === 'openai' ||
    data.provider === 'custom' ||
    data.provider === 'doubao' ||
    data.provider === 'groq' ||
    data.provider === 'mistral' ||
    data.provider === 'xai' ||
    data.provider === 'elevenlabs' ||
    data.provider === 'deepinfra'
    ? data.provider
    : DEFAULT.provider

  return {
    provider,
    openaiModel: typeof data.openaiModel === 'string' && data.openaiModel.trim() ? data.openaiModel : DEFAULT.openaiModel,
    openaiLanguage: typeof data.openaiLanguage === 'string' ? data.openaiLanguage : DEFAULT.openaiLanguage,
    openaiPrompt: typeof data.openaiPrompt === 'string' ? data.openaiPrompt : DEFAULT.openaiPrompt,
    customBaseUrl: typeof data.customBaseUrl === 'string' ? data.customBaseUrl : DEFAULT.customBaseUrl,
    customModel: typeof data.customModel === 'string' && data.customModel.trim() ? data.customModel : DEFAULT.customModel,
    customLanguage: typeof data.customLanguage === 'string' ? data.customLanguage : DEFAULT.customLanguage,
    customPrompt: typeof data.customPrompt === 'string' ? data.customPrompt : DEFAULT.customPrompt,
  }
}

function load(): SttSettingsData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const sanitized = sanitize(JSON.parse(raw))
      const sanitizedRaw = JSON.stringify(sanitized)
      if (raw !== sanitizedRaw) {
        localStorage.setItem(STORAGE_KEY, sanitizedRaw)
      }
      return sanitized
    }
  } catch {
    // ignore invalid persisted values
  }
  return { ...DEFAULT }
}

const initial = load()

const provider = ref<SttProvider>(initial.provider)

const openaiModel = ref(initial.openaiModel)
const openaiLanguage = ref(initial.openaiLanguage)
const openaiPrompt = ref(initial.openaiPrompt)
const openaiApiKey = ref('')
const openaiApiKeyPreview = ref('')
const openaiHasApiKey = ref(false)

const customBaseUrl = ref(initial.customBaseUrl)
const customBaseUrlPresets = ref<string[]>([])
const customModel = ref(initial.customModel)
const customLanguage = ref(initial.customLanguage)
const customPrompt = ref(initial.customPrompt)
const customApiKey = ref('')
const customApiKeyPreview = ref('')
const customHasApiKey = ref(false)

function persistedData(): SttSettingsData {
  return {
    provider: provider.value,
    openaiModel: openaiModel.value,
    openaiLanguage: openaiLanguage.value,
    openaiPrompt: openaiPrompt.value,
    customBaseUrl: customBaseUrl.value,
    customModel: customModel.value,
    customLanguage: customLanguage.value,
    customPrompt: customPrompt.value,
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedData()))
  } catch (err) {
    console.warn('[useSttSettings] Failed to persist STT settings:', err)
  }
}

function resetServerBackedState() {
  openaiModel.value = DEFAULT.openaiModel
  openaiLanguage.value = DEFAULT.openaiLanguage
  openaiPrompt.value = DEFAULT.openaiPrompt
  openaiApiKey.value = ''
  openaiApiKeyPreview.value = ''
  openaiHasApiKey.value = false

  customBaseUrl.value = DEFAULT.customBaseUrl
  customBaseUrlPresets.value = []
  customModel.value = DEFAULT.customModel
  customLanguage.value = DEFAULT.customLanguage
  customPrompt.value = DEFAULT.customPrompt
  customApiKey.value = ''
  customApiKeyPreview.value = ''
  customHasApiKey.value = false
}

function resetLocalState() {
  const nextDefault = defaultProvider()
  provider.value = nextDefault
  openaiModel.value = DEFAULT.openaiModel
  openaiLanguage.value = DEFAULT.openaiLanguage
  openaiPrompt.value = DEFAULT.openaiPrompt
  customBaseUrl.value = DEFAULT.customBaseUrl
  customBaseUrlPresets.value = []
  customModel.value = DEFAULT.customModel
  customLanguage.value = DEFAULT.customLanguage
  customPrompt.value = DEFAULT.customPrompt
}

let serverSettingsLoaded = false
let serverSettingsPromise: Promise<void> | null = null
let serverSettingsGeneration = 0

export function clearSttSettingsAuthState() {
  serverSettingsGeneration += 1
  serverSettingsLoaded = false
  serverSettingsPromise = null
  resetLocalState()
  resetServerBackedState()
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('hermes-auth-cleared', clearSttSettingsAuthState)
}

watch(
  [provider, openaiModel, openaiLanguage, openaiPrompt, customBaseUrl, customModel, customLanguage, customPrompt],
  persist,
)

function normalizePresetList(values: unknown): string[] {
  return Array.isArray(values)
    ? Array.from(new Set(values.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).map(value => value.trim())))
    : []
}

function applyServerRow(row: SttProviderSettingsResponse) {
  if (row.provider === 'openai') {
    openaiModel.value = typeof row.settings.model === 'string' && row.settings.model.trim()
      ? row.settings.model
      : openaiModel.value
    openaiLanguage.value = typeof row.settings.language === 'string' ? row.settings.language : openaiLanguage.value
    openaiPrompt.value = typeof row.settings.prompt === 'string' ? row.settings.prompt : openaiPrompt.value
    openaiApiKeyPreview.value = row.secrets.apiKey || ''
    openaiHasApiKey.value = Boolean(row.secrets.apiKey)
    openaiApiKey.value = ''
  }

  if (row.provider === 'custom') {
    customBaseUrl.value = typeof row.settings.baseUrl === 'string' ? row.settings.baseUrl : customBaseUrl.value
    customBaseUrlPresets.value = normalizePresetList(row.settings.baseUrlPresets)
    customModel.value = typeof row.settings.model === 'string' && row.settings.model.trim()
      ? row.settings.model
      : customModel.value
    customLanguage.value = typeof row.settings.language === 'string' ? row.settings.language : customLanguage.value
    customPrompt.value = typeof row.settings.prompt === 'string' ? row.settings.prompt : customPrompt.value
    customApiKeyPreview.value = row.secrets.apiKey || ''
    customHasApiKey.value = Boolean(row.secrets.apiKey)
    customApiKey.value = ''
  }

}

function applyServerSttSettings(response: FetchSttSettingsResponse | SttProviderSettingsResponse[], authoritative = false) {
  if (authoritative) {
    resetServerBackedState()
  }
  const rows = Array.isArray(response) ? response : response.providers
  for (const row of rows) {
    applyServerRow(row)
  }
  if (!Array.isArray(response) && response.activeProvider) {
    provider.value = response.activeProvider
  }
}

async function loadServerSttSettings(force = false): Promise<void> {
  if (serverSettingsLoaded && !force) return
  if (serverSettingsPromise && !force) return serverSettingsPromise

  const generation = serverSettingsGeneration
  const promise = fetchSttSettings()
    .then(response => {
      if (generation !== serverSettingsGeneration) return
      applyServerSttSettings(response, true)
      serverSettingsLoaded = true
    })
    .finally(() => {
      if (serverSettingsPromise === promise) {
        serverSettingsPromise = null
      }
    })

  serverSettingsPromise = promise
  return promise
}

export function useSttSettings() {
  return {
    provider,
    openaiModel,
    openaiLanguage,
    openaiPrompt,
    openaiApiKey,
    openaiApiKeyPreview,
    openaiHasApiKey,
    customBaseUrl,
    customBaseUrlPresets,
    customModel,
    customLanguage,
    customPrompt,
    customApiKey,
    customApiKeyPreview,
    customHasApiKey,

    setProvider(value: SttProvider) { provider.value = value },
    setOpenaiModel(value: string) { openaiModel.value = value },
    setOpenaiLanguage(value: string) { openaiLanguage.value = value },
    setOpenaiPrompt(value: string) { openaiPrompt.value = value },
    setOpenaiApiKey(value: string) { openaiApiKey.value = value },
    setCustomBaseUrl(value: string) { customBaseUrl.value = value },
    setCustomBaseUrlPresets(values: string[]) { customBaseUrlPresets.value = normalizePresetList(values) },
    setCustomModel(value: string) { customModel.value = value },
    setCustomLanguage(value: string) { customLanguage.value = value },
    setCustomPrompt(value: string) { customPrompt.value = value },
    setCustomApiKey(value: string) { customApiKey.value = value },
    applyServerSttSettings,
    loadServerSttSettings,
    reset() {
      clearSttSettingsAuthState()
    },
  }
}
