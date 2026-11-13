<script setup lang="ts">
// ASR 配置向导（DashScope / LLM / OSS 表单，拆分自 MeetingView.vue，行为保持一致）。
//
// 状态契约：
//   - `asrApiKey` 与分析模式、`asrProvider` 由父级持有（父级的"创建"按钮禁用条件
//     需要响应式依赖 asrApiKey），通过 defineModel 双向绑定。
//   - 其余向导字段（LLM / OSS / 步骤 / ASR 模型）由本组件自持；父级通过
//     ref 调用 `reset()`（打开弹窗时从 store 重播种）与 `collectConfig()`
//     （创建会议 / 启动 ASR 服务时取当前输入值）。
//   - 父级的 CreateMeetingDialog 需使用 display-directive="show" 保持本组件
//     在弹窗关闭后仍挂载，与旧版"状态常驻 MeetingView"的语义一致。
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NInput, NRadio, NRadioGroup, NSelect, NStep, NSteps } from 'naive-ui'
import { useMeetingStore } from '@/stores/hermes/meeting'
import { useRealtimeModelStore } from '@/stores/hermes/realtime-model'

const { t } = useI18n()
const meetingStore = useMeetingStore()
const realtimeModelStore = useRealtimeModelStore()

const asrApiKey = defineModel<string>('asrApiKey', { default: '' })
const newMeetingAnalysisMode = defineModel<'hermes' | 'custom'>('analysisMode', { default: 'hermes' })
const newMeetingAsrProvider = defineModel<'dashscope' | 'minimax'>('asrProvider', { default: 'dashscope' })
const newMeetingMinimaxApiKey = defineModel<string>('minimaxApiKey', { default: '' })

// --- LLM 配置 ---
const llmApiKey = ref(meetingStore.asrConfig.llmApiKey)
const llmBaseUrl = ref(meetingStore.asrConfig.llmBaseUrl)
const llmModel = ref(meetingStore.asrConfig.llmModel)
const asrWizardStep = ref(meetingStore.hasASRConfig && meetingStore.hasLLMConfig ? 3 : 1) // 1=DashScope, 2=LLM, 3=Review

// --- OSS 配置（说话人分离模式必填）---
const ossBucket = ref(meetingStore.asrConfig.ossBucket)
const ossAccessKeyId = ref(meetingStore.asrConfig.ossAccessKeyId)
const ossAccessKeySecret = ref(meetingStore.asrConfig.ossAccessKeySecret)
const ossEndpoint = ref(meetingStore.asrConfig.ossEndpoint)
const ossPathPrefix = ref(meetingStore.asrConfig.ossPathPrefix)
const newMeetingAsrModel = ref('paraformer-v2')

// ASR 模型选项（每个 provider 内部的子模型）
const dashscopeModelOptions = computed(() => [
  {
    label: 'Paraformer V2',
    value: 'paraformer-v2',
    description: t('meeting.asrModelParaformerDesc'),
  },
  {
    label: 'Fun-ASR',
    value: 'fun-asr',
    description: t('meeting.asrModelFunAsrDesc'),
  },
  {
    label: 'Fun-ASR MTL',
    value: 'fun-asr-mtl',
    description: t('meeting.asrModelFunAsrMtlDesc'),
  },
])

/**
 * MiniMax 子模型选项。官方 ASR 文档（v1，2025）只暴露 `asr-1.0`；保留一个
 *  `speech-01` 入口作为对外口径的别名，便于未来版本切换时无需改动 UI。
 */
const minimaxModelOptions = computed(() => [
  {
    label: 'asr-1.0',
    value: 'asr-1.0',
    description: t('meeting.asrModelMinimaxAsr10Desc'),
  },
  {
    label: 'speech-01',
    value: 'speech-01',
    description: t('meeting.asrModelMinimaxSpeech01Desc'),
  },
])

