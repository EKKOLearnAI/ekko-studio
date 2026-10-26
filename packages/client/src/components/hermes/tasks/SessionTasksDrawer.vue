<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { NButton, NDrawer, NDrawerContent, NDropdown, NEmpty, NInput, NPagination, NSpin, useMessage } from 'naive-ui'
import SessionTaskIcon from '@/components/common/SessionTaskIcon.vue'
import { fetchSessionTasks, updateSessionTaskStatus, type SessionTaskListItem, type SessionTaskStatus } from '@/api/studio/session-tasks'
import { chatSessionAgentAvatar } from '@/utils/chat-agent-avatar'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ 'update:show': [show: boolean] }>()
const route = useRoute()
const router = useRouter()
const { t, locale } = useI18n()
const message = useMessage()
const savingIds = ref(new Set<string>())
const tasks = ref<SessionTaskListItem[]>([])
const total = ref(0)
const loading = ref(true)
const error = ref(false)
const searchOpen = ref(false)
const searchInput = ref<InstanceType<typeof NInput> | null>(null)
const statusMenuOpen = ref(false)
const search = ref(typeof route.query.taskSearch === 'string' ? route.query.taskSearch : '')
const status = computed(() => ['open', 'completed', 'closed'].includes(String(route.query.taskStatus)) ? String(route.query.taskStatus) : '')
const order = computed(() => route.query.taskOrder === 'oldest' ? 'oldest' : 'newest')
const page = computed(() => {
  const value = Number(route.query.taskPage)
  return Number.isSafeInteger(value) && value > 0 ? value : 1
})
const mobileQuery = window.matchMedia('(max-width: 768px)')
const isMobile = ref(mobileQuery.matches)
const drawerWidth = computed(() => isMobile.value ? '100vw' : 'min(1200px, calc(100vw - 64px))')
const statusLabel = computed(() => t(status.value ? `sessionTasks.${status.value}` : 'sessionTasks.status'))
const taskStatusOptions = computed(() => [
  { key: 'open', label: t('sessionTasks.open') },
  { key: 'completed', label: t('sessionTasks.completed') },
  { key: 'closed', label: t('sessionTasks.closed') },
])
const statusOptions = computed(() => [{ key: '', label: t('sessionTasks.all') }, ...taskStatusOptions.value])
let requestSequence = 0
let searchTimer: ReturnType<typeof setTimeout> | undefined
let refreshTimer: ReturnType<typeof setInterval> | undefined
let disposed = false

function updateQuery(change: Record<string, string | undefined>) {
  return router.replace({ query: { ...route.query, taskPage: undefined, ...change } })
}

async function load(silent = false) {
  const sequence = ++requestSequence
  if (!silent) loading.value = true
  error.value = false
  try {
    const result = await fetchSessionTasks({ search: typeof route.query.taskSearch === 'string' ? route.query.taskSearch : '',
      status: status.value, order: order.value, page: page.value })
    if (disposed || sequence !== requestSequence || !props.show) return
    tasks.value = result.tasks
    total.value = result.total
    if (page.value > 1 && !result.tasks.length && result.total > 0) {
      await updateQuery({ taskPage: String(Math.ceil(result.total / 50)) })
    }
  } catch {
    if (!disposed && sequence === requestSequence && props.show) error.value = true
  } finally {
    if (!disposed && sequence === requestSequence) loading.value = false
  }
}

