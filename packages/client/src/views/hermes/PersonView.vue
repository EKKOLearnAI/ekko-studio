<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, watch, provide } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NAlert, NTabs, NTabPane, NDrawer, NDrawerContent, NTooltip, NModal, NPopconfirm, useMessage } from 'naive-ui'
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import ChatInput from '@/components/hermes/chat/ChatInput.vue'
import MessageList from '@/components/hermes/chat/MessageList.vue'
import SessionTasksDrawer from '@/components/hermes/tasks/SessionTasksDrawer.vue'
import PersonTaskChat from '@/components/hermes/person/PersonTaskChat.vue'
import { personTaskNavigation } from '@/components/hermes/person/task-navigation'
import PersonSchedulesPanel from '@/components/hermes/person/PersonSchedulesPanel.vue'
import PersonMemoryPanel from '@/components/hermes/person/PersonMemoryPanel.vue'
import PersonPanelIcon from '@/components/hermes/person/PersonPanelIcon.vue'
import { useTaskDrawerLayout } from '@/components/hermes/tasks/useTaskDrawerLayout'
import PersonAgentSettings from '@/components/hermes/person/PersonAgentSettings.vue'
import PersonGeneralSettings from '@/components/hermes/person/PersonGeneralSettings.vue'
import PersonTaskActivity from '@/components/hermes/person/PersonTaskActivity.vue'
import { onPersonUpdated } from '@/api/studio/chat'
import ModelCascader from '@/components/hermes/models/ModelCascader.vue'
import SessionTaskIcon from '@/components/common/SessionTaskIcon.vue'
import FolderIcon from '@/components/common/FolderIcon.vue'
import BroomIcon from '@/components/common/BroomIcon.vue'
import FolderPicker from '@/components/hermes/chat/FolderPicker.vue'
import { useDefaultWorkspace } from '@/composables/useDefaultWorkspace'
import { useChatStore } from '@/stores/hermes/chat'
import { useSettingsStore } from '@/stores/hermes/settings'
import { usePersonPresenceStore } from '@/stores/hermes/person-presence'
import type { AvailableModelGroup } from '@/api/hermes/system'
import { personRequest, type PersonSnapshot, type PersonModelGroup, type PersonTask, type PersonSchedule, type PersonMemory } from '@/api/person'

