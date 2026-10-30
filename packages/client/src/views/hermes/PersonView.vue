<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '@/stores/hermes/app'
import SessionListSidebar from '@/components/hermes/chat/SessionListSidebar.vue'
import SessionSelectionToolbar from '@/components/hermes/chat/SessionSelectionToolbar.vue'
import ListActionsMenu from '@/components/layout/ListActionsMenu.vue'
import PageSidebarNav from '@/components/layout/PageSidebarNav.vue'
import HeaderSidebarToggle from '@/components/layout/HeaderSidebarToggle.vue'
import SessionListItem from '@/components/hermes/chat/SessionListItem.vue'
import { usePageSidebarState } from '@/composables/usePageSidebar'
import { batchDeleteSessions, renameSession, type SessionSummary } from '@/api/studio/sessions'
import { ref, nextTick, onMounted, onBeforeUnmount, computed, watch, provide } from 'vue'
import { useI18n } from 'vue-i18n'
import { NInput, NButton, NAlert, NTabs, NTabPane, NDrawer, NDrawerContent, NTooltip, NModal, NPopconfirm, NDropdown, useMessage } from 'naive-ui'
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import ChatInput from '@/components/hermes/chat/ChatInput.vue'
import NewChatPage from '@/components/hermes/chat/NewChatPage.vue'
import PersonBotPicker from '@/components/hermes/person/PersonBotPicker.vue'
import MessageList from '@/components/hermes/chat/MessageList.vue'
import SessionTasksDrawer from '@/components/hermes/tasks/SessionTasksDrawer.vue'
import PersonTaskChat from '@/components/hermes/person/PersonTaskChat.vue'
import PersonWorkspaceFiles from '@/components/hermes/person/PersonWorkspaceFiles.vue'
import { personTaskNavigation } from '@/components/hermes/person/task-navigation'
import PersonSchedulesPanel from '@/components/hermes/person/PersonSchedulesPanel.vue'
import PersonFlowsPanel from '@/components/hermes/person/PersonFlowsPanel.vue'
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
import { useChatStore, mapHermesSession, type Attachment } from '@/stores/hermes/chat'
import { useSettingsStore } from '@/stores/hermes/settings'
import { useSessionReadState } from '@/composables/useSessionReadState'
import { useChatSurfaceReveal } from '@/composables/useChatSurfaceReveal'
import type { AvailableModelGroup } from '@/api/hermes/system'
import { personRequest, type PersonSnapshot, type PersonModel, type PersonModelGroup, type PersonTask, type PersonSchedule, type PersonMemory, type PersonFlow } from '@/api/person'
import { DEFAULT_PERSON_BOT_TYPE, personBot } from '../../../../shared/person-bots'
import { modelReasoningEfforts } from '@/utils/model-reasoning-effort'
import { PERSON_AVATAR, chatSessionAgentAvatar } from '@/utils/chat-agent-avatar'
import { personBotLabel } from '@/utils/person-bot-label'
import { deploymentUrl } from '@/utils/deployment-url'
import { prepareAgentDeployment, type AgentDeploymentController } from '@/components/hermes/chat/agentDeployment.mjs'

