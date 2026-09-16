// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, nextTick, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'

const STT_STORAGE_KEY = 'hermes-stt-settings-v1'

const mockFetchSttSettings = vi.fn()
const mockSaveSttSettings = vi.fn()
const mockSaveActiveSttProvider = vi.fn()
const mockClearSttSecret = vi.fn()
const mockDeleteSttProvider = vi.fn()
const mockDeleteSttBaseUrlPreset = vi.fn()
const mockTranscribeSpeech = vi.fn()
const mockFetchLocalSttModelStatus = vi.fn()
const mockDownloadLocalSttModel = vi.fn()
const mockFetchTtsSettings = vi.fn()
const mockSaveTtsSettings = vi.fn()
const mockSaveActiveTtsProvider = vi.fn()
const mockClearTtsSecret = vi.fn()
const mockDeleteTtsProvider = vi.fn()
const mockDeleteTtsBaseUrlPreset = vi.fn()
const mockFetchProviderModels = vi.fn()
const mockProbeVoiceProvider = vi.fn()
const mockSpeechStop = vi.fn()
const mockSpeakViaBrowser = vi.fn()
const mockOpenaiPlay = vi.fn()
const mockMimoPlay = vi.fn()
const mockMicRecorderState = ref<any>({ status: 'idle', error: null, startedAt: null, mimeType: null })
const mockMicStart = vi.fn()
const mockMicStop = vi.fn()

