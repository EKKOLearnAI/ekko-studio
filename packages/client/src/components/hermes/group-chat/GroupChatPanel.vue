<script setup lang="ts">
import DshSessionPresetSelect from "@/components/coding-agents/dsh/DshSessionPresetSelect.vue"
import { ref, computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, provide, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useMessage, NInput, NButton, NSpace, NSelect, NPopconfirm, NInputNumber, NDropdown, NModal, NPopover, NDrawer, NDrawerContent, NSwitch, type DropdownOption } from 'naive-ui'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import { useAppStore } from '@/stores/hermes/app'
import { useProfilesStore } from '@/stores/hermes/profiles'
import {
    createGroupAgentPreset,
    deleteGroupAgentPreset,
    getRoomSummary,
    groupAgentPresetToRoomAgentInput,
    listGroupAgentPresets,
    listStoppedRoomAgentHandoffs,
    continueRoomAgentHandoff,
    updateGroupAgentPreset,
    updateRoomConfig,
    updateRoomSummary,
} from '@/api/studio/group-chat'
import {
    decideGroupAgentPairing,
    leaveLocalGroupAgentRoom,
    listLocalGroupAgentConnections,
    listPendingGroupAgentPairings,
    renameLocalGroupAgentRoom,
    updateGuestAgentPolicy,
    type GroupAgentPairingRequest,
    type LocalGroupAgentConnection,
} from '@/api/studio/group-chat-agent-link'
import GroupMessageList from './GroupMessageList.vue'
import GroupChatInput from './GroupChatInput.vue'
import GroupRoomAgentAvatar from './GroupRoomAgentAvatar.vue'
import MessageQueueFloatPanel from '@/components/hermes/chat/MessageQueueFloatPanel.vue'
import PendingInteractionCountdown from '@/components/hermes/chat/PendingInteractionCountdown.vue'
import FolderPicker from '@/components/hermes/chat/FolderPicker.vue'
import ProfileAvatar from '@/components/hermes/profiles/ProfileAvatar.vue'
import PageSidebarNav from '@/components/layout/PageSidebarNav.vue'
import { copyToClipboard } from '@/utils/clipboard'
import type { Attachment } from '@/stores/hermes/chat'
import type {
    GroupAgentPreset,
    GroupAgentPresetInput,
    GroupChatMention,
    MemberInfo,
    RoomAgent,
    RoomAgentInput,
    RoomInfo,
    RoomSummaryAnchor,
    RoomSummaryConfig,
    RoomSummaryState,
    RoomSummaryReview,
} from '@/api/studio/group-chat'
import { useFilesStore } from '@/stores/hermes/files'
import { useToolPanelStore } from '@/stores/hermes/tool-panel'
import { hasDesktopBrowserBridge } from '@/utils/desktop-bridge'
import { OPEN_DESKTOP_BROWSER_PANEL_EVENT } from '@/utils/desktop-browser'
import {
    createBrowserAnnotationAttachment,
    type BrowserAnnotationSubmission,
} from '@/utils/browser-annotation-submit'
import { canScopedCodingAgentUseProvider } from '@/utils/codingAgentProviders'
import {
    inferCodingAgentApiMode,
    normalizeCodingAgentApiMode,
    type CodingAgentApiMode,
} from '@/api/coding-agents'
import type { ProfileAvatar as ProfileAvatarData } from '@/api/hermes/profiles'
import {
    defaultGroupAgentAvatar,
    groupAgentAvatar,
    parseStoredAvatar,
} from '@/utils/group-agent-avatar'
import { generateGroupChatInviteCode } from '@/utils/group-chat-invite-code'
import { buildRemoteGroupChatRooms, type RemoteGroupChatRoom } from '@/utils/group-chat-remote-rooms'
import { handoffErrorTranslationKey } from './handoff-presentation'
import { clearGroupChatRoomDraft } from './group-chat-room-drafts'
import {
    fetchAgentStatusSnapshot,
    isAgentStatusAvailable,
    type AgentStatusSnapshot,
} from '@/api/agent-status'

const FilesPanel = defineAsyncComponent(async () => (await import('@/components/hermes/chat/FilesPanel.vue')).default)
const FilePreview = defineAsyncComponent(async () => (await import('@/components/hermes/files/FilePreview.vue')).default)
const WorkspaceDiffPreview = defineAsyncComponent(async () => (await import('@/components/hermes/files/WorkspaceDiffPreview.vue')).default)
const DesktopBrowserPanel = defineAsyncComponent(async () => (await import('@/components/hermes/chat/DesktopBrowserPanel.vue')).default)
const TerminalPanel = defineAsyncComponent(async () => (await import('@/components/hermes/chat/TerminalPanel.vue')).default)

const props = withDefaults(defineProps<{
    standalone?: boolean
}>(), {
    standalone: false,
})

const emit = defineEmits<{
    requestAgentLink: []
    requestAgentEdit: [agent: RoomAgent]
}>()
const { t } = useI18n()
const router = useRouter()
const message = useMessage()
const appStore = useAppStore()
const store = useGroupChatStore()
const profilesStore = useProfilesStore()
const filesStore = useFilesStore()
const toolPanelStore = useToolPanelStore()

const showSidebar = ref(!props.standalone && window.innerWidth > 768)
watch(
    showSidebar,
    expanded => appStore.setPageSidebarExpanded(expanded),
    { immediate: true },
)
const showCreateModal = ref(false)
const showCloneModal = ref(false)
const showAddAgentDrawer = ref(false)
const showGroupChatRefactorNotice = ref(false)
const showManualRoomLinkModal = ref(false)
const manualRoomLink = ref('')
const manualRoomLinkInput = ref<HTMLInputElement | null>(null)
const showMemberRail = ref(true)
const editingAgent = ref<RoomAgent | null>(null)
const isSavingAgent = ref(false)
const agentStatusSnapshot = ref<AgentStatusSnapshot | null>(null)
const showRoomSettingsModal = ref(false)
const showUserProfileModal = ref(false)
const userProfileName = ref('')
const userProfileDescription = ref('')
const isSavingUserProfile = ref(false)
const summaryConfig = ref<RoomSummaryConfig>({
    summaryProfile: 'default',
    summaryProvider: '',
    summaryModel: '',
    summaryApiMode: 'chat_completions',
    summaryEveryTurns: 20,
    evaluationProfile: 'default',
    summaryReviewMode: 'inherit',
    summaryRevisionEnabled: false,
    messageRoutingMode: 'off',
})
const agentHandoffEnabledDraft = ref(true)
const agentHandoffMaxDepthDraft = ref<number | null>(4)
const agentHandoffUnlimitedDraft = ref(false)
const agentHandoffRecommendation = computed(() => Math.max(4, store.agents.length + 1))
const isContinuingHandoff = ref(false)
const roomSummaryState = ref<RoomSummaryState | null>(null)
const roomSummaryAnchor = ref<RoomSummaryAnchor | null>(null)
const roomSummaryReview = ref<RoomSummaryReview | null>(null)
const roomSummaryDraft = ref('')
const isLoadingRoomSummary = ref(false)
const isSavingRoomSummary = ref(false)
const inlineSummaryStatus = ref<{
    roomId: string
    status: 'summarizing' | 'success' | 'failed'
    error: string
} | null>(null)
let inlineSummaryStatusTimer: ReturnType<typeof setTimeout> | null = null
const roomNameDraft = ref('')
const isSavingRoomName = ref(false)
const inviteCodeDraft = ref('')
const isSavingInviteCode = ref(false)
const pendingAgentPairings = ref<GroupAgentPairingRequest[]>([])
const remoteRoomConnections = ref<LocalGroupAgentConnection[]>([])
const localRoomsCollapsed = ref(false)
const remoteRoomsCollapsed = ref(false)
const isDecidingAgentPairing = ref(false)
const clarifyResponse = ref('')
const allowGuestAgentsDraft = ref(false)
const maxGuestAgentsPerMemberDraft = ref(1)
const allowRemoteWorkspaceAccessDraft = ref(false)
const isSavingGuestAgentPolicy = ref(false)
let agentPairingRefreshTimer: ReturnType<typeof setInterval> | null = null
let remoteRoomRefreshTimer: ReturnType<typeof setInterval> | null = null
const selectedAgentType = ref<GroupAgentType>('hermes')
const selectedAgentMode = ref<'scoped' | 'global'>('scoped')
const selectedProfile = ref<string | null>(null)
const selectedAgentProvider = ref('')
const selectedAgentModel = ref('')
const selectedAgentApiMode = ref<CodingAgentApiMode>('codex_responses')
const selectedAgentReasoningEffort = ref('')
const selectedRuntimePreset = ref<string>()
const selectedRuntimePresetReady = ref(false)
const agentName = ref('')
const agentDescription = ref('')
const agentAvatar = ref<ProfileAvatarData | null>(null)
const agentAvatarFileInput = ref<HTMLInputElement | null>(null)
const agentPresets = ref<GroupAgentPreset[]>([])
const selectedAgentPresetId = ref<string | null>(null)
const showAgentPresetDialog = ref(false)
const agentPresetDialogMode = ref<'select' | 'manage'>('select')
const agentPresetSearch = ref('')
const pendingAgentPresetId = ref<string | null>(null)
const isLoadingAgentPresets = ref(false)
const agentPresetLoadError = ref('')
const isSavingAgentPreset = ref(false)
const cloneSourceRoomId = ref<string | null>(null)
const cloneRoomName = ref('')
const cloneInviteCode = ref('')
const contextRoomId = ref<string | null>(null)
const showRoomContextMenu = ref(false)
const roomContextMenuX = ref(0)
const roomContextMenuY = ref(0)
const remoteRoomContext = ref<RemoteGroupChatRoom | null>(null)
const showRemoteRoomContextMenu = ref(false)
const remoteRoomContextMenuX = ref(0)
const remoteRoomContextMenuY = ref(0)
const showRemoteRoomRenameModal = ref(false)
const remoteRoomNameDraft = ref('')
const remoteRoomBeingRenamed = ref<RemoteGroupChatRoom | null>(null)
const remoteRoomBeingLeft = ref<RemoteGroupChatRoom | null>(null)
const isUpdatingRemoteRoom = ref(false)
const groupChatInputRef = ref<(InstanceType<typeof GroupChatInput> & {
    addFiles?: (files: File[]) => void
    insertMention?: (name: string, participantId?: string) => void
    completeSend?: (success: boolean) => void
}) | null>(null)
const summarySettingsSectionRef = ref<HTMLElement | null>(null)
const chatDropCounter = ref(0)
const isChatDropActive = ref(false)
const groupChatContentWrapperRef = ref<HTMLElement | null>(null)
const groupChatSurfaceRef = ref<HTMLElement | null>(null)
let roomFadeAnimation: Animation | null = null
const showWorkspacePanel = ref(false)
const toolPanelTransitionReady = ref(false)
const activeWorkspacePanel = ref<'files' | 'terminal' | 'browser'>('files')
const desktopBrowserAvailable = hasDesktopBrowserBridge()
const workspacePanelMobile = ref(window.innerWidth <= 768)
const GROUP_CHAT_REFACTOR_NOTICE_STORAGE_KEY = 'hermes.groupChat.refactorNotice.v1.acknowledged'
const WORKSPACE_PANEL_MIN_WIDTH = 360
const WORKSPACE_PANEL_DEFAULT_WIDTH = 560
const WORKSPACE_PANEL_STORAGE_KEY = 'hermes.groupChat.workspacePanelWidth'
const workspacePanelWidth = ref(loadWorkspacePanelWidth())
const workspaceResizeStart = ref<{ x: number; width: number; deltaSign: 1 | -1 } | null>(null)
const workspacePanelStyle = computed(() => ({
    width: workspacePanelMobile.value ? '100%' : `${workspacePanelWidth.value}px`,
}))

const profileOptions = computed(() =>
    profilesStore.profiles.map(p => ({ label: p.name, value: p.name }))
)

type GroupAgentType = 'hermes' | 'ekko' | 'codex' | 'claude' | 'pi' | 'grok' | 'opencode' | 'dsh'

const groupAgentTypeDefinitions: Array<{ label: string; value: GroupAgentType }> = [
    { label: 'Hermes', value: 'hermes' },
    { label: 'Ekko', value: 'ekko' },
    { label: 'Claude', value: 'claude' },
    { label: 'Codex', value: 'codex' },
    { label: 'Pi', value: 'pi' },
    { label: 'Grok', value: 'grok' },
    { label: 'OpenCode', value: 'opencode' },
  { label: 'DeepSeek Harness', value: 'dsh' },
]

const groupAgentTypeOptions = computed(() => groupAgentTypeDefinitions.map((option) => {
    const disabled = !isAgentStatusAvailable(agentStatusSnapshot.value, option.value)
    return {
        ...option,
        disabled,
        label: disabled ? `${option.label} · ${t('codingAgents.notInstalled')}` : option.label,
    }
}))

const firstAvailableGroupAgentType = computed<GroupAgentType | null>(() =>
    groupAgentTypeOptions.value.find(option => !option.disabled)?.value || null
)
const supportsGlobalAgentMode = computed(() => ['claude', 'codex', 'pi', 'grok', 'opencode', 'dsh'].includes(selectedAgentType.value))
const usesGlobalAgentMode = computed(() => supportsGlobalAgentMode.value && selectedAgentMode.value === 'global')
const agentModeOptions = computed(() => [
    { label: t('codingAgents.launchModeGlobal'), value: 'global' },
    { label: t('codingAgents.launchModeScoped'), value: 'scoped' },
])

function groupAgentDisplayName(agent: GroupAgentType): string {
    return groupAgentTypeDefinitions.find(option => option.value === agent)?.label || agent
}

function isGroupAgentAvailable(agent: GroupAgentType): boolean {
    return isAgentStatusAvailable(agentStatusSnapshot.value, agent)
}

function warnAgentUnavailable(agent: GroupAgentType) {
    message.warning(t('codingAgents.installRequired', { agent: groupAgentDisplayName(agent) }))
}

async function refreshAgentAvailability() {
    try {
        agentStatusSnapshot.value = await fetchAgentStatusSnapshot()
    } catch {
        agentStatusSnapshot.value = null
    }
}

function getAgentModelGroups(profile: string) {
    return (appStore.profileModelGroups.find(entry => entry.profile === profile)?.groups || [])
        .filter((group) => {
            if (group.provider === 'moa') return selectedAgentType.value === 'hermes'
            if (selectedAgentType.value === 'hermes') return true
            const codingAgentId = selectedAgentType.value === 'ekko'
                ? 'ekko-agent'
                : selectedAgentType.value === 'claude'
                    ? 'claude-code'
                    : selectedAgentType.value === 'pi'
                        ? 'pi'
                        : selectedAgentType.value === 'grok'
                            ? 'grok'
                            : selectedAgentType.value === 'dsh' ? 'dsh' : selectedAgentType.value === 'opencode'
                                ? 'opencode'
                            : 'codex'
            return canScopedCodingAgentUseProvider(codingAgentId, group.provider)
        })
}

function getDefaultAgentModel(profile: string) {
    const groups = getAgentModelGroups(profile)
    const selectedGroup = groups.find(group => group.provider === appStore.selectedProvider)
    if (
        profile === profilesStore.activeProfileName &&
        selectedGroup?.models.includes(appStore.selectedModel)
    ) {
        return { provider: appStore.selectedProvider, model: appStore.selectedModel }
    }
    const profileModels = appStore.profileModelGroups.find(entry => entry.profile === profile)
    const defaultGroup = groups.find(group => group.provider === profileModels?.default_provider)
    const fallbackGroup = defaultGroup || groups.find(group => group.models.length > 0)
    return {
        provider: fallbackGroup?.provider || '',
        model: fallbackGroup?.models.includes(profileModels?.default || '')
            ? profileModels?.default || ''
            : fallbackGroup?.models[0] || '',
    }
}

const agentProviderOptions = computed(() =>
    getAgentModelGroups(selectedProfile.value || '').map(group => ({
        label: group.label || group.provider,
        value: group.provider,
    }))
)

const agentModelOptions = computed(() => {
    const group = getAgentModelGroups(selectedProfile.value || '')
        .find(item => item.provider === selectedAgentProvider.value)
    return (group?.models || []).map(modelId => ({
        label: appStore.displayModelName(modelId, group?.provider),
        value: modelId,
    }))
})

const selectedAgentProviderGroup = computed(() =>
    getAgentModelGroups(selectedProfile.value || '')
        .find(item => item.provider === selectedAgentProvider.value)
)

const agentApiModeOptions = computed(() => [
    { label: t('codingAgents.protocolOpenAiChat'), value: 'chat_completions' },
    { label: t('codingAgents.protocolOpenAiResponses'), value: 'codex_responses' },
    { label: t('codingAgents.protocolAnthropicMessages'), value: 'anthropic_messages' },
])
const filteredAgentPresets = computed(() => {
    const query = agentPresetSearch.value.trim().toLocaleLowerCase()
    if (!query) return agentPresets.value
    return agentPresets.value.filter((preset) => {
        const searchable = [
            preset.name,
            preset.description,
            preset.profile,
            preset.provider,
            preset.model,
            preset.validationError,
        ].join(' ').toLocaleLowerCase()
        return searchable.includes(query)
    })
})
const pendingAgentPreset = computed(() =>
    agentPresets.value.find(preset => preset.id === pendingAgentPresetId.value) || null
)

const agentReasoningEffortOptions = computed(() => [
    { label: t('chat.reasoningEffort.options.default'), value: '' },
    { label: t('chat.reasoningEffort.options.none'), value: 'none' },
    { label: t('chat.reasoningEffort.options.minimal'), value: 'minimal' },
    { label: t('chat.reasoningEffort.options.low'), value: 'low' },
    { label: t('chat.reasoningEffort.options.medium'), value: 'medium' },
    { label: t('chat.reasoningEffort.options.high'), value: 'high' },
    { label: t('chat.reasoningEffort.options.xhigh'), value: 'xhigh' },
    { label: t('chat.reasoningEffort.options.max'), value: 'max' },
])

const summaryModelGroups = computed(() =>
    (appStore.profileModelGroups.find(entry => entry.profile === summaryConfig.value.summaryProfile)?.groups || [])
        .filter(group => group.provider !== 'moa' && canScopedCodingAgentUseProvider('ekko-agent', group.provider))
)
const summaryProviderOptions = computed(() => summaryModelGroups.value.map(group => ({
    label: group.label || group.provider,
    value: group.provider,
})))
const selectedSummaryProviderGroup = computed(() =>
    summaryModelGroups.value.find(group => group.provider === summaryConfig.value.summaryProvider)
)
const summaryModelOptions = computed(() =>
    (selectedSummaryProviderGroup.value?.models || []).map(model => ({
        label: appStore.displayModelName(model, summaryConfig.value.summaryProvider),
        value: model,
    }))
)
const summaryApiModeOptions = computed(() => [
    { label: t('codingAgents.protocolOpenAiChat'), value: 'chat_completions' },
    { label: t('codingAgents.protocolOpenAiResponses'), value: 'codex_responses' },
    { label: t('codingAgents.protocolAnthropicMessages'), value: 'anthropic_messages' },
])
const liveRoomSummaryReview = computed(() => {
    const roomId = store.currentRoomId
    return roomId ? store.roomSummaryReviews.get(roomId) || roomSummaryReview.value : roomSummaryReview.value
})
const liveRoomSummaryState = computed(() => {
    const roomId = store.currentRoomId
    return (roomId && store.roomSummaryStates.get(roomId))
        || (roomSummaryState.value?.roomId === roomId ? roomSummaryState.value : null)
})

function clearInlineSummaryStatusTimer() {
    if (inlineSummaryStatusTimer === null) return
    clearTimeout(inlineSummaryStatusTimer)
    inlineSummaryStatusTimer = null
}

function hideInlineSummaryStatus() {
    clearInlineSummaryStatusTimer()
    inlineSummaryStatus.value = null
}

watch(
    () => {
        const state = liveRoomSummaryState.value
        return state ? `${state.roomId}:${state.version}:${state.status}:${state.updatedAt}` : ''
    },
    async () => {
        const state = liveRoomSummaryState.value
        if (!state || state.roomId !== store.currentRoomId) {
            hideInlineSummaryStatus()
            return
        }
        if (state.status === 'summarizing') {
            clearInlineSummaryStatusTimer()
            inlineSummaryStatus.value = {
                roomId: state.roomId,
                status: 'summarizing',
                error: '',
            }
        } else if (state.status === 'idle') {
            hideInlineSummaryStatus()
        } else if (
            (state.status === 'success' || state.status === 'failed')
            && inlineSummaryStatus.value?.roomId === state.roomId
            && inlineSummaryStatus.value.status === 'summarizing'
        ) {
            inlineSummaryStatus.value = {
                roomId: state.roomId,
                status: state.status,
                error: state.status === 'failed' ? String(state.lastError || '').trim() : '',
            }
            clearInlineSummaryStatusTimer()
            const completedRoomId = state.roomId
            const timer = setTimeout(() => {
                if (inlineSummaryStatusTimer !== timer) return
                if (inlineSummaryStatus.value?.roomId === completedRoomId) {
                    inlineSummaryStatus.value = null
                }
                inlineSummaryStatusTimer = null
            }, state.status === 'failed' ? 6000 : 3000)
            inlineSummaryStatusTimer = timer
        }
        if (!showRoomSettingsModal.value) return
        roomSummaryState.value = state
        if (state.status === 'success') roomSummaryDraft.value = state.summary
        try {
            const result = await getRoomSummary(state.roomId)
            if (store.currentRoomId === state.roomId) roomSummaryAnchor.value = result.anchor
        } catch { /* the next settings open refreshes it */ }
    },
    { flush: 'sync' },
)

