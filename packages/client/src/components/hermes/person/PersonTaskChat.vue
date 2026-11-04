<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NSpin } from 'naive-ui'
import { usePersonTaskPanel } from './usePersonTaskPanel'
import PersonTaskChatContent from './PersonTaskChatContent.vue'
import PersonTaskIdentity from './PersonTaskIdentity.vue'
import { useReducedMotion } from '@/composables/useReducedMotion'
import type { Attachment } from '@/stores/hermes/chat'
import type { PersonAgentPreset } from '@/api/person'
const props = defineProps<{ taskId?: string | null; mainSessionId: string; executionId?: string; agents?: PersonAgentPreset[]; loading?: boolean; canClose?: () => boolean }>()
const emit = defineEmits<{ close: [restoreFocus: boolean] }>()
const { t } = useI18n()
const reducedMotion = useReducedMotion()
const taskPanel = useTemplateRef<HTMLElement>('taskPanel')
const { isMobile, width, maxWidth, startResize, resizeWithKeyboard } = usePersonTaskPanel(taskPanel)
const content = ref<InstanceType<typeof PersonTaskChatContent> | null>(null)
const currentContent = computed(() => !props.loading && content.value?.task?.id === props.taskId ? content.value : null)
const task = computed(() => currentContent.value?.task)
const session = computed(() => currentContent.value?.session)
const closing = ref(false)
let restoreFocus = false
let disposed = false
function close() {
  if (closing.value || props.canClose?.() === false) return
  restoreFocus = !!taskPanel.value?.contains(document.activeElement)
  closing.value = true
}
function disablePanel(element: Element) {
  const panel = element as HTMLElement
  panel.inert = true
  element.setAttribute('aria-hidden', 'true')
}
function finishClose() { if (!disposed) emit('close', restoreFocus) }
function handleEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented
    || [...document.querySelectorAll('.person-tools-panel, .n-drawer, .n-modal, .n-dialog, [role="listbox"]')]
      .some(element => element.getClientRects().length > 0
        && ![...element.classList].some(name => name.endsWith('-leave-active')))) return
  event.preventDefault()
  close()
}
onMounted(() => window.addEventListener('keydown', handleEscape))
onBeforeUnmount(() => { disposed = true; window.removeEventListener('keydown', handleEscape) })
defineExpose({ session, panelWidth: width,
  send: (text: string, attachments?: Attachment[]) => !closing.value && currentContent.value?.send(text, attachments) || Promise.resolve(false),
  addFiles: (files: File[]) => { if (!closing.value) currentContent.value?.addFiles(files) },
})
</script>
<template>
  <Transition name="person-task-panel" appear :css="!reducedMotion" @before-leave="disablePanel" @after-leave="finishClose">
  <aside v-if="!closing" ref="taskPanel" class="person-task-chat" data-theme-surface="card" role="complementary"
    :aria-label="task?.title || t('person.tasks')" :style="{ '--person-task-panel-width': `${width}px` }">
      <div v-if="!isMobile" class="task-chat-resize" role="separator" tabindex="0" aria-orientation="vertical"
        :aria-label="t('person.tasks')" :aria-valuemin="320" :aria-valuemax="maxWidth" :aria-valuenow="Math.round(width)"
        @pointerdown="startResize" @keydown="resizeWithKeyboard" />
      <header class="task-chat-heading">
        <PersonTaskIdentity v-if="task" :task="task" :agents="agents" />
        <span v-else>{{ t('person.tasks') }}</span>
        <NButton quaternary circle size="small" :aria-label="t('common.close')" @click="close">×</NButton>
      </header>
      <PersonTaskChatContent v-if="taskId && !loading && !closing" ref="content" :key="`${mainSessionId}:${taskId}:${executionId || ''}`"
        :task-id="taskId" :main-session-id="mainSessionId" :execution-id="executionId" />
      <div v-else-if="loading" class="task-chat-loading"><NSpin /></div>
      <p v-else class="task-chat-alert">{{ t('person.noExecution') }}</p>
  </aside>
  </Transition>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.person-task-chat { position: relative; display: flex; flex-direction: column; flex-shrink: 0; width: var(--person-task-panel-width); min-width: 0; min-height: 0; height: 100%; border-inline-start: var(--border-width, 1px) solid $border-color; }
.person-task-panel-enter-active, .person-task-panel-leave-active {
  overflow: hidden;
  pointer-events: none;
  transition: width 0.25s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.16s ease;
}
.person-task-panel-enter-from, .person-task-panel-leave-to { width: 0; opacity: 0; }
.task-chat-resize { position: absolute; inset-inline-start: -3px; top: 0; bottom: 0; width: 6px; z-index: 3; cursor: col-resize; touch-action: none; }
.task-chat-resize:focus-visible { outline: 2px solid $accent-primary; outline-offset: -2px; }
.task-chat-alert { margin: 12px; flex-shrink: 0; }
.task-chat-loading { flex: 1; display: grid; place-items: center; }
.task-chat-heading { display: flex; align-items: center; gap: 12px; min-width: 0; padding: 12px 16px; border-bottom: var(--border-width, 1px) solid $border-color; }
.task-chat-heading > span, .task-chat-heading > .person-task-identity { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 768px) {
  .person-task-chat { position: absolute; inset: 0; z-index: 80; border-inline-start: 0; }
  .person-task-panel-enter-active, .person-task-panel-leave-active { transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.16s ease; }
  .person-task-panel-enter-from, .person-task-panel-leave-to { width: var(--person-task-panel-width); transform: translateX(100%); }
  .person-task-panel-enter-from:dir(rtl), .person-task-panel-leave-to:dir(rtl) { transform: translateX(-100%); }
}
@media (prefers-reduced-motion: reduce) {
  .person-task-panel-enter-active, .person-task-panel-leave-active { transition: none; }
}
</style>