const translations: Record<string, string> = {
  'settings.voice.activeTtsApi': 'Active TTS API',
  'settings.voice.activeSttApi': 'Active STT API',
  'settings.voice.addTtsApi': 'Add TTS API',
  'settings.voice.addSttApi': 'Add STT API',
  'settings.voice.builtin': 'Built-in',
  'settings.voice.source': 'Source',
  'settings.voice.model': 'Model',
  'settings.voice.voice': 'Voice',
  'settings.voice.apiKey': 'API key',
  'settings.voice.connected': 'Connected',
  'settings.voice.active': 'Active',
  'settings.voice.lastTest': 'Last test',
  'settings.voice.notTested': '—',
  'settings.voice.recording': 'Recording',
  'settings.voice.testFailedShort': 'Failed',
  'settings.voice.testFailedSummary': 'Test failed. Check provider settings and try again.',
  'settings.voice.showDetails': 'Show details',
  'settings.voice.hideDetails': 'Hide details',
  'settings.voice.moreActions': 'More',
  'settings.voice.moreActionsFor': 'More actions for {provider}',
  'common.edit': 'Edit',
  'settings.voice.ttsProvidersTitle': 'TTS providers',
  'settings.voice.ttsProvidersDescription': 'Manage text-to-speech integrations used to play assistant responses and voice previews.',
  'settings.voice.sttProvidersTitle': 'STT providers',
  'settings.voice.sttProvidersDescription': 'Manage speech-to-text integrations used by the microphone and voice input flow.',
  'settings.voice.localSttModelTitle': 'Local Chinese-English STT',
  'settings.voice.localSttModelDescription': 'Private on-device recognition.',
  'settings.voice.localSttModelUnavailable': 'Download and validate the local STT model first.',
  'settings.voice.localSttModelReady': 'Ready',
  'settings.voice.localSttModelDownloading': 'Downloading',
  'settings.voice.localSttModelNotInstalled': 'Not installed',
  'settings.voice.localSttLanguages': 'Languages',
  'settings.voice.localSttLanguagesValue': 'Chinese + English',
  'settings.voice.localSttDownloadSize': 'Download size',
  'settings.voice.localSttRuntime': 'Runtime',
  'settings.voice.localSttDownloadCf': 'Cloudflare download',
  'settings.voice.localSttDownloadGithub': 'GitHub download',
  'settings.voice.localSttBackgroundHint': 'Runs in the background.',
  'settings.voice.localSttDownloadFailed': 'Download failed: {error}',
  'settings.voice.localSttStage.queued': 'Waiting to download…',
  'settings.voice.localSttStage.resolve': 'Preparing download…',
  'settings.voice.localSttStage.download': 'Downloading model…',
  'settings.voice.localSttStage.verify': 'Verifying checksum…',
  'settings.voice.localSttStage.extract': 'Extracting model…',
  'settings.voice.localSttStage.validate': 'Validating model…',
  'settings.voice.localSttStage.install': 'Installing model…',
  'settings.voice.localSttStage.completed': 'Model is ready',
  'settings.voice.localSttStage.failed': 'Download failed',
  'settings.voice.noneSelected': 'None selected',
  'settings.voice.keyStored': 'Stored',
  'settings.voice.keyMissing': 'Missing',
  'settings.voice.customApi': 'API',
  'settings.voice.localBuiltin': 'Local built-in',
  'settings.voice.ttsCardHint': 'Speech synthesis provider',
  'settings.voice.sttCardHint': 'Speech transcription provider',
  'settings.voice.setActive': 'Set active',
  'settings.voice.testAction': 'Test',
  'settings.voice.connect': 'Connect',
  'settings.voice.presetEdgeTtsLabel': 'Edge TTS',
  'settings.voice.presetEdgeTtsDescription': 'Free high-quality cloud voices from Microsoft Edge.',
  'settings.voice.presetOpenaiTtsLabel': 'OpenAI TTS',
  'settings.voice.presetMimoTtsLabel': 'MiMo TTS',
  'settings.voice.presetCustomTtsLabel': 'Custom TTS',
  'settings.voice.presetBrowserSttLabel': 'Browser STT',
  'settings.voice.presetBrowserSttDescription': 'Native browser speech recognition API.',
  'settings.voice.presetOpenaiWhisperLabel': 'OpenAI Whisper',
  'settings.voice.presetGroqSttLabel': 'Groq STT',
  'settings.voice.presetCustomSttLabel': 'Custom STT',
  'settings.voice.apiCompatibility': 'API compatibility',
  'settings.voice.openaiCompatible': 'OpenAI-compatible',
  'settings.voice.manualCustomEndpoint': 'Manual custom endpoint',
  'settings.voice.connectionStep': 'Connection',
  'settings.voice.discoveryManualHint': 'Manual custom endpoint selected. Model discovery is not available; enter the model name manually.',
  'settings.voice.discoveryCredentialHint': 'Enter Base URL and API key, then connect to fetch available models.',
  'settings.voice.discoveryNoAutoProbeHint': 'No requests are sent while typing. Use Connect when the credentials are ready.',
  'settings.voice.apiKeyConnectPlaceholder': 'Paste API key to connect; stored keys are never shown',
  'settings.voice.connectFetchModels': 'Connect & fetch models',
  'settings.voice.modelRecommendedSuffix': 'recommended',
  'settings.voice.modelConnectManualHint': 'Connect to auto-fill, or enter manually.',
  'settings.voice.modelRequiredConnectManual': 'Model is required. Connect to auto-fill, or enter manually.',
  'settings.voice.apiKeyRequired': 'API key is required.',
  'settings.voice.apiKeyRequiredForDiscovery': 'API key is required to fetch models.',
  'settings.voice.baseUrlRequired': 'Base URL is required.',
  'settings.voice.baseUrlHttpsRequired': 'Use https:// unless the endpoint is localhost.',
  'settings.voice.baseUrlInvalid': 'Enter a valid Base URL, including https://.',
  'settings.voice.discoveryFailedManualFallback': 'Could not fetch models. You can still enter the model name manually.',
  'settings.voice.completeRequiredProviderFields': 'Complete the required provider fields before saving.',
  'settings.voice.fetchingModels': 'Fetching models…',
  'settings.voice.recommendedModel': 'Recommended: {model}.',
  'settings.voice.useRecommendedModel': 'Use this.',
  'settings.voice.modelsDiscovered': '{count} models discovered. Recommended model is selected when the field is empty.',
  'settings.voice.remove': 'Remove',
  'settings.voice.testSuccess': 'Test completed',
  'settings.voice.testTextRequired': 'Enter text before testing.',
  'settings.voice.keyMissingForTest': 'Add an API key before testing this provider.',
  'settings.voice.testing': 'Testing…',
  'settings.voice.transcribing': 'Transcribing…',
  'settings.voice.browserSttTestHint': 'Browser STT is tested from the chat microphone.',
  'settings.voice.sttEmptyAudio': 'No audio was captured. Try again.',
  'settings.voice.sttTestSuccess': 'Transcription completed',
  'settings.voice.sttRecordingHint': 'Recording… click Stop to transcribe.',
  'settings.voice.keepStoredKeyPlaceholder': 'Leave blank to keep the stored key',
  'settings.voice.apiKeyPlaceholder': 'Enter API key',
  'settings.voice.ttsTestSaved': 'Audition succeeded; TTS settings saved on the server',
  'settings.voice.ttsTestSaving': 'Saving TTS settings before audition…',
  'settings.voice.ttsMissingBaseUrl': 'Base URL is required before testing. Enter a provider endpoint, then test again.',
  'settings.voice.ttsMissingApiKey': 'API key is required before testing. Paste the key, or save a stored server key first.',
  'settings.voice.testFailed': 'Test failed: {error}',
  'settings.voice.testTextDefault': 'Hello, this is a voice test.',
  'settings.voice.ttsProvider': 'TTS Provider',
  'settings.voice.ttsProviderHint': 'Choose the text-to-speech engine for message playback',
  'settings.voice.providerWebSpeech': 'WebSpeech API (Browser)',
  'settings.voice.providerOpenai': 'OpenAI TTS',
  'settings.voice.providerCustom': 'Custom Endpoint (OpenAI-compatible)',
  'settings.voice.providerEdge': 'Edge TTS (Free, no API Key)',
  'settings.voice.providerMimo': 'MiMo TTS',
  'settings.voice.webspeechVoice': 'Voice',
  'settings.voice.webspeechVoiceHint': 'Select a voice from your browser or OS',
  'settings.voice.webspeechVoicePlaceholder': 'Auto (default voice)',
  'settings.voice.testTitle': 'Test Voice',
  'settings.voice.testTextPlaceholder': 'Enter text to test...',
  'settings.voice.testButton': 'Test',
  'settings.voice.testButtonPlaying': 'Playing...',
  'settings.voice.sttTitle': 'Speech-to-text',
  'settings.voice.sttProvider': 'STT Provider',
  'settings.voice.sttProviderHint': 'Choose how voice input is transcribed',
  'settings.voice.sttProviderBrowser': 'Browser',
  'settings.voice.sttProviderOpenai': 'OpenAI-compatible',
  'settings.voice.sttProviderCustom': 'Custom',
  'settings.voice.sttBrowserHint': 'Use built-in browser speech recognition when available.',
  'settings.voice.sttApiKey': 'API Key',
  'settings.voice.sttApiKeyHint': 'Stored server-side for STT providers that require authentication.',
  'settings.voice.sttStoredSecret': 'Stored server key: {value}',
  'settings.voice.sttPendingSecret': 'Stored server key: will be updated on save',
  'settings.voice.sttClearKey': 'Clear stored key',
  'settings.voice.sttModel': 'Model',
  'settings.voice.sttModelHint': 'Speech-to-text model to use.',
  'settings.voice.sttLanguage': 'Language',
  'settings.voice.sttLanguageHint': 'Optional language hint such as en or zh.',
  'settings.voice.sttPrompt': 'Prompt',
  'settings.voice.sttPromptHint': 'Optional transcription prompt.',
  'settings.voice.sttBaseUrl': 'Base URL',
  'settings.voice.sttBaseUrlHint': 'Custom OpenAI-compatible speech-to-text endpoint.',
  'settings.voice.sttSave': 'Save STT settings',
  'settings.voice.sttSaveActive': 'Save active STT provider',
  'settings.voice.sttActiveSaved': 'Active STT provider saved on server.',
  'settings.voice.sttEndpointHint': 'Final transcription endpoint: {endpoint}',
  'settings.voice.sttTestButton': 'Test STT API',
  'settings.voice.sttTestStopButton': 'Stop and transcribe',
  'settings.voice.sttTestBackendOnly': 'STT API test is available for OpenAI-compatible and Custom providers.',
  'settings.voice.sttTestRecording': 'Recording test sample… click Stop and transcribe when done.',
  'settings.voice.sttTestTranscribing': 'Transcribing test sample…',
  'settings.voice.sttTestEmpty': 'No audio was captured for the STT test.',
  'settings.voice.sttTestSucceeded': 'STT test succeeded.',
  'settings.voice.sttTestFailed': 'STT test failed: {error} — {hint}',
  'settings.voice.sttFailureHintMissingConfig': 'Check that the provider is saved with a base URL/model and an API key before testing.',
  'settings.voice.sttFailureHintAuth': 'Check the API key. If a key was already stored, paste the current key again and save before testing.',
  'settings.voice.sttFailureHintForbidden': 'The key reached the provider but does not have permission for this STT model or account. Check provider access/billing.',
  'settings.voice.sttFailureHintEndpointModel': 'Check the Base URL and model. For Groq, use {endpoint} with whisper-large-v3-turbo or another Groq STT model.',
  'settings.voice.sttFailureHintModel': 'Check that the selected STT model exists and is enabled for this account.',
  'settings.voice.sttFailureHintQuota': 'The provider reports quota, billing, or rate-limit trouble. Check account quota/billing or retry later.',
  'settings.voice.sttFailureHintNetworkCustom': 'The server could not reach the custom STT endpoint. Check that {endpoint} is reachable from the Web UI server and is OpenAI-compatible.',
  'settings.voice.sttFailureHintNetwork': 'The Web UI server could not reach the STT provider. Check network/proxy/firewall and retry.',
  'settings.voice.sttFailureHintAudio': 'The recorded audio was empty or rejected. Try a short clear sample, allow microphone access, or retry in Chrome.',
  'settings.voice.sttFailureHintGenericCustom': 'Check API key, Base URL, model, and the final endpoint {endpoint}.',
  'settings.voice.sttFailureHintGeneric': 'Check API key, model, and provider account access, then retry.',
  'settings.voice.sttTestRecordFailed': 'Could not start microphone recording: {error}',
  'settings.voice.sttTestTranscript': 'Transcript: {text}',
  'settings.voice.sttSaved': 'STT settings saved on server.',
  'settings.voice.sttSaveFailed': 'Failed to save STT settings.',
  'settings.voice.sttCleared': 'Stored STT secret cleared from server.',
  'settings.voice.sttClearFailed': 'Failed to clear stored STT secret.',
  'settings.voice.storedBaseUrlsTitle': 'Stored Base URLs',
  'settings.voice.storedBaseUrlsHint': 'Saved voice provider endpoints. Field-level inputs only clear the current value; delete saved endpoints here.',
  'settings.voice.storedBaseUrlsEmpty': 'No custom voice Base URLs are saved on the server.',
  'settings.voice.storedBaseUrlDelete': 'Delete URL',
  'settings.voice.storedApiKeysTitle': 'Stored API keys',
  'settings.voice.storedApiKeysHint': 'Masked list of server-stored voice API keys. Only provider/source is shown; raw keys are never displayed.',
  'settings.voice.storedApiKeysEmpty': 'No voice API keys are stored on the server.',
  'settings.voice.storedKeyKindTts': 'TTS',
  'settings.voice.storedKeyKindStt': 'STT',
  'settings.voice.storedApiKeyMasked': '[stored]',
  'settings.voice.storedApiKeyDelete': 'Delete key',
  'settings.voice.baseUrlPresetClear': 'Clear URL',
  'settings.voice.baseUrlPresetCleared': 'Base URL cleared from the field.',
  'settings.voice.baseUrlPresetDelete': 'Delete URL',
  'settings.voice.baseUrlPresetDeleted': 'Base URL removed from saved list.',
  'settings.voice.baseUrlPresetDeleteFailed': 'Failed to remove saved Base URL.',
}

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) => {
      const template = translations[key] ?? key
      return params
        ? template.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? '')
        : template
    },
  }),
}))

