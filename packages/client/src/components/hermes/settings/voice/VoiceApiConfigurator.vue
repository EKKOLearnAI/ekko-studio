<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { NDrawer, NDrawerContent, NForm, NFormItem, NInput, NSelect, NSlider, NButton, NSpace } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { VoiceApiConnection, VoiceApiSavePayload } from '@/types/voice-api'
import { VOICE_API_PRESETS } from '@/constants/voiceApiPresets'
import { DOUBAO_TTS_2_RESOURCE_ID, DOUBAO_TTS_VOICE_OPTIONS, doubaoTtsResourceForVoice } from '@/constants/doubaoTtsVoices'
import { EDGE_TTS_VOICE_OPTIONS } from '@/constants/edgeTtsVoices'
import { OPENROUTER_TTS_MODELS, OPENROUTER_DEFAULT_MODEL, openrouterModelRequiresVoice, openrouterVoiceSetForModel, openrouterModelSupportsCloning, OPENROUTER_CLONE_AUDIO_MAX_BYTES, OPENROUTER_CLONE_AUDIO_ACCEPT } from '@/constants/openrouterTtsVoices'
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

// #8 全场语速/音量：按 provider 决定是否显示与映射
//  - aliyun 官方无 speed/volume 数值参数 → 不显示
//  - edge 用 provider 自带的 rate/pitch 滑块（在下方），不在这里再放速度滑块
//  - 其他 provider 走全局档位 ttsSpeed/ttsVolume，由 useSpeech.applyTtsPreset 自动映射字段
const supportsGlobalSpeed = computed(() => {
  if (props.connection?.kind !== 'tts') return false
  const p = props.connection.provider
  return p !== 'aliyun' && p !== 'edge'
})
const supportsGlobalVolume = computed(() => {
  if (props.connection?.kind !== 'tts') return false
  const p = props.connection.provider
  // zhipu volume / siliconflow gain / minimax vol / fishaudio gain → 全部支持
  return p !== 'aliyun' && p !== 'edge' && p !== 'openai' && p !== 'custom' && p !== 'deepinfra' && p !== 'doubao'
})
function onTtsSpeed(v: number | null) { voiceSettings.setTtsSpeed(typeof v === 'number' ? v : 1.0) }
function onTtsVolume(v: number | null) { voiceSettings.setTtsVolume(typeof v === 'number' ? v : 1.0) }