const { t } = useI18n()
const message = useMessage()
const settingsStore = useSettingsStore()
const chatStore = useChatStore()
const appStore = useAppStore()
const route = useRoute()
const router = useRouter()
const { expanded: showSessions, isMobile } = usePageSidebarState()
watch(showSessions, value => appStore.setPageSidebarExpanded(value), { immediate: true })
const selectedSessionId = computed(() => typeof route.query.session === 'string' ? route.query.session : '')
provide('hermesWorkspaceFilePreview', computed(() => !!selectedSessionId.value))
const conversations = ref<SessionSummary[]>([])
const nextOffset = ref<number | null>(null)
const showCreate = ref(false)
const conversationName = ref('')
const creating = ref(false)
const showNewConversation = ref(false)
const newConversationName = ref(personBotLabel(personBot(DEFAULT_PERSON_BOT_TYPE)!))
const newConversationBot = ref<string>(DEFAULT_PERSON_BOT_TYPE)
const selectedBotName = computed(() => personBotLabel(personBot(newConversationBot.value)!))
const personLayout = ref<HTMLElement>()
let personDeployment: AgentDeploymentController | null = null
const newConversationDefaults = ref<PersonSnapshot | null>(null)
const newConversationModel = ref<PersonModel | null>(null)
const newConversationEffort = ref('')
const newConversationWorkspace = ref<string | null>(null)
const duplicateBotName = ref(false)
const createdConversation = ref<SessionSummary | null>(null)
watch(newConversationName, () => { duplicateBotName.value = false })
const draftLocked = computed(() => creating.value || !!createdConversation.value)
watch(selectedBotName, (name, previous) => {
  if (!draftLocked.value && (!newConversationName.value.trim() || newConversationName.value === previous)) newConversationName.value = name
})
function selectDraftBot(type: string) {
  if (draftLocked.value || !personBot(type)) return
  newConversationBot.value = type
  newConversationName.value = selectedBotName.value
}
const isNewConversation = computed(() => showNewConversation.value || (!!data.value && !data.value.session))
const renameConversationId = ref<string | null>(null)
const showConversationMenu = ref(false)
const contextConversationId = ref<string | null>(null)
const conversationMenuX = ref(0)
const conversationMenuY = ref(0)
const showDeleteConversation = ref(false)
const deleteConversationId = ref<string | null>(null)
const batchMode = ref(false)
const selectedConversationIds = ref(new Set<string>())
const showBatchDeleteConfirm = ref(false)
const conversationMenuOptions = computed(() => [
  { key: 'rename', label: t('chat.rename'), disabled: pending.value },
  { key: 'delete', label: t('common.delete'), disabled: pending.value },
  { key: 'batch', label: t('chat.toggleBatchMode'), disabled: pending.value },
])
const sidebarSessions = computed(() => conversations.value.map(mapHermesSession))
function resetConversationDraft() {
  newConversationBot.value = DEFAULT_PERSON_BOT_TYPE; newConversationName.value = selectedBotName.value
  newConversationModel.value = null; newConversationEffort.value = ''
  newConversationWorkspace.value = null; duplicateBotName.value = false
  newConversationDefaults.value = null; createdConversation.value = null
}
async function openCreateConversation() {
  if (pending.value || creating.value) return
  batchMode.value = false
  selectedConversationIds.value = new Set()
  showBatchDeleteConfirm.value = false
  renameConversationId.value = null
  resetConversationDraft(); error.value = ''
  showPanel.value = false; showTasks.value = false; chatTaskId.value = null; showModelPicker.value = false
  if (isMobile.value) showSessions.value = false
  showNewConversation.value = true
  try { newConversationDefaults.value = await personRequest<PersonSnapshot>('', undefined, 'GET', lifetime.signal) }
  catch (e) { if (!disposed) error.value = String(e) }
}
function openConversationMenu(event: MouseEvent, id: string) {
  event.preventDefault()
  if (pending.value || batchMode.value) return
  contextConversationId.value = id
  conversationMenuX.value = event.clientX
  conversationMenuY.value = event.clientY
  showConversationMenu.value = true
}
function selectConversationAction(action: string) {
  showConversationMenu.value = false
  const session = conversations.value.find(item => item.id === contextConversationId.value)
  if (!session || pending.value) return
  error.value = ''
  if (action !== 'batch' && isMobile.value) showSessions.value = false
  if (action === 'rename') {
    renameConversationId.value = session.id
    conversationName.value = session.title || ''
    showCreate.value = true
  } else if (action === 'delete') {
    deleteConversationId.value = session.id
    showDeleteConversation.value = true
  } else if (action === 'batch') {
    batchMode.value = true
    selectedConversationIds.value = new Set([session.id])
  }
}
function toggleBatchMode() {
  if (pending.value) return
  batchMode.value = !batchMode.value
  selectedConversationIds.value = new Set()
  showBatchDeleteConfirm.value = false
  showConversationMenu.value = false
}
function toggleConversationSelection(id: string) {
  if (pending.value) return
  const selected = new Set(selectedConversationIds.value)
  if (selected.has(id)) selected.delete(id); else selected.add(id)
  selectedConversationIds.value = selected
  if (!selected.size) showBatchDeleteConfirm.value = false
}
function selectAllConversations() {
  if (!pending.value) selectedConversationIds.value = new Set(conversations.value.map(session => session.id))
}
async function deleteSelectedConversations() {
  if (pending.value || !selectedConversationIds.value.size) return
  const targets = [...selectedConversationIds.value].map(id => ({ id }))
  pending.value = true; deletingConversations = true; snapshotSequence++; error.value = ''
  try {
    const result = await batchDeleteSessions(targets)
    const failedIds = new Set(result.errors.map(item => item.id))
    const deletedIds = new Set(targets.filter(target => !failedIds.has(target.id)).map(target => target.id))
    for (const id of deletedIds) chatStore.forgetSession(id)
    selectedConversationIds.value = failedIds
    await loadConversations()
    if (deletedIds.has(selectedSessionId.value)) {
      await router.replace({ name: 'hermes.person', query: conversations.value[0] ? { session: conversations.value[0].id } : {} })
    } else await refresh()
    if (result.deleted) message.success(t('chat.batchDeleteSuccess', { count: result.deleted }))
    if (result.failed) message.warning(t('chat.batchDeletePartial', { failed: result.failed }))
    else batchMode.value = false
    showBatchDeleteConfirm.value = false
  } catch (e) { error.value = String(e); message.error(t('chat.batchDeleteFailed')) }
  finally { pending.value = false; deletingConversations = false; void refresh() }
}
let conversationRequestSequence = 0
async function loadConversations(offset = 0) {
  const request = ++conversationRequestSequence
  const result = await personRequest<{ sessions: SessionSummary[]; next_offset: number | null }>(`/conversations?offset=${offset}`, undefined, 'GET', lifetime.signal)
  if (disposed || request !== conversationRequestSequence) return
  conversations.value = offset ? [...conversations.value, ...result.sessions.filter(session => !conversations.value.some(existing => existing.id === session.id))] : result.sessions
  nextOffset.value = result.next_offset
}
function selectConversation(id: string) {
  if (batchMode.value) { toggleConversationSelection(id); return }
  error.value = ''
  showNewConversation.value = false
  showConversationMenu.value = false
  if (isMobile.value) showSessions.value = false
  showTasks.value = false; chatTaskId.value = null
  return router.push({ name: 'hermes.person', query: { session: id } })
}
async function saveConversationName() {
  if (!conversationName.value.trim() || creating.value) return false
  creating.value = true; error.value = ''
  try {
    const title = conversationName.value.trim()
    const renameId = renameConversationId.value
    if (!renameId || !await renameSession(renameId, title)) throw new Error(t('chat.renameFailed'))
    await loadConversations()
    const session = conversations.value.find(item => item.id === renameId)
    if (session) chatStore.ensureSessionLoaded(session)
    await refresh()
    showCreate.value = false; conversationName.value = ''
    return true
  } catch (e) { error.value = String(e); return false }
  finally { creating.value = false }
}
async function createDraftConversation(text?: string, attachments?: Attachment[]) {
  if (!newConversationName.value.trim() || creating.value || (!text?.trim() && !attachments?.length)) return false
  if (!checkExecutionAgent()) return false
  personDeployment?.cancel()
  const deployment = prepareAgentDeployment(personLayout.value?.querySelector('.person-bot-option.selected img'), {
    imageSrc: deploymentUrl(personBot(newConversationBot.value)!.animations.done),
  })
  personDeployment = deployment
  creating.value = true; error.value = ''; duplicateBotName.value = false
  try {
    const created = createdConversation.value ?? await personRequest<SessionSummary>('/conversations', {
      title: newConversationName.value.trim(), bot_type: newConversationBot.value,
      ...(newConversationModel.value ? { model: newConversationModel.value } : {}), reasoning_effort: newConversationEffort.value,
      ...(newConversationWorkspace.value !== null ? { workspace: newConversationWorkspace.value, expected_revision: draftDefaults.value?.revision } : {}),
    }, 'POST', lifetime.signal)
    createdConversation.value = created
    chatStore.ensureSessionLoaded(created)
    await loadConversations()
    await selectConversation(created.id)
    await chatStore.switchSession(created.id)
    if (disposed) { deployment?.cancel(); return false }
    const sent = chatStore.sendMessage(text || '', attachments)
    deployment?.start(created.id)
    await sent
    createdConversation.value = null
    return true
  } catch (e) {
    deployment?.cancel()
    if (!disposed) {
      if ((e as { code?: string }).code === 'PERSON_BOT_NAME_EXISTS') duplicateBotName.value = true
      else {
        error.value = String(e)
        if ((e as { status?: number }).status === 409 && !createdConversation.value) {
          newConversationDefaults.value = await personRequest<PersonSnapshot>('', undefined, 'GET', lifetime.signal).catch(() => newConversationDefaults.value)
        }
      }
    }
    return false
  }
  finally { creating.value = false }
}
async function deleteConversation(id: string) {
  if (pending.value) return false
  pending.value = true; deletingConversations = true; snapshotSequence++; error.value = ''
  try {
    const snapshot = await personRequest<PersonSnapshot>(`?session_id=${encodeURIComponent(id)}`, undefined, 'GET', lifetime.signal)
    await personRequest(`/conversations/${encodeURIComponent(id)}`, { expected_history_revision: snapshot.history_revision }, 'DELETE', lifetime.signal)
    error.value = ''
    chatStore.forgetSession(id)
    await loadConversations()
    if (selectedSessionId.value === id) await router.replace({ name: 'hermes.person', query: conversations.value[0] ? { session: conversations.value[0].id } : {} })
    else await refresh()
    return true
  } catch (e) { if (!disposed) error.value = String(e); return false }
  finally { pending.value = false; deletingConversations = false; void refresh() }
}
function confirmDeleteConversation() {
  return deleteConversationId.value ? deleteConversation(deleteConversationId.value) : false
}
const data = ref<PersonSnapshot | null>(null)
const initializing = ref(true)
const chatSurface = ref<HTMLElement | null>(null)
useChatSurfaceReveal(chatSurface, () => selectedSessionId.value, () => !initializing.value
  && chatStore.activeSessionId === selectedSessionId.value && (!chatStore.isLoadingMessages || chatStore.messages.length > 0))
