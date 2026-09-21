<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NModal, NForm, NFormItem, NInput, NButton, NSelect, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { probeVoiceProvider, type VoiceProviderProbeModel } from '@/api/studio/voice-provider-probe'
import { VOICE_API_PRESETS } from '@/constants/voiceApiPresets'
import { DOUBAO_TTS_2_RESOURCE_ID, DOUBAO_TTS_DEFAULT_VOICE, DOUBAO_TTS_VOICE_OPTIONS, doubaoTtsResourceForVoice } from '@/constants/doubaoTtsVoices'
import type { VoiceApiKind, VoiceApiProviderCompatibility } from '@/types/voice-api'

const props = defineProps<{
  kind: VoiceApiKind
  show: boolean
}>()

const emit = defineEmits<{
  close: []
  saved: [payload: {
    preset: typeof VOICE_API_PRESETS[number]
    settings: Record<string, string>
    secrets: Record<string, string>
  }]
}>()

const { t } = useI18n()
const message = useMessage()

const loading = ref(false)
const selectedPresetId = ref<string | null>(null)
const compatibility = ref<VoiceApiProviderCompatibility>('openai-compatible')
const formData = ref({
  baseUrl: '',
  apiKey: '',
  model: '',
  voice: '',
  audioTranscode: 'none',
})

const modelManuallyEdited = ref(false)
const modelTouched = ref(false)
const baseUrlTouched = ref(false)
const apiKeyTouched = ref(false)
const probeLoading = ref(false)
const probeModels = ref<VoiceProviderProbeModel[]>([])
const probeRecommendedModel = ref('')
const probeErrorSummary = ref('')
const probeErrorDetails = ref('')
const showProbeDetails = ref(false)
const lastBlurProbeKey = ref('')
let probeAbort: AbortController | null = null
let probeSeq = 0
let suppressProbeReset = false

const presetOptions = computed(() =>
  VOICE_API_PRESETS
    .filter(p => p.kind === props.kind && !p.isBuiltin)
    .map(p => ({ label: p.labelKey ? t(p.labelKey) : p.label, value: p.id })),
)

const selectedPreset = computed(() =>
  VOICE_API_PRESETS.find(p => p.id === selectedPresetId.value) || null,
)

const isCustomProvider = computed(() => selectedPreset.value?.provider === 'custom')
const isDoubaoTtsPreset = computed(() => props.kind === 'tts' && selectedPreset.value?.provider === 'doubao')
const canProbeModels = computed(() => compatibility.value === 'openai-compatible')
const modelOptions = computed(() => {
  const discovered = probeModels.value.map(model => ({
    label: model.capability === 'preferred' ? `${model.label} · ${t('settings.voice.modelRecommendedSuffix')}` : model.label,
    value: model.id,
  }))
  const current = formData.value.model.trim()
  if (current && !discovered.some(option => option.value === current)) {
    return [{ label: current, value: current }, ...discovered]
  }
  return discovered
})
const sttAudioTranscodeOptions = computed(() => [
  { label: t('settings.voice.sttAudioTranscodeNone'), value: 'none' },
  { label: t('settings.voice.sttAudioTranscodeFfmpeg'), value: 'ffmpeg' },
])
const doubaoVoiceOptions = computed(() => {
  const current = formData.value.voice.trim()
  const presetOptions = DOUBAO_TTS_VOICE_OPTIONS.map(option => ({
    label: option.label,
    value: option.value,
  }))
  if (current && !DOUBAO_TTS_VOICE_OPTIONS.some(option => option.value === current)) {
    return [{ label: current, value: current }, ...presetOptions]
  }
  return presetOptions
})

