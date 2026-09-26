<script setup lang="ts">
import DshSessionPresetSelect from "@/components/coding-agents/dsh/DshSessionPresetSelect.vue"
import { computed, ref } from 'vue'
import { Handle, Position, type NodeProps } from '@vue-flow/core'
import { NodeResizer } from '@vue-flow/node-resizer'
import { NInput, NSelect, NSwitch, NTooltip, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import WorkflowModelSelector from './WorkflowModelSelector.vue'
import WorkflowFieldHelp from './WorkflowFieldHelp.vue'
import type { WorkflowAgentNodeData, WorkflowAgentNodeEditableData } from './types'
import type { ChatCodingAgentId, CodingAgentApiMode } from '@/api/coding-agents'
import type { ProviderApiMode } from '@/api/studio/provider-api-mode'
import { getFileDownloadUrl } from '@/api/studio/files'
import { canScopedCodingAgentUseProvider } from '@/utils/codingAgentProviders'

import '@vue-flow/node-resizer/dist/style.css'

const props = defineProps<NodeProps<WorkflowAgentNodeData>>()
const { t } = useI18n()
const message = useMessage()
const attachmentInputRef = ref<HTMLInputElement | null>(null)
const uploadingAttachments = ref(false)
const previewPath = ref('')
const previewVisible = ref(false)

const statusClass = computed(() => `status-${props.data.status}`)
const statusLabel = computed(() => t(`workflow.status.${props.data.status}`))
const statusTip = computed(() => (
  props.data.status === 'failed' && props.data.statusError?.trim()
    ? props.data.statusError.trim()
    : ''
))
const isCodingAgent = computed(() => props.data.agent !== 'hermes')
const supportsGlobalMode = computed(() => ['claude-code', 'codex', 'pi', 'grok', 'opencode', 'dsh'].includes(props.data.agent))
const usesScopedModel = computed(() => !supportsGlobalMode.value || props.data.agentMode !== 'global')
const agentModeOptions = computed(() => [
  { label: t('codingAgents.launchModeGlobal'), value: 'global' },
  { label: t('codingAgents.launchModeScoped'), value: 'scoped' },
])
const selectableModelGroups = computed(() => (
  isCodingAgent.value
    ? props.data.modelGroups.filter(group => canScopedCodingAgentUseProvider(
        props.data.agent as ChatCodingAgentId,
        group.provider,
      ))
    : props.data.modelGroups
))
const apiModeOptions = computed(() => [
  { label: t('codingAgents.protocolOpenAiChat'), value: 'chat_completions' },
  { label: t('codingAgents.protocolOpenAiResponses'), value: 'codex_responses' },
  { label: t('codingAgents.protocolAnthropicMessages'), value: 'anthropic_messages' },
])
const reasoningEffortOptions = computed(() => [
  { label: t('chat.reasoningEffort.options.default'), value: 'default' },
  { label: t('chat.reasoningEffort.options.none'), value: 'none' },
  { label: t('chat.reasoningEffort.options.minimal'), value: 'minimal' },
  { label: t('chat.reasoningEffort.options.low'), value: 'low' },
  { label: t('chat.reasoningEffort.options.medium'), value: 'medium' },
  { label: t('chat.reasoningEffort.options.high'), value: 'high' },
  { label: t('chat.reasoningEffort.options.xhigh'), value: 'xhigh' },
  { label: t('chat.reasoningEffort.options.max'), value: 'max' },
])
const imageAttachments = computed(() => props.data.images.filter(isImagePath))
const fileAttachments = computed(() => props.data.images.filter(path => !isImagePath(path)))

function updateField<K extends keyof WorkflowAgentNodeEditableData>(key: K, value: WorkflowAgentNodeEditableData[K]) {
  props.data.onUpdate(props.id, { [key]: value } as Partial<WorkflowAgentNodeEditableData>)
}

function addQualityCriterion() {
  const criteria = [...(props.data.qualityReview?.criteria || []), { id: `criterion-${Date.now().toString(36)}`, text: '', evidence: 'output' as const }].slice(0, 10)
  updateField('qualityReview', { mode: 'observe', criteria })
}
function updateQualityCriterion(index: number, text: string) { const criteria = [...(props.data.qualityReview?.criteria || [])]; if (criteria[index]) criteria[index] = { ...criteria[index], text }; updateField('qualityReview', { mode: props.data.qualityReview?.mode || 'observe', criteria }) }
function removeQualityCriterion(index: number) { const criteria = [...(props.data.qualityReview?.criteria || [])]; criteria.splice(index,1); updateField('qualityReview', { mode: props.data.qualityReview?.mode || 'observe', criteria }) }

function handleModelSelect(selection: { provider: string; model: string; apiMode?: ProviderApiMode }) {
  const patch: Partial<WorkflowAgentNodeEditableData> = {
    provider: selection.provider,
    model: selection.model,
  }
  if (
    selection.apiMode === 'chat_completions' ||
    selection.apiMode === 'codex_responses' ||
    selection.apiMode === 'anthropic_messages'
  ) {
    patch.apiMode = selection.apiMode
  }
  props.data.onUpdate(props.id, patch)
}

function handleControlEvent(event: Event) {
  if (!props.data.readonly) event.stopPropagation()
}

function openImagePicker() {
  if (uploadingAttachments.value) return
  attachmentInputRef.value?.click()
}

async function handleImageInputChange(event: Event) {
  if (uploadingAttachments.value) return
  const input = event.target instanceof HTMLInputElement ? event.target : null
  const files = Array.from(input?.files || [])
  if (files.length === 0) return
  await uploadImages(files)
  if (input) input.value = ''
}

function removeImage(path: string) {
  updateField('images', props.data.images.filter(image => image !== path))
}

function imageName(path: string) {
  return path.split('/').pop() || path
}

function imageUrl(path: string) {
  return getFileDownloadUrl(path, imageName(path))
}

function isImagePath(path: string) {
  return /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i.test(path.split('?')[0] || path)
}

function openPreview(path: string) {
  previewPath.value = path
  previewVisible.value = true
}

async function uploadImages(files: File[]) {
  uploadingAttachments.value = true
  try {
    const paths = await props.data.onUploadImages(props.id, files)
    updateField('images', [...props.data.images, ...paths])
  } catch (err: any) {
    message.error(err?.message || t('files.uploadFailed'))
  } finally {
    uploadingAttachments.value = false
  }
}
</script>

<template>
  <div class="workflow-agent-node" :class="[statusClass, { selected }]">
    <NodeResizer
      :is-visible="selected && !data.readonly"
      :min-width="260"
      :min-height="360"
      color="var(--accent-info)"
      handle-class-name="workflow-resize-handle"
      line-class-name="workflow-resize-line"
    />
    <Handle id="input" type="source" :position="Position.Left" class="workflow-handle input-handle" />
    <Handle id="top" type="source" :position="Position.Top" class="workflow-handle top-handle" />

    <div class="node-header">
      <NTooltip v-if="statusTip" trigger="hover" placement="top">
        <template #trigger>
          <span class="node-status-with-tip">
            <span class="node-status-dot" />
            <span class="node-status-label">{{ statusLabel }}</span>
          </span>
        </template>
        <span class="node-status-tip">{{ statusTip }}</span>
      </NTooltip>
      <span v-else class="node-status-with-tip">
        <span class="node-status-dot" />
        <span class="node-status-label">{{ statusLabel }}</span>
      </span>
    </div>

    <div
      class="node-controls nodrag nopan"
      @click="handleControlEvent"
      @pointerdown="handleControlEvent"
      @pointerup="handleControlEvent"
      @mousedown="handleControlEvent"
      @mouseup="handleControlEvent"
      @touchstart="handleControlEvent"
      @touchend="handleControlEvent"
    >
      <NInput
        :value="data.title"
        size="small"
        :disabled="data.readonly"
        :placeholder="t('workflow.node.title')"
        @update:value="value => updateField('title', value)"
      />
      <NSelect
        :value="data.agent"
        :options="data.agentOptions"
        size="small"
        :disabled="data.readonly"
        :placeholder="t('workflow.node.agent')"
        @update:value="value => updateField('agent', value as string)"
      />
      <DshSessionPresetSelect v-if="data.agent === 'dsh'" :model-value="data.agentPreset" :disabled="data.readonly"
        @update:model-value="updateField('agentPreset', $event)" @valid="updateField('agentPresetReady', $event)" />
      <NSelect
        v-if="supportsGlobalMode"
        :value="data.agentMode"
        :options="agentModeOptions"
        size="small"
        :disabled="data.readonly"
        :placeholder="t('codingAgents.launchModeScope')"
        @update:value="value => updateField('agentMode', value as 'scoped' | 'global')"
      />
      <WorkflowModelSelector
        v-if="usesScopedModel"
        :provider="data.provider"
        :model="data.model"
        :groups="selectableModelGroups"
        :disabled="data.readonly"
        @select="handleModelSelect"
      />
      <NSelect
        v-if="isCodingAgent && usesScopedModel"
        :value="data.apiMode"
        :options="apiModeOptions"
        size="small"
        :disabled="data.readonly"
        :placeholder="t('workflow.node.apiMode')"
        @update:value="value => updateField('apiMode', value as CodingAgentApiMode)"
      />
      <NSelect
        v-if="usesScopedModel"
        :value="data.reasoningEffort"
        :options="reasoningEffortOptions"
        size="small"
        :disabled="data.readonly"
        :placeholder="t('chat.reasoningEffort.tooltip')"
        @update:value="value => updateField('reasoningEffort', value as string)"
      />
      <div class="node-field-row">
        <span class="node-field-label-row">
          <span>{{ t('workflow.node.join') }}</span>
          <WorkflowFieldHelp
            :text="data.orchestration?.join === 'any' ? t('workflow.node.joinAnyHelp') : t('workflow.node.joinAllHelp')"
            test-id="workflow-node-join-help"
          />
        </span>
        <NSelect
          :value="data.orchestration?.join || 'all'"
          :options="[{ label: t('workflow.node.joinAll'), value: 'all' }, { label: t('workflow.node.joinAny'), value: 'any' }]"
          size="small"
          :disabled="data.readonly"
          @update:value="value => updateField('orchestration', { join: value as 'all' | 'any' })"
        />
      </div>
      <label class="node-toggle-row">
        <span>{{ t('workflow.node.qualityReview') }}</span>
        <NSwitch :value="data.qualityReview?.mode === 'observe'" size="small" :disabled="data.readonly" @update:value="value => updateField('qualityReview', { mode: value ? 'observe' : 'off', criteria: data.qualityReview?.criteria || [] })" />
      </label>
      <div v-if="data.qualityReview?.mode === 'observe'" class="quality-criteria">
        <div v-for="(criterion, index) in data.qualityReview.criteria" :key="criterion.id" class="quality-criterion">
          <NInput :value="criterion.text" size="small" :disabled="data.readonly" :placeholder="t('workflow.node.qualityCriterion')" @update:value="value => updateQualityCriterion(index, value)" />
          <button type="button" :disabled="data.readonly" @click="removeQualityCriterion(index)">×</button>
        </div>
        <button v-if="data.qualityReview.criteria.length < 10" type="button" :disabled="data.readonly" @click="addQualityCriterion">{{ t('workflow.node.addQualityCriterion') }}</button>
      </div>
      <label class="node-toggle-row">
        <span>{{ t('workflow.node.approvalRequired') }}</span>
        <NSwitch
          :value="data.approvalRequired === true"
          size="small"
          :disabled="data.readonly"
          @update:value="value => updateField('approvalRequired', value)"
        />
      </label>
      <NSelect
        :value="data.skills"
        :options="data.skillOptions"
        :loading="data.skillsLoading"
        multiple
        tag
        filterable
        size="small"
        :disabled="data.readonly"
        :placeholder="t('workflow.node.skillsPlaceholder')"
        @update:value="value => updateField('skills', value as string[])"
      />
      <NInput
        class="node-prompt-input"
        :value="data.input"
        type="textarea"
        size="small"
        :resizable="false"
        :disabled="data.readonly"
        :input-props="{ style: { height: '100%', resize: 'none' } }"
        :placeholder="t('workflow.node.promptPlaceholder')"
        @update:value="value => updateField('input', value)"
      />
      <div class="node-images">
        <input
          ref="attachmentInputRef"
          class="image-upload-input"
          type="file"
          multiple
          @change="handleImageInputChange"
        >
        <div v-if="imageAttachments.length > 0" class="image-preview-grid">
          <div
            v-for="image in imageAttachments"
            :key="image"
            class="image-preview"
            :title="image"
            role="button"
            tabindex="0"
            @click.stop="openPreview(image)"
            @keydown.enter.stop.prevent="openPreview(image)"
            @keydown.space.stop.prevent="openPreview(image)"
          >
            <img :src="imageUrl(image)" :alt="imageName(image)">
            <button
              v-if="!data.readonly"
              class="image-remove"
              type="button"
              :aria-label="t('common.delete')"
              @pointerdown.stop
              @pointerup.stop
              @mousedown.stop
              @mouseup.stop
              @click.stop.prevent="removeImage(image)"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
        <div v-if="fileAttachments.length > 0" class="file-paths">
          <a
            v-for="file in fileAttachments"
            :key="file"
            class="file-path"
            :title="file"
            :href="imageUrl(file)"
            target="_blank"
            rel="noopener noreferrer"
            @click.stop
          >
            <svg class="file-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span class="file-name">{{ imageName(file) }}</span>
            <button
              v-if="!data.readonly"
              class="file-remove"
              type="button"
              :aria-label="t('common.delete')"
              @click.stop.prevent="removeImage(file)"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </a>
        </div>
        <button
          v-if="!data.readonly"
          class="image-upload-trigger"
          type="button"
          :disabled="uploadingAttachments"
          :aria-label="t('workflow.node.uploadImages')"
          @click.stop.prevent="openImagePicker"
          @pointerdown.stop
          @pointerup.stop
        >
          <svg v-if="!uploadingAttachments" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
          <span v-else class="image-upload-loading" aria-hidden="true" />
        </button>
      </div>
    </div>

    <Handle id="output" type="source" :position="Position.Right" class="workflow-handle output-handle" />
    <Handle id="bottom" type="source" :position="Position.Bottom" class="workflow-handle bottom-handle" />

    <Teleport to="body">
      <div
        v-if="previewVisible && isImagePath(previewPath)"
        class="image-preview-overlay"
        @click.self="previewVisible = false"
      >
        <img
          class="image-preview-img"
          :src="imageUrl(previewPath)"
          :alt="imageName(previewPath)"
          @click="previewVisible = false"
        >
      </div>
    </Teleport>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.workflow-agent-node {
  width: 100%;
  height: 100%;
  min-width: 260px;
  min-height: 360px;
  border: 1px solid $border-color;
  border-radius: 8px;
  background: $bg-card;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
  color: $text-primary;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: border-color $transition-fast, box-shadow $transition-fast, transform $transition-fast;

  &.selected {
    border-color: var(--accent-info);
    box-shadow: 0 0 0 3px rgba(var(--accent-info-rgb), 0.16), 0 12px 28px rgba(0, 0, 0, 0.12);
  }
}

.workflow-agent-node :deep(.workflow-resize-handle) {
  width: 10px;
  height: 10px;
  border: 2px solid $bg-card;
  background: var(--accent-info);
}

.workflow-agent-node :deep(.workflow-resize-line) {
  border-color: var(--accent-info);
}

.node-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid $border-light;
  font-size: 13px;
  font-weight: 600;
  flex: 0 0 auto;
  cursor: grab;

  &:active {
    cursor: grabbing;
  }
}

