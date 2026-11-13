<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * Right panel shell for the meeting view. Owns the outer chrome (aside,
 * resize handle, header with title + close button, scrollable inner area)
 * and exposes mutually-exclusive slots for the content modes:
 *
 *   #analysis  - rendered when !showAgentPanel && !isSpeechScene
 *   #agent     - rendered when showAgentPanel (Agent realtime assist)
 *   #speech    - rendered when isSpeechScene (SpeechEvaluationPanel)
 *
 * The header actions are always available: 下载音频 (post-recording export)
 * and 拆分人声 (send the whole recording to the ASR again, with speaker
 * labels). The toolbar above the content (analysis trigger / report buttons /
 * agent toggle) is exposed as its own slot so MeetingView keeps all the
 * Naive UI tooltip/loading wiring in one place. Resize handle is bound
 * here because it logically lives on the aside element itself; parent
 * passes a `resizeStyle` + pointerdown handler through props.
 *
 * Modes are derived in the parent and passed as booleans, not computed
 * here, so the dispatch order (speech > agent > analysis) stays explicit.
 */

const props = withDefaults(defineProps<{
  visible: boolean
  isSpeechScene: boolean
  isLegalScene?: boolean
  isInterviewScene?: boolean
  showAgentPanel: boolean
  /** 录音已完成、存在可下载的音频。 */
  canDownloadAudio?: boolean
  /** 录音已完成、存在可重新做说话人分离的音频。 */
  canDiarize?: boolean
  /** 整段人声拆分进行中（按钮转 loading 态）。 */
  isDiarizing?: boolean
  resizeStyle?: Record<string, string>
}>(), {
  canDownloadAudio: false,
  canDiarize: false,
  isDiarizing: false,
  resizeStyle: () => ({}),
})

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'download-audio'): void
  (e: 'diarize'): void
  (e: 'resize-start', event: PointerEvent): void
}>()

const { t } = useI18n()

const panelTitle = computed(() => {
  if (props.isSpeechScene) return t('meeting.scene.speech')
  if (props.isLegalScene) return t('meeting.scene.legal')
  if (props.isInterviewScene) return t('meeting.scene.interview')
  if (props.showAgentPanel) return t('meeting.agentChat')
  return t('meeting.analysis')
})
</script>

<template>
  <aside
    v-if="props.visible"
    class="right-panel"
    :style="props.resizeStyle"
  >
    <div
      class="right-panel-resize-handle"
      @pointerdown="emit('resize-start', $event)"
    />
    <div class="right-panel-inner">
      <div class="right-panel-header">
        <h2>{{ panelTitle }}</h2>
        <div class="right-panel-actions">
          <!-- 下载音频：录音完成后导出整段音频（原实时对话入口位置） -->
          <button
            class="panel-header-btn"
            :title="t('meeting.downloadAudio')"
            :aria-label="t('meeting.downloadAudio')"
            :disabled="!props.canDownloadAudio"
            @click="emit('download-audio')"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
          <!-- 拆分人声：把整段录音重新送 ASR，按发言人标注 -->
          <button
            class="panel-header-btn"
            :class="{ active: props.isDiarizing }"
            :title="t('meeting.diarizeActionHint')"
            :aria-label="t('meeting.diarizeAction')"
            :disabled="!props.canDiarize || props.isDiarizing"
            @click="emit('diarize')"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </button>
          <!-- 关闭按钮：始终位于最右，确保不被遮挡 -->
          <button
            class="panel-close-btn"
            :title="t('sidebar.collapse')"
            @click="emit('close')"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- 分析工具栏：仅在 analysis 模式下显示（parent passes the wired buttons） -->
      <div v-if="!props.showAgentPanel && !props.isSpeechScene" class="right-panel-toolbar">
        <slot name="toolbar" />
      </div>

      <!-- 内容分发：speech > agent > analysis -->
      <template v-if="props.isSpeechScene">
        <slot name="speech" />
      </template>
      <template v-else-if="props.isLegalScene">
        <slot name="legal" />
      </template>
      <template v-else-if="props.isInterviewScene">
        <slot name="interview" />
      </template>
      <template v-else-if="props.showAgentPanel">
        <slot name="agent" />
      </template>
      <template v-else>
        <slot name="analysis" />
      </template>
    </div>
  </aside>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.right-panel {
  position: relative;
  flex: 0 0 auto;
  min-width: 280px;
  max-width: 100%;
  background: var(--theme-card-bg, var(--bg-card));
  border-left: 1px solid $border-color;
  display: flex;
  align-self: stretch;
  min-height: 0;
  overflow: hidden;
}