const { t } = useI18n()
const message = useMessage()
const settingsStore = useSettingsStore()
const chatStore = useChatStore()
const personPresence = usePersonPresenceStore()
const data = ref<PersonSnapshot | null>(null)
const initializing = ref(true)
const error = ref('')
const pending = ref(false)
const tab = ref('general')
const showTasks = ref(false)
const showPanel = ref(false)
const showAgentSetup = ref(false)
const showWorkspace = ref(false)
const showClearConfirm = ref(false)
const workspaceValue = ref<string | null>('')
const workspaceDirectories = useDefaultWorkspace()
const { defaultWorkspaces, recentWorkspaces } = workspaceDirectories
const chatTaskId = ref<string | null>(null)
function openTask(task: PersonTask) { showTasks.value = false; chatTaskId.value = task.id }
provide(personTaskNavigation, taskId => { showTasks.value = false; chatTaskId.value = taskId })
const showModelPicker = ref(false)
const modelsLoading = ref(false)
const modelTrigger = ref<HTMLElement | null>(null)
const modelGroups = ref<PersonModelGroup[]>([])
const settingsWrites = ref(0)
let settingsChain = Promise.resolve()
const optimisticEffort = ref<string | null>(null)
const { drawerWidth } = useTaskDrawerLayout()
let refreshing = false
let refreshAgain = false
let disposed = false
let snapshotSequence = 0
const lifetime = new AbortController()
const busy = computed(() => chatStore.isRunActive)
const currentModel = computed(() => data.value?.settings.model)
const needsAgentSetup = computed(() => !!data.value && !data.value.settings.agents.length)
watch([needsAgentSetup, showPanel], ([needed, panelOpen]) => { showAgentSetup.value = needed && !panelOpen })
const modelKey = (profile: string, provider: string) => JSON.stringify([profile, provider])
const pickerProvider = computed(() => currentModel.value ? modelKey(currentModel.value.profile, currentModel.value.provider) : '')
const pickerGroups = computed<AvailableModelGroup[]>(() => modelGroups.value.map(group => ({
  ...group, provider: modelKey(group.profile, group.provider),
  label: new Set(modelGroups.value.map(item => item.profile)).size > 1 ? `${group.label} · ${group.profile}` : group.label,
  base_url: '', api_key: '',
})))
function displayModel(model: string, provider: string) {
  return pickerGroups.value.find(group => group.provider === provider)?.model_meta?.[model]?.alias || model
}
const modelLabel = computed(() => currentModel.value ? displayModel(currentModel.value.model, pickerProvider.value) : t('models.selectModel'))
const reasoningEffort = computed(() => optimisticEffort.value ?? data.value?.settings.reasoningEffort ?? '')
function openPanel(name: string) { if (name === 'tasks') { showTasks.value = true; return }; tab.value = name; showPanel.value = true; void refresh() }
async function refresh() {
  if (disposed) return
  if (refreshing) { refreshAgain = true; return }
  refreshing = true
  const sequence = snapshotSequence
  try {
    const next = await personRequest<PersonSnapshot>('', undefined, 'GET', lifetime.signal)
    if (disposed) return
    if (sequence !== snapshotSequence) { refreshAgain = true; return }
    data.value = next
    syncSession(next)
  } catch (e) { if (!disposed) error.value = String(e) } finally { refreshing = false; if (refreshAgain && !disposed) { refreshAgain = false; void refresh() } }
}
async function act(work: () => Promise<unknown>) {
  if (pending.value) return false
  pending.value = true; error.value = ''
  try { await work(); await refresh(); return true } catch (e) { if (!disposed) error.value = String(e); return false } finally { pending.value = false }
}
function syncSession(snapshot: PersonSnapshot) {
  const session = chatStore.ensureSessionLoaded(snapshot.session)
  if (chatStore.activeSessionId === session.id) chatStore.activeSession = session
}
function folderName(path: string) { return path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || path }
function openWorkspace() {
  workspaceValue.value = data.value?.session.workspace || ''
  showWorkspace.value = true
  void workspaceDirectories.init().catch(e => { error.value = String(e) })
}
async function saveWorkspace() {
  const workspace = workspaceValue.value?.trim() || ''
  await saveSettings({ workspace })
  if (data.value?.settings.workspace !== workspace) return false
  await refresh()
  showWorkspace.value = false
  return true
}
async function clearHistory() {
  if (!data.value?.can_clear || busy.value || pending.value || settingsWrites.value) return false
  pending.value = true; error.value = ''
  try {
    await personRequest('/clear', { expected_history_revision: data.value.history_revision })
    const next = await personRequest<PersonSnapshot>('', undefined, 'GET', lifetime.signal)
    if (disposed) return true
    snapshotSequence++; data.value = next; syncSession(next)
    showTasks.value = false; chatTaskId.value = null; showClearConfirm.value = false
    await chatStore.switchSession(next.session.id)
    message.success(t('person.cleared'))
    return true
  } catch (e) { if (!disposed) { error.value = String(e); await refresh() }; return false }
  finally { pending.value = false }
}
async function openModels(event: MouseEvent) {
  modelTrigger.value = event.currentTarget as HTMLElement
  showModelPicker.value = true
  modelsLoading.value = true
  try { modelGroups.value = (await personRequest<{ groups: PersonModelGroup[] }>('/models', undefined, 'GET', lifetime.signal)).groups }
  catch (e) { if (!disposed) error.value = String(e) }
  finally { modelsLoading.value = false }
}
function saveSettings(patch: Record<string, unknown>) {
  let saved = false
  settingsWrites.value++
  error.value = ''
  settingsChain = settingsChain.then(async () => {
    if (disposed || !data.value) return
    const result = await personRequest<Pick<PersonSnapshot, 'settings' | 'revision' | 'inherits_global_model' | 'reasoning_efforts' | 'compression' | 'contextTokens'>>('/settings', { ...patch, expected_revision: data.value.revision }, 'PUT', lifetime.signal)
    snapshotSequence++
    if (!disposed && data.value) {
      const model = result.settings.model
      data.value = { ...data.value, ...result, session: { ...data.value.session,
        model: model?.model || '', provider: model?.provider || '', profile: model?.profile || data.value.session.profile,
        reasoning_effort: result.settings.reasoningEffort } }
      syncSession(data.value)
      saved = true
    }
  }).catch(async e => { if (!disposed) { error.value = String(e); await refresh() } })
    .finally(() => { settingsWrites.value--; if (!settingsWrites.value) optimisticEffort.value = null })
  return settingsChain.then(() => saved)
}
function selectModel(selection: { provider: string; model: string }) {
  const group = modelGroups.value.find(group => modelKey(group.profile, group.provider) === selection.provider)
  if (!group) return
  void saveSettings({ model: { profile: group.profile, provider: group.provider, model: selection.model } })
  showModelPicker.value = false
}
function selectEffort(value: string) { optimisticEffort.value = value; void saveSettings({ reasoning_effort: value }) }
function inheritModel() { void saveSettings({ use_global_default: true }); showModelPicker.value = false }
function memoryForget(memory: PersonMemory) { return act(() => personRequest('/memory', { id: memory.id, expected_revision: memory.revision, forget: true })) }
function scheduleAction(schedule: PersonSchedule, action: string) { return act(() => personRequest('/schedules/apply', { schedule_id: schedule.id, action, expected_revision: schedule.revision, idempotency_key: crypto.randomUUID() })) }
function saveSchedule(input: Record<string, unknown>) { return act(() => personRequest('/schedules/apply', input)) }