vi.mock('naive-ui', () => ({
  useMessage: () => ({
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
  NCard: defineComponent({
    name: 'NCard',
    inheritAttrs: false,
    template: '<section v-bind="$attrs"><header><slot name="header" /></header><main><slot /></main><footer><slot name="action" /></footer></section>',
  }),
  NTag: defineComponent({
    name: 'NTag',
    inheritAttrs: false,
    template: '<span v-bind="$attrs"><slot /></span>',
  }),
  NTooltip: defineComponent({
    name: 'NTooltip',
    inheritAttrs: false,
    template: '<span><slot name="trigger" /><slot /></span>',
  }),
  NPopconfirm: defineComponent({
    name: 'NPopconfirm',
    inheritAttrs: false,
    emits: ['positive-click'],
    template: '<span><span @click="$emit(\'positive-click\')"><slot name="trigger" /></span><slot /></span>',
  }),
  NDropdown: defineComponent({
    name: 'NDropdown',
    inheritAttrs: false,
    props: { options: { type: Array as () => Array<{ label: string; key: string; disabled?: boolean }>, default: () => [] } },
    emits: ['select'],
    template: '<span><slot /><button v-for="option in options" :key="option.key" type="button" :disabled="option.disabled" :data-testid="`dropdown-option-${option.key}`" @click="$emit(\'select\', option.key)">{{ option.label }}</button></span>',
  }),
  NModal: defineComponent({
    name: 'NModal',
    inheritAttrs: false,
    props: { show: { type: Boolean, default: false } },
    emits: ['update:show'],
    template: '<div v-if="show" v-bind="$attrs"><slot /><slot name="footer" /></div>',
  }),
  NDrawer: defineComponent({
    name: 'NDrawer',
    inheritAttrs: false,
    props: { show: { type: Boolean, default: false } },
    emits: ['update:show'],
    template: '<div v-if="show" v-bind="$attrs"><slot /></div>',
  }),
  NDrawerContent: defineComponent({
    name: 'NDrawerContent',
    inheritAttrs: false,
    template: '<div v-bind="$attrs"><slot /><slot name="footer" /></div>',
  }),
  NForm: defineComponent({
    name: 'NForm',
    inheritAttrs: false,
    template: '<form v-bind="$attrs"><slot /></form>',
  }),
  NFormItem: defineComponent({
    name: 'NFormItem',
    inheritAttrs: false,
    props: { label: { type: String, default: '' } },
    template: '<label v-bind="$attrs"><span>{{ label }}</span><slot /></label>',
  }),
  NSpace: defineComponent({
    name: 'NSpace',
    inheritAttrs: false,
    template: '<div v-bind="$attrs"><slot /></div>',
  }),
  NGrid: defineComponent({
    name: 'NGrid',
    inheritAttrs: false,
    template: '<div v-bind="$attrs"><slot /></div>',
  }),
  NGridItem: defineComponent({
    name: 'NGridItem',
    inheritAttrs: false,
    template: '<div v-bind="$attrs"><slot /></div>',
  }),
  NCheckbox: defineComponent({
    name: 'NCheckbox',
    inheritAttrs: false,
    props: {
      checked: { type: Boolean, default: false },
    },
    emits: ['update:checked'],
    template: `<label v-bind="$attrs"><input type="checkbox" :checked="checked" @change="$emit('update:checked', $event.target.checked)" /><slot /></label>`,
  }),
  NSwitch: defineComponent({
    name: 'NSwitch',
    inheritAttrs: false,
    props: { value: { type: Boolean, default: false } },
    emits: ['update:value'],
    template: `<button type="button" v-bind="$attrs" :data-value="String(value)" @click="$emit('update:value', !value)"></button>`,
  }),
  NInputNumber: defineComponent({
    name: 'NInputNumber',
    inheritAttrs: false,
    props: { value: { type: Number, default: 0 } },
    emits: ['update:value'],
    template: `<input type="number" v-bind="$attrs" :value="value" @input="$emit('update:value', Number($event.target.value))" />`,
  }),
  NPopover: defineComponent({
    name: 'NPopover',
    inheritAttrs: false,
    template: `<div v-bind="$attrs"><slot name="trigger" /><slot /></div>`,
  }),
  NRadioGroup: defineComponent({
    name: 'NRadioGroup',
    inheritAttrs: false,
    props: { value: { type: [String, Number], default: '' } },
    emits: ['update:value'],
    template: `<div v-bind="$attrs"><slot /></div>`,
  }),
  NRadioButton: defineComponent({
    name: 'NRadioButton',
    inheritAttrs: false,
    props: { value: { type: [String, Number], default: '' } },
    template: `<label v-bind="$attrs"><slot /></label>`,
  }),
  NDataTable: defineComponent({
    name: 'NDataTable',
    inheritAttrs: false,
    props: { data: { type: Array as () => unknown[], default: () => [] } },
    template: `<table v-bind="$attrs"><tbody><tr v-for="(row, i) in data" :key="i"><td><slot :row="row" /></td></tr></tbody></table>`,
  }),
  NEmpty: defineComponent({
    name: 'NEmpty',
    inheritAttrs: false,
    template: `<div v-bind="$attrs"><slot /></div>`,
  }),
  NSkeleton: defineComponent({
    name: 'NSkeleton',
    inheritAttrs: false,
    template: `<div v-bind="$attrs"></div>`,
  }),
  NSpin: defineComponent({
    name: 'NSpin',
    inheritAttrs: false,
    template: `<div v-bind="$attrs"><slot /></div>`,
  }),
  NStatistic: defineComponent({
    name: 'NStatistic',
    inheritAttrs: false,
    props: {
      label: { type: String, default: '' },
      value: { type: [String, Number], default: '' },
    },
    template: `<div v-bind="$attrs"><span class="mock-stat-label">{{ label }}</span><span class="mock-stat-value">{{ value }}</span></div>`,
  }),
  NSelect: defineComponent({
    name: 'NSelect',
    inheritAttrs: false,
    props: {
      value: { type: [String, Number], default: '' },
      options: { type: Array as () => Array<{ label: string; value: string }>, default: () => [] },
      size: { type: String, default: '' },
    },
    emits: ['update:value'],
    template: `
      <div class="mock-select">
        <input v-bind="$attrs" :value="value" @input="$emit('update:value', $event.target.value)" />
        <span v-for="option in options" :key="option.value" class="mock-select-option">{{ option.label }}</span>
      </div>
    `,
  }),
  NInput: defineComponent({
    name: 'NInput',
    inheritAttrs: false,
    props: {
      value: { type: String, default: '' },
      placeholder: { type: String, default: '' },
      type: { type: String, default: 'text' },
      rows: { type: Number, default: 2 },
      size: { type: String, default: '' },
    },
    emits: ['update:value'],
    template: `
      <textarea
        v-if="type === 'textarea'"
        v-bind="$attrs"
        :rows="rows"
        :placeholder="placeholder"
        :value="value"
        @input="$emit('update:value', $event.target.value)"
      />
      <input
        v-else
        v-bind="$attrs"
        :type="type"
        :placeholder="placeholder"
        :value="value"
        @input="$emit('update:value', $event.target.value)"
      />
    `,
  }),
  NButton: defineComponent({
    name: 'NButton',
    inheritAttrs: false,
    props: {
      size: { type: String, default: '' },
      type: { type: String, default: '' },
      loading: { type: Boolean, default: false },
    },
    emits: ['click'],
    template: '<button type="button" v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>',
  }),
  NProgress: defineComponent({
    name: 'NProgress',
    inheritAttrs: false,
    props: { percentage: { type: Number, default: 0 } },
    template: '<progress v-bind="$attrs" :value="percentage" max="100" />',
  }),
  NSlider: defineComponent({
    name: 'NSlider',
    inheritAttrs: false,
    props: {
      value: { type: Number, default: 0 },
      min: { type: Number, default: 0 },
      max: { type: Number, default: 100 },
      step: { type: Number, default: 1 },
      size: { type: String, default: '' },
    },
    emits: ['update:value'],
    template: `
      <input
        v-bind="$attrs"
        type="range"
        :min="min"
        :max="max"
        :step="step"
        :value="value"
        @input="$emit('update:value', Number($event.target.value))"
      />
    `,
  }),
}))

vi.mock('@/api/studio/stt-settings', () => ({
  fetchSttSettings: mockFetchSttSettings,
  saveSttSettings: mockSaveSttSettings,
  saveActiveSttProvider: mockSaveActiveSttProvider,
  clearSttSecret: mockClearSttSecret,
  deleteSttProvider: mockDeleteSttProvider,
  deleteSttBaseUrlPreset: mockDeleteSttBaseUrlPreset,
}))

vi.mock('@/api/studio/stt', () => ({
  transcribeSpeech: mockTranscribeSpeech,
}))

vi.mock('@/api/studio/local-stt-model', () => ({
  fetchLocalSttModelStatus: mockFetchLocalSttModelStatus,
  downloadLocalSttModel: mockDownloadLocalSttModel,
}))

vi.mock('@/composables/usePcmStreamRecorder', () => ({
  usePcmStreamRecorder: () => ({
    status: ref(mockMicRecorderState.value.status),
    error: ref(null),
    level: ref(0),
    stream: ref(null),
    isRecording: ref(mockMicRecorderState.value.status === 'recording'),
    start: mockMicStart,
    stop: mockMicStop,
    cancel: vi.fn(),
  }),
}))

vi.mock('@/api/studio/tts-settings', () => ({
  fetchTtsSettings: mockFetchTtsSettings,
  saveTtsSettings: mockSaveTtsSettings,
  saveActiveTtsProvider: mockSaveActiveTtsProvider,
  clearTtsSecret: mockClearTtsSecret,
  deleteTtsProvider: mockDeleteTtsProvider,
  deleteTtsBaseUrlPreset: mockDeleteTtsBaseUrlPreset,
  // VoiceSettings mounts SpeechPreprocessingSection, which loads/saves this on mount
  fetchSpeechPreprocessing: vi.fn().mockResolvedValue({ enabled: false }),
  saveSpeechPreprocessing: vi.fn().mockResolvedValue({ enabled: false }),
}))

vi.mock('@/api/hermes/system', () => ({
  fetchProviderModels: mockFetchProviderModels,
}))

vi.mock('@/api/studio/voice-provider-probe', () => ({
  probeVoiceProvider: mockProbeVoiceProvider,
}))

vi.mock('@/composables/useSpeech', () => ({
  useSpeech: () => ({
    stop: mockSpeechStop,
    speakViaBrowser: mockSpeakViaBrowser,
    openaiPlay: mockOpenaiPlay,
    mimoPlay: mockMimoPlay,
  }),
}))

function createVoiceSettingsMock() {
  return {
    provider: ref('webspeech'),
    webspeechVoice: ref(''),
    loadServerTtsSettings: vi.fn().mockResolvedValue(undefined),
    applyServerTtsSettings: vi.fn(),
    setProvider(value: string) { this.provider.value = value },
    setWebSpeechVoice(value: string) { this.webspeechVoice.value = value },

    openaiApiKey: ref(''),
    openaiApiKeyPreview: ref(''),
    openaiHasApiKey: ref(false),
    openaiBaseUrl: ref(''),
    openaiModel: ref('tts-1'),
    openaiVoice: ref('alloy'),
    setOpenaiApiKey(value: string) { this.openaiApiKey.value = value },
    setOpenaiBaseUrl(value: string) { this.openaiBaseUrl.value = value },
    setOpenaiModel(value: string) { this.openaiModel.value = value },
    setOpenaiVoice(value: string) { this.openaiVoice.value = value },

    customUrl: ref(''),
    customApiKey: ref(''),
    customApiKeyPreview: ref(''),
    customHasApiKey: ref(false),
    setCustomUrl(value: string) { this.customUrl.value = value },
    setCustomApiKey(value: string) { this.customApiKey.value = value },

    edgeVoice: ref('zh-CN-XiaoxiaoNeural'),
    edgeRate: ref(1),
    edgePitchHz: ref(0),
    setEdgeVoice(value: string) { this.edgeVoice.value = value },
    setEdgeRate(value: number) { this.edgeRate.value = value },
    setEdgePitchHz(value: number) { this.edgePitchHz.value = value },

    mimoApiKey: ref(''),
    mimoApiKeyPreview: ref(''),
    mimoHasApiKey: ref(false),
    mimoHasVoiceCloneData: ref(false),
    mimoAuthMode: ref('bearer'),
    mimoBaseUrl: ref('https://api.xiaomimimo.com/v1'),
    mimoModel: ref('mimo-v2.5-tts'),
    mimoVoice: ref('冰糖'),
    mimoVoiceDesignDesc: ref(''),
    mimoVoiceCloneDataUri: ref(''),
    mimoVoiceCloneFileName: ref(''),
    mimoVoiceCloneFormat: ref<'mp3' | 'wav'>('wav'),
    mimoStylePrompt: ref(''),
    setMimoApiKey(value: string) { this.mimoApiKey.value = value },
    setMimoAuthMode(value: string) { this.mimoAuthMode.value = value },
    setMimoBaseUrl(value: string) { this.mimoBaseUrl.value = value },
    setMimoModel(value: string) { this.mimoModel.value = value },
    setMimoVoice(value: string) { this.mimoVoice.value = value },
    setMimoVoiceDesignDesc(value: string) { this.mimoVoiceDesignDesc.value = value },
    setMimoVoiceCloneDataUri(value: string) { this.mimoVoiceCloneDataUri.value = value },
    setMimoVoiceCloneFileName(value: string) { this.mimoVoiceCloneFileName.value = value },
    setMimoVoiceCloneFormat(value: 'mp3' | 'wav') { this.mimoVoiceCloneFormat.value = value },
    setMimoStylePrompt(value: string) { this.mimoStylePrompt.value = value },
  }
}

let voiceSettingsMock = createVoiceSettingsMock()

vi.mock('@/composables/useVoiceSettings', () => ({
  useVoiceSettings: () => voiceSettingsMock,
}))

function installSpeechRecognition() {
  class MockSpeechRecognition {}
  vi.stubGlobal('SpeechRecognition', MockSpeechRecognition)
  ;(window as any).SpeechRecognition = MockSpeechRecognition
}

function removeSpeechRecognition() {
  vi.unstubAllGlobals()
  delete (window as any).SpeechRecognition
  delete (window as any).webkitSpeechRecognition
}

function installSpeechSynthesis() {
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      getVoices: () => [],
      onvoiceschanged: null,
    },
  })
}

