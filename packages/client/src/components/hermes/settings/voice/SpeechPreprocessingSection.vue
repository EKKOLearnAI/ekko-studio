<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { NButton, NInput, NInputNumber, NSwitch, NRadioGroup, NRadioButton, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { prepareSpeechPreview, synthesizeSpeech, type TtsProviderId } from '@/api/studio/tts'
import {
  fetchSpeechPreprocessing,
  saveSpeechPreprocessing,
  type SpeechPreprocessingMode,
  type SpeechPreprocessingSettings,
} from '@/api/studio/tts-settings'

const { t } = useI18n()
const message = useMessage()

const loading = ref(false)
const saving = ref(false)
const loaded = ref(false)

const enabled = ref(false)
const provider = ref('open.bigmodel.cn')
const model = ref('glm-4.5-air')
const mode = ref<SpeechPreprocessingMode>('faithful')
const promptFaithful = ref('')
const promptSummary = ref('')
const triggerCodeBlock = ref(true)
const triggerTable = ref(true)
const triggerMinChars = ref(300)

const activePrompt = ref('')
const activePromptKind = ref<SpeechPreprocessingMode>('faithful')

const DEFAULT_PROMPTS: Record<SpeechPreprocessingMode, string> = {
  faithful: '你是语音播报预处理助手。把输入内容转换为适合用语音朗读的口语化中文。\n要求：\n1. 去除所有 Markdown 标记、表格符号、URL、代码块符号\n2. 代码块用一句话概括其作用，不要朗读代码本身\n3. 表格转述为自然语言的对比描述\n4. 保留全部信息，不做删减；保留关键数据、数字、专有名词的准确表达\n5. 只输出要朗读的文本，不要任何解释、前缀或后缀',
  summary: '你是语音播报预处理助手。把输入内容压缩为适合语音朗读的口语化中文摘要。\n要求：\n1. 只保留核心结论、关键数据和必要背景，省略论证过程与重复表述\n2. 长度控制在 200 字以内\n3. 去除所有 Markdown 标记、代码块、表格符号与 URL\n4. 代码块用一句话概括作用；表格只说结论\n5. 只输出要朗读的文本，不要任何解释、前缀或后缀',
}

function syncActivePrompt() {
  activePrompt.value = mode.value === 'summary' ? promptSummary.value : promptFaithful.value
  activePromptKind.value = mode.value
}

function applySettings(cfg: SpeechPreprocessingSettings) {
  enabled.value = cfg.enabled
  provider.value = cfg.provider || 'open.bigmodel.cn'
  model.value = cfg.model || 'glm-4.5-air'
  mode.value = cfg.mode || 'faithful'
  promptFaithful.value = cfg.promptFaithful || DEFAULT_PROMPTS.faithful
  promptSummary.value = cfg.promptSummary || DEFAULT_PROMPTS.summary
  triggerCodeBlock.value = cfg.triggers?.codeBlock ?? true
  triggerTable.value = cfg.triggers?.table ?? true
  triggerMinChars.value = cfg.triggers?.minChars ?? 300
  syncActivePrompt()
}

function restorePreset() {
  if (activePromptKind.value === 'summary') {
    promptSummary.value = DEFAULT_PROMPTS.summary
  } else {
    promptFaithful.value = DEFAULT_PROMPTS.faithful
  }
  syncActivePrompt()
  message.success(t('settings.voice.speechPreprocessingPromptRestore'))
}

watch(mode, (next) => {
  activePrompt.value = next === 'summary' ? promptSummary.value : promptFaithful.value
  activePromptKind.value = next
})

watch(activePrompt, (value) => {
  if (activePromptKind.value === 'summary') {
    promptSummary.value = value
  } else {
    promptFaithful.value = value
  }
})

async function load() {
  if (loaded.value) return
  loading.value = true
  try {
    const cfg = await fetchSpeechPreprocessing()
    applySettings(cfg)
    loaded.value = true
  } catch (err) {
    message.error(t('settings.voice.speechPreprocessingLoadFailed'))
    console.error('[SpeechPreprocessing] failed to load settings:', err)
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  try {
    const cfg = await saveSpeechPreprocessing({
      enabled: enabled.value,
      provider: provider.value.trim(),
      model: model.value.trim(),
      mode: mode.value,
      promptFaithful: promptFaithful.value,
      promptSummary: promptSummary.value,
      triggers: {
        codeBlock: triggerCodeBlock.value,
        table: triggerTable.value,
        minChars: triggerMinChars.value && triggerMinChars.value > 0 ? triggerMinChars.value : 300,
      },
    })
    applySettings(cfg)
    message.success(t('settings.voice.speechPreprocessingSaved'))
  } catch (err) {
    message.error(
      t('settings.voice.speechPreprocessingSaveFailed', {
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  } finally {
    saving.value = false
  }
}

onMounted(load)

// ---------------------------------------------------------------------------
// 语音稿试听台：输入长文本 → 生成预处理语音稿 → 可编辑 → 试听（跳过预处理直读稿子）
// ---------------------------------------------------------------------------
const props = withDefaults(defineProps<{ activeProvider?: string }>(), { activeProvider: '' })

const previewInput = ref('')
const previewDraft = ref('')
const previewLoading = ref(false)
const previewPlaying = ref(false)
let previewAudio: HTMLAudioElement | null = null

function usePreviewSample() {
  previewInput.value = t('settings.voice.ttsPreviewSample')
}

async function generatePreview() {
  const text = previewInput.value.trim()
  if (!text) {
    message.warning(t('settings.voice.ttsPreviewInputEmpty'))
    return
  }
  previewLoading.value = true
  try {
    const prepared = await prepareSpeechPreview({ text })
    previewDraft.value = prepared
    message.success(t('settings.voice.ttsPreviewGeneratedOk'))
  } catch (err) {
    message.error(
      t('settings.voice.ttsPreviewGenerateFailed', {
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  } finally {
    previewLoading.value = false
  }
}

async function listenPreview() {
  if (!props.activeProvider) {
    message.warning(t('settings.voice.ttsPreviewNoProvider'))
    return
  }
  const text = previewDraft.value.trim()
  if (!text) return
  previewPlaying.value = true
  try {
    const { audio } = await synthesizeSpeech({
      provider: props.activeProvider as TtsProviderId,
      text,
      skipPreprocess: true, // 稿子已编辑好，直接合成，避免二次预处理改写
    })
    const url = URL.createObjectURL(audio)
    if (previewAudio) {
      previewAudio.pause()
      previewAudio = null
    }
    const el = new Audio(url)
    previewAudio = el
    el.onended = () => {
      if (previewAudio === el) previewAudio = null
      previewPlaying.value = false
      URL.revokeObjectURL(url)
    }
    el.onerror = () => {
      if (previewAudio === el) previewAudio = null
      previewPlaying.value = false
      URL.revokeObjectURL(url)
      message.error(t('settings.voice.ttsPreviewListenFailed'))
    }
    await el.play()
  } catch (err) {
    previewPlaying.value = false
    message.error(
      t('settings.voice.ttsPreviewListenFailed', {
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}
</script>

<template>
  <section class="settings-section speech-preprocessing-section" aria-labelledby="speech-preprocessing-title">
    <header class="section-header">
      <div class="section-copy">
        <h4 id="speech-preprocessing-title" class="section-title">{{ t('settings.voice.speechPreprocessingTitle') }}</h4>
        <p class="section-desc">{{ t('settings.voice.speechPreprocessingDescription') }}</p>
      </div>
    </header>

    <div class="preprocess-grid" :class="{ 'is-loading': loading }">
      <div class="pp-row pp-row-switch">
        <div class="pp-copy">
          <span class="pp-label">{{ t('settings.voice.speechPreprocessingEnabled') }}</span>
          <span class="pp-hint">{{ t('settings.voice.speechPreprocessingEnabledHint') }}</span>
        </div>
        <NSwitch v-model:value="enabled" size="small" />
      </div>

      <template v-if="enabled">
        <div class="pp-grid-2">
          <div class="pp-field">
            <span class="pp-label">{{ t('settings.voice.speechPreprocessingMode') }}</span>
            <NRadioGroup v-model:value="mode" size="small">
              <NRadioButton value="faithful">
                {{ t('settings.voice.speechPreprocessingModeFaithful') }}
              </NRadioButton>
              <NRadioButton value="summary">
                {{ t('settings.voice.speechPreprocessingModeSummary') }}
              </NRadioButton>
            </NRadioGroup>
            <span class="pp-hint">
              {{
                mode === 'faithful'
                  ? t('settings.voice.speechPreprocessingModeFaithfulHint')
                  : t('settings.voice.speechPreprocessingModeSummaryHint')
              }}
            </span>
          </div>

          <div class="pp-field">
            <span class="pp-label">{{ t('settings.voice.speechPreprocessingProvider') }}</span>
            <NInput v-model:value="provider" size="small" :placeholder="'open.bigmodel.cn'" />
            <span class="pp-hint">{{ t('settings.voice.speechPreprocessingProviderHint') }}</span>
          </div>

          <div class="pp-field">
            <span class="pp-label">{{ t('settings.voice.speechPreprocessingModel') }}</span>
            <NInput v-model:value="model" size="small" :placeholder="'glm-4.5-air'" />
            <span class="pp-hint">{{ t('settings.voice.speechPreprocessingModelHint') }}</span>
          </div>

          <div class="pp-field">
            <span class="pp-label">{{ t('settings.voice.speechPreprocessingTriggers') }}</span>
            <div class="pp-triggers">
              <label class="pp-check">
                <input v-model="triggerCodeBlock" type="checkbox" />
                <span>{{ t('settings.voice.speechPreprocessingTriggerCode') }}</span>
              </label>
              <label class="pp-check">
                <input v-model="triggerTable" type="checkbox" />
                <span>{{ t('settings.voice.speechPreprocessingTriggerTable') }}</span>
              </label>
              <label class="pp-check pp-check-chars">
                <span>{{ t('settings.voice.speechPreprocessingTriggerChars') }}</span>
                <NInputNumber
                  v-model:value="triggerMinChars"
                  size="tiny"
                  :min="1"
                  :max="5000"
                  style="width: 84px"
                />
                <span class="pp-unit">字</span>
              </label>
            </div>
            <span class="pp-hint">{{ t('settings.voice.speechPreprocessingTriggerCharsHint') }}</span>
          </div>
        </div>

        <div class="pp-row pp-row-prompt">
          <div class="pp-copy pp-copy-prompt">
            <span class="pp-label">{{ t('settings.voice.speechPreprocessingPrompt') }}</span>
            <span class="pp-hint">{{ t('settings.voice.speechPreprocessingPromptHint') }}</span>
          </div>
          <div class="pp-prompt-controls">
            <NButton size="tiny" quaternary @click="restorePreset">
              {{ t('settings.voice.speechPreprocessingPromptRestore') }}
            </NButton>
          </div>
        </div>
        <NInput
          v-model:value="activePrompt"
          type="textarea"
          :autosize="{ minRows: 4, maxRows: 10 }"
          size="small"
        />
      </template>

      <div class="pp-actions">
        <NButton size="small" type="primary" :loading="saving" :disabled="loading" @click="save">
          {{ t('settings.voice.speechPreprocessingSave') }}
        </NButton>
      </div>
    </div>

    <!-- 语音稿试听台 -->
    <div class="pp-preview">
      <h5 class="pp-preview-title">{{ t('settings.voice.ttsPreviewTitle') }}</h5>
      <p class="pp-preview-desc">{{ t('settings.voice.ttsPreviewDescription') }}</p>
      <NInput
        v-model:value="previewInput"
        type="textarea"
        :autosize="{ minRows: 2, maxRows: 5 }"
        size="small"
        :placeholder="t('settings.voice.ttsPreviewInputPlaceholder')"
      />
      <div class="pp-preview-toolbar">
        <NButton size="tiny" quaternary @click="usePreviewSample">
          {{ t('settings.voice.ttsPreviewUseSample') }}
        </NButton>
        <NButton size="tiny" type="primary" :loading="previewLoading" @click="generatePreview">
          {{ t('settings.voice.ttsPreviewGenerate') }}
        </NButton>
      </div>

      <template v-if="previewDraft">
        <span class="pp-preview-draft-label">{{ t('settings.voice.ttsPreviewDraftLabel') }}</span>
        <NInput
          v-model:value="previewDraft"
          type="textarea"
          :autosize="{ minRows: 3, maxRows: 10 }"
          size="small"
        />
        <NButton size="small" :loading="previewPlaying" @click="listenPreview">
          {{ t('settings.voice.ttsPreviewListen', { provider: props.activeProvider || '…' }) }}
        </NButton>
      </template>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.speech-preprocessing-section {
  margin-top: 28px;
  padding-top: 20px;
  border-top: 1px solid $border-color;
}

.section-header {
  margin-bottom: 14px;
}

.section-copy {
  min-width: 0;
}

.section-title {
  margin: 0 0 6px;
  color: $text-primary;
  font-size: 15px;
  font-weight: 600;
}

.section-desc {
  margin: 0;
  max-width: 620px;
  color: $text-muted;
  font-size: 13px;
  line-height: 1.6;
}

.preprocess-grid {
  display: grid;
  gap: 14px;
  max-width: 720px;

  &.is-loading {
    opacity: 0.5;
    pointer-events: none;
  }
}

.pp-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.pp-copy {
  display: grid;
  gap: 4px;
}

.pp-label {
  color: $text-primary;
  font-size: 13px;
  font-weight: 600;
}

.pp-hint {
  color: $text-muted;
  font-size: 12px;
  line-height: 1.5;
}

.pp-grid-2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.pp-field {
  display: grid;
  gap: 6px;
  align-content: start;
}

.pp-triggers {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.pp-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: $text-secondary;
  font-size: 13px;
  cursor: pointer;

  input[type='checkbox'] {
    accent-color: $accent-primary;
  }
}

.pp-check-chars {
  cursor: default;
}

.pp-unit {
  color: $text-muted;
  font-size: 12px;
}

.pp-row-prompt {
  align-items: center;
}

.pp-copy-prompt {
  flex: 1;
}

.pp-actions {
  display: flex;
  justify-content: flex-end;
}

.pp-preview {
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px dashed $border-color;
}

.pp-preview-title {
  margin: 0 0 4px;
  font-size: 14px;
}

.pp-preview-desc {
  margin: 0 0 8px;
  color: $text-muted;
  font-size: 12px;
}

.pp-preview-toolbar {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin: 6px 0 10px;
}

.pp-preview-draft-label {
  display: block;
  margin: 8px 0 4px;
  color: $text-secondary;
  font-size: 13px;
}

.pp-preview :deep(.n-button) {
  margin-top: 8px;
}

@media (max-width: 720px) {
  .pp-grid-2 {
    grid-template-columns: 1fr;
  }

  .pp-row-switch,
  .pp-row-prompt {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