const normalizedBaseUrl = computed(() => normalizeBaseUrl(formData.value.baseUrl))
const baseUrlError = computed(() => {
  if (!baseUrlTouched.value && !formData.value.baseUrl.trim()) return ''
  if (!selectedPreset.value || !selectedPreset.value.isSecretRequired) return ''
  return validateBaseUrl(formData.value.baseUrl)
})
const modelError = computed(() => {
  if (!selectedPreset.value?.capabilities?.models) return ''
  if (!modelTouched.value) return ''
  return formData.value.model.trim() ? '' : t('settings.voice.modelRequiredConnectManual')
})
const apiKeyError = computed(() => {
  if (!apiKeyTouched.value || !selectedPreset.value?.isSecretRequired) return ''
  return formData.value.apiKey.trim() ? '' : t('settings.voice.apiKeyRequired')
})
const canConnect = computed(() => {
  return !!selectedPreset.value &&
    canProbeModels.value &&
    !!formData.value.baseUrl.trim() &&
    !!formData.value.apiKey.trim() &&
    !validateBaseUrl(formData.value.baseUrl)
})
const canSave = computed(() => {
  if (!selectedPreset.value) return false
  if (selectedPreset.value.isSecretRequired) {
    if (!formData.value.apiKey.trim()) return false
    if (validateBaseUrl(formData.value.baseUrl)) return false
  }
  if (selectedPreset.value.capabilities?.models && !formData.value.model.trim()) return false
  if (isDoubaoTtsPreset.value && !formData.value.voice.trim()) return false
  return true
})
const connectHelpText = computed(() => {
  if (!selectedPreset.value) return ''
  if (compatibility.value === 'manual') {
    return t('settings.voice.discoveryManualHint')
  }
  if (!formData.value.baseUrl.trim() || !formData.value.apiKey.trim()) {
    return t('settings.voice.discoveryCredentialHint')
  }
  return t('settings.voice.discoveryNoAutoProbeHint')
})

watch(() => props.show, (show) => {
  if (show) resetForm()
  else cancelProbe()
})

watch([() => formData.value.baseUrl, () => formData.value.apiKey, compatibility], () => {
  if (suppressProbeReset) {
    suppressProbeReset = false
    return
  }
  cancelProbe()
  probeModels.value = []
  probeRecommendedModel.value = ''
  probeErrorSummary.value = ''
  probeErrorDetails.value = ''
  showProbeDetails.value = false
})

onBeforeUnmount(() => cancelProbe())

function resetForm() {
  selectedPresetId.value = null
  compatibility.value = 'openai-compatible'
  formData.value = { baseUrl: '', apiKey: '', model: '', voice: '', audioTranscode: 'none' }
  modelManuallyEdited.value = false
  modelTouched.value = false
  baseUrlTouched.value = false
  apiKeyTouched.value = false
  lastBlurProbeKey.value = ''
  probeModels.value = []
  probeRecommendedModel.value = ''
  probeErrorSummary.value = ''
  probeErrorDetails.value = ''
  showProbeDetails.value = false
  cancelProbe()
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  try {
    const url = new URL(trimmed)
    url.hash = ''
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    return url.toString().replace(/\/$/, '')
  } catch {
    return trimmed.replace(/\/+$/, '')
  }
}

function validateBaseUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return t('settings.voice.baseUrlRequired')
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return t('settings.voice.baseUrlHttpsRequired')
    }
    return ''
  } catch {
    return t('settings.voice.baseUrlInvalid')
  }
}

function cancelProbe() {
  if (probeAbort) {
    probeAbort.abort()
    probeAbort = null
  }
  probeLoading.value = false
}

function handlePresetChange(id: string) {
  selectedPresetId.value = id
  const preset = VOICE_API_PRESETS.find(p => p.id === id)
  compatibility.value = preset?.compatibility ||
    (preset?.provider === 'custom' || preset?.provider === 'openai' ? 'openai-compatible' : 'manual')
  const isDoubaoTts = props.kind === 'tts' && preset?.provider === 'doubao'
  formData.value = {
    baseUrl: preset?.baseUrl || '',
    model: isDoubaoTts ? DOUBAO_TTS_2_RESOURCE_ID : (preset?.defaultModel || ''),
    voice: isDoubaoTts ? DOUBAO_TTS_DEFAULT_VOICE : (preset?.defaultVoice || ''),
    apiKey: '',
    audioTranscode: 'none',
  }
  modelManuallyEdited.value = false
  modelTouched.value = false
  baseUrlTouched.value = false
  apiKeyTouched.value = false
  lastBlurProbeKey.value = ''
}