const asrModelOptions = computed(() =>
  newMeetingAsrProvider.value === 'minimax' ? minimaxModelOptions.value : dashscopeModelOptions.value,
)

// 切换 provider 时回到对应 provider 的默认子模型 — 避免跨 provider 的旧值残留。
function onProviderChange(value: 'dashscope' | 'minimax') {
  newMeetingAsrProvider.value = value
  newMeetingAsrModel.value = value === 'minimax' ? 'asr-1.0' : 'paraformer-v2'
}

/** 隐藏说话人分离功能（产品需求：会议只显示 agent 对话，不展示说话人分离）。
 *  与 MeetingView 中的同名常量保持一致；置 false 可恢复 OSS 配置区块。 */
const HIDE_SPEAKER_DIARIZATION = true

/** 打开弹窗时从 store 重播种所有自持字段（与旧版 openCreateModal 一致）。 */
function reset() {
  // ASR provider 默认按 Realtime 模型面板里保存的选择；如果 store 没配置过
  // provider，沿用 'dashscope'。
  const preferred = realtimeModelStore.config.asrProvider || meetingStore.asrConfig.asrProvider
  newMeetingAsrProvider.value = preferred === 'minimax' ? 'minimax' : 'dashscope'
  newMeetingAsrModel.value = newMeetingAsrProvider.value === 'minimax' ? 'asr-1.0' : 'paraformer-v2'
  // MiniMax API key 默认填入 Realtime 面板里保存的值（如果有），用户未填时
  // 可直接使用共享 key。
  newMeetingMinimaxApiKey.value = meetingStore.asrConfig.minimaxApiKey
    || realtimeModelStore.config.minimaxApiKey
  llmApiKey.value = meetingStore.asrConfig.llmApiKey
  llmBaseUrl.value = meetingStore.asrConfig.llmBaseUrl
  llmModel.value = meetingStore.asrConfig.llmModel
  ossBucket.value = meetingStore.asrConfig.ossBucket
  ossAccessKeyId.value = meetingStore.asrConfig.ossAccessKeyId
  ossAccessKeySecret.value = meetingStore.asrConfig.ossAccessKeySecret
  ossEndpoint.value = meetingStore.asrConfig.ossEndpoint
  ossPathPrefix.value = meetingStore.asrConfig.ossPathPrefix
  asrWizardStep.value = meetingStore.hasASRConfig && meetingStore.hasLLMConfig ? 3 : 1
}

/** 父级创建会议 / 启动 ASR 服务时取当前输入值（未挂载时父级回退到 store）。 */
function collectConfig() {
  return {
    asrApiKey: asrApiKey.value,
    asrProvider: newMeetingAsrProvider.value,
    minimaxApiKey: newMeetingMinimaxApiKey.value,
    analysisMode: newMeetingAnalysisMode.value,
    llmApiKey: llmApiKey.value,
    llmBaseUrl: llmBaseUrl.value,
    llmModel: llmModel.value,
    ossBucket: ossBucket.value,
    ossAccessKeyId: ossAccessKeyId.value,
    ossAccessKeySecret: ossAccessKeySecret.value,
    ossEndpoint: ossEndpoint.value,
    ossPathPrefix: ossPathPrefix.value,
    asrModel: newMeetingAsrModel.value,
  }
}

defineExpose({ reset, collectConfig })
</script>

