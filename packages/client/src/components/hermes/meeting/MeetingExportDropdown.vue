<script setup lang="ts">
import { computed, h, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NDropdown, type DropdownOption } from 'naive-ui'
import {
  useMeetingReportExport,
  type ExportFormat,
} from '@/composables/useMeetingReportExport'

interface Props {
  /** 报告 Markdown 文本。空字符串时主按钮置灰，箭头按钮可切换。 */
  markdown: string
  /** 报告标题（用于文件名、文档元信息）。 */
  title: string
/**
 * i18n 命名空间前缀（拼在 `meeting.` 之后）：
 *   - 'reportPanel' → meeting.reportPanel.{exportWord,exportHtml,exportMarkdown}
 *   - 'speechEval' → meeting.speechEval.{exportWord,exportHtml,exportMarkdown}
 */
scope: 'reportPanel' | 'speechEval' | 'legalReview' | 'interviewReview'
  /** 按钮尺寸（默认 tiny，对齐原 NButton size="tiny"）。 */
  buttonSize?: 'tiny' | 'small' | 'medium'
}

const props = withDefaults(defineProps<Props>(), {
  buttonSize: 'tiny',
})

const emit = defineEmits<{
  /** 触发导出时同步一次，回传最终落盘的格式。 */
  (e: 'exported', format: ExportFormat): void
}>()

const { t } = useI18n()

const { isExporting, exportAs } = useMeetingReportExport(
  () => props.markdown,
  () => props.title,
)

// 朴素的内联 chevron 图标，避免引入额外 @vicons/* 依赖。
const ChevronIcon = () =>
  h(
    'svg',
    {
      width: 10,
      height: 10,
      viewBox: '0 0 12 12',
      fill: 'none',
      'aria-hidden': 'true',
    },
    [
      h('path', {
        d: 'M3 4.5 L6 7.5 L9 4.5',
        stroke: 'currentColor',
        'stroke-width': 1.4,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }),
    ],
  )

const primaryLabel = computed(() =>
  isExporting.value ? t(`meeting.${props.scope}.exporting`) : t(`meeting.${props.scope}.exportWord`),
)

const dropdownLabel = t('meeting.reportExport.moreFormats')

const options = computed<DropdownOption[]>(() => [
  { label: t(`meeting.${props.scope}.exportWord`), key: 'docx' },
  { label: t(`meeting.${props.scope}.exportHtml`), key: 'html' },
  { label: t(`meeting.${props.scope}.exportMarkdown`), key: 'markdown' },
])

const dropdownVisible = ref(false)

async function handlePrimary() {
  if (!props.markdown || isExporting.value) return
  await exportAs('docx')
  emit('exported', 'docx')
}

async function handleSelect(key: ExportFormat) {
  dropdownVisible.value = false
  if (!props.markdown || isExporting.value) return
  await exportAs(key)
  emit('exported', key)
}

function toggleDropdown() {
  if (isExporting.value) return
  dropdownVisible.value = !dropdownVisible.value
}
</script>

<template>
  <div class="meeting-export-dropdown">
    <NButton
      class="meeting-export-dropdown__primary"
      :size="buttonSize"
      :loading="isExporting"
      :disabled="!markdown"
      @click="handlePrimary"
    >
      {{ primaryLabel }}
    </NButton>
    <NDropdown
      placement="bottom-end"
      trigger="manual"
      :options="options"
      :show="dropdownVisible"
      @select="handleSelect"
      @clickoutside="dropdownVisible = false"
    >
      <NButton
        class="meeting-export-dropdown__split"
        :size="buttonSize"
        :disabled="!markdown"
        :loading="isExporting"
        :title="dropdownLabel"
        :aria-label="dropdownLabel"
        @click="toggleDropdown"
      >
        <ChevronIcon />
      </NButton>
    </NDropdown>
  </div>
</template>

<style scoped>
.meeting-export-dropdown {
  display: inline-flex;
  align-items: stretch;
}
.meeting-export-dropdown :deep(.meeting-export-dropdown__primary),
.meeting-export-dropdown :deep(.meeting-export-dropdown__split) {
  /* 拼接缝处不要双倍圆角：左侧按钮右圆角收紧，右侧按钮左圆角收紧。 */
  border-radius: 0;
}
.meeting-export-dropdown :deep(.meeting-export-dropdown__primary) {
  border-top-left-radius: 3px;
  border-bottom-left-radius: 3px;
}
.meeting-export-dropdown :deep(.meeting-export-dropdown__split) {
  border-top-right-radius: 3px;
  border-bottom-right-radius: 3px;
  border-left: 1px solid rgba(var(--text-primary-rgb), 0.18);
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 26px;
}
</style>