const loading = ref(false)
const formData = ref<Record<string, string | number | undefined>>({})
const apiKeyInput = ref('')
const iflytekAppId = ref('')
const mimoCloneAudioInput = ref<HTMLInputElement | null>(null)
const mimoCloneDataUri = ref('')
const mimoCloneFileName = ref('')
const mimoCloneFormat = ref<'mp3' | 'wav'>('wav')
// OpenRouter stateless 声音克隆（参考音频每次合成随请求发送）
const openrouterCloneAudioInput = ref<HTMLInputElement | null>(null)
const openrouterCloneDataUri = ref('')
const openrouterCloneFileName = ref('')
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
    if (conn.provider === 'iflytek') {
      iflytekAppId.value = String(conn.settings?.appId || '')
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
    if (conn.provider === 'openrouter') {
      openrouterCloneDataUri.value = voiceSettings.openrouterVoiceCloneDataUri.value
      openrouterCloneFileName.value = voiceSettings.openrouterVoiceCloneFileName.value
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

async function handleOpenrouterCloneAudioChange(event: Event) {
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
  if (!validType || file.size > OPENROUTER_CLONE_AUDIO_MAX_BYTES) {
    input.value = ''
    return
  }

  try {
    const format = inferCloneAudioFormat(file)
    const dataUri = await readFileAsDataUri(file)
    const mimeType = format === 'mp3' ? 'audio/mpeg' : 'audio/wav'
    openrouterCloneDataUri.value = dataUri.replace(/^data:[^;,]*;base64,/, `data:${mimeType};base64,`)
    openrouterCloneFileName.value = file.name
  } finally {
    input.value = ''
  }
}

function clearOpenrouterCloneAudio() {
  openrouterCloneDataUri.value = ''
  openrouterCloneFileName.value = ''
  if (openrouterCloneAudioInput.value) openrouterCloneAudioInput.value.value = ''
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
    if (props.connection.provider === 'openrouter') {
      // 同上：参考音频不落库（settings 有 2000 字符上限），由 useVoiceApiConnections
      // 转存 localStorage。空值也传，以便"清除音频"能真正生效。
      settings.voiceCloneDataUri = openrouterCloneDataUri.value
      settings.voiceCloneFileName = openrouterCloneFileName.value
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

// OpenRouter：模型列表内置（含两个免费档）。音色语义按模型分裂——
// 有的模型用内置音色（voice 必须留空），有的必须从固定音色表里选，
// 未登记的模型则退回自由输入，避免给出错误的音色下拉。
const openrouterModelOptions = OPENROUTER_TTS_MODELS.map(m => ({ label: m.label, value: m.id }))

const openrouterCurrentModel = computed(() =>
  stringField('model').trim() || OPENROUTER_DEFAULT_MODEL
)

type OpenrouterVoiceMode = 'select' | 'none' | 'free'

const openrouterVoiceMode = computed<OpenrouterVoiceMode>(() => {
  if (props.connection?.provider !== 'openrouter') return 'free'
  const model = openrouterCurrentModel.value
  if (!openrouterModelRequiresVoice(model)) return 'none'
  return openrouterVoiceSetForModel(model) ? 'select' : 'free'
})

const openrouterVoiceOptions = computed(() => {
  const known = openrouterVoiceSetForModel(openrouterCurrentModel.value) || []
  const current = stringField('voice').trim()
  // 保留已存的自定义音色，避免编辑时被吞掉
  if (current && !known.includes(current)) {
    return [{ label: current, value: current }, ...known.map(v => ({ label: v, value: v }))]
  }
  return known.map(v => ({ label: v, value: v }))
})

/** 当前模型是否支持 stateless 声音克隆（决定是否显示参考音频上传） */
const openrouterSupportsCloning = computed(() => {
  if (props.connection?.provider !== 'openrouter') return false
  return openrouterModelSupportsCloning(openrouterCurrentModel.value)
})

/** 切到"使用内置音色"的模型时清空 voice，否则 OpenRouter 会直接 400 */
watch(
  [() => props.connection?.provider, () => stringField('model')],
  () => {
    if (props.connection?.provider !== 'openrouter') return
    if (openrouterVoiceMode.value === 'none' && stringField('voice').trim()) {
      setField('voice', '')
    }
  },
)

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
        <NFormItem v-if="connection.provider === 'iflytek'" label="APPID">
          <NInput
            v-model:value="iflytekAppId"
            :placeholder="connection.settings.appId ? t('settings.voice.keepStoredKeyPlaceholder') : '讯飞控制台 → 我的应用 → APPID'"
            autocomplete="off"
          />
        </NFormItem>
        <NFormItem v-if="!connection.isBuiltin" :label="t('settings.voice.apiKey')">
          <NInput
            v-model:value="apiKeyInput"
            type="password"
            show-password-on="click"
            autocomplete="off"
            :placeholder="connection.hasSecret ? t('settings.voice.keepStoredKeyPlaceholder') : (connection.provider === 'iflytek' ? 'APIKey|APISecret（用 | 分隔）' : t('settings.voice.apiKeyPlaceholder'))"
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
          <NSelect
            v-else-if="connection.provider === 'openrouter'"
            :value="stringField('model')"
            :options="openrouterModelOptions"
            tag
            filterable
            :placeholder="t('models.selectOrInput')"
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
          <NSelect
            v-else-if="connection.provider === 'openrouter' && openrouterVoiceMode === 'select'"
            :value="stringField('voice')"
            :options="openrouterVoiceOptions"
            tag
            filterable
            @update:value="value => setField('voice', value)"
          />
          <NInput
            v-else-if="connection.provider === 'openrouter' && openrouterVoiceMode === 'none'"
            :value="stringField('voice')"
            disabled
            placeholder="该模型使用内置音色，无需填写"
          />
          <NInput
            v-else-if="connection.provider === 'openrouter'"
            :value="stringField('voice')"
            :placeholder="t('models.selectOrInput')"
            @update:value="value => setField('voice', value)"
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

        <template v-if="connection.kind === 'tts' && (supportsGlobalSpeed || supportsGlobalVolume)">
          <NFormItem :label="t('settings.voice.ttsGlobalTitle')">
            <div class="tts-global-hint">{{ t('settings.voice.ttsGlobalHint') }}</div>
          </NFormItem>
          <NFormItem v-if="supportsGlobalSpeed" :label="t('settings.voice.ttsGlobalSpeed')">
            <NSpace vertical style="width: 100%">
              <NSlider
                :value="voiceSettings.ttsSpeed.value"
                :min="0.5"
                :max="2.0"
                :step="0.05"
                @update:value="onTtsSpeed"
              />
              <span style="font-size: 12px; opacity: 0.6">{{ voiceSettings.ttsSpeed.value.toFixed(2) }}x</span>
            </NSpace>
          </NFormItem>
          <NFormItem v-if="supportsGlobalVolume" :label="t('settings.voice.ttsGlobalVolume')">
            <NSpace vertical style="width: 100%">
              <NSlider
                :value="voiceSettings.ttsVolume.value"
                :min="0"
                :max="10"
                :step="0.1"
                @update:value="onTtsVolume"
              />
              <span style="font-size: 12px; opacity: 0.6">{{ voiceSettings.ttsVolume.value.toFixed(1) }}（{{ t('settings.voice.ttsGlobalVolumeHint') }}）</span>
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
          v-if="connection.provider === 'openrouter' && openrouterSupportsCloning"
          :label="t('settings.voice.mimoCloneAudio')"
        >
          <NSpace vertical style="width: 100%">
            <input
              ref="openrouterCloneAudioInput"
              type="file"
              :accept="OPENROUTER_CLONE_AUDIO_ACCEPT"
              style="display: none"
              @change="handleOpenrouterCloneAudioChange"
            />
            <NSpace align="center">
              <NButton size="small" @click="openrouterCloneAudioInput?.click()">
                {{ t('settings.voice.mimoCloneAudioUpload') }}
              </NButton>
              <span v-if="openrouterCloneFileName" style="font-size: 12px; opacity: 0.7">
                {{ openrouterCloneFileName }}
              </span>
              <NButton v-if="openrouterCloneDataUri" size="small" tertiary @click="clearOpenrouterCloneAudio">
                {{ t('settings.voice.mimoCloneAudioClear') }}
              </NButton>
            </NSpace>
            <span style="font-size: 12px; opacity: 0.6">{{ t('settings.voice.openrouterCloneHint') }}</span>
          </NSpace>
        </NFormItem>

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
