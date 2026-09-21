<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { NDrawer, NDrawerContent, NForm, NFormItem, NInput, NSelect, NSlider, NButton, NSpace } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { VoiceApiConnection, VoiceApiSavePayload } from '@/types/voice-api'
import { VOICE_API_PRESETS } from '@/constants/voiceApiPresets'
import { DOUBAO_TTS_2_RESOURCE_ID, DOUBAO_TTS_VOICE_OPTIONS, doubaoTtsResourceForVoice } from '@/constants/doubaoTtsVoices'
import { EDGE_TTS_VOICE_OPTIONS } from '@/constants/edgeTtsVoices'
import { speedToEdgeRate, hzToEdgePitch } from '@/utils/ttsHelpers'
import { useVoiceSettings } from '@/composables/useVoiceSettings'

const props = defineProps<{
  connection: VoiceApiConnection | null
  show: boolean
}>()

const emit = defineEmits<{
  close: []
  save: [connection: VoiceApiConnection, payload: VoiceApiSavePayload]
}>()

const { t } = useI18n()
const voiceSettings = useVoiceSettings()

const loading = ref(false)
const formData = ref<Record<string, string | number | undefined>>({})
const apiKeyInput = ref('')
const mimoCloneAudioInput = ref<HTMLInputElement | null>(null)
const mimoCloneDataUri = ref('')
const mimoCloneFileName = ref('')
const mimoCloneFormat = ref<'mp3' | 'wav'>('wav')
const MIMO_CLONE_AUDIO_MAX_BYTES = 10 * 1024 * 1024
const MIMO_CLONE_AUDIO_ACCEPT = 'audio/mpeg,audio/mp3,audio/wav,.mp3,.wav'

const preset = computed(() =>
  props.connection ? VOICE_API_PRESETS.find(p => p.kind === props.connection!.kind && p.provider === props.connection!.provider && (p.baseUrl === props.connection!.baseUrl || !p.baseUrl)) : null
)

const capabilities = computed(() => preset.value?.capabilities || {})

function setField(key: string, value: string | number | null | undefined) {
  formData.value[key] = value ?? ''
}

function stringField(key: string): string {
  const value = formData.value[key]
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
}

function numberField(key: string, fallback = 0): number {
  const value = formData.value[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

watch(() => props.connection, (conn) => {
  if (conn) {
    formData.value = {
      ...conn.settings,
      model: conn.model || String(conn.settings.model || ''),
      voice: conn.voice || String(conn.settings.voice || ''),
    }
    if (conn.provider === 'edge') {
      formData.value.rate = numberField('rate', 1.0)
      formData.value.pitch = numberField('pitch', 0)
    }
    apiKeyInput.value = ''
    if (conn.provider === 'mimo') {
      mimoCloneDataUri.value = voiceSettings.mimoVoiceCloneDataUri.value
      mimoCloneFileName.value = voiceSettings.mimoVoiceCloneFileName.value
      mimoCloneFormat.value = voiceSettings.mimoVoiceCloneFormat.value
    }
  }
}, { immediate: true })

function inferCloneAudioFormat(file: File): 'mp3' | 'wav' {
  const name = file.name.toLowerCase()
  return file.type.includes('mpeg') || file.type.includes('mp3') || name.endsWith('.mp3') ? 'mp3' : 'wav'
}

function readFileAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('Failed to read audio file'))
    reader.readAsDataURL(file)
  })
}

async function handleMimoCloneAudioChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  const lowerName = file.name.toLowerCase()
  const validType = file.type === 'audio/wav'
    || file.type === 'audio/x-wav'
    || file.type === 'audio/mpeg'
    || file.type === 'audio/mp3'
    || lowerName.endsWith('.wav')
    || lowerName.endsWith('.mp3')
  if (!validType || file.size > MIMO_CLONE_AUDIO_MAX_BYTES) {
    input.value = ''
    return
  }

  try {
    const format = inferCloneAudioFormat(file)
    const dataUri = await readFileAsDataUri(file)
    const mimeType = format === 'mp3' ? 'audio/mpeg' : 'audio/wav'
    mimoCloneDataUri.value = dataUri.replace(/^data:[^;,]*;base64,/, `data:${mimeType};base64,`)
    mimoCloneFileName.value = file.name
    mimoCloneFormat.value = format
  } finally {
    input.value = ''
  }
}

