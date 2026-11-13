<script setup lang="ts">
// 会议模式顶部控制条：
//   - 侧栏 toggle 按钮
//   - 标题（logo + 文字）
//   - 控制按钮组：Agent 面板 / 导出会议文字 / 说话人分离 / 保存模式 / 说话人数 / 清空转写
//
// 数据与状态从父级传入，本组件只承担"显示什么"和"通知用户操作"——
// 真正的录音逻辑、Agent 状态、导出实现等都在父级。

import { useI18n } from 'vue-i18n'
import { NTooltip, NButton, NSelect } from 'naive-ui'

interface SpeakerCountOption {
  label: string
  value: number
  type?: 'group' | 'render'
  [key: string]: unknown
}

const props = defineProps<{
  sidebarExpanded: boolean
  showAgentPanel: boolean
  useDiarize: boolean
  saveMode: boolean
  speakerCount: number
  speakerCountOptions: SpeakerCountOption[]
  isRecording: boolean
  hasSentences: boolean
  hideSpeakerDiarization: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle-sidebar'): void
  (e: 'toggle-agent-panel'): void
  (e: 'export-transcript'): void
  (e: 'toggle-diarize'): void
  (e: 'toggle-save-mode'): void
  (e: 'update:speakerCount', value: number): void
  (e: 'clear-transcript'): void
}>()

const { t } = useI18n()

function onSpeakerCountUpdate(value: number | null) {
  emit('update:speakerCount', value ?? 0)
}
</script>

<template>
  <div class="meeting-header">
    <div class="meeting-title">
      <button
        type="button"
        class="header-avatar-toggle"
        :title="props.sidebarExpanded ? t('sidebar.collapse') : t('sidebar.expand')"
        @click="emit('toggle-sidebar')"
      >
        <img src="/logo.png" alt="QuantHermes" class="header-logo" />
      </button>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" />
        <path d="M8 12l3 3 5-5" />
      </svg>
      <h1>{{ t('meeting.title') }}</h1>
    </div>

    <div class="meeting-controls">
      <!-- Agent 切换 -->
      <NTooltip trigger="hover">
        <template #trigger>
          <NButton
            size="small"
            :type="props.showAgentPanel ? 'primary' : 'default'"
            @click="emit('toggle-agent-panel')"
          >
            <template #icon>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M12 2a4 4 0 0 1 4 4v2a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z" />
                <path d="M16 14H8a4 4 0 0 0-4 4v2h16v-2a4 4 0 0 0-4-4z" />
              </svg>
            </template>
            {{ t('meeting.agentChat') }}
          </NButton>
        </template>
        {{ t('meeting.showAgentChat') }}
      </NTooltip>

      <!-- 导出会议文字（ASR 逐字稿 Markdown） -->
      <NTooltip trigger="hover">
        <template #trigger>
          <NButton
            size="small"
            :disabled="!props.hasSentences"
            @click="emit('export-transcript')"
          >
            <template #icon>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="8" y1="13" x2="16" y2="13" />
                <line x1="8" y1="17" x2="13" y2="17" />
              </svg>
            </template>
            {{ t('meeting.exportTranscript') }}
          </NButton>
        </template>
        {{ props.hasSentences ? t('meeting.exportTranscriptHint') : t('meeting.noTranscript') }}
      </NTooltip>

      <template v-if="!props.hideSpeakerDiarization">
        <!-- 说话人分离开关 -->
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton
              size="small"
              :type="props.useDiarize ? 'primary' : 'default'"
              :disabled="props.isRecording"
              @click="emit('toggle-diarize')"
            >
              <template #icon>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </template>
              {{ t('meeting.diarize') }}
            </NButton>
          </template>
          {{ t('meeting.diarizeHint') }}
        </NTooltip>

        <!-- 保存模式 -->
        <NTooltip v-if="props.useDiarize" trigger="hover">
          <template #trigger>
            <NButton
              size="small"
              :type="props.saveMode ? 'warning' : 'default'"
              :disabled="props.isRecording"
              @click="emit('toggle-save-mode')"
            >
              <template #icon>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                  <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                </svg>
              </template>
              {{ props.saveMode ? t('meeting.saveMode') : t('meeting.normalMode') }}
            </NButton>
          </template>
          {{ props.saveMode ? t('meeting.saveModeHint') : t('meeting.normalModeHint') }}
        </NTooltip>

        <!-- 说话人数 -->
        <NSelect
          v-if="props.useDiarize"
          :value="props.speakerCount"
          :options="props.speakerCountOptions"
          size="small"
          :style="{ width: '120px' }"
          :disabled="props.isRecording"
          :placeholder="t('meeting.speakerCount')"
          @update:value="onSpeakerCountUpdate"
        />
      </template>

      <!-- 清空转写 -->
      <NTooltip trigger="hover">
        <template #trigger>
          <NButton
            size="small"
            type="error"
            :disabled="props.isRecording || !props.hasSentences"
            @click="emit('clear-transcript')"
          >
            <template #icon>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </template>
            {{ t('meeting.clear') }}
          </NButton>
        </template>
        {{ t('meeting.clearHint') }}
      </NTooltip>
    </div>
  </div>
</template>

<style scoped>
.meeting-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color, var(--border-color));
  background: var(--bg-card, var(--theme-card-bg, var(--theme-card-bg, var(--bg-card))));
  flex-shrink: 0;
}

.meeting-title {
  display: flex;
  align-items: center;
  gap: 8px;

  h1 {
    font-size: 16px;
    font-weight: 600;
    margin: 0;
  }

  svg {
    color: var(--accent-primary, var(--text-primary));
  }
}

.meeting-controls {
  display: flex;
  gap: 8px;
  align-items: center;
}

.header-avatar-toggle {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: all 0.2s ease;
  overflow: hidden;

  &:hover {
    background: rgba(var(--accent-primary-rgb, 26, 26, 26), 0.1);
    transform: scale(1.05);
  }

  &:active {
    transform: scale(0.95);
  }
}

.header-logo {
  width: 24px;
  height: 24px;
  object-fit: contain;
}
</style>