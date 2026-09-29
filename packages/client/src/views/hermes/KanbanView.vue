<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { NButton, NSelect, NSpin, NModal, NInput, NTooltip, useDialog, useMessage } from 'naive-ui'
import { VueFlow, type Node } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import KanbanTaskCard from '@/components/hermes/kanban/KanbanTaskCard.vue'
import KanbanTaskDrawer from '@/components/hermes/kanban/KanbanTaskDrawer.vue'
import KanbanCreateForm from '@/components/hermes/kanban/KanbanCreateForm.vue'
import { DEFAULT_KANBAN_BOARD, useKanbanStore } from '@/stores/hermes/kanban'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { withDefaultAssignee } from '@/utils/hermes/kanban-assignees'
import type { KanbanTask, KanbanTaskStatus } from '@/api/hermes/kanban'
import type { ProfileAvatar } from '@/api/hermes/profiles'

import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const kanbanStore = useKanbanStore()
const profilesStore = useProfilesStore()

const showCreateForm = ref(false)
const showCreateBoardForm = ref(false)
const selectedTaskId = ref<string | null>(null)
const newBoardSlug = ref('')
const newBoardName = ref('')
const boardActionLoading = ref(false)
const refreshLoading = ref(false)
const refreshTimer = ref<ReturnType<typeof setInterval> | null>(null)
const routeReady = ref(false)

const boardStatuses: KanbanTaskStatus[] = ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done', 'archived']
const kanbanCanvasViewport = { x: 24, y: 24, zoom: 0.92 }
const kanbanColumnWidth = 320
const kanbanColumnGap = 24

interface KanbanCanvasNodeData {
  status: KanbanTaskStatus
  title: string
  tasks: KanbanTask[]
}

function firstQueryString(value: unknown): string | null {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : null
  return typeof value === 'string' ? value : null
}

function routeBoard(): string | null {
  return firstQueryString(route.query.board)
}

async function replaceRouteBoard(board: string) {
  if (routeBoard() === board) return
  await router.replace({ query: { ...route.query, board } })
}

async function applyBoardSelection(candidate: string | null, notify = true, forceRefresh = false) {
  const previousBoard = kanbanStore.selectedBoard
  const { board, recovered } = kanbanStore.recoverSelectedBoard(candidate || kanbanStore.selectedBoard || DEFAULT_KANBAN_BOARD)
  selectedTaskId.value = null
  showCreateForm.value = false
  showCreateBoardForm.value = false
  if (notify && recovered && kanbanStore.boardWarning) message.warning(kanbanStore.boardWarning)
  await replaceRouteBoard(board)
  if (forceRefresh || board !== previousBoard) {
    await kanbanStore.refreshAll()
  }
}

function taskCountLabel(count: number): string {
  return `${t('kanban.stats.tasks')}: ${count}`
}

const boardOptions = computed(() => kanbanStore.activeBoards.map(board => {
  const count = typeof board.total === 'number' ? board.total : 0
  return {
    label: `${t('kanban.title')}: ${board.icon ? `${board.icon} ` : ''}${board.name || board.slug} · ${taskCountLabel(count)}`,
    value: board.slug,
  }
}))

const selectedBoardValue = computed({
  get: () => kanbanStore.selectedBoard,
  set: (value: string) => {
    void applyBoardSelection(value || DEFAULT_KANBAN_BOARD)
  },
})

const tasksByStatus = computed(() => {
  const grouped: Record<string, typeof kanbanStore.tasks> = {}
  for (const status of boardStatuses) {
    grouped[status] = kanbanStore.tasks
      .filter(t => t.status === status)
      .sort((a, b) => b.created_at - a.created_at)
  }
  return grouped
})

const visibleBoardStatuses = computed(() => {
  const status = kanbanStore.filterStatus as KanbanTaskStatus | null
  return status && boardStatuses.includes(status) ? [status] : boardStatuses
})