function clearMimoCloneAudio() {
  mimoCloneDataUri.value = ''
  mimoCloneFileName.value = ''
  mimoCloneFormat.value = 'wav'
  if (mimoCloneAudioInput.value) mimoCloneAudioInput.value.value = ''
}

async function handleSave() {
  if (!props.connection) return

  loading.value = true
  try {
    const apiKey = apiKeyInput.value.trim()
    const settings: Record<string, unknown> = { ...formData.value }
    if (props.connection.provider === 'mimo') {
      const model = stringField('model')
      settings.voiceMode = model === 'mimo-v2.5-tts-voiceclone'
        ? 'voiceClone'
        : model === 'mimo-v2.5-tts-voicedesign' ? 'voiceDesign' : 'preset'
      if (model === 'mimo-v2.5-tts-voiceclone') {
        // These fields are consumed client-side by useVoiceApiConnections and
        // deliberately omitted from the server's small settings payload.
        settings.voiceCloneDataUri = mimoCloneDataUri.value
        settings.voiceCloneFileName = mimoCloneFileName.value
        settings.voiceCloneFormat = mimoCloneFormat.value
      }
    }
    emit('save', props.connection, {
      settings,
      ...(apiKey ? { secrets: { apiKey } } : {}),
    })
  } finally {
    loading.value = false
  }
}

const edgeVoiceOptions = EDGE_TTS_VOICE_OPTIONS.map(option => ({ label: option.label, value: option.value }))

const openaiVoiceOptions = [
  { label: 'Alloy', value: 'alloy' },
  { label: 'Echo', value: 'echo' },
  { label: 'Fable', value: 'fable' },
  { label: 'Nova', value: 'nova' },
  { label: 'Onyx', value: 'onyx' },
  { label: 'Shimmer', value: 'shimmer' },
]

const mimoVoiceOptions = [
  { label: '冰糖 (中文·女)', value: '冰糖' },
  { label: '茉莉 (中文·女)', value: '茉莉' },
  { label: '苏打 (中文·男)', value: '苏打' },
  { label: '白桦 (中文·男)', value: '白桦' },
]

const mimoModelOptions = [
  { label: t('settings.voice.mimoModelPreset'), value: 'mimo-v2.5-tts' },
  { label: t('settings.voice.mimoModelVoiceDesign'), value: 'mimo-v2.5-tts-voicedesign' },
  { label: t('settings.voice.mimoModelVoiceClone'), value: 'mimo-v2.5-tts-voiceclone' },
]

const doubaoModelOptions = [
  { label: 'Seed TTS 2.0', value: DOUBAO_TTS_2_RESOURCE_ID },
]

const doubaoVoiceOptions = computed(() => {
  const current = stringField('voice').trim()
  const presetOptions = DOUBAO_TTS_VOICE_OPTIONS.map(option => ({
    label: option.label,
    value: option.value,
  }))
  if (current && !DOUBAO_TTS_VOICE_OPTIONS.some(option => option.value === current)) {
    return [{ label: current, value: current }, ...presetOptions]
  }
  return presetOptions
})

const sttAudioTranscodeOptions = computed(() => [
  { label: t('settings.voice.sttAudioTranscodeNone'), value: 'none' },
  { label: t('settings.voice.sttAudioTranscodeFfmpeg'), value: 'ffmpeg' },
])
const booleanOptions = computed(() => [
  { label: t('settings.voice.optionDisabled'), value: 'false' },
  { label: t('settings.voice.optionEnabled'), value: 'true' },
])

function handleDoubaoVoiceUpdate(value: string) {
  setField('voice', value)
  setField('model', doubaoTtsResourceForVoice(value) || DOUBAO_TTS_2_RESOURCE_ID)
}
</script>