async function importVoiceSettingsComponent() {
  const mod = await import('../../packages/client/src/components/hermes/settings/VoiceSettings.vue')
  return mod.default
}

describe('useSttSettings', () => {
  beforeEach(() => {
    vi.resetModules()
    mockFetchSttSettings.mockReset()
    mockSaveSttSettings.mockReset()
    mockSaveActiveSttProvider.mockReset()
    mockClearSttSecret.mockReset()
    mockDeleteSttProvider.mockReset()
    mockDeleteSttBaseUrlPreset.mockReset()
    mockTranscribeSpeech.mockReset()
    mockFetchLocalSttModelStatus.mockReset()
    mockDownloadLocalSttModel.mockReset()
    mockFetchLocalSttModelStatus.mockResolvedValue({
      id: 'local-model',
      name: 'Streaming Zipformer Chinese-English INT8',
      languages: ['zh', 'en'],
      archiveSize: 176344382,
      extractedSize: 199056205,
      installed: false,
      usable: false,
      validationError: '',
      job: null,
    })
    mockMicStart.mockReset()
    mockMicStop.mockReset()
    mockMicRecorderState.value = { status: 'idle', error: null, startedAt: null, mimeType: null }
    mockFetchTtsSettings.mockReset()
    mockSaveTtsSettings.mockReset()
    mockSaveActiveTtsProvider.mockReset()
    mockClearTtsSecret.mockReset()
    mockDeleteTtsProvider.mockReset()
    mockDeleteTtsBaseUrlPreset.mockReset()
    mockFetchProviderModels.mockReset()
    mockProbeVoiceProvider.mockReset()
    mockSpeechStop.mockReset()
    mockSpeakViaBrowser.mockReset()
    mockOpenaiPlay.mockReset()
    mockMimoPlay.mockReset()
    localStorage.clear()
    voiceSettingsMock = createVoiceSettingsMock()
    removeSpeechRecognition()
    installSpeechSynthesis()
  })

  it('defaults provider to browser when SpeechRecognition exists', async () => {
    installSpeechRecognition()

    const { useSttSettings } = await import('../../packages/client/src/composables/useSttSettings')
    const settings = useSttSettings()

    expect(settings.provider.value).toBe('browser')
  })

  it('defaults provider to openai when SpeechRecognition is unavailable', async () => {
    const { useSttSettings } = await import('../../packages/client/src/composables/useSttSettings')
    const settings = useSttSettings()

    expect(settings.provider.value).toBe('openai')
  })

  it('loads masked secret state from the server', async () => {
    mockFetchSttSettings.mockResolvedValue({
      providers: [
        {
          provider: 'openai',
          settings: { model: 'gpt-4o-transcribe', language: 'en', prompt: 'keep punctuation' },
          secrets: { apiKey: '[stored]' },
          updatedAt: 1,
        },
      ],
    })

    const { useSttSettings } = await import('../../packages/client/src/composables/useSttSettings')
    const settings = useSttSettings()
    await settings.loadServerSttSettings(true)

    expect(settings.openaiModel.value).toBe('gpt-4o-transcribe')
    expect(settings.openaiLanguage.value).toBe('en')
    expect(settings.openaiPrompt.value).toBe('keep punctuation')
    expect(settings.openaiApiKey.value).toBe('')
    expect(settings.openaiApiKeyPreview.value).toBe('[stored]')
    expect(settings.openaiHasApiKey.value).toBe(true)
  })

  it('authoritative empty hydration resets stale server-backed settings but keeps the local provider preference', async () => {
    localStorage.setItem(STT_STORAGE_KEY, JSON.stringify({
      provider: 'custom',
      openaiModel: 'stale-openai-model',
      openaiLanguage: 'fr',
      openaiPrompt: 'stale-openai-prompt',
      customBaseUrl: 'https://stale.example/v1',
      customModel: 'stale-custom-model',
      customLanguage: 'ja',
      customPrompt: 'stale-custom-prompt',
    }))
    mockFetchSttSettings.mockResolvedValue({ providers: [] })

    const { useSttSettings } = await import('../../packages/client/src/composables/useSttSettings')
    const settings = useSttSettings()

    settings.openaiApiKeyPreview.value = '[stored-openai]'
    settings.openaiHasApiKey.value = true
    settings.customApiKeyPreview.value = '[stored-custom]'
    settings.customHasApiKey.value = true
    settings.setOpenaiApiKey('pending-openai-secret')
    settings.setCustomApiKey('pending-custom-secret')

    await settings.loadServerSttSettings(true)

    expect(settings.provider.value).toBe('custom')
    expect(settings.openaiModel.value).toBe('gpt-4o-transcribe')
    expect(settings.openaiLanguage.value).toBe('')
    expect(settings.openaiPrompt.value).toBe('')
    expect(settings.customBaseUrl.value).toBe('')
    expect(settings.customModel.value).toBe('gpt-4o-transcribe')
    expect(settings.customLanguage.value).toBe('')
    expect(settings.customPrompt.value).toBe('')
    expect(settings.openaiApiKey.value).toBe('')
    expect(settings.openaiApiKeyPreview.value).toBe('')
    expect(settings.openaiHasApiKey.value).toBe(false)
    expect(settings.customApiKey.value).toBe('')
    expect(settings.customApiKeyPreview.value).toBe('')
    expect(settings.customHasApiKey.value).toBe(false)
  })

  it('authoritative partial hydration resets missing provider rows before applying returned server settings', async () => {
    localStorage.setItem(STT_STORAGE_KEY, JSON.stringify({
      provider: 'custom',
      openaiModel: 'stale-openai-model',
      openaiLanguage: 'fr',
      openaiPrompt: 'stale-openai-prompt',
      customBaseUrl: 'https://stale.example/v1',
      customModel: 'stale-custom-model',
      customLanguage: 'ja',
      customPrompt: 'stale-custom-prompt',
    }))
    mockFetchSttSettings.mockResolvedValue({
      providers: [
        {
          provider: 'openai',
          settings: {
            model: 'gpt-4o-mini-transcribe',
            language: 'en',
            prompt: 'keep punctuation',
          },
          secrets: { apiKey: '[stored]' },
          updatedAt: 1,
        },
      ],
    })

    const { useSttSettings } = await import('../../packages/client/src/composables/useSttSettings')
    const settings = useSttSettings()

    settings.customApiKeyPreview.value = '[stored-custom]'
    settings.customHasApiKey.value = true
    settings.setCustomApiKey('pending-custom-secret')

    await settings.loadServerSttSettings(true)

    expect(settings.provider.value).toBe('custom')
    expect(settings.openaiModel.value).toBe('gpt-4o-mini-transcribe')
    expect(settings.openaiLanguage.value).toBe('en')
    expect(settings.openaiPrompt.value).toBe('keep punctuation')
    expect(settings.openaiApiKey.value).toBe('')
    expect(settings.openaiApiKeyPreview.value).toBe('[stored]')
    expect(settings.openaiHasApiKey.value).toBe(true)
    expect(settings.customBaseUrl.value).toBe('')
    expect(settings.customModel.value).toBe('gpt-4o-transcribe')
    expect(settings.customLanguage.value).toBe('')
    expect(settings.customPrompt.value).toBe('')
    expect(settings.customApiKey.value).toBe('')
    expect(settings.customApiKeyPreview.value).toBe('')
    expect(settings.customHasApiKey.value).toBe(false)
  })

  it('persists non-secret preferences without storing raw api keys', async () => {
    const { useSttSettings } = await import('../../packages/client/src/composables/useSttSettings')
    const settings = useSttSettings()

    settings.setProvider('custom')
    settings.setCustomBaseUrl('https://custom.example/v1')
    settings.setCustomModel('whisper-large-v3')
    settings.setCustomLanguage('zh')
    settings.setCustomPrompt('preserve punctuation')
    settings.setCustomApiKey('raw-custom-secret')
    await nextTick()

    const raw = localStorage.getItem(STT_STORAGE_KEY) || '{}'
    expect(raw).toContain('https://custom.example/v1')
    expect(raw).toContain('whisper-large-v3')
    expect(raw).toContain('preserve punctuation')
    expect(raw).not.toContain('raw-custom-secret')
  })

  it('sanitizes unexpected raw secret fields out of localStorage on load', async () => {
    localStorage.setItem(STT_STORAGE_KEY, JSON.stringify({
      provider: 'custom',
      customBaseUrl: 'https://custom.example/v1',
      customModel: 'whisper-large-v3',
      apiKey: 'raw-root-secret',
      openaiApiKey: 'raw-openai-secret',
      customApiKey: 'raw-custom-secret',
      secrets: { apiKey: 'nested-secret' },
      nested: { openaiApiKey: 'deep-secret' },
    }))

    const { useSttSettings } = await import('../../packages/client/src/composables/useSttSettings')
    useSttSettings()
    await nextTick()

    const raw = localStorage.getItem(STT_STORAGE_KEY) || '{}'
    expect(raw).toContain('https://custom.example/v1')
    expect(raw).toContain('whisper-large-v3')
    expect(raw).not.toContain('raw-root-secret')
    expect(raw).not.toContain('raw-openai-secret')
    expect(raw).not.toContain('raw-custom-secret')
    expect(raw).not.toContain('nested-secret')
    expect(raw).not.toContain('deep-secret')
    expect(raw).not.toContain('"secrets"')
  })
})