const kanbanCanvasNodes = computed<Node<KanbanCanvasNodeData>[]>(() => {
  return visibleBoardStatuses.value.map((status, index) => ({
    id: `kanban-status-${status}`,
    type: 'status',
    position: { x: index * (kanbanColumnWidth + kanbanColumnGap), y: 0 },
    width: kanbanColumnWidth,
    height: 'max(360px, calc(100cqh - 48px))',
    draggable: false,
    selectable: false,
    connectable: false,
    focusable: false,
    style: { pointerEvents: 'all' },
    data: {
      status,
      title: t(`kanban.columns.${status}`, status),
      tasks: tasksByStatus.value[status],
    },
  }))
})

const kanbanCanvasKey = computed(() => `${kanbanStore.selectedBoard}:${kanbanStore.filterStatus || 'all'}`)

const visibleAssignees = computed(() => withDefaultAssignee(kanbanStore.assignees, kanbanStore.stats?.by_assignee || {}))

const profileAvatarByName = computed<Record<string, ProfileAvatar | null>>(() => {
  return Object.fromEntries(profilesStore.profiles.map(profile => [profile.name, profile.avatar || null]))
})

const statusFilterOptions = computed(() => [
  { label: t('kanban.allStatuses'), value: '' },
  ...boardStatuses.map(s => ({ label: t(`kanban.columns.${s}`, s), value: s })),
])

const assigneeFilterOptions = computed(() => [
  { label: t('kanban.allAssignees'), value: '' },
  ...visibleAssignees.value.map(a => ({ label: a.name, value: a.name })),
])

const filterStatusValue = computed({
  get: () => kanbanStore.filterStatus || '',
  set: (v: string) => kanbanStore.setFilter('status', v || null),
})

const filterAssigneeValue = computed({
  get: () => kanbanStore.filterAssignee || '',
  set: (v: string) => kanbanStore.setFilter('assignee', v || null),
})

function kanbanNodeColor(node: { data: KanbanCanvasNodeData }): string {
  const colors: Record<KanbanTaskStatus, string> = {
    triage: '#8b8f95',
    todo: '#6f7782',
    scheduled: '#667681',
    ready: '#a66d23',
    running: '#5b7f95',
    blocked: '#b95d5d',
    review: '#7b6f8b',
    done: '#5f8b70',
    archived: '#777b81',
  }
  return colors[node.data.status]
}

watch(() => route.query.board, async () => {
  if (!routeReady.value) return
  await applyBoardSelection(routeBoard(), false)
})

onMounted(async () => {
  await Promise.all([
    kanbanStore.fetchBoards(),
    kanbanStore.fetchCapabilities(),
    profilesStore.profiles.length === 0 ? profilesStore.fetchProfiles() : Promise.resolve(),
  ])
  await applyBoardSelection(routeBoard(), true, true)
  kanbanStore.startEventStream()
  routeReady.value = true
  document.addEventListener('visibilitychange', handleVisibilityChange)
  refreshTimer.value = setInterval(() => {
    void Promise.all([kanbanStore.fetchBoards(), kanbanStore.fetchTasks(true), kanbanStore.fetchStats()])
  }, 15000)
})

onUnmounted(() => {
  kanbanStore.stopEventStream()
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  if (refreshTimer.value) clearInterval(refreshTimer.value)
})

function handleTaskClick(taskId: string) {
  selectedTaskId.value = taskId
}

function handleDrawerClose() {
  selectedTaskId.value = null
}

async function handleDrawerUpdated() {
  await Promise.all([kanbanStore.fetchTasks(), kanbanStore.fetchStats()])
}

function handleNavigateTask(taskId: string) {
  selectedTaskId.value = taskId
}

async function handleApplyFilter() {
  await kanbanStore.fetchTasks()
}

async function handleStatusChipClick(status: KanbanTaskStatus | null) {
  kanbanStore.setFilter('status', status)
  await kanbanStore.fetchTasks()
}

async function handleTaskCreated() {
  await Promise.all([kanbanStore.fetchTasks(), kanbanStore.fetchStats(), kanbanStore.fetchBoards()])
}

