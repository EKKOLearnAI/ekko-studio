<script setup lang="ts">
// 演讲评分 · 评估报告区：生成/下载逐字稿/按演讲者导出逐字稿/导出/渲染。
// 纯展示组件：报告状态由面板提供，动作以事件回传。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NDropdown, NSpin } from 'naive-ui'
import { defineAsyncComponent } from 'vue'
import MeetingExportDropdown from '@/components/hermes/meeting/MeetingExportDropdown.vue'

const MarkdownRenderer = defineAsyncComponent(async () => (await import('@/components/hermes/chat/MarkdownRenderer.vue')).default)

const props = defineProps<{
  reportMarkdown: string
  reportError: string | null
  isGeneratingReport: boolean
  /** 是否具备生成条件（有逐字稿） */
  canGenerate: boolean
  exportTitle: string
  /** 逐字稿按演讲者分组后的演讲者名列表（'' = 未标注）；>1 人时显示按人导出下拉 */
  verbatimSpeakers?: string[]
}>()

const emit = defineEmits<{
  (e: 'generate'): void
  (e: 'download-verbatim'): void
  (e: 'download-verbatim-speaker', speaker: string): void
}>()

const { t } = useI18n()

const verbatimOptions = computed(() =>
  (props.verbatimSpeakers || []).map(sp => ({
    key: sp,
    label: sp || t('meeting.speechEval.unknownSpeaker'),
  })),
)
</script>

<template>
  <div class="report-generate-row">
    <NButton type="primary" size="small" :loading="props.isGeneratingReport" :disabled="!props.canGenerate" @click="emit('generate')">
      {{ t('meeting.speechEval.generateReport') }}
    </NButton>
    <NButton size="small" :disabled="!props.canGenerate" @click="emit('download-verbatim')">
      {{ t('meeting.speechEval.downloadVerbatim') }}
    </NButton>
    <NDropdown
      v-if="verbatimOptions.length > 1"
      trigger="click"
      :options="verbatimOptions"
      @select="(key: string | number) => emit('download-verbatim-speaker', String(key))"
    >
      <NButton size="small" :disabled="!props.canGenerate">
        {{ t('meeting.speechEval.downloadVerbatimBySpeaker') }}
      </NButton>
    </NDropdown>
  </div>

  <div v-if="props.reportError" class="report-error">{{ props.reportError }}</div>

  <div v-if="props.isGeneratingReport && !props.reportMarkdown" class="report-loading">
    <NSpin size="small" />
    <span>{{ t('meeting.speechEval.generating') }}</span>
  </div>

  <div v-if="props.reportMarkdown" class="report-content">
    <div class="report-actions">
      <MeetingExportDropdown
        :markdown="props.reportMarkdown"
        :title="props.exportTitle"
        scope="speechEval"
      />
    </div>
    <MarkdownRenderer :content="props.reportMarkdown" />
  </div>
</template>

<style scoped lang="scss">
/* --- 评估报告（自 SpeechEvaluationPanel 原样搬出） ---*/
.report-generate-row { display: flex; gap: 8px; flex-wrap: wrap; }
.report-generate-row .n-button { flex: 1; }
.report-error { font-size: 12px; color: var(--error); padding: 6px 8px; background: rgba(var(--error-rgb), 0.08); border-radius: 6px; }
.report-loading { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--n-text-color3, var(--text-primary)); }
.report-actions { display: flex; justify-content: flex-end; margin-bottom: 8px; }
.report-content { font-size: 13px; line-height: 1.6; }
</style>