<template>
  <div class="form-section">
    <div class="form-section-title">{{ t('meeting.asrConfig') }}</div>
    <NSteps :current="asrWizardStep" size="small" status="process" class="asr-wizard-steps">
      <NStep :title="t('meeting.wizardStepAsr')" :description="meetingStore.hasASRConfig ? t('meeting.configured') : ''" />
      <NStep :title="t('meeting.wizardStepLlm')" :description="newMeetingAnalysisMode === 'hermes' ? t('meeting.hermesAgent') : (meetingStore.hasLLMConfig ? t('meeting.configured') : t('meeting.optional'))" />
      <NStep :title="t('meeting.wizardStepReview')" />
    </NSteps>

    <!-- Step 1: ASR provider + API key（必填） -->
    <div v-if="asrWizardStep === 1" class="form-item">
      <label class="form-label">{{ t('meeting.asrProvider') }}</label>
      <NRadioGroup :value="newMeetingAsrProvider" @update:value="onProviderChange">
        <NRadio value="dashscope">
          <div class="radio-content">
            <span class="radio-title">{{ t('meeting.asrProviderDashscope') }}</span>
            <span class="radio-desc">{{ t('meeting.asrProviderDashscopeDesc') }}</span>
          </div>
        </NRadio>
        <NRadio value="minimax">
          <div class="radio-content">
            <span class="radio-title">{{ t('meeting.asrProviderMinimax') }}</span>
            <span class="radio-desc">{{ t('meeting.asrProviderMinimaxDesc') }}</span>
          </div>
        </NRadio>
      </NRadioGroup>

      <template v-if="newMeetingAsrProvider === 'dashscope'">
        <label class="form-label" style="margin-top: 12px">
          {{ t('meeting.dashscopeApiKey') }}
          <a
            href="https://dashscope.aliyun.com/"
            target="_blank"
            rel="noopener noreferrer"
            class="form-tutorial-link"
            @click.stop
          >{{ t('meeting.howToGetApiKey') }}</a>
          <span v-if="meetingStore.hasASRConfig" class="form-label-badge">{{ t('meeting.configured') }}</span>
        </label>
        <NInput
          :value="asrApiKey"
          type="password"
          show-password-on="click"
          :placeholder="meetingStore.hasASRConfig ? t('meeting.apiKeySaved') : t('meeting.dashscopeApiKeyPlaceholder')"
          @update:value="asrApiKey = $event"
        />
        <div class="form-hint">{{ t('meeting.dashscopeApiKeyHint') }}</div>
      </template>

      <template v-else>
        <label class="form-label" style="margin-top: 12px">
          {{ t('meeting.minimaxApiKey') }}
          <a
            href="https://platform.minimax.cn/user-center/basic-information/interface-key"
            target="_blank"
            rel="noopener noreferrer"
            class="form-tutorial-link"
            @click.stop
          >{{ t('meeting.howToGetApiKey') }}</a>
        </label>
        <NInput
          :value="newMeetingMinimaxApiKey"
          type="password"
          show-password-on="click"
          :placeholder="t('meeting.minimaxApiKeyPlaceholder')"
          @update:value="newMeetingMinimaxApiKey = $event"
        />
        <div class="form-hint">{{ t('meeting.minimaxApiKeyHint') }}</div>
      </template>

      <!-- OSS 配置（说话人分离必填，可折叠）——隐藏说话人分离时一并隐藏 -->
      <details v-if="!HIDE_SPEAKER_DIARIZATION" class="oss-config-details">
        <summary class="oss-config-summary">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
            <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
            <line x1="12" y1="22.08" x2="12" y2="12"/>
          </svg>
          {{ t('meeting.ossConfig') }}
          <span v-if="meetingStore.asrConfig.ossBucket" class="form-label-badge">{{ t('meeting.configured') }}</span>
        </summary>
        <div class="oss-config-body">
          <NAlert type="info" :show-icon="false" closable style="margin-bottom: 12px">
            {{ t('meeting.ossConfigHint') }}
          </NAlert>
          <label class="form-label">{{ t('meeting.ossBucket') }}</label>
          <NInput v-model:value="ossBucket" :placeholder="t('meeting.ossBucketPlaceholder')" />
          <label class="form-label" style="margin-top: 12px">{{ t('meeting.ossAccessKeyId') }}</label>
          <NInput v-model:value="ossAccessKeyId" type="password" show-password-on="click" :placeholder="t('meeting.ossAccessKeyIdPlaceholder')" />
          <label class="form-label" style="margin-top: 12px">{{ t('meeting.ossAccessKeySecret') }}</label>
          <NInput v-model:value="ossAccessKeySecret" type="password" show-password-on="click" :placeholder="t('meeting.ossAccessKeySecretPlaceholder')" />
          <label class="form-label" style="margin-top: 12px">{{ t('meeting.ossEndpoint') }}</label>
          <NInput v-model:value="ossEndpoint" :placeholder="t('meeting.ossEndpointPlaceholder')" />
          <label class="form-label" style="margin-top: 12px">{{ t('meeting.ossPathPrefix') }}</label>
          <NInput v-model:value="ossPathPrefix" :placeholder="t('meeting.ossPathPrefixPlaceholder')" />
        </div>
      </details>

      <div class="wizard-actions">
        <NButton type="primary" size="small" @click="asrWizardStep = 2">
          {{ t('meeting.wizardNext') }}
        </NButton>
      </div>
    </div>

    <!-- Step 2: 智能分析（可选 — 默认直接使用 Hermes Agent，无需 LLM 配置） -->
    <div v-if="asrWizardStep === 2" class="form-item">
      <NAlert type="info" :show-icon="false" style="margin-bottom: 12px">
        {{ t('meeting.llmOptionalHint') }}
      </NAlert>
      <label class="form-label">{{ t('meeting.analysisMode') }}</label>
      <NRadioGroup v-model:value="newMeetingAnalysisMode">
        <NRadio value="hermes">
          <div class="radio-content">
            <span class="radio-title">{{ t('meeting.hermesAgent') }}</span>
            <span class="radio-desc">{{ t('meeting.hermesAgentDesc') }}</span>
          </div>
        </NRadio>
        <NRadio value="custom">
          <div class="radio-content">
            <span class="radio-title">{{ t('meeting.customModel') }}</span>
            <span class="radio-desc">{{ t('meeting.customModelDesc') }}</span>
          </div>
        </NRadio>
      </NRadioGroup>
      <!-- 自定义 LLM 配置（仅在选择自定义模式时显示） -->
      <template v-if="newMeetingAnalysisMode === 'custom'">
        <label class="form-label" style="margin-top: 12px">{{ t('meeting.llmApiKey') }}</label>
        <NInput
          v-model:value="llmApiKey"
          type="password"
          show-password-on="click"
          :placeholder="t('meeting.llmApiKeyPlaceholder')"
        />
        <label class="form-label" style="margin-top: 12px">{{ t('meeting.llmBaseUrl') }}</label>
        <NInput v-model:value="llmBaseUrl" :placeholder="t('meeting.llmBaseUrlPlaceholder')" />
        <label class="form-label" style="margin-top: 12px">{{ t('meeting.llmModel') }}</label>
        <NInput v-model:value="llmModel" :placeholder="t('meeting.llmModelPlaceholder')" />
      </template>
      <div class="wizard-actions">
        <NButton size="small" @click="asrWizardStep = 1">{{ t('meeting.wizardBack') }}</NButton>
        <NButton type="primary" size="small" @click="asrWizardStep = 3">
          {{ t('meeting.wizardNext') }}
        </NButton>
      </div>
    </div>

    <!-- Step 3: Review -->
    <div v-if="asrWizardStep === 3" class="form-item">
      <NAlert v-if="!meetingStore.hasASRConfig && !asrApiKey && newMeetingAsrProvider === 'dashscope'" type="warning" :show-icon="true" style="margin-bottom: 8px">
        {{ t('meeting.wizardWarnMissingAsr') }}
      </NAlert>
      <NAlert v-if="newMeetingAsrProvider === 'minimax' && !newMeetingMinimaxApiKey.trim()" type="warning" :show-icon="true" style="margin-bottom: 8px">
        {{ t('meeting.wizardWarnMissingMinimax') }}
      </NAlert>
      <NAlert v-if="newMeetingAnalysisMode === 'custom' && !meetingStore.hasLLMConfig && !llmApiKey" type="info" :show-icon="false" style="margin-bottom: 8px">
        {{ t('meeting.wizardWarnMissingLlm') }}
      </NAlert>
      <ul class="wizard-review-list">
        <li>
          <span class="wizard-review-label">{{ t('meeting.wizardStepAsr') }}:</span>
          <span class="wizard-review-value">
            <template v-if="newMeetingAsrProvider === 'minimax'">
              {{ newMeetingMinimaxApiKey.trim() ? '✓ ' + t('meeting.asrProviderMinimax') : '— ' + t('meeting.notConfigured') }}
            </template>
            <template v-else>
              {{ (asrApiKey || meetingStore.asrConfig.dashscopeApiKey) ? '✓ ' + t('meeting.asrProviderDashscope') : '— ' + t('meeting.notConfigured') }}
            </template>
          </span>
        </li>
        <li>
          <span class="wizard-review-label">{{ t('meeting.wizardStepLlm') }}:</span>
          <span class="wizard-review-value">{{ newMeetingAnalysisMode === 'hermes' ? '✓ ' + t('meeting.hermesAgent') : ((llmApiKey || meetingStore.asrConfig.llmApiKey) ? '✓ ' + t('meeting.configured') : '— ' + t('meeting.notConfigured')) }}</span>
        </li>
      </ul>
      <div class="wizard-actions">
        <NButton size="small" @click="asrWizardStep = 2">{{ t('meeting.wizardBack') }}</NButton>
        <NButton size="small" @click="asrWizardStep = 1">{{ t('meeting.wizardRestart') }}</NButton>
      </div>
    </div>
    <div class="form-item">
      <label class="form-label">{{ t('meeting.asrModel') }}</label>
      <NSelect
        v-model:value="newMeetingAsrModel"
        :options="asrModelOptions"
        :placeholder="t('meeting.selectAsrModel')"
      />
      <div class="form-hint">{{ t('meeting.asrModelHint') }}</div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

