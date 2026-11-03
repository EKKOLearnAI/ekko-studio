<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChatStore } from '@/stores/hermes/chat'
import type { SubagentStream, SubagentStreamEntry } from '@/stores/hermes/chat'
import { openSubagentStream, subagentIdFromToolCall } from '@/utils/hermes/subagent-stream'

const props = defineProps<{ toolCallId?: string; sessionId?: string }>()

const chatStore = useChatStore()
const { t } = useI18n()

const subagentId = computed(() => subagentIdFromToolCall(props.toolCallId))
const sid = computed(() => props.sessionId || chatStore.activeSessionId)
const stream = computed<SubagentStream | null>(() =>
  subagentId.value && sid.value ? chatStore.getSubagentStream(sid.value, subagentId.value) : null,
)

const status = computed(() => stream.value?.status || 'running')
const isRunning = computed(() => status.value === 'running')
const isDone = computed(() => status.value === 'completed')
const isFailed = computed(() => ['failed', 'error', 'cancelled', 'interrupted'].includes(status.value))
const statusLabel = computed(() => t(`subagent.${status.value}`))

const pos = computed(() => {
  const s = stream.value
  if (!s) return ''
  return `${s.taskIndex + 1}/${Math.max(1, s.taskCount)}`
})

// running 时每秒 tick，显示实时耗时
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
function startTimer() { if (!timer) timer = setInterval(() => { now.value = Date.now() }, 1000) }
function stopTimer() { if (timer) { clearInterval(timer); timer = null } }
watch(isRunning, v => (v ? startTimer() : stopTimer()), { immediate: true })
onBeforeUnmount(stopTimer)

const elapsedSec = computed(() => {
  const s = stream.value
  if (!s) return 0
  if (!isRunning.value && s.durationSeconds != null && Number.isFinite(s.durationSeconds)) return Math.round(s.durationSeconds)
  return Math.max(0, Math.floor((now.value - (s.startedAt || now.value)) / 1000))
})
function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return ''
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60), r = sec % 60
  if (m >= 60) { const h = Math.floor(m / 60); return `${h}h${m % 60}m` }
  return r ? `${m}m${r}s` : `${m}m`
}
const durationText = computed(() => fmtDuration(elapsedSec.value))

const goal = computed(() => stream.value?.goal?.trim() || t('subagent.noGoal'))

// mini 步骤：最近 5 个 tool/text 事件（实时滚动）
const recentSteps = computed<SubagentStreamEntry[]>(() => {
  const entries = stream.value?.entries || []
  return entries.filter(e => e.kind === 'tool' || e.kind === 'text').slice(-5)
})
function stepLabel(entry: SubagentStreamEntry): string {
  if (entry.kind === 'tool') return entry.toolName || t('subagent.tool')
  const text = (entry.text || '').replace(/\s+/g, ' ').trim()
  return text.length > 72 ? text.slice(0, 72) + '…' : text
}

// 结果回贴内容：优先 server 的 summary，回退最后一段 text
const resultText = computed(() => {
  const s = stream.value
  if (!s) return ''
  if (s.summary && s.summary.trim()) return s.summary.trim()
  const lastText = [...s.entries].reverse().find(e => e.kind === 'text' && e.text && e.text.trim())
  return lastText?.text?.trim() || ''
})

// 完整输出 transcript（展开时）
const transcript = computed(() => {
  const s = stream.value
  if (!s) return []
  return s.entries
    .filter(e => e.kind === 'text' || e.kind === 'tool')
    .map(e => ({ kind: e.kind, text: e.kind === 'tool' ? (e.toolName || t('subagent.tool')) : (e.text || '') }))
    .filter(e => e.text)
})

const expanded = ref(false)
function toggleExpanded(ev?: Event) { ev?.stopPropagation(); expanded.value = !expanded.value }
function openDetail(ev?: Event) { ev?.stopPropagation(); if (sid.value) openSubagentStream(sid.value, props.toolCallId) }
</script>

