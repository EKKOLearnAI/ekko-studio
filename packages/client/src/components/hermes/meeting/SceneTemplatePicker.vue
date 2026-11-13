<script setup lang="ts">
// 场景模板卡片选择器（新建会议对话框用）
//
// speech（演讲评分）为 Toastmasters 风格场景：计时/赘语/增量评分；medical/legal/interview 目前渲染占位布局，
// 但在这里都是可选项——用户选了就按该模板新建会议。

import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { SCENE_IDS, type SceneId } from './scene-templates'

const props = defineProps<{
  modelValue: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

const { t } = useI18n()

// 每个核心模板一个简单 inline SVG（24×24 stroke 风格，跟随 currentColor）
const CORE_TEMPLATE_ICONS: Record<SceneId, string> = {
  general: `
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>`,
  business: `
    <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/>
    <polyline points="16 7 22 7 22 13"/>`,
  legal: `
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    <polyline points="9 12 11 14 15 10"/>`,
  medical: `
    <path d="M3 12h4l2-6 4 12 2-6h6"/>`,
  interview: `
    <circle cx="12" cy="12" r="10"/>
    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
    <line x1="12" y1="17" x2="12.01" y2="17"/>`,
  speech: `
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <line x1="12" y1="19" x2="12" y2="23"/>
    <line x1="8" y1="23" x2="16" y2="23"/>`,
}

interface PickerEntry {
  id: string
  icon: string
  labelKey: string
  descriptionKey: string
}

const entries = computed<PickerEntry[]>(() =>
  SCENE_IDS.map(id => ({
    id,
    icon: CORE_TEMPLATE_ICONS[id],
    labelKey: `meeting.scene.${id}`,
    descriptionKey: `meeting.scene.${id}Desc`,
  })),
)

function isSelected(id: string): boolean {
  return props.modelValue === id
}

function select(id: string) {
  if (id !== props.modelValue) {
    emit('update:modelValue', id)
  }
}
</script>

<template>
  <div class="scene-template-picker" role="radiogroup" :aria-label="t('meeting.scene.label')">
    <button
      v-for="entry in entries"
      :key="entry.id"
      type="button"
      role="radio"
      class="scene-template-picker__card" data-theme-surface="card"
      :class="{ 'scene-template-picker__card--selected': isSelected(entry.id) }"
      :aria-checked="isSelected(entry.id)"
      @click="select(entry.id)"
    >
      <span class="scene-template-picker__icon" aria-hidden="true">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          v-html="entry.icon"
        />
      </span>
      <span class="scene-template-picker__name">{{ t(entry.labelKey) }}</span>
      <span class="scene-template-picker__desc">{{ t(entry.descriptionKey) }}</span>
    </button>
  </div>
</template>

<style scoped>
.scene-template-picker {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
}
.scene-template-picker__card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--theme-card-bg, var(--bg-card));
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
  transition: border-color 120ms, background 120ms, box-shadow 120ms;
}
.scene-template-picker__card:hover {
  background: var(--bg-card-hover);
  border-color: var(--input-border-hover-color);
}
.scene-template-picker__card--selected {
  border-color: var(--accent-primary);
  background: var(--bg-card-hover);
  box-shadow: 0 0 0 1px var(--accent-primary) inset;
}
.scene-template-picker__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: var(--theme-card-bg, var(--bg-card));
  color: var(--accent-primary);
}
.scene-template-picker__card--selected .scene-template-picker__icon {
  background: var(--accent-primary);
  color: var(--text-on-accent);
}
.scene-template-picker__name {
  font-size: 14px;
  font-weight: 600;
}
.scene-template-picker__desc {
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-muted);
}
</style>