/* 与 MeetingView 同名规则保持一致（scoped 样式无法跨组件复用，*/
/* 后续可抽成共享 SCSS partial）。*/
.form-section {
  padding: 12px;
  background: rgba(var(--accent-primary-rgb), 0.03);
  border-radius: 8px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.1);
}

.form-section-title {
  font-size: 14px;
  font-weight: 600;
  color: $text-primary;
  margin-bottom: 12px;
}

.form-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-label {
  font-size: 13px;
  font-weight: 500;
  color: $text-primary;
  display: flex;
  align-items: center;
  gap: 8px;
}

.form-label-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(var(--success-rgb), 0.1);
  color: var(--success);
  font-size: 11px;
  font-weight: 600;
}

.form-tutorial-link {
  font-size: 12px;
  font-weight: 400;
  color: var(--color-primary, var(--accent-info));
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
  opacity: 0.75;
  transition: opacity 0.2s;
}

.form-tutorial-link:hover {
  opacity: 1;
}

.form-hint {
  font-size: 12px;
  color: $text-secondary;
  line-height: 1.4;
}

.oss-config-details {
  margin-top: 12px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.15);
  border-radius: $radius-sm;
  overflow: hidden;
}

.oss-config-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  font-size: 13px;
  font-weight: 500;
  color: $text-primary;
  cursor: pointer;
  user-select: none;
  background: rgba(var(--accent-primary-rgb), 0.03);
  transition: background 0.2s;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.07);
  }

  svg {
    flex-shrink: 0;
    color: $accent-primary;
  }

  &::-webkit-details-marker {
    display: none;
  }
}

.oss-config-body {
  padding: 10px;
  border-top: 1px solid rgba(var(--accent-primary-rgb), 0.1);
}

.radio-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.radio-title {
  font-size: 14px;
  font-weight: 500;
  color: $text-primary;
}

.radio-desc {
  font-size: 12px;
  color: $text-secondary;
}
</style>