watch(busy, (running, wasRunning) => { if (wasRunning && !running) void refresh() })
const stopPersonUpdates = onPersonUpdated(event => { if (event.session_id === data.value?.session.id) void refresh() })
onMounted(async () => {
  try {
    chatStore.setRuntimeMode('default')
    await Promise.all([settingsStore.fetchSettings(), refresh()])
    if (!disposed && data.value) await chatStore.switchSession(data.value.session.id)
  } catch (e) { if (!disposed) error.value = String(e) }
  finally { if (!disposed) initializing.value = false }
})
onBeforeUnmount(() => { stopPersonUpdates(); disposed = true; lifetime.abort() })
</script>

<template>
  <PageLoading :show="initializing || chatStore.isLoadingMessages" initial-only class="person-view">
    <PageHeader>
      <header class="person-header">
        <span class="person-title">{{ t('person.title') }}</span>
        <div class="person-header-actions">
          <NTooltip trigger="hover">
            <template #trigger><NButton quaternary circle size="small" :aria-label="t('person.tasks')" :aria-expanded="showTasks" @click="openPanel('tasks')"><SessionTaskIcon :size="17" /></NButton></template>
            {{ t('person.tasks') }}
          </NTooltip>
          <NTooltip trigger="hover">
            <template #trigger><NButton quaternary circle size="small" :disabled="!data?.can_clear || busy || pending || settingsWrites > 0" :aria-label="t('chat.workspace')" :aria-expanded="showWorkspace" @click="openWorkspace"><FolderIcon /></NButton></template>
            {{ data?.session.workspace || t('chat.workspace') }}
          </NTooltip>
          <NPopconfirm v-model:show="showClearConfirm" :positive-text="t('common.confirm')" :negative-text="t('common.cancel')" :positive-button-props="{ loading: pending }" :disabled="!data?.can_clear || busy || pending || settingsWrites > 0" @positive-click="clearHistory">
            <template #trigger>
              <NTooltip trigger="hover">
                <template #trigger><NButton quaternary circle size="small" :aria-label="t('person.clearHistoryTasks')" :disabled="!data?.can_clear || busy || pending || settingsWrites > 0"><BroomIcon /></NButton></template>
                {{ data?.can_clear && !busy ? t('person.clearHistoryTasks') : t('person.clearHistoryTasksBusy') }}
              </NTooltip>
            </template>
            {{ t('person.clearHistoryTasksConfirm') }}
          </NPopconfirm>
          <NTooltip trigger="hover">
            <template #trigger><NButton quaternary circle size="small" :aria-label="t('person.settings')" :aria-expanded="showPanel" @click="openPanel('general')"><PersonPanelIcon name="settings" :size="17" /></NButton></template>
            {{ t('person.settings') }}
          </NTooltip>
        </div>
      </header>
    </PageHeader>
    <NAlert v-if="error" class="person-alert" type="error" closable @close="error = ''">{{ error }}</NAlert>
    <template v-if="data">
      <PersonTaskActivity :count="personPresence.backgroundTaskCount" :expanded="showTasks" @open="openPanel('tasks')" />
      <NModal v-model:show="showWorkspace" preset="dialog" :title="t('chat.setWorkspaceTitle')" :positive-text="t('common.ok')" :negative-text="t('common.cancel')"
        :positive-button-props="{ loading: settingsWrites > 0, disabled: busy || pending || !data?.can_clear }" style="width: var(--studio-workspace-picker-width)" @positive-click="saveWorkspace">
        <p>{{ t('person.workspaceHint') }}</p>
        <div v-if="defaultWorkspaces.length" class="person-workspace-shortcuts">
          <NButton v-for="path in defaultWorkspaces" :key="path" size="tiny" :title="path" @click="workspaceValue = path">{{ folderName(path) }}</NButton>
        </div>
        <FolderPicker v-model="workspaceValue" show-favorite :favorite="!!workspaceValue && workspaceDirectories.isDefaultWorkspace(workspaceValue)" :favorite-disabled="!workspaceValue"
          @toggle-favorite="workspaceValue && workspaceDirectories.toggleDefaultWorkspace(workspaceValue).catch(e => { error = String(e) })" />
        <div v-if="recentWorkspaces.length" class="person-workspace-shortcuts">
          <NButton v-for="entry in recentWorkspaces" :key="entry.path" size="tiny" :title="entry.path" @click="workspaceValue = entry.path">{{ folderName(entry.path) }}</NButton>
        </div>
      </NModal>
      <MessageList :user-label="t('person.you')" hide-tool-calls />
      <div class="person-compose">
        <button v-if="needsAgentSetup" type="button" class="person-model-hint" @click="openPanel('agents')">{{ t('person.agentSetupTitle') }} · {{ t('person.configureAgents') }}</button>
        <button v-if="!currentModel" type="button" class="person-model-hint" @click="openModels">{{ t('person.defaultUnavailable') }}</button>
        <ChatInput hide-settings managed-reasoning-effort :send-disabled="needsAgentSetup || !currentModel || pending || settingsWrites > 0"
          :model-label="modelLabel" :model-disabled="busy || settingsWrites > 0" :model-expanded="showModelPicker"
          :reasoning-effort="reasoningEffort" :reasoning-effort-disabled="busy || !currentModel"
          :default-effort-label="t('person.defaultEffort')"
          :scoped-reasoning-efforts="data.reasoning_efforts" @update:reasoning-effort="selectEffort" @model-click="openModels" />
      </div>
      <ModelCascader v-model:show="showModelPicker" :groups="pickerGroups" :custom-models="{}" :display-name="displayModel"
        :provider="pickerProvider" :model="currentModel?.model" :loading="modelsLoading || settingsWrites > 0" :trigger-element="modelTrigger"
        :title="t('chat.setModelTitle')" @select="selectModel">
        <template #footer>
          <NButton size="small" quaternary :disabled="busy || settingsWrites > 0" @click="inheritModel">{{ data.inherits_global_model ? t('person.followingGlobalModel') : t('person.useGlobalModel') }}</NButton>
        </template>
      </ModelCascader>
      <NDrawer v-model:show="showPanel" :width="drawerWidth" placement="right" :close-on-esc="true" class="person-workspace-drawer">
        <NDrawerContent closable :native-scrollbar="false" :body-content-style="{ padding: '0' }">
          <template #header><div class="workspace-heading"><span class="workspace-brand">zhezhe</span><span class="workspace-divider">/</span><span>{{ t('person.title') }}</span></div></template>
          <div class="person-workspace">
            <NAlert v-if="error && !['general', 'agents'].includes(tab)" class="workspace-error" type="error" closable @close="error = ''">{{ error }}</NAlert>
            <NTabs v-model:value="tab" type="line" size="large" animated>
              <NTabPane name="general" display-directive="show:lazy" :tab-props="{ role: 'tab', 'aria-selected': tab === 'general' }">
                <template #tab><span class="workspace-tab"><PersonPanelIcon name="settings" :size="17" />{{ t('person.generalSettings') }}</span></template>
                <PersonGeneralSettings :settings="data.settings" :compression="data.compression" :context-tokens="data.contextTokens" :model-label="modelLabel" :save-error="error" :saving="settingsWrites > 0" :busy="busy || data.busy" :save="saveSettings" />
              </NTabPane>
              <NTabPane name="agents" display-directive="show:lazy" :tab-props="{ role: 'tab', 'aria-selected': tab === 'agents' }">
                <template #tab><span class="workspace-tab"><PersonPanelIcon name="agents" :size="17" />{{ t('person.agentsTab') }}<span class="workspace-tab-count">{{ data.settings.agents.length }}</span></span></template>
                <PersonAgentSettings :agents="data.settings.agents" :save-error="error" :saving="settingsWrites > 0" @save="saveSettings({ agents: JSON.parse(JSON.stringify($event)) })" />
              </NTabPane>
              <NTabPane name="schedules" :tab-props="{ role: 'tab', 'aria-selected': tab === 'schedules' }">
                <template #tab><span class="workspace-tab"><PersonPanelIcon name="schedule" :size="17" />{{ t('person.schedules') }}<span class="workspace-tab-count">{{ data.schedules.length }}</span></span></template>
                <PersonSchedulesPanel :schedules="data.schedules" :tasks="data.tasks" :timezone="data.settings.timezone" :saving="pending" :save="saveSchedule" @action="scheduleAction" />
              </NTabPane>
              <NTabPane name="memory" :tab-props="{ role: 'tab', 'aria-selected': tab === 'memory' }">
                <template #tab><span class="workspace-tab"><PersonPanelIcon name="memory" :size="17" />{{ t('person.memory') }}<span class="workspace-tab-count">{{ data.memories.length }}</span></span></template>
                <PersonMemoryPanel :memories="data.memories" :saving="pending" @forget="memoryForget" />
              </NTabPane>
            </NTabs>
          </div>
        </NDrawerContent>
      </NDrawer>
      <NModal v-model:show="showAgentSetup" preset="card" class="person-setup-dialog" :bordered="false" :closable="false" :content-style="{ padding: '0' }" :mask-closable="false" :close-on-esc="false" role="dialog" aria-modal="true" aria-labelledby="person-setup-title" aria-describedby="person-setup-hint">
          <div class="person-setup-icon"><PersonPanelIcon name="agents" :size="28" /></div>
          <h2 id="person-setup-title">{{ t('person.agentSetupTitle') }}</h2>
          <p id="person-setup-hint">{{ t('person.agentSetupHint') }}</p>
          <NButton type="primary" size="large" block @click="openPanel('agents')">{{ t('person.configureAgents') }}<template #icon><PersonPanelIcon name="settings" :size="18" /></template></NButton>
      </NModal>
      <SessionTasksDrawer v-model:show="showTasks" person @open-person-task="openTask" />
      <PersonTaskChat v-if="chatTaskId" :task-id="chatTaskId" :main-session-id="data.session.id" @close="chatTaskId = null; refresh()" />
    </template>
  </PageLoading>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.person-view { display: flex; flex-direction: column; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; color: $text-primary; background: var(--card-container-bg, var(--bg-main-surface)); }