function refresh() {
  if (props.show && !savingIds.value.size && document.visibilityState === 'visible') void load(true)
}
async function changeStatus(task: SessionTaskListItem, value: string | number) {
  if (savingIds.value.has(task.id) || value === task.status || !['open', 'completed', 'closed'].includes(String(value))) return
  savingIds.value = new Set([...savingIds.value, task.id])
  requestSequence++
  try {
    await updateSessionTaskStatus(task, value as SessionTaskStatus)
    requestSequence++
    if (!disposed && props.show) await load(true)
  } catch {
    if (!disposed) message.error(t('sessionTasks.updateFailed'))
  } finally {
    const next = new Set(savingIds.value)
    next.delete(task.id)
    savingIds.value = next
  }
}
async function openSearch() {
  searchOpen.value = true
  await nextTick()
  searchInput.value?.focus()
}
function handleKeydown(event: KeyboardEvent) {
  if (props.show && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    event.stopImmediatePropagation()
    void openSearch()
  }
}
function handleMobileChange(event: MediaQueryListEvent) { isMobile.value = event.matches }
function taskHref(task: SessionTaskListItem) {
  return router.resolve({ name: 'hermes.session', params: { sessionId: task.session_id },
    query: { profile: task.profile, ...(task.message_id ? { message: String(task.message_id) } : {}) } }).href
}
function taskAvatar(task: SessionTaskListItem) {
  return chatSessionAgentAvatar({ source: task.source, agent: task.agent || (task.source === 'builtin_agent' ? 'ekko-agent' : 'hermes') })
}
function formatTime(timestamp: number, compact = false) {
  const sameDay = new Date(timestamp).toDateString() === new Date().toDateString()
  const options: Intl.DateTimeFormatOptions = compact
    ? sameDay ? { hour: '2-digit', minute: '2-digit' } : { month: '2-digit', day: '2-digit' }
    : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
  return new Intl.DateTimeFormat(locale.value, options).format(timestamp)
}
watch(search, () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { if (props.show) void updateQuery({ taskSearch: search.value.trim() || undefined }) }, 200)
})
watch([() => props.show, () => route.query.taskSearch, () => route.query.taskStatus, () => route.query.taskOrder, () => route.query.taskPage], () => {
  requestSequence++
  const value = typeof route.query.taskSearch === 'string' ? route.query.taskSearch : ''
  if (search.value.trim() !== value) search.value = value
  if (props.show) void load()
  else { clearTimeout(searchTimer); statusMenuOpen.value = false }
}, { immediate: true })
onMounted(() => {
  window.addEventListener('keydown', handleKeydown, true)
  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', refresh)
  mobileQuery.addEventListener('change', handleMobileChange)
  refreshTimer = setInterval(refresh, 30_000)
})
onUnmounted(() => {
  disposed = true
  requestSequence++
  clearTimeout(searchTimer)
  clearInterval(refreshTimer)
  window.removeEventListener('keydown', handleKeydown, true)
  window.removeEventListener('focus', refresh)
  document.removeEventListener('visibilitychange', refresh)
  mobileQuery.removeEventListener('change', handleMobileChange)
})
</script>