function handleModelUpdate(value: string) {
  formData.value.model = value || ''
  modelManuallyEdited.value = true
  modelTouched.value = true
}

function handleDoubaoVoiceUpdate(value: string) {
  formData.value.voice = value || ''
  formData.value.model = doubaoTtsResourceForVoice(value) || DOUBAO_TTS_2_RESOURCE_ID
  modelTouched.value = true
  modelManuallyEdited.value = false
}

function applyRecommendedModel() {
  if (!probeRecommendedModel.value) return
  formData.value.model = probeRecommendedModel.value
  modelTouched.value = true
  modelManuallyEdited.value = false
}

function updateBaseUrlOnBlur() {
  baseUrlTouched.value = true
  if (!validateBaseUrl(formData.value.baseUrl)) {
    formData.value.baseUrl = normalizedBaseUrl.value
  }
}

function probeKey() {
  return `${props.kind}|${selectedPreset.value?.provider || ''}|${compatibility.value}|${normalizeBaseUrl(formData.value.baseUrl)}|${formData.value.apiKey.trim()}`
}

async function maybeProbeOnApiKeyBlur() {
  apiKeyTouched.value = true
  if (!canConnect.value) return
  const key = probeKey()
  if (lastBlurProbeKey.value === key) return
  lastBlurProbeKey.value = key
  await handleProbe()
}

async function handleProbe() {
  if (!selectedPreset.value || !canProbeModels.value) return

  baseUrlTouched.value = true
  apiKeyTouched.value = true
  const validationError = validateBaseUrl(formData.value.baseUrl)
  if (validationError) {
    probeErrorSummary.value = validationError
    return
  }
  if (!formData.value.apiKey.trim()) {
    probeErrorSummary.value = t('settings.voice.apiKeyRequiredForDiscovery')
    return
  }

  cancelProbe()
  const seq = ++probeSeq
  const controller = new AbortController()
  probeAbort = controller
  probeLoading.value = true
  probeErrorSummary.value = ''
  probeErrorDetails.value = ''
  showProbeDetails.value = false

  try {
    const result = await probeVoiceProvider({
      kind: props.kind,
      provider: String(selectedPreset.value.provider),
      compatibility: compatibility.value,
      baseUrl: normalizeBaseUrl(formData.value.baseUrl),
      apiKey: formData.value.apiKey.trim(),
      signal: controller.signal,
    })
    if (seq !== probeSeq) return

    if (result.normalizedBaseUrl) {
      suppressProbeReset = true
      formData.value.baseUrl = result.normalizedBaseUrl
    }
    probeModels.value = result.models || []
    probeRecommendedModel.value = result.recommendedModel || ''
    probeErrorSummary.value = result.ok ? '' : (result.errorSummary || t('settings.voice.discoveryFailedManualFallback'))
    probeErrorDetails.value = result.errorDetails || ''

    if (result.ok && result.recommendedModel && !modelManuallyEdited.value && !formData.value.model.trim()) {
      formData.value.model = result.recommendedModel
      modelTouched.value = true
    }
  } catch (error) {
    if (controller.signal.aborted || seq !== probeSeq) return
    probeErrorSummary.value = error instanceof Error ? error.message : t('settings.voice.discoveryFailedManualFallback')
    probeErrorDetails.value = ''
  } finally {
    if (seq === probeSeq) {
      probeLoading.value = false
      probeAbort = null
    }
  }
}