<template>
  <NDrawer :show="show" :width="400" @update:show="emit('close')">
    <NDrawerContent :title="connection?.label" closable>
      <NForm label-placement="top" v-if="connection">
        <NFormItem v-if="!connection.isBuiltin" :label="t('settings.voice.apiKey')">
          <NInput
            v-model:value="apiKeyInput"
            type="password"
            show-password-on="click"
            autocomplete="off"
            :placeholder="connection.hasSecret ? t('settings.voice.keepStoredKeyPlaceholder') : t('settings.voice.apiKeyPlaceholder')"
          />
        </NFormItem>

        <NFormItem :label="t('settings.voice.model')" v-if="capabilities.models">
          <NSelect
            v-if="connection.provider === 'mimo'"
            :value="stringField('model')"
            :options="mimoModelOptions"
            @update:value="value => setField('model', value)"
          />
          <NSelect
            v-else-if="connection.provider === 'doubao'"
            :value="stringField('model') || DOUBAO_TTS_2_RESOURCE_ID"
            :options="doubaoModelOptions"
            tag
            filterable
            @update:value="value => setField('model', value)"
          />
          <NInput
            v-else
            :value="stringField('model')"
            :placeholder="t('models.selectOrInput')"
            @update:value="value => setField('model', value)"
          />
        </NFormItem>

        <NFormItem :label="t('settings.voice.voice')" v-if="capabilities.voices">
          <NSelect
            v-if="connection.provider === 'edge'"
            :value="stringField('voice')"
            :options="edgeVoiceOptions"
            tag
            filterable
            @update:value="value => setField('voice', value)"
          />
          <NSelect
            v-else-if="connection.provider === 'openai'"
            :value="stringField('voice')"
            :options="openaiVoiceOptions"
            @update:value="value => setField('voice', value)"
          />
          <NSelect
            v-else-if="connection.provider === 'mimo' && stringField('model') === 'mimo-v2.5-tts'"
            :value="stringField('voice')"
            :options="mimoVoiceOptions"
            @update:value="value => setField('voice', value)"
          />
          <NSelect
            v-else-if="connection.provider === 'doubao'"
            :value="stringField('voice')"
            :options="doubaoVoiceOptions"
            tag
            filterable
            @update:value="handleDoubaoVoiceUpdate"
          />
          <NInput
            v-else
            :value="stringField('voice')"
            @update:value="value => setField('voice', value)"
          />
        </NFormItem>

        <template v-if="connection.provider === 'edge'">
          <NFormItem :label="t('settings.voice.edgeRate')">
            <NSpace vertical style="width: 100%">
              <NSlider
                :value="numberField('rate', 1)"
                :min="0.5"
                :max="2.0"
                :step="0.05"
                @update:value="value => setField('rate', Array.isArray(value) ? value[0] : value)"
              />
              <span style="font-size: 12px; opacity: 0.6">{{ numberField('rate', 1).toFixed(2) }}x ({{ speedToEdgeRate(numberField('rate', 1)) }})</span>
            </NSpace>
          </NFormItem>
          <NFormItem :label="t('settings.voice.edgePitch')">
            <NSpace vertical style="width: 100%">
              <NSlider
                :value="numberField('pitch', 0)"
                :min="-20"
                :max="20"
                :step="1"
                @update:value="value => setField('pitch', Array.isArray(value) ? value[0] : value)"
              />
              <span style="font-size: 12px; opacity: 0.6">{{ numberField('pitch', 0) > 0 ? '+' : '' }}{{ numberField('pitch', 0) }} Hz ({{ hzToEdgePitch(numberField('pitch', 0)) }})</span>
            </NSpace>
          </NFormItem>
        </template>

        <template v-if="connection.provider === 'mimo'">
          <NFormItem :label="t('settings.voice.mimoStylePrompt')" v-if="capabilities.stylePrompt">
            <NInput :value="stringField('stylePrompt')" type="textarea" :rows="2" @update:value="value => setField('stylePrompt', value)" />
          </NFormItem>
          <NFormItem :label="t('settings.voice.mimoVoiceDesignPrompt')" v-if="stringField('model') === 'mimo-v2.5-tts-voicedesign'">
            <NInput :value="stringField('voiceDesignDesc')" type="textarea" :rows="3" @update:value="value => setField('voiceDesignDesc', value)" />
          </NFormItem>
          <NFormItem :label="t('settings.voice.mimoCloneAudio')" v-if="stringField('model') === 'mimo-v2.5-tts-voiceclone'">
            <NSpace vertical style="width: 100%">
              <input
                ref="mimoCloneAudioInput"
                type="file"
                :accept="MIMO_CLONE_AUDIO_ACCEPT"
                style="display: none"
                @change="handleMimoCloneAudioChange"
              />
              <NSpace align="center">
                <NButton size="small" @click="mimoCloneAudioInput?.click()">
                  {{ t('settings.voice.mimoCloneAudioUpload') }}
                </NButton>
                <span v-if="mimoCloneFileName" style="font-size: 12px; opacity: 0.7">
                  {{ mimoCloneFileName }} · {{ mimoCloneFormat }}
                </span>
                <NButton v-if="mimoCloneDataUri" size="small" tertiary @click="clearMimoCloneAudio">
                  {{ t('settings.voice.mimoCloneAudioClear') }}
                </NButton>
              </NSpace>
              <span style="font-size: 12px; opacity: 0.6">{{ t('settings.voice.mimoCloneAudioHint') }}</span>
            </NSpace>
          </NFormItem>
        </template>

        <NFormItem
          v-if="connection.kind === 'tts' && capabilities.language"
          :label="t('settings.voice.sttLanguage')"
        >
          <NInput :value="stringField('language')" @update:value="value => setField('language', value)" />
        </NFormItem>

        <NFormItem v-if="capabilities.speed" :label="t('settings.voice.providerSpeed')">
          <NInput :value="stringField('speed')" @update:value="value => setField('speed', value)" />
        </NFormItem>

        <NFormItem v-if="capabilities.sampleRate" :label="t('settings.voice.providerSampleRate')">
          <NInput :value="stringField('sampleRate')" @update:value="value => setField('sampleRate', value)" />
        </NFormItem>

        <NFormItem v-if="capabilities.bitRate" :label="t('settings.voice.providerBitRate')">
          <NInput :value="stringField('bitRate')" @update:value="value => setField('bitRate', value)" />
        </NFormItem>

        <NFormItem v-if="capabilities.groupId" :label="t('settings.voice.providerGroupId')">
          <NInput :value="stringField('groupId')" @update:value="value => setField('groupId', value)" />
        </NFormItem>

        <NFormItem v-if="capabilities.volume" :label="t('settings.voice.providerVolume')">
          <NInput :value="stringField('volume')" @update:value="value => setField('volume', value)" />
        </NFormItem>

        <NFormItem v-if="capabilities.emotion" :label="t('settings.voice.providerEmotion')">
          <NInput :value="stringField('emotion')" @update:value="value => setField('emotion', value)" />
        </NFormItem>

        <template v-if="connection.kind === 'stt' && connection.provider !== 'browser'">
          <NFormItem :label="t('settings.voice.sttAudioTranscode')">
            <NSelect
              :value="stringField('audioTranscode') || 'none'"
              :options="sttAudioTranscodeOptions"
              @update:value="value => setField('audioTranscode', value)"
            />
          </NFormItem>
          <NFormItem :label="t('settings.voice.sttLanguage')">
            <NInput :value="stringField('language')" @update:value="value => setField('language', value)" />
          </NFormItem>
          <NFormItem :label="t('settings.voice.sttPrompt')">
            <NInput :value="stringField('prompt')" type="textarea" :rows="2" @update:value="value => setField('prompt', value)" />
          </NFormItem>
          <NFormItem v-if="capabilities.diarize" :label="t('settings.voice.providerDiarize')">
            <NSelect
              :value="stringField('diarize') || 'false'"
              :options="booleanOptions"
              @update:value="value => setField('diarize', value)"
            />
          </NFormItem>
          <NFormItem v-if="capabilities.format" :label="t('settings.voice.providerFormatText')">
            <NSelect
              :value="stringField('format') || 'true'"
              :options="booleanOptions"
              @update:value="value => setField('format', value)"
            />
          </NFormItem>
          <NFormItem v-if="capabilities.tagAudioEvents" :label="t('settings.voice.providerTagAudioEvents')">
            <NSelect
              :value="stringField('tagAudioEvents') || 'false'"
              :options="booleanOptions"
              @update:value="value => setField('tagAudioEvents', value)"
            />
          </NFormItem>
        </template>
      </NForm>

      <template #footer>
        <NSpace justify="end">
          <NButton @click="emit('close')">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="loading" @click="handleSave">{{ t('common.save') }}</NButton>
        </NSpace>
      </template>
    </NDrawerContent>
  </NDrawer>
</template>