function handleSummaryProviderChange(provider: string) {
    summaryConfig.value.summaryProvider = provider
    const group = summaryModelGroups.value.find(item => item.provider === provider)
    summaryConfig.value.summaryModel = group?.models[0] || ''
    summaryConfig.value.summaryApiMode = normalizeCodingAgentApiMode(
        group?.api_mode,
        inferCodingAgentApiMode(group?.provider || provider, group?.base_url),
    )
}

const agentAvatarPreview = computed(() =>
    agentAvatar.value || defaultGroupAgentAvatar(selectedAgentType.value)
)

const canConfirmAddAgent = computed(() =>
    Boolean(
        isGroupAgentAvailable(selectedAgentType.value) &&
        (selectedAgentType.value !== 'dsh' || (selectedRuntimePreset.value && selectedRuntimePresetReady.value)) &&
        selectedProfile.value &&
        (usesGlobalAgentMode.value || (
            selectedAgentProvider.value &&
            selectedAgentModel.value &&
            (selectedAgentType.value === 'hermes' || selectedAgentApiMode.value)
        )),
    )
)

function syncAgentApiMode() {
    const group = selectedAgentProviderGroup.value
    selectedAgentApiMode.value = normalizeCodingAgentApiMode(
        group?.api_mode,
        inferCodingAgentApiMode(group?.provider || selectedAgentProvider.value, group?.base_url),
    )
}

function syncAgentModelSelection(profile: string) {
    const defaults = getDefaultAgentModel(profile)
    selectedAgentProvider.value = defaults.provider
    selectedAgentModel.value = defaults.model
    selectedAgentReasoningEffort.value = ''
    syncAgentApiMode()
}

function handleAgentProfileChange(profile: string) {
    selectedProfile.value = profile
    syncAgentModelSelection(profile)
}

function handleAgentTypeChange(agent: GroupAgentType) {
    if (!isGroupAgentAvailable(agent)) {
        warnAgentUnavailable(agent)
        return
    }
    selectedRuntimePreset.value = undefined
    selectedRuntimePresetReady.value = false
    selectedAgentType.value = agent
    if (!['claude', 'codex', 'pi', 'grok', 'opencode', 'dsh'].includes(agent)) selectedAgentMode.value = 'scoped'
    if (selectedProfile.value) syncAgentModelSelection(selectedProfile.value)
}

function handleAgentModeChange(mode: 'scoped' | 'global') {
    selectedAgentMode.value = mode
    selectedAgentPresetId.value = null
}

function handleAgentProviderChange(provider: string) {
    selectedAgentProvider.value = provider
    selectedAgentModel.value = agentModelOptions.value[0]?.value || ''
    selectedAgentReasoningEffort.value = ''
    syncAgentApiMode()
}

function handleAgentModelChange(model: string) {
    selectedAgentModel.value = model
    selectedAgentReasoningEffort.value = ''
}

function agentAvatarName(agent: RoomAgent): string {
    return agent.agent || 'hermes'
}

function agentContextStatus(agent: RoomAgent): { agentName: string; status: string } | undefined {
    return store.contextStatuses.get(agent.name)
        || Array.from(store.contextStatuses.values()).find(status => status.agentName === agent.name)
}

function agentActivityLabel(agent: RoomAgent): string {
    return agentContextStatus(agent)?.status === 'compressing'
        ? t('groupChat.agentCompressing')
        : t('groupChat.agentReplying')
}

function canStopAgent(agent: RoomAgent): boolean {
    return currentRoomCanManage.value
        || (
            agent.executorType === 'remote'
            && agent.ownerMemberId === store.userId
        )
}

function canRemoveAgent(agent: RoomAgent): boolean {
    return currentRoomCanManage.value
        || (
            agent.executorType === 'remote'
            && agent.ownerMemberId === store.userId
        )
}

function handleMentionAgent(agent: RoomAgent) {
    if (agent.connectionStatus === 'offline') return
    groupChatInputRef.value?.insertMention?.(agent.name, agent.agentId)
}

function handleAgentRailAdd() {
    if (props.standalone) {
        emit('requestAgentLink')
        return
    }
    handleAddAgent()
}

function handleAgentRailClick(agent: RoomAgent) {
    if (currentRoomCanManage.value && agent.executorType !== 'remote') {
        void handleEditAgent(agent)
        return
    }
    if (
        props.standalone
        && agent.executorType === 'remote'
        && agent.ownerMemberId === store.userId
        && Boolean(agent.connectorId)
        && Boolean(agent.remoteOrigin)
    ) {
        emit('requestAgentEdit', agent)
        return
    }
    handleMentionAgent(agent)
}

const hasRoom = computed(() => !!store.currentRoomId)
const currentRoom = computed(() => store.rooms.find(room => room.id === store.currentRoomId) || null)
const contextRoom = computed(() => store.rooms.find(room => room.id === contextRoomId.value) || null)
function canManageRoom(room: Pick<RoomInfo, 'canManage'> | null | undefined): boolean {
    return room?.canManage === true
}
const currentRoomCanManage = computed(() => !props.standalone && canManageRoom(currentRoom.value))
provide('hermesWorkspaceFilePreview', currentRoomCanManage)
const currentRoomCanMentionAll = computed(() => !props.standalone && currentRoom.value?.canMentionAll === true)
const currentRoomNeedsSummaryConfiguration = computed(() => {
    if (props.standalone) return false
    const room = currentRoom.value
    if (!room) return false
    return !String(room.summaryProfile || '').trim()
        || !String(room.summaryProvider || '').trim()
        || !String(room.summaryModel || '').trim()
        || !String(room.summaryApiMode || '').trim()
        || Number(room.summaryEveryTurns || 0) < 1
})
const railMembers = computed<MemberInfo[]>(() => {
    const members = store.members.some(member => member.userId === store.userId)
        ? [...store.members]
        : [{
            id: `current:${store.userId}`,
            userId: store.userId,
            name: store.userName || t('groupChat.you'),
            description: '',
            joinedAt: 0,
            avatar: store.currentUserAvatar,
        }, ...store.members]
    const ownerMemberId = currentRoom.value?.ownerMemberId || ''
    return members.sort((left, right) => {
        const rank = (member: MemberInfo) => {
            if (ownerMemberId && member.userId === ownerMemberId) return 0
            if (member.userId === store.userId) return 1
            return 2
        }
        return rank(left) - rank(right)
            || Number(left.joinedAt || 0) - Number(right.joinedAt || 0)
            || left.name.localeCompare(right.name)
    })
})
const participantCount = computed(() => railMembers.value.length + store.agents.length)
function agentOwnerMember(agent: RoomAgent): MemberInfo | null {
    if (!agent.ownerMemberId) return null
    return railMembers.value.find(member => member.userId === agent.ownerMemberId) || null
}
function agentOwnerAvatar(agent: RoomAgent) {
    const owner = agentOwnerMember(agent)
    return owner ? memberAvatarFor(owner) : null
}
const visibleApproval = computed(() =>
    pendingAgentPairings.value.length === 0
        ? store.activePendingApproval
        : null,
)
const visibleClarify = computed(() =>
    currentRoomCanManage.value && pendingAgentPairings.value.length === 0
        ? store.activePendingClarify
        : null,
)
watch(
    () => visibleClarify.value?.clarifyId,
    () => { clarifyResponse.value = visibleClarify.value?.initialResponse || '' },
)
const visibleAgentPairing = computed(() =>
    currentRoomCanManage.value ? pendingAgentPairings.value[0] || null : null,
)
const currentWorkspaceLabel = computed(() => workspaceBasename(currentRoom.value?.workspace || ''))
const groupToolPanelTitle = computed(() => desktopBrowserAvailable
    ? `${t('drawer.files')} / ${t('drawer.terminal')} / ${t('browser.title')}`
    : `${t('drawer.files')} / ${t('drawer.terminal')}`
)
const canUpdateRoomName = computed(() => {
    const nextName = roomNameDraft.value.trim()
    return currentRoomCanManage.value
        && !isSavingRoomName.value
        && !!nextName
        && nextName !== (currentRoom.value?.name || '')
})
const canUpdateInviteCode = computed(() => {
    const nextCode = inviteCodeDraft.value.trim()
    return currentRoomCanManage.value && !isSavingInviteCode.value && !!nextCode && nextCode !== (currentRoom.value?.inviteCode || '')
})
const showWorkspaceModal = ref(false)
const workspaceRoomId = ref<string | null>(null)
const workspaceValue = ref('')

/** Resolve the current user's custom avatar — first from the member list, then from the cached current-user value. */
const userMemberAvatar = computed(() => {
    // Prefer the live member list (populated when a room is active)
    const member = store.members.find(m => m.userId === store.userId)
    const raw = member?.avatar || store.currentUserAvatar
    return parseMemberAvatar(raw)
})

function parseMemberAvatar(raw: unknown) {
    return parseStoredAvatar(raw)
}

function memberAvatarFor(member: MemberInfo) {
    return member.userId === store.userId ? userMemberAvatar.value : parseMemberAvatar(member.avatar)
}

function handleRoomMemberClick(member: MemberInfo) {
    if (member.userId === store.userId) handleOpenUserProfile()
}

async function handleRemoveMember(member: MemberInfo) {
    if (!currentRoomCanMentionAll.value || !store.currentRoomId || member.userId === store.userId) return
    try {
        await store.removeMemberFromRoom(store.currentRoomId, member.userId)
        message.success(t('groupChat.memberRemoved', { name: member.name }))
    } catch (err: any) {
        message.error(err?.message || t('common.deleteFailed'))
    }
}

function formatTokens(tokens: number): string {
    const value = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)
    return `${value} ${t('usage.tokens')}`
}

function workspaceBasename(path: string): string {
    const trimmed = String(path || '').trim().replace(/[\\/]+$/, '')
    if (!trimmed) return ''
    return trimmed.split(/[\\/]/).pop() || trimmed
}

function toggleSidebar() {
    if (props.standalone) return
    showSidebar.value = !showSidebar.value
}

function loadWorkspacePanelWidth(): number {
    const saved = Number.parseInt(window.localStorage.getItem(WORKSPACE_PANEL_STORAGE_KEY) || '', 10)
    return Number.isFinite(saved) ? saved : WORKSPACE_PANEL_DEFAULT_WIDTH
}

function workspacePanelMaxWidth(): number {
    if (workspacePanelMobile.value) return window.innerWidth
    const available = groupChatContentWrapperRef.value?.clientWidth || window.innerWidth
    return Math.max(320, Math.min(Math.floor(available * 0.88), available - 120))
}

function clampWorkspacePanelWidth(width: number): number {
    const maxWidth = workspacePanelMaxWidth()
    return Math.min(maxWidth, Math.max(Math.min(WORKSPACE_PANEL_MIN_WIDTH, maxWidth), Math.round(width)))
}

function handleWorkspacePanelResize(): void {
    workspacePanelMobile.value = window.innerWidth <= 768
    if (!workspacePanelMobile.value) workspacePanelWidth.value = clampWorkspacePanelWidth(workspacePanelWidth.value)
}

function handleWorkspaceResizeMove(event: PointerEvent): void {
    if (!workspaceResizeStart.value) return
    workspacePanelWidth.value = clampWorkspacePanelWidth(
        workspaceResizeStart.value.width
            + (event.clientX - workspaceResizeStart.value.x) * workspaceResizeStart.value.deltaSign,
    )
}

function stopWorkspaceResize(): void {
    if (!workspaceResizeStart.value) return
    workspaceResizeStart.value = null
    window.removeEventListener('pointermove', handleWorkspaceResizeMove)
    window.removeEventListener('pointerup', stopWorkspaceResize)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    if (!workspacePanelMobile.value) {
        window.localStorage.setItem(WORKSPACE_PANEL_STORAGE_KEY, String(workspacePanelWidth.value))
    }
}

function startWorkspaceResize(event: PointerEvent): void {
    if (workspacePanelMobile.value) return
    event.preventDefault()
    workspaceResizeStart.value = {
        x: event.clientX,
        width: workspacePanelWidth.value,
        deltaSign: document.documentElement.dir === 'rtl' ? 1 : -1,
    }
    window.addEventListener('pointermove', handleWorkspaceResizeMove)
    window.addEventListener('pointerup', stopWorkspaceResize)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
}

function closeWorkspacePanel(): void {
    if (toolPanelStore.workspaceDiff?.editable && filesStore.hasUnsavedChanges) {
        message.warning(t('files.unsavedChanges'))
        return
    }
    if (toolPanelStore.workspaceDiff?.editable && filesStore.editingFile) filesStore.closeEditor()
    filesStore.closePreview()
    toolPanelStore.closeWorkspaceDiff()
    showWorkspacePanel.value = false
}

function toggleWorkspacePanel(): void {
    if (showWorkspacePanel.value) {
        closeWorkspacePanel()
        return
    }
    showWorkspacePanel.value = true
}

function handleToolPanelBeforeEnter(): void {
    toolPanelTransitionReady.value = false
}

function handleToolPanelAfterEnter(): void {
    toolPanelTransitionReady.value = true
}

function handleToolPanelBeforeLeave(): void {
    toolPanelTransitionReady.value = false
}

function handleToolPanelLeaveCancelled(): void {
    toolPanelTransitionReady.value = true
}

function openWorkspaceFilesPanel(): void {
    if (!currentRoom.value?.workspace) return
    if (showWorkspacePanel.value && activeWorkspacePanel.value === 'files') {
        closeWorkspacePanel()
        return
    }
    selectWorkspacePanel('files')
}

function selectWorkspacePanel(panel: 'files' | 'terminal' | 'browser'): void {
    if (panel === 'browser' && !desktopBrowserAvailable) return
    if (panel !== 'files') {
        if (toolPanelStore.workspaceDiff?.editable && filesStore.hasUnsavedChanges) {
            message.warning(t('files.unsavedChanges'))
            return
        }
        if (toolPanelStore.workspaceDiff?.editable && filesStore.editingFile) filesStore.closeEditor()
        filesStore.closePreview()
        toolPanelStore.closeWorkspaceDiff()
    }
    activeWorkspacePanel.value = panel
    showWorkspacePanel.value = true
}

function handleOpenDesktopBrowserPanelRequest(): void {
    selectWorkspacePanel('browser')
}

async function submitBrowserAnnotations(payload: BrowserAnnotationSubmission): Promise<boolean> {
    if (currentRoomNeedsSummaryConfiguration.value) {
        await handleSummaryConfigurationRequired()
        return false
    }
    const attachment = createBrowserAnnotationAttachment(payload)
    try {
        await store.sendMessage('', [attachment])
        return true
    } catch (err: any) {
        URL.revokeObjectURL(attachment.url)
        message.error(err instanceof Error ? err.message : String(err))
        return false
    }
}