<template>
  <NDrawer :show="show" :width="drawerWidth" placement="right" display-directive="show" class="session-tasks-drawer" :aria-label="t('sessionTasks.title')" @update:show="emit('update:show', $event)">
    <NDrawerContent closable :native-scrollbar="true" :body-content-style="{ padding: '0', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }">
      <template #header><div class="drawer-title"><SessionTaskIcon :size="18" /><span>{{ t('sessionTasks.title') }}</span></div></template>
      <section class="session-tasks" :aria-label="t('sessionTasks.title')">
        <div class="task-list-scroll">
          <table class="task-list" :class="{ 'task-list--empty': loading || error || !tasks.length }" :aria-label="t('sessionTasks.title')" :aria-busy="loading">
            <colgroup><col /><col class="source-col" /><col class="status-col" /><col class="time-col" /><col class="action-col" /></colgroup>
            <thead><tr>
              <th scope="col"><div class="search-heading">
                <template v-if="!searchOpen && !search">{{ t('sessionTasks.task') }}</template>
                <NInput v-else ref="searchInput" v-model:value="search" clearable size="small" :maxlength="200" :placeholder="t('sessionTasks.search')" :input-props="{ 'aria-label': t('sessionTasks.search') }" @keydown.esc.stop="searchOpen = false; search = ''">
                  <template #prefix><SessionTaskIcon name="search" :size="15" /></template>
                </NInput>
                <button v-if="!searchOpen && !search" type="button" class="header-action search-action" :aria-label="t('sessionTasks.search')" @click="openSearch"><SessionTaskIcon name="search" :size="16" /></button>
              </div></th>
              <th scope="col" class="source-column">{{ t('sessionTasks.source') }}</th>
              <th scope="col" class="status-heading">
                <NDropdown v-model:show="statusMenuOpen" trigger="click" :options="statusOptions" :menu-props="() => ({ role: 'menu' })" :node-props="option => ({ role: 'menuitem', 'aria-label': String(option.label) })" @select="key => updateQuery({ taskStatus: key || undefined })">
                  <button type="button" class="header-action" :aria-label="t('sessionTasks.filterStatus')" :aria-expanded="statusMenuOpen" aria-haspopup="menu">{{ statusLabel }}<SessionTaskIcon name="chevron-down" :size="13" /></button>
                </NDropdown>
              </th>
              <th scope="col" class="time-column" :aria-sort="order === 'newest' ? 'descending' : 'ascending'"><button type="button" class="header-action" @click="updateQuery({ taskOrder: order === 'newest' ? 'oldest' : undefined })">{{ t('sessionTasks.updated') }}<SessionTaskIcon :name="order === 'newest' ? 'arrow-down' : 'arrow-up'" :size="13" /></button></th>
              <th scope="col" class="action-heading"><span class="sr-only">{{ t('sessionTasks.openChat') }}</span></th>
            </tr></thead>
            <tbody v-if="loading || error || !tasks.length"><tr><td colspan="5" class="list-state" role="status" aria-live="polite">
              <NSpin v-if="loading" size="small" :description="t('sessionTasks.loading')" />
              <div v-else-if="error" class="empty-state"><SessionTaskIcon :size="32" /><p>{{ t('sessionTasks.loadFailed') }}</p><NButton size="small" secondary @click="load()">{{ t('sessionTasks.retry') }}</NButton></div>
              <NEmpty v-else :description="t(search || status ? 'sessionTasks.noResults' : 'sessionTasks.empty')"><template #icon><SessionTaskIcon :size="32" /></template></NEmpty>
            </td></tr></tbody>
            <tbody v-else><tr v-for="task in tasks" :key="task.id" class="task-row" :class="{ 'task-row--completed': task.status === 'completed', 'task-row--closed': task.status === 'closed' }">
              <td class="task-cell">
                <a class="task-title" :href="taskHref(task)" :aria-label="t('sessionTasks.openTask', { title: task.title })">{{ task.title }}</a>
                <details class="task-description"><summary><span class="description-text">{{ task.summary }}</span><SessionTaskIcon name="chevron-down" :size="13" /></summary></details>
                <div class="mobile-source">
                  <img :src="taskAvatar(task).src" alt="" />
                  <div class="mobile-source-info">
                    <span class="mobile-session-name">{{ task.session_title || t('sessionTasks.untitled') }}</span>
                    <div class="mobile-meta">
                      <NDropdown trigger="click" :options="taskStatusOptions" :menu-props="() => ({ role: 'menu' })" :node-props="option => ({ role: 'menuitem', 'aria-label': String(option.label) })" @select="value => changeStatus(task, value)">
                        <button type="button" class="task-status task-status-button" :disabled="savingIds.has(task.id)" :aria-busy="savingIds.has(task.id)" :aria-label="t('sessionTasks.changeStatus', { title: task.title })" aria-haspopup="menu"><SessionTaskIcon :name="task.status === 'open' ? 'circle' : task.status" :size="13" />{{ t(`sessionTasks.${task.status}`) }}<SessionTaskIcon name="chevron-down" :size="11" /></button>
                      </NDropdown>
                      <time class="mobile-time" :datetime="new Date(task.updated_at).toISOString()">{{ formatTime(task.updated_at) }}</time>
                    </div>
                  </div>
                </div>
              </td>
              <td class="source-column"><div class="source-session"><img :src="taskAvatar(task).src" alt="" /><div><span>{{ task.session_title || t('sessionTasks.untitled') }}</span><small>{{ taskAvatar(task).label }}<span class="source-divider" aria-hidden="true" />{{ task.profile }}</small></div></div></td>
              <td class="status-cell">
                <NDropdown trigger="click" :options="taskStatusOptions" :menu-props="() => ({ role: 'menu' })" :node-props="option => ({ role: 'menuitem', 'aria-label': String(option.label) })" @select="value => changeStatus(task, value)">
                  <button type="button" class="task-status task-status-button" :disabled="savingIds.has(task.id)" :aria-busy="savingIds.has(task.id)" :aria-label="t('sessionTasks.changeStatus', { title: task.title })" aria-haspopup="menu"><SessionTaskIcon :name="task.status === 'open' ? 'circle' : task.status" :size="13" />{{ t(`sessionTasks.${task.status}`) }}<SessionTaskIcon name="chevron-down" :size="11" /></button>
                </NDropdown>
              </td>
              <td class="time-column"><time :datetime="new Date(task.updated_at).toISOString()">{{ formatTime(task.updated_at) }}</time></td>
              <td class="action-cell"><a class="task-open" :href="taskHref(task)" :aria-label="t('sessionTasks.openChat')"><SessionTaskIcon name="open" :size="17" /></a></td>
            </tr></tbody>
          </table>
        </div>
        <div v-if="total > 50 && !error" class="task-pagination"><NPagination :page="page" :page-size="50" :item-count="total" :page-slot="isMobile ? 3 : 5" :disabled="loading" @update:page="value => updateQuery({ taskPage: String(value) })" /></div>
      </section>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.drawer-title { display: flex; align-items: center; gap: 10px; color: $text-primary; font-size: calc(var(--font-size-base, 14px) * 16 / 14); font-weight: 600; }
