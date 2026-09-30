<script setup lang="ts">
import { NSpin, NAlert, NButton, NButtonGroup, NDataTable } from 'naive-ui'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { useI18n } from 'vue-i18n'
import { parseCsvPreview } from '@/utils/hermes/tabular-preview'

const props = defineProps<{
  kind: 'csv' | 'spreadsheet'
  data?: ArrayBuffer
  source?: string
}>()
const emit = defineEmits<{ (event: 'error', error: Error): void }>()
const { t } = useI18n()
const mode = ref<'table' | 'source'>('table')
const loading = ref(false)
const rows = ref<string[][]>([])
const truncated = ref(false)
const sheetNames = ref<string[]>([])
const activeSheet = ref('')
let worker: Worker | null = null

function columnLabel(index: number): string {
  let label = ''
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    label = String.fromCharCode(65 + ((value - 1) % 26)) + label
  }
  return label
}

const columnCount = computed(() => rows.value.reduce((max, row) => Math.max(max, row.length), 0))
const columns = computed(() => [
  { title: '#', key: '__row', width: 64, fixed: 'left' as const },
  ...Array.from({ length: columnCount.value }, (_, index) => ({
    title: columnLabel(index),
    key: `c${index}`,
    width: 160,
    ellipsis: { tooltip: true },
  })),
])
const tableRows = computed(() => rows.value.map((row, rowIndex) => {
  const record: Record<string, string | number> = { __row: rowIndex + 1, __key: rowIndex }
  row.forEach((cell, index) => { record[`c${index}`] = cell })
  return record
}))

function terminateWorker(): void {
  worker?.terminate()
  worker = null
}

function loadCsv(): void {
  const result = parseCsvPreview(props.source || '')
  rows.value = result.rows
  truncated.value = result.truncated
}

function loadWorkbook(): void {
  terminateWorker()
  if (!props.data) return
  loading.value = true
  worker = new Worker(new URL('./xlsx-preview.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = event => {
    const payload = event.data || {}
    if (payload.type === 'error') {
      loading.value = false
      emit('error', new Error(String(payload.error || 'Workbook parsing failed')))
      return
    }
    if (payload.sheetNames) sheetNames.value = payload.sheetNames
    activeSheet.value = String(payload.activeSheet || '')
    rows.value = Array.isArray(payload.rows) ? payload.rows : []
    truncated.value = payload.truncated === true
    loading.value = false
  }
  worker.onerror = event => {
    loading.value = false
    emit('error', new Error(event.message || 'Workbook worker failed'))
  }
  const copy = props.data.slice(0)
  worker.postMessage({ type: 'open', data: copy }, [copy])
}

function selectSheet(sheet: string): void {
  if (!worker || sheet === activeSheet.value) return
  loading.value = true
  worker.postMessage({ type: 'sheet', sheet })
}

function load(): void {
  if (props.kind === 'csv') loadCsv()
  else loadWorkbook()
}

watch(() => [props.kind, props.data, props.source], load)
onMounted(load)
onBeforeUnmount(terminateWorker)
</script>

<template>
  <div class="spreadsheet-preview">
    <div class="spreadsheet-toolbar">
      <NButtonGroup v-if="kind === 'csv'" size="small">
        <NButton :type="mode === 'table' ? 'primary' : 'default'" @click="mode = 'table'">{{ t('files.tableMode') }}</NButton>
        <NButton :type="mode === 'source' ? 'primary' : 'default'" @click="mode = 'source'">{{ t('files.sourceMode') }}</NButton>
      </NButtonGroup>
      <div v-else class="sheet-tabs">
        <span class="sheet-tabs-label">{{ t('files.worksheet') }}:</span>
        <NButton
          v-for="sheet in sheetNames"
          :key="sheet"
          size="small"
          :type="sheet === activeSheet ? 'primary' : 'default'"
          @click="selectSheet(sheet)"
        >{{ sheet }}</NButton>
      </div>
    </div>
    <NAlert v-if="truncated" type="warning" :show-icon="false">{{ t('files.tableTruncated') }}</NAlert>
    <pre v-if="kind === 'csv' && mode === 'source'" class="source-view">{{ source }}</pre>
    <NSpin v-else :show="loading" class="table-stage">
      <NDataTable
        :columns="columns"
        :data="tableRows"
        :row-key="(row: any) => row.__key"
        :max-height="560"
        :scroll-x="Math.max(720, columns.length * 160)"
        virtual-scroll
        size="small"
        striped
      />
    </NSpin>
  </div>
</template>

<style scoped lang="scss">
.spreadsheet-preview { display: flex; flex-direction: column; width: 100%; min-height: 0; gap: 10px; }
.spreadsheet-toolbar, .sheet-tabs { display: flex; gap: 6px; align-items: center; }
.sheet-tabs { overflow-x: auto; padding-bottom: 2px; }
.sheet-tabs-label { flex: 0 0 auto; font-size: 12px; color: var(--n-text-color-3); }
.sheet-tabs :deep(.n-button) { border-radius: 999px; }
.table-stage { min-height: 360px; }
.source-view { flex: 1; overflow: auto; margin: 0; padding: 14px; border-radius: 6px; background: rgba(127, 127, 127, 0.08); white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
