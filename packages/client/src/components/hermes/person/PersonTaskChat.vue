<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NSpin, NSelect } from 'naive-ui'
import { usePersonTaskPanel } from './usePersonTaskPanel'
import PersonTaskConversation from './PersonTaskConversation.vue'
import { buildContentBlocks, uploadFiles, type Attachment } from '@/stores/hermes/chat'
import { personRequest, personTaskCanStop, stopPersonTask, removePersonTaskMessage, type PersonTask, type PersonExecutionSummary, type PersonTaskQueueState } from '@/api/person'
import { onPersonUpdated } from '@/api/studio/chat'
import { clientUuid } from '@/utils/secure-uuid'
import type { SessionSummary } from '@/api/studio/sessions'
import { createRefreshQueue } from '@/utils/refresh-queue'
import { useReducedMotion } from '@/composables/useReducedMotion'
const props = defineProps<{ taskId: string; mainSessionId: string; executionId?: string }>()
const emit = defineEmits<{ close: [restoreFocus: boolean] }>()
const { t } = useI18n()
const reducedMotion = useReducedMotion()
const taskPanel = useTemplateRef<HTMLElement>('taskPanel')
const { isMobile, width, maxWidth, startResize, resizeWithKeyboard } = usePersonTaskPanel(taskPanel)
const selectedExecutionId = ref(props.executionId || '')
const executions = ref<PersonExecutionSummary[]>([])
const executionOptions = computed(() => {
  const seen = new Set<string>()
  return executions.value.filter(run => { if (seen.has(run.session_id)) return false; seen.add(run.session_id); return true })
    .map(run => ({ value: run.session_id, label: `${new Date(run.created_at).toLocaleString()} · ${t(`person.states.${run.state}`)}` }))
})
const selectedIsCurrent = computed(() => executions.value.some(run => run.id === task.value?.execution_id && run.session_id === session.value?.id))
const task = ref<PersonTask | null>(null)
const session = ref<SessionSummary | null>(null)
const conversationRef = ref<InstanceType<typeof PersonTaskConversation> | null>(null)
const pending = ref<{ id: string; input: { type: string; text?: string; name?: string }[] }[]>([])
const queueState = ref<PersonTaskQueueState>({})
const requestingInsertion = ref('')
const requestingRemoval = ref('')
const refreshing = ref(false)
const removalError = ref('')
const ready = ref(false)
const loading = ref(true)
const loadError = ref(false)
const closing = ref(false)
let restoreFocus = false
let disposed = false
const sending = ref(false)
const stopping = ref(false)
const error = ref('')
const lifetime = new AbortController()
const disabled = computed(() => !ready.value || closing.value || sending.value || stopping.value || !!requestingInsertion.value || !!requestingRemoval.value || task.value?.execution_state === 'stopping' || task.value?.status === 'closed')
const queueDisabled = computed(() => disabled.value || refreshing.value)
const canRemove = computed(() => selectedIsCurrent.value && task.value?.status === 'open' && queueState.value.canRemove === true)
const stopControl = computed(() => ({ active: selectedIsCurrent.value && personTaskCanStop(task.value), allowSend: true, pending: stopping.value || task.value?.execution_state === 'stopping', request: stopTask }))
const reads = createRefreshQueue({
  load: (executionId, signal) => {
    refreshing.value = true
    return personRequest<PersonTaskQueueState & { task: PersonTask; session: SessionSummary | null; pending?: typeof pending.value; execution: PersonExecutionSummary | null; executions: PersonExecutionSummary[] }>(`/tasks/${encodeURIComponent(props.taskId)}/chat${executionId ? `?execution_id=${encodeURIComponent(executionId)}` : ''}`, undefined, 'GET', signal)
  },
  apply: result => {
    task.value = result.task; session.value = result.session; pending.value = result.pending || []
    queueState.value = result
    executions.value = result.executions; selectedExecutionId.value = result.execution?.id || ''
    ready.value = true; loading.value = false; loadError.value = false; refreshing.value = false
  },
  failed: () => { loading.value = false; loadError.value = true; refreshing.value = false },
})
function refresh(executionId = selectedExecutionId.value) {
  if (!ready.value) loading.value = true
  loadError.value = false
  return reads.refresh(executionId)
}
const stopUpdates = onPersonUpdated(event => {
  if ((!event.session_id || event.session_id === props.mainSessionId) && !sending.value && !stopping.value && !requestingInsertion.value && !requestingRemoval.value) void refresh()
})
onMounted(() => { void refresh() })
async function send(text: string, attachments?: Attachment[]) {
  if (disabled.value || !task.value) return false
  sending.value = true; error.value = ''; removalError.value = ''; refreshing.value = false
  reads.cancel()
  try {
    const input = await buildContentBlocks(text, attachments, await uploadFiles(attachments || []))
    const result = await personRequest<{ task: PersonTask; pending?: typeof pending.value }>(`/tasks/${encodeURIComponent(props.taskId)}/chat`, {
      input, execution_id: selectedExecutionId.value || undefined, expected_execution_id: task.value.execution_id || null, expected_revision: task.value.revision, idempotency_key: clientUuid(),
    }, 'POST', lifetime.signal)
    task.value = result.task; pending.value = result.pending || []
    await refresh()
    return true
  } catch (e) { if (!lifetime.signal.aborted) { error.value = String(e); await refresh() }; return false }
  finally { sending.value = false }
}
function close() {
  if (closing.value) return
  restoreFocus = !!taskPanel.value?.contains(document.activeElement)
  closing.value = true; reads.dispose(); lifetime.abort(); stopUpdates()
}
function disablePanel(element: Element) {
  // Keep the leaving panel visible without accepting focus or further actions.
  const panel = element as HTMLElement
  panel.inert = true
  element.setAttribute('aria-hidden', 'true')
}
function finishClose() {
  if (!disposed) emit('close', restoreFocus)
}
async function insert(queueId: string) {
  if (queueDisabled.value || !task.value || !selectedIsCurrent.value || !queueState.value.canInsert || requestingInsertion.value || queueState.value.insertion) return
  requestingInsertion.value = queueId; error.value = ''; removalError.value = ''; reads.cancel()
  try {
    await personRequest(`/tasks/${encodeURIComponent(props.taskId)}/queue/insert`, {
      queue_id: queueId, expected_execution_id: task.value.execution_id, expected_revision: task.value.revision, idempotency_key: clientUuid(),
    }, 'POST', lifetime.signal)
  } catch (e) { if (!lifetime.signal.aborted) error.value = String(e) }
  finally { if (!lifetime.signal.aborted) await refresh(); requestingInsertion.value = '' }
}
async function remove(queueId: string) {
  if (queueDisabled.value || !task.value || !canRemove.value || queueState.value.insertion?.queueId === queueId || !pending.value.some(item => item.id === queueId)) return
  requestingRemoval.value = queueId; removalError.value = ''; error.value = ''
  reads.cancel()
  try {
    const result = await removePersonTaskMessage(task.value, queueId, lifetime.signal)
    if (!lifetime.signal.aborted) {
      // Keep the confirmed snapshot even if the following refresh fails.
      task.value = result.task; pending.value = result.pending; queueState.value = result
    }
  } catch (e) { if (!lifetime.signal.aborted) removalError.value = String(e) }
  finally { if (!lifetime.signal.aborted) await refresh(); requestingRemoval.value = '' }
}
async function stopTask() {
  if (!selectedIsCurrent.value || !task.value || !personTaskCanStop(task.value) || disabled.value) return
  stopping.value = true; error.value = ''; removalError.value = ''; refreshing.value = false; reads.cancel()
  try {
    await stopPersonTask(task.value, lifetime.signal)
  } catch (e) { if (!lifetime.signal.aborted) error.value = String(e) }
  finally { if (!lifetime.signal.aborted) await refresh(); stopping.value = false }
}
function handleEscape(event: KeyboardEvent) {
  // Let dialogs and the shared tools drawer handle their own Escape first.
  if (event.key !== 'Escape' || event.defaultPrevented
    || [...document.querySelectorAll('.person-tools-panel, .n-drawer, .n-modal, .n-dialog, [role="listbox"]')]
      .some(element => element.getClientRects().length > 0
        && ![...element.classList].some(name => name.endsWith('-leave-active')))) return
  event.preventDefault()
  void close()
}
onMounted(() => window.addEventListener('keydown', handleEscape))
onBeforeUnmount(() => {
  disposed = true
  reads.dispose(); lifetime.abort(); stopUpdates()
  window.removeEventListener('keydown', handleEscape)
})
defineExpose({ session, send, panelWidth: width, addFiles: (files: File[]) => conversationRef.value?.addFiles(files) })
</script>

