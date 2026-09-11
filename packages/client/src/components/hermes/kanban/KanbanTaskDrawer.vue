<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { NDrawer, NDrawerContent, NButton, NSelect, NInput, NSpin, NModal, useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { request } from '@/api/client'
import { getApprovalCapabilities, getAttachmentContentPath, getTask, listAttachments, performApprovalAction } from '@/api/hermes/kanban'
import { useKanbanStore } from '@/stores/hermes/kanban'
import { useFilesStore } from '@/stores/hermes/files'
import { withDefaultAssignee } from '@/utils/hermes/kanban-assignees'
import HistoryMessageList from '@/components/hermes/chat/HistoryMessageList.vue'
import FilePreview from '@/components/hermes/files/FilePreview.vue'
import { fetchAuthenticatedBlob, saveBlob } from '@/api/studio/binary-content'
import type { Session, Message } from '@/stores/hermes/chat'
import type { KanbanApprovalAction, KanbanApprovalCapabilities, KanbanAttachment, KanbanTaskDetail } from '@/api/hermes/kanban'

const RUN_HISTORY_PAGE_SIZE = 10

const props = defineProps<{
  taskId: string | null
}>()

const emit = defineEmits<{
  close: []
  updated: []
  navigate: [taskId: string]
}>()

const { t } = useI18n()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const kanbanStore = useKanbanStore()
const filesStore = useFilesStore()

const detail = ref<KanbanTaskDetail | null>(null)
const loading = ref(false)
const assignProfile = ref<string | null>(null)
const blockReason = ref('')
const showBlockInput = ref(false)
const completeSummary = ref('')
const showCompleteInput = ref(false)
const showMessagesModal = ref(false)
const commentBody = ref('')
const taskLog = ref<string | null>(null)
const taskLogLoading = ref(false)
const diagnostics = ref<unknown[] | null>(null)
const diagnosticsLoading = ref(false)
const recoveryReason = ref('')
const runHistoryPage = ref(1)
const attachments = ref<KanbanAttachment[]>([])
const showAttachmentPreview = ref(false)
const approvalCapabilities = ref<KanbanApprovalCapabilities | null>(null)
const approvalReason = ref('')
const approvalLoading = ref<KanbanApprovalAction | null>(null)

const completionSummary = computed(() => {
  if (!detail.value) return ''
  return detail.value.task.result || detail.value.latest_summary || ''
})

const localizedTaskStatus = computed(() => {
  if (!detail.value) return ''
  return t(`kanban.columns.${detail.value.task.status}`, detail.value.task.status)
})

const canMutateTask = computed(() => {
  const status = detail.value?.task.status
  return status !== 'done' && status !== 'archived'
})
const canCompleteTask = computed(() => ['running', 'ready', 'blocked'].includes(detail.value?.task.status || ''))
const canBlockTask = computed(() => ['running', 'ready'].includes(detail.value?.task.status || ''))
const canUnblockTask = computed(() => ['blocked', 'scheduled'].includes(detail.value?.task.status || ''))
const canArchiveTask = computed(() => detail.value?.task.status === 'done')
const canAssignTask = computed(() => canMutateTask.value && detail.value?.task.status !== 'running')
const canReclaimTask = computed(() => detail.value?.task.status === 'running')
const canReassignTask = computed(() => canMutateTask.value)
const canSpecifyTask = computed(() => detail.value?.task.status === 'triage')
const canUseApproval = computed(() => Boolean(
  approvalCapabilities.value?.can_approve
  && approvalCapabilities.value.allowed_boards.includes(kanbanStore.selectedBoard),
))
const currentRunId = computed(() => detail.value?.task.current_run_id
  || [...(detail.value?.runs || [])].reverse().find(run => !run.ended_at)?.id
  || [...(detail.value?.runs || [])].reverse()[0]?.id
  || null)
const latestEvent = computed(() => [...(detail.value?.events || [])].reverse()[0] || null)
const hasRiskFlag = computed(() => {
  const task = detail.value?.task
  if (!task) return false
  if (task.priority >= 3) return true
  return /\b(risk|blocker|breaking|security|data loss|payment|credential)\b/i.test(`${task.title} ${task.body || ''}`)
})
const isApprovalLifecycleStatus = computed(() => ['ready', 'running', 'review', 'done'].includes(detail.value?.task.status || ''))

const sessionResults = ref<any[]>([])
const sessionLoading = ref(false)
const showSessions = ref(false)

const latestRunProfile = computed(() => {
  if (!detail.value) return null
  return [...detail.value.runs].reverse().find(run => run.profile)?.profile || null
})

function isActiveTask(taskId: string, board: string): boolean {
  return props.taskId === taskId && kanbanStore.selectedBoard === board
}

function resetTaskScopedState() {
  assignProfile.value = null
  blockReason.value = ''
  showBlockInput.value = false
  completeSummary.value = ''
  showCompleteInput.value = false
  showMessagesModal.value = false
  commentBody.value = ''
  taskLog.value = null
  taskLogLoading.value = false
  diagnostics.value = null
  diagnosticsLoading.value = false
  recoveryReason.value = ''
  runHistoryPage.value = 1
  sessionResults.value = []
  sessionLoading.value = false
  showSessions.value = false
  attachments.value = []
  approvalCapabilities.value = null
  approvalReason.value = ''
  approvalLoading.value = null
  if (showAttachmentPreview.value) {
    showAttachmentPreview.value = false
    filesStore.closePreview()
  }
}

async function searchTaskSessions() {
  if (!detail.value) return
  const taskId = detail.value.task.id
  const board = kanbanStore.selectedBoard
  const profile = latestRunProfile.value
  if (!profile) return
  showSessions.value = !showSessions.value
  if (!showSessions.value) return
  sessionLoading.value = true
  try {
    const res = await request<{ results: any[] }>(
      `/api/hermes/kanban/search-sessions?task_id=${encodeURIComponent(taskId)}&profile=${encodeURIComponent(profile)}&board=${encodeURIComponent(board)}`
    )
    if (isActiveTask(taskId, board)) sessionResults.value = res.results
  } catch {
    if (isActiveTask(taskId, board)) sessionResults.value = []
  } finally {
    if (isActiveTask(taskId, board)) sessionLoading.value = false
  }
}

function openResultDetail() {
  if (detail.value?.session) {
    showMessagesModal.value = true
  }
}

const historySession = computed<Session | null>(() => {
  const s = detail.value?.session
  if (!s) return null
  return {
    id: s.id,
    title: s.title || '',
    source: s.source,
    messages: s.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({
        id: String(m.id),
        role: m.role as Message['role'],
        content: m.content,
        timestamp: m.timestamp,
      })),
    createdAt: s.started_at,
    updatedAt: s.ended_at || s.started_at,
    model: s.model,
    messageCount: s.messages.length,
    endedAt: s.ended_at,
  }
})