async function handleCreateBoard() {
  const slug = newBoardSlug.value.trim()
  if (!slug) {
    message.warning(t('kanban.board.slugRequired'))
    return
  }
  boardActionLoading.value = true
  try {
    const board = await kanbanStore.createBoard({
      slug,
      name: newBoardName.value.trim() || undefined,
    })
    newBoardSlug.value = ''
    newBoardName.value = ''
    showCreateBoardForm.value = false
    await replaceRouteBoard(board.slug)
    message.success(t('kanban.board.created'))
  } catch (err: any) {
    message.error(err.message)
  } finally {
    boardActionLoading.value = false
  }
}

function handleArchiveSelectedBoard() {
  if (kanbanStore.selectedBoard === DEFAULT_KANBAN_BOARD) return
  const board = kanbanStore.selectedBoard
  dialog.warning({
    title: t('kanban.board.archive'),
    content: t('kanban.board.archiveConfirm'),
    positiveText: t('kanban.board.archive'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      if (kanbanStore.selectedBoard !== board) return
      boardActionLoading.value = true
      try {
        await kanbanStore.archiveSelectedBoard()
        await replaceRouteBoard(DEFAULT_KANBAN_BOARD)
        message.success(t('kanban.board.archived'))
      } catch (err: any) {
        message.error(err.message)
      } finally {
        boardActionLoading.value = false
      }
    },
  })
}

async function handleDispatch() {
  boardActionLoading.value = true
  try {
    await kanbanStore.dispatch()
    await kanbanStore.refreshAll()
    message.success(t('kanban.message.dispatchNudged'))
  } catch (err: any) {
    message.error(err.message)
  } finally {
    boardActionLoading.value = false
  }
}

async function handleManualRefresh() {
  refreshLoading.value = true
  try {
    await kanbanStore.refreshAll()
    message.success(t('kanban.message.refreshed'))
  } catch (err: any) {
    message.error(err.message)
  } finally {
    refreshLoading.value = false
  }
}

function handleVisibilityChange() {
  if (document.visibilityState === 'visible') {
    void Promise.all([kanbanStore.fetchBoards(), kanbanStore.fetchTasks(true), kanbanStore.fetchStats()])
  }
}
</script>