const switchingConversation = computed(() => !isNewConversation.value && !!selectedSessionId.value
  && data.value?.session?.id !== selectedSessionId.value)
const sessionStates = useSessionReadState(() => !initializing.value && !isNewConversation.value && !chatStore.isLoadingMessages
  && chatStore.activeSessionId === selectedSessionId.value ? selectedSessionId.value : null)
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
const chatInputRef = ref<InstanceType<typeof ChatInput> | null>(null)
const chatExecutionId = ref<string>()
function openTask(task: PersonTask) { showTasks.value = false; chatExecutionId.value = undefined; chatTaskId.value = task.id }
provide(personTaskNavigation, (taskId, executionId) => { showTasks.value = false; chatExecutionId.value = executionId; chatTaskId.value = taskId })
const showModelPicker = ref(false)
const modelsLoading = ref(false)
const modelTrigger = ref<HTMLElement | null>(null)
const modelGroups = ref<PersonModelGroup[]>([])
const settingsWrites = ref(0)
let settingsChain = Promise.resolve()
const optimisticEffort = ref<string | null>(null)
const { drawerWidth } = useTaskDrawerLayout()
let bootstrapping = true
let snapshotRequest: { sequence: number; sessionId: string; controller: AbortController } | null = null
let refreshAgain = false
let deletingConversations = false
let disposed = false
let snapshotSequence = 0
const lifetime = new AbortController()
const busy = computed(() => chatStore.isRunActive)
const draftDefaults = computed(() => newConversationDefaults.value ?? (data.value?.session ? null : data.value))
const currentModel = computed(() => isNewConversation.value ? newConversationModel.value ?? draftDefaults.value?.settings.model : data.value?.settings.model)
const draftConfig = computed(() => ({ ...currentModel.value, agent: 'ekko-agent' }))
const draftReasoningEfforts = computed(() => newConversationModel.value
  ? modelReasoningEfforts(pickerGroups.value, pickerProvider.value, newConversationModel.value.model)
  : draftDefaults.value?.reasoning_efforts ?? [])