<template>
  <section
    v-if="stream"
    class="subagent-card"
    :class="status"
    data-theme-surface="card"
    role="button"
    tabindex="0"
    :aria-label="t('subagent.open')"
    @click="openDetail"
    @keydown.enter.prevent="openDetail"
  >
    <header class="sc-head">
      <span v-if="isRunning" class="live-dot" aria-hidden="true"></span>
      <span v-else-if="isDone" class="lead done" aria-hidden="true">
        <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg>
      </span>
      <span v-else class="lead fail" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </span>
      <div class="sc-titles">
        <div class="sc-kicker">{{ t('subagent.title') }}<span v-if="pos"> · {{ pos }}</span></div>
        <div class="sc-goal" dir="auto">{{ goal }}</div>
      </div>
      <span class="badge" :class="status">{{ statusLabel }}</span>
      <span class="sc-dur">{{ durationText }}</span>
    </header>

    <!-- 运行态：mini 步骤实时滚动 -->
    <ul v-if="isRunning && recentSteps.length" class="sc-steps">
      <li
        v-for="(step, i) in recentSteps"
        :key="step.id"
        class="step"
        :class="[step.kind, { cur: i === recentSteps.length - 1 }]"
      >
        <span class="ic" aria-hidden="true">
          <svg v-if="step.kind === 'tool'" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></svg>
          <span v-else class="tdot"></span>
        </span>
        <span class="step-text" dir="auto">{{ stepLabel(step) }}</span>
      </li>
    </ul>

    <!-- 完成态：结果自动回贴（不展开即可见） -->
    <div v-if="isDone" class="sc-result">
      <div class="rc-head">
        <span class="rc-check" aria-hidden="true"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg></span>
        {{ t('subagent.resultRecycled') }}
        <span class="rc-tag">{{ t('subagent.autoRecycle') }}</span>
      </div>
      <div v-if="resultText" class="rc-concl" dir="auto">{{ resultText }}</div>
      <div v-else class="rc-empty">{{ t('subagent.noResult') }}</div>
      <button v-if="transcript.length" type="button" class="rc-toggle" @click="toggleExpanded">
        {{ expanded ? t('subagent.collapseOutput') : t('subagent.expandOutput') }}
        <svg class="chev" :class="{ rot: expanded }" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6" /></svg>
      </button>
      <div v-if="expanded && transcript.length" class="rc-detail">
        <div v-for="(line, i) in transcript" :key="i" class="dl" :class="line.kind" dir="auto">
          <span v-if="line.kind === 'tool'" class="dl-tool">{{ t('subagent.tool') }}: {{ line.text }}</span>
          <template v-else>{{ line.text }}</template>
        </div>
      </div>
    </div>

    <!-- 失败态：醒目红框 + 失败原因 + 可展开过程 -->
    <div v-if="isFailed" class="sc-failed-box">
      <div class="sc-failed-head">
        <span class="sc-failed-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" /></svg></span>
        {{ statusLabel }}
      </div>
      <div v-if="resultText" class="sc-failed-concl" dir="auto">{{ resultText }}</div>
      <button v-if="transcript.length" type="button" class="rc-toggle" @click="toggleExpanded">
        {{ expanded ? t('subagent.collapseOutput') : t('subagent.expandOutput') }}
        <svg class="chev" :class="{ rot: expanded }" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6" /></svg>
      </button>
      <div v-if="expanded && transcript.length" class="rc-detail">
        <div v-for="(line, i) in transcript" :key="i" class="dl" :class="line.kind" dir="auto">
          <span v-if="line.kind === 'tool'" class="dl-tool">{{ t('subagent.tool') }}: {{ line.text }}</span>
          <template v-else>{{ line.text }}</template>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.subagent-card {
  width: 100%;
  max-width: 780px;
  background: $bg-card;
  color: $text-primary;
  border: var(--border-width, 1px) solid $border-light;
  border-left: 3px solid $border-color;
  border-radius: var(--radius-component, 10px);
  padding: 10px 13px;
  cursor: pointer;
  text-align: start;
  transition: border-color $transition-fast;

  &:hover { border-color: $border-color; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: -2px; }
  &.running { border-left-color: $accent-primary; }
  &.completed { border-left-color: $success; }
  &.failed, &.error, &.cancelled, &.interrupted { border-left-color: $error; }
}