<template>
  <div class="kanban-view">
    <header class="page-header">
      <h2 class="header-title">{{ t('kanban.title') }}</h2>
      <div class="header-actions">
        <NSelect
          v-model:value="selectedBoardValue"
          :options="boardOptions"
          :loading="kanbanStore.boardsLoading"
          size="small"
          style="width: 260px;"
        />
        <NButton size="small" :loading="boardActionLoading" @click="showCreateBoardForm = true">
          {{ t('common.add') }}
        </NButton>
        <NTooltip trigger="hover" :disabled="kanbanStore.selectedBoard !== DEFAULT_KANBAN_BOARD">
          <template #trigger>
            <span class="archive-board-trigger">
              <NButton
                size="small"
                secondary
                :disabled="kanbanStore.selectedBoard === DEFAULT_KANBAN_BOARD"
                :loading="boardActionLoading"
                @click="handleArchiveSelectedBoard"
              >
                {{ t('kanban.board.archive') }}
              </NButton>
            </span>
          </template>
          {{ t('kanban.board.defaultArchiveUnavailable') }}
        </NTooltip>
        <NButton size="small" secondary :loading="boardActionLoading" @click="handleDispatch">
          {{ t('kanban.action.dispatch') }}
        </NButton>
        <NButton size="small" quaternary :loading="refreshLoading" @click="handleManualRefresh">
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
          </template>
          {{ t('common.refresh') }}
        </NButton>
        <NSelect
          v-model:value="filterStatusValue"
          :options="statusFilterOptions"
          size="small"
          style="width: 150px;"
          @update:value="handleApplyFilter"
        />
        <NSelect
          v-model:value="filterAssigneeValue"
          :options="assigneeFilterOptions"
          size="small"
          style="width: 170px;"
          @update:value="handleApplyFilter"
        />
        <NButton type="primary" size="small" @click="showCreateForm = true">
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </template>
          {{ t('kanban.createTask') }}
        </NButton>
      </div>
    </header>

    <!-- Stats bar -->
    <div v-if="kanbanStore.stats" class="stats-bar">
      <button
        type="button"
        class="stat-chip total"
        :class="{ active: !kanbanStore.filterStatus }"
        :aria-pressed="!kanbanStore.filterStatus"
        @click="handleStatusChipClick(null)"
      >
        <span class="stat-count">{{ kanbanStore.stats.total }}</span>
        <span class="stat-label">{{ t('kanban.stats.total') }}</span>
      </button>
      <button
        v-for="status in boardStatuses"
        :key="status"
        type="button"
        class="stat-chip"
        :class="[status, { active: kanbanStore.filterStatus === status }]"
        :aria-pressed="kanbanStore.filterStatus === status"
        @click="handleStatusChipClick(status)"
      >
        <span class="stat-indicator" aria-hidden="true" />
        <span class="stat-count">{{ kanbanStore.stats.by_status[status] || 0 }}</span>
        <span class="stat-label">{{ t(`kanban.columns.${status}`, status) }}</span>
      </button>
    </div>

    <!-- Board -->
    <NSpin
      class="kanban-board-spin"
      :show="kanbanStore.loading && kanbanStore.tasks.length === 0"
    >
      <div class="kanban-canvas">
        <VueFlow
          :key="kanbanCanvasKey"
          id="hermes-kanban"
          :nodes="kanbanCanvasNodes"
          :default-viewport="kanbanCanvasViewport"
          :min-zoom="0.35"
          :max-zoom="1.25"
          :nodes-draggable="false"
          :nodes-connectable="false"
          :elements-selectable="false"
          :zoom-on-double-click="false"
          class="kanban-flow"
          :class="{ filtered: visibleBoardStatuses.length === 1 }"
        >
          <template #node-status="{ data }">
            <section
              :class="['kanban-column', `status-${data.status}`]"
              :data-status="data.status"
            >
              <header class="column-header">
                <span class="status-dot" aria-hidden="true" />
                <span class="column-title">{{ data.title }}</span>
                <span class="column-count">{{ data.tasks.length }}</span>
              </header>
              <div class="task-list nodrag nopan nowheel">
                <KanbanTaskCard
                  v-for="task in data.tasks"
                  :key="task.id"
                  :task="task"
                  :assignee-avatar="task.assignee ? profileAvatarByName[task.assignee] || null : null"
                  @click="handleTaskClick(task.id)"
                />
                <div v-if="data.tasks.length === 0" class="column-empty">
                  {{ t('kanban.noTasks') }}
                </div>
              </div>
            </section>
          </template>

          <Background :gap="24" :size="1.2" color="var(--border-color)" />
          <MiniMap pannable zoomable :node-color="kanbanNodeColor" />
          <Controls />
        </VueFlow>
      </div>
    </NSpin>

    <!-- Task detail drawer -->
    <KanbanTaskDrawer
      :task-id="selectedTaskId"
      @close="handleDrawerClose"
      @updated="handleDrawerUpdated"
      @navigate="handleNavigateTask"
    />

    <!-- Board management -->
    <NModal v-model:show="showCreateBoardForm" preset="dialog" :title="t('kanban.board.create')" style="width: 420px;">
      <div class="board-form">
        <NInput v-model:value="newBoardSlug" :placeholder="t('kanban.board.slugPlaceholder')" />
        <NInput v-model:value="newBoardName" :placeholder="t('kanban.board.namePlaceholder')" />
      </div>
      <template #action>
        <NButton @click="showCreateBoardForm = false">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="boardActionLoading" @click="handleCreateBoard">{{ t('common.create') }}</NButton>
      </template>
    </NModal>

    <!-- Create form -->
    <KanbanCreateForm
      v-if="showCreateForm"
      @close="showCreateForm = false"
      @created="handleTaskCreated"
    />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.kanban-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}

