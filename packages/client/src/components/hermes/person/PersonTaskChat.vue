<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NDrawer, NDrawerContent, NSpin, NSelect } from 'naive-ui'
import { useTaskDrawerLayout } from '@/components/hermes/tasks/useTaskDrawerLayout'
import PersonTaskConversation from './PersonTaskConversation.vue'
import PersonWorkspaceFiles from './PersonWorkspaceFiles.vue'
import { buildContentBlocks, uploadFiles, type Attachment } from '@/stores/hermes/chat'
import { personRequest, personTaskCanStop, stopPersonTask, type PersonTask, type PersonExecutionSummary } from '@/api/person'
import { onPersonUpdated } from '@/api/studio/chat'
import type { SessionSummary } from '@/api/studio/sessions'
const props = defineProps<{ taskId: string; mainSessionId: string; executionId?: string }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const { drawerWidth } = useTaskDrawerLayout()
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
const ready = ref(false)
const closing = ref(false)
const sending = ref(false)
const stopping = ref(false)
const error = ref('')
const lifetime = new AbortController()
let sequence = 0
const disabled = computed(() => !ready.value || closing.value || sending.value || stopping.value || task.value?.execution_state === 'stopping' || task.value?.status === 'closed')
const stopControl = computed(() => ({ active: selectedIsCurrent.value && personTaskCanStop(task.value), allowSend: true, pending: stopping.value || task.value?.execution_state === 'stopping', request: stopTask }))
async function refresh(executionId = selectedExecutionId.value) {
  const request = ++sequence
  try {
    const result = await personRequest<{ task: PersonTask; session: SessionSummary | null; pending?: typeof pending.value; execution: PersonExecutionSummary | null; executions: PersonExecutionSummary[] }>(`/tasks/${encodeURIComponent(props.taskId)}/chat${executionId ? `?execution_id=${encodeURIComponent(executionId)}` : ''}`, undefined, 'GET', lifetime.signal)
    if (lifetime.signal.aborted || request !== sequence) return false
    task.value = result.task; session.value = result.session; pending.value = result.pending || []
    executions.value = result.executions; selectedExecutionId.value = result.execution?.id || ''
    return true
  } catch (e) { if (!lifetime.signal.aborted) error.value = String(e); return false }
}
const stopUpdates = onPersonUpdated(event => { if ((!event.session_id || event.session_id === props.mainSessionId) && ready.value) void refresh() })
onMounted(async () => {
  if (await refresh() && !lifetime.signal.aborted) ready.value = true
})
async function send(text: string, attachments?: Attachment[]) {
  if (disabled.value || !task.value) return false
  sending.value = true; error.value = ''
  try {
    const input = await buildContentBlocks(text, attachments, await uploadFiles(attachments || []))
    const result = await personRequest<{ task: PersonTask; pending?: typeof pending.value }>(`/tasks/${encodeURIComponent(props.taskId)}/chat`, {
      input, execution_id: selectedExecutionId.value || undefined, expected_execution_id: task.value.execution_id || null, expected_revision: task.value.revision, idempotency_key: crypto.randomUUID(),
    }, 'POST', lifetime.signal)
    sequence++; task.value = result.task; pending.value = result.pending || []
    await refresh()
    return true
  } catch (e) { if (!lifetime.signal.aborted) { error.value = String(e); await refresh() }; return false }
  finally { sending.value = false }
}
async function close() {
  if (closing.value) return
  closing.value = true; lifetime.abort(); stopUpdates()
  emit('close')
}
async function stopTask() {
  if (!selectedIsCurrent.value || !task.value || !personTaskCanStop(task.value) || stopping.value || task.value.execution_state === 'stopping') return
  stopping.value = true; error.value = ''; sequence++
  try {
    await stopPersonTask(task.value, lifetime.signal)
  } catch (e) { if (!lifetime.signal.aborted) error.value = String(e) }
  finally { if (!lifetime.signal.aborted) await refresh(); stopping.value = false }
}
onBeforeUnmount(() => { lifetime.abort(); stopUpdates() })
</script>

<template>
  <NDrawer :show="!closing" placement="right" :width="drawerWidth" class="person-task-chat" :aria-label="task?.title || t('person.tasks')" @update:show="value => { if (!value) void close() }">
    <NDrawerContent :title="task?.title || t('person.tasks')" closable :native-scrollbar="true"
      :body-content-style="{ padding: '0', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }">
      <template #header><div class="task-chat-heading">
        <span>{{ task?.title || t('person.tasks') }}</span>
        <PersonWorkspaceFiles v-if="session" :session-id="session.id" :workspace="session.workspace" :submit="send"
          @attach="file => conversationRef?.addFiles([file])" />
        <NButton v-if="selectedIsCurrent && personTaskCanStop(task)" size="small" :loading="stopping" :disabled="stopping || task?.execution_state === 'stopping'" @click="stopTask">
          {{ t(task?.execution_state === 'stopping' ? 'person.states.stopping' : 'person.stopTask') }}
        </NButton>
      </div></template>
      <NAlert v-if="error" type="error" class="task-chat-alert">{{ error }}</NAlert>
      <div v-if="!ready" class="task-chat-loading"><NSpin /></div>
      <template v-else>
        <NSelect v-if="executionOptions.length > 1" class="task-executions" :value="session?.id" :options="executionOptions"
          :disabled="sending || stopping" :aria-label="t('person.executionHistory')" @update:value="value => refresh(executions.find(run => run.session_id === value)?.id)" />
        <PersonTaskConversation v-if="session" ref="conversationRef" :key="session.id" :session="session" :pending="pending" :send="send"
          :disabled="disabled" :stop-control="stopControl" />
        <p v-else class="task-chat-alert">{{ t('person.noExecution') }}</p>
      </template>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped lang="scss">
.task-executions { flex-shrink: 0; padding: 8px 16px; }
.task-chat-alert { margin: 12px; flex-shrink: 0; }
.task-chat-loading { flex: 1; display: grid; place-items: center; }
.task-chat-heading { display: flex; align-items: center; gap: 12px; min-width: 0; }
.task-chat-heading > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