.node-status-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-status-with-tip {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.node-status-tip {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.node-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: #9ca3af;
}

.status-idle .node-status-dot {
  background: #9ca3af;
}

.status-queued .node-status-dot {
  background: #64748b;
}

.status-running .node-status-dot {
  background: #2563eb;
  box-shadow: 0 0 8px rgba(37, 99, 235, 0.65);
}

.status-pending_approval .node-status-dot {
  background: #d97706;
  box-shadow: 0 0 8px rgba(217, 119, 6, 0.55);
}

.status-approval_rejected .node-status-dot {
  background: #b45309;
}

.status-completed .node-status-dot {
  background: #16a34a;
}

.status-failed .node-status-dot {
  background: #dc2626;
}

.status-canceled .node-status-dot {
  background: #f97316;
}

.node-controls {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.node-field-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: $text-secondary;
  font-size: 12px;
}

.node-field-label-row {
  display: inline-flex;
  width: fit-content;
  align-items: center;
  gap: 4px;
}

.node-toggle-row {
  min-height: 28px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 2px;
  color: $text-secondary;
  font-size: 12px;
  line-height: 1.2;
}

.node-prompt-input {
  flex: 1;
  min-height: 96px;

  :deep(.n-input-wrapper),
  :deep(.n-input__textarea) {
    height: 100%;
    resize: none !important;
  }

  :deep(.n-input__textarea-el) {
    height: 100% !important;
    min-height: 84px;
    resize: none !important;

    &::-webkit-resizer {
      display: none;
    }
  }
}

.node-images {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px;
  max-height: 180px;
  overflow-y: auto;
  padding-inline-end: 2px;
}

.image-upload-input {
  display: none;
}

.image-upload-trigger {
  width: 64px;
  height: 64px;
  border: 1px dashed $border-color;
  border-radius: $radius-sm;
  background: $bg-input;
  color: $text-muted;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: border-color $transition-fast, color $transition-fast, background-color $transition-fast;

  &:hover:not(:disabled) {
    border-color: var(--accent-info);
    color: var(--accent-info);
    background: rgba(var(--accent-info-rgb), 0.08);
  }

  &:disabled {
    cursor: wait;
    opacity: 0.7;
  }
}

.image-upload-loading {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(var(--accent-info-rgb), 0.25);
  border-top-color: var(--accent-info);
  border-radius: 50%;
  animation: image-upload-spin 0.8s linear infinite;
}

@keyframes image-upload-spin {
  to {
    transform: rotate(360deg);
  }
}

.image-preview-grid {
  display: contents;
}

.image-preview {
  position: relative;
  width: 64px;
  height: 64px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  background: $bg-secondary;
  overflow: hidden;
  cursor: zoom-in;
}

.image-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.image-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.5);
  color: var(--text-on-overlay);
  appearance: none;
  cursor: pointer;
  padding: 0;
  opacity: 0;
  transition: opacity $transition-fast;

  &:hover {
    background: var(--error);
  }
}