.archive-board-trigger {
  display: inline-flex;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.stats-bar {
  display: flex;
  gap: 4px;
  padding: 8px 20px;
  overflow-x: auto;
  overscroll-behavior-inline: contain;
  border-bottom: 1px solid $border-light;
  flex-shrink: 0;
  flex-wrap: nowrap;
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;

  &::-webkit-scrollbar {
    display: none;
  }
}

.stat-chip,
.kanban-column {
  --kanban-status-color: #7f858d;

  &.triage,
  &.status-triage { --kanban-status-color: #8b8f95; }
  &.todo,
  &.status-todo { --kanban-status-color: #6f7782; }
  &.scheduled,
  &.status-scheduled { --kanban-status-color: #667681; }
  &.ready,
  &.status-ready { --kanban-status-color: #a66d23; }
  &.running,
  &.status-running { --kanban-status-color: var(--accent-info); }
  &.blocked,
  &.status-blocked { --kanban-status-color: var(--error); }
  &.review,
  &.status-review { --kanban-status-color: #7b6f8b; }
  &.done,
  &.status-done { --kanban-status-color: var(--success); }
  &.archived,
  &.status-archived { --kanban-status-color: #777b81; }
  &.total { --kanban-status-color: $text-muted; }
}

.stat-chip {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  border-radius: $radius-sm;
  font-size: 12px;
  border: 1px solid transparent;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  line-height: inherit;
  white-space: nowrap;

  &:hover,
  &.active {
    border-color: $border-color;
    background-color: $bg-secondary;
  }

  &:focus-visible {
    outline: 2px solid $accent-primary;
    outline-offset: 2px;
  }
}

.stat-indicator {
  width: 5px;
  height: 5px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: var(--kanban-status-color);
}

.stat-count {
  font-weight: 600;
  color: $text-primary;
}

.stat-label {
  color: $text-muted;
}

.kanban-canvas {
  container-type: size;
  position: relative;
  flex: 1;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.kanban-board-spin {
  flex: 1;
  min-height: 0;
  overflow: hidden;

  :deep(.n-spin-container),
  :deep(.n-spin-content) {
    height: 100%;
    min-height: 0;
  }

  :deep(.n-spin-content) {
    display: flex;
    flex-direction: column;
  }
}

.column-header {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 43px;
  padding: 10px 11px;
  border-bottom: 1px solid $border-light;
  color: $text-primary;
  font-weight: 600;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--kanban-status-color);
  flex-shrink: 0;
}

.column-title {
  min-width: 0;
  overflow: hidden;
  font-size: 12.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.column-count {
  min-width: 22px;
  margin-inline-start: auto;
  padding: 2px 6px;
  border: 1px solid $border-light;
  border-radius: 999px;
  color: $text-muted;
  font-size: 10.5px;
  font-weight: 500;
  line-height: 1.2;
  text-align: center;
}

.kanban-flow {
  width: 100%;
  height: 100%;
  background: $bg-primary;

  :deep(.vue-flow__node-status) {
    border: 0;
    padding: 0;
    background: transparent;
    box-shadow: none;
    cursor: grab;
  }

  :deep(.vue-flow__node-status:active) {
    cursor: grabbing;
  }

  :deep(.vue-flow__minimap) {
    border: 1px solid $border-color;
    border-radius: $radius-md;
    background: $bg-card;
  }

  :deep(.vue-flow__controls) {
    overflow: hidden;
    border: 1px solid $border-color;
    border-radius: $radius-md;
    box-shadow: none;
  }

  :deep(.vue-flow__controls-button) {
    border-bottom-color: $border-light;
    background: $bg-card;
    color: $text-primary;
  }
}

.kanban-column {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  border: 1px solid $border-light;
  border-radius: $radius-md;
  background: color-mix(in srgb, $bg-secondary 66%, $bg-card);
}

.task-list {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  padding: 9px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  touch-action: pan-y;
}

.column-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-height: 72px;
  border: 1px dashed $border-light;
  border-radius: $radius-sm;
  font-size: 12px;
  color: $text-muted;
}

.board-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

@media (max-width: $breakpoint-mobile) {
  .page-header {
    padding: 16px 12px 16px 52px;
    position: sticky;
    top: 0;
    z-index: 20;
    flex-direction: column;
    align-items: flex-start;
    background: $bg-primary;
    gap: 10px;
  }

  .header-actions {
    flex-wrap: wrap;
    width: 100%;
  }

  .stats-bar {
    gap: 6px;
    padding-inline: 12px;
  }

  .kanban-flow {
    :deep(.vue-flow__minimap) {
      width: 112px;
      height: 76px;
    }
  }
}
</style>