.person-header { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; padding: calc(21px * var(--spacing-scale, 1)) calc(20px * var(--spacing-scale, 1)); border-bottom: var(--border-width, 1px) solid $border-color; }
.person-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: calc(var(--font-size-base, 14px) * 16 / 14); font-weight: 600; }
.person-header-actions { display: flex; flex-shrink: 0; align-items: center; gap: 4px; }
.person-workspace-shortcuts { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.person-alert { margin: 12px; width: auto; }
.person-compose { flex-shrink: 0; min-width: 0; }
.person-model-hint { display: block; margin: 0 auto; border: 0; background: transparent; color: $accent-primary; cursor: pointer; font: inherit; font-size: 12px; padding: 8px; }
.person-workspace { padding: 0 24px 28px; min-width: 0; }
:global(.person-setup-dialog) { width: min(420px, calc(100vw - 32px)); box-sizing: border-box; padding: 32px; border: 1px solid $border-color; border-radius: var(--radius-container, 16px); color: $text-primary; }
.person-setup-icon { display: grid; place-items: center; width: 56px; height: 56px; margin-bottom: 24px; border: 1px solid $border-color; border-radius: var(--radius-component, 12px); color: $accent-primary; }
.person-setup-dialog h2 { margin: 0 0 12px; font-size: 23px; font-weight: 600; letter-spacing: -.4px; line-height: 1.4; }
.person-setup-dialog p { margin: 0 0 28px; font-size: 14px; line-height: 1.8; color: $text-secondary; }
.workspace-heading { display: flex; align-items: center; gap: 12px; font-size: 13px; font-weight: 400; color: $text-secondary; }
.workspace-brand { font-size: 17px; font-weight: 600; letter-spacing: -.4px; color: $text-primary; }
.workspace-divider { color: $text-muted; }
.workspace-tab { display: flex; align-items: center; gap: 8px; padding: 8px 0; font-size: 13px; }
.workspace-tab-count { color: $text-muted; font-size: 11px; font-variant-numeric: tabular-nums; margin-inline-start: 4px; }
.workspace-error { margin-top: 20px; }
.person-workspace :deep(.n-tab-pane) { padding-top: 28px; }
@media (max-width: 640px) { .person-workspace { padding: 0 16px 24px; } .workspace-tab { gap: 6px; } .workspace-tab-count { display: none; } }
@media (max-width: 768px) {
  .person-header { padding: calc(16px + env(safe-area-inset-top, 0px)) 12px 16px 52px; }
  .person-title { font-size: 14px; }
}
</style>