.image-preview:hover .image-remove,
.image-remove:focus-visible {
  opacity: 1;
}

.file-paths {
  display: contents;
}

.file-path {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  width: 92px;
  min-height: 64px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  background: $bg-secondary;
  color: $text-secondary;
  padding: 8px 10px;
  cursor: pointer;
  text-decoration: none;
  overflow: hidden;

  &:hover {
    border-color: var(--accent-info);
    color: $text-primary;
  }
}

.file-icon {
  flex: 0 0 auto;
}

.file-name {
  max-width: 100%;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.5);
  color: var(--text-on-overlay);
  appearance: none;
  cursor: pointer;
  padding: 0;
  opacity: 0;
  transition: opacity $transition-fast;

  &:hover {
    background: var(--error);
  }
}

.file-path:hover .file-remove,
.file-remove:focus-visible {
  opacity: 1;
}

.image-preview-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.image-preview-img {
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
  border-radius: 4px;
  cursor: pointer;
}

@media (hover: none), (pointer: coarse) {
  .image-remove,
  .file-remove {
    opacity: 1;
    transform: scale(1);
  }
}

.workflow-handle {
  width: 16px;
  height: 16px;
  border: 2px solid $bg-card;
  background: var(--accent-info);
  opacity: 0.36;
  transition: opacity $transition-fast, transform $transition-fast, box-shadow $transition-fast;
}

.workflow-agent-node:hover .workflow-handle,
.workflow-agent-node.selected .workflow-handle,
.workflow-handle.connecting,
.workflow-handle.valid {
  opacity: 1;
  box-shadow: 0 0 0 3px rgba(var(--accent-info-rgb), 0.14);
}

.input-handle {
  left: -9px;
}

.output-handle {
  right: -9px;
}

.top-handle {
  top: -9px;
}

.bottom-handle {
  bottom: -9px;
}
</style>

<style scoped>.quality-criteria{display:grid;gap:6px}.quality-criterion{display:grid;grid-template-columns:1fr auto;gap:4px}.quality-criterion button,.quality-criteria>button{border:0;background:transparent;color:var(--text-color-2);cursor:pointer;text-align:start}</style>