const assigneeOptions = computed(() => {
  return withDefaultAssignee(kanbanStore.assignees, kanbanStore.stats?.by_assignee || {})
    .map(a => ({ label: a.name, value: a.name }))
})

const runHistoryPageCount = computed(() => {
  const total = detail.value?.runs.length || 0
  return Math.max(1, Math.ceil(total / RUN_HISTORY_PAGE_SIZE))
})

const visibleRuns = computed(() => {
  const runs = detail.value?.runs || []
  const start = (runHistoryPage.value - 1) * RUN_HISTORY_PAGE_SIZE
  return runs.slice(start, start + RUN_HISTORY_PAGE_SIZE)
})

const runHistoryRange = computed(() => {
  const total = detail.value?.runs.length || 0
  if (!total) return ''
  const start = (runHistoryPage.value - 1) * RUN_HISTORY_PAGE_SIZE + 1
  const end = Math.min(start + RUN_HISTORY_PAGE_SIZE - 1, total)
  return `${start}-${end} / ${total}`
})

watch(() => [props.taskId, kanbanStore.selectedBoard] as const, async ([id, board]) => {
  resetTaskScopedState()
  if (!id) {
    detail.value = null
    return
  }
  loading.value = true
  try {
    const [nextDetail, nextAttachments, nextApprovalCapabilities] = await Promise.all([
      getTask(id, { board }),
      listAttachments(id, { board }).catch(() => []),
      getApprovalCapabilities().catch(() => null),
    ])
    if (isActiveTask(id, board)) {
      detail.value = nextDetail
      attachments.value = nextAttachments
      approvalCapabilities.value = nextApprovalCapabilities
    }
  } catch (err: any) {
    if (isActiveTask(id, board)) {
      message.error(t('kanban.message.loadFailed'))
    }
  } finally {
    if (isActiveTask(id, board)) {
      loading.value = false
    }
  }
}, { immediate: true })

watch(() => detail.value?.runs.length || 0, () => {
  if (runHistoryPage.value > runHistoryPageCount.value) {
    runHistoryPage.value = runHistoryPageCount.value
  }
})