const needsAgentSetup = computed(() => !(isNewConversation.value ? draftDefaults.value : data.value)?.settings.agents.length)
function checkExecutionAgent() {
  if (!needsAgentSetup.value) return true
  showAgentSetup.value = true
  return false
}
async function sendMessage(text: string, attachments?: Attachment[]) {
  if (!checkExecutionAgent()) return false
  await chatStore.sendMessage(text, attachments)
  return true
}
function configureAgents() {
  showAgentSetup.value = false
  openPanel('agents')
}
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
const reasoningEffort = computed(() => isNewConversation.value ? newConversationEffort.value : optimisticEffort.value ?? data.value?.settings.reasoningEffort ?? '')
function openPanel(name: string) { if (name === 'tasks') { showTasks.value = true; return }; tab.value = name; showPanel.value = true; void refresh() }
async function refresh() {
  if (disposed) return
  // Deletion broadcasts before its HTTP response; wait until the route is updated.
  const sequence = snapshotSequence
  const sessionId = selectedSessionId.value
  if (deletingConversations || (snapshotRequest?.sequence === sequence && snapshotRequest.sessionId === sessionId)) {
    refreshAgain = true; return
  }
  snapshotRequest?.controller.abort()
  const request = { sequence, sessionId, controller: new AbortController() }
  snapshotRequest = request; refreshAgain = false
  const isCurrent = () => !disposed && snapshotRequest === request && sequence === snapshotSequence && sessionId === selectedSessionId.value
  try {
    const next = await personRequest<PersonSnapshot>(sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '', undefined, 'GET', request.controller.signal)
    if (!isCurrent()) return
    data.value = next
    syncSession(next)
    if (next.session && (chatStore.activeSessionId !== next.session.id || (typeof route.query.message === 'string' && chatStore.focusMessageId !== route.query.message))) void chatStore.switchSession(next.session.id, typeof route.query.message === 'string' ? route.query.message : null).catch(e => { if (!disposed && sequence === snapshotSequence && sessionId === selectedSessionId.value) error.value = String(e) })
    else if (!next.session && chatStore.activeSessionId?.startsWith('person-main-')) chatStore.clearActiveSession()
  } catch (e) {
    if (!isCurrent()) return
    if ((e as { status?: number }).status === 404 && sessionId) {
      error.value = ''
      chatStore.forgetSession(sessionId)
      await router.replace({ name: 'hermes.person' })
    } else error.value = String(e)
  } finally {
    if (snapshotRequest === request) {
      snapshotRequest = null
      if (refreshAgain && !disposed && !deletingConversations) void refresh()
    }
  }
}
function flowAction(flow: PersonFlow, action: 'stop' | 'resume') {
  return act(() => personRequest('/flows/apply', { action, flow_id: flow.id, expected_revision: flow.revision, idempotency_key: crypto.randomUUID() }))
}
function openFlowResult(sessionId: string, messageId: number) {
  showPanel.value = false
  return router.push({ name: 'hermes.person', query: { session: sessionId, message: String(messageId) } })
}
function openFlowConversation(sessionId: string) {
  showPanel.value = false
  return router.push({ name:'hermes.person',query:{ session:sessionId } })
}
function openFlowTask(taskId: string) { showPanel.value = false; chatExecutionId.value = undefined; chatTaskId.value = taskId }
async function act(work: () => Promise<unknown>) {
  if (pending.value) return false
  pending.value = true; error.value = ''
  try { await work(); await refresh(); return true } catch (e) { if (!disposed) error.value = String(e); return false } finally { pending.value = false }
}
function syncSession(snapshot: PersonSnapshot) {
  if (!snapshot.session) return
  const session = chatStore.ensureSessionLoaded(snapshot.session)
  if (chatStore.activeSessionId === session.id) chatStore.activeSession = session
}
function folderName(path: string) { return path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || path }
function openWorkspace() {
  workspaceValue.value = isNewConversation.value ? newConversationWorkspace.value ?? draftDefaults.value?.settings.workspace ?? '' : data.value?.settings.workspace || ''
  showWorkspace.value = true
  void workspaceDirectories.init().catch(e => { error.value = String(e) })
}
async function saveWorkspace() {
  const workspace = workspaceValue.value?.trim() || ''
  if (isNewConversation.value) {
    newConversationWorkspace.value = workspace
    showWorkspace.value = false
    return true
  }
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
    await personRequest('/clear', { session_id: selectedSessionId.value, expected_history_revision: data.value.history_revision })
    const next = await personRequest<PersonSnapshot>(selectedSessionId.value ? `?session_id=${encodeURIComponent(selectedSessionId.value)}` : '', undefined, 'GET', lifetime.signal)
    if (disposed) return true
    snapshotSequence++; data.value = next; syncSession(next)
    showTasks.value = false; chatTaskId.value = null; showClearConfirm.value = false
    if (next.session) await chatStore.switchSession(next.session.id)
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
  const snapshot = isNewConversation.value ? draftDefaults.value : data.value
  const sessionId = isNewConversation.value ? undefined : snapshot?.session?.id
  if (!snapshot) return Promise.resolve(false)
  let revision = snapshot.revision
  let saved = false
  settingsWrites.value++
  error.value = ''
  settingsChain = settingsChain.then(async () => {
    if (disposed) return
    revision = (sessionId ? data.value : draftDefaults.value)?.revision ?? revision
    const result = await personRequest<Pick<PersonSnapshot, 'settings' | 'revision' | 'inherits_global_model' | 'reasoning_efforts' | 'compression' | 'contextTokens'>>('/settings', { ...patch, session_id: sessionId, expected_revision: revision }, 'PUT', lifetime.signal)
    saved = true
    if (!disposed && !sessionId) {
      newConversationDefaults.value = { ...snapshot, ...result }
      await refresh()
    } else if (!disposed && data.value && data.value.session?.id === sessionId && selectedSessionId.value === sessionId) {
      snapshotSequence++
      const model = result.settings.model
      data.value = { ...data.value, ...result, session: data.value.session ? { ...data.value.session,
        model: model?.model || '', provider: model?.provider || '', profile: model?.profile || data.value.session.profile,
        reasoning_effort: result.settings.reasoningEffort } : null }
      syncSession(data.value)
    } else if (!disposed) await refresh()
  }).catch(async e => {
    if (!disposed) {
      error.value = String(e)
      if (!sessionId) newConversationDefaults.value = await personRequest<PersonSnapshot>('', undefined, 'GET', lifetime.signal).catch(() => newConversationDefaults.value)
      await refresh()
    }
  })
    .finally(() => { settingsWrites.value--; if (!settingsWrites.value) optimisticEffort.value = null })
  return settingsChain.then(() => saved)
}
function selectModel(selection: { provider: string; model: string }) {
  const group = modelGroups.value.find(group => modelKey(group.profile, group.provider) === selection.provider)
  if (!group) return
  const model = { profile: group.profile, provider: group.provider, model: selection.model }
  if (isNewConversation.value) {
    newConversationModel.value = model
    if (!draftReasoningEfforts.value.includes(newConversationEffort.value)) newConversationEffort.value = ''
  } else void saveSettings({ model })
  showModelPicker.value = false
}
function selectEffort(value: string) {
  if (isNewConversation.value) newConversationEffort.value = value
  else { optimisticEffort.value = value; void saveSettings({ reasoning_effort: value }) }
}
function inheritModel() {
  if (isNewConversation.value) { newConversationModel.value = null; newConversationEffort.value = '' }
  else void saveSettings({ use_global_default: true })
  showModelPicker.value = false
}
function memoryForget(memory: PersonMemory) { return act(() => personRequest('/memory', { id: memory.id, expected_revision: memory.revision, forget: true })) }
function scheduleAction(schedule: PersonSchedule, action: string) { return act(() => personRequest('/schedules/apply', { schedule_id: schedule.id, action, expected_revision: schedule.revision, idempotency_key: crypto.randomUUID() })) }
function saveSchedule(input: Record<string, unknown>) { return act(() => personRequest('/schedules/apply', input)) }

