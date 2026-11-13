<script setup lang="ts">
import { ref, watch, computed, defineAsyncComponent } from 'vue'
import { NSpin, NEmpty, NCollapse, NCollapseItem } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { listCronRuns, readCronRun } from '@/api/hermes/cron-history'
import type { RunEntry, RunDetail } from '@/api/hermes/cron-history'

const MarkdownRenderer = defineAsyncComponent(async () => (await import('@/components/hermes/chat/MarkdownRenderer.vue')).default)

const props = defineProps<{
  selectedJobId: string | null
  jobNameMap: Record<string, string>
  profileKey: string
}>()

const { t } = useI18n()
const loading = ref(false)
const runs = ref<RunEntry[]>([])
const expandedContent = ref<Record<string, string>>({})
const loadingContent = ref<Record<string, boolean>>({})

const filteredRuns = computed(() => {
  if (!props.selectedJobId) return runs.value
  return runs.value.filter(r => r.jobId === props.selectedJobId)
})

async function fetchRuns() {
  loading.value = true
  try {
    runs.value = await listCronRuns(props.selectedJobId ?? undefined)
  } catch (err) {
    console.error('Failed to fetch cron runs:', err)
    runs.value = []
  } finally {
    loading.value = false
  }
}

async function handleExpand(key: string | number | Array<string | number>) {
  // accordion mode emits a single value; non-accordion emits an array
  const keys = Array.isArray(key) ? key : key != null ? [key] : []
  for (const raw of keys) {
    const k = String(raw)
    if (expandedContent.value[k] || loadingContent.value[k]) continue

    const run = filteredRuns.value.find(r => `${r.jobId}/${r.fileName}` === k)
    if (!run) continue

    loadingContent.value[k] = true
    try {
      const detail: RunDetail = await readCronRun(run.jobId, run.fileName)
      expandedContent.value[k] = detail.content
    } catch (err) {
      expandedContent.value[k] = `[Error loading content]`
    } finally {
      loadingContent.value[k] = false
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function getJobName(jobId: string): string {
  return props.jobNameMap[jobId] || jobId
}

watch(() => [props.selectedJobId, props.profileKey], () => {
  expandedContent.value = {}
  fetchRuns()
}, { immediate: true })
</script>

<template>
  <div class="run-history">
    <div class="history-header">
      <span class="history-title">{{ t('jobs.runHistory.title') }}</span>
      <span class="history-count">{{ filteredRuns.length }} {{ t('jobs.runHistory.runs') }}</span>
    </div>

    <div class="history-body">
      <NSpin :show="loading">
        <NEmpty v-if="!loading && filteredRuns.length === 0" :description="t('jobs.runHistory.noRuns')" />

        <NCollapse
          v-else
          accordion
          @update:expanded-names="handleExpand"
        >
          <NCollapseItem
            v-for="run in filteredRuns"
            :key="`${run.jobId}/${run.fileName}`"
            :title="`${getJobName(run.jobId)} — ${run.runTime}`"
            :name="`${run.jobId}/${run.fileName}`"
          >
            <template #header-extra>
              <span class="run-meta">{{ formatSize(run.size) }}</span>
            </template>

            <NSpin v-if="loadingContent[`${run.jobId}/${run.fileName}`]" size="small" />
            <MarkdownRenderer v-else-if="expandedContent[`${run.jobId}/${run.fileName}`]" :content="expandedContent[`${run.jobId}/${run.fileName}`]" />
          </NCollapseItem>
        </NCollapse>
      </NSpin>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.run-history {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.history-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: calc(12px * var(--spacing-scale, 1)) calc(20px * var(--spacing-scale, 1));
  border-bottom: var(--border-width, 1px) solid $border-light;
  flex-shrink: 0;
}

.history-title {
  font-size: calc(var(--font-size-base, 14px) * 14 / 14);
  font-weight: 600;
  color: $text-primary;
}

.history-count {
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  color: $text-muted;
}

.history-body {
  flex: 1;
  overflow-y: auto;
  padding: calc(8px * var(--spacing-scale, 1)) calc(20px * var(--spacing-scale, 1)) calc(20px * var(--spacing-scale, 1));
}

.run-meta {
  font-size: calc(var(--font-size-base, 14px) * 11 / 14);
  color: $text-muted;
  font-family: var(--font-code, $font-code);
}
</style>
