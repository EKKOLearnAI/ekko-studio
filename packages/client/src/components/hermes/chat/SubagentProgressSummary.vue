<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChatStore } from '@/stores/hermes/chat'
import type { SubagentStream } from '@/stores/hermes/chat'
import { openSubagentStream } from '@/utils/hermes/subagent-stream'

const chatStore = useChatStore()
const { t } = useI18n()
const expanded = ref(false)

const streams = computed<SubagentStream[]>(() => {
  const sid = chatStore.activeSessionId
  if (!sid) return []
  return [...chatStore.subagentStreams.values()].filter(s => s.sessionId === sid)
})
const total = computed(() => streams.value.length)
const running = computed(() => streams.value.filter(s => s.status === 'running').length)
const completed = computed(() => streams.value.filter(s => s.status === 'completed').length)
const failed = computed(() =>
  streams.value.filter(s => ['failed', 'error', 'cancelled', 'interrupted'].includes(s.status)).length,
)
const allDone = computed(() => total.value > 0 && running.value === 0)

function open(s: SubagentStream) {
  openSubagentStream(s.sessionId, `subagent:${s.subagentId}`)
}
</script>

<template>
  <template v-if="total > 0">
    <div
      class="subagent-summary"
      :class="{ done: allDone }"
      role="button"
      tabindex="0"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
      @keydown.enter.prevent="expanded = !expanded"
    >
      <div class="ss-prog" aria-hidden="true">
        <span v-for="s in streams" :key="s.subagentId" class="seg" :class="s.status"></span>
      </div>
      <span class="ss-text" dir="auto">
        <b>{{ total }}</b>&nbsp;{{ t('subagent.summaryTotal') }}
        <template v-if="running">&nbsp;·&nbsp;<span class="ss-run">{{ running }} {{ t('subagent.running') }}</span></template>
        <template v-if="completed">&nbsp;·&nbsp;<span class="ss-done">{{ completed }} {{ t('subagent.completed') }}</span></template>
        <template v-if="failed">&nbsp;·&nbsp;<span class="ss-fail">{{ failed }} {{ t('subagent.failed') }}</span></template>
      </span>
      <span class="ss-auto">{{ t('subagent.autoRecycle') }}</span>
      <svg class="ss-chev" :class="{ rot: expanded }" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9" /></svg>
    </div>
    <div v-if="expanded" class="ss-list">
      <div
        v-for="s in streams"
        :key="s.subagentId"
        class="ss-item"
        role="button"
        tabindex="0"
        @click="open(s)"
        @keydown.enter.prevent="open(s)"
      >
        <span class="ss-ic" :class="s.status" aria-hidden="true">
          <span v-if="s.status === 'running'" class="pd"></span>
          <svg v-else-if="s.status === 'completed'" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg>
          <svg v-else viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </span>
        <span class="ss-goal" dir="auto">{{ s.goal || t('subagent.noGoal') }}</span>
        <span class="ss-state" :class="s.status">{{ t(`subagent.${s.status}`) }}</span>
      </div>
    </div>
  </template>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.subagent-summary {
  position: sticky; top: 0; z-index: 5;
  display: flex; align-items: center; gap: 11px;
  padding: 9px 18px;
  background: var(--theme-card-bg, $bg-card);
  border-bottom: 1px solid $border-light;
  cursor: pointer;
  transition: border-color $transition-fast;
  &:hover { border-color: $border-color; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: -2px; }
  &.done { border-bottom-color: color-mix(in srgb, $success 35%, $border-light); }
}

.ss-prog { display: flex; gap: 4px; flex-shrink: 0; }
.seg { width: 22px; height: 6px; border-radius: 3px; background: $border-color; }
.seg.running { background: $accent-primary; }
.seg.completed { background: $success; }
.seg.failed, .seg.error, .seg.cancelled, .seg.interrupted { background: $error; }

.ss-text { font-size: 12.5px; font-weight: 600; color: $text-primary; min-width: 0; }
.ss-text b { font-weight: 700; }
.ss-run { color: $text-secondary; }
.ss-done { color: $success; }
.ss-fail { color: $error; }

.ss-auto {
  margin-left: auto; flex-shrink: 0;
  font-size: 11px; font-weight: 700; color: $success;
  border: 1px solid $border-light;
  padding: 3px 10px; border-radius: 20px;
}

.ss-chev { width: 14px; height: 14px; stroke: $text-muted; fill: none; stroke-width: 2; flex-shrink: 0; transition: transform $transition-fast; }
.ss-chev.rot { transform: rotate(180deg); }

.ss-list {
  position: sticky; top: 38px; z-index: 4;
  background: var(--theme-card-bg, $bg-card);
  border-bottom: 1px solid $border-light;
  padding: 4px 10px 8px;
}
.ss-item {
  display: flex; align-items: center; gap: 9px;
  padding: 7px 10px; border-radius: $radius-sm; cursor: pointer;
  &:hover { background: $bg-card-hover; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: -2px; }
}
.ss-ic { width: 16px; height: 16px; flex-shrink: 0; display: grid; place-items: center; }
.ss-ic svg { width: 14px; height: 14px; stroke-width: 2.6; fill: none; }
.ss-ic.completed svg { stroke: $success; }
.ss-ic.failed, .ss-ic.error, .ss-ic.cancelled, .ss-ic.interrupted svg { stroke: $error; }
.ss-ic .pd { width: 8px; height: 8px; border-radius: 50%; background: $accent-primary; position: relative; }
.ss-ic .pd::after { content: ""; position: absolute; inset: -3px; border-radius: 50%; background: $accent-primary; opacity: 0.4; animation: ssp-pulse 1.4s ease-out infinite; }
@keyframes ssp-pulse { 0% { transform: scale(0.6); opacity: 0.5; } 100% { transform: scale(1.9); opacity: 0; } }
.ss-goal { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; color: $text-primary; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ss-state { flex-shrink: 0; font-size: 11.5px; font-weight: 600; color: $text-secondary; }
.ss-state.completed { color: $success; }
.ss-state.failed, .ss-state.error, .ss-state.cancelled, .ss-state.interrupted { color: $error; }
</style>