watch(busy, (running, wasRunning) => { if (wasRunning && !running) void refresh() })
watch(selectedSessionId, id => {
  optimisticEffort.value = null; showModelPicker.value = false; showAgentSetup.value = false
  if (!id) resetConversationDraft()
})
const stopPersonUpdates = onPersonUpdated(() => { void loadConversations().catch(() => {}); void refresh() })
function resumeSelectedConversation() {
  const sessionId = selectedSessionId.value
  const focus = typeof route.query.message === 'string' ? route.query.message : null
  const cached = conversations.value.find(session => session.id === sessionId)
  if (!cached || (chatStore.activeSessionId === sessionId && chatStore.focusMessageId === focus)) return
  const sequence = snapshotSequence
  chatStore.ensureSessionLoaded(cached)
  void chatStore.switchSession(sessionId, focus)
    .catch(e => { if (!disposed && sequence === snapshotSequence) error.value = String(e) })
}
watch([selectedSessionId, () => route.query.message], async () => {
  if (bootstrapping) return
  snapshotSequence++
  chatTaskId.value = null; showTasks.value = false
  // Keep the shared message list and composer mounted, as ordinary chat does.
  resumeSelectedConversation()
  await refresh()
})
onMounted(async () => {
  try {
    chatStore.setRuntimeMode('default')
    await Promise.all([settingsStore.fetchSettings(), loadConversations().then(async () => {
      if (disposed) return
      if (!selectedSessionId.value && conversations.value.length) await router.replace({ name: 'hermes.person', query: { session: conversations.value[0].id } })
      await nextTick()
      bootstrapping = false
      resumeSelectedConversation()
      await refresh()
    })])
  } catch (e) { if (!disposed) error.value = String(e) }
  finally { bootstrapping = false; if (!disposed) initializing.value = false }
})
onBeforeUnmount(() => { stopPersonUpdates(); disposed = true; personDeployment?.cancel(); snapshotRequest?.controller.abort(); lifetime.abort() })
</script>

