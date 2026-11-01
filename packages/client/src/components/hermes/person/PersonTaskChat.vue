<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NDrawer, NDrawerContent, NSpin, NSelect } from 'naive-ui'
import { useTaskDrawerLayout } from '@/components/hermes/tasks/useTaskDrawerLayout'
import PersonTaskConversation from './PersonTaskConversation.vue'
import PersonWorkspaceFiles from './PersonWorkspaceFiles.vue'
import { buildContentBlocks, uploadFiles, type Attachment } from '@/stores/hermes/chat'
import { personRequest, personTaskCanStop, stopPersonTask, removePersonTaskMessage, type PersonTask, type PersonExecutionSummary, type PersonTaskQueueState } from '@/api/person'
import { onPersonUpdated } from '@/api/studio/chat'
import { clientUuid } from '@/utils/secure-uuid'
import type { SessionSummary } from '@/api/studio/sessions'
import { createRefreshQueue } from '@/utils/refresh-queue'
const props = defineProps<{ taskId: string; mainSessionId: string; executionId?: string }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const { drawerWidth } = useTaskDrawerLayout()
const toolsTargetId = `task-tools-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
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
async function close() {
  if (closing.value) return
  closing.value = true; reads.dispose(); lifetime.abort(); stopUpdates()
  emit('close')
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
onBeforeUnmount(() => { reads.dispose(); lifetime.abort(); stopUpdates() })
</script>

<template>
  <NDrawer :show="!closing" placement="right" :width="drawerWidth" class="person-task-chat" :aria-label="task?.title || t('person.tasks')" @update:show="value => { if (!value) void close() }">
    <NDrawerContent :title="task?.title || t('person.tasks')" closable :native-scrollbar="true"
      :body-content-style="{ padding: '0', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }">
      <template #header><div class="task-chat-heading">
        <span>{{ task?.title || t('person.tasks') }}</span>
        <PersonWorkspaceFiles v-if="session" :panel-target="`#${toolsTargetId}`" :session-id="session.id" :workspace="session.workspace" :submit="send"
          @attach="file => conversationRef?.addFiles([file])" />
      </div></template>
      <div :id="toolsTargetId" class="task-chat-layout">
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
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped lang="scss">
.task-chat-layout { position: relative; display: flex; flex: 1; min-height: 0; min-width: 0; overflow: hidden; }
.task-chat-main { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; }
.task-executions { flex-shrink: 0; padding: 8px 16px; }
.task-chat-alert { margin: 12px; flex-shrink: 0; }
.task-chat-loading { flex: 1; display: grid; place-items: center; }
.task-chat-heading { display: flex; align-items: center; gap: 12px; min-width: 0; }
.task-chat-heading > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