.drawer-title svg { color: $text-secondary; }
.session-tasks { display: flex; flex: 1; flex-direction: column; width: 100%; height: 100%; min-height: 0; color: $text-primary; }
.task-list-scroll { flex: 1; min-height: 0; overflow: auto; }
.task-list { width: 100%; table-layout: fixed; border-collapse: collapse; }
.task-list--empty { height: 100%; }
.source-col { width: 25%; }
.status-col { width: 164px; }
.time-col { width: 140px; }
.action-col { width: 52px; }
th, td { padding: 18px 20px; border-bottom: var(--border-width, 1px) solid $border-light; text-align: start; }
th { height: 56px; padding-block: 10px; color: $text-muted; font-size: calc(var(--font-size-base, 14px) * 12 / 14); font-weight: 400; }
th:first-child, td:first-child { padding-inline-start: 28px; }
th:last-child, td:last-child { padding-inline: 4px 20px; }
.header-action { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 30px; padding: 3px 0; border: 0; color: inherit; background: transparent; font: inherit; cursor: pointer; }
.header-action:hover { color: $text-primary; }
.header-action:focus-visible, .task-title:focus-visible, .task-open:focus-visible, summary:focus-visible { outline: 2px solid $accent-primary; outline-offset: 4px; border-radius: var(--radius-component, 4px); }
.search-heading { display: flex; align-items: center; gap: 10px; max-width: 360px; }
.search-action { width: 28px; }
.task-row { vertical-align: top; }
.task-row:hover, .task-row:focus-within { background: rgba(var(--accent-primary-rgb), 0.025); }
.task-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: $text-primary; text-decoration: none; font-size: calc(var(--font-size-base, 14px) * 15 / 14); font-weight: 550; line-height: 1.6; }
.task-title:hover { text-decoration: underline; text-underline-offset: 4px; }
.task-description { margin-top: 5px; color: $text-secondary; font-size: calc(var(--font-size-base, 14px) * 13 / 14); line-height: 1.65; }
summary { display: flex; align-items: flex-start; gap: 8px; min-width: 0; list-style: none; cursor: pointer; }
summary::-webkit-details-marker { display: none; }
summary svg { flex-shrink: 0; margin-top: 5px; color: $text-muted; transition: transform 160ms ease; }
.description-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
details[open] summary { display: block; }
details[open] .description-text { display: block; width: 100%; min-width: 0; white-space: pre-wrap; overflow: visible; overflow-wrap: anywhere; }
details[open] summary svg { display: block; margin: 2px 0 0 auto; transform: rotate(180deg); }
.source-session { display: flex; align-items: flex-start; gap: 10px; min-width: 0; padding-top: 3px; color: $text-secondary; font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
.source-session img { width: 20px; height: 20px; margin-top: 2px; object-fit: contain; }
.source-session img, .mobile-source img { border-radius: 22%; }
.source-session div { min-width: 0; }
.source-session div > span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.6; }
.source-session small { display: flex; align-items: center; gap: 6px; margin-top: 4px; color: $text-muted; font-size: calc(var(--font-size-base, 14px) * 11 / 14); }
.source-divider { width: 2px; height: 2px; border-radius: 50%; background: currentColor; }
.task-status { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border: var(--border-width, 1px) solid $border-light; border-radius: var(--radius-component, 6px); color: $text-secondary; font-size: calc(var(--font-size-base, 14px) * 11 / 14); line-height: 1.5; white-space: nowrap; }
.task-status svg { flex-shrink: 0; }
.task-status-button { font-family: inherit; background: transparent; cursor: pointer; }
.task-status-button:hover { border-color: $accent-primary; }
.task-status-button:focus-visible { outline: 2px solid $accent-primary; outline-offset: 2px; }
.task-status-button:disabled { cursor: wait; opacity: 0.6; }
.task-row--completed .task-status { color: $success; background: rgba(var(--success-rgb), 0.06); border-color: transparent; }
.task-row--closed .task-status { color: $text-muted; }
time { display: block; padding-top: 7px; color: $text-muted; font-size: calc(var(--font-size-base, 14px) * 11 / 14); white-space: nowrap; }
.task-open { display: grid; place-items: center; width: 30px; height: 30px; color: $text-muted; border-radius: var(--radius-component, 5px); }
.task-open:hover { background: rgba(var(--accent-primary-rgb), 0.05); color: $text-primary; }
.mobile-source, .mobile-time { display: none; }
.list-state { height: 100%; padding: 24px; text-align: center; vertical-align: middle; }
.empty-state { display: flex; flex-direction: column; align-items: center; gap: 12px; color: $text-muted; }
.empty-state p { margin: 0; }
.task-pagination { display: flex; flex-shrink: 0; justify-content: center; padding: 16px 24px; border-top: var(--border-width, 1px) solid $border-light; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }

@media (max-width: 768px) {
  table, thead, tbody { display: block; }
  colgroup { display: none; }
  tr { display: grid; grid-template-columns: minmax(0, 1fr) 32px; }
  th, td { display: block; min-width: 0; }
  .task-list--empty { display: flex; flex-direction: column; }
  .task-list--empty tbody { flex: 1; min-height: 0; }
  .task-list--empty tbody tr { height: 100%; }
  .list-state { grid-column: 1 / -1; display: flex; align-items: center; justify-content: center; }
  .source-col { display: none; }
  .status-col { width: 108px; }
  .time-col { display: none; }
  .action-col { width: 32px; }
  .source-column, .time-column, .status-cell { display: none; }
  .status-heading { grid-column: 1 / -1; grid-row: 1; justify-self: end; display: flex; justify-content: flex-end; padding-inline-end: 20px; }
  thead th:first-child { grid-column: 1 / -1; grid-row: 1; padding-inline-end: 116px; }
  .action-heading { display: none; }
  th, td { padding: 18px 8px; }
  th:first-child, td:first-child { padding-inline-start: 20px; }
  th:last-child, td:last-child { padding-inline: 0 8px; }
  .task-title { font-size: var(--font-size-base, 14px); }
  .task-description { font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
  .task-description summary { gap: 4px; }
  .mobile-source { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
  .mobile-source img { width: 34px; height: 34px; object-fit: contain; flex-shrink: 0; }
  .mobile-source-info { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 4px; }
  .mobile-session-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: $text-secondary; font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
  .mobile-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .mobile-time { display: block; padding-top: 0; font-size: calc(var(--font-size-base, 14px) * 10 / 14); }
  .task-status { padding: 1px 5px; gap: 4px; font-size: calc(var(--font-size-base, 14px) * 10 / 14); }
  .task-open { width: 24px; height: 28px; }
}
@media (prefers-reduced-motion: reduce) { summary svg { transition: none; } }
</style>