<template>
  <div ref="personLayout" class="person-layout">
    <SessionListSidebar class="person-sidebar" :expanded="showSessions" :aria-label="t('person.conversations')">
      <template #header>
        <PageSidebarNav active="person" :primary-label="t('person.newConversation')" @primary="openCreateConversation">
          <template #actions>
            <ListActionsMenu :label="t('chat.sessionListActions')" :batch-mode="batchMode" :batch-disabled="pending || !conversations.length" @batch="toggleBatchMode" />
            <button v-if="isMobile" class="session-close-btn" type="button" :aria-label="t('common.close')" @click="showSessions = false">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m18 6-12 12M6 6l12 12" /></svg>
            </button>
          </template>
        </PageSidebarNav>
        <SessionSelectionToolbar v-if="batchMode" v-model:show-confirm="showBatchDeleteConfirm" :selected-count="selectedConversationIds.size" :can-select-all="conversations.length > 0" :deleting="pending"
          @select-all="selectAllConversations" @delete="deleteSelectedConversations" @cancel="toggleBatchMode" />
      </template>
      <template #default>
            <SessionListItem v-for="session in sidebarSessions" :key="session.id" :session="session" :active="session.id === selectedSessionId" :pinned="false" :can-delete="!isMobile" :delete-disabled="pending"
              :selectable="batchMode" :selected="selectedConversationIds.has(session.id)" @toggle-select="toggleConversationSelection(session.id)"
              single-line :show-profile="false" :streaming="sessionStates.isWorking(session.id, chatStore.isSessionWorking(session.id))"
              :completed-unread="sessionStates.isUnread(session.id)" :to="router.resolve({ name: 'hermes.person', query: { session: session.id } }).href"
              :delete-confirm-text="t('person.deleteConversationConfirm')" @select="selectConversation(session.id)" @delete="deleteConversation(session.id)" @contextmenu="openConversationMenu($event, session.id)" />
            <NButton v-if="nextOffset !== null" quaternary block @click="loadConversations(nextOffset!)">{{ t('person.older') }}</NButton>
      </template>
    </SessionListSidebar>
  <PageLoading :show="initializing || (!isNewConversation && chatStore.isLoadingMessages)" :inert="switchingConversation || undefined" initial-only class="person-view"
    data-agent-deployment-surface :data-agent-deployment-session="selectedSessionId"
    :data-agent-deployment-active="!isNewConversation && !!selectedSessionId"
    :data-agent-deployment-status-session="selectedSessionId"
    :data-agent-deployment-status="chatStore.isLoadingMessages || chatStore.activeSessionId !== selectedSessionId ? 'pending' : chatStore.isRunActive ? 'working' : 'settled'">
    <PageHeader>
      <header class="person-header">
        <div class="header-left">
          <HeaderSidebarToggle class="header-sidebar-toggle" :expanded="showSessions" @toggle="showSessions = !showSessions" />
          <span class="person-title">{{ isNewConversation ? t('person.newConversation') : conversations.find(session => session.id === selectedSessionId)?.title || data?.session?.title || t('person.title') }}</span>
        </div>
        <div v-if="!isNewConversation" class="person-header-actions">
          <NTooltip trigger="hover">
            <template #trigger><NButton quaternary circle size="small" :aria-label="t('person.tasks')" :aria-expanded="showTasks" :disabled="!data?.session" @click="openPanel('tasks')"><SessionTaskIcon :size="17" /></NButton></template>
            {{ t('person.tasks') }}
          </NTooltip>
          <NTooltip trigger="hover">
            <template #trigger><NButton quaternary circle size="small" :disabled="!data?.can_clear || busy || pending || settingsWrites > 0" :aria-label="t('chat.workspace')" :aria-expanded="showWorkspace" @click="openWorkspace"><FolderIcon /></NButton></template>
            {{ data?.settings.workspace || t('chat.workspace') }}
          </NTooltip>
          <PersonWorkspaceFiles :session-id="data?.session?.id" :workspace="data?.session?.workspace" :submit="sendMessage"
            :active="!chatTaskId && data?.session?.id === selectedSessionId" @attach="file => chatInputRef?.addFiles([file])" />
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
      <NewChatPage v-if="isNewConversation" :title="t('person.newConversation')" :subtitle="t('person.welcome')">
        <template #cards>
          <PersonBotPicker :value="newConversationBot" :disabled="draftLocked" @update:value="selectDraftBot" />
        </template>
        <div class="person-new-name">
          <div class="person-new-name-input">
            <NInput v-model:value="newConversationName" :maxlength="100" :disabled="draftLocked" :placeholder="t('person.botNamePlaceholder')" :status="duplicateBotName ? 'error' : undefined"
              :input-props="{ id: 'person-conversation-name', 'aria-label': t('person.botName'), 'aria-invalid': duplicateBotName, 'aria-describedby': duplicateBotName ? 'person-bot-name-error' : undefined }" />
            <NTooltip trigger="hover">
              <template #trigger><NButton quaternary circle :disabled="draftLocked" :aria-label="t('chat.workspace')" :aria-expanded="showWorkspace" @click="openWorkspace"><FolderIcon /></NButton></template>
              {{ (newConversationWorkspace ?? draftDefaults?.settings.workspace) || t('chat.workspace') }}
            </NTooltip>
          </div>
          <span v-if="duplicateBotName" id="person-bot-name-error" class="person-name-error" role="alert">{{ t('person.botNameExists') }}</span>
        </div>
        <ChatInput draft hide-settings managed-reasoning-effort :persist-draft="false" :draft-config="draftConfig"
          :send-disabled="!newConversationName.trim() || !currentModel || creating || settingsWrites > 0" :submit="createDraftConversation"
          :model-label="modelLabel" :model-disabled="draftLocked" :model-expanded="showModelPicker"
          :reasoning-effort="reasoningEffort" :reasoning-effort-disabled="draftLocked || !currentModel"
          :scoped-reasoning-efforts="draftReasoningEfforts" :default-effort-label="t('person.defaultEffort')"
          @update:reasoning-effort="selectEffort" @model-click="openModels" />
      </NewChatPage>
      <NModal v-model:show="showWorkspace" preset="dialog" :title="t('chat.setWorkspaceTitle')" :positive-text="t('common.ok')" :negative-text="t('common.cancel')"
        :positive-button-props="{ loading: settingsWrites > 0, disabled: isNewConversation ? draftLocked : busy || pending || !data?.can_clear }" style="width: var(--studio-workspace-picker-width)" @positive-click="saveWorkspace">
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
      <div v-if="!isNewConversation" ref="chatSurface" class="person-chat-surface">
      <div v-if="data.session" class="person-chat-messages">
      <PersonTaskActivity :count="sessionStates.backgroundCount(selectedSessionId)" :avatar="chatSessionAgentAvatar(chatStore.activeSession)" :expanded="showTasks" @open="openPanel('tasks')" />
      <MessageList v-if="data.session" :user-label="t('person.you')" hide-tool-calls hide-run-usage hide-reasoning :activity-label="t('person.executing')" />
      </div>
      <div v-if="data.session" class="person-compose">
        <button v-if="!currentModel" type="button" class="person-model-hint" @click="openModels">{{ t('person.defaultUnavailable') }}</button>
        <ChatInput ref="chatInputRef" hide-settings managed-reasoning-effort :send-disabled="!currentModel || pending || settingsWrites > 0" :submit="sendMessage"
          :model-label="modelLabel" :model-disabled="busy || settingsWrites > 0" :model-expanded="showModelPicker"
          :reasoning-effort="reasoningEffort" :reasoning-effort-disabled="busy || !currentModel"
          :default-effort-label="t('person.defaultEffort')"
          :scoped-reasoning-efforts="data.reasoning_efforts" @update:reasoning-effort="selectEffort" @model-click="openModels" />
      </div>
      </div>
      <NModal v-model:show="showAgentSetup" preset="dialog" :title="t('person.agentSetupTitle')" :aria-label="t('person.agentSetupTitle')"
        :positive-text="t('person.configureAgents')" :negative-text="t('common.cancel')"
        :closable="true" :close-on-esc="true" @positive-click="configureAgents">
        {{ t('person.agentSetupHint') }}
      </NModal>
      <ModelCascader v-model:show="showModelPicker" :groups="pickerGroups" :custom-models="{}" :display-name="displayModel"
        :provider="pickerProvider" :model="currentModel?.model" :loading="modelsLoading || settingsWrites > 0" :trigger-element="modelTrigger"
        :title="t('chat.setModelTitle')" @select="selectModel">
        <template #footer>
          <NButton size="small" quaternary :disabled="creating || (!isNewConversation && (busy || settingsWrites > 0))" @click="inheritModel">{{ (isNewConversation ? !newConversationModel : data.inherits_global_model) ? t('person.followingGlobalModel') : t('person.useGlobalModel') }}</NButton>
        </template>
      </ModelCascader>
      <NDrawer v-model:show="showPanel" :width="drawerWidth" placement="right" :close-on-esc="true" class="person-workspace-drawer">
        <NDrawerContent closable :native-scrollbar="false" :body-content-style="{ padding: '0' }">
          <template #header><div class="workspace-heading"><span class="workspace-brand">{{ PERSON_AVATAR.label }}</span><span class="workspace-divider">/</span><span>{{ t('person.title') }}</span></div></template>
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
              <NTabPane name="flows" :tab-props="{ role: 'tab', 'aria-selected': tab === 'flows' }">
                <template #tab><span class="workspace-tab"><SessionTaskIcon :size="17" />{{ t('person.flows') }}</span></template>
                <PersonFlowsPanel :flows="data.flows || []" :saving="pending" @action="flowAction" @open-result="openFlowResult" @open-task="openFlowTask" @open-conversation="openFlowConversation" />
              </NTabPane>
              <NTabPane name="schedules" :tab-props="{ role: 'tab', 'aria-selected': tab === 'schedules' }">
                <template #tab><span class="workspace-tab"><PersonPanelIcon name="schedule" :size="17" />{{ t('person.schedules') }}<span class="workspace-tab-count">{{ data.schedules.length }}</span></span></template>
                <PersonSchedulesPanel :session-id="data.session?.id || ''" :schedules="data.schedules" :tasks="data.tasks" :timezone="data.settings.timezone" :saving="pending" :save="saveSchedule" @action="scheduleAction" />
              </NTabPane>
              <NTabPane name="memory" :tab-props="{ role: 'tab', 'aria-selected': tab === 'memory' }">
                <template #tab><span class="workspace-tab"><PersonPanelIcon name="memory" :size="17" />{{ t('person.memory') }}<span class="workspace-tab-count">{{ data.memories.length }}</span></span></template>
                <PersonMemoryPanel :memories="data.memories" :saving="pending" @forget="memoryForget" />
              </NTabPane>
            </NTabs>
          </div>
        </NDrawerContent>
      </NDrawer>
      <SessionTasksDrawer v-if="data.session" v-model:show="showTasks" person :person-session-id="data.session.id" @open-person-task="openTask" />
      <PersonTaskChat v-if="chatTaskId && data.session" :key="`${chatTaskId}:${chatExecutionId || ''}`" :execution-id="chatExecutionId" :task-id="chatTaskId" :main-session-id="data.session.id" @close="chatTaskId = null; refresh()" />
    </template>
  </PageLoading>
    <NDropdown trigger="manual" placement="bottom-start" :show="showConversationMenu" :x="conversationMenuX" :y="conversationMenuY" :options="conversationMenuOptions"
      @select="selectConversationAction" @clickoutside="showConversationMenu = false" />
    <NModal v-model:show="showCreate" preset="dialog" :title="renameConversationId ? t('chat.renameSession') : t('person.newConversation')" :positive-text="renameConversationId ? t('common.ok') : t('common.create')" :negative-text="t('common.cancel')"
      :positive-button-props="{ loading: creating, disabled: !conversationName.trim() }" :mask-closable="!creating" :close-on-esc="!creating" @positive-click="saveConversationName">
      <NInput v-model:value="conversationName" :maxlength="100" :placeholder="t('person.conversationName')" :input-props="{ 'aria-label': t('person.conversationName') }" @keydown.enter.prevent="saveConversationName" />
      <NAlert v-if="error" type="error">{{ error }}</NAlert>
    </NModal>
    <NModal v-model:show="showDeleteConversation" preset="dialog" :title="t('chat.deleteSession')" :positive-text="t('common.confirm')" :negative-text="t('common.cancel')"
      :positive-button-props="{ loading: pending }" :mask-closable="!pending" :close-on-esc="!pending" @positive-click="confirmDeleteConversation">
      {{ t('person.deleteConversationConfirm') }}
      <NAlert v-if="error" type="error">{{ error }}</NAlert>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.person-layout { display: flex; width: 100%; height: 100%; min-width: 0; min-height: 0; position: relative; }