function groupWorkspacePreviewPath(filePath: string): string | null {
    const workspace = currentRoom.value?.workspace?.replace(/\\/g, '/').replace(/\/+$/, '')
    let decodedPath = filePath
    try { decodedPath = decodeURIComponent(filePath) } catch { /* server validates malformed input */ }
    const normalizedPath = decodedPath.replace(/\\/g, '/').replace(/\/+$/, '')
    if (!normalizedPath) return null
    if (!(normalizedPath.startsWith('/') || /^[a-zA-Z]:\//.test(normalizedPath))) return normalizedPath
    if (!workspace) return normalizedPath
    const ignoreCase = /^[a-zA-Z]:\//.test(workspace)
    const comparableWorkspace = ignoreCase ? workspace.toLowerCase() : workspace
    const comparablePath = ignoreCase ? normalizedPath.toLowerCase() : normalizedPath
    if (comparablePath.startsWith(`${comparableWorkspace}/`)) return normalizedPath.slice(workspace.length + 1)
    return normalizedPath
}

function handleWorkspaceFilePreviewRequest(event: Event): void {
    const customEvent = event as CustomEvent<{
        path?: string
        fileName?: string
        startLine?: number
        endLine?: number
    }>
    const roomId = store.currentRoomId
    const path = groupWorkspacePreviewPath(typeof customEvent.detail?.path === 'string' ? customEvent.detail.path : '')
    if (!roomId || !path || !currentRoomCanManage.value) return
    customEvent.preventDefault()
    const fileName = customEvent.detail?.fileName || path.split('/').pop() || path
    const requestedStartLine = customEvent.detail?.startLine
    const startLine = Number.isInteger(requestedStartLine) && requestedStartLine! > 0
        ? requestedStartLine
        : undefined
    const requestedEndLine = customEvent.detail?.endLine
    const endLine = startLine && Number.isInteger(requestedEndLine) && requestedEndLine! >= startLine
        ? requestedEndLine
        : startLine
    toolPanelStore.closeWorkspaceDiff()
    filesStore.closePreview()
    void filesStore.openGroupWorkspacePreview(
        roomId,
        path,
        fileName,
        -1,
        startLine ? { startLine, endLine } : undefined,
    ).catch(error => {
        message.error(error instanceof Error ? error.message : t('files.previewFailed'))
    })
}

function handleGroupAttachmentPreviewRequest(event: Event): void {
    const customEvent = event as CustomEvent<{ sourceUrl?: string; fileName?: string; size?: number }>
    const roomId = store.currentRoomId
    const sourceUrl = String(customEvent.detail?.sourceUrl || '').trim()
    const fileName = String(customEvent.detail?.fileName || '').trim()
    if (!roomId || !sourceUrl || !fileName) return
    customEvent.preventDefault()
    toolPanelStore.closeWorkspaceDiff()
    filesStore.closePreview()
    void filesStore.openRemotePreview(
        sourceUrl,
        fileName,
        Number(customEvent.detail?.size ?? -1),
        { workspaceRoomId: roomId },
    ).then(opened => {
        if (!opened) return
        activeWorkspacePanel.value = 'files'
        showWorkspacePanel.value = true
    }).catch(error => {
        message.error(error instanceof Error ? error.message : t('files.previewFailed'))
    })
}

function openPageSidebar() {
    if (props.standalone) return
    showSidebar.value = true
}

function acknowledgeGroupChatRefactorNotice() {
    try {
        window.localStorage.setItem(GROUP_CHAT_REFACTOR_NOTICE_STORAGE_KEY, '1')
    } catch {
        // The notice can still be dismissed when persistent browser storage is unavailable.
    }
    showGroupChatRefactorNotice.value = false
}

function openSettingsPage() {
    router.push({ name: 'hermes.settings' })
}

const remoteRooms = computed(() => buildRemoteGroupChatRooms(
    remoteRoomConnections.value,
))

async function refreshRemoteRooms() {
    if (props.standalone) return
    try {
        remoteRoomConnections.value = (await listLocalGroupAgentConnections()).connections
    } catch {
        // Keep the last successful list during transient local API failures.
    }
}

function handleWindowFocus() {
    void refreshRemoteRooms()
}

function handleSelectRemoteRoom(room: RemoteGroupChatRoom) {
    if (!room.inviteCode) return
    const url = `${room.cloudOrigin}/#/share/group-chat/${encodeURIComponent(room.inviteCode)}`
    window.open(url, '_blank', 'noopener,noreferrer')
    if (window.innerWidth <= 768) showSidebar.value = false
}

function hasDraggedFiles(event: DragEvent) {
    return Array.from(event.dataTransfer?.types || []).includes('Files')
}

function resetChatDropState() {
    chatDropCounter.value = 0
    isChatDropActive.value = false
}

function handleChatDragOver(event: DragEvent) {
    if (props.standalone) return
    if (!hasRoom.value || !hasDraggedFiles(event)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

function handleChatDragEnter(event: DragEvent) {
    if (props.standalone) return
    if (!hasRoom.value || !hasDraggedFiles(event)) return
    event.preventDefault()
    chatDropCounter.value += 1
    isChatDropActive.value = true
}

function handleChatDragLeave(event: DragEvent) {
    if (props.standalone) return
    if (!hasRoom.value || !hasDraggedFiles(event)) return
    chatDropCounter.value -= 1
    if (chatDropCounter.value <= 0) resetChatDropState()
}

function handleChatDrop(event: DragEvent) {
    if (props.standalone) return
    if (!hasRoom.value || !hasDraggedFiles(event)) return
    event.preventDefault()
    const files = Array.from(event.dataTransfer?.files || [])
    const target = event.target instanceof Element ? event.target : null
    resetChatDropState()
    if (!files.length || target?.closest('.chat-input-area')) return
    groupChatInputRef.value?.addFiles?.(files)
}

function handleWorkspaceFileAttach(file: File) {
    groupChatInputRef.value?.addFiles?.([file])
}

function formatAgentFailures(results?: Array<{ ok: boolean; profile: string; error?: string; reason?: string }>): string | null {
    const failed = results?.filter(result => !result.ok) || []
    if (failed.length === 0) return null
    const details = failed.map(result => result.reason || result.error || result.profile).join('; ')
    return t('groupChat.agentAddFailedCount', { count: failed.length, details })
}

function extractApiErrorMessage(err: any): string {
    const raw = err?.message || ''
    const jsonStart = raw.indexOf('{')
    if (jsonStart >= 0) {
        try {
            const parsed = JSON.parse(raw.slice(jsonStart))
            if (parsed?.code === 'PROFILE_AGENT_CONNECT_FAILED' && parsed?.error) {
                return parsed.reason ? `${parsed.error}: ${parsed.reason}` : parsed.error
            }
            if (parsed?.error) return parsed.error
        } catch { /* ignore */ }
    }
    return raw || t('common.saveFailed')
}

async function handleCreateRoom(
    name: string,
    inviteCode: string,
    userName: string,
    description: string,
    summary: RoomSummaryConfig,
    workspace: string,
    agents: RoomAgentInput[],
) {
    try {
        store.setUserInfo(userName, description)
        const res = await store.createNewRoom(
            name,
            inviteCode,
            agents,
            summary,
            workspace,
            { name: userName, description },
        )
        showCreateModal.value = false
        const failureMessage = formatAgentFailures(res.agentResults)
        if (failureMessage) message.warning(failureMessage)
        else message.success(t('groupChat.roomCreated'))
        await router.push({ name: 'hermes.groupChatRoom', params: { roomId: res.room.id } })
    } catch {
        message.error(t('common.saveFailed'))
    }
}

async function handleDeleteRoom(roomId: string) {
    const room = store.rooms.find(r => r.id === roomId)
    if (!canManageRoom(room)) return
    try {
        await store.deleteRoom(roomId)
        if (store.currentRoomId === roomId) {
            await router.replace({ name: 'hermes.groupChat' })
        }
        message.success(t('groupChat.roomDeleted'))
    } catch {
        message.error(t('common.saveFailed'))
    }
}

function buildRoomUrl(roomId: string) {
    const room = store.rooms.find(candidate => candidate.id === roomId)
    const href = room?.inviteCode
        ? router.resolve({ name: 'share.groupChat', params: { inviteCode: room.inviteCode } }).href
        : router.resolve({ name: 'hermes.groupChatRoom', params: { roomId } }).href
    return `${window.location.origin}${window.location.pathname}${href}`
}

async function copyRoomLink(roomId: string) {
    const roomLink = buildRoomUrl(roomId)
    const ok = await copyToClipboard(roomLink)
    if (ok) {
        message.success(t('common.copied'))
        return
    }

    manualRoomLink.value = roomLink
    showManualRoomLinkModal.value = true
}

function selectManualRoomLink() {
    void nextTick(() => {
        manualRoomLinkInput.value?.focus()
        manualRoomLinkInput.value?.select()
    })
}

function copyCurrentRoomLink() {
    if (store.currentRoomId) void copyRoomLink(store.currentRoomId)
}

const roomContextMenuOptions = computed<DropdownOption[]>(() => {
    const options: DropdownOption[] = [{ label: t('groupChat.copyRoomLink'), key: 'copy-link' }]
    if (canManageRoom(contextRoom.value)) {
        options.push({ label: t('chat.setWorkspace'), key: 'set-workspace' })
        options.push({ label: t('groupChat.cloneRoom'), key: 'clone-room' })
    }
    return options
})

const remoteRoomContextMenuOptions = computed<DropdownOption[]>(() => [
    { label: t('groupChat.renameRemoteRoom'), key: 'rename' },
    { label: t('groupChat.leaveRemoteRoom'), key: 'leave' },
])

function handleRoomContextMenu(event: MouseEvent, roomId: string) {
    event.preventDefault()
    showRemoteRoomContextMenu.value = false
    contextRoomId.value = roomId
    roomContextMenuX.value = event.clientX
    roomContextMenuY.value = event.clientY
    showRoomContextMenu.value = true
}

function handleRemoteRoomContextMenu(event: MouseEvent, room: RemoteGroupChatRoom) {
    event.preventDefault()
    showRoomContextMenu.value = false
    remoteRoomContext.value = room
    remoteRoomContextMenuX.value = event.clientX
    remoteRoomContextMenuY.value = event.clientY
    showRemoteRoomContextMenu.value = true
}

function handleRoomContextClickOutside() {
    showRoomContextMenu.value = false
}

function handleRemoteRoomContextClickOutside() {
    showRemoteRoomContextMenu.value = false
}

function handleRemoteRoomContextSelect(key: string) {
    showRemoteRoomContextMenu.value = false
    const room = remoteRoomContext.value
    if (!room) return
    if (key === 'rename') {
        remoteRoomBeingRenamed.value = room
        remoteRoomNameDraft.value = room.roomName
        showRemoteRoomRenameModal.value = true
    } else if (key === 'leave') {
        remoteRoomBeingLeft.value = room
    }
}

async function confirmRemoteRoomRename() {
    const room = remoteRoomBeingRenamed.value
    const name = remoteRoomNameDraft.value.trim()
    const connectorId = room?.connectorIds[0]
    if (!room || !connectorId || !name || isUpdatingRemoteRoom.value) return
    isUpdatingRemoteRoom.value = true
    try {
        await renameLocalGroupAgentRoom(connectorId, name)
        await refreshRemoteRooms()
        showRemoteRoomRenameModal.value = false
        remoteRoomBeingRenamed.value = null
        message.success(t('groupChat.remoteRoomRenamed'))
    } catch {
        message.error(t('groupChat.remoteRoomRenameFailed'))
    } finally {
        isUpdatingRemoteRoom.value = false
    }
}

async function confirmLeaveRemoteRoom() {
    const room = remoteRoomBeingLeft.value
    const connectorId = room?.connectorIds[0]
    if (!room || !connectorId || isUpdatingRemoteRoom.value) return
    isUpdatingRemoteRoom.value = true
    try {
        const result = await leaveLocalGroupAgentRoom(connectorId)
        remoteRoomBeingLeft.value = null
        await refreshRemoteRooms()
        if (result.notified < result.removed) {
            message.warning(t('groupChat.remoteRoomLeavePartial', {
                count: result.removed - result.notified,
            }))
        } else {
            message.success(t('groupChat.remoteRoomLeft'))
        }
    } catch {
        message.error(t('groupChat.remoteRoomLeaveFailed'))
    } finally {
        isUpdatingRemoteRoom.value = false
    }
}

function handleRoomContextSelect(key: string) {
    showRoomContextMenu.value = false
    const roomId = contextRoomId.value
    if (!roomId) return
    if (key === 'copy-link') {
        void copyRoomLink(roomId)
    } else if (key === 'set-workspace') {
        if (!canManageRoom(contextRoom.value)) return
        handleOpenWorkspacePicker(roomId)
    } else if (key === 'clone-room') {
        if (!canManageRoom(contextRoom.value)) return
        handleOpenCloneRoom(roomId)
    }
}

function handleOpenCloneRoom(roomId: string) {
    const room = store.rooms.find(r => r.id === roomId)
    if (!canManageRoom(room)) return
    cloneSourceRoomId.value = roomId
    cloneRoomName.value = room?.name ? `${room.name} Copy` : ''
    cloneInviteCode.value = generateGroupChatInviteCode()
    showCloneModal.value = true
}

async function confirmCloneRoom() {
    if (!cloneSourceRoomId.value || !cloneRoomName.value.trim()) return
    try {
        const res = await store.cloneRoom(cloneSourceRoomId.value, {
            name: cloneRoomName.value.trim(),
            inviteCode: cloneInviteCode.value.trim() || undefined,
        })
        showCloneModal.value = false
        cloneSourceRoomId.value = null
        cloneRoomName.value = ''
        cloneInviteCode.value = ''
        await router.push({ name: 'hermes.groupChatRoom', params: { roomId: res.room.id } })
        const failureMessage = formatAgentFailures(res.agentResults)
        if (failureMessage) message.warning(failureMessage)
        else message.success(t('groupChat.roomCloned'))
    } catch {
        message.error(t('common.saveFailed'))
    }
}

async function handleClearRoomContext() {
    if (!store.currentRoomId) return
    if (!currentRoomCanManage.value) return
    if (store.contextStatuses.size > 0) {
        message.warning(t('groupChat.compressingInProgress'))
        return
    }
    try {
        await store.clearCurrentRoomContext()
        message.success(t('groupChat.contextCleared'))
    } catch {
        message.error(t('common.deleteFailed'))
    }
}

async function handleSelectRoom(roomId: string) {
    try {
        await router.push({ name: 'hermes.groupChatRoom', params: { roomId } })
        if (window.innerWidth <= 768) showSidebar.value = false
    } catch {
        message.error(t('groupChat.joinFailed'))
    }
}

async function handleSendMessage(content: string, attachments?: Attachment[], mentions?: GroupChatMention[]) {
    const submittedRoomId = store.currentRoomId
    try {
        await store.sendMessage(content, attachments, mentions)
        if (submittedRoomId) clearGroupChatRoomDraft(submittedRoomId)
        groupChatInputRef.value?.completeSend?.(true)
    } catch (err: any) {
        groupChatInputRef.value?.completeSend?.(false)
        message.error(err.message)
    }
}

async function handleCancelQueuedExecution(queueId: string) {
    try {
        await store.cancelExecutionQueueItem(queueId)
    } catch (err: any) {
        message.error(err?.message || t('groupChat.executionQueueCancelFailed'))
    }
}

async function handleSummaryConfigurationRequired() {
    if (!currentRoomCanManage.value) {
        message.warning(t('groupChat.summaryConfigurationOwnerRequired'))
        return
    }
    message.warning(t('groupChat.summaryConfigurationRequired'))
    void handleOpenRoomSettings()
    await nextTick()
    summarySettingsSectionRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function resetAgentForm() {
    selectedAgentPresetId.value = null
    selectedProfile.value = null
    selectedRuntimePreset.value = undefined
    selectedRuntimePresetReady.value = false
    selectedAgentType.value = firstAvailableGroupAgentType.value || 'hermes'
    selectedAgentMode.value = 'scoped'
    selectedAgentProvider.value = ''
    selectedAgentModel.value = ''
    selectedAgentApiMode.value = 'codex_responses'
    selectedAgentReasoningEffort.value = ''
    agentName.value = ''
    agentDescription.value = ''
    agentAvatar.value = null
}

function currentAgentPresetInput(): GroupAgentPresetInput | null {
    if (!canConfirmAddAgent.value || !selectedProfile.value) return null
    return {
        agent: selectedAgentType.value,
        agentMode: usesGlobalAgentMode.value ? 'global' : 'scoped',
        profile: selectedProfile.value,
        provider: usesGlobalAgentMode.value ? '' : selectedAgentProvider.value,
        model: usesGlobalAgentMode.value ? '' : selectedAgentModel.value,
        apiMode: selectedAgentType.value === 'hermes' || usesGlobalAgentMode.value ? '' : selectedAgentApiMode.value,
        reasoningEffort: usesGlobalAgentMode.value ? '' : selectedAgentReasoningEffort.value,
        agentPreset: selectedAgentType.value === 'dsh' ? selectedRuntimePreset.value : undefined,
        name: agentName.value.trim() || selectedProfile.value,
        description: agentDescription.value.trim(),
        avatar: agentAvatar.value ? JSON.stringify(agentAvatar.value) : '',
    }
}

async function loadAgentPresets() {
    isLoadingAgentPresets.value = true
    agentPresetLoadError.value = ''
    try {
        agentPresets.value = (await listGroupAgentPresets()).presets
    } catch (err: any) {
        agentPresetLoadError.value = extractApiErrorMessage(err) || t('groupChat.agentPresetLoadFailed')
        message.error(agentPresetLoadError.value)
    } finally {
        isLoadingAgentPresets.value = false
    }
}

function openAgentPresetSelection() {
    agentPresetDialogMode.value = 'select'
    pendingAgentPresetId.value = selectedAgentPresetId.value
    agentPresetSearch.value = ''
    showAgentPresetDialog.value = true
}

function openAgentPresetManager() {
    agentPresetDialogMode.value = 'manage'
    pendingAgentPresetId.value = null
    agentPresetSearch.value = ''
    showAgentPresetDialog.value = true
}

function closeAgentPresetDialog() {
    showAgentPresetDialog.value = false
    pendingAgentPresetId.value = null
    agentPresetSearch.value = ''
}

function selectAgentPresetForDialog(preset: GroupAgentPreset) {
    if (!preset.available) return
    pendingAgentPresetId.value = preset.id
}

function confirmAgentPresetSelection() {
    const preset = pendingAgentPreset.value
    if (!preset?.available) return
    applyAgentPreset(preset.id)
    closeAgentPresetDialog()
}

function applyAgentPreset(presetId: string | null) {
    selectedAgentPresetId.value = presetId
    const preset = agentPresets.value.find(item => item.id === presetId)
    if (!preset) return
    if (!preset.available) {
        message.warning(preset.validationError || t('groupChat.agentPresetUnavailable'))
        return
    }
    const input = groupAgentPresetToRoomAgentInput(preset)
    selectedAgentType.value = input.agent
    selectedAgentMode.value = input.agentMode === 'global' ? 'global' : 'scoped'
    selectedProfile.value = input.profile
    selectedAgentProvider.value = input.provider || ''
    selectedAgentModel.value = input.model || ''
    selectedAgentApiMode.value = normalizeCodingAgentApiMode(
        input.apiMode,
        inferCodingAgentApiMode(input.provider),
    )
    selectedAgentReasoningEffort.value = input.reasoningEffort || ''
    selectedRuntimePreset.value = input.agentPreset
    agentName.value = input.name || ''
    agentDescription.value = input.description || ''
    agentAvatar.value = parseStoredAvatar(input.avatar)
}

async function saveAgentPreset(presetId: string | null) {
    const input = currentAgentPresetInput()
    if (!input || isSavingAgentPreset.value) return
    isSavingAgentPreset.value = true
    try {
        const result = presetId
            ? await updateGroupAgentPreset(presetId, input)
            : await createGroupAgentPreset(input)
        const index = agentPresets.value.findIndex(item => item.id === result.preset.id)
        if (index >= 0) agentPresets.value[index] = result.preset
        else agentPresets.value = [result.preset, ...agentPresets.value]
        pendingAgentPresetId.value = result.preset.id
        message.success(t('groupChat.agentPresetSaved'))
    } catch (err: any) {
        message.error(
            err?.code === 'GROUP_AGENT_PRESET_NAME_CONFLICT'
                ? t('groupChat.agentPresetAlreadyExists')
                : extractApiErrorMessage(err) || t('groupChat.agentPresetOperationFailed'),
        )
    } finally {
        isSavingAgentPreset.value = false
    }
}

async function createAgentPresetFromCurrent() {
    pendingAgentPresetId.value = null
    await saveAgentPreset(null)
}

async function updateSelectedAgentPreset() {
    if (!pendingAgentPresetId.value) return
    await saveAgentPreset(pendingAgentPresetId.value)
}

async function deleteAgentPreset() {
    const presetId = pendingAgentPresetId.value
    if (!presetId || isSavingAgentPreset.value) return
    isSavingAgentPreset.value = true
    try {
        await deleteGroupAgentPreset(presetId)
        agentPresets.value = agentPresets.value.filter(item => item.id !== presetId)
        if (selectedAgentPresetId.value === presetId) selectedAgentPresetId.value = null
        pendingAgentPresetId.value = null
        message.success(t('groupChat.agentPresetDeleted'))
    } catch (err: any) {
        message.error(extractApiErrorMessage(err) || t('groupChat.agentPresetOperationFailed'))
    } finally {
        isSavingAgentPreset.value = false
    }
}

function closeAgentDrawer() {
    closeAgentPresetDialog()
    showAddAgentDrawer.value = false
    editingAgent.value = null
    resetAgentForm()
}

async function handleAddAgent() {
    if (!currentRoomCanManage.value) return
    await Promise.all([
        profilesStore.fetchProfiles(),
        appStore.loadModels(),
        loadAgentPresets(),
        refreshAgentAvailability(),
    ])
    editingAgent.value = null
    resetAgentForm()
    selectedRuntimePreset.value = undefined
    selectedRuntimePresetReady.value = false
    selectedAgentType.value = firstAvailableGroupAgentType.value || 'hermes'
    selectedProfile.value =
        profilesStore.activeProfileName ||
        profilesStore.profiles.find(profile => profile.active)?.name ||
        profilesStore.profiles[0]?.name ||
        'default'
    syncAgentModelSelection(selectedProfile.value)
    selectedAgentReasoningEffort.value = ''
    showAddAgentDrawer.value = true
}

function randomAgentAvatarSeed() {
    return `group-agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function handleRandomAgentAvatar() {
    agentAvatar.value = { type: 'generated', seed: randomAgentAvatarSeed() }
}

function handleResetAgentAvatar() {
    agentAvatar.value = null
}

function triggerAgentAvatarUpload() {
    agentAvatarFileInput.value?.click()
}

async function handleAgentAvatarFileChange(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
        message.warning(t('profiles.avatar.invalidType'))
        return
    }
    if (file.size > 1024 * 1024) {
        message.warning(t('profiles.avatar.tooLarge'))
        return
    }
    try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result || ''))
            reader.onerror = () => reject(reader.error || new Error('Failed to read file'))
            reader.readAsDataURL(file)
        })
        agentAvatar.value = { type: 'image', dataUrl }
    } catch {
        message.error(t('profiles.avatar.saveFailed'))
    }
}

async function handleEditAgent(agent: RoomAgent) {
    if (!currentRoomCanManage.value) return
    await Promise.all([
        profilesStore.fetchProfiles(),
        appStore.loadModels(),
        loadAgentPresets(),
        refreshAgentAvailability(),
    ])
    selectedAgentPresetId.value = null
    editingAgent.value = agent
    selectedAgentType.value = agent.agent || 'hermes'
    selectedAgentMode.value = agent.agentMode === 'global' ? 'global' : 'scoped'
    selectedProfile.value = agent.profile
    selectedAgentProvider.value = agent.provider || ''
    selectedAgentModel.value = agent.model || ''
    selectedAgentApiMode.value = normalizeCodingAgentApiMode(
        agent.apiMode,
        inferCodingAgentApiMode(agent.provider),
    )
    selectedAgentReasoningEffort.value = agent.reasoningEffort || ''
    selectedRuntimePreset.value = agent.agentPreset
    agentName.value = agent.name || ''
    agentDescription.value = agent.description || ''
    agentAvatar.value = parseStoredAvatar(agent.avatar)
    showAddAgentDrawer.value = true
}

onMounted(() => {
    if (!props.standalone) void refreshAgentAvailability()
    if (!props.standalone) {
        try {
            showGroupChatRefactorNotice.value = window.localStorage.getItem(GROUP_CHAT_REFACTOR_NOTICE_STORAGE_KEY) !== '1'
        } catch {
            showGroupChatRefactorNotice.value = true
        }
    }
    window.addEventListener('hermes:open-page-sidebar', openPageSidebar)
    window.addEventListener('hermes:preview-workspace-file', handleWorkspaceFilePreviewRequest)
    window.addEventListener('hermes:preview-group-attachment', handleGroupAttachmentPreviewRequest)
    window.addEventListener(OPEN_DESKTOP_BROWSER_PANEL_EVENT, handleOpenDesktopBrowserPanelRequest)
    window.addEventListener('resize', handleWorkspacePanelResize)
    window.addEventListener('focus', handleWindowFocus)
    handleWorkspacePanelResize()
    if (!props.standalone && profilesStore.profiles.length === 0) {
        void profilesStore.fetchProfiles()
    }
    if (!props.standalone) {
        agentPairingRefreshTimer = setInterval(() => void refreshPendingAgentPairings(), 3_000)
        remoteRoomRefreshTimer = setInterval(() => void refreshRemoteRooms(), 5_000)
        void refreshPendingAgentPairings()
        void refreshRemoteRooms()
    }
})

onUnmounted(() => {
    hideInlineSummaryStatus()
    window.removeEventListener('hermes:open-page-sidebar', openPageSidebar)
    window.removeEventListener('hermes:preview-workspace-file', handleWorkspaceFilePreviewRequest)
    window.removeEventListener('hermes:preview-group-attachment', handleGroupAttachmentPreviewRequest)
    window.removeEventListener(OPEN_DESKTOP_BROWSER_PANEL_EVENT, handleOpenDesktopBrowserPanelRequest)
    window.removeEventListener('resize', handleWorkspacePanelResize)
    window.removeEventListener('focus', handleWindowFocus)
    stopWorkspaceResize()
    roomFadeAnimation?.cancel()
    if (showWorkspacePanel.value) closeWorkspacePanel()
    else toolPanelStore.closeWorkspaceDiff()
    roomFadeAnimation = null
    if (agentPairingRefreshTimer) clearInterval(agentPairingRefreshTimer)
    agentPairingRefreshTimer = null
    if (remoteRoomRefreshTimer) clearInterval(remoteRoomRefreshTimer)
    remoteRoomRefreshTimer = null
})

async function loadRoomSummaryState(roomId: string) {
    try {
        const result = await getRoomSummary(roomId)
        store.applyRoomSummaryState(result.summary)
        if (store.currentRoomId !== roomId) return
        roomSummaryState.value = store.roomSummaryStates.get(roomId) || result.summary
        roomSummaryAnchor.value = result.anchor
        roomSummaryReview.value = result.review
        if (result.review) store.applyRoomSummaryReview(result.review)
        roomSummaryDraft.value = roomSummaryState.value.summary
    } catch {
        // A missing summary should not block entering or reading the room.
    }
}

watch(() => store.currentRoomId, (roomId, previousRoomId) => {
    if (roomId === previousRoomId) return
    if (inlineSummaryStatus.value?.roomId !== roomId) hideInlineSummaryStatus()
    roomSummaryState.value = null
    roomSummaryAnchor.value = null
    roomSummaryDraft.value = ''
    if (filesStore.previewFile || toolPanelStore.workspaceDiff || showWorkspacePanel.value) closeWorkspacePanel()
    if (roomId && !props.standalone) void loadRoomSummaryState(roomId)
    if (!props.standalone) void refreshPendingAgentPairings()
}, { immediate: true, flush: 'sync' })

watch(() => store.agentPairingRevision, () => {
    if (!props.standalone) void refreshPendingAgentPairings()
})

watch(
    () => store.currentRoomId,
    async (roomId, previousRoomId) => {
        if (!roomId || !previousRoomId || roomId === previousRoomId) return

        await nextTick()
        const surface = groupChatSurfaceRef.value
        if (!surface || typeof surface.animate !== 'function') return

        roomFadeAnimation?.cancel()
        roomFadeAnimation = surface.animate(
            [
                { opacity: 0 },
                { opacity: 1 },
            ],
            {
                duration: 1500,
                easing: 'ease',
            },
        )
    },
    { flush: 'post' },
)

watch(() => filesStore.previewFile, previewFile => {
    if (previewFile?.workspaceRoomId === store.currentRoomId) {
        activeWorkspacePanel.value = 'files'
        showWorkspacePanel.value = true
    }
})

watch(() => toolPanelStore.workspaceDiff, workspaceDiff => {
    if (workspaceDiff) {
        activeWorkspacePanel.value = 'files'
        showWorkspacePanel.value = true
    }
})

watch(showWorkspacePanel, async visible => {
    if (!visible || workspacePanelMobile.value) return
    await nextTick()
    handleWorkspacePanelResize()
})

async function confirmAddAgent() {
    if (!store.currentRoomId) {
        message.warning(t('groupChat.selectRoomFirst'))
        return
    }
    if (!isGroupAgentAvailable(selectedAgentType.value)) {
        warnAgentUnavailable(selectedAgentType.value)
        return
    }
    if (!canConfirmAddAgent.value || !selectedProfile.value || isSavingAgent.value) return
    isSavingAgent.value = true
    try {
        await store.addAgentToRoom(store.currentRoomId, {
            presetId: selectedAgentPresetId.value || undefined,
            agent: selectedAgentType.value,
            agentMode: usesGlobalAgentMode.value ? 'global' : 'scoped',
            profile: selectedProfile.value,
            provider: usesGlobalAgentMode.value ? '' : selectedAgentProvider.value,
            model: usesGlobalAgentMode.value ? '' : selectedAgentModel.value,
            apiMode: selectedAgentType.value === 'hermes' || usesGlobalAgentMode.value ? undefined : selectedAgentApiMode.value,
            reasoningEffort: usesGlobalAgentMode.value ? '' : selectedAgentReasoningEffort.value,
            agentPreset: selectedAgentType.value === 'dsh' ? selectedRuntimePreset.value : undefined,
            name: agentName.value.trim() || undefined,
            description: agentDescription.value.trim() || undefined,
            avatar: agentAvatar.value ? JSON.stringify(agentAvatar.value) : '',
        })
        closeAgentDrawer()
        message.success(t('groupChat.agentAdded'))
    } catch (err: any) {
        if (err.message?.includes('already')) {
            message.warning(t('groupChat.agentAlreadyInRoom'))
        } else {
            message.error(extractApiErrorMessage(err))
        }
    } finally {
        isSavingAgent.value = false
    }
}

async function confirmUpdateAgent() {
    if (!store.currentRoomId || !editingAgent.value) return
    if (!isGroupAgentAvailable(selectedAgentType.value)) {
        warnAgentUnavailable(selectedAgentType.value)
        return
    }
    if (!canConfirmAddAgent.value || !selectedProfile.value || isSavingAgent.value) return
    isSavingAgent.value = true
    try {
        await store.updateAgentInRoom(store.currentRoomId, editingAgent.value.id, {
            agent: selectedAgentType.value,
            agentMode: usesGlobalAgentMode.value ? 'global' : 'scoped',
            profile: selectedProfile.value,
            provider: usesGlobalAgentMode.value ? '' : selectedAgentProvider.value,
            model: usesGlobalAgentMode.value ? '' : selectedAgentModel.value,
            apiMode: selectedAgentType.value === 'hermes' || usesGlobalAgentMode.value ? undefined : selectedAgentApiMode.value,
            reasoningEffort: usesGlobalAgentMode.value ? '' : selectedAgentReasoningEffort.value,
            agentPreset: selectedAgentType.value === 'dsh' ? selectedRuntimePreset.value : undefined,
            name: agentName.value.trim() || undefined,
            description: agentDescription.value.trim() || undefined,
            avatar: agentAvatar.value ? JSON.stringify(agentAvatar.value) : '',
        })
        closeAgentDrawer()
        message.success(t('common.saved'))
    } catch (err: any) {
        message.error(extractApiErrorMessage(err))
    } finally {
        isSavingAgent.value = false
    }
}

function handleOpenWorkspacePicker(roomId = store.currentRoomId || '') {
    if (!roomId) return
    const room = store.rooms.find(r => r.id === roomId)
    if (!canManageRoom(room)) return
    workspaceRoomId.value = roomId
    workspaceValue.value = room?.workspace || ''
    showWorkspaceModal.value = true
}

async function handleSaveWorkspace() {
    const roomId = workspaceRoomId.value || store.currentRoomId
    if (!roomId) return
    const room = store.rooms.find(r => r.id === roomId)
    if (!canManageRoom(room)) return
    try {
        const updatedRoom = await store.setRoomWorkspace(roomId, String(workspaceValue.value || '').trim())
        workspaceValue.value = updatedRoom?.workspace || ''
        showWorkspaceModal.value = false
        workspaceRoomId.value = null
        message.success(t('chat.workspaceSet'))
    } catch (err: any) {
        message.error(err?.message || t('chat.workspaceSetFailed'))
    }
}

async function handleClearWorkspace() {
    workspaceValue.value = ''
    await handleSaveWorkspace()
}

function handleOpenUserProfile() {
    const member = store.members.find(item => item.userId === store.userId)
    userProfileName.value = member?.name || store.userName || ''
    userProfileDescription.value = member?.description || ''
    showUserProfileModal.value = true
}

async function handleSaveUserProfile() {
    const name = userProfileName.value.trim()
    if (!name || isSavingUserProfile.value) return
    isSavingUserProfile.value = true
    try {
        await store.updateCurrentMemberProfile(name, userProfileDescription.value)
        showUserProfileModal.value = false
        message.success(t('common.saved'))
    } catch {
        message.error(t('common.saveFailed'))
    } finally {
        isSavingUserProfile.value = false
    }
}

async function handleOpenRoomSettings() {
    if (!currentRoomCanManage.value) return
    const room = store.rooms.find(r => r.id === store.currentRoomId)
    if (room) {
        roomNameDraft.value = room.name
        inviteCodeDraft.value = room.inviteCode || ''
        workspaceRoomId.value = room.id
        workspaceValue.value = room.workspace || ''
        allowGuestAgentsDraft.value = Number(room.allowGuestAgents || 0) === 1
        maxGuestAgentsPerMemberDraft.value = Math.max(1, Number(room.maxGuestAgentsPerMember || 1))
        allowRemoteWorkspaceAccessDraft.value = Number(room.allowRemoteWorkspaceAccess || 0) === 1
        summaryConfig.value = {
            summaryProfile: room.summaryProfile || profilesStore.activeProfileName || 'default',
            summaryProvider: room.summaryProvider || '',
            summaryModel: room.summaryModel || '',
            summaryApiMode: room.summaryApiMode || 'chat_completions',
            summaryEveryTurns: room.summaryEveryTurns || 20,
            evaluationProfile: room.evaluationProfile || room.summaryProfile || profilesStore.activeProfileName || 'default',
            summaryReviewMode: room.summaryReviewMode || 'inherit',
            summaryRevisionEnabled: Number(room.summaryRevisionEnabled || 0) === 1,
            messageRoutingMode: room.messageRoutingMode || 'off',
        }
        agentHandoffEnabledDraft.value = Number(room.agentHandoffEnabled ?? 1) === 1
        agentHandoffMaxDepthDraft.value = room.agentHandoffMaxDepth ?? 4
        agentHandoffUnlimitedDraft.value = Number(room.agentHandoffUnlimited ?? 0) === 1
    }
    showRoomSettingsModal.value = true
    try {
        const result = await listStoppedRoomAgentHandoffs(store.currentRoomId!)
        store.handoffChains = new Map(result.chains.map(chain => [chain.chainId, chain]))
    } catch {
        store.handoffChains = new Map()
    }
    if (!store.currentRoomId) return
    const summaryRoomId = store.currentRoomId
    void refreshPendingAgentPairings()
    isLoadingRoomSummary.value = true
    try {
        const result = await getRoomSummary(summaryRoomId)
        store.applyRoomSummaryState(result.summary)
        if (store.currentRoomId !== summaryRoomId) return
        roomSummaryState.value = store.roomSummaryStates.get(summaryRoomId) || result.summary
        roomSummaryAnchor.value = result.anchor
        roomSummaryReview.value = result.review
        if (result.review) store.applyRoomSummaryReview(result.review)
        roomSummaryDraft.value = roomSummaryState.value.summary
    } catch (err: any) {
        message.error(err?.message || t('groupChat.summaryLoadFailed'))
    } finally {
        isLoadingRoomSummary.value = false
    }
}

async function refreshPendingAgentPairings(): Promise<void> {
    const roomId = store.currentRoomId
    if (!roomId || !currentRoomCanManage.value) {
        pendingAgentPairings.value = []
        return
    }
    try {
        const result = await listPendingGroupAgentPairings(roomId)
        if (store.currentRoomId === roomId) pendingAgentPairings.value = result.requests
    } catch {
        // The next refresh retries without interrupting the chat.
    }
}

async function handleAgentPairingDecision(
    approved: boolean,
    selectedRequest: GroupAgentPairingRequest | null = visibleAgentPairing.value,
): Promise<void> {
    const roomId = store.currentRoomId
    const request = selectedRequest
    if (!roomId || !request || isDecidingAgentPairing.value) return
    isDecidingAgentPairing.value = true
    try {
        await decideGroupAgentPairing(roomId, request.id, approved)
        pendingAgentPairings.value = pendingAgentPairings.value.filter(item => item.id !== request.id)
        message.success(approved ? t('groupChat.agentPairingApproved') : t('groupChat.agentPairingRejected'))
    } catch (error: any) {
        message.error(error?.message || t('common.saveFailed'))
        await refreshPendingAgentPairings()
    } finally {
        isDecidingAgentPairing.value = false
    }
}

async function handleSaveGuestAgentPolicy(): Promise<void> {
    const roomId = store.currentRoomId
    if (!roomId || !currentRoomCanManage.value || isSavingGuestAgentPolicy.value) return
    isSavingGuestAgentPolicy.value = true
    try {
        const result = await updateGuestAgentPolicy(roomId, {
            allowGuestAgents: allowGuestAgentsDraft.value,
            maxGuestAgentsPerMember: maxGuestAgentsPerMemberDraft.value,
            allowRemoteWorkspaceAccess: allowGuestAgentsDraft.value && allowRemoteWorkspaceAccessDraft.value,
        })
        const index = store.rooms.findIndex(room => room.id === roomId)
        if (index >= 0) store.rooms[index] = {
            ...store.rooms[index],
            ...result.policy,
        }
        message.success(t('common.saved'))
    } catch (error: any) {
        message.error(error?.message || t('common.saveFailed'))
    } finally {
        isSavingGuestAgentPolicy.value = false
    }
}

async function handleSaveRoomName() {
    if (!store.currentRoomId || !canUpdateRoomName.value) return
    isSavingRoomName.value = true
    try {
        const res = await updateRoomConfig(store.currentRoomId, { name: roomNameDraft.value.trim() })
        const idx = store.rooms.findIndex(r => r.id === store.currentRoomId)
        if (idx >= 0 && res.room) store.rooms[idx] = res.room
        if (res.room) store.roomName = res.room.name
        message.success(t('common.saved'))
    } catch (err: any) {
        message.error(err?.message || t('common.saveFailed'))
    } finally {
        isSavingRoomName.value = false
    }
}

async function handleSaveInviteCode() {
    if (!store.currentRoomId || !currentRoomCanManage.value || isSavingInviteCode.value || !canUpdateInviteCode.value) return
    const nextCode = inviteCodeDraft.value.trim()
    isSavingInviteCode.value = true
    try {
        await store.setRoomInviteCode(store.currentRoomId, nextCode)
        inviteCodeDraft.value = nextCode
        message.success(t('groupChat.inviteCodeUpdated'))
    } catch (err: any) {
        message.error(err?.message || t('groupChat.inviteCodeUpdateFailed'))
    } finally {
        isSavingInviteCode.value = false
    }
}

async function handleSaveSummaryConfig() {
    if (!store.currentRoomId) return
    if (!currentRoomCanManage.value) return
    try {
        const res = await updateRoomConfig(store.currentRoomId, {
            ...summaryConfig.value,
            summaryRevisionEnabled: summaryConfig.value.summaryRevisionEnabled === true,
            agentHandoffEnabled: agentHandoffEnabledDraft.value,
            agentHandoffMaxDepth: agentHandoffMaxDepthDraft.value,
            agentHandoffUnlimited: agentHandoffUnlimitedDraft.value,
        })
        const idx = store.rooms.findIndex(r => r.id === store.currentRoomId)
        if (idx >= 0 && res.room) store.rooms[idx] = res.room
        message.success(t('groupChat.summaryConfigSaved'))
    } catch {
        message.error(t('common.saveFailed'))
    }
}

async function handleSaveHandoffConfig() {
    const roomId = store.currentRoomId
    if (!roomId || !currentRoomCanManage.value) return
    try {
        const res = await updateRoomConfig(roomId, {
            agentHandoffEnabled: agentHandoffEnabledDraft.value,
            agentHandoffMaxDepth: agentHandoffMaxDepthDraft.value,
            agentHandoffUnlimited: agentHandoffUnlimitedDraft.value,
        })
        const idx = store.rooms.findIndex(r => r.id === roomId)
        if (idx >= 0 && res.room) store.rooms[idx] = res.room
        try {
            const result = await listStoppedRoomAgentHandoffs(roomId)
            if (store.currentRoomId === roomId) {
                store.handoffChains = new Map(result.chains.map(chain => [chain.chainId, chain]))
            }
        } catch {
            // Never preserve controls that may have become invalid under the saved policy.
            if (store.currentRoomId === roomId) store.handoffChains = new Map()
        }
        message.success(t('common.saved'))
    } catch (err: any) {
        message.error(err?.message || t('common.saveFailed'))
    }
}

async function handleContinueHandoff(chainId: string): Promise<void> {
    if (!store.currentRoomId || isContinuingHandoff.value) return
    isContinuingHandoff.value = true
    try {
        await continueRoomAgentHandoff(store.currentRoomId, chainId)
        const result = await listStoppedRoomAgentHandoffs(store.currentRoomId)
        store.handoffChains = new Map(result.chains.map(chain => [chain.chainId, chain]))
        message.success(t('groupChat.agentHandoffContinued'))
    } catch (err: any) {
        try {
            const result = await listStoppedRoomAgentHandoffs(store.currentRoomId)
            store.handoffChains = new Map(result.chains.map(chain => [chain.chainId, chain]))
        } catch {
            // Keep the original continuation error.
        }
        message.error(t(handoffErrorTranslationKey(err?.message) || 'groupChat.agentHandoffErrorGeneric'))
    } finally {
        isContinuingHandoff.value = false
    }
}

async function handleSaveRoomSummary() {
    if (!store.currentRoomId || isSavingRoomSummary.value || !currentRoomCanManage.value) return
    isSavingRoomSummary.value = true
    try {
        const result = await updateRoomSummary(store.currentRoomId, roomSummaryDraft.value)
        roomSummaryState.value = result.summary
        store.roomSummaryStates.set(store.currentRoomId, result.summary)
        message.success(t('groupChat.summaryUpdated'))
    } catch (err: any) {
        message.error(err?.message || t('common.saveFailed'))
    } finally {
        isSavingRoomSummary.value = false
    }
}

function roomSummaryStatusLabel(status?: RoomSummaryState['status']): string {
    return t(`groupChat.summaryStatus.${status || 'idle'}`)
}

function formatSummaryTime(timestamp?: number): string {
    return timestamp ? new Date(timestamp).toLocaleString() : t('groupChat.summaryNever')
}

async function handleRemoveAgent(agent: RoomAgent) {
    if (!store.currentRoomId) return
    if (!canRemoveAgent(agent)) return
    try {
        await store.removeAgentFromRoom(store.currentRoomId, agent.id)
        if (editingAgent.value && (editingAgent.value.id === agent.id || editingAgent.value.agentId === agent.agentId)) {
            closeAgentDrawer()
        }
    } catch {
        message.error(t('common.deleteFailed'))
    }
}

async function handleInterruptAgent(agent: RoomAgent) {
    if (!canStopAgent(agent)) return
    try {
        await store.interruptAgent(agent.name)
    } catch (err: any) {
        message.error(err.message || t('common.saveFailed'))
    }
}

async function handleApproval(choice: 'once' | 'session' | 'always' | 'deny') {
    try {
        await store.respondApproval(choice)
    } catch (err: any) {
        message.error(err.message || t('common.saveFailed'))
    }
}

async function handleClarify(response?: string) {
    if (!currentRoomCanManage.value) return
    const finalResponse = response !== undefined
        ? response
        : visibleClarify.value?.responseMode === 'editor'
            ? clarifyResponse.value
            : clarifyResponse.value.trim()
    if (response === undefined && !finalResponse && visibleClarify.value?.responseMode !== 'editor') return
    try {
        await store.respondClarify(finalResponse)
        clarifyResponse.value = ''
    } catch (err: any) {
        message.error(err.message || t('common.saveFailed'))
    }
}

function handleClarifyKeydown(event: KeyboardEvent) {
    if (visibleClarify.value?.responseMode === 'editor') return
    event.preventDefault()
    void handleClarify()
}

</script>

<template>
    <div class="group-chat-panel">
        <!-- Mobile backdrop -->
        <div v-if="!props.standalone" class="sidebar-backdrop" :class="{ active: showSidebar }" @click="showSidebar = false" />
        <!-- Room sidebar -->
        <div v-if="!props.standalone && showSidebar" class="room-sidebar">
            <div class="sidebar-header">
                <PageSidebarNav
                    active="group"
                    :primary-label="t('groupChat.createRoom')"
                    @primary="showCreateModal = true"
                />
            </div>
            <div class="room-list">
                <section v-if="store.rooms.length" class="room-section">
                    <button
                        class="room-section-title"
                        type="button"
                        :aria-expanded="!localRoomsCollapsed"
                        @click="localRoomsCollapsed = !localRoomsCollapsed"
                    >
                        <span>{{ t('groupChat.localRooms') }}</span>
                        <svg class="room-section-chevron" :class="{ collapsed: localRoomsCollapsed }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="m6 9 6 6 6-6" />
                        </svg>
                    </button>
                    <div v-show="!localRoomsCollapsed" class="room-section-content">
                        <div
                            v-for="room in store.rooms"
                            :key="room.id"
                            class="room-item"
                            :class="{ active: store.currentRoomId === room.id }"
                            @click="handleSelectRoom(room.id)"
                            @contextmenu="handleRoomContextMenu($event, room.id)"
                        >
                            <GroupRoomAgentAvatar
                                :agents="store.roomAgentsForRoom(room.id)"
                                :active-agent-ids="store.activeAgentIdsForRoom(room.id)"
                                :label="room.name || room.id"
                            />
                            <div class="room-info">
                                <span class="room-name">{{ room.name || room.id }}</span>
                                <span v-if="room.inviteCode" class="room-code">{{ room.inviteCode }}</span>
                                <span class="room-tokens">{{ formatTokens(room.totalTokens || 0) }}</span>
                            </div>
                            <NPopconfirm v-if="canManageRoom(room)" @positive-click="handleDeleteRoom(room.id)">
                                <template #trigger>
                                    <button class="room-action-btn danger" @click.stop>
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                    </button>
                                </template>
                                {{ t('groupChat.deleteRoomConfirm') }}
                            </NPopconfirm>
                        </div>
                    </div>
                </section>

                <section v-if="remoteRooms.length" class="room-section">
                    <button
                        class="room-section-title"
                        type="button"
                        :aria-expanded="!remoteRoomsCollapsed"
                        @click="remoteRoomsCollapsed = !remoteRoomsCollapsed"
                    >
                        <span>{{ t('groupChat.remoteRooms') }}</span>
                        <svg class="room-section-chevron" :class="{ collapsed: remoteRoomsCollapsed }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="m6 9 6 6 6-6" />
                        </svg>
                    </button>
                    <div v-show="!remoteRoomsCollapsed" class="room-section-content">
                        <button
                            v-for="room in remoteRooms"
                            :key="room.key"
                            class="room-item remote-room-item"
                            :class="{ unavailable: !room.inviteCode }"
                            type="button"
                            :aria-disabled="!room.inviteCode"
                            @click="handleSelectRemoteRoom(room)"
                            @contextmenu="handleRemoteRoomContextMenu($event, room)"
                        >
                            <svg class="room-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                            </svg>
                            <span class="room-info">
                                <span class="room-name">{{ room.roomName }}</span>
                                <span v-if="room.inviteCode" class="room-code">{{ room.inviteCode }}</span>
                                <span class="room-origin">{{ room.cloudOrigin }}</span>
                            </span>
                            <span
                                class="remote-room-state"
                                :class="{ online: room.connected }"
                                :title="room.connected ? t('groupChat.agentLinkConnected') : t('groupChat.remoteRoomOffline')"
                                :aria-label="room.connected ? t('groupChat.agentLinkConnected') : t('groupChat.remoteRoomOffline')"
                            >{{ room.connected ? '●' : '○' }}</span>
                        </button>
                    </div>
                </section>
            </div>
            <div class="page-sidebar-bottom">
                <button class="page-sidebar-menu-btn" type="button" @click="openSettingsPage">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="3" />
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                    <span>{{ t('sidebar.settings') }}</span>
                </button>
            </div>
        </div>

        <NDropdown
            v-if="!props.standalone"
            placement="bottom-start"
            trigger="manual"
            :x="roomContextMenuX"
            :y="roomContextMenuY"
            :options="roomContextMenuOptions"
            :show="showRoomContextMenu"
            @select="handleRoomContextSelect"
            @clickoutside="handleRoomContextClickOutside"
        />

        <NDropdown
            v-if="!props.standalone"
            placement="bottom-start"
            trigger="manual"
            :x="remoteRoomContextMenuX"
            :y="remoteRoomContextMenuY"
            :options="remoteRoomContextMenuOptions"
            :show="showRemoteRoomContextMenu"
            @select="handleRemoteRoomContextSelect"
            @clickoutside="handleRemoteRoomContextClickOutside"
        />

        <!-- Main chat area -->
        <div
            class="chat-main"
            :class="{ 'chat-main--sidebar-collapsed': !showSidebar }"
            @dragover="handleChatDragOver"
            @dragenter="handleChatDragEnter"
            @dragleave="handleChatDragLeave"
            @drop="handleChatDrop"
        >
            <div class="chat-header">
                <div class="header-left">
                    <button v-if="!props.standalone" class="icon-btn header-sidebar-toggle" @click="toggleSidebar">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                            <rect x="3" y="3" width="7" height="7" />
                            <rect x="14" y="3" width="7" height="7" />
                            <rect x="3" y="14" width="7" height="7" />
                            <rect x="14" y="14" width="7" height="7" />
                        </svg>
                    </button>
                    <span class="room-title-text">{{ store.roomName || (store.currentRoomId || t('groupChat.title')) }}</span>
                    <button
                        v-if="currentRoom?.workspace"
                        class="workspace-badge"
                        type="button"
                        :title="currentRoom.workspace"
                        @click="openWorkspaceFilesPanel"
                    >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                        </svg>
                        <span>{{ currentWorkspaceLabel }}</span>
                    </button>
                </div>
                <div class="header-info">
                    <button
                        v-if="currentRoomCanManage && pendingAgentPairings.length"
                        class="agent-pairing-header-button"
                        type="button"
                        @click="handleOpenRoomSettings"
                    >
                        <span class="agent-pairing-header-dot" aria-hidden="true" />
                        <span>{{ t('groupChat.agentPairingRequestTitle') }}</span>
                        <strong>{{ pendingAgentPairings.length }}</strong>
                    </button>
                    <button
                        v-if="currentRoomCanManage"
                        class="icon-btn workspace-panel-toggle"
                        :class="{ active: showWorkspacePanel }"
                        :title="groupToolPanelTitle"
                        :aria-label="groupToolPanelTitle"
                        :aria-pressed="showWorkspacePanel"
                        @click="toggleWorkspacePanel"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <rect x="3" y="3" width="18" height="18" rx="2" />
                            <line x1="15" y1="3" x2="15" y2="21" />
                        </svg>
                    </button>
                    <button v-if="currentRoomCanManage" class="icon-btn compression-settings-button" :title="t('groupChat.roomSettings')" @click="handleOpenRoomSettings">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 4.6a1.65 1.65 0 0 0 1.51 1V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1.51 1z"/></svg>
                    </button>
                    <NPopconfirm v-if="currentRoomCanManage" @positive-click="handleClearRoomContext">
                        <template #trigger>
                            <button class="icon-btn" :title="t('groupChat.clearContext')">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                    <path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v5" /><path d="M14 11v5" />
                                </svg>
                            </button>
                        </template>
                        {{ t('groupChat.clearContextConfirm') }}
                    </NPopconfirm>
                    <button
                        v-if="participantCount"
                        type="button"
                        class="member-count member-count-toggle"
                        :aria-expanded="showMemberRail"
                        @click="showMemberRail = !showMemberRail"
                    >
                        <span>{{ t('groupChat.members', { count: participantCount }) }}</span>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" :class="{ collapsed: !showMemberRail }" aria-hidden="true">
                            <polyline points="15 18 9 12 15 6" />
                        </svg>
                    </button>
                    <span class="connection-dot" :class="{ connected: store.connected, disconnected: !store.connected }"></span>
                </div>
            </div>

            <div
                v-if="hasRoom"
                ref="groupChatContentWrapperRef"
                class="group-chat-content-wrapper"
                :class="{ 'chat-main--drop-active': isChatDropActive }"
            >
                <aside
                    v-if="showMemberRail"
                    class="agent-avatar-rail"
                    :aria-label="t('groupChat.members', { count: participantCount })"
                >
                    <div class="agent-avatar-rail-trigger">
                        <NPopover
                            v-for="member in railMembers"
                            :key="member.userId"
                            trigger="hover"
                            placement="right"
                            :show-arrow="false"
                            :disabled="!currentRoomCanMentionAll || member.userId === store.userId"
                        >
                            <template #trigger>
                                <button
                                    type="button"
                                    class="agent-avatar-rail-item agent-avatar-rail-user"
                                    :class="{
                                        'agent-avatar-rail-current-user': member.userId === store.userId,
                                        'agent-avatar-rail-typing': member.userId !== store.userId && store.isUserTyping(member.userId),
                                        'agent-avatar-rail-offline': member.connectionStatus === 'offline',
                                    }"
                                    :title="member.userId === store.userId ? t('groupChat.yourName') : member.name"
                                    :aria-label="member.userId === store.userId ? t('groupChat.yourName') : member.name"
                                    :disabled="member.userId !== store.userId && !currentRoomCanMentionAll"
                                    @click="handleRoomMemberClick(member)"
                                >
                                    <ProfileAvatar
                                        class="agent-avatar"
                                        :name="member.name || t('groupChat.you')"
                                        :avatar="memberAvatarFor(member)"
                                        :size="32"
                                    />
                                </button>
                            </template>
                            <div class="agent-avatar-activity-popover">
                                <span class="agent-avatar-activity-text">{{ member.name }}</span>
                                <button
                                    type="button"
                                    class="agent-avatar-stop"
                                    :aria-label="t('groupChat.removeMember')"
                                    @click.stop="handleRemoveMember(member)"
                                >
                                    <span>{{ t('groupChat.removeMember') }}</span>
                                </button>
                            </div>
                        </NPopover>
                        <span v-if="store.agents.length" class="agent-avatar-rail-divider" aria-hidden="true"></span>
                        <NPopover
                            v-for="agent in store.agents"
                            :key="agent.id"
                            trigger="hover"
                            placement="right"
                            :show-arrow="false"
                            :disabled="!canRemoveAgent(agent) && !agentContextStatus(agent)"
                        >
                            <template #trigger>
                                <button
                                    type="button"
                                    class="agent-avatar-rail-item agent-avatar-rail-agent"
                                    :class="{
                                        'agent-avatar-rail-active': !!agentContextStatus(agent),
                                        'agent-avatar-rail-offline': agent.connectionStatus === 'offline',
                                    }"
                                    :aria-label="agent.name"
                                    :aria-busy="!!agentContextStatus(agent)"
                                    @click="handleAgentRailClick(agent)"
                                >
                                    <ProfileAvatar class="agent-avatar" :name="agentAvatarName(agent)" :avatar="groupAgentAvatar(agent)" :size="32" />
                                    <span
                                        v-if="agentOwnerMember(agent)"
                                        class="agent-owner-avatar-badge"
                                        :title="t('groupChat.agentOwner', { name: agentOwnerMember(agent)?.name })"
                                    >
                                        <ProfileAvatar
                                            :name="agentOwnerMember(agent)?.name || ''"
                                            :avatar="agentOwnerAvatar(agent)"
                                            :size="14"
                                        />
                                    </span>
                                </button>
                            </template>
                            <div class="agent-avatar-activity-popover">
                                <span class="agent-avatar-activity-text">
                                    @{{ agent.name }}
                                    <template v-if="agentContextStatus(agent)">
                                        {{ agentActivityLabel(agent) }}
                                    </template>
                                </span>
                                <button
                                    v-if="canStopAgent(agent) && agentContextStatus(agent)"
                                    type="button"
                                    class="agent-avatar-stop"
                                    :aria-label="t('common.stop')"
                                    @click.stop="handleInterruptAgent(agent)"
                                >
                                    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                        <rect x="6" y="6" width="12" height="12" rx="1" />
                                    </svg>
                                    <span>{{ t('common.stop') }}</span>
                                </button>
                                <button
                                    v-if="canRemoveAgent(agent)"
                                    type="button"
                                    class="agent-avatar-stop"
                                    :aria-label="t('common.delete')"
                                    @click.stop="handleRemoveAgent(agent)"
                                >
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                        <path d="M3 6h18" />
                                        <path d="M8 6V4h8v2" />
                                        <path d="M19 6l-1 14H6L5 6" />
                                    </svg>
                                    <span>{{ t('common.delete') }}</span>
                                </button>
                            </div>
                        </NPopover>
                    </div>
                    <button
                        v-if="currentRoomCanManage || props.standalone"
                        type="button"
                        class="agent-avatar-rail-add"
                        :title="props.standalone ? t('groupChat.agentLinkButton') : t('groupChat.addAgent')"
                        :aria-label="props.standalone ? t('groupChat.agentLinkButton') : t('groupChat.addAgent')"
                        @click="handleAgentRailAdd"
                    >
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
                            <line x1="12" y1="5" x2="12" y2="19" />
                            <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                    </button>
                </aside>
                <div ref="groupChatSurfaceRef" class="group-chat-surface">
                    <div class="group-message-shell">
                        <GroupMessageList
                            :allow-speech="!props.standalone"
                            :can-manage-handoff="currentRoomCanManage"
                            @mention-agent="handleMentionAgent"
                            @continue-handoff="handleContinueHandoff"
                            @adjust-handoff-settings="handleOpenRoomSettings"
                        />
                        <Transition name="approval-float">
                            <div v-if="visibleAgentPairing" class="approval-float-panel agent-pairing-float-panel">
                                <div class="approval-float-header">
                                    <span class="approval-float-icon" aria-hidden="true">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                            <circle cx="12" cy="8" r="4" />
                                            <path d="M4 21a8 8 0 0 1 16 0M19 8v6M16 11h6" />
                                        </svg>
                                    </span>
                                    <span>{{ t('groupChat.agentPairingRequestTitle') }}</span>
                                </div>
                                <div class="approval-float-title">
                                    @{{ visibleAgentPairing.agent.name }}
                                </div>
                                <div class="approval-float-desc">
                                    {{ t('groupChat.agentPairingRequestDescription', {
                                        user: visibleAgentPairing.ownerName,
                                        origin: visibleAgentPairing.targetOrigin,
                                    }) }}
                                </div>
                                <div class="approval-float-actions">
                                    <NButton
                                        size="small"
                                        type="primary"
                                        :loading="isDecidingAgentPairing"
                                        @click="handleAgentPairingDecision(true)"
                                    >
                                        {{ t('groupChat.approveAgent') }}
                                    </NButton>
                                    <NButton
                                        size="small"
                                        type="error"
                                        secondary
                                        :disabled="isDecidingAgentPairing"
                                        @click="handleAgentPairingDecision(false)"
                                    >
                                        {{ t('groupChat.rejectAgent') }}
                                    </NButton>
                                </div>
                            </div>
                        </Transition>
                        <Transition name="approval-float">
                            <div v-if="visibleApproval" class="approval-float-panel">
                                <div class="approval-float-header">
                                    <span class="approval-float-icon" aria-hidden="true">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
                                            <path d="m9 12 2 2 4-4" />
                                        </svg>
                                    </span>
                                    <span>{{ t('chat.approvalKicker') }}</span>
                                    <PendingInteractionCountdown :deadline="visibleApproval.countdownDeadline" />
                                </div>
                                <div class="approval-float-title">
                                    <span v-if="visibleApproval.agentName">@{{ visibleApproval.agentName }} · </span>{{ t('chat.approvalTitle') }}
                                </div>
                                <div class="approval-float-desc">{{ visibleApproval.description }}</div>
                                <code class="approval-float-command">{{ visibleApproval.command }}</code>
                                <div class="approval-float-actions">
                                    <NButton v-if="visibleApproval.isMemoryWrite" size="small" type="primary" @click="handleApproval('once')">
                                        {{ t('chat.approvalAgree') }}
                                    </NButton>
                                    <NButton v-if="!visibleApproval.isMemoryWrite && visibleApproval.choices.includes('once')" size="small" type="primary" @click="handleApproval('once')">
                                        {{ t('chat.approvalAllowOnce') }}
                                    </NButton>
                                    <NButton v-if="!visibleApproval.isMemoryWrite && visibleApproval.choices.includes('always')" size="small" secondary @click="handleApproval('always')">
                                        {{ t('chat.approvalAlways') }}
                                    </NButton>
                                    <NButton v-if="visibleApproval.isMemoryWrite || visibleApproval.choices.includes('deny')" size="small" type="error" secondary @click="handleApproval('deny')">
                                        {{ t('chat.approvalDeny') }}
                                    </NButton>
                                </div>
                            </div>
                        </Transition>
                        <Transition name="approval-float">
                            <div v-if="!visibleApproval && visibleClarify" class="approval-float-panel">
                                <div class="approval-float-header">
                                    <span class="approval-float-icon" aria-hidden="true">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                            <circle cx="12" cy="12" r="10" />
                                            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                                            <line x1="12" y1="17" x2="12.01" y2="17" />
                                        </svg>
                                    </span>
                                    <span>{{ t('chat.clarifyKicker') }}</span>
                                    <PendingInteractionCountdown :deadline="visibleClarify.countdownDeadline" />
                                </div>
                                <div class="approval-float-title">
                                    <span v-if="visibleClarify.agentName">@{{ visibleClarify.agentName }} · </span>{{ t('chat.clarifyTitle') }}
                                </div>
                                <div class="approval-float-desc">{{ visibleClarify.question }}</div>
                                <div v-if="visibleClarify.choices?.length" class="approval-float-actions">
                                    <NButton v-for="choice in visibleClarify.choices" :key="choice" size="small" type="primary" @click="handleClarify(choice)">
                                        {{ choice }}
                                    </NButton>
                                    <NButton size="small" type="error" secondary @click="handleClarify('')">
                                        {{ t('chat.clarifyDismiss') }}
                                    </NButton>
                                </div>
                                <div class="clarify-float-input-row">
                                    <NInput v-model:value="clarifyResponse" size="small" :type="visibleClarify.responseMode === 'editor' ? 'textarea' : 'text'" :placeholder="t('chat.clarifyPlaceholder')" @keydown.enter="handleClarifyKeydown" />
                                    <NButton size="small" type="primary" :disabled="visibleClarify.responseMode !== 'editor' && !clarifyResponse.trim()" @click="handleClarify()">
                                        {{ t('chat.clarifySubmit') }}
                                    </NButton>
                                </div>
                            </div>
                        </Transition>
                    </div>
                    <Transition name="summary-inline">
                        <div
                            v-if="inlineSummaryStatus"
                            class="group-summary-inline-status"
                            :class="`is-${inlineSummaryStatus.status}`"
                            role="status"
                            aria-live="polite"
                        >
                            <span class="group-summary-inline-label">
                                {{ roomSummaryStatusLabel(inlineSummaryStatus.status) }}
                            </span>
                            <span
                                v-if="inlineSummaryStatus.status === 'summarizing'"
                                class="group-summary-inline-spinner"
                                aria-hidden="true"
                            ></span>
                            <svg
                                v-else-if="inlineSummaryStatus.status === 'success'"
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                                class="group-summary-inline-success-icon"
                                aria-hidden="true"
                            >
                                <circle cx="12" cy="12" r="10" fill="currentColor" fill-opacity="0.15" />
                                <path d="M8 12L11 15L16 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                            </svg>
                            <svg
                                v-else
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                                class="group-summary-inline-error-icon"
                                aria-hidden="true"
                            >
                                <circle cx="12" cy="12" r="10" fill="currentColor" fill-opacity="0.15" />
                                <path d="M15 9L9 15M9 9L15 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                            </svg>
                            <span
                                v-if="inlineSummaryStatus.status === 'failed' && inlineSummaryStatus.error"
                                class="group-summary-inline-detail"
                                :title="inlineSummaryStatus.error"
                            >
                                {{ inlineSummaryStatus.error }}
                            </span>
                        </div>
                    </Transition>
                    <div v-if="store.executionQueue.length > 0" class="group-execution-queue-float-stack">
                        <MessageQueueFloatPanel
                            :items="store.executionQueue.map(item => ({
                                id: item.id,
                                text: item.textSummary,
                                secondary: item.targetAgentName,
                                position: item.position,
                            }))"
                            test-id="group-execution-queue"
                            :remove-title="item => t('groupChat.executionQueueCancel', { agent: item.secondary || '' })"
                            @remove="handleCancelQueuedExecution"
                        />
                    </div>
                    <GroupChatInput
                        ref="groupChatInputRef"
                        :room-id="store.currentRoomId"
                        :send-blocked="currentRoomNeedsSummaryConfiguration"
                        :allow-attachments="true"
                        :show-settings="!props.standalone"
                        :allow-all-mention="currentRoomCanMentionAll"
                        @send="handleSendMessage"
                        @send-blocked="handleSummaryConfigurationRequired"
                    />
                </div>
                <Transition
                    name="tool-panel"
                    @before-enter="handleToolPanelBeforeEnter"
                    @after-enter="handleToolPanelAfterEnter"
                    @before-leave="handleToolPanelBeforeLeave"
                    @leave-cancelled="handleToolPanelLeaveCancelled"
                >
                    <aside
                        v-if="showWorkspacePanel && (
                            activeWorkspacePanel === 'files'
                            || activeWorkspacePanel === 'terminal'
                            || (activeWorkspacePanel === 'browser' && desktopBrowserAvailable)
                            || toolPanelStore.workspaceDiff
                            || currentRoom?.workspace
                            || filesStore.previewFile?.workspaceRoomId === store.currentRoomId
                        )"
                        class="group-workspace-panel"
                        :style="workspacePanelStyle"
                    >
                        <div class="group-workspace-resize-handle" @pointerdown="startWorkspaceResize" />
                        <div class="group-workspace-panel-inner">
                            <WorkspaceDiffPreview
                                v-if="toolPanelStore.workspaceDiff"
                                :custom-close="closeWorkspacePanel"
                            />
                            <template v-else>
                                <div class="group-tool-tabs" role="tablist">
                                    <button
                                        class="group-tool-tab"
                                        :class="{ active: activeWorkspacePanel === 'files' }"
                                        type="button"
                                        role="tab"
                                        :title="t('drawer.files')"
                                        :aria-label="t('drawer.files')"
                                        :aria-selected="activeWorkspacePanel === 'files'"
                                        @click="selectWorkspacePanel('files')"
                                    >
                                        <svg viewBox="0 0 24 24" aria-hidden="true">
                                            <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />
                                        </svg>
                                    </button>
                                    <button
                                        class="group-tool-tab"
                                        :class="{ active: activeWorkspacePanel === 'terminal' }"
                                        type="button"
                                        role="tab"
                                        :title="t('drawer.terminal')"
                                        :aria-label="t('drawer.terminal')"
                                        :aria-selected="activeWorkspacePanel === 'terminal'"
                                        @click="selectWorkspacePanel('terminal')"
                                    >
                                        <svg viewBox="0 0 24 24" aria-hidden="true">
                                            <rect x="3" y="4" width="18" height="16" rx="2" />
                                            <path d="m7 9 3 3-3 3M13 15h4" />
                                        </svg>
                                    </button>
                                    <button
                                        v-if="desktopBrowserAvailable"
                                        class="group-tool-tab"
                                        :class="{ active: activeWorkspacePanel === 'browser' }"
                                        type="button"
                                        role="tab"
                                        :title="t('browser.title')"
                                        :aria-label="t('browser.title')"
                                        :aria-selected="activeWorkspacePanel === 'browser'"
                                        @click="selectWorkspacePanel('browser')"
                                    >
                                        <svg viewBox="0 0 24 24" aria-hidden="true">
                                            <rect x="3" y="4" width="18" height="16" rx="2" />
                                            <path d="M3 9h18" />
                                            <circle cx="6.5" cy="6.5" r=".75" fill="currentColor" stroke="none" />
                                            <circle cx="9.5" cy="6.5" r=".75" fill="currentColor" stroke="none" />
                                        </svg>
                                    </button>
                                </div>
                                <div class="group-tool-content">
                                    <template v-if="currentRoom?.workspace">
                                        <FilesPanel
                                            v-show="activeWorkspacePanel === 'files'"
                                            :workspace-room-id="store.currentRoomId"
                                            :workspace="currentRoom.workspace"
                                            @attach="handleWorkspaceFileAttach"
                                        />
                                    </template>
                                    <FilePreview
                                        v-else-if="filesStore.previewFile?.workspaceRoomId === store.currentRoomId"
                                        :custom-close="closeWorkspacePanel"
                                    />
                                    <div v-else-if="activeWorkspacePanel === 'files'" class="group-workspace-empty">
                                        <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                                            <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                                        </svg>
                                        <span>{{ t('chat.setWorkspaceTitle') }}</span>
                                        <NButton type="primary" size="small" @click="handleOpenWorkspacePicker()">
                                            {{ t('chat.setWorkspace') }}
                                        </NButton>
                                    </div>
                                    <TerminalPanel
                                        v-show="activeWorkspacePanel === 'terminal'"
                                        class="group-terminal-panel"
                                        :visible="showWorkspacePanel && activeWorkspacePanel === 'terminal'"
                                    />
                                    <DesktopBrowserPanel
                                        v-if="desktopBrowserAvailable && activeWorkspacePanel === 'browser'"
                                        class="group-browser-panel"
                                        :visible="toolPanelTransitionReady"
                                        :submit="submitBrowserAnnotations"
                                    />
                                </div>
                            </template>
                        </div>
                    </aside>
                </Transition>
            </div>

            <div v-else class="no-room">
                <div class="no-room-icon">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                </div>
                <p>{{ t('groupChat.selectOrCreate') }}</p>
            </div>
        </div>

        <NDrawer v-model:show="showCreateModal" placement="right" :width="workspacePanelMobile ? '100%' : 520">
            <NDrawerContent :title="t('groupChat.createRoom')" closable>
                <CreateRoomForm @submit="handleCreateRoom" @cancel="showCreateModal = false" />
            </NDrawerContent>
        </NDrawer>

        <NDrawer
            :show="showAddAgentDrawer"
            placement="right"
            :width="workspacePanelMobile ? '100%' : 520"
            :z-index="1000"
            :mask-closable="!isSavingAgent"
            :close-on-esc="!isSavingAgent && !showAgentPresetDialog"
            :trap-focus="!showAgentPresetDialog"
            @update:show="!$event && closeAgentDrawer()"
        >
            <NDrawerContent
                :title="editingAgent ? t('groupChat.editAgentTitle', { name: editingAgent.name }) : t('groupChat.addAgent')"
                :closable="!isSavingAgent"
            >
                    <div v-if="!editingAgent" class="agent-preset-entry">
                        <NButton secondary block @click="openAgentPresetSelection">
                            {{ t('groupChat.chooseAgentPreset') }}
                        </NButton>
                        <p class="form-hint">{{ t('groupChat.agentPresetSnapshotHint') }}</p>
                    </div>
                    <div v-if="editingAgent" class="agent-preset-entry">
                        <NButton secondary block @click="openAgentPresetManager">
                            {{ t('groupChat.manageAgentPresets') }}
                        </NButton>
                        <p class="form-hint">{{ t('groupChat.agentPresetSnapshotHint') }}</p>
                    </div>
                    <div class="group-agent-avatar-editor">
                        <ProfileAvatar
                            :name="selectedAgentType"
                            :avatar="agentAvatarPreview"
                            :size="64"
                        />
                        <div class="group-agent-avatar-controls">
                            <span class="form-label">{{ t('profiles.avatar.customize') }}</span>
                            <div class="group-agent-avatar-actions">
                                <NButton size="small" @click="triggerAgentAvatarUpload">
                                    {{ t('profiles.avatar.upload') }}
                                </NButton>
                                <NButton size="small" @click="handleRandomAgentAvatar">
                                    {{ t('profiles.avatar.random') }}
                                </NButton>
                                <NButton size="small" @click="handleResetAgentAvatar">
                                    {{ t('profiles.avatar.reset') }}
                                </NButton>
                            </div>
                            <span class="group-agent-avatar-hint">{{ t('profiles.avatar.hint') }}</span>
                        </div>
                        <input
                            ref="agentAvatarFileInput"
                            class="group-agent-avatar-file"
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            @change="handleAgentAvatarFileChange"
                        >
                    </div>
                    <div class="form-group">
                        <label class="form-label">{{ t('groupChat.agentType') }}</label>
                        <NSelect
                            :value="selectedAgentType"
                            :options="groupAgentTypeOptions"
                            @update:value="handleAgentTypeChange"
                        />
                    </div>
                    <div class="form-group">
                        <label class="form-label">{{ t('sidebar.profiles') }}</label>
                        <NSelect
                            :value="selectedProfile"
                            :options="profileOptions"
                            :placeholder="t('groupChat.selectProfile')"
                            filterable
                            @update:value="handleAgentProfileChange"
                        />
                    </div>
                    <DshSessionPresetSelect v-if="selectedAgentType === 'dsh'" class="form-group"
                        v-model="selectedRuntimePreset" :disabled="isSavingAgent"
                        @valid="selectedRuntimePresetReady = $event" />
                    <div v-if="supportsGlobalAgentMode" class="form-group">
                        <label class="form-label">{{ t('codingAgents.launchModeScope') }}</label>
                        <NSelect
                            :value="selectedAgentMode"
                            :options="agentModeOptions"
                            @update:value="handleAgentModeChange"
                        />
                    </div>
                    <div v-if="!usesGlobalAgentMode" class="form-group">
                        <label class="form-label">{{ t('models.provider') }}</label>
                        <NSelect
                            :value="selectedAgentProvider"
                            :options="agentProviderOptions"
                            :placeholder="t('models.selectProvider')"
                            filterable
                            @update:value="handleAgentProviderChange"
                        />
                    </div>
                    <div v-if="!usesGlobalAgentMode" class="form-group">
                        <label class="form-label">{{ t('models.models') }}</label>
                        <NSelect
                            :value="selectedAgentModel"
                            :options="agentModelOptions"
                            :placeholder="t('models.selectModel')"
                            :disabled="!selectedAgentProvider"
                            filterable
                            @update:value="handleAgentModelChange"
                        />
                    </div>
                    <div v-if="selectedAgentType !== 'hermes' && !usesGlobalAgentMode" class="form-group">
                        <label class="form-label">{{ t('codingAgents.protocolScope') }}</label>
                        <NSelect
                            v-model:value="selectedAgentApiMode"
                            :options="agentApiModeOptions"
                        />
                    </div>
                    <div v-if="!usesGlobalAgentMode" class="form-group">
                        <label class="form-label">{{ t('chat.reasoningEffort.tooltip') }}</label>
                        <NSelect
                            v-model:value="selectedAgentReasoningEffort"
                            :options="agentReasoningEffortOptions"
                            :placeholder="t('chat.reasoningEffort.tooltip')"
                        />
                    </div>
                    <div class="form-group">
                        <label class="form-label">{{ t('groupChat.agentName') }}</label>
                        <NInput
                            v-model:value="agentName"
                            :placeholder="t('groupChat.agentNamePlaceholder')"
                        />
                    </div>
                    <div class="form-group">
                        <label class="form-label">{{ t('groupChat.agentDesc') }}</label>
                        <NInput
                            v-model:value="agentDescription"
                            type="textarea"
                            :rows="2"
                            :placeholder="t('groupChat.agentDescPlaceholder')"
                        />
                    </div>
                <template #footer>
                    <div class="agent-drawer-actions" :class="{ 'is-editing': editingAgent }">
                        <NButton
                            v-if="editingAgent"
                            type="error"
                            secondary
                            :disabled="isSavingAgent"
                            @click="handleRemoveAgent(editingAgent)"
                        >
                            {{ t('common.delete') }}
                        </NButton>
                        <NSpace justify="end">
                            <NButton :disabled="isSavingAgent" @click="closeAgentDrawer">{{ t('common.cancel') }}</NButton>
                            <NButton
                                type="primary"
                                :disabled="!canConfirmAddAgent"
                                :loading="isSavingAgent"
                                @click="editingAgent ? confirmUpdateAgent() : confirmAddAgent()"
                            >
                                {{ editingAgent ? t('common.update') : t('common.add') }}
                            </NButton>
                        </NSpace>
                    </div>
                </template>
            </NDrawerContent>
        </NDrawer>

        <Teleport to="body">
            <div
                v-if="showAgentPresetDialog"
                class="modal-backdrop agent-preset-dialog-backdrop"
                @click.self="closeAgentPresetDialog"
            >
                <div class="modal agent-preset-dialog">
                    <h3>
                        {{ agentPresetDialogMode === 'select'
                            ? t('groupChat.chooseAgentPreset')
                            : t('groupChat.manageAgentPresets') }}
                    </h3>
                    <NInput
                        v-model:value="agentPresetSearch"
                        clearable
                        :placeholder="t('groupChat.searchAgentPresets')"
                    />
                    <div v-if="isLoadingAgentPresets" class="agent-preset-dialog-state">
                        {{ t('groupChat.agentPresetsLoading') }}
                    </div>
                    <div v-else-if="agentPresetLoadError" class="agent-preset-dialog-state is-error">
                        <span>{{ agentPresetLoadError }}</span>
                        <NButton size="small" secondary @click="loadAgentPresets">
                            {{ t('common.retry') }}
                        </NButton>
                    </div>
                    <div v-else-if="agentPresets.length === 0" class="agent-preset-dialog-state">
                        {{ t('groupChat.agentPresetsEmpty') }}
                    </div>
                    <div v-else-if="filteredAgentPresets.length === 0" class="agent-preset-dialog-state">
                        {{ t('groupChat.agentPresetsNoResults') }}
                    </div>
                    <div v-else class="agent-preset-dialog-list">
                        <button
                            v-for="preset in filteredAgentPresets"
                            :key="preset.id"
                            type="button"
                            class="agent-preset-dialog-row"
                            :class="{
                                selected: pendingAgentPresetId === preset.id,
                                unavailable: !preset.available,
                            }"
                            :disabled="!preset.available"
                            :aria-pressed="pendingAgentPresetId === preset.id"
                            @click="selectAgentPresetForDialog(preset)"
                        >
                            <span class="agent-preset-dialog-row-name">{{ preset.name }}</span>
                            <span class="agent-preset-dialog-row-config">
                                {{ preset.profile }} · {{ preset.agentMode === 'global'
                                    ? t('codingAgents.launchModeGlobal')
                                    : `${preset.provider}/${preset.model}` }}
                            </span>
                            <span v-if="!preset.available" class="agent-preset-dialog-row-error">
                                {{ preset.validationError || t('groupChat.agentPresetUnavailable') }}
                            </span>
                        </button>
                    </div>
                    <p class="form-hint">{{ t('groupChat.agentPresetSnapshotHint') }}</p>
                    <div v-if="agentPresetDialogMode === 'manage'" class="agent-preset-management-actions">
                        <NButton
                            secondary
                            :disabled="!canConfirmAddAgent || isSavingAgentPreset"
                            :loading="isSavingAgentPreset && !pendingAgentPresetId"
                            @click="createAgentPresetFromCurrent"
                        >
                            {{ t('groupChat.saveCurrentAgentAsPreset') }}
                        </NButton>
                        <NButton
                            secondary
                            :disabled="!pendingAgentPresetId || !canConfirmAddAgent || isSavingAgentPreset"
                            :loading="isSavingAgentPreset && Boolean(pendingAgentPresetId)"
                            @click="updateSelectedAgentPreset"
                        >
                            {{ t('groupChat.updateAgentPreset') }}
                        </NButton>
                        <NPopconfirm
                            v-if="pendingAgentPresetId"
                            @positive-click="deleteAgentPreset"
                        >
                            <template #trigger>
                                <NButton type="error" secondary :disabled="isSavingAgentPreset">
                                    {{ t('groupChat.deleteAgentPreset') }}
                                </NButton>
                            </template>
                            {{ t('groupChat.deleteAgentPresetConfirm') }}
                        </NPopconfirm>
                    </div>
                    <div class="modal-actions">
                        <NButton @click="closeAgentPresetDialog">
                            {{ t('common.cancel') }}
                        </NButton>
                        <NButton
                            v-if="agentPresetDialogMode === 'select'"
                            type="primary"
                            :disabled="!pendingAgentPreset?.available"
                            @click="confirmAgentPresetSelection"
                        >
                            {{ t('groupChat.applyAgentPreset') }}
                        </NButton>
                    </div>
                </div>
            </div>
            <div v-if="showCloneModal" class="modal-backdrop" @click.self="showCloneModal = false">
                <div class="modal">
                    <h3>{{ t('groupChat.cloneRoom') }}</h3>
                    <div class="form-group">
                        <label class="form-label">{{ t('groupChat.roomName') }}</label>
                        <NInput
                            v-model:value="cloneRoomName"
                            :placeholder="t('groupChat.roomNamePlaceholder')"
                            @keyup.enter="confirmCloneRoom"
                        />
                    </div>
                    <div class="form-group">
                        <label class="form-label">{{ t('groupChat.inviteCode') }}</label>
                        <div class="code-row">
                            <NInput
                                v-model:value="cloneInviteCode"
                                :placeholder="t('groupChat.autoGenerate')"
                                @keyup.enter="confirmCloneRoom"
                            />
                            <NButton size="small" @click="cloneInviteCode = generateGroupChatInviteCode()">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                                    <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                                </svg>
                            </NButton>
                        </div>
                    </div>
                    <div class="modal-actions">
                        <NSpace justify="end">
                            <NButton @click="showCloneModal = false">{{ t('common.cancel') }}</NButton>
                            <NButton type="primary" :disabled="!cloneRoomName.trim()" @click="confirmCloneRoom">{{ t('groupChat.cloneRoom') }}</NButton>
                        </NSpace>
                    </div>
                </div>
            </div>
            <NModal
                v-model:show="showRemoteRoomRenameModal"
                preset="dialog"
                :title="t('groupChat.renameRemoteRoom')"
                style="width: 460px; max-width: 92vw"
                @after-leave="remoteRoomBeingRenamed = null"
            >
                <NInput
                    v-model:value="remoteRoomNameDraft"
                    :placeholder="t('groupChat.roomNamePlaceholder')"
                    :maxlength="120"
                    @keyup.enter="confirmRemoteRoomRename"
                />
                <p class="form-hint">{{ t('groupChat.renameRemoteRoomHint') }}</p>
                <template #action>
                    <NSpace justify="end">
                        <NButton :disabled="isUpdatingRemoteRoom" @click="showRemoteRoomRenameModal = false">
                            {{ t('common.cancel') }}
                        </NButton>
                        <NButton
                            type="primary"
                            :loading="isUpdatingRemoteRoom"
                            :disabled="!remoteRoomNameDraft.trim()"
                            @click="confirmRemoteRoomRename"
                        >
                            {{ t('groupChat.renameRemoteRoom') }}
                        </NButton>
                    </NSpace>
                </template>
            </NModal>
            <NModal
                :show="Boolean(remoteRoomBeingLeft)"
                preset="dialog"
                :title="t('groupChat.leaveRemoteRoom')"
                style="width: 480px; max-width: 92vw"
                @update:show="visible => { if (!visible && !isUpdatingRemoteRoom) remoteRoomBeingLeft = null }"
            >
                <p class="manual-room-link-hint">
                    {{ t('groupChat.leaveRemoteRoomConfirm', { name: remoteRoomBeingLeft?.roomName || '' }) }}
                </p>
                <template #action>
                    <NSpace justify="end">
                        <NButton :disabled="isUpdatingRemoteRoom" @click="remoteRoomBeingLeft = null">
                            {{ t('common.cancel') }}
                        </NButton>
                        <NButton type="error" :loading="isUpdatingRemoteRoom" @click="confirmLeaveRemoteRoom">
                            {{ t('groupChat.leaveRemoteRoom') }}
                        </NButton>
                    </NSpace>
                </template>
            </NModal>
            <NModal
                v-model:show="showManualRoomLinkModal"
                preset="dialog"
                :title="t('groupChat.copyRoomLink')"
                :aria-label="t('groupChat.copyRoomLink')"
                style="width: 560px; max-width: 92vw"
                @after-enter="selectManualRoomLink"
            >
                <p class="manual-room-link-hint">
                    {{ t('groupChat.manualCopyRoomLinkHint') }}
                </p>
                <input
                    ref="manualRoomLinkInput"
                    class="manual-room-link-input"
                    type="text"
                    :value="manualRoomLink"
                    :aria-label="t('groupChat.copyRoomLink')"
                    readonly
                    @click="selectManualRoomLink"
                >
                <template #action>
                    <NButton type="primary" @click="showManualRoomLinkModal = false">
                        {{ t('common.ok') }}
                    </NButton>
                </template>
            </NModal>
            <NModal
                v-model:show="showGroupChatRefactorNotice"
                preset="dialog"
                :title="t('groupChat.refactorNoticeTitle')"
                :mask-closable="false"
                :close-on-esc="false"
                :closable="false"
                style="width: 480px; max-width: 92vw"
            >
                <p class="group-chat-refactor-notice">
                    {{ t('groupChat.refactorNoticeMessage') }}
                </p>
                <template #action>
                    <NButton type="primary" @click="acknowledgeGroupChatRefactorNotice">
                        {{ t('common.confirm') }}
                    </NButton>
                </template>
            </NModal>
            <NModal
                v-model:show="showWorkspaceModal"
                preset="dialog"
                :title="t('chat.setWorkspaceTitle')"
                class="workspace-modal"
                style="width: 520px; max-width: 92vw"
            >
                <FolderPicker v-model="workspaceValue" />
                <template #action>
                    <NSpace justify="end">
                        <NButton @click="showWorkspaceModal = false">{{ t('common.cancel') }}</NButton>
                        <NButton @click="handleClearWorkspace">{{ t('workflow.workspace.clear') }}</NButton>
                        <NButton type="primary" @click="handleSaveWorkspace">{{ t('common.save') }}</NButton>
                    </NSpace>
                </template>
            </NModal>
            <NModal
                v-model:show="showUserProfileModal"
                preset="dialog"
                :title="t('groupChat.yourName')"
                style="width: 460px; max-width: 92vw"
            >
                <div class="form-group">
                    <label class="form-label">{{ t('groupChat.yourName') }}</label>
                    <NInput
                        v-model:value="userProfileName"
                        :placeholder="t('groupChat.yourNamePlaceholder')"
                        :maxlength="120"
                        @keyup.enter="handleSaveUserProfile"
                    />
                </div>
                <div class="form-group">
                    <label class="form-label">{{ t('groupChat.yourDescription') }}</label>
                    <NInput
                        v-model:value="userProfileDescription"
                        type="textarea"
                        :rows="3"
                        :maxlength="2000"
                        :placeholder="t('groupChat.yourDescriptionPlaceholder')"
                    />
                </div>
                <template #action>
                    <NSpace justify="end">
                        <NButton @click="showUserProfileModal = false">{{ t('common.cancel') }}</NButton>
                        <NButton
                            type="primary"
                            :disabled="!userProfileName.trim()"
                            :loading="isSavingUserProfile"
                            @click="handleSaveUserProfile"
                        >
                            {{ t('common.save') }}
                        </NButton>
                    </NSpace>
                </template>
            </NModal>
            <NDrawer
                v-model:show="showRoomSettingsModal"
                placement="right"
                :width="workspacePanelMobile ? '100%' : 520"
            >
                <NDrawerContent :title="t('groupChat.roomSettings')" closable>
                    <div class="room-settings-drawer">
                        <section v-if="pendingAgentPairings.length" class="settings-section pending-agent-pairings-section">
                            <h4>{{ t('groupChat.agentPairingRequestTitle') }} ({{ pendingAgentPairings.length }})</h4>
                            <article
                                v-for="request in pendingAgentPairings"
                                :key="request.id"
                                class="pending-agent-pairing-card"
                            >
                                <strong>@{{ request.agent.name }}</strong>
                                <p>
                                    {{ t('groupChat.agentPairingRequestDescription', {
                                        user: request.ownerName,
                                        origin: request.targetOrigin,
                                    }) }}
                                </p>
                                <NSpace>
                                    <NButton
                                        size="small"
                                        type="primary"
                                        :loading="isDecidingAgentPairing"
                                        @click="handleAgentPairingDecision(true, request)"
                                    >
                                        {{ t('groupChat.approveAgent') }}
                                    </NButton>
                                    <NButton
                                        size="small"
                                        type="error"
                                        secondary
                                        :disabled="isDecidingAgentPairing"
                                        @click="handleAgentPairingDecision(false, request)"
                                    >
                                        {{ t('groupChat.rejectAgent') }}
                                    </NButton>
                                </NSpace>
                            </article>
                        </section>
                        <section class="settings-section">
                            <h4>{{ t('groupChat.roomName') }}</h4>
                            <div class="code-row room-name-row">
                                <NInput
                                    v-model:value="roomNameDraft"
                                    :placeholder="t('groupChat.roomNamePlaceholder')"
                                    :maxlength="120"
                                    :disabled="isSavingRoomName"
                                    @keyup.enter="handleSaveRoomName"
                                />
                                <NButton
                                    type="primary"
                                    :disabled="!canUpdateRoomName"
                                    :loading="isSavingRoomName"
                                    @click="handleSaveRoomName"
                                >
                                    {{ t('common.update') }}
                                </NButton>
                            </div>
                        </section>
                        <section class="settings-section">
                            <h4>{{ t('groupChat.inviteCodeSettings') }}</h4>
                            <div class="form-group">
                                <label class="form-label">{{ t('groupChat.inviteCode') }}</label>
                                <div class="code-row invite-code-row">
                                    <NInput
                                        v-model:value="inviteCodeDraft"
                                        :placeholder="t('groupChat.inviteCodePlaceholder')"
                                        :disabled="isSavingInviteCode"
                                        @keyup.enter="handleSaveInviteCode"
                                    />
                                    <NButton size="small" :disabled="isSavingInviteCode" :title="t('groupChat.generateInviteCode')" @click="inviteCodeDraft = generateGroupChatInviteCode()">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                                            <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                                        </svg>
                                    </NButton>
                                    <NButton
                                        type="primary"
                                        :disabled="!canUpdateInviteCode"
                                        :loading="isSavingInviteCode"
                                        @click="handleSaveInviteCode"
                                    >
                                        {{ t('common.update') }}
                                    </NButton>
                                </div>
                                <p class="form-hint">{{ t('groupChat.inviteCodeRotateHint') }}</p>
                                <NButton
                                    class="share-link-button"
                                    secondary
                                    block
                                    :disabled="!currentRoom?.inviteCode"
                                    @click="copyCurrentRoomLink"
                                >
                                    {{ t('groupChat.copyRoomLink') }}
                                </NButton>
                            </div>
                        </section>
                        <section class="settings-section">
                            <h4>{{ t('groupChat.guestAgentSettings') }}</h4>
                            <div class="guest-agent-policy-row">
                                <div>
                                    <strong>{{ t('groupChat.allowGuestAgents') }}</strong>
                                    <p class="form-hint">{{ t('groupChat.ownerApprovalHint') }}</p>
                                </div>
                                <NSwitch v-model:value="allowGuestAgentsDraft" />
                            </div>
                            <div class="form-group">
                                <label class="form-label">{{ t('groupChat.maxGuestAgentsPerMember') }}</label>
                                <NInputNumber
                                    v-model:value="maxGuestAgentsPerMemberDraft"
                                    :min="1"
                                    :max="5"
                                    :step="1"
                                    :disabled="!allowGuestAgentsDraft"
                                    style="width: 100%"
                                />
                            </div>
                            <div class="guest-agent-policy-row">
                                <div>
                                    <strong>{{ t('groupChat.allowRemoteWorkspaceAccess') }}</strong>
                                    <p class="form-hint">{{ t('groupChat.remoteWorkspaceAccessHint') }}</p>
                                </div>
                                <NSwitch
                                    v-model:value="allowRemoteWorkspaceAccessDraft"
                                    :disabled="!allowGuestAgentsDraft"
                                />
                            </div>
                            <NButton
                                type="primary"
                                :loading="isSavingGuestAgentPolicy"
                                @click="handleSaveGuestAgentPolicy"
                            >
                                {{ t('common.save') }}
                            </NButton>
                        </section>
                        <section class="settings-section">
                            <h4>{{ t('chat.setWorkspaceTitle') }}</h4>
                            <FolderPicker v-model="workspaceValue" />
                            <NSpace class="room-workspace-actions" justify="end">
                                <NButton @click="handleClearWorkspace">{{ t('workflow.workspace.clear') }}</NButton>
                                <NButton type="primary" @click="handleSaveWorkspace">{{ t('common.save') }}</NButton>
                            </NSpace>
                        </section>
                        <section ref="summarySettingsSectionRef" class="settings-section">
                            <h4>{{ t('groupChat.summarySettings') }}</h4>
                            <p v-if="currentRoomNeedsSummaryConfiguration" class="summary-config-required">
                                {{ t('groupChat.summaryConfigurationRequired') }}
                            </p>
                            <p class="form-hint">{{ t('groupChat.summarySettingsDesc') }}</p>
                            <div class="form-group">
                                <label class="form-label">{{ t('groupChat.summaryProvider') }}</label>
                                <NSelect
                                    :value="summaryConfig.summaryProvider"
                                    :options="summaryProviderOptions"
                                    @update:value="handleSummaryProviderChange"
                                />
                            </div>
                            <div class="form-group">
                                <label class="form-label">{{ t('groupChat.summaryModel') }}</label>
                                <NSelect
                                    v-model:value="summaryConfig.summaryModel"
                                    :options="summaryModelOptions"
                                    :disabled="!summaryConfig.summaryProvider"
                                />
                            </div>
                            <div class="form-group">
                                <label class="form-label">{{ t('groupChat.summaryApiMode') }}</label>
                                <NSelect v-model:value="summaryConfig.summaryApiMode" :options="summaryApiModeOptions" />
                            </div>
                            <div class="form-group">
                                <label class="form-label">{{ t('groupChat.summaryEveryTurns') }}</label>
                                <NInputNumber v-model:value="summaryConfig.summaryEveryTurns" :min="1" :max="1000" :step="1" style="width: 100%" />
                                <p class="form-hint">{{ t('groupChat.summaryEveryTurnsDesc') }}</p>
                            </div>
                            <div class="form-group">
                                <label class="form-label">{{ t('groupChat.summaryEvaluationProfile') }}</label>
                                <NSelect v-model:value="summaryConfig.evaluationProfile" :options="profilesStore.profiles.map(profile => ({ label: profile.name, value: profile.name }))" />
                            </div>
                            <div class="guest-agent-policy-row">
                                <div><strong>{{ t('groupChat.summaryReviewEnabled') }}</strong><p class="form-hint">{{ t('groupChat.summaryReviewHint') }}</p></div>
                                <NSwitch :value="summaryConfig.summaryReviewMode !== 'off'" @update:value="value => summaryConfig.summaryReviewMode = value ? 'inherit' : 'off'" />
                            </div>
                            <div class="guest-agent-policy-row">
                                <div><strong>{{ t('groupChat.summaryRevisionEnabled') }}</strong><p class="form-hint">{{ t('groupChat.summaryRevisionHint') }}</p></div>
                                <NSwitch v-model:value="summaryConfig.summaryRevisionEnabled" />
                            </div>
                            <NButton
                                type="primary"
                                :disabled="!summaryConfig.summaryProvider || !summaryConfig.summaryModel || !summaryConfig.summaryApiMode"
                                @click="handleSaveSummaryConfig"
                            >
                                {{ t('groupChat.saveSummaryConfig') }}
                            </NButton>
                        </section>
                        <section class="settings-section">
                            <h4>{{ t('groupChat.agentHandoffTitle') }}</h4>
                            <div class="guest-agent-policy-row">
                                <div>
                                    <strong>{{ t('groupChat.agentHandoffEnabled') }}</strong>
                                    <p class="form-hint">{{ t('groupChat.agentHandoffRecommendation', { count: agentHandoffRecommendation }) }}</p>
                                </div>
                                <NSwitch v-model:value="agentHandoffEnabledDraft" />
                            </div>
                            <div class="form-group">
                                <label class="form-label">{{ t('groupChat.agentHandoffMaxDepth') }}</label>
                                <NInputNumber
                                    v-model:value="agentHandoffMaxDepthDraft"
                                    :min="1"
                                    :max="100"
                                    :disabled="agentHandoffUnlimitedDraft || !agentHandoffEnabledDraft"
                                    style="width: 100%"
                                />
                            </div>
                            <div class="guest-agent-policy-row">
                                <strong>{{ t('groupChat.agentHandoffUnlimited') }}</strong>
                                <NSwitch v-model:value="agentHandoffUnlimitedDraft" :disabled="!agentHandoffEnabledDraft" />
                            </div>
                            <NButton type="primary" @click="handleSaveHandoffConfig">{{ t('common.save') }}</NButton>
                        </section>
                    <section class="settings-section summary-state-section">
                        <div class="summary-state-heading">
                            <h4>{{ t('groupChat.currentSummary') }}</h4>
                            <span class="summary-status" :class="`is-${liveRoomSummaryState?.status || 'idle'}`">
                                {{ roomSummaryStatusLabel(liveRoomSummaryState?.status) }}
                            </span>
                        </div>
                        <div v-if="isLoadingRoomSummary" class="summary-loading">{{ t('common.loading') }}</div>
                        <template v-else>
                            <div class="summary-meta">
                                <span>
                                    <span>{{ t('groupChat.summaryUpdatedAt') }}</span>
                                    <strong>{{ formatSummaryTime(liveRoomSummaryState?.updatedAt) }}</strong>
                                </span>
                                <span>
                                    <span>{{ t('groupChat.summarizedTurns') }}</span>
                                    <strong>{{ liveRoomSummaryState?.summarizedTurnCount || 0 }}</strong>
                                </span>
                            </div>
                            <div v-if="liveRoomSummaryReview" class="summary-review" :class="`is-${liveRoomSummaryReview.decision}`">
                                <strong>{{ t('groupChat.summaryQuality') }} · {{ t(`groupChat.summaryQualityDecision.${liveRoomSummaryReview.decision}`) }}</strong>
                                <span>{{ t('groupChat.summaryQualityVersion', { version: liveRoomSummaryReview.sourceVersion }) }}</span>
                                <ul v-if="liveRoomSummaryReview.ruleResults.length">
                                    <li v-for="rule in liveRoomSummaryReview.ruleResults" :key="rule.id">{{ t(`groupChat.summaryQualityRule.${rule.id}`) }} · {{ t(`groupChat.summaryQualityDecision.${rule.decision}`) }}</li>
                                </ul>
                            </div>
                            <div v-if="liveRoomSummaryState?.lastError" class="summary-error">
                                {{ liveRoomSummaryState.lastError }}
                            </div>
                            <div class="summary-anchor">
                                <div>
                                    <strong>{{ t('groupChat.summaryAnchor') }}</strong>
                                    <template v-if="roomSummaryAnchor">
                                        <span>{{ roomSummaryAnchor.senderName }} · {{ formatSummaryTime(roomSummaryAnchor.timestamp) }}</span>
                                        <p>{{ roomSummaryAnchor.content }}</p>
                                    </template>
                                    <span v-else>{{ liveRoomSummaryState?.summaryThroughMessageId || t('groupChat.summaryNoAnchor') }}</span>
                                </div>
                            </div>
                            <div class="form-group">
                                <label class="form-label">{{ t('groupChat.summaryContent') }}</label>
                                <NInput
                                    v-model:value="roomSummaryDraft"
                                    type="textarea"
                                    :rows="12"
                                    :disabled="liveRoomSummaryState?.status === 'summarizing'"
                                    :placeholder="t('groupChat.summaryEmpty')"
                                />
                                <p class="form-hint">{{ t('groupChat.summaryEditKeepsAnchor') }}</p>
                            </div>
                            <NButton
                                type="primary"
                                :loading="isSavingRoomSummary"
                                :disabled="liveRoomSummaryState?.status === 'summarizing'"
                                @click="handleSaveRoomSummary"
                            >
                                {{ t('groupChat.saveSummary') }}
                            </NButton>
                        </template>
                    </section>
                    </div>
                </NDrawerContent>
            </NDrawer>
        </Teleport>

    </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import CreateRoomForm from './CreateRoomForm.vue'

export default defineComponent({ components: { CreateRoomForm } })
</script>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.group-chat-panel {
    display: flex;
    height: 100%;
    overflow: hidden;
    position: relative;
    min-width: 0;
    max-width: 100%;
    background-color: $bg-card;
}

.group-execution-queue-float-stack {
    position: absolute;
    right: 16px;
    bottom: 82px;
    z-index: 8;
    width: min(380px, calc(100% - 32px));
    pointer-events: none;
}

.sidebar-backdrop {
    display: none;
}

.group-message-shell {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
}

.group-chat-refactor-notice {
    margin: 0;
    line-height: 1.7;
}

@media (max-width: $breakpoint-mobile) {
    .sidebar-backdrop {
        display: block;
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        z-index: 99;
        opacity: 0;
        pointer-events: none;
        transition: opacity $transition-fast;

        &.active {
            opacity: 1;
            pointer-events: auto;
        }
    }
}

.approval-float-panel {
    position: absolute;
    right: 16px;
    bottom: 16px;
    z-index: 8;
    width: min(720px, calc(100% - 32px));
    padding: 10px;
    border: 1px solid rgba(var(--accent-primary-rgb), 0.24);
    border-radius: 16px;
    background: #ffffff;
    box-shadow: 0 14px 40px rgba(0, 0, 0, 0.14);
    backdrop-filter: blur(14px);

    .dark & {
        background: #262626;
    }
}

.approval-float-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 4px 8px;
    color: var(--accent-primary);
    font-size: 11px;
    font-weight: 700;
    line-height: 1.2;
    letter-spacing: 0.08em;
    text-transform: uppercase;
}

.approval-float-icon {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--accent-primary);
    background: rgba(var(--accent-primary-rgb), 0.12);
    border: 1px solid rgba(var(--accent-primary-rgb), 0.24);
}

.approval-float-title {
    padding: 0 4px;
    font-size: 14px;
    font-weight: 700;
    line-height: 1.3;
    color: $text-primary;
}

.approval-float-desc {
    padding: 0 4px;
    margin-top: 5px;
    font-size: 12px;
    line-height: 1.45;
    color: $text-secondary;
}

.approval-float-command {
    display: block;
    margin: 8px 4px 0;
    max-height: 96px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: "SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace;
    font-size: 11px;
    line-height: 1.45;
    color: $text-primary;
    background: rgba(255, 255, 255, 0.68);
    border: 1px solid $border-color;
    border-radius: 11px;
    padding: 8px 10px;

    .dark & {
        background: rgba(255, 255, 255, 0.08);
    }
}

.approval-float-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-start;
    gap: 8px;
    margin-top: 10px;
    padding: 10px 4px 0;
    border-top: 1px solid $border-color;
}

.clarify-float-input-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    margin-top: 10px;
    padding: 10px 4px 0;
    border-top: 1px solid $border-color;
}

@media (max-width: 640px) {
    .approval-float-panel {
        left: 8px;
        right: 8px;
        bottom: 8px;
        width: auto;
        padding: 7px;
        border-radius: 14px;
    }

    .approval-float-actions {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .approval-float-actions :deep(.n-button) {
        width: 100%;
    }
}

.approval-float-enter-active,
.approval-float-leave-active {
    transition: opacity 0.2s ease, transform 0.2s ease;
}

.approval-float-enter-from,
.approval-float-leave-to {
    opacity: 0;
    transform: translateY(10px) scale(0.98);
}

// ─── Room Sidebar ────────────────────────────────────────

.room-sidebar {
    width: $sidebar-width;
    min-height: 0;
    align-self: stretch;
    margin: 10px;
    background: $bg-sidebar-surface;
    border: 1px solid $border-color;
    border-radius: 14px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.sidebar-header {
    padding: 12px;
    flex-shrink: 0;
}

.page-sidebar-tab {
    width: 100%;
    min-width: 0;
    height: 34px;
    border: none;
    border-radius: $radius-sm;
    background: transparent;
    color: $text-secondary;
    display: inline-flex;
    align-items: center;
    justify-content: flex-start;
    gap: 8px;
    padding: 7px 10px;
    cursor: pointer;
    transition:
        background-color $transition-fast,
        color $transition-fast;

    svg {
        flex-shrink: 0;
    }

    span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
        line-height: 18px;
    }

    &:hover {
        background: rgba(var(--accent-primary-rgb), 0.06);
        color: $text-primary;
    }

}

.conversation-switch {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 2px;
    margin: 0 12px 8px;
    padding: 2px;
    border-radius: $radius-sm;
    background: rgba(var(--accent-primary-rgb), 0.05);
    flex-shrink: 0;
}

.conversation-switch-tab {
    min-width: 0;
    height: 28px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: $text-secondary;
    font-size: 12px;
    line-height: 16px;
    cursor: pointer;
    transition:
        background-color $transition-fast,
        color $transition-fast;

    &:hover {
        color: $text-primary;
    }

    &.active {
        background: $bg-card;
        color: $text-primary;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
    }
}

.manual-room-link-hint {
    margin: 0 0 12px;
    color: var(--text-secondary);
    line-height: 1.6;
}

.manual-room-link-input {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    padding: 9px 12px;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    outline: none;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font: inherit;
}

.manual-room-link-input:focus {
    border-color: var(--primary-color);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary-color) 18%, transparent);
}

.room-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
}

.room-section + .room-section {
    margin-top: 14px;
}

.room-section-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    box-sizing: border-box;
    width: 100%;
    padding: 4px 10px 6px;
    border: 0;
    background: transparent;
    color: $text-muted;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-align: start;
    text-transform: uppercase;
    cursor: pointer;

    &:hover {
        color: $text-secondary;
    }
}

.room-section-chevron {
    transition: transform $transition-fast;

    &.collapsed {
        transform: rotate(-90deg);
    }
}

.room-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px;
    border-radius: $radius-sm;
    cursor: pointer;
    transition: background-color $transition-fast;

    &:hover {
        background-color: rgba(var(--accent-primary-rgb), 0.06);
    }

    &.active {
        background-color: rgba(var(--accent-primary-rgb), 0.12);
    }

    &.active .room-name {
        color: $text-primary;
    }

    .room-icon {
        color: $text-muted;
        flex-shrink: 0;
    }

    .room-info {
        display: flex;
        flex-direction: column;
        min-width: 0;
        flex: 1;
    }

    .room-name {
        font-size: 13px;
        color: $text-primary;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .room-code {
        font-size: 11px;
        color: $text-muted;
        font-family: $font-code;
    }

    .room-tokens {
        font-size: 11px;
        color: $text-muted;
    }

    .room-action-btn {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border: none;
        background: transparent;
        color: $text-muted;
        cursor: pointer;
        border-radius: $radius-sm;
        opacity: 0;
        transition: opacity $transition-fast, color $transition-fast, background-color $transition-fast;

        &:hover {
            color: $text-primary;
            background-color: rgba(var(--accent-primary-rgb), 0.08);
        }

        &.danger:hover {
            color: $error;
            background-color: rgba(var(--error-rgb), 0.1);
        }
    }

    &:hover .room-action-btn {
        opacity: 1;
    }
}

.remote-room-item {
    box-sizing: border-box;
    width: 100%;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;

    &.unavailable {
        opacity: 0.6;
    }

    .room-origin {
        overflow: hidden;
        color: $text-muted;
        font-family: $font-code;
        font-size: 11px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
}

.remote-room-state {
    flex-shrink: 0;
    color: $text-muted;
    font-size: 11px;

    &.online {
        color: $success;
    }
}

.empty-rooms {
    padding: 20px 12px;
    text-align: center;
    font-size: 13px;
    color: $text-muted;
}

.page-sidebar-bottom {
    flex-shrink: 0;
    padding: 10px 12px;
    display: flex;
    align-items: center;
    gap: 8px;
}

.page-sidebar-menu-btn {
    flex: 1 1 auto;
    width: auto;
    min-width: 0;
    height: 36px;
    border: none;
    border-radius: $radius-sm;
    background: transparent;
    color: $text-secondary;
    display: inline-flex;
    align-items: center;
    justify-content: flex-start;
    gap: 8px;
    padding: 8px 10px;
    cursor: pointer;
    transition:
        background-color $transition-fast,
        color $transition-fast;

    &:hover {
        background: rgba(var(--accent-primary-rgb), 0.06);
        color: $text-primary;
    }

    span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
        line-height: 18px;
    }
}

// ─── Chat Main ──────────────────────────────────────────

.chat-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    margin: 10px 10px 10px 0;
    overflow: hidden;
    background-color: $bg-main-surface;
    border: 1px solid $border-color;
    border-radius: 14px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);
    position: relative;

    &--sidebar-collapsed {
        margin-inline-start: 10px;
    }
}

.group-chat-content-wrapper {
    flex: 1;
    display: flex;
    overflow: hidden;
    position: relative;
    min-width: 0;
    min-height: 0;
    max-width: 100%;
}

.agent-avatar-rail {
    flex: 0 0 72px;
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 72px;
    min-height: 0;
    padding: 12px 0;
    overflow: hidden;
    box-sizing: border-box;
    border-inline-end: 1px solid $border-color;
    background: rgba(var(--bg-main-surface-rgb), 0.55);
}

.agent-avatar-rail-trigger {
    display: flex;
    align-items: center;
    flex-direction: column;
    flex: 1;
    width: 100%;
    min-height: 0;
    gap: 10px;
    overflow-x: hidden;
    overflow-y: auto;
    scrollbar-width: none;

    &::-webkit-scrollbar {
        display: none;
    }
}

.agent-avatar-rail-item {
    position: relative;
    display: flex;
    flex: 0 0 34px;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    padding: 0;
    overflow: visible;
    box-sizing: border-box;
    border: 1px solid rgba(var(--text-primary-rgb), 0.12);
    border-radius: 50%;
    background: $bg-secondary;
    cursor: pointer;
    transition: border-color $transition-fast, box-shadow $transition-fast;
    -webkit-app-region: no-drag;

    &:hover {
        border-color: rgba(var(--accent-primary-rgb), 0.55);
    }

    &:focus-visible {
        border-color: rgba(var(--accent-primary-rgb), 0.75);
        box-shadow: 0 0 0 2px rgba(var(--accent-primary-rgb), 0.14);
        outline: none;
    }

    &:disabled {
        cursor: default;
    }

    .agent-avatar {
        width: 32px;
        height: 32px;
    }
}

.agent-avatar-rail-agent .agent-avatar {
    box-sizing: border-box;
    border: 1px solid #fff;
}

.agent-owner-avatar-badge {
    position: absolute;
    z-index: 2;
    inset-block-start: -5px;
    inset-inline-end: -6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    overflow: hidden;
    box-sizing: border-box;
    border: 2px solid $bg-main-surface;
    border-radius: 50%;
    background: $bg-main-surface;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18);
    pointer-events: none;
}

.agent-avatar-rail-current-user {
    border-color: rgba(var(--accent-primary-rgb), 0.28);
}

.agent-avatar-rail-typing {
    border-color: rgba(var(--accent-primary-rgb), 0.72);
    animation: member-avatar-typing-breathe 1.6s ease-in-out infinite;
}

.agent-avatar-rail-active {
    border-color: transparent;
    animation: agent-avatar-rainbow-glow 4s linear infinite;
}

.agent-avatar-rail-offline {
    border-color: rgba(var(--text-primary-rgb), 0.08);

    .agent-avatar {
        filter: grayscale(1);
        opacity: 0.42;
    }
}

.agent-avatar-activity-popover {
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: 280px;
}

.agent-avatar-activity-text {
    color: $text-secondary;
    font-size: 12px;
    line-height: 1.4;
}

.agent-avatar-stop {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    gap: 5px;
    height: 26px;
    padding: 0 9px;
    border: 1px solid rgba(var(--error-rgb), 0.24);
    border-radius: $radius-sm;
    color: $error;
    background: rgba(var(--error-rgb), 0.08);
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
    transition: color $transition-fast, border-color $transition-fast, background $transition-fast;

    &:hover {
        border-color: $error;
        color: #ffffff;
        background: $error;
    }
}

@keyframes agent-avatar-rainbow-glow {
    0% {
        box-shadow:
            0 0 0 2px #ff6b6b,
            0 0 10px rgba(255, 107, 107, 0.4),
            0 0 20px rgba(255, 107, 107, 0.2);
    }

    16.66% {
        box-shadow:
            0 0 0 2px #feca57,
            0 0 10px rgba(254, 202, 87, 0.4),
            0 0 20px rgba(254, 202, 87, 0.2);
    }

    33.33% {
        box-shadow:
            0 0 0 2px #48dbfb,
            0 0 10px rgba(72, 219, 251, 0.4),
            0 0 20px rgba(72, 219, 251, 0.2);
    }

    50% {
        box-shadow:
            0 0 0 2px #ff9ff3,
            0 0 10px rgba(255, 159, 243, 0.4),
            0 0 20px rgba(255, 159, 243, 0.2);
    }

    66.66% {
        box-shadow:
            0 0 0 2px #54a0ff,
            0 0 10px rgba(84, 160, 255, 0.4),
            0 0 20px rgba(84, 160, 255, 0.2);
    }

    83.33% {
        box-shadow:
            0 0 0 2px #5f27cd,
            0 0 10px rgba(95, 39, 205, 0.4),
            0 0 20px rgba(95, 39, 205, 0.2);
    }

    100% {
        box-shadow:
            0 0 0 2px #ff6b6b,
            0 0 10px rgba(255, 107, 107, 0.4),
            0 0 20px rgba(255, 107, 107, 0.2);
    }
}

@keyframes member-avatar-typing-breathe {
    0%,
    100% {
        box-shadow:
            0 0 0 1px rgba(var(--accent-primary-rgb), 0.18),
            0 0 5px rgba(var(--accent-primary-rgb), 0.12);
    }

    50% {
        box-shadow:
            0 0 0 3px rgba(var(--accent-primary-rgb), 0.28),
            0 0 14px rgba(var(--accent-primary-rgb), 0.42);
    }
}

@media (prefers-reduced-motion: reduce) {
    .agent-avatar-rail-active {
        animation: none;
        box-shadow:
            0 0 0 2px #ff6b6b,
            0 0 10px rgba(255, 107, 107, 0.4),
            0 0 20px rgba(255, 107, 107, 0.2);
    }

    .agent-avatar-rail-typing {
        animation: none;
        box-shadow: 0 0 0 2px rgba(var(--accent-primary-rgb), 0.24);
    }
}

.agent-avatar-rail-divider {
    flex: 0 0 1px;
    width: 24px;
    background: $border-color;
}

.agent-avatar-rail-add {
    display: flex;
    flex: 0 0 34px;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    margin-top: 10px;
    padding: 0;
    border: 1px dashed rgba(var(--accent-primary-rgb), 0.65);
    border-radius: 50%;
    color: var(--accent-primary);
    background: rgba(var(--accent-primary-rgb), 0.08);
    cursor: pointer;
    transition: color $transition-fast, border-color $transition-fast, background $transition-fast;
    -webkit-app-region: no-drag;

    &:hover {
        border-color: rgba(var(--accent-primary-rgb), 0.82);
        color: var(--accent-primary);
        background: rgba(var(--accent-primary-rgb), 0.13);
    }
}

.group-chat-surface {
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background-color: $bg-main-surface;
    animation: group-chat-surface-fade-in 1.5s ease both;
}

.group-summary-inline-status {
    display: flex;
    align-items: center;
    align-self: flex-start;
    gap: 6px;
    width: 520px;
    max-width: calc(100% - 40px);
    min-width: 0;
    box-sizing: border-box;
    margin: 0 20px;
    padding: 3px 8px;
    border-radius: $radius-sm;
    color: $text-secondary;
    background: rgba(0, 0, 0, 0.03);
    font-size: 11px;

    &.is-success {
        color: #52c41a;
    }

    &.is-failed {
        color: #ff4d4f;
    }
}

.group-summary-inline-label {
    flex: 0 1 auto;
    min-width: 0;
    color: $text-secondary;
    font-family: $font-code;
    white-space: nowrap;
}

.group-summary-inline-spinner {
    width: 10px;
    height: 10px;
    flex-shrink: 0;
    box-sizing: border-box;
    border: 1.5px solid $text-muted;
    border-top-color: transparent;
    border-radius: 50%;
    animation: group-summary-inline-spin 0.6s linear infinite;
}

.group-summary-inline-success-icon,
.group-summary-inline-error-icon {
    flex-shrink: 0;
}

.group-summary-inline-detail {
    min-width: 0;
    overflow: hidden;
    color: $text-muted;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.summary-inline-enter-active,
.summary-inline-leave-active {
    transition: opacity 0.15s ease, transform 0.15s ease;
}

.summary-inline-enter-from,
.summary-inline-leave-to {
    opacity: 0;
    transform: translateY(3px);
}

.workspace-panel-toggle.active {
    color: var(--accent-primary);
    background: rgba(var(--accent-primary-rgb), 0.1);
}

.group-workspace-panel {
    position: relative;
    flex: 0 0 auto;
    min-width: 320px;
    max-width: 100%;
    min-height: 0;
    overflow: visible;
    display: flex;
    background: $bg-card;
    border-inline-start: 1px solid $border-color;
}

.tool-panel-enter-active,
.tool-panel-leave-active {
    overflow: hidden;
    pointer-events: none;
    will-change: width, min-width, opacity;
    transition:
        width 0.25s cubic-bezier(0.4, 0, 0.2, 1),
        min-width 0.25s cubic-bezier(0.4, 0, 0.2, 1),
        opacity 0.16s ease,
        border-color 0.16s ease;
}

.tool-panel-enter-from,
.tool-panel-leave-to {
    width: 0 !important;
    min-width: 0;
    opacity: 0;
    border-inline-start-color: transparent;
}

.group-workspace-resize-handle {
    position: absolute;
    inset-inline-start: -7px;
    top: 0;
    bottom: 0;
    width: 14px;
    cursor: col-resize;
    z-index: 20;

    &::after {
        content: '';
        position: absolute;
        inset-inline-start: 6px;
        top: 0;
        bottom: 0;
        width: 1px;
        background:
            linear-gradient($border-color, $border-color) top / 1px calc(50% - 26px) no-repeat,
            linear-gradient($border-color, $border-color) bottom / 1px calc(50% - 26px) no-repeat;
    }

    &::before {
        content: '';
        position: absolute;
        inset-inline-start: 1px;
        top: 50%;
        width: 12px;
        height: 38px;
        transform: translateY(-50%);
        border-radius: 6px;
        border: 1px solid $border-color;
        background:
            linear-gradient($text-muted, $text-muted) center 12px / 6px 1px no-repeat,
            linear-gradient($text-muted, $text-muted) center 19px / 6px 1px no-repeat,
            linear-gradient($text-muted, $text-muted) center 26px / 6px 1px no-repeat,
            $bg-card;
    }

    &:hover::before {
        border-color: var(--accent-primary);
        background:
            linear-gradient(var(--accent-primary), var(--accent-primary)) center 12px / 6px 1px no-repeat,
            linear-gradient(var(--accent-primary), var(--accent-primary)) center 19px / 6px 1px no-repeat,
            linear-gradient(var(--accent-primary), var(--accent-primary)) center 26px / 6px 1px no-repeat,
            $bg-card;
    }
}

.group-workspace-panel-inner {
    display: flex;
    flex-direction: row;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: $bg-main-surface;
}

.group-tool-tabs {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex-shrink: 0;
    order: 2;
    width: 48px;
    height: 100%;
    gap: 4px;
    padding: 8px 6px;
    border-inline-start: 1px solid $border-color;
    background: $bg-sidebar-surface;
    box-sizing: border-box;
}

.group-tool-tab {
    position: relative;
    width: 36px;
    height: 36px;
    padding: 0;
    border: none;
    border-radius: $radius-sm;
    background: transparent;
    color: $text-secondary;
    cursor: pointer;
    display: grid;
    place-items: center;
    transition: all $transition-fast;

    svg {
        width: 18px;
        height: 18px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.7;
        stroke-linecap: round;
        stroke-linejoin: round;
    }

    &:hover {
        color: $text-primary;
        background: rgba(var(--accent-primary-rgb), 0.06);
    }

    &.active {
        color: var(--accent-primary);
        background: rgba(var(--accent-primary-rgb), 0.12);

        &::after {
            content: '';
            position: absolute;
            inset-inline-end: -6px;
            top: 9px;
            bottom: 9px;
            width: 2px;
            border-radius: 2px 0 0 2px;
            background: var(--accent-primary);
        }
    }
}

.group-tool-content {
    order: 1;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: $bg-main-surface;

    > * {
        height: 100%;
        min-height: 0;
    }
}

.group-workspace-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 24px;
    color: $text-muted;
    text-align: center;
    font-size: 13px;

    > svg {
        color: $text-secondary;
    }
}

.group-browser-panel,
.group-terminal-panel {
    min-height: 0;
}

@media (max-width: $breakpoint-mobile) {
    .group-workspace-panel {
        position: absolute;
        inset: 0;
        z-index: 70;
        width: 100% !important;
        min-width: 0;
        border-inline-start: none;
    }

    .group-workspace-resize-handle {
        display: none;
    }

    .tool-panel-enter-active,
    .tool-panel-leave-active {
        transition:
            transform 0.25s cubic-bezier(0.4, 0, 0.2, 1),
            opacity 0.16s ease;
    }

    .tool-panel-enter-from,
    .tool-panel-leave-to {
        width: 100% !important;
        transform: translateX(100%);
    }

    .tool-panel-enter-from:dir(rtl),
    .tool-panel-leave-to:dir(rtl) {
        transform: translateX(-100%);
    }
}

@media (prefers-reduced-motion: reduce) {
    .tool-panel-enter-active,
    .tool-panel-leave-active {
        transition-duration: 0.01ms;
    }
}

@keyframes group-chat-surface-fade-in {
    from {
        opacity: 0;
    }

    to {
        opacity: 1;
    }
}

.chat-main--drop-active::after {
    content: "";
    position: absolute;
    inset: 12px;
    z-index: 30;
    pointer-events: none;
    border: 2px dashed var(--accent-info);
    border-radius: 8px;
    background: rgba(var(--accent-info-rgb), 0.05);
}

.chat-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 21px 20px;
    border-bottom: 1px solid $border-color;

    .icon-btn {
        width: 28px;
        height: 28px;
    }

    .icon-btn {
        box-sizing: content-box;
    }

    .header-left {
        display: flex;
        align-items: center;
        gap: 8px;
        overflow: hidden;
        flex: 1;
        min-width: 0;
    }

    .room-title-text {
        font-size: 16px;
        font-weight: 600;
        color: $text-primary;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
    }

    .header-info {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
    }

    .workspace-badge {
        border: 0;
        font-size: 11px;
        line-height: 16px;
        color: $text-muted;
        background: rgba(255, 255, 255, 0.05);
        padding: 2px 8px;
        border-radius: 4px;
        max-width: 160px;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        overflow: hidden;
        cursor: pointer;
        flex-shrink: 0;

        svg {
            flex: 0 0 auto;
        }

        span {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        &:hover {
            color: $text-secondary;
            background: rgba(var(--accent-primary-rgb), 0.06);
        }
    }

    .member-count {
        font-size: 12px;
        color: $text-muted;
    }

    .member-count-toggle {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 3px 5px;
        border: 0;
        border-radius: $radius-sm;
        background: transparent;
        cursor: pointer;
        transition: color $transition-fast, background-color $transition-fast;
        -webkit-app-region: no-drag;

        &:hover {
            color: $text-secondary;
            background: rgba(var(--accent-primary-rgb), 0.06);
        }

        svg {
            transition: transform $transition-fast;

            &.collapsed {
                transform: rotate(180deg);
            }
        }
    }
}

.agent-avatar {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;

    :deep(svg) {
        width: 100%;
        height: 100%;
    }
}

// ─── No Room State ────────────────────────────────────────

.no-room {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    color: $text-muted;

    .no-room-icon {
        opacity: 0.3;
    }

    p {
        font-size: 14px;
    }
}

// ─── Shared ──────────────────────────────────────────────

.icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    background: none;
    border-radius: $radius-sm;
    color: $text-secondary;
    cursor: pointer;
    transition: all $transition-fast;

    &:hover {
        background-color: rgba(var(--accent-primary-rgb), 0.08);
        color: $text-primary;
    }
}

.modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
}

.modal {
    background: $bg-card;
    border-radius: $radius-lg;
    padding: 24px;
    width: 400px;
    max-width: 90vw;
    max-height: calc(100vh - 32px);
    overflow-y: auto;
    box-sizing: border-box;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);

    h3 {
        font-size: 16px;
        font-weight: 600;
        color: $text-primary;
        margin: 0 0 20px;
    }
}

.agent-preset-entry {
    margin-bottom: 18px;
}

.agent-preset-dialog-backdrop {
    z-index: 1010;
}

.agent-preset-dialog {
    width: 480px;
}

.agent-preset-dialog-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 320px;
    margin-top: 12px;
    overflow-y: auto;
}

.agent-preset-dialog-row {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 3px;
    width: 100%;
    padding: 11px 12px;
    border: 1px solid $border-color;
    border-radius: $radius-md;
    color: $text-primary;
    background: $bg-main-surface;
    text-align: start;
    cursor: pointer;
    transition:
        border-color $transition-fast,
        background-color $transition-fast;

    &:hover:not(:disabled) {
        border-color: rgba(var(--accent-primary-rgb), 0.55);
        background: rgba(var(--accent-primary-rgb), 0.05);
    }

    &.selected {
        border-color: var(--accent-primary);
        background: rgba(var(--accent-primary-rgb), 0.09);
    }

    &.unavailable {
        cursor: not-allowed;
        opacity: 0.72;
    }
}

.agent-preset-dialog-row-name {
    font-size: 13px;
    font-weight: 600;
}

.agent-preset-dialog-row-config,
.agent-preset-dialog-row-error {
    font-size: 11px;
    line-height: 1.45;
    overflow-wrap: anywhere;
}

.agent-preset-dialog-row-config {
    color: $text-secondary;
}

.agent-preset-dialog-row-error {
    color: $error;
}

.agent-preset-dialog-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    margin-top: 12px;
    padding: 28px 16px;
    border: 1px dashed $border-color;
    border-radius: $radius-md;
    color: $text-muted;
    text-align: center;

    &.is-error {
        color: $error;
    }
}

.agent-preset-management-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 14px;
}

.room-settings-drawer {
    min-width: 0;
}

.settings-section {
    margin-bottom: 18px;

    h4 {
        margin: 0 0 12px;
        font-size: 13px;
        font-weight: 600;
        color: $text-primary;
    }
}

.pending-agent-pairings-section {
    padding: 12px;
    border: 1px solid rgba(var(--accent-primary-rgb), 0.3);
    border-radius: 12px;
    background: rgba(var(--accent-primary-rgb), 0.06);
}

.pending-agent-pairing-card {
    padding: 10px;
    border: 1px solid $border-color;
    border-radius: 10px;
    background: $bg-main-surface;

    & + & {
        margin-top: 10px;
    }

    strong {
        color: $text-primary;
    }

    p {
        margin: 6px 0 10px;
        color: $text-secondary;
        font-size: 12px;
        line-height: 1.5;
        overflow-wrap: anywhere;
    }
}

.agent-pairing-header-button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 30px;
    padding: 0 9px;
    border: 1px solid rgba(var(--accent-primary-rgb), 0.32);
    border-radius: 999px;
    color: var(--accent-primary);
    background: rgba(var(--accent-primary-rgb), 0.08);
    font-size: 12px;
    cursor: pointer;

    strong {
        min-width: 18px;
        padding: 1px 5px;
        border-radius: 999px;
        color: #fff;
        background: var(--accent-primary);
        text-align: center;
    }
}

.agent-pairing-header-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent-primary);
    box-shadow: 0 0 0 4px rgba(var(--accent-primary-rgb), 0.12);
}

.guest-agent-policy-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 18px;
    margin-bottom: 14px;

    strong {
        color: $text-primary;
        font-size: 13px;
        font-weight: 600;
    }

    .form-hint {
        margin: 5px 0 0;
    }
}

.agent-pairing-float-panel {
    border-color: rgba(var(--accent-primary-rgb), 0.28);
}

.summary-state-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;

    h4 {
        margin-bottom: 0;
    }
}

.summary-config-required {
    margin: 0 0 10px;
    padding: 8px 10px;
    border-radius: $radius-sm;
    color: #d97706;
    background: rgba(217, 119, 6, 0.1);
    font-size: 12px;
    line-height: 1.5;
}

.summary-status {
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 11px;
    color: $text-muted;
    background: rgba(var(--text-primary-rgb), 0.06);

    &.is-summarizing {
        color: var(--accent-primary);
        background: rgba(var(--accent-primary-rgb), 0.12);
    }

    &.is-success {
        color: #36ad6a;
        background: rgba(54, 173, 106, 0.12);
    }

    &.is-failed {
        color: #d03050;
        background: rgba(208, 48, 80, 0.12);
    }
}

.summary-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 14px;
    margin: 10px 0;
    color: $text-muted;
    font-size: 11px;

    > span {
        display: inline-flex;
        align-items: baseline;
        gap: 4px;
    }

    strong {
        color: $text-secondary;
        font-weight: 500;
    }
}

.room-workspace-actions {
    margin-top: 12px;
}

.summary-error {
    margin-bottom: 12px;
    padding: 8px 10px;
    border-radius: $radius-sm;
    color: #d03050;
    background: rgba(208, 48, 80, 0.08);
    font-size: 12px;
    overflow-wrap: anywhere;
}

.summary-anchor {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 14px;
    padding: 10px;
    border: 1px solid $border-color;
    border-radius: $radius-sm;
    color: $text-secondary;
    font-size: 12px;

    strong,
    span {
        display: block;
    }

    span {
        margin-top: 3px;
        color: $text-muted;
    }

    p {
        margin: 6px 0 0;
        display: -webkit-box;
        overflow: hidden;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 3;
        overflow-wrap: anywhere;
    }
}

.summary-loading {
    padding: 20px 0;
    color: $text-muted;
    text-align: center;
}

.form-group {
    margin-bottom: 16px;
}

.group-agent-avatar-editor {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 18px;
    padding: 12px;
    border: 1px solid $border-color;
    border-radius: $radius-md;
    background: rgba(var(--text-primary-rgb), 0.02);
}

.group-agent-avatar-controls {
    min-width: 0;
    flex: 1;

    .form-label {
        margin-bottom: 7px;
    }
}

.group-agent-avatar-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}

.group-agent-avatar-hint {
    display: block;
    margin-top: 6px;
    color: $text-muted;
    font-size: 11px;
}

.group-agent-avatar-file {
    display: none;
}

.form-label {
    display: block;
    font-size: 13px;
    font-weight: 500;
    color: $text-secondary;
    margin-bottom: 6px;
}

.code-row {
    display: flex;
    gap: 8px;
    align-items: center;
}

.invite-code-row :deep(.n-input) {
    flex: 1;
}

.modal-actions {
    margin-top: 12px;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
}

.agent-drawer-actions {
    display: flex;
    width: 100%;
    justify-content: flex-end;
    gap: 8px;

    &.is-editing {
        justify-content: space-between;
    }
}

.form-hint {
    font-size: 11px;
    color: $text-muted;
    margin: 4px 0 0;
}

.share-link-button {
    margin-top: 12px;
}

// ─── Connection Dot ──────────────────────────────────────

.connection-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;

    &.connected {
        background-color: $success;
        box-shadow: 0 0 6px rgba(var(--success-rgb), 0.5);
    }

    &.disconnected {
        background-color: $error;
    }
}

@keyframes group-summary-inline-spin {
    to {
        transform: rotate(360deg);
    }
}

// ─── Mobile ──────────────────────────────────────────────

@media (max-width: $breakpoint-mobile) {
    .chat-main {
        margin: 0;
        border: none;
        border-radius: 0;
        box-shadow: none;
    }

    .room-sidebar {
        position: absolute;
        left: 10px;
        top: 10px;
        bottom: 10px;
        height: auto;
        margin: 0;
        z-index: 100;
    }

    .chat-header {
        padding: 16px 12px 16px 52px;
    }

    .group-summary-inline-status {
        max-width: calc(100% - 24px);
        margin: 0 12px;
    }

    .agent-avatar-rail {
        flex-basis: 68px;
        width: 68px;
        padding: 10px 0;
    }

    .agent-avatar-rail-item {
        width: 32px;
        height: 32px;

        .agent-avatar {
            width: 30px;
            height: 30px;
        }
    }

    .agent-avatar-rail-add {
        width: 32px;
        height: 32px;
        flex-basis: 32px;
    }

    .header-sidebar-toggle {
        display: none;
    }

    .room-title-text {
        display: none;
    }

}
</style>

<style scoped lang="scss">
.summary-review { margin: 12px 0; padding: 12px; border: 1px solid var(--border-color); border-radius: 8px; display: grid; gap: 6px; }
.summary-review.is-pass { border-color: #18a058; }
.summary-review.is-needs_improvement { border-color: #f0a020; }
.summary-review ul { margin: 0; padding-inline-start: 20px; }
</style>