describe('VoiceSettings STT UI', () => {
  beforeEach(() => {
    vi.resetModules()
    mockFetchSttSettings.mockReset()
    mockSaveSttSettings.mockReset()
    mockSaveActiveSttProvider.mockReset()
    mockClearSttSecret.mockReset()
    mockDeleteSttProvider.mockReset()
    mockDeleteSttBaseUrlPreset.mockReset()
    mockTranscribeSpeech.mockReset()
    mockFetchLocalSttModelStatus.mockReset()
    mockDownloadLocalSttModel.mockReset()
    mockFetchLocalSttModelStatus.mockResolvedValue({
      id: 'local-model',
      name: 'Streaming Zipformer Chinese-English INT8',
      languages: ['zh', 'en'],
      archiveSize: 176344382,
      extractedSize: 199056205,
      installed: false,
      usable: false,
      validationError: '',
      job: null,
    })
    mockMicStart.mockReset()
    mockMicStop.mockReset()
    mockMicRecorderState.value = { status: 'idle', error: null, startedAt: null, mimeType: null }
    mockFetchTtsSettings.mockReset()
    mockSaveTtsSettings.mockReset()
    mockSaveActiveTtsProvider.mockReset()
    mockClearTtsSecret.mockReset()
    mockDeleteTtsProvider.mockReset()
    mockDeleteTtsBaseUrlPreset.mockReset()
    mockFetchProviderModels.mockReset()
    mockSpeechStop.mockReset()
    mockSpeakViaBrowser.mockReset()
    mockOpenaiPlay.mockReset()
    mockMimoPlay.mockReset()
    localStorage.clear()
    voiceSettingsMock = createVoiceSettingsMock()
    removeSpeechRecognition()
    installSpeechSynthesis()
    mockFetchSttSettings.mockResolvedValue({ providers: [] })
    mockFetchTtsSettings.mockResolvedValue({ providers: [] })
    mockSaveActiveTtsProvider.mockResolvedValue('edge')
    mockSaveActiveSttProvider.mockResolvedValue('browser')
  })

  async function mountComponent(props?: { kind?: 'tts' | 'stt' | 'all' }) {
    const VoiceSettings = await importVoiceSettingsComponent()
    return mount(VoiceSettings, {
      props,
      global: {
        stubs: {
          SettingRow: defineComponent({
            name: 'SettingRow',
            props: {
              label: { type: String, default: '' },
              hint: { type: String, default: '' },
            },
            template: `
              <div class="setting-row">
                <div class="setting-row-label">{{ label }}</div>
                <div class="setting-row-hint">{{ hint }}</div>
                <div class="setting-row-content"><slot /></div>
              </div>
            `,
          }),
        },
      },
    })
  }

  it('renders card-based TTS/STT voice APIs with built-ins and masked stored secrets', async () => {
    mockFetchSttSettings.mockResolvedValue({
      activeProvider: 'custom',
      providers: [
        {
          provider: 'custom',
          settings: { baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' },
          secrets: { apiKey: '[stored]' },
          updatedAt: 3,
        },
      ],
    })
    mockFetchTtsSettings.mockResolvedValue({
      providers: [
        {
          provider: 'mimo',
          settings: { baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.5-tts', voice: '冰糖' },
          secrets: { apiKey: '[stored]' },
          updatedAt: 4,
        },
      ],
    })

    const wrapper = await mountComponent()
    await flushPromises()

    expect(wrapper.text()).toContain('Edge TTS')
    expect(wrapper.text()).toContain('Browser STT')
    expect(wrapper.text()).toContain('Local Chinese-English STT')
    expect(wrapper.text()).toContain('Cloudflare download')
    expect(wrapper.text()).toContain('GitHub download')
    expect(wrapper.text()).toContain('MiMo TTS')
    expect(wrapper.text()).toContain('Groq STT')
    expect(wrapper.text()).toContain('Stored')
    expect(wrapper.text()).not.toContain('raw-openai-secret')
    expect(wrapper.find('[data-testid="stt-provider-select"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="stt-custom-base-url"]').exists()).toBe(false)
  })

  it('starts the fixed local model download from the selected channel without blocking the card', async () => {
    mockDownloadLocalSttModel.mockResolvedValue({
      success: true,
      job: {
        id: 'local-job',
        source: 'cf',
        status: 'running',
        stage: 'download',
        error: '',
        percent: 25,
        receivedBytes: 44_086_095,
        totalBytes: 176_344_382,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    })
    mockFetchLocalSttModelStatus.mockImplementation(async () => ({
      id: 'local-model', name: 'Streaming Zipformer Chinese-English INT8', languages: ['zh', 'en'],
      archiveSize: 176344382, extractedSize: 199056205, installed: false, usable: false, validationError: '',
      job: mockDownloadLocalSttModel.mock.calls.length
        ? { id: 'local-job', source: 'cf', status: 'running', stage: 'download', error: '', percent: 25, receivedBytes: 44_086_095, totalBytes: 176_344_382, createdAt: '', updatedAt: '' }
        : null,
    }))

    const wrapper = await mountComponent({ kind: 'stt' })
    await flushPromises()
    await wrapper.get('[data-testid="local-stt-download-cf"]').trigger('click')
    await flushPromises()

    expect(mockDownloadLocalSttModel).toHaveBeenCalledWith('cf')
    expect(wrapper.find('progress').attributes('value')).toBe('25')
    expect(wrapper.text()).toContain('Runs in the background.')
    wrapper.unmount()
  })

  it('renders only the voice API kind selected by the Models page tab', async () => {
    const sttWrapper = await mountComponent({ kind: 'stt' })
    await flushPromises()

    expect(sttWrapper.text()).toContain('STT providers')
    expect(sttWrapper.text()).toContain('Browser STT')
    expect(sttWrapper.text()).not.toContain('TTS providers')
    expect(sttWrapper.text()).not.toContain('Edge TTS')

    sttWrapper.unmount()

    const ttsWrapper = await mountComponent({ kind: 'tts' })
    await flushPromises()

    expect(ttsWrapper.text()).toContain('TTS providers')
    expect(ttsWrapper.text()).toContain('Edge TTS')
    expect(ttsWrapper.text()).not.toContain('STT providers')
    expect(ttsWrapper.text()).not.toContain('Browser STT')
  })

  it('uses server active TTS provider instead of stale local voice settings', async () => {
    voiceSettingsMock.provider.value = 'edge'
    mockFetchTtsSettings.mockResolvedValue({
      activeProvider: 'doubao',
      providers: [
        {
          provider: 'doubao',
          settings: {
            baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
            model: 'seed-tts-2.0',
            voice: 'zh_female_xiaohe_uranus_bigtts',
          },
          secrets: { apiKey: '[stored]' },
          updatedAt: 4,
        },
      ],
    })
    mockSaveActiveTtsProvider.mockResolvedValue('edge')

    const wrapper = await mountComponent()
    await flushPromises()

    expect(wrapper.find('.active-summary').text()).toContain('Doubao')
    expect(wrapper.findAll('.voice-api-card').find(card => card.text().includes('Doubao'))?.text()).toContain('Active')

    await wrapper.findAll('.voice-api-card')
      .find(card => card.text().includes('Edge TTS'))!
      .findAll('button')
      .find(button => button.text().includes('Set active'))!
      .trigger('click')
    await flushPromises()

    expect(mockSaveActiveTtsProvider).toHaveBeenCalledWith('edge')
    expect(wrapper.find('.active-summary').text()).toContain('Edge TTS')
  })

  it('adds a Groq STT preset through the unified add API modal as a distinct usable provider', async () => {
    mockSaveSttSettings.mockResolvedValue({
      provider: 'custom',
      settings: { baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3' },
      secrets: { apiKey: '[stored]' },
      updatedAt: 5,
    })
    mockFetchSttSettings
      .mockResolvedValueOnce({ activeProvider: 'browser', providers: [] })
      .mockResolvedValue({
        activeProvider: 'custom',
        providers: [{
          provider: 'custom',
          settings: { baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3' },
          secrets: { apiKey: '[stored]' },
          updatedAt: 5,
        }],
      })

    const wrapper = await mountComponent()
    await flushPromises()

    await wrapper.findAll('button').find(button => button.text().includes('Add STT API'))!.trigger('click')
    await flushPromises()
    await wrapper.get('input[placeholder="models.chooseProvider"]').setValue('stt-groq')
    await flushPromises()
    await wrapper.get('input[type="password"]').setValue('raw-groq-secret')
    await wrapper.findAll('button').find(button => button.text().includes('common.add'))!.trigger('click')
    await flushPromises()

    expect(mockSaveSttSettings).toHaveBeenCalledWith('groq', expect.objectContaining({
      activeProvider: 'groq',
      settings: expect.objectContaining({
        baseUrl: 'https://api.groq.com/openai/v1',
        model: 'whisper-large-v3',
      }),
      secrets: { apiKey: 'raw-groq-secret' },
    }))
    expect(wrapper.text()).not.toContain('raw-groq-secret')
  })

  it('adds a Doubao STT preset through the unified add API modal', async () => {
    mockSaveSttSettings.mockResolvedValue({
      provider: 'doubao',
      settings: {
        baseUrl: 'https://openspeech.bytedance.com/api/v3/auc/bigmodel',
        model: 'volc.seedasr.auc',
        audioTranscode: 'ffmpeg',
      },
      secrets: { apiKey: '[stored]' },
      updatedAt: 6,
    })
    mockFetchSttSettings
      .mockResolvedValueOnce({ activeProvider: 'browser', providers: [] })
      .mockResolvedValue({
        activeProvider: 'doubao',
        providers: [{
          provider: 'doubao',
          settings: {
            baseUrl: 'https://openspeech.bytedance.com/api/v3/auc/bigmodel',
            model: 'volc.seedasr.auc',
            audioTranscode: 'ffmpeg',
          },
          secrets: { apiKey: '[stored]' },
          updatedAt: 6,
        }],
      })

    const wrapper = await mountComponent()
    await flushPromises()

    await wrapper.findAll('button').find(button => button.text().includes('Add STT API'))!.trigger('click')
    await flushPromises()
    await wrapper.get('input[placeholder="models.chooseProvider"]').setValue('stt-doubao')
    await flushPromises()
    await wrapper.get('input[type="password"]').setValue('raw-doubao-api-key')
    await wrapper.get('[data-testid="voice-provider-audio-transcode"]').setValue('ffmpeg')
    await wrapper.findAll('button').find(button => button.text().includes('common.add'))!.trigger('click')
    await flushPromises()

    expect(mockSaveSttSettings).toHaveBeenCalledWith('doubao', expect.objectContaining({
      activeProvider: 'doubao',
      settings: expect.objectContaining({
        baseUrl: 'https://openspeech.bytedance.com/api/v3/auc/bigmodel',
        model: 'volc.seedasr.auc',
        audioTranscode: 'ffmpeg',
      }),
      secrets: { apiKey: 'raw-doubao-api-key' },
    }))
    expect(wrapper.text()).not.toContain('raw-doubao-api-key')
  })

  it('uses connection-first discovery without typing spam or overwriting manual models', async () => {
    mockProbeVoiceProvider.mockResolvedValue({
      ok: true,
      models: [
        { id: 'gpt-4o-mini', label: 'gpt-4o-mini', capability: 'other' },
        { id: 'tts-1-hd', label: 'tts-1-hd', capability: 'preferred' },
      ],
      recommendedModel: 'tts-1-hd',
      manualModelAllowed: true,
      normalizedBaseUrl: 'https://custom.example/v1',
    })
    mockSaveTtsSettings.mockResolvedValue({
      provider: 'custom',
      settings: { baseUrl: 'https://custom.example/v1', model: 'my-manual-model' },
      secrets: { apiKey: '[stored]' },
      updatedAt: 11,
    })

    const wrapper = await mountComponent()
    await flushPromises()

    await wrapper.findAll('button').find(button => button.text().includes('Add TTS API'))!.trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="voice-provider-select"]').setValue('tts-custom')
    await flushPromises()

    expect(wrapper.text()).toContain('API compatibility')
    expect(wrapper.text()).toContain('Connection')
    expect(wrapper.text()).toContain('Model')

    await wrapper.get('[data-testid="voice-provider-base-url"]').setValue('https://custom.example/v1/')
    await wrapper.get('[data-testid="voice-provider-api-key"]').setValue('raw-custom-secret')
    await wrapper.get('[data-testid="voice-provider-model"]').setValue('my-manual-model')
    await flushPromises()

    expect(mockProbeVoiceProvider).not.toHaveBeenCalled()

    await wrapper.get('[data-testid="voice-provider-probe"]').trigger('click')
    await flushPromises()
    await nextTick()

    expect(mockProbeVoiceProvider).toHaveBeenCalledTimes(1)
    expect(mockProbeVoiceProvider).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'tts',
      provider: 'custom',
      compatibility: 'openai-compatible',
      baseUrl: 'https://custom.example/v1',
      apiKey: 'raw-custom-secret',
    }))
    expect(wrapper.text()).toContain('Recommended: tts-1-hd')
    expect((wrapper.get('[data-testid="voice-provider-model"]').element as HTMLInputElement).value).toBe('my-manual-model')

    await wrapper.findAll('button').find(button => button.text().includes('common.add'))!.trigger('click')
    await flushPromises()

    expect(mockSaveTtsSettings).toHaveBeenCalledWith('custom', expect.objectContaining({
      settings: expect.objectContaining({ baseUrl: 'https://custom.example/v1', model: 'my-manual-model' }),
      secrets: { apiKey: 'raw-custom-secret' },
    }))
  })

  it('deletes stored API keys from cards without exposing raw key values', async () => {
    mockFetchTtsSettings
      .mockResolvedValueOnce({
        providers: [{
          provider: 'mimo',
          settings: { baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.5-tts' },
          secrets: { apiKey: '[stored]' },
          updatedAt: 4,
        }],
      })
      .mockResolvedValue({ providers: [] })
    mockDeleteTtsProvider.mockResolvedValue({ success: true, deleted: true, activeProvider: null })

    const wrapper = await mountComponent()
    await flushPromises()

    expect(wrapper.text()).toContain('Stored')
    await wrapper.get('[data-testid="dropdown-option-remove"]').trigger('click')
    await flushPromises()

    expect(mockDeleteTtsProvider).toHaveBeenCalledWith('mimo')
    expect(wrapper.text()).not.toContain('raw-secret')
  })

  it('routes TTS test through the active card provider and settings', async () => {
    mockFetchTtsSettings.mockResolvedValue({
      providers: [{
        provider: 'mimo',
        settings: { baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.5-tts', voice: '冰糖' },
        secrets: { apiKey: '[stored]' },
        updatedAt: 8,
      }],
    })
    voiceSettingsMock.provider.value = 'mimo'

    const wrapper = await mountComponent()
    await flushPromises()

    await wrapper.get('[data-testid="voice-card-test-tts-mimo"]').trigger('click')
    await flushPromises()

    expect(mockMimoPlay).toHaveBeenCalledWith('tts-mimo', 'Hello, this is a voice test.', expect.objectContaining({
      baseUrl: 'https://api.xiaomimimo.com/v1',
      model: 'mimo-v2.5-tts',
      voice: '冰糖',
    }))
    expect(mockOpenaiPlay).not.toHaveBeenCalled()
  })

  it('records the STT card test as PCM WAV before transcription', async () => {
    const wav = new Blob([new Uint8Array(256)], { type: 'audio/wav' })
    mockMicStart.mockResolvedValue(undefined)
    mockMicStop.mockResolvedValue(wav)
    mockTranscribeSpeech.mockResolvedValue({
      text: 'WAV transcription succeeded',
      provider: 'openai',
      model: 'gpt-4o-transcribe',
      durationMs: 10,
    })
    mockFetchSttSettings.mockResolvedValue({
      activeProvider: 'openai',
      providers: [{
        provider: 'openai',
        settings: { model: 'gpt-4o-transcribe' },
        secrets: { apiKey: '[stored]' },
        updatedAt: 12,
      }],
    })

    const wrapper = await mountComponent()
    await flushPromises()

    const testButton = wrapper.get('[data-testid="voice-card-test-stt-openai"]')
    await testButton.trigger('click')
    await flushPromises()
    expect(mockMicStart).toHaveBeenCalledOnce()

    await testButton.trigger('click')
    await flushPromises()

    expect(mockTranscribeSpeech).toHaveBeenCalledWith({ audio: wav, provider: 'openai' })
    expect(wrapper.text()).toContain('WAV transcription succeeded')
  })

  it('shows missing-key and inline testing/error states on provider cards', async () => {
    let resolvePlay!: () => void
    mockOpenaiPlay.mockReturnValue(new Promise<void>(resolve => { resolvePlay = resolve }))
    mockFetchTtsSettings.mockResolvedValue({
      providers: [{
        provider: 'openai',
        settings: { baseUrl: 'https://api.openai.com/v1', model: 'tts-1', voice: 'alloy' },
        secrets: {},
        updatedAt: 9,
      }],
    })

    const wrapper = await mountComponent()
    await flushPromises()

    expect(wrapper.text()).toContain('Missing')
    expect(wrapper.text()).toContain('Connect')

    await wrapper.get('[data-testid="voice-card-test-tts-openai"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Add an API key before testing this provider.')

    mockFetchTtsSettings.mockResolvedValue({
      providers: [{
        provider: 'openai',
        settings: { baseUrl: 'https://api.openai.com/v1', model: 'tts-1', voice: 'alloy' },
        secrets: { apiKey: '[stored]' },
        updatedAt: 10,
      }],
    })
    await wrapper.get('[data-testid="voice-card-test-tts-edge"]').trigger('click')
    await nextTick()
    expect(wrapper.text()).toContain('Testing…')
    resolvePlay()
    await flushPromises()
    expect(wrapper.text()).toContain('Test completed')
  })
})
