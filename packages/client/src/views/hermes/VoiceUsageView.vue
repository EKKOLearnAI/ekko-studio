<script setup lang="ts">
// 语音用量统计（TTS + STT）独立视图
// - 4 档时间粒度 7d/30d/90d/365d
// - 3 块：总览卡 / 区间明细 / 今日明细
import { ref, computed, onMounted, watch } from 'vue'
import { NButton, NDataTable, NTag, NEmpty, NSkeleton, NCard, NStatistic } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchVoiceUsage, type VoiceUsageRow, type VoiceUsageResponse } from '@/api/studio/voice-usage'

const { t } = useI18n()
const loading = ref(false)
const error = ref<string | null>(null)
const data = ref<VoiceUsageResponse | null>(null)

const periodOptions = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '365d', days: 365 },
] as const

const selectedDays = ref<number>(30)

async function load(days = selectedDays.value) {
  selectedDays.value = days
  loading.value = true
  error.value = null
  try {
    data.value = await fetchVoiceUsage(days)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

onMounted(() => { void load(30) })
watch(selectedDays, (d) => { void load(d) })

// 工具函数
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
function fmtNumber(n: number): string { return n.toLocaleString('zh-CN') }
function fmtTime(ts: number | undefined | null): string {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

// 区间汇总（range 是按 source+provider 分组的）
const rangeSummary = computed(() => {
  const r = data.value?.range ?? []
  const tts = r.filter(x => x.source === 'tts')
  const stt = r.filter(x => x.source === 'stt')
  const ttsCalls = tts.reduce((s: number, x: VoiceUsageRow) => s + (x.calls || 0), 0)
  const sttCalls = stt.reduce((s: number, x: VoiceUsageRow) => s + (x.calls || 0), 0)
  const ttsBytes = tts.reduce((s: number, x: VoiceUsageRow) => s + (x.output_total || 0), 0)
  const sttBytes = stt.reduce((s: number, x: VoiceUsageRow) => s + (x.input_total || 0), 0)
  const ttsChars = tts.reduce((s: number, x: VoiceUsageRow) => s + (x.input_total || 0), 0) // 字符数
  const sttChars = stt.reduce((s: number, x: VoiceUsageRow) => s + (x.output_total || 0), 0) // 转写字符数
  return { ttsCalls, sttCalls, ttsBytes, sttBytes, ttsChars, sttChars }
})

// 提供商列（区间）
const providerColumns = computed(() => [
  { title: t('voiceUsage.source'), key: 'source', width: 100,
    render: (row: VoiceUsageRow) => row.source === 'tts' ? t('voiceUsage.ttsTitle') : t('voiceUsage.sttTitle') },
  { title: t('voiceUsage.provider'), key: 'provider', width: 160 },
  { title: t('voiceUsage.calls'), key: 'calls', width: 100,
    render: (row: VoiceUsageRow) => fmtNumber(row.calls || 0) },
  { title: t('voiceUsage.audioBytes'), key: 'bytes', width: 120,
    render: (row: VoiceUsageRow) => fmtBytes(row.source === 'tts' ? (row.output_total || 0) : (row.input_total || 0)) },
  { title: t('voiceUsage.transcriptChars'), key: 'chars', width: 100,
    render: (row: VoiceUsageRow) => fmtNumber(row.source === 'tts' ? (row.input_total || 0) : (row.output_total || 0)) + ' ' + t('voiceUsage.charUnit') },
])

// 今日列
const todayColumns = computed(() => [
  { title: t('voiceUsage.source'), key: 'source', width: 100,
    render: (row: VoiceUsageRow) => row.source === 'tts' ? t('voiceUsage.ttsTitle') : t('voiceUsage.sttTitle') },
  { title: t('voiceUsage.provider'), key: 'provider', width: 160 },
  { title: t('voiceUsage.calls'), key: 'calls', width: 100,
    render: (row: VoiceUsageRow) => fmtNumber(row.calls || 0) },
])

// 按日分桶（合并 tts+stt 同一日）
const dailyMerged = computed(() => {
  const rows = data.value?.daily ?? []
  const map = new Map<string, { day: string; calls: number; ttsBytes: number; sttBytes: number; ttsChars: number; sttChars: number }>()
  for (const r of rows) {
    const cur = map.get(r.day) || { day: r.day, calls: 0, ttsBytes: 0, sttBytes: 0, ttsChars: 0, sttChars: 0 }
    if (r.source === 'tts') { cur.ttsBytes += (r.output_total || 0); cur.ttsChars += (r.input_total || 0) }
    else { cur.sttBytes += (r.input_total || 0); cur.sttChars += (r.output_total || 0) }
    cur.calls += (r.calls || 0)
    map.set(r.day, cur)
  }
  return Array.from(map.values()).sort((a, b) => a.day.localeCompare(b.day))
})

const dailyColumns = computed(() => [
  { title: t('voiceUsage.date'), key: 'day', width: 140 },
  { title: t('voiceUsage.calls'), key: 'calls', width: 90,
    render: (row: any) => fmtNumber(row.calls) },
  { title: t('voiceUsage.ttsAudio'), key: 'ttsBytes', width: 110,
    render: (row: any) => fmtBytes(row.ttsBytes) },
  { title: t('voiceUsage.sttAudio'), key: 'sttBytes', width: 110,
    render: (row: any) => fmtBytes(row.sttBytes) },
  { title: t('voiceUsage.ttsChars'), key: 'ttsChars', width: 90,
    render: (row: any) => fmtNumber(row.ttsChars) },
  { title: t('voiceUsage.sttChars'), key: 'sttChars', width: 90,
    render: (row: any) => fmtNumber(row.sttChars) },
])
</script>

<template>
  <div class="voice-usage-view">
    <header class="page-header">
      <h2 class="header-title">{{ t('voiceUsage.pageTitle') }}</h2>
      <p class="header-desc">{{ t('voiceUsage.pageDesc') }}</p>
      <div class="usage-toolbar">
        <div class="period-selector" role="group" :aria-label="t('voiceUsage.periodLabel')">
          <NButton
            v-for="option in periodOptions"
            :key="option.days"
            class="period-option"
            size="small"
            :type="selectedDays === option.days ? 'primary' : 'default'"
            :secondary="selectedDays === option.days"
            :quaternary="selectedDays !== option.days"
            :aria-pressed="selectedDays === option.days"
            @click="selectedDays = option.days"
          >
            {{ option.label }}
          </NButton>
        </div>
        <NButton size="small" quaternary :loading="loading" @click="load()">
          {{ t('voiceUsage.refresh') }}
        </NButton>
      </div>
    </header>

    <div class="usage-content">
      <NSkeleton v-if="loading && !data" text :repeat="6" style="margin: 12px 0" />
      <NEmpty v-else-if="error" :description="error" style="margin: 24px 0" />
      <template v-else-if="data">
        <!-- 概览卡 -->
        <div class="overview-grid">
          <NCard size="small" class="overview-card">
            <NStatistic :label="t('voiceUsage.ttsCalls')" :value="rangeSummary.ttsCalls" />
          </NCard>
          <NCard size="small" class="overview-card">
            <NStatistic :label="t('voiceUsage.sttCalls')" :value="rangeSummary.sttCalls" />
          </NCard>
          <NCard size="small" class="overview-card">
            <NStatistic :label="t('voiceUsage.ttsAudio')">
              <template #default>{{ fmtBytes(rangeSummary.ttsBytes) }}</template>
            </NStatistic>
          </NCard>
          <NCard size="small" class="overview-card">
            <NStatistic :label="t('voiceUsage.sttAudio')">
              <template #default>{{ fmtBytes(rangeSummary.sttBytes) }}</template>
            </NStatistic>
          </NCard>
        </div>

        <!-- 区间内：按 provider 明细 -->
        <NCard size="small" class="block">
          <template #header>
            <div class="block-header">
              <span class="block-title">{{ t('voiceUsage.rangeTitle', { days: selectedDays }) }}</span>
              <NTag size="small" round>{{ t('voiceUsage.providerDistribution') }}</NTag>
            </div>
          </template>
          <NDataTable
            v-if="data.range && data.range.length"
            :columns="providerColumns"
            :data="data.range"
            :pagination="false"
            size="small"
          />
          <NEmpty v-else :description="t('voiceUsage.noData')" size="small" />
        </NCard>

        <!-- 按日趋势 -->
        <NCard size="small" class="block">
          <template #header>
            <div class="block-header">
              <span class="block-title">{{ t('voiceUsage.dailyTitle') }}</span>
              <NTag size="small" round>{{ t('voiceUsage.dailyTag') }}</NTag>
            </div>
          </template>
          <NDataTable
            v-if="dailyMerged.length"
            :columns="dailyColumns"
            :data="dailyMerged"
            :pagination="false"
            size="small"
          />
          <NEmpty v-else :description="t('voiceUsage.noData')" size="small" />
        </NCard>

        <!-- 今日 -->
        <NCard size="small" class="block">
          <template #header>
            <div class="block-header">
              <span class="block-title">{{ t('voiceUsage.todayTitle') }}</span>
              <NTag size="small" round type="success">{{ t('voiceUsage.today') }}</NTag>
            </div>
          </template>
          <NDataTable
            v-if="data.today && data.today.length"
            :columns="todayColumns"
            :data="data.today"
            :pagination="false"
            size="small"
          />
          <NEmpty v-else :description="t('voiceUsage.noToday')" size="small" />
        </NCard>

        <p class="updated-at">{{ t('voiceUsage.updatedAt') }}: {{ fmtTime(data.generated_at) }}</p>
      </template>
    </div>
  </div>
</template>

<style scoped lang="scss">
.voice-usage-view {
  padding: 20px 24px;
  max-width: 1100px;
  margin: 0 auto;
}
.page-header { margin-bottom: 16px; }
.header-title { margin: 0; font-size: 20px; font-weight: 600; }
.header-desc { margin: 4px 0 0; font-size: 12px; opacity: 0.6; }
.usage-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.period-selector { display: inline-flex; gap: 4px; padding: 4px; background: rgba(26, 108, 181, 0.04); border-radius: 6px; }
.usage-content { display: flex; flex-direction: column; gap: 16px; }
.overview-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
@media (max-width: 720px) { .overview-grid { grid-template-columns: repeat(2, 1fr); } }
.overview-card { text-align: center; }
.block { margin-top: 0; }
.block-header { display: flex; align-items: center; gap: 8px; }
.block-title { font-size: 14px; font-weight: 600; }
.updated-at { font-size: 11px; opacity: 0.5; text-align: right; margin: 0; font-variant-numeric: tabular-nums; }
</style>