<template>
  <Transition name="person-task-panel" appear :css="!reducedMotion" @before-leave="disablePanel" @after-leave="finishClose">
  <aside v-if="!closing" ref="taskPanel" class="person-task-chat" data-theme-surface="card" role="complementary"
    :aria-label="task?.title || t('person.tasks')" :style="{ '--person-task-panel-width': `${width}px` }">
      <div v-if="!isMobile" class="task-chat-resize" role="separator" tabindex="0" aria-orientation="vertical"
        :aria-label="t('person.tasks')" :aria-valuemin="320" :aria-valuemax="maxWidth" :aria-valuenow="Math.round(width)"
        @pointerdown="startResize" @keydown="resizeWithKeyboard" />
      <header class="task-chat-heading">
        <span>{{ task?.title || t('person.tasks') }}</span>
        <NButton quaternary circle size="small" :aria-label="t('common.close')" @click="close">×</NButton>
      </header>
      <div class="task-chat-layout">
      <div class="task-chat-main">
      <NAlert v-if="removalError || error || queueState.insertionError" type="error" class="task-chat-alert">{{ removalError || error || queueState.insertionError }}</NAlert>
      <NAlert v-if="loadError" type="error" class="task-chat-alert">
        {{ t('sessionTasks.loadFailed') }} <NButton size="small" :disabled="sending || stopping || !!requestingInsertion || !!requestingRemoval || refreshing" @click="refresh()">{{ t('sessionTasks.retry') }}</NButton>
      </NAlert>
      <div v-if="loading && !ready" class="task-chat-loading"><NSpin /></div>
      <template v-else-if="ready">
        <NSelect v-if="executionOptions.length > 1" class="task-executions" :value="session?.id" :options="executionOptions"
          :disabled="sending || stopping || !!requestingInsertion || !!requestingRemoval || refreshing" :aria-label="t('person.executionHistory')" @update:value="value => refresh(executions.find(run => run.session_id === value)?.id)" />
        <PersonTaskConversation v-if="session" ref="conversationRef" :key="session.id" :session="session" :pending="pending" :send="send"
          :can-insert="selectedIsCurrent && !!queueState.canInsert && !queueDisabled" :can-remove="canRemove" :queue-disabled="queueDisabled" :requesting-removal="requestingRemoval" :remove="remove" :insertion="queueState.insertion" :requesting-insertion="requestingInsertion" :insert="insert"
          :disabled="disabled" :stop-control="stopControl" />
        <p v-else class="task-chat-alert">{{ t('person.noExecution') }}</p>
      </template>
      </div>
      </div>
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
.task-chat-layout { position: relative; display: flex; flex: 1; min-height: 0; min-width: 0; overflow: hidden; }
.task-chat-main { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; }
.task-executions { flex-shrink: 0; padding: 8px 16px; }
.task-chat-alert { margin: 12px; flex-shrink: 0; }
.task-chat-loading { flex: 1; display: grid; place-items: center; }
.task-chat-heading { display: flex; align-items: center; gap: 12px; min-width: 0; padding: 12px 16px; border-bottom: var(--border-width, 1px) solid $border-color; }
.task-chat-heading > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