function formatTime(ts: number | null) {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString()
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function handleAttachment(attachment: KanbanAttachment) {
  if (!detail.value) return
  const sourceUrl = getAttachmentContentPath(detail.value.task.id, attachment.id, {
    board: kanbanStore.selectedBoard,
  })
  try {
    if (await filesStore.openRemotePreview(sourceUrl, attachment.filename, attachment.size)) {
      showAttachmentPreview.value = true
      return
    }
    saveBlob(await fetchAuthenticatedBlob(sourceUrl, { profile: null }), attachment.filename)
  } catch (err: any) {
    message.error(err.message)
  }
}

function closeAttachmentPreview() {
  showAttachmentPreview.value = false
  filesStore.closePreview()
}

async function handleComplete() {
  if (!props.taskId) return
  if (!showCompleteInput.value) {
    showCompleteInput.value = true
    return
  }
  try {
    await kanbanStore.completeTasks([props.taskId], completeSummary.value.trim() || undefined)
    message.success(t('kanban.message.taskCompleted'))
    showCompleteInput.value = false
    completeSummary.value = ''
    emit('updated')
    emit('close')
  } catch (err: any) {
    message.error(err.message)
  }
}

async function handleBlock() {
  if (!props.taskId || !blockReason.value.trim()) return
  try {
    await kanbanStore.blockTask(props.taskId, blockReason.value.trim())
    message.success(t('kanban.message.taskBlocked'))
    showBlockInput.value = false
    blockReason.value = ''
    emit('updated')
    emit('close')
  } catch (err: any) {
    message.error(err.message)
  }
}

async function handleUnblock() {
  if (!props.taskId) return
  try {
    await kanbanStore.unblockTasks([props.taskId])
    message.success(t('kanban.message.taskUnblocked'))
    emit('updated')
    emit('close')
  } catch (err: any) {
    message.error(err.message)
  }
}

function handleArchive() {
  if (!props.taskId) return
  const taskId = props.taskId
  const board = kanbanStore.selectedBoard
  dialog.warning({
    title: t('kanban.action.archive'),
    content: t('kanban.action.archiveConfirm'),
    positiveText: t('kanban.action.archive'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      if (!isActiveTask(taskId, board)) return
      try {
        await kanbanStore.archiveTasks([taskId])
        if (!isActiveTask(taskId, board)) return
        message.success(t('kanban.message.taskArchived'))
        emit('updated')
        emit('close')
      } catch (err: any) {
        if (isActiveTask(taskId, board)) message.error(err.message)
      }
    },
  })
}

async function handleAssign() {
  if (!props.taskId || !assignProfile.value) return
  const taskId = props.taskId
  const board = kanbanStore.selectedBoard
  try {
    await kanbanStore.assignTask(taskId, assignProfile.value)
    if (isActiveTask(taskId, board)) {
      message.success(t('kanban.message.taskAssigned'))
      assignProfile.value = null
    }
    if (detail.value) {
      const nextDetail = await getTask(taskId, { board })
      if (isActiveTask(taskId, board)) detail.value = nextDetail
    }
    emit('updated')
  } catch (err: any) {
    if (isActiveTask(taskId, board)) message.error(err.message)
  }
}

async function handleAddComment() {
  if (!props.taskId || !commentBody.value.trim()) return
  const taskId = props.taskId
  const board = kanbanStore.selectedBoard
  try {
    await kanbanStore.addComment(taskId, commentBody.value.trim())
    const nextDetail = await getTask(taskId, { board })
    if (isActiveTask(taskId, board)) {
      commentBody.value = ''
      detail.value = nextDetail
      message.success(t('kanban.message.commentAdded'))
    }
    emit('updated')
  } catch (err: any) {
    if (isActiveTask(taskId, board)) message.error(err.message)
  }
}

async function handleLoadLog() {
  if (!props.taskId) return
  const taskId = props.taskId
  const board = kanbanStore.selectedBoard
  taskLogLoading.value = true
  try {
    const log = await kanbanStore.getTaskLog(taskId, 20000)
    if (isActiveTask(taskId, board)) {
      taskLog.value = log.exists ? log.content : t('kanban.detail.noLog')
    }
  } catch (err: any) {
    if (isActiveTask(taskId, board)) message.error(err.message)
  } finally {
    if (isActiveTask(taskId, board)) taskLogLoading.value = false
  }
}

async function handleLoadDiagnostics() {
  if (!props.taskId) return
  const taskId = props.taskId
  const board = kanbanStore.selectedBoard
  diagnosticsLoading.value = true
  try {
    const nextDiagnostics = await kanbanStore.getDiagnostics({ task: taskId, severity: 'warning' })
    if (isActiveTask(taskId, board)) {
      diagnostics.value = nextDiagnostics
    }
  } catch (err: any) {
    if (isActiveTask(taskId, board)) message.error(err.message)
  } finally {
    if (isActiveTask(taskId, board)) diagnosticsLoading.value = false
  }
}

async function handleReclaim() {
  if (!props.taskId) return
  try {
    await kanbanStore.reclaimTask(props.taskId, recoveryReason.value.trim() || undefined)
    message.success(t('kanban.message.taskReclaimed'))
    emit('updated')
    emit('close')
  } catch (err: any) {
    message.error(err.message)
  }
}

async function handleReassign() {
  if (!props.taskId || !assignProfile.value) return
  try {
    await kanbanStore.reassignTask(props.taskId, assignProfile.value, {
      reclaim: detail.value?.task.status === 'running',
      reason: recoveryReason.value.trim() || undefined,
    })
    message.success(t('kanban.message.taskReassigned'))
    emit('updated')
    emit('close')
  } catch (err: any) {
    message.error(err.message)
  }
}

async function handleSpecify() {
  if (!props.taskId) return
  const taskId = props.taskId
  const board = kanbanStore.selectedBoard
  try {
    await kanbanStore.specifyTask(taskId)
    const nextDetail = await getTask(taskId, { board })
    if (isActiveTask(taskId, board)) {
      message.success(t('kanban.message.taskSpecified'))
      detail.value = nextDetail
    }
    emit('updated')
  } catch (err: any) {
    message.error(err.message)
  }
}

async function handleApproval(action: KanbanApprovalAction) {
  if (!props.taskId || !detail.value || !canUseApproval.value) return
  const reason = approvalReason.value.trim()
  if (['request_review', 'approve', 'request_changes'].includes(action) && !reason) {
    message.error(t('kanban.approval.reasonRequired'))
    return
  }
  const taskId = props.taskId
  const board = kanbanStore.selectedBoard
  approvalLoading.value = action
  try {
    const result = await performApprovalAction(taskId, action, { reason: reason || undefined }, { board })
    if (!isActiveTask(taskId, board)) return
    const [nextDetail, nextAttachments] = await Promise.all([
      getTask(taskId, { board }),
      listAttachments(taskId, { board }).catch(() => []),
    ])
    if (!isActiveTask(taskId, board)) return
    detail.value = nextDetail
    attachments.value = nextAttachments
    approvalReason.value = ''
    message.success(t(result.receipt.duplicate ? 'kanban.approval.duplicate' : 'kanban.approval.success'))
    emit('updated')
  } catch (err: any) {
    message.error(err.message || t('kanban.approval.failed'))
  } finally {
    if (isActiveTask(taskId, board)) approvalLoading.value = null
  }
}

function handleApprovalArchive() {
  if (!props.taskId) return
  const taskId = props.taskId
  const board = kanbanStore.selectedBoard
  dialog.warning({
    title: t('kanban.action.archive'),
    content: t('kanban.action.archiveConfirm'),
    positiveText: t('kanban.action.archive'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      if (!isActiveTask(taskId, board)) return
      await handleApproval('archive')
    },
  })
}

function handleNavigateTask(taskId: string) {
  emit('updated')
  emit('navigate', taskId)
}
</script>

<template>
  <NDrawer :show="!!taskId" :width="420" placement="right" @update:show="(v: boolean) => { if (!v) emit('close') }">
    <NDrawerContent :title="detail?.task.title || ''" closable>
      <NSpin :show="loading">
        <template v-if="detail">
          <!-- Metadata -->
          <div class="detail-section">
            <div class="detail-row">
              <span class="detail-label">{{ t('kanban.detail.status') }}</span>
              <span class="detail-value status-badge" :class="detail.task.status">{{ localizedTaskStatus }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Task ID</span>
              <span class="detail-value task-id-value">{{ detail.task.id }}</span>
            </div>
            <div v-if="detail.parents?.length" class="detail-row">
              <span class="detail-label">Parent</span>
              <span class="detail-value">
                <a v-for="pid in detail.parents" :key="pid" class="task-link" @click="handleNavigateTask(pid)">{{ pid }}</a>
              </span>
            </div>
            <div v-if="detail.children?.length" class="detail-row">
              <span class="detail-label">Children</span>
              <span class="detail-value">
                <a v-for="cid in detail.children" :key="cid" class="task-link" @click="handleNavigateTask(cid)">{{ cid }}</a>
              </span>
            </div>
            <div class="detail-row">
              <span class="detail-label">{{ t('kanban.detail.assignee') }}</span>
              <span class="detail-value">{{ detail.task.assignee || '—' }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">{{ t('kanban.detail.priority') }}</span>
              <span class="detail-value">{{ detail.task.priority }}</span>
            </div>
            <div v-if="hasRiskFlag" class="detail-row" data-testid="approval-risk">
              <span class="detail-label">{{ t('kanban.approval.risk') }}</span>
              <span class="detail-value approval-risk">{{ t('kanban.approval.riskDetected') }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">{{ t('kanban.approval.runId') }}</span>
              <span class="detail-value">{{ currentRunId || '—' }}</span>
            </div>
            <div class="detail-row" data-testid="approval-event-id">
              <span class="detail-label">{{ t('kanban.approval.eventId') }}</span>
              <span class="detail-value">{{ latestEvent?.id || '—' }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">{{ t('kanban.detail.tenant') }}</span>
              <span class="detail-value">{{ detail.task.tenant || '—' }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">{{ t('kanban.detail.createdAt') }}</span>
              <span class="detail-value">{{ formatTime(detail.task.created_at) }}</span>
            </div>
            <div v-if="detail.task.started_at" class="detail-row">
              <span class="detail-label">{{ t('kanban.detail.startedAt') }}</span>
              <span class="detail-value">{{ formatTime(detail.task.started_at) }}</span>
            </div>
            <div v-if="detail.task.completed_at" class="detail-row">
              <span class="detail-label">{{ t('kanban.detail.completedAt') }}</span>
              <span class="detail-value">{{ formatTime(detail.task.completed_at) }}</span>
            </div>
          </div>

          <!-- Body -->
          <div v-if="detail.task.body" class="detail-section">
            <div class="section-title">{{ t('kanban.form.body') }}</div>
            <div class="detail-body" dir="auto">{{ detail.task.body }}</div>
          </div>

          <!-- Result / Summary -->
          <div v-if="completionSummary" class="detail-section">
            <div class="section-title">{{ t('kanban.detail.result') }}</div>
            <div class="result-summary" dir="auto" @click="openResultDetail">{{ completionSummary }}</div>
          </div>

          <div v-if="isApprovalLifecycleStatus" class="detail-section approval-section">
            <div class="section-title">{{ t('kanban.approval.title') }}</div>
            <template v-if="canUseApproval">
              <NInput
                v-if="detail.task.status === 'running' || detail.task.status === 'review'"
                v-model:value="approvalReason"
                data-testid="approval-reason"
                :placeholder="t('kanban.approval.reasonPlaceholder')"
              />
              <div class="action-group approval-actions">
                <NButton
                  v-if="detail.task.status === 'ready'"
                  data-testid="approval-claim"
                  type="primary"
                  :loading="approvalLoading === 'claim'"
                  @click="handleApproval('claim')"
                >{{ t('kanban.approval.claim') }}</NButton>
                <NButton
                  v-if="detail.task.status === 'running'"
                  data-testid="approval-request-review"
                  type="primary"
                  :loading="approvalLoading === 'request_review'"
                  @click="handleApproval('request_review')"
                >{{ t('kanban.approval.requestReview') }}</NButton>
                <NButton
                  v-if="detail.task.status === 'review'"
                  data-testid="approval-approve"
                  type="success"
                  :loading="approvalLoading === 'approve'"
                  @click="handleApproval('approve')"
                >{{ t('kanban.approval.approve') }}</NButton>
                <NButton
                  v-if="detail.task.status === 'review'"
                  data-testid="approval-request-changes"
                  type="warning"
                  :loading="approvalLoading === 'request_changes'"
                  @click="handleApproval('request_changes')"
                >{{ t('kanban.approval.requestChanges') }}</NButton>
                <NButton
                  v-if="detail.task.status === 'done'"
                  data-testid="approval-archive"
                  secondary
                  :loading="approvalLoading === 'archive'"
                  @click="handleApprovalArchive"
                >{{ t('kanban.approval.archive') }}</NButton>
              </div>
            </template>
            <div v-else class="approval-unauthorized">{{ t('kanban.approval.unauthorized') }}</div>
          </div>

          <!-- Actions for active tasks and the terminal done-to-archived transition -->
          <div v-if="canMutateTask || canArchiveTask" class="detail-section">
            <div class="section-title">{{ t('kanban.action.title') }}</div>
            <div class="action-group">
              <NButton v-if="canArchiveTask && !canUseApproval" size="small" secondary type="warning" @click="handleArchive">
                {{ t('kanban.action.archive') }}
              </NButton>
              <template v-if="canCompleteTask && !canUseApproval && !showCompleteInput">
                <NButton size="small" @click="showCompleteInput = true">
                  {{ t('kanban.action.complete') }}
                </NButton>
              </template>
              <div v-else-if="canCompleteTask && !canUseApproval" class="complete-input">
                <NInput v-model:value="completeSummary" size="small" :placeholder="t('kanban.action.completeSummary')" />
                <NButton size="small" type="primary" @click="handleComplete">{{ t('common.ok') }}</NButton>
                <NButton size="small" @click="showCompleteInput = false; completeSummary = ''">{{ t('common.cancel') }}</NButton>
              </div>
              <template v-if="canUnblockTask">
                <NButton size="small" @click="handleUnblock">{{ t('kanban.action.unblock') }}</NButton>
              </template>
              <template v-else-if="canBlockTask">
                <NButton v-if="!showBlockInput" size="small" @click="showBlockInput = true">{{ t('kanban.action.block') }}</NButton>
                <div v-else class="block-input">
                  <NInput v-model:value="blockReason" size="small" :placeholder="t('kanban.action.blockReason')" />
                  <NButton size="small" type="primary" @click="handleBlock">{{ t('common.ok') }}</NButton>
                </div>
              </template>
            </div>
            <div v-if="canAssignTask" class="assign-group">
              <NSelect v-model:value="assignProfile" :options="assigneeOptions" size="small" :placeholder="t('kanban.action.assignTo')" style="flex: 1;" />
              <NButton size="small" :disabled="!assignProfile" @click="handleAssign">{{ t('kanban.action.assign') }}</NButton>
            </div>
            <div v-if="canReclaimTask || canReassignTask || canSpecifyTask" class="recovery-group">
              <NInput v-model:value="recoveryReason" size="small" :placeholder="t('kanban.action.recoveryReason')" />
              <NButton v-if="canReclaimTask" size="small" secondary @click="handleReclaim">{{ t('kanban.action.reclaim') }}</NButton>
              <NButton v-if="canReassignTask" size="small" secondary :disabled="!assignProfile" @click="handleReassign">{{ t('kanban.action.reassign') }}</NButton>
              <NButton v-if="canSpecifyTask" size="small" secondary @click="handleSpecify">{{ t('kanban.action.specify') }}</NButton>
            </div>
          </div>

          <!-- Durable task attachments -->
          <div v-if="attachments.length > 0" class="detail-section">
            <div class="section-title">{{ t('kanban.detail.artifacts') }}</div>
            <button
              v-for="attachment in attachments"
              :key="attachment.id"
              type="button"
              class="attachment-item"
              @click="handleAttachment(attachment)"
            >
              <span class="attachment-name">{{ attachment.filename }}</span>
              <span class="attachment-size">{{ formatSize(attachment.size) }}</span>
            </button>
          </div>

          <!-- Related Sessions -->
          <div v-if="detail.runs.length > 0" class="detail-section">
            <div class="section-title" style="cursor: pointer;" @click="searchTaskSessions">
              {{ t('kanban.detail.sessions') }}
              <NSpin v-if="sessionLoading" :size="12" style="margin-inline-start: 6px;" />
            </div>
            <div v-if="showSessions && sessionResults.length > 0" class="session-list">
              <div v-for="session in sessionResults" :key="session.id" class="session-item" @click="router.push({ name: 'hermes.chat', query: { session: session.id } })">
                <div class="session-title" dir="auto">{{ session.title || session.id }}</div>
                <div class="session-meta">
                  <span>{{ session.source }}</span>
                  <span>{{ session.model }}</span>
                  <span>{{ formatTime(session.started_at) }}</span>
                </div>
              </div>
            </div>
            <div v-if="showSessions && !sessionLoading && sessionResults.length === 0" class="column-empty">{{ t('kanban.detail.noSessions') }}</div>
          </div>

          <!-- Runs -->
          <div v-if="detail.runs.length > 0" class="detail-section">
            <div class="section-title run-history-title">
              <span>{{ t('kanban.detail.runs') }}</span>
              <span class="run-history-range">{{ runHistoryRange }}</span>
              <div v-if="runHistoryPageCount > 1" class="run-history-controls">
                <NButton size="tiny" secondary :disabled="runHistoryPage <= 1" @click="runHistoryPage -= 1">‹</NButton>
                <NButton size="tiny" secondary :disabled="runHistoryPage >= runHistoryPageCount" @click="runHistoryPage += 1">›</NButton>
              </div>
            </div>
            <div v-for="run in visibleRuns" :key="run.id" class="run-item">
              <div class="run-header">
                <span class="run-status" :class="run.status">{{ run.status }}</span>
                <span class="run-profile">{{ run.profile || '—' }}</span>
                <span class="run-time">{{ formatTime(run.started_at) }}</span>
              </div>
              <div v-if="run.summary" class="run-summary">{{ run.summary }}</div>
              <div v-if="run.error" class="run-error">{{ run.error }}</div>
            </div>
          </div>

          <!-- Comments -->
          <div v-if="detail.comments.length > 0" class="detail-section">
            <div class="section-title">{{ t('kanban.detail.comments') }}</div>
            <div v-for="comment in detail.comments" :key="comment.id" class="comment-item">
              <div class="comment-header">
                <span class="comment-author">{{ comment.author }}</span>
                <span class="comment-time">{{ formatTime(comment.created_at) }}</span>
              </div>
              <div class="comment-body">{{ comment.body }}</div>
            </div>
          </div>
          <div v-if="canMutateTask" class="detail-section">
            <div class="section-title">{{ t('kanban.detail.addComment') }}</div>
            <div class="comment-input">
              <NInput v-model:value="commentBody" type="textarea" :rows="3" :placeholder="t('kanban.detail.commentPlaceholder')" />
              <NButton size="small" type="primary" :disabled="!commentBody.trim()" @click="handleAddComment">{{ t('common.add') }}</NButton>
            </div>
          </div>

          <div class="detail-section">
            <div class="section-title">{{ t('kanban.detail.operations') }}</div>
            <div class="action-group">
              <NButton size="small" secondary :loading="taskLogLoading" @click="handleLoadLog">{{ t('kanban.action.loadLog') }}</NButton>
              <NButton size="small" secondary :loading="diagnosticsLoading" @click="handleLoadDiagnostics">{{ t('kanban.action.loadDiagnostics') }}</NButton>
            </div>
            <pre v-if="taskLog !== null" class="log-output">{{ taskLog }}</pre>
            <pre v-if="diagnostics !== null" class="log-output">{{ JSON.stringify(diagnostics, null, 2) }}</pre>
          </div>

          <!-- Events -->
          <div v-if="detail.events.length > 0" class="detail-section">
            <div class="section-title">{{ t('kanban.detail.events') }}</div>
            <div v-for="event in detail.events.slice(-10)" :key="event.id" class="event-item">
              <span class="event-kind">{{ event.kind }}</span>
              <span class="event-id">#{{ event.id }}<template v-if="event.run_id"> · run {{ event.run_id }}</template></span>
              <span class="event-time">{{ formatTime(event.created_at) }}</span>
            </div>
          </div>
        </template>
      </NSpin>
    </NDrawerContent>
  </NDrawer>

  <!-- Session messages modal (click result summary) -->
  <NModal v-if="historySession" :show="showMessagesModal" preset="card" :title="detail?.task.title || ''" :style="{ width: '900px', maxWidth: 'calc(100vw - 48px)' }" @close="showMessagesModal = false">
    <div class="messages-modal-body">
      <HistoryMessageList :session="historySession" scroll-scope="kanban" />
    </div>
  </NModal>

  <NModal
    :show="showAttachmentPreview"
    preset="card"
    :title="filesStore.previewFile?.name || ''"
    :style="{ width: 'min(1100px, calc(100vw - 48px))', height: 'min(820px, calc(100vh - 48px))' }"
    content-style="padding: 0; height: 100%; overflow: hidden;"
    @close="closeAttachmentPreview"
  >
    <FilePreview v-if="filesStore.previewFile" :custom-close="closeAttachmentPreview" />
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.detail-section {
  margin-bottom: 20px;
}

.attachment-item {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 10px;
  margin-top: 6px;
  border: 1px solid $border-color;
  border-radius: 6px;
  color: $text-primary;
  background: $bg-secondary;
  cursor: pointer;
  text-align: start;

  &:hover {
    border-color: $accent-primary;
  }
}

.attachment-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-size {
  flex: 0 0 auto;
  color: $text-muted;
  font-size: 12px;
}

.section-title {
  font-size: 12px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 10px;
}

.run-history-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.run-history-range {
  color: $text-muted;
  font-family: $font-code;
  font-size: 11px;
  font-weight: 500;
  margin-inline-start: auto;
  text-transform: none;
}

.run-history-controls {
  display: flex;
  gap: 4px;
}

.result-summary {
  cursor: pointer;
  border-radius: $radius-sm;
  padding: 8px 10px;
  background: rgba(var(--accent-primary-rgb), 0.04);
  border: 1px solid $border-light;
  font-size: 13px;
  color: $text-secondary;
  line-height: 1.5;
  transition: border-color $transition-fast;

  &:hover { border-color: rgba(var(--accent-primary-rgb), 0.3); }
}

.result-detail {
  margin-top: 10px;
  padding: 10px;
  background: rgba(var(--accent-primary-rgb), 0.02);
  border: 1px solid $border-light;
  border-radius: $radius-sm;
}

.meta-label {
  font-size: 11px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin: 8px 0 4px;

  &:first-child { margin-top: 0; }
}

.meta-list {
  list-style: none;
  padding: 0;
  margin: 0;

  li {
    font-size: 12px;
    color: $text-secondary;
    padding: 2px 0;

    code {
      font-family: $font-code;
      font-size: 11px;
      background: rgba(var(--accent-primary-rgb), 0.06);
      padding: 1px 4px;
      border-radius: 3px;
      word-break: break-all;
    }
  }
}

.meta-kv {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.meta-kv-row {
  display: flex;
  gap: 8px;
  font-size: 12px;
}

.meta-kv-key {
  color: $text-muted;
  font-family: $font-code;
  font-size: 11px;
  min-width: 100px;
  flex-shrink: 0;
}

.meta-kv-val {
  color: $text-secondary;
}

.artifact-link {
  cursor: pointer;
  transition: color $transition-fast;

  &:hover { color: $accent-primary; }
}

.artifact-modal-body,
.messages-modal-body {
  max-height: 65vh;
  overflow: hidden;
  padding: 4px 0;

  :deep(.message-list) {
    max-height: 65vh;
    background: transparent;
    padding: 0;
  }
}

.detail-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 0;
  border-bottom: 1px solid $border-light;
}

.detail-label {
  font-size: 12px;
  color: $text-muted;
}

.detail-value {
  font-size: 12px;
  color: $text-primary;
}

.task-id-value {
  font-family: $font-code;
  font-size: 11px;
  background: rgba(var(--accent-primary-rgb), 0.06);
  padding: 1px 5px;
  border-radius: 3px;
  user-select: all;
}

.task-link {
  font-family: $font-code;
  font-size: 11px;
  color: $accent-primary;
  cursor: pointer;
  background: rgba(var(--accent-primary-rgb), 0.06);
  padding: 1px 5px;
  border-radius: 3px;
  transition: background $transition-fast;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.14);
    text-decoration: underline;
  }

  &:not(:last-child) {
    margin-inline-end: 4px;
  }
}

.status-badge {
  padding: 1px 8px;
  border-radius: 4px;
  font-weight: 500;

  &.triage {
    background: rgba(148, 163, 184, 0.14);
    color: #94a3b8;
  }

  &.todo {
    background: rgba(56, 189, 248, 0.14);
    color: #38bdf8;
  }

  &.ready {
    background: rgba(var(--warning-rgb), 0.12);
    color: $warning;
  }

  &.running {
    background: rgba(var(--accent-primary-rgb), 0.12);
    color: $accent-primary;
  }

  &.blocked {
    background: rgba(var(--error-rgb), 0.12);
    color: $error;
  }

  &.done {
    background: rgba(var(--success-rgb), 0.12);
    color: $success;
  }

  &.archived {
    background: rgba(100, 116, 139, 0.14);
    color: #94a3b8;
  }
}

.detail-body {
  font-size: 13px;
  color: $text-secondary;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.action-group {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.block-input,
.complete-input {
  display: flex;
  gap: 6px;
  flex: 1;
}

.assign-group {
  display: flex;
  gap: 8px;
}

.run-item,
.comment-item {
  padding: 8px 0;
  border-bottom: 1px solid $border-light;

  &:last-child {
    border-bottom: none;
  }
}

.run-header,
.comment-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.run-status {
  font-size: 11px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 4px;

  &.running {
    background: rgba(var(--accent-primary-rgb), 0.12);
    color: $accent-primary;
  }

  &.done, &.completed {
    background: rgba(var(--success-rgb), 0.12);
    color: $success;
  }

  &.crashed, &.failed {
    background: rgba(var(--error-rgb), 0.12);
    color: $error;
  }
}

.run-profile,
.comment-author {
  font-size: 12px;
  font-weight: 500;
  color: $text-primary;
}

.run-time,
.comment-time {
  font-size: 11px;
  color: $text-muted;
  margin-inline-start: auto;
}

.run-summary,
.run-error,
.comment-body {
  font-size: 12px;
  color: $text-secondary;
  line-height: 1.4;
}

.run-error {
  color: $error;
}

.event-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}

.event-kind {
  font-size: 11px;
  font-family: $font-code;
  color: $accent-primary;
}

.event-time {
  font-size: 11px;
  color: $text-muted;
  margin-inline-start: auto;
}

.session-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.session-item {
  padding: 8px 10px;
  border-radius: $radius-sm;
  border: 1px solid $border-light;
  cursor: pointer;
  transition: border-color $transition-fast;

  &:hover { border-color: rgba(var(--accent-primary-rgb), 0.3); }
}

.session-title {
  font-size: 13px;
  font-weight: 500;
  color: $text-primary;
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-meta {
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: $text-muted;
}

.session-messages {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.recovery-group,
.comment-input {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}

.comment-input {
  align-items: flex-start;
}

.comment-input :deep(.n-input) {
  flex: 1;
  min-width: 220px;
}

.log-output {
  margin: 10px 0 0;
  max-height: 240px;
  overflow: auto;
  padding: 10px;
  border: 1px solid $border-light;
  border-radius: $radius-sm;
  background: rgba(var(--accent-primary-rgb), 0.03);
  color: $text-secondary;
  font-family: $font-code;
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}

.session-msg {
  padding: 10px 12px;
  border-radius: $radius-sm;
  border: 1px solid $border-light;

  &.user {
    background: rgba(var(--accent-primary-rgb), 0.04);
  }

  &.assistant {
    background: transparent;
  }
}

.session-msg-role {
  font-size: 11px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  margin-bottom: 6px;
}

.session-msg-content {
  font-size: 13px;
  color: $text-secondary;
  line-height: 1.5;

  :deep(p) {
    margin: 0 0 8px;

    &:last-child { margin-bottom: 0; }
  }
}
</style>