.person-new-name { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; font-size: 12px; color: $text-secondary; }
.person-name-error { color: $error; }
.person-new-name-input { display: flex; align-items: center; gap: 8px; }
.person-new-name-input :deep(.n-input) { flex: 1; min-width: 0; }
.person-view { flex: 1; display: flex; flex-direction: column; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; color: $text-primary; background: var(--card-container-bg, var(--bg-main-surface)); }
.person-header { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; padding: calc(21px * var(--spacing-scale, 1)) calc(20px * var(--spacing-scale, 1)); border-bottom: var(--border-width, 1px) solid $border-color; }
.header-left { display: flex; align-items: center; gap: calc(8px * var(--spacing-scale, 1)); overflow: hidden; flex: 1; min-width: 0; }
.person-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: calc(var(--font-size-base, 14px) * 16 / 14); font-weight: 600; }
.person-header-actions { display: flex; flex-shrink: 0; align-items: center; gap: 4px; }
.person-workspace-shortcuts { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.person-alert { margin: 12px; width: auto; }
.person-compose { flex-shrink: 0; min-width: 0; }
.person-chat-surface { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.person-chat-messages { position: relative; display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.person-model-hint { display: block; margin: 0 auto; border: 0; background: transparent; color: $accent-primary; cursor: pointer; font: inherit; font-size: 12px; padding: 8px; }
.person-workspace { padding: 0 24px 28px; min-width: 0; }
.workspace-heading { display: flex; align-items: center; gap: 12px; font-size: 13px; font-weight: 400; color: $text-secondary; }
.workspace-brand { font-size: 17px; font-weight: 600; letter-spacing: -.4px; color: $text-primary; }
.workspace-divider { color: $text-muted; }
.workspace-tab { display: flex; align-items: center; gap: 8px; padding: 8px 0; font-size: 13px; }
.workspace-tab-count { color: $text-muted; font-size: 11px; font-variant-numeric: tabular-nums; margin-inline-start: 4px; }
.workspace-error { margin-top: 20px; }
.person-workspace :deep(.n-tab-pane) { padding-top: 28px; }
@media (max-width: 640px) { .person-workspace { padding: 0 16px 24px; } .workspace-tab { gap: 6px; } .workspace-tab-count { display: none; } }
@media (max-width: 768px) {
  .person-sidebar :deep(.session-item) { -webkit-touch-callout: none; user-select: none; }
  .person-header { padding: calc(16px + env(safe-area-inset-top, 0px)) 12px 16px 52px; }
  .person-title { font-size: 14px; }
}
</style>