.sc-head { display: flex; align-items: center; gap: 10px; }
.live-dot {
  width: 9px; height: 9px; border-radius: 50%;
  background: $accent-primary; flex-shrink: 0; position: relative;
  &::after {
    content: ""; position: absolute; inset: -3px; border-radius: 50%;
    background: $accent-primary; opacity: 0.4; animation: sac-pulse 1.4s ease-out infinite;
  }
}
@keyframes sac-pulse { 0% { transform: scale(0.6); opacity: 0.5; } 100% { transform: scale(1.9); opacity: 0; } }
.lead { width: 18px; height: 18px; flex-shrink: 0; display: grid; place-items: center; }
.lead svg { width: 17px; height: 17px; stroke-width: 2.6; fill: none; }
.lead.done svg { stroke: $success; }
.lead.fail svg { stroke: $error; }

.sc-titles { min-width: 0; flex: 1; }
.sc-kicker { font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: $text-muted; }
.sc-goal { font-size: 13.5px; font-weight: 600; color: $text-primary; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.badge { font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 20px; flex-shrink: 0; }
.badge.running { background: $accent-primary; color: var(--text-on-accent, #fff); }
.badge.completed { background: $success; color: var(--text-on-accent, #fff); }
.badge.failed, .badge.error, .badge.cancelled, .badge.interrupted { background: $error; color: var(--text-on-accent, #fff); }
.sc-dur { font-size: 12px; color: $text-muted; flex-shrink: 0; font-variant-numeric: tabular-nums; }

.sc-steps { list-style: none; margin: 8px 0 0; padding: 0 0 0 2px; }
.step { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 12.5px; color: $text-secondary; }
.step .ic { width: 14px; height: 14px; flex-shrink: 0; display: grid; place-items: center; }
.step .ic svg { width: 13px; height: 13px; stroke: $text-muted; fill: none; stroke-width: 2; }
.step .tdot { width: 6px; height: 6px; border-radius: 50%; background: $text-muted; }
.step.cur { color: $text-primary; font-weight: 600; }
.step.cur .tdot { background: $accent-primary; }
.step-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.sc-result { margin-top: 10px; padding: 10px 12px; border-radius: $radius-md; border: 1px solid $border-light; cursor: default; }
.rc-head { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 700; color: $success; }
.rc-check { width: 16px; height: 16px; border-radius: 50%; background: $success; display: grid; place-items: center; flex-shrink: 0; }
.rc-check svg { width: 11px; height: 11px; stroke: var(--text-on-accent, #fff); stroke-width: 3; fill: none; }
.rc-tag { margin-left: auto; font-size: 10.5px; font-weight: 600; color: $text-secondary; border: 1px solid $border-light; padding: 2px 8px; border-radius: 20px; }
.rc-concl { margin-top: 8px; font-size: 13px; line-height: 1.6; color: $text-primary; }
.rc-empty { margin-top: 8px; font-size: 12.5px; color: $text-muted; }
.rc-toggle { margin-top: 9px; display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; color: $accent-primary; background: transparent; border: 0; cursor: pointer; padding: 0; }
.rc-toggle:hover { color: $accent-hover; }
.rc-toggle .chev { width: 12px; height: 12px; stroke: currentColor; fill: none; stroke-width: 2.4; transition: transform $transition-fast; }
.rc-toggle .chev.rot { transform: rotate(90deg); }
.rc-detail { margin-top: 8px; padding: 9px 11px; border-radius: $radius-sm; border: 1px solid $border-light; max-height: 240px; overflow-y: auto; }
.dl { font-size: 12px; line-height: 1.6; color: $text-secondary; margin-bottom: 5px; }
.dl:last-child { margin-bottom: 0; }
.dl.tool { color: $text-muted; }
.dl .dl-tool { font-weight: 600; color: $text-secondary; }

.sc-failed-box { margin-top: 10px; padding: 10px 12px; border-radius: $radius-md; border: 1px solid $error; }
.sc-failed-head { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 700; color: $error; }
.sc-failed-icon { width: 16px; height: 16px; border-radius: 50%; background: $error; display: grid; place-items: center; flex-shrink: 0; }
.sc-failed-icon svg { width: 11px; height: 11px; stroke: var(--text-on-accent, #fff); stroke-width: 3; fill: none; }
.sc-failed-concl { margin-top: 8px; font-size: 13px; line-height: 1.6; color: $text-primary; }
</style>