async function handleSave() {
  if (!selectedPreset.value) return
  baseUrlTouched.value = true
  apiKeyTouched.value = true
  modelTouched.value = true

  if (!canSave.value) {
    message.warning(modelError.value || baseUrlError.value || apiKeyError.value || t('settings.voice.completeRequiredProviderFields'))
    return
  }

  loading.value = true
  try {
    emit('saved', {
      preset: selectedPreset.value,
      settings: {
        baseUrl: normalizeBaseUrl(formData.value.baseUrl),
        model: formData.value.model.trim(),
        ...(props.kind === 'tts' && formData.value.voice.trim() ? { voice: formData.value.voice.trim() } : {}),
        ...(props.kind === 'stt' ? { audioTranscode: formData.value.audioTranscode } : {}),
      },
      secrets: {
        apiKey: formData.value.apiKey.trim(),
      },
    })
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    :title="kind === 'tts' ? t('settings.voice.addTtsApi') : t('settings.voice.addSttApi')"
    :style="{ width: 'min(540px, calc(100vw - 32px))' }"
    @update:show="emit('close')"
  >
    <NForm label-placement="top" class="provider-form">
      <section class="form-section">
        <NFormItem :label="t('models.selectProvider')" required>
          <NSelect
            v-model:value="selectedPresetId"
            :options="presetOptions"
            :placeholder="t('models.chooseProvider')"
            data-testid="voice-provider-select"
            @update:value="handlePresetChange"
          />
        </NFormItem>

        <NFormItem v-if="selectedPreset && isCustomProvider" :label="t('settings.voice.apiCompatibility')" required>
          <NSelect
            v-model:value="compatibility"
            :options="[
              { label: t('settings.voice.openaiCompatible'), value: 'openai-compatible' },
              { label: t('settings.voice.manualCustomEndpoint'), value: 'manual' },
            ]"
            data-testid="voice-provider-compatibility"
          />
        </NFormItem>
      </section>

      <template v-if="selectedPreset">
        <section class="form-section">
          <div class="section-heading">
            <span>{{ t('settings.voice.connectionStep') }}</span>
            <small>{{ connectHelpText }}</small>
          </div>

          <NFormItem :label="t('models.baseUrl')" :required="selectedPreset.isSecretRequired" :feedback="baseUrlError">
            <NInput
              v-model:value="formData.baseUrl"
              :placeholder="t('models.baseUrlPlaceholder')"
              :disabled="!!selectedPreset.baseUrl && selectedPreset.provider !== 'custom'"
              data-testid="voice-provider-base-url"
              @blur="updateBaseUrlOnBlur"
            />
          </NFormItem>

          <NFormItem :label="t('models.apiKey')" :required="selectedPreset.isSecretRequired" :feedback="apiKeyError">
            <NInput
              v-model:value="formData.apiKey"
              type="password"
              show-password-on="click"
              autocomplete="off"
              :placeholder="selectedPreset.isSecretRequired ? t('settings.voice.apiKeyConnectPlaceholder') : t('models.apiKeyPlaceholder')"
              data-testid="voice-provider-api-key"
              @blur="maybeProbeOnApiKeyBlur"
            />
          </NFormItem>

          <div v-if="canProbeModels" class="connection-actions">
            <NButton
              size="small"
              :loading="probeLoading"
              :disabled="!canConnect"
              data-testid="voice-provider-probe"
              @click="handleProbe"
            >
              {{ t('settings.voice.connectFetchModels') }}
            </NButton>
          </div>

          <div v-if="probeErrorSummary" class="inline-error" data-testid="voice-provider-probe-error">
            <span>{{ probeErrorSummary }}</span>
            <button v-if="probeErrorDetails" type="button" class="link-button" @click="showProbeDetails = !showProbeDetails">
              {{ showProbeDetails ? t('settings.voice.hideDetails') : t('settings.voice.showDetails') }}
            </button>
            <pre v-if="showProbeDetails && probeErrorDetails">{{ probeErrorDetails }}</pre>
          </div>
        </section>

        <section v-if="selectedPreset.capabilities?.models" class="form-section">
          <div class="section-heading">
            <span>{{ t('settings.voice.model') }}</span>
            <small>{{ t('settings.voice.modelConnectManualHint') }}</small>
          </div>

          <NFormItem :label="t('models.defaultModel')" :feedback="modelError">
            <NSelect
              :value="formData.model"
              :options="modelOptions"
              tag
              filterable
              :loading="probeLoading"
              :placeholder="t('settings.voice.modelConnectManualHint')"
              data-testid="voice-provider-model"
              @update:value="handleModelUpdate"
            />
          </NFormItem>

          <div v-if="probeLoading" class="helper-text">{{ t('settings.voice.fetchingModels') }}</div>
          <div v-else-if="probeRecommendedModel && modelManuallyEdited && formData.model !== probeRecommendedModel" class="helper-text">
            {{ t('settings.voice.recommendedModel', { model: probeRecommendedModel }) }}
            <button type="button" class="link-button" @click="applyRecommendedModel">{{ t('settings.voice.useRecommendedModel') }}</button>
          </div>
          <div v-else-if="probeModels.length" class="helper-text">{{ t('settings.voice.modelsDiscovered', { count: probeModels.length }) }}</div>
          <div v-else-if="probeErrorSummary" class="helper-text">{{ t('settings.voice.discoveryFailedManualFallback') }}</div>
        </section>

        <section v-if="kind === 'tts' && selectedPreset.capabilities?.voices" class="form-section">
          <div class="section-heading">
            <span>{{ t('settings.voice.voice') }}</span>
            <small>{{ t('settings.voice.doubaoVoiceHint') }}</small>
          </div>

          <NFormItem :label="t('settings.voice.voice')">
            <NSelect
              v-if="isDoubaoTtsPreset"
              v-model:value="formData.voice"
              :options="doubaoVoiceOptions"
              tag
              filterable
              data-testid="voice-provider-voice"
              @update:value="handleDoubaoVoiceUpdate"
            />
            <NInput
              v-else
              v-model:value="formData.voice"
              data-testid="voice-provider-voice"
            />
          </NFormItem>
        </section>

        <section v-if="kind === 'stt'" class="form-section">
          <NFormItem :label="t('settings.voice.sttAudioTranscode')">
            <NSelect
              v-model:value="formData.audioTranscode"
              :options="sttAudioTranscodeOptions"
              data-testid="voice-provider-audio-transcode"
            />
          </NFormItem>
        </section>
      </template>
    </NForm>

    <template #footer>
      <div class="modal-footer">
        <NButton @click="emit('close')">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="loading" :disabled="!canSave" data-testid="voice-provider-save" @click="handleSave">
          {{ t('common.add') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.provider-form {
  display: grid;
  gap: 14px;
}

.form-section {
  display: grid;
  gap: 10px;
}

.form-section + .form-section {
  padding-top: 12px;
  border-top: 1px solid var(--n-border-color, rgba(0, 0, 0, 0.08));
}

.section-heading {
  display: grid;
  gap: 2px;
  font-weight: 600;
}

.section-heading small,
.helper-text {
  color: var(--n-text-color-3, #8a8f98);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.4;
}

.connection-actions {
  display: flex;
  justify-content: flex-start;
}

.inline-error {
  display: grid;
  gap: 6px;
  color: var(--n-error-color, #d03050);
  font-size: 12px;
  line-height: 1.4;
}

.inline-error pre {
  max-height: 120px;
  margin: 0;
  padding: 8px;
  overflow: auto;
  white-space: pre-wrap;
  color: inherit;
  background: rgba(208, 48, 80, 0.06);
  border-radius: 6px;
}

.link-button {
  padding: 0;
  color: var(--n-primary-color, #18a058);
  background: transparent;
  border: 0;
  cursor: pointer;
  font: inherit;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