.right-panel-resize-handle {
  position: absolute;
  left: -7px;
  top: 0;
  bottom: 0;
  width: 14px;
  cursor: col-resize;
  z-index: 20;

  &::after {
    content: "";
    position: absolute;
    left: 6px;
    top: 0;
    bottom: 0;
    width: 1px;
    background:
      linear-gradient($border-color, $border-color) top / 1px calc(50% - 26px) no-repeat,
      linear-gradient($border-color, $border-color) bottom / 1px calc(50% - 26px) no-repeat;
    transition: background $transition-fast;
    z-index: 1;
  }

  &::before {
    content: "";
    position: absolute;
    left: 1px;
    top: 50%;
    width: 12px;
    height: 38px;
    transform: translateY(-50%);
    border-radius: 6px;
    background:
      linear-gradient($text-muted, $text-muted) center 12px / 6px 1px no-repeat,
      linear-gradient($text-muted, $text-muted) center 19px / 6px 1px no-repeat,
      linear-gradient($text-muted, $text-muted) center 26px / 6px 1px no-repeat,
      var(--theme-card-bg, var(--bg-card));
    border: 1px solid $border-color;
    opacity: 0.9;
    transition: all $transition-fast;
    z-index: 2;
  }

  &:hover::after {
    background:
      linear-gradient(var(--accent-primary), var(--accent-primary)) top / 1px calc(50% - 26px) no-repeat,
      linear-gradient(var(--accent-primary), var(--accent-primary)) bottom / 1px calc(50% - 26px) no-repeat;
  }

  &:hover::before {
    background:
      linear-gradient(var(--accent-primary), var(--accent-primary)) center 12px / 6px 1px no-repeat,
      linear-gradient(var(--accent-primary), var(--accent-primary)) center 19px / 6px 1px no-repeat,
      linear-gradient(var(--accent-primary), var(--accent-primary)) center 26px / 6px 1px no-repeat,
      var(--theme-card-bg, var(--bg-card));
    border-color: var(--accent-primary);
    opacity: 1;
  }
}

.right-panel-inner {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.right-panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid $border-color;
  flex-shrink: 0;
  gap: 8px;

  h2 {
    font-size: 14px;
    font-weight: 600;
    margin: 0;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.right-panel-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

/* 分析工具栏（独立一行，承载触发/启动/配置 + Agent 切换）*/
.right-panel-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid $border-color;
  background: rgba($accent-primary, 0.02);
  flex-shrink: 0;
  min-width: 0;
}

.panel-close-btn {
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: $text-secondary;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;

  &:hover {
    background: rgba(var(--error-rgb), 0.1);
    color: var(--error);
  }
}

/* 面板头部工具按钮（实时对话入口）：与关闭按钮同尺寸，激活态跟随主题色 */
.panel-header-btn {
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: $text-secondary;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;

  &:hover {
    background: rgba($accent-primary, 0.12);
    color: $accent-primary;
  }

  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;

    &:hover {
      background: transparent;
      color: $text-secondary;
    }
  }

  &.active {
    background: rgba($accent-primary, 0.16);
    color: $accent-primary;
  }
}

/* 工具栏槽位内部按钮在窄面板中优雅收缩（扁平选择器，避免 SCSS 在 :deep 块中展开嵌套失败） */
:deep(.toolbar-actions) {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

:deep(.toolbar-actions::-webkit-scrollbar) {
  display: none;
}

:deep(.toolbar-actions .n-button) {
  flex-shrink: 0;
}

/* 分析内容槽：让父组件传入的 .right-panel-content 仍然能撑满滚动区 */
:deep(.right-panel-content) {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

:deep(.right-panel-empty) {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: $text-secondary;
  padding: 40px;
}
</